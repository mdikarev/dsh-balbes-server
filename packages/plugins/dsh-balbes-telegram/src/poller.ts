/**
 * Long-polling loop over the Bot API `getUpdates` endpoint.
 *
 * Exactly one loop is meant to run per process. The poller is pure transport:
 * it knows a `BotClient`, the allowlisted owner id and nothing else — no
 * settings, no state file, no chat semantics. Its two jobs are moving the
 * offset forward and keeping the loop alive across transient failures while
 * stopping at once on a fatal one.
 *
 * Offset and authorization:
 * - The first poll of a run carries no `offset` unless a restored one was
 *   passed to `start`; afterwards the offset is `last.update_id + 1`. The
 *   offset advances even when a whole batch was unauthorized, so an ignored
 *   update is never fetched forever.
 * - The offset moves BEFORE the batch is delivered, and every acknowledged
 *   batch is reported once through `cb.onAck(nextOffset)` — the value a state
 *   file must persist. Deriving that value from `onUpdate` instead would
 *   regress it (a batch can end with unauthorized updates that are never
 *   delivered) and re-deliver already-handled commands after a restart.
 *   Loss window, by design: if `cb.onUpdate` rejects for an acknowledged
 *   update, that update is never retried — the offset has already moved past
 *   it, and the failure is only recorded in `lastError`.
 * - Only updates for which `isAuthorized(update, allowedUserId)` holds reach
 *   `cb.onUpdate`. Every other update is dropped without any processing and
 *   without observable state.
 *
 * Failures:
 * - `BotApiError` with `status === 401` is fatal: `cb.onFatal` fires, the loop
 *   ends and the status becomes "error" (until the next `start`).
 * - Anything else is transient: the status stays "running", `lastError` is
 *   recorded and the next poll waits a backoff starting at 1s and doubling up
 *   to `maxBackoffMs` (default 30s). A successful batch resets the backoff.
 * - A throwing `cb.onUpdate` or `cb.onAck` is contained: the rest of the batch
 *   and the loop survive it, and it is reported through `lastError` — the only
 *   channel a pure transport has (there is no logger in this contract).
 *
 * Lifecycle:
 * - `start` is a no-op while "running"; a fatal stop leaves the poller
 *   restartable and `start` clears `lastError`.
 * - `stop` aborts the current run through an `AbortController`, waits for the
 *   iteration to exit (including the handlers of a batch it already fetched)
 *   and leaves no timer behind. A restart must await `stop()` first: `start`
 *   is deliberately synchronous and only refuses to run while the loop is
 *   "running". The last offset is kept, so a restart without an explicit
 *   offset resumes where the previous run stopped. A batch that resolves after
 *   the abort is dropped without acknowledging its offset, so a restart
 *   re-fetches it.
 * - Bound of `stop`: it cancels the loop, NOT the transport. `BotClient` takes
 *   no `AbortSignal`, so `stop()` resolves only once the in-flight `getUpdates`
 *   has settled on its own — on a dead network that is up to
 *   `(retries + 1) x REQUEST_TIMEOUT_MS` of `bot.ts` (~180s with its defaults
 *   of 2 retries and a 60s per-attempt timeout, plus the short retry sleeps),
 *   and a handler that never settles extends the wait further. Callers (Task 11
 *   dispose/disable) must `await stop()`, but must not let that wait block HTTP
 *   request handling beyond the effect that owns the poller.
 * - `lastError` is cleared only by `start`: it is the last safe error of the
 *   current run, not a claim that the current state is broken.
 */

import { BotApiError, type BotClient, type BotUpdate } from "./bot.js";
import { isAuthorized } from "./updates.js";

export type PollState = "stopped" | "running" | "error";

/** Safe status snapshot for the admin API; never carries a token. */
export interface PollStatusDetail {
  state: PollState;
  lastPollAt?: string;
  lastError?: { code: string; message: string };
}

export interface PollerCallbacks {
  /** Called once per authorized update, awaited to keep delivery ordered. */
  onUpdate(update: BotUpdate): Promise<void> | void;
  /** Called once when polling dies fatally (401): the loop stops, status is "error". */
  onFatal(error: BotApiError): void;
  /**
   * Optional persistence seam: called once per successful batch with the offset
   * the poller just acknowledged (`last.update_id + 1`, the same value the next
   * `getUpdates` sends). Optional so a caller that keeps no offset — and every
   * transport-only test — can ignore it.
   */
  onAck?(nextOffset: number): void;
}

export interface Poller {
  start(opts: { bot: BotClient; allowedUserId: number; offset?: number }): void;
  /** Abort the loop and resolve once the current iteration has exited. */
  stop(): Promise<void>;
  status(): PollStatusDetail;
}

/** getUpdates long-poll timeout in seconds (Telegram caps it at 50). */
const DEFAULT_POLL_TIMEOUT_SEC = 50;
/** Pause between two polls; keeps an idle bot from spinning on the API. */
const DEFAULT_IDLE_MS = 300;
/** Ceiling of the transient-failure backoff. */
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** First backoff after a transient failure; doubles up to the ceiling. */
const INITIAL_BACKOFF_MS = 1_000;

