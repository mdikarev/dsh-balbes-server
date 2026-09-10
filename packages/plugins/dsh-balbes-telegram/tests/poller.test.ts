import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotApiError, type BotClient, type BotUpdate } from "../src/bot.js";
import { createPoller, type PollStatusDetail, type Poller, type PollerCallbacks } from "../src/poller.js";

const OWNER_ID = 7;
const OTHER_ID = 999;
const POLL_TIMEOUT_SEC = 50;
const DEFAULT_IDLE_MS = 300;

/**
 * Every test runs on vitest's fake clock: the loop is driven by advancing
 * virtual time, so no test ever waits a real millisecond and the gaps between
 * two polls can be asserted exactly (`Date.now()` inside the fake client is
 * virtual too). The poller itself is still configured with the small injected
 * timers (`idleMs`/`maxBackoffMs`) the unit contract asks for.
 */
beforeEach(() => {
  vi.useFakeTimers();
});

const livePollers: Poller[] = [];

/** Create a poller that the afterEach hook stops, so no loop outlives its test. */
function makePoller(
  cb: PollerCallbacks,
  opts?: { pollTimeoutSec?: number; idleMs?: number; maxBackoffMs?: number }
): Poller {
  const poller = opts === undefined ? createPoller(cb) : createPoller(cb, opts);
  livePollers.push(poller);
  return poller;
}

afterEach(async () => {
  for (const poller of livePollers.splice(0)) await poller.stop();
  vi.useRealTimers();
});

/** Body of one `getUpdates` call as the poller produced it. */
interface PollArgs {
  offset?: number;
  timeout?: number;
}

type UpdatesHandler = (args: PollArgs, call: number) => BotUpdate[] | Promise<BotUpdate[]>;

interface FakeBot {
  bot: BotClient;
  getUpdates: ReturnType<typeof vi.fn>;
}

/** Fake `BotClient` in the bot.test.ts style: only `getUpdates` matters here. */
function fakeBot(handler: UpdatesHandler): FakeBot {
  let call = 0;
  const getUpdates = vi.fn(async (args: PollArgs): Promise<BotUpdate[]> => handler(args, call++));
  const bot: BotClient = {
    getMe: vi.fn(async () => ({ id: 1, username: "sample_bot" })),
    getUpdates,
    sendMessage: vi.fn(async () => undefined),
    editMessageText: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined)
  };
  return { bot, getUpdates };
}

interface Recorder {
  callbacks: PollerCallbacks;
  /** Updates handed to `onUpdate`, in delivery order. */
  updates: BotUpdate[];
  fatals: BotApiError[];
  update: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
}

function recorder(impl?: {
  onUpdate?: (update: BotUpdate) => void | Promise<void>;
  onFatal?: (error: BotApiError) => void;
}): Recorder {
  const updates: BotUpdate[] = [];
  const fatals: BotApiError[] = [];
  const update = vi.fn(async (u: BotUpdate): Promise<void> => {
    updates.push(u);
    await impl?.onUpdate?.(u);
  });
  const fatal = vi.fn((error: BotApiError): void => {
    fatals.push(error);
    impl?.onFatal?.(error);
  });
  return { callbacks: { onUpdate: update, onFatal: fatal }, updates, fatals, update, fatal };
}

/** An allowlisted private-chat text message (the only shape that is delivered). */
function messageUpdate(updateId: number, fromId: number = OWNER_ID, chatType = "private"): BotUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: fromId, type: chatType },
      from: { id: fromId },
      text: `m${updateId}`
    }
  };
}

/** Arguments of the n-th `getUpdates` call. */
function callArgs(getUpdates: ReturnType<typeof vi.fn>, index: number): PollArgs {
  const call = getUpdates.mock.calls[index];
  if (call === undefined) throw new Error(`getUpdates call #${index} was never made`);
  return call[0] as PollArgs;
}

/** Differences between consecutive virtual timestamps. */
function gaps(stamps: number[]): number[] {
  return stamps.slice(1).map((stamp, index) => stamp - stamps[index]!);
}

