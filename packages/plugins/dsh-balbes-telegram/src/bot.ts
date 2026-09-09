/**
 * Thin Telegram Bot API client built on the platform fetch.
 *
 * Every call is `POST {apiBase}/bot{token}/{method}` with a JSON body. The
 * client carries no state: it retries transient failures (network rejection,
 * HTTP 429/5xx) with a short sleep, surfaces Telegram error envelopes as
 * BotApiError, and guarantees the bot token never reaches an error message.
 * The fetch implementation and the API base are injectable so unit tests and
 * the REAL-composition fixture can point the client at a fake endpoint.
 */

const DEFAULT_API_BASE = "https://api.telegram.org";
/** Number of retries after the initial attempt (default 2 -> up to 3 calls). */
const DEFAULT_RETRIES = 2;
/** Per-attempt timeout: long-poll getUpdates may hold the socket for 50s. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Base delay for one retry; scaled linearly (25ms, 50ms, ...) to stay fast in tests. */
const RETRY_DELAY_MS = 25;

/** A single update delivered by the Bot API polling endpoint. */
export interface BotUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean };
    text?: string;
    date?: number;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number; type: string } };
    data?: string;
  };
}

/**
 * Error raised for any failed Bot API interaction. `status` is the HTTP
 * status when Telegram answered (0 for failures that never produced an HTTP
 * response), `telegramCode` the `error_code` from the JSON envelope when one
 * was parsed. The message never contains the bot token.
 */
export class BotApiError extends Error {
  constructor(
    public status: number,
    public telegramCode: number | undefined,
    message: string
  ) {
    super(message);
    this.name = "BotApiError";
  }
}

/** Client surface consumed by the poller, chat handler and admin routes. */
export interface BotClient {
  getMe(): Promise<{ username?: string; id?: number }>;
  getUpdates(opts: { offset?: number; timeout?: number }): Promise<BotUpdate[]>;
  sendMessage(chatId: number, text: string, extra?: { reply_markup?: unknown }): Promise<void>;
  editMessageText(chatId: number, messageId: number, text: string, extra?: { reply_markup?: unknown }): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<void>;
}

/** JSON envelope every Bot API method answers with. */
interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a Bot API client. `fetchImpl` defaults to the global fetch and
 * `apiBase` to the real Telegram endpoint; tests override both.
 */
export function createBotClient(opts: {
  token: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
}): BotClient {
  const token = opts.token;
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  /** Masking: replace any token occurrence so no error string leaks it. */
  const redact = (value: string): string => value.split(token).join("[redacted]");

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Transient failure after retries are exhausted. */
  const temporaryFailure = (reason: string): BotApiError =>
    new BotApiError(0, undefined, redact(`temporary failure: ${reason}`));

  /** Backoff for retry number n (1-based): 25ms x n. */
  const delayForRetry = (retryNumber: number): number => RETRY_DELAY_MS * retryNumber;

  async function call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const url = `${apiBase}/bot${token}/${method}`;
    const body = JSON.stringify(payload);

    for (let attempt = 0; ; attempt++) {
      const retriesLeft = attempt < retries;

      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch (error) {
        // Network-level rejection (DNS, connect, abort, TLS): transient.
        if (retriesLeft) {
          await sleep(delayForRetry(attempt + 1));
          continue;
        }
        throw temporaryFailure(reasonOf(error));
      }

      // Throttling and server faults are transient; 4xx (incl. 401) never retried.
      if (response.status === 429 || response.status >= 500) {
        if (retriesLeft) {
          await sleep(delayForRetry(attempt + 1));
          continue;
        }
        throw temporaryFailure(`http ${response.status}`);
      }

      // Buffer the body as text first: a body that is not JSON never reaches
      // the envelope parser, so it surfaces as a masked non-json response.
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        // The response never fully arrived; report it as a temporary failure.
        throw temporaryFailure(reasonOf(error));
      }

      let envelope: TelegramEnvelope<T>;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
          throw new SyntaxError("response body is not a Telegram envelope");
        }
        envelope = parsed as TelegramEnvelope<T>;
      } catch {
        throw new BotApiError(0, undefined, "non-json response");
      }

      if (envelope.ok !== true) {
        // Telegram error envelope: message is only the description.
        throw new BotApiError(response.status, envelope.error_code, redact(envelope.description ?? ""));
      }
      return envelope.result as T;
    }
  }

  return {
    async getMe(): Promise<{ username?: string; id?: number }> {
      return call<{ username?: string; id?: number }>("getMe", {});
    },

    async getUpdates(opts: { offset?: number; timeout?: number }): Promise<BotUpdate[]> {
      const payload: Record<string, unknown> = {};
      if (opts.offset !== undefined) payload.offset = opts.offset;
      if (opts.timeout !== undefined) payload.timeout = opts.timeout;
      return call<BotUpdate[]>("getUpdates", payload);
    },

    async sendMessage(chatId: number, text: string, extra?: { reply_markup?: unknown }): Promise<void> {
      await call<unknown>("sendMessage", { chat_id: chatId, text, ...extra });
    },

    async editMessageText(
      chatId: number,
      messageId: number,
      text: string,
      extra?: { reply_markup?: unknown }
    ): Promise<void> {
      await call<unknown>("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
    },

    async answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<void> {
      await call<unknown>("answerCallbackQuery", { callback_query_id: callbackQueryId, ...opts });
    }
  };
}