/** Stable, safe codes reported through `status().lastError`. */
const CODE_UNAUTHORIZED = "unauthorized";
const CODE_POLL_FAILED = "poll-failed";
const CODE_UPDATE_FAILED = "update-failed";
const CODE_ACK_FAILED = "ack-failed";

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the polling loop. `pollTimeoutSec`, `idleMs` and `maxBackoffMs` are
 * injectable so unit tests can drive the loop on a virtual clock.
 */
export function createPoller(
  cb: PollerCallbacks,
  opts: { pollTimeoutSec?: number; idleMs?: number; maxBackoffMs?: number } = {}
): Poller {
  const pollTimeoutSec = opts.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let state: PollState = "stopped";
  let lastPollAt: string | undefined;
  let lastError: { code: string; message: string } | undefined;
  /** Last acknowledged update id + 1; survives a stop so a restart resumes. */
  let offset: number | undefined;
  let controller: AbortController | undefined;
  /** The run being awaited by `stop()`; cleared as soon as it settles. */
  let active: Promise<void> | undefined;

  /**
   * Sleep that `stop()` cuts short. The timer is always cleared and the abort
   * listener always removed, so a disposed poller leaves nothing pending.
   */
  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      if (signal.aborted) {
        finish();
        return;
      }
      timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  /** Poll until the loop is aborted (or dies fatally, which ends it too). */
  async function run(bot: BotClient, allowedUserId: number, signal: AbortSignal): Promise<void> {
    // The cap also bounds the very first wait: a configured cap below the 1s
    // start must shorten the first retry too, not only the later ones.
    let backoffMs = Math.min(INITIAL_BACKOFF_MS, maxBackoffMs);

    while (!signal.aborted) {
      let updates: BotUpdate[];
      try {
        const args: { offset?: number; timeout: number } = { timeout: pollTimeoutSec };
        // Omit the key entirely while there is no offset: the request body and
        // the fake-client assertions stay minimal on the first poll.
        if (offset !== undefined) args.offset = offset;
        updates = await bot.getUpdates(args);
      } catch (error) {
        if (error instanceof BotApiError && error.status === 401) {
          lastError = { code: CODE_UNAUTHORIZED, message: error.message };
          state = "error";
          cb.onFatal(error);
          return;
        }
        lastError = { code: CODE_POLL_FAILED, message: reasonOf(error) };
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        continue;
      }

      // The batch resolved while stopping: drop it without acknowledging its
      // offset, so a restart re-fetches those updates instead of losing them.
      if (signal.aborted) return;

      // Any answer is a successful long poll, empty or not.
      lastPollAt = new Date().toISOString();
      backoffMs = Math.min(INITIAL_BACKOFF_MS, maxBackoffMs);
      const last = updates[updates.length - 1];
      if (last !== undefined) {
        // The offset moves BEFORE delivery: Telegram counts these updates as
        // confirmed from here on, so an update whose handler then rejects is
        // lost by design (recorded in lastError, never retried), and an abort
        // during delivery does not rewind the offset either. An empty batch
        // acknowledges nothing and leaves the offset untouched.
        offset = last.update_id + 1;
        // Persist the ack at once: a stored offset that lags the in-memory one
        // would make a restart re-fetch — and re-execute — updates this process
        // already delivered.
        if (cb.onAck !== undefined) {
          try {
            cb.onAck(offset);
          } catch (error) {
            lastError = { code: CODE_ACK_FAILED, message: reasonOf(error) };
          }
        }
      }

      for (const update of updates) {
        // Authorization comes first: an unauthorized update is never
        // classified, delivered or otherwise observed.
        if (!isAuthorized(update, allowedUserId)) continue;
        try {
          await cb.onUpdate(update);
        } catch (error) {
          lastError = { code: CODE_UPDATE_FAILED, message: reasonOf(error) };
        }
      }

      if (signal.aborted) return;
      await sleep(idleMs, signal);
    }
  }

  function start(startOpts: { bot: BotClient; allowedUserId: number; offset?: number }): void {
    // Idempotent: a running loop keeps its state. After a fatal (or a stop) the
    // poller is startable again, which is how a replaced token takes effect.
    if (state === "running") return;
    if (startOpts.offset !== undefined) offset = startOpts.offset;

    lastError = undefined;
    state = "running";
    const runController = new AbortController();
    controller = runController;

    const task = run(startOpts.bot, startOpts.allowedUserId, runController.signal).catch((error: unknown) => {
      // `run` contains every failure it knows about; this only keeps an
      // unexpected throw from becoming an unhandled rejection.
      lastError = { code: CODE_POLL_FAILED, message: reasonOf(error) };
      if (state === "running") state = "error";
    });
    active = task;
    void task.then(() => {
      if (active === task) active = undefined;
    });
  }

  async function stop(): Promise<void> {
    const task = active;
    controller?.abort();
    // A fatal stop already reported "error"; stopping must not hide it.
    if (state === "running") state = "stopped";
    if (task !== undefined) await task;
  }

  function status(): PollStatusDetail {
    const detail: PollStatusDetail = { state };
    if (lastPollAt !== undefined) detail.lastPollAt = lastPollAt;
    if (lastError !== undefined) detail.lastError = { ...lastError };
    return detail;
  }

  return { start, stop, status };
}