describe("createPoller status", () => {
  it("reports stopped before start and survives stop() without a loop", async () => {
    const rec = recorder();
    const poller = makePoller(rec.callbacks);

    expect(poller.status()).toStrictEqual({ state: "stopped" });

    await expect(poller.stop()).resolves.toBeUndefined();
    await expect(poller.stop()).resolves.toBeUndefined();
    expect(poller.status()).toStrictEqual({ state: "stopped" });
  });
});

describe("createPoller long polling", () => {
  it("polls without an offset first and then with last.update_id + 1", async () => {
    const batch = [messageUpdate(10), messageUpdate(11)];
    const { bot, getUpdates } = fakeBot(() => batch);
    const rec = recorder();
    const poller = makePoller(rec.callbacks, { idleMs: 1, maxBackoffMs: 5 });

    poller.start({ bot, allowedUserId: OWNER_ID });
    await vi.advanceTimersByTimeAsync(0);

    expect(getUpdates).toHaveBeenCalledTimes(1);
    // No offset on the very first poll; the timeout is the 50s default.
    expect(callArgs(getUpdates, 0)).toStrictEqual({ timeout: POLL_TIMEOUT_SEC });
    expect(rec.updates.map((u) => u.update_id)).toEqual([10, 11]);

    await vi.advanceTimersByTimeAsync(1);

    expect(callArgs(getUpdates, 1)).toStrictEqual({ offset: 12, timeout: POLL_TIMEOUT_SEC });
  });

  it("delivers only allowlisted private-chat updates but still advances past the ignored ones", async () => {
    const authorized = messageUpdate(21);
    const foreignUser = messageUpdate(22, OTHER_ID);
    const groupChat = messageUpdate(23, OWNER_ID, "group");
    const foreignCallback: BotUpdate = {
      update_id: 24,
      callback_query: {
        id: "cb-1",
        from: { id: OTHER_ID },
        message: { message_id: 3, chat: { id: OTHER_ID, type: "private" } },
        data: "menu"
      }
    };
    const anonymous: BotUpdate = {
      update_id: 25,
      message: { message_id: 4, chat: { id: OWNER_ID, type: "private" }, text: "no from" }
    };
    const batch = [foreignUser, groupChat, authorized, foreignCallback, anonymous];
    const { bot, getUpdates } = fakeBot(() => batch);
    const rec = recorder();
    const poller = makePoller(rec.callbacks, { idleMs: 1, maxBackoffMs: 5 });

    poller.start({ bot, allowedUserId: OWNER_ID });
    await vi.advanceTimersByTimeAsync(0);

    expect(rec.update).toHaveBeenCalledTimes(1);
    expect(rec.updates).toEqual([authorized]);

    // An ignored update is still acknowledged: the next poll starts after it.
    await vi.advanceTimersByTimeAsync(1);
    expect(callArgs(getUpdates, 1)).toStrictEqual({ offset: 26, timeout: POLL_TIMEOUT_SEC });
  });

  it("stops the loop and reports error on a fatal 401, then stays restartable", async () => {
    const fatal = new BotApiError(401, 401, "Unauthorized");
    let failing = true;
    const { bot, getUpdates } = fakeBot(() => {
      if (failing) throw fatal;
      return [];
    });
    let statusInsideFatal: PollStatusDetail | undefined;
    let poller: Poller;
    const rec = recorder({ onFatal: () => { statusInsideFatal = poller.status(); } });
    poller = makePoller(rec.callbacks, { idleMs: 1, maxBackoffMs: 5 });

    poller.start({ bot, allowedUserId: OWNER_ID });
    await vi.advanceTimersByTimeAsync(0);

    expect(rec.fatal).toHaveBeenCalledTimes(1);
    expect(rec.fatals[0]).toBe(fatal);
    // The status is already "error" while onFatal runs, and the handler is the
    // only error channel: no update is delivered and no timer is left behind.
    expect(statusInsideFatal).toStrictEqual({
      state: "error",
      lastError: { code: "unauthorized", message: "Unauthorized" }
    });
    expect(rec.update).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getUpdates).toHaveBeenCalledTimes(1);

    await poller.stop();
    expect(poller.status().state).toBe("error");

    // A fatal stop is recoverable: start() runs a new loop and clears lastError.
    failing = false;
    poller.start({ bot, allowedUserId: OWNER_ID, offset: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(getUpdates).toHaveBeenCalledTimes(2);
    expect(poller.status()).toMatchObject({ state: "running" });
    expect(poller.status().lastError).toBeUndefined();
  });

  it("backs off on a transient BotApiError and resets the backoff after a successful batch", async () => {
    const stamps: number[] = [];
    const { bot, getUpdates } = fakeBot((_args, call) => {
      stamps.push(Date.now());
      if (call === 0) throw new BotApiError(500, 500, "Internal Server Error");
      return [];
    });
    const rec = recorder();
    const poller = makePoller(rec.callbacks, { idleMs: 1, maxBackoffMs: 40 });

    poller.start({ bot, allowedUserId: OWNER_ID });
    await vi.advanceTimersByTimeAsync(0);

    // Transient: the loop survives, the failure is recorded, the state stays running.
    expect(rec.fatal).not.toHaveBeenCalled();
    expect(poller.status()).toStrictEqual({
      state: "running",
      lastError: { code: "poll-failed", message: "Internal Server Error" }
    });
    expect(vi.getTimerCount()).toBe(1);

    // The retry waits the capped backoff (min(1s, maxBackoffMs)), not idleMs.
    await vi.advanceTimersByTimeAsync(40);

    expect(getUpdates).toHaveBeenCalledTimes(2);
    expect(gaps(stamps)).toEqual([40]);
    expect(poller.status().lastPollAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A successful batch resets the backoff: only the idle pause is left.
    await vi.advanceTimersByTimeAsync(1);

    expect(gaps(stamps)).toEqual([40, 1]);
    expect(poller.status().state).toBe("running");
  });

  it("starts the backoff at 1s, doubles it to the 30s default cap and resets it after success", async () => {
    const stamps: number[] = [];
    let failing = true;
    const { bot } = fakeBot(() => {
      stamps.push(Date.now());
      if (failing) throw new Error("network down");
      return [];
    });
    const rec = recorder();
    const poller = makePoller(rec.callbacks); // all defaults

    poller.start({ bot, allowedUserId: OWNER_ID });
    await vi.advanceTimersByTimeAsync(0);

    // 1s, 2s, 4s, 8s, 16s and then the 30s cap (uncapped doubling would be 32s).
    for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(wait);
    }

    expect(stamps).toHaveLength(7);
    expect(gaps(stamps)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(poller.status()).toMatchObject({ state: "running", lastError: { code: "poll-failed" } });

    // Success resets the wait to the default 300ms idle pause: the pending
    // capped backoff first fires the successful poll, and only the poll after
    // it is back on the idle cadence.
    failing = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gaps(stamps).at(-1)).toBe(30_000);

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS);

    expect(gaps(stamps).at(-1)).toBe(DEFAULT_IDLE_MS);
    expect(poller.status().lastPollAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ignores a second start while the loop is running", async () => {
    const { bot, getUpdates } = fakeBot(() => []);
    const rec = recorder();
    const poller = makePoller(rec.callbacks, { idleMs: 1, maxBackoffMs: 5 });

    poller.start({ bot, allowedUserId: OWNER_ID });
    poller.start({ bot, allowedUserId: OWNER_ID, offset: 999 });
    await vi.advanceTimersByTimeAsync(0);

    // One loop only, and the offset of the ignored start never reached the API.
    expect(getUpdates).toHaveBeenCalledTimes(1);
    expect(callArgs(getUpdates, 0)).toStrictEqual({ timeout: POLL_TIMEOUT_SEC });

    await vi.advanceTimersByTimeAsync(1);

    expect(getUpdates).toHaveBeenCalledTimes(2);
  });

  it("finishes the batch it already fetched before stop() resolves", async () => {
    let releaseHandler: (() => void) | undefined;
    const deliveries: number[] = [];
    const { bot, getUpdates } = fakeBot(() => [messageUpdate(51), messageUpdate(52)]);
    const rec = recorder({
      onUpdate: async (update) => {
        deliveries.push(update.update_id);
        if (update.update_id === 51) {
          await new Promise<void>((resolve) => {
            releaseHandler = resolve;
          });
        }
      }
    });
    const poller = makePoller(rec.callbacks, { idleMs: 1, maxBackoffMs: 5 });

    poller.start({ bot, allowedUserId: OWNER_ID });
    await vi.advanceTimersByTimeAsync(0);
    expect(deliveries).toEqual([51]);

    // stop() waits for the iteration in flight: a handler (and the rest of the
    // fetched batch) still completes. Those updates are already acknowledged by
    // the offset, so dropping them would lose them for good.
    let settled = false;
    const stopped = poller.stop();
    void stopped.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    releaseHandler?.();
    await expect(stopped).resolves.toBeUndefined();

    expect(deliveries).toEqual([51, 52]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getUpdates).toHaveBeenCalledTimes(1);
  });

  it("keeps polling when onUpdate rejects", async () => {
    const { bot, getUpdates } = fakeBot((_args, call) => (call === 0 ? [messageUpdate(31), messageUpdate(32)] : []));
    const rec = recorder({
      onUpdate: (update) => {
        if (update.update_id === 31) throw new Error("handler boom");
      }
    });
    const poller = makePoller(rec.callbacks, { idleMs: 1, maxBackoffMs: 5 });

    poller.start({ bot, allowedUserId: OWNER_ID });
    await vi.advanceTimersByTimeAsync(0);

    // The failing update does not swallow the rest of the batch...
    expect(rec.update).toHaveBeenCalledTimes(2);
    expect(poller.status()).toMatchObject({ lastError: { code: "update-failed", message: "handler boom" } });
    expect(poller.status().state).toBe("running");

    // ...nor does it stop the loop.
    await vi.advanceTimersByTimeAsync(1);
    expect(getUpdates).toHaveBeenCalledTimes(2);
  });

  it("drops a batch that lands while stopping and resolves stop()", async () => {
    let release: ((updates: BotUpdate[]) => void) | undefined;
    const { bot, getUpdates } = fakeBot(
      () =>
        new Promise<BotUpdate[]>((resolve) => {
          release = resolve;
        })
    );
    const rec = recorder();
    const poller = makePoller(rec.callbacks, { idleMs: 1, maxBackoffMs: 5 });

    poller.start({ bot, allowedUserId: OWNER_ID });
    await vi.advanceTimersByTimeAsync(0);
    expect(getUpdates).toHaveBeenCalledTimes(1);
    expect(release).toBeDefined();

    const stopped = poller.stop();
    release?.([messageUpdate(41)]);
    await expect(stopped).resolves.toBeUndefined();

    // The in-flight long poll resolved after the abort: it is not processed and
    // its offset stays unacknowledged, so a restart re-fetches those updates.
    expect(rec.update).not.toHaveBeenCalled();
    expect(poller.status()).toStrictEqual({ state: "stopped" });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getUpdates).toHaveBeenCalledTimes(1);
  });

  it("stops polling on stop(), leaves no timer behind and restarts from the last offset", async () => {
    const { bot, getUpdates } = fakeBot((_args, call) => (call === 0 ? [messageUpdate(5)] : []));
    const rec = recorder();
    const poller = makePoller(rec.callbacks, { idleMs: 1, maxBackoffMs: 5 });

    poller.start({ bot, allowedUserId: OWNER_ID });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(getUpdates).toHaveBeenCalledTimes(2);

    await poller.stop();

    // Stopping keeps the last successful poll time (the admin shows it) but
    // drops every timer the loop owned.
    expect(poller.status()).toMatchObject({ state: "stopped" });
    expect(poller.status().lastPollAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getUpdates).toHaveBeenCalledTimes(2);

    // Restart without an offset resumes after the last acknowledged update.
    poller.start({ bot, allowedUserId: OWNER_ID });
    await vi.advanceTimersByTimeAsync(0);
    expect(callArgs(getUpdates, 2)).toStrictEqual({ offset: 6, timeout: POLL_TIMEOUT_SEC });

    // An explicit offset on restart wins over the remembered one.
    await poller.stop();
    poller.start({ bot, allowedUserId: OWNER_ID, offset: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(callArgs(getUpdates, 3)).toStrictEqual({ offset: 100, timeout: POLL_TIMEOUT_SEC });
    expect(poller.status()).toMatchObject({ state: "running" });
  });
});
