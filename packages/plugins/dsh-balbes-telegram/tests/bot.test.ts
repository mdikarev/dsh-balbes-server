import { describe, expect, it, vi } from "vitest";
import { BotApiError, createBotClient } from "../src/bot.js";
import type { BotClient } from "../src/bot.js";

const TOKEN = "123456:SECRET_BOT_TOKEN";
const API_BASE = "http://fake.local";
const DEFAULT_API_BASE = "https://api.telegram.org";

/**
 * Minimal Response stand-in. The client reads the body through text() and
 * JSON.parses it itself, so the fake only has to expose ok/status/text().
 */
function jsonResponse(status: number, body: unknown): {
  ok: boolean;
  status: number;
  text(): Promise<string>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async (): Promise<string> => JSON.stringify(body)
  };
}

/** Test doubles are not real fetch; the client contract types them as such. */
function asFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch;
}

function lastInit(mock: ReturnType<typeof vi.fn>): { body: string; method: string } {
  const init = mock.mock.calls[0]![1] as { body: string; method: string };
  return init;
}

function parsedBody(mock: ReturnType<typeof vi.fn>): unknown {
  return JSON.parse(lastInit(mock).body);
}

async function rejectionOf(promise: Promise<unknown>): Promise<BotApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  return err as BotApiError;
}

describe("createBotClient", () => {
  it("getMe posts to /bot<token>/getMe with an empty body and resolves the bot user", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: unknown) =>
      jsonResponse(200, { ok: true, result: { id: 7, is_bot: true, first_name: "Bot", username: "sample_bot" } })
    );
    const bot: BotClient = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    const me = await bot.getMe();

    expect(fetchImpl.mock.calls[0]![0]).toBe(`${API_BASE}/bot${TOKEN}/getMe`);
    expect(lastInit(fetchImpl).method).toBe("POST");
    expect(lastInit(fetchImpl).body).toBe("{}");
    expect(me).toMatchObject({ id: 7, username: "sample_bot" });
  });

  it("defaults apiBase to https://api.telegram.org", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: unknown) => jsonResponse(200, { ok: true, result: {} }));
    const bot = createBotClient({ token: TOKEN, fetchImpl: asFetch(fetchImpl) });

    await bot.getMe();

    expect(fetchImpl.mock.calls[0]![0]).toBe(`${DEFAULT_API_BASE}/bot${TOKEN}/getMe`);
  });

  it("getUpdates sends offset and timeout in the body and resolves the result array", async () => {
    const update = {
      update_id: 41,
      message: { message_id: 1, chat: { id: 1, type: "private" }, text: "hi" }
    };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: [update] }));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    const updates = await bot.getUpdates({ offset: 41, timeout: 50 });

    expect(parsedBody(fetchImpl)).toEqual({ offset: 41, timeout: 50 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.update_id).toBe(41);
  });

  it("getUpdates sends an empty body when neither offset nor timeout is given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: [] }));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    await bot.getUpdates({});

    expect(lastInit(fetchImpl).body).toBe("{}");
  });

  it("sendMessage includes chat_id, text and extra reply_markup in the body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: { message_id: 5 } }));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    await bot.sendMessage(1, "hi", { reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] } });

    expect(parsedBody(fetchImpl)).toEqual({
      chat_id: 1,
      text: "hi",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] }
    });
  });

  it("editMessageText includes chat_id, message_id, text and reply_markup in the body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: { message_id: 5 } }));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    await bot.editMessageText(1, 5, "edited", { reply_markup: { inline_keyboard: [] } });

    expect(parsedBody(fetchImpl)).toEqual({
      chat_id: 1,
      message_id: 5,
      text: "edited",
      reply_markup: { inline_keyboard: [] }
    });
  });

  it("answerCallbackQuery sends callback_query_id and text in the body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, result: true }));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    await bot.answerCallbackQuery("cb-9", { text: "Done" });

    expect(parsedBody(fetchImpl)).toEqual({ callback_query_id: "cb-9", text: "Done" });
  });

  it("maps an HTTP error envelope to BotApiError, masks the token, and never retries 4xx", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { ok: false, error_code: 401, description: "Unauthorized" })
    );
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    const err = await rejectionOf(bot.getMe());

    expect(err).toBeInstanceOf(BotApiError);
    expect(err.status).toBe(401);
    expect(err.telegramCode).toBe(401);
    expect(err.message).toBe("Unauthorized");
    expect(err.message).not.toContain(TOKEN);
    expect(String(err)).not.toContain(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("masks a token that Telegram echoes inside an error description", async () => {
    // The masking guarantee is absolute: even if a description contained the
    // token, the surfaced message must carry the redacted form instead.
    const fetchImpl = vi.fn(async (_url: string, _init: unknown) =>
      jsonResponse(400, { ok: false, error_code: 400, description: `Bad Request: invalid token ${TOKEN}` })
    );
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    const err = await rejectionOf(bot.getMe());

    expect(err).toBeInstanceOf(BotApiError);
    expect(err.status).toBe(400);
    expect(err.telegramCode).toBe(400);
    expect(err.message).toBe("Bad Request: invalid token [redacted]");
    expect(err.message).not.toContain(TOKEN);
    expect(String(err)).not.toContain(TOKEN);
  });

  it("masks a token that leaks through a network failure reason", async () => {
    // A wrapped transport error may embed the request URL (which holds the
    // token); the temporary-failure message must still be token-free.
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`fetch failed: ${API_BASE}/bot${TOKEN}/getMe`));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl), retries: 0 });

    const err = await rejectionOf(bot.getMe());

    expect(err).toBeInstanceOf(BotApiError);
    expect(err.status).toBe(0);
    expect(err.message).toBe(`temporary failure: fetch failed: ${API_BASE}/bot[redacted]/getMe`);
    expect(err.message).not.toContain(TOKEN);
    expect(String(err)).not.toContain(TOKEN);
  });

  it("retries a network rejection before succeeding", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { username: "sample_bot" } }));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    await expect(bot.getMe()).resolves.toMatchObject({ username: "sample_bot" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 response before succeeding", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { ok: false, error_code: 429, description: "Too Many Requests" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { username: "sample_bot" } }));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    await expect(bot.getMe()).resolves.toMatchObject({ username: "sample_bot" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx response before succeeding", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { ok: false, error_code: 502, description: "Bad Gateway" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, result: { username: "sample_bot" } }));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    await expect(bot.getMe()).resolves.toMatchObject({ username: "sample_bot" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after the default 2 retries with BotApiError status 0 and a masked reason", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    const err = await rejectionOf(bot.getMe());

    expect(err).toBeInstanceOf(BotApiError);
    expect(err.status).toBe(0);
    expect(err.telegramCode).toBeUndefined();
    expect(err.message).toContain("temporary failure:");
    expect(err.message).not.toContain(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("honours a custom retries count of 1", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl), retries: 1 });

    const err = await rejectionOf(bot.getMe());

    expect(err).toBeInstanceOf(BotApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a non-JSON body as BotApiError with status 0", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => "<html>oops</html>" }));
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    const err = await rejectionOf(bot.getMe());

    expect(err).toBeInstanceOf(BotApiError);
    expect(err.status).toBe(0);
    expect(err.message).toBe("non-json response");
  });

  it("treats an ok:false envelope on a 200 response as a BotApiError", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: false, error_code: 400, description: "Bad Request: text is empty" })
    );
    const bot = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchImpl) });

    const err = await rejectionOf(bot.sendMessage(1, ""));

    expect(err).toBeInstanceOf(BotApiError);
    expect(err.status).toBe(200);
    expect(err.telegramCode).toBe(400);
    expect(err.message).toBe("Bad Request: text is empty");
  });
});
