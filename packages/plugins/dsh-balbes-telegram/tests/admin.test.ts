import { describe, expect, it, vi } from "vitest";
import {
  bindRuntimeToSettings,
  buildTelegramStatus,
  createTelegramRuntime,
  pollerTimingOptions,
  registerTelegramRoutes,
  restoreTelegramBoot,
  workspaceRefFromKey,
  type HttpSeatLike,
  type ResLike,
  type TelegramAdminDeps,
  type TelegramRuntime,
  type TelegramSettingsSection
} from "../src/admin.js";
import { BotApiError, type BotClient, type BotUpdate } from "../src/bot.js";
import type { Poller, PollStatusDetail } from "../src/poller.js";
import type { TelegramStateData } from "../src/state.js";
import { TELEGRAM_BOT_TOKEN_REF } from "../src/index.js";

/** One captured route registration. */
interface Seat {
  path: string;
  auth: string;
  handler(req: unknown, res: unknown, body: unknown): Promise<void> | void;
}

/** A real-looking (never valid) bot token: every response body is scanned for it. */
const TOKEN = "123456789:AAHsecretTOKENvalue";

class FakeScope {
  updates: object[] = [];
  watchers: Array<(next: TelegramSettingsSection, prev: TelegramSettingsSection) => void | Promise<void>> = [];
  value: TelegramSettingsSection;

  constructor(value: TelegramSettingsSection = { enabled: false, allowedUserId: null }) {
    this.value = value;
  }

  get(): TelegramSettingsSection {
    return { ...this.value };
  }

  async update(patch: object): Promise<void> {
    this.updates.push(patch);
    const prev = this.get();
    this.value = { ...this.value, ...(patch as TelegramSettingsSection) };
    await this.commit(this.get(), prev);
  }

  watch(callback: (next: TelegramSettingsSection, prev: TelegramSettingsSection) => void | Promise<void>): () => void {
    this.watchers.push(callback);
    return () => {
      this.watchers = this.watchers.filter((w) => w !== callback);
    };
  }

  /** Simulate a settings commit made outside the routes (as the SPA would). */
  async commit(next: TelegramSettingsSection, prev: TelegramSettingsSection): Promise<void> {
    this.value = next;
    for (const watcher of this.watchers) await watcher(next, prev);
  }
}

class FakeCredentials {
  refs = new Map<string, string>();
  setCalls: Array<{ ref: string; value: string }> = [];
  unsetCalls: string[] = [];
  /** When set, resolving the VALUE fails (a broken credential provider). */
  resolveError: unknown;

  async describe(ref: string): Promise<{ configured: boolean; writable: boolean }> {
    return { configured: this.refs.has(ref), writable: true };
  }

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    if (this.resolveError !== undefined) throw this.resolveError;
    const value = this.refs.get(ref);
    return value === undefined ? undefined : { value, source: "test" };
  }

  async set(ref: string, value: string): Promise<void> {
    this.setCalls.push({ ref, value });
    this.refs.set(ref, value);
  }

  async unset(ref: string): Promise<void> {
    this.unsetCalls.push(ref);
    this.refs.delete(ref);
  }
}

class FakePoller implements Poller {
  starts: Array<{ bot: BotClient; allowedUserId: number; offset?: number }> = [];
  stops = 0;
  detail: PollStatusDetail = { state: "stopped" };
  /**
   * When set, `stop()` parks on it before settling — the window a real poller
   * spends waiting for an in-flight long poll to return.
   */
  stopGate: Promise<void> | undefined;

  start(opts: { bot: BotClient; allowedUserId: number; offset?: number }): void {
    this.starts.push(opts);
    const { lastPollAt } = this.detail;
    this.detail = { state: "running", ...(lastPollAt !== undefined ? { lastPollAt } : {}) };
  }

  async stop(): Promise<void> {
    this.stops += 1;
    const gate = this.stopGate;
    if (gate !== undefined) await gate;
    const { lastPollAt } = this.detail;
    this.detail = { state: this.detail.state === "error" ? "error" : "stopped", ...(lastPollAt !== undefined ? { lastPollAt } : {}) };
  }

  status(): PollStatusDetail {
    return { ...this.detail, ...(this.detail.lastError !== undefined ? { lastError: { ...this.detail.lastError } } : {}) };
  }
}

class FakeBot implements BotClient {
  getMeCalls = 0;
  getUpdatesCalls = 0;
  getMeError: unknown;
  me: { username?: string; id?: number } = { username: "test_bot", id: 42 };

  async getMe(): Promise<{ username?: string; id?: number }> {
    this.getMeCalls += 1;
    // A real getMe is a round trip: the identity lands on a later tick, never
    // inside the transition that requested it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.getMeError !== undefined) throw this.getMeError;
    return this.me;
  }

  async getUpdates(_opts: { offset?: number; timeout?: number }): Promise<BotUpdate[]> {
    this.getUpdatesCalls += 1;
    return [];
  }

  async sendMessage(): Promise<number> {
    return 1;
  }

  async editMessageText(): Promise<void> {}

  async answerCallbackQuery(): Promise<void> {}
}

function makeRes(): { res: ResLike; read(): { status: number; raw: string; json: unknown } } {
  const box = { status: 0, raw: "" };
  return {
    res: {
      writeHead(status: number) {
        box.status = status;
      },
      end(body?: string) {
        box.raw = String(body ?? "");
      }
    },
    read: () => ({ status: box.status, raw: box.raw, json: JSON.parse(box.raw) as unknown })
  };
}

interface Harness {
  seats: Seat[];
  http: HttpSeatLike;
  scope: FakeScope;
  credentials: FakeCredentials;
  poller: FakePoller;
  bots: FakeBot[];
  runtime: TelegramRuntime;
  deps: TelegramAdminDeps;
  call(path: string, body?: unknown): Promise<{ status: number; raw: string; json: unknown }>;
}

function harness(opts: { scope?: FakeScope; tokenConfigured?: boolean } = {}): Harness {
  const seats: Seat[] = [];
  const http: HttpSeatLike = {
    post(path, auth, handler) {
      seats.push({ path, auth, handler: handler as Seat["handler"] });
    }
  };
  const scope = opts.scope ?? new FakeScope();
  const credentials = new FakeCredentials();
  if (opts.tokenConfigured === true) credentials.refs.set(TELEGRAM_BOT_TOKEN_REF, TOKEN);
  const poller = new FakePoller();
  const bots: FakeBot[] = [];
  const botFactory = (): BotClient => {
    const bot = new FakeBot();
    bots.push(bot);
    return bot;
  };
  const runtime = createTelegramRuntime({
    settingsScope: scope,
    resolveToken: async () => (await credentials.resolve(TELEGRAM_BOT_TOKEN_REF))?.value,
    botFactory,
    poller,
    initialOffset: () => 5
  });
  const deps: TelegramAdminDeps = {
    settingsScope: scope,
    credentials,
    resolveToken: async () => (await credentials.resolve(TELEGRAM_BOT_TOKEN_REF))?.value,
    botFactory,
    poller,
    statusExtras: async () => {
      const extras: {
        botUsername?: string;
        lastPollAt?: string;
        runtimeError?: { code: string; message: string };
      } = {};
      const username = runtime.botUsername();
      const lastPollAt = runtime.lastPollAt();
      const runtimeError = runtime.lastError();
      if (username !== undefined) extras.botUsername = username;
      if (lastPollAt !== undefined) extras.lastPollAt = lastPollAt;
      if (runtimeError !== undefined) extras.runtimeError = runtimeError;
      return extras;
    },
    // The deps type is `() => void` (routes REQUEST a transition, never join it),
    // but the fake deliberately hands back the joinable promise as well: a route
    // that started awaiting it would block on a deferred stop, which the
    // promptness test below then catches.
    applyRuntime: () => runtime.apply()
  };
  registerTelegramRoutes(http, deps);

  return {
    seats,
    http,
    scope,
    credentials,
    poller,
    bots,
    runtime,
    deps,
    async call(path: string, body: unknown = {}) {
      const seat = seats.find((s) => s.path === path);
      if (seat === undefined) throw new Error(`no seat for ${path}`);
      const { res, read } = makeRes();
      await seat.handler({}, res, body);
      return read();
    }
  };
}

describe("registerTelegramRoutes", () => {
  it("registers the five bearer POST routes", () => {
    const h = harness();
    expect(h.seats.map((s) => [s.path, s.auth])).toEqual([
      ["/api/telegram/status", "bearer"],
      ["/api/telegram/save", "bearer"],
      ["/api/telegram/test", "bearer"],
      ["/api/telegram/disable", "bearer"],
      ["/api/telegram/clear-token", "bearer"]
    ]);
  });

  it("never returns the token, in any route, on any outcome", async () => {
    const h = harness({ tokenConfigured: true });
    const responses = [
      await h.call("/api/telegram/status"),
      await h.call("/api/telegram/test"),
      await h.call("/api/telegram/save", { token: TOKEN, allowedUserId: 7, enabled: true }),
      await h.call("/api/telegram/save", { allowedUserId: 0 }),
      await h.call("/api/telegram/disable"),
      await h.call("/api/telegram/clear-token")
    ];
    for (const response of responses) {
      expect(response.raw).not.toContain(TOKEN);
      expect(response.raw).not.toMatch(/"token"\s*:/);
      expect(response.raw).not.toContain("botToken");
    }
  });
});

describe("POST /api/telegram/status", () => {
  it("reports not-configured without a stored token", async () => {
    const h = harness();
    const { status, json } = await h.call("/api/telegram/status");
    expect(status).toBe(200);
    expect(json).toEqual({
      status: { state: "not-configured", tokenConfigured: false, enabled: false }
    });
  });

  it("reports disabled while a token is stored but the bot is switched off", async () => {
    const h = harness({ scope: new FakeScope({ enabled: false, allowedUserId: 7 }), tokenConfigured: true });
    const { json } = await h.call("/api/telegram/status");
    expect(json).toEqual({
      status: { state: "disabled", tokenConfigured: true, enabled: false, allowedUserId: 7 }
    });
  });

  it("reports connected while the poller runs, with the bot identity and the last poll time", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    h.poller.detail = { state: "running", lastPollAt: "2026-09-10T10:00:00.000Z" };
    await h.runtime.apply();
    await h.runtime.botInfoSettled();

    const { json } = await h.call("/api/telegram/status");
    expect(json).toEqual({
      status: {
        state: "connected",
        tokenConfigured: true,
        enabled: true,
        allowedUserId: 7,
        botUsername: "test_bot",
        lastPollAt: "2026-09-10T10:00:00.000Z"
      }
    });
  });

  it("reports error with the poller's safe code when polling died fatally", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    h.poller.detail = { state: "error", lastError: { code: "unauthorized", message: "Unauthorized" } };
    const { status, json } = await h.call("/api/telegram/status");
    expect(status).toBe(200);
    expect(json).toEqual({
      status: {
        state: "error",
        tokenConfigured: true,
        enabled: true,
        allowedUserId: 7,
        error: { code: "unauthorized", message: "Unauthorized" }
      }
    });
  });

  it("reports error when the bot is enabled but nothing is polling", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    const { json } = await h.call("/api/telegram/status");
    const status = (json as { status: { state: string; error: { code: string; message: string } } }).status;
    expect(status.state).toBe("error");
    expect(status.error.code).toBe("not-running");
    expect(status.error.message).toEqual(expect.any(String));
  });

  it("keeps a transient lastError out of the state while the loop still runs", async () => {
    // The poller keeps "running" through a transient failure and only clears
    // lastError on the next start: reporting it as the state would show a
    // permanent failure for a single network blip.
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    h.poller.detail = { state: "running", lastError: { code: "poll-failed", message: "socket hang up" } };
    const { json } = await h.call("/api/telegram/status");
    expect(json).toEqual({
      status: { state: "connected", tokenConfigured: true, enabled: true, allowedUserId: 7 }
    });
  });

  it("answers 500 with the R-API-1 envelope when the settings read throws", async () => {
    const h = harness();
    h.scope.get = () => {
      throw new Error("settings unavailable");
    };
    const { status, json } = await h.call("/api/telegram/status");
    expect(status).toBe(500);
    expect(json).toEqual({ error: { code: "internal", message: "settings unavailable" } });
  });
});

describe("POST /api/telegram/save", () => {
  it("stores a trimmed token and reports it as configured without echoing it", async () => {
    const h = harness();
    const { status, json } = await h.call("/api/telegram/save", { token: `  ${TOKEN}  ` });
    expect(status).toBe(200);
    expect(h.credentials.setCalls).toEqual([{ ref: TELEGRAM_BOT_TOKEN_REF, value: TOKEN }]);
    expect(h.scope.updates).toEqual([]);
    expect(json).toEqual({ status: { state: "disabled", tokenConfigured: true, enabled: false } });
    expect(h.poller.starts).toEqual([]);
  });

  it("leaves the credential alone when the token is absent, empty, whitespace or not a string", async () => {
    const h = harness({ tokenConfigured: true });
    for (const token of [undefined, "", "   ", 42, null, {}]) {
      const { status } = await h.call("/api/telegram/save", { token, allowedUserId: 7 });
      expect(status).toBe(200);
    }
    expect(h.credentials.setCalls).toEqual([]);
    expect(h.scope.updates).toHaveLength(6);
  });

  it.each([[0], [-1], [1.5], ["abc"], [null], [true], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "answers 400 invalid-user-id for allowedUserId %s",
    async (allowedUserId) => {
      const h = harness({ tokenConfigured: true });
      const { status, json } = await h.call("/api/telegram/save", { allowedUserId, enabled: true });
      expect(status).toBe(400);
      expect(json).toEqual({ error: { code: "invalid-user-id", message: expect.any(String) } });
      expect(h.scope.updates).toEqual([]);
      expect(h.poller.starts).toEqual([]);
    }
  );

  it("refuses to enable the bot without a token", async () => {
    const h = harness();
    const { status, json } = await h.call("/api/telegram/save", { enabled: true, allowedUserId: 7 });
    expect(status).toBe(400);
    expect(json).toEqual({ error: { code: "invalid-config", message: expect.any(String) } });
    expect(h.scope.updates).toEqual([]);
    expect(h.poller.starts).toEqual([]);
  });

  it("refuses to enable the bot without a User ID", async () => {
    const h = harness({ tokenConfigured: true });
    const { status, json } = await h.call("/api/telegram/save", { enabled: true });
    expect(status).toBe(400);
    expect(json).toEqual({ error: { code: "invalid-config", message: expect.any(String) } });
  });

  it("enables the bot and starts polling on the same call", async () => {
    const h = harness({ tokenConfigured: true });
    const { status, json } = await h.call("/api/telegram/save", { allowedUserId: 7, enabled: true });
    expect(status).toBe(200);
    expect(h.scope.updates).toEqual([{ allowedUserId: 7, enabled: true }]);
    // The response is a snapshot: the transition is requested, not joined, so it
    // reports the settings and whatever the runtime already shows.
    expect(json).toMatchObject({ status: { tokenConfigured: true, enabled: true, allowedUserId: 7 } });

    await h.runtime.settled();
    expect(h.poller.starts).toHaveLength(1);
    expect(h.poller.starts[0]?.allowedUserId).toBe(7);
    expect(h.poller.starts[0]?.bot).toBe(h.bots[0]);
    expect(h.poller.starts[0]?.offset).toBe(5);
    // a later /status reports where the loop ended up
    const after = await h.call("/api/telegram/status");
    expect(after.json).toEqual({
      status: { state: "connected", tokenConfigured: true, enabled: true, allowedUserId: 7 }
    });
  });

  it("ignores a non-boolean enabled instead of guessing", async () => {
    const h = harness({ tokenConfigured: true });
    const { status } = await h.call("/api/telegram/save", { enabled: "yes", allowedUserId: 7 });
    expect(status).toBe(200);
    expect(h.scope.updates).toEqual([{ allowedUserId: 7 }]);
    expect(h.poller.starts).toEqual([]);
  });

  it("keeps the stored token when saving only the User ID", async () => {
    const h = harness({ tokenConfigured: true });
    const { status } = await h.call("/api/telegram/save", { allowedUserId: 7 });
    expect(status).toBe(200);
    expect(h.credentials.setCalls).toEqual([]);
    expect(h.credentials.refs.get(TELEGRAM_BOT_TOKEN_REF)).toBe(TOKEN);
  });

  it("does not store a token it is about to refuse", async () => {
    const h = harness();
    const { status } = await h.call("/api/telegram/save", { token: TOKEN, enabled: true });
    expect(status).toBe(400);
    expect(h.credentials.setCalls).toEqual([]);
    expect(h.credentials.refs.size).toBe(0);
  });

  it("restarts polling on a fresh client when the save replaces the token", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();
    expect(h.poller.starts).toHaveLength(1);

    const replaced = "999999999:AAHreplacement";
    const { status, raw, json } = await h.call("/api/telegram/save", { token: replaced });

    expect(status).toBe(200);
    expect(h.credentials.refs.get(TELEGRAM_BOT_TOKEN_REF)).toBe(replaced);
    expect(raw).not.toContain("AAHreplacement");
    expect(json).toMatchObject({ status: { tokenConfigured: true, enabled: true, allowedUserId: 7 } });

    await h.runtime.settled();
    expect(h.bots).toHaveLength(2);
    expect(h.poller.starts).toHaveLength(2);
    expect(h.poller.starts[1]?.bot).toBe(h.bots[1]);
    expect(h.runtime.bot()).toBe(h.bots[1]);
    // the poller keeps its own offset after the first start
    expect(h.poller.starts[1]?.offset).toBeUndefined();
    const after = await h.call("/api/telegram/status");
    expect(after.json).toMatchObject({
      status: { state: "connected", tokenConfigured: true, enabled: true, allowedUserId: 7 }
    });
  });
});

describe("POST /api/telegram/test", () => {
  it("answers 400 not-configured without a stored token and never builds a client", async () => {
    const h = harness();
    const { status, json } = await h.call("/api/telegram/test");
    expect(status).toBe(400);
    expect(json).toEqual({ error: { code: "not-configured", message: expect.any(String) } });
    expect(h.bots).toEqual([]);
    expect(h.poller.starts).toEqual([]);
  });

  it("calls getMe and returns the username without touching polling or the settings", async () => {
    const h = harness({ tokenConfigured: true });
    const { status, json } = await h.call("/api/telegram/test");
    expect(status).toBe(200);
    expect(json).toEqual({ username: "test_bot" });
    expect(h.bots).toHaveLength(1);
    expect(h.bots[0]?.getMeCalls).toBe(1);
    expect(h.poller.starts).toEqual([]);
    expect(h.poller.stops).toBe(0);
    expect(h.scope.updates).toEqual([]);
    expect(h.credentials.refs.get(TELEGRAM_BOT_TOKEN_REF)).toBe(TOKEN);
  });

  it("starts nothing even while the bot is switched on", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    const { status, json } = await h.call("/api/telegram/test");
    expect(status).toBe(200);
    expect(json).toEqual({ username: "test_bot" });
    expect(h.poller.starts).toEqual([]);
    expect(h.poller.stops).toBe(0);
    expect(h.scope.updates).toEqual([]);
  });

  it("answers 400 invalid-token when Telegram rejects the token", async () => {
    const h = harness({ tokenConfigured: true });
    const bot = new FakeBot();
    bot.getMeError = new BotApiError(401, 401, "Unauthorized");
    h.deps.botFactory = () => bot;
    const { status, json } = await h.call("/api/telegram/test");
    expect(status).toBe(400);
    expect(json).toEqual({ error: { code: "invalid-token", message: expect.any(String) } });
    expect(JSON.stringify(json)).not.toContain(TOKEN);
  });

  it("answers 502 telegram-error when Telegram fails in any other way", async () => {
    const h = harness({ tokenConfigured: true });
    const bot = new FakeBot();
    bot.getMeError = new BotApiError(500, undefined, "temporary failure: http 500");
    h.deps.botFactory = () => bot;
    const { status, json } = await h.call("/api/telegram/test");
    expect(status).toBe(502);
    expect(json).toEqual({ error: { code: "telegram-error", message: "temporary failure: http 500" } });
  });

  it("answers 502 without leaking an unexpected error's internals", async () => {
    const h = harness({ tokenConfigured: true });
    const bot = new FakeBot();
    bot.getMeError = new Error(`boom ${TOKEN}`);
    h.deps.botFactory = () => bot;
    const { status, json } = await h.call("/api/telegram/test");
    expect(status).toBe(502);
    expect(json).toEqual({ error: { code: "telegram-error", message: "getMe failed" } });
  });
});

describe("POST /api/telegram/disable", () => {
  it("switches the setting off, stops polling and answers disabled", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();
    expect(h.poller.status().state).toBe("running");

    const { status, json } = await h.call("/api/telegram/disable");
    expect(status).toBe(200);
    expect(h.scope.updates).toEqual([{ enabled: false }]);
    expect(json).toEqual({
      status: { state: "disabled", tokenConfigured: true, enabled: false, allowedUserId: 7 }
    });

    await h.runtime.settled();
    expect(h.poller.status().state).toBe("stopped");
  });

  it("answers while the stop is still draining an in-flight long poll", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();
    expect(h.poller.status().state).toBe("running");

    // The stop parks until the in-flight getUpdates returns.
    let releaseStop!: () => void;
    h.poller.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    const { status, json } = await h.call("/api/telegram/disable");

    // the response is built from the settings + the current snapshot, not from
    // the transition: the loop is still winding down at this point
    expect(status).toBe(200);
    expect(json).toEqual({
      status: { state: "disabled", tokenConfigured: true, enabled: false, allowedUserId: 7 }
    });
    expect(h.scope.updates).toEqual([{ enabled: false }]);
    expect(h.poller.status().state).toBe("running");

    h.poller.stopGate = undefined;
    releaseStop();
    await h.runtime.settled();
    expect(h.poller.status().state).toBe("stopped");
    expect(h.poller.starts).toHaveLength(1);
  });
});

describe("POST /api/telegram/clear-token", () => {
  it("unsets the credential, switches the setting off, stops polling and answers not-configured", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();

    const { status, json } = await h.call("/api/telegram/clear-token");
    expect(status).toBe(200);
    expect(h.credentials.unsetCalls).toEqual([TELEGRAM_BOT_TOKEN_REF]);
    expect(h.credentials.refs.size).toBe(0);
    expect(h.scope.updates).toEqual([{ enabled: false }]);
    expect(json).toEqual({
      status: { state: "not-configured", tokenConfigured: false, enabled: false, allowedUserId: 7 }
    });

    await h.runtime.settled();
    expect(h.poller.status().state).toBe("stopped");
  });

  it("keeps the disabled flag when the credential was already gone", async () => {
    const h = harness();
    const { status, json } = await h.call("/api/telegram/clear-token");
    expect(status).toBe(200);
    expect(json).toEqual({ status: { state: "not-configured", tokenConfigured: false, enabled: false } });
  });
});

describe("createTelegramRuntime", () => {
  it("starts polling on the configured allowlist with the restored offset", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();

    expect(h.poller.starts).toHaveLength(1);
    expect(h.poller.starts[0]).toMatchObject({ allowedUserId: 7, offset: 5 });
    expect(h.poller.starts[0]?.bot).toBe(h.bots[0]);
  });

  it("is idempotent: an unchanged reconciliation does not restart the loop", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();
    await h.runtime.apply();

    expect(h.poller.starts).toHaveLength(1);
    expect(h.poller.stops).toBe(1);
  });

  it("restarts polling when the allowlist changes", async () => {
    const scope = new FakeScope({ enabled: true, allowedUserId: 7 });
    const h = harness({ scope, tokenConfigured: true });
    await h.runtime.apply();

    scope.value = { enabled: true, allowedUserId: 8 };
    await h.runtime.apply();

    expect(h.poller.starts).toHaveLength(2);
    expect(h.poller.starts[1]?.allowedUserId).toBe(8);
    expect(h.poller.starts[1]?.bot).toBe(h.bots[0]);
  });

  it("restarts polling on a new client when the token changes", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();

    h.credentials.refs.set(TELEGRAM_BOT_TOKEN_REF, "999:NEWTOKEN");
    await h.runtime.apply();

    expect(h.bots).toHaveLength(2);
    expect(h.poller.starts).toHaveLength(2);
    expect(h.poller.starts[1]?.bot).toBe(h.bots[1]);
  });

  it("stops polling when the bot is switched off", async () => {
    const scope = new FakeScope({ enabled: true, allowedUserId: 7 });
    const h = harness({ scope, tokenConfigured: true });
    await h.runtime.apply();

    scope.value = { enabled: false, allowedUserId: 7 };
    await h.runtime.apply();

    expect(h.poller.status().state).toBe("stopped");
    expect(h.poller.starts).toHaveLength(1);
  });

  it("stops polling when the token disappears", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();

    h.credentials.refs.delete(TELEGRAM_BOT_TOKEN_REF);
    await h.runtime.apply();

    expect(h.poller.status().state).toBe("stopped");
  });

  it("refuses to poll while enabled without a token or without an allowlist", async () => {
    const warns: string[] = [];
    const scope = new FakeScope({ enabled: true, allowedUserId: null });
    const poller = new FakePoller();
    const credentials = new FakeCredentials();
    credentials.refs.set(TELEGRAM_BOT_TOKEN_REF, TOKEN);
    const runtime = createTelegramRuntime({
      settingsScope: scope,
      resolveToken: async () => credentials.refs.get(TELEGRAM_BOT_TOKEN_REF),
      botFactory: () => new FakeBot(),
      poller,
      logger: { warn: (m: string) => warns.push(m) }
    });

    await runtime.apply();
    expect(poller.starts).toEqual([]);

    credentials.refs.delete(TELEGRAM_BOT_TOKEN_REF);
    scope.value = { enabled: true, allowedUserId: 7 };
    await runtime.apply();

    expect(poller.starts).toEqual([]);
    expect(warns).toHaveLength(2);
  });

  it("exposes the current client only while a token is stored", async () => {
    const h = harness({ scope: new FakeScope({ enabled: false, allowedUserId: 7 }), tokenConfigured: false });
    await h.runtime.apply();
    expect(() => h.runtime.bot()).toThrow();

    h.credentials.refs.set(TELEGRAM_BOT_TOKEN_REF, TOKEN);
    await h.runtime.apply();
    expect(h.runtime.bot()).toBe(h.bots[0]);
  });

  it("caches the bot username from getMe without blocking the transition", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();
    expect(h.bots[0]?.getMeCalls).toBe(1);
    await h.runtime.botInfoSettled();
    expect(h.runtime.botUsername()).toBe("test_bot");
  });

  it("survives a failing getMe and reports no username", async () => {
    const warns: string[] = [];
    const scope = new FakeScope({ enabled: true, allowedUserId: 7 });
    const credentials = new FakeCredentials();
    credentials.refs.set(TELEGRAM_BOT_TOKEN_REF, TOKEN);
    const poller = new FakePoller();
    const bot = new FakeBot();
    bot.getMeError = new BotApiError(401, 401, "Unauthorized");
    const runtime = createTelegramRuntime({
      settingsScope: scope,
      resolveToken: async () => credentials.refs.get(TELEGRAM_BOT_TOKEN_REF),
      botFactory: () => bot,
      poller,
      logger: { warn: (m: string) => warns.push(m) }
    });

    await runtime.apply();
    await runtime.botInfoSettled();

    expect(runtime.botUsername()).toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(poller.starts).toHaveLength(1);
  });

  it("consumes the restored offset once and then lets the poller keep its own", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();
    h.credentials.refs.set(TELEGRAM_BOT_TOKEN_REF, "999:NEWTOKEN");
    await h.runtime.apply();

    expect(h.poller.starts[0]?.offset).toBe(5);
    expect(h.poller.starts[1]?.offset).toBeUndefined();
  });

  it("reports the poller's last poll time for the status endpoint", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    h.poller.detail = { state: "running", lastPollAt: "2026-09-10T11:00:00.000Z" };
    expect(h.runtime.lastPollAt()).toBe("2026-09-10T11:00:00.000Z");
  });
});

describe("runtime transition serialization", () => {
  /** A harness with a loop already running for allowlist 7. */
  async function running(): Promise<Harness> {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    await h.runtime.apply();
    expect(h.poller.status().state).toBe("running");
    expect(h.poller.starts).toHaveLength(1);
    return h;
  }

  it("does not restart a loop the newest intent forbids when a commit lands mid-stop", async () => {
    const h = await running();

    // Transition A (allowlist 7 -> 8) parks inside stop(), which in production
    // waits for the in-flight long poll to return.
    let releaseStop!: () => void;
    h.poller.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    h.scope.value = { enabled: true, allowedUserId: 8 };
    const changing = h.runtime.apply();
    await vi.waitFor(() => expect(h.poller.stops).toBe(2));

    // ...and the owner disables the bot inside that window.
    h.scope.value = { enabled: false, allowedUserId: 8 };
    const disabling = h.runtime.apply();

    releaseStop();
    h.poller.stopGate = undefined;
    await Promise.all([changing, disabling]);
    await h.runtime.settled();

    // the stale transition must not have started anything: the loop stays off
    expect(h.poller.status().state).toBe("stopped");
    expect(h.poller.starts).toHaveLength(1);
    expect(h.poller.starts[0]?.allowedUserId).toBe(7);
    const status = await buildTelegramStatus(h.deps);
    expect(status.state).toBe("disabled");
  });

  it("bails out of a start when the settings changed under it, even without a newer request", async () => {
    const h = await running();

    let releaseStop!: () => void;
    h.poller.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    h.scope.value = { enabled: true, allowedUserId: 8 };
    const changing = h.runtime.apply();
    await vi.waitFor(() => expect(h.poller.stops).toBe(2));

    // The settings flip WITHOUT anyone requesting a transition: the transition's
    // own re-read after the await is the only thing that can catch this.
    h.scope.value = { enabled: false, allowedUserId: 8 };

    releaseStop();
    h.poller.stopGate = undefined;
    await changing;
    await h.runtime.settled();

    expect(h.poller.status().state).toBe("stopped");
    expect(h.poller.starts).toHaveLength(1);
  });

  it("serializes transitions so a start never overtakes the stop that preceded it", async () => {
    const h = await running();

    let releaseStop!: () => void;
    h.poller.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    h.scope.value = { enabled: true, allowedUserId: 8 };
    const first = h.runtime.apply();
    await vi.waitFor(() => expect(h.poller.stops).toBe(2));

    h.scope.value = { enabled: true, allowedUserId: 9 };
    const second = h.runtime.apply();
    expect(h.poller.starts).toHaveLength(1);

    releaseStop();
    h.poller.stopGate = undefined;
    await Promise.all([first, second]);
    await h.runtime.settled();

    // exactly one restart, for the newest allowlist, and it happened after the stop
    expect(h.poller.starts).toHaveLength(2);
    expect(h.poller.starts[1]?.allowedUserId).toBe(9);
    expect(h.poller.status().state).toBe("running");
  });

  it("settled() also waits for a transition that re-queued itself", async () => {
    const h = await running();

    let releaseStop!: () => void;
    h.poller.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    h.scope.value = { enabled: true, allowedUserId: 8 };
    const changing = h.runtime.apply();
    await vi.waitFor(() => expect(h.poller.stops).toBe(2));

    // The intent changes again with no newer request: this transition cannot act
    // on what it was asked for, so it re-queues itself instead.
    h.scope.value = { enabled: true, allowedUserId: 9 };
    releaseStop();
    h.poller.stopGate = undefined;
    await changing;
    await h.runtime.settled();

    // the re-queued transition is part of the tail, so `settled()` covers it
    expect(h.poller.starts).toHaveLength(2);
    expect(h.poller.starts[1]?.allowedUserId).toBe(9);
    expect(h.poller.status().state).toBe("running");
    expect(h.runtime.lastError()).toBeUndefined();
  });

  it("records a failed transition instead of rejecting, and reports it in the status", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    h.credentials.resolveError = new Error("credentials unavailable");

    // a route kick must not reject, however the transition fails
    const saved = await h.call("/api/telegram/save", { allowedUserId: 8 });
    expect(saved.status).toBe(200);
    await h.runtime.settled();

    expect(h.runtime.lastError()).toEqual({ code: "runtime-error", message: "credentials unavailable" });
    expect(h.poller.starts).toEqual([]);
    const broken = await h.call("/api/telegram/status");
    expect(broken.json).toEqual({
      status: {
        state: "error",
        tokenConfigured: true,
        enabled: true,
        allowedUserId: 8,
        error: { code: "runtime-error", message: "credentials unavailable" }
      }
    });

    // a later transition that succeeds clears the recorded failure
    h.credentials.resolveError = undefined;
    await h.runtime.apply();
    expect(h.runtime.lastError()).toBeUndefined();
    expect(h.poller.status().state).toBe("running");
  });
});

describe("bindRuntimeToSettings", () => {
  it("reconciles the runtime on every settings commit and contains failures", async () => {
    const scope = new FakeScope();
    const calls: number[] = [];
    const warns: string[] = [];
    let fail = false;
    bindRuntimeToSettings(scope, async () => {
      calls.push(calls.length);
      if (fail) throw new Error("reconcile failed");
    }, { warn: (m: string) => warns.push(m) });

    expect(scope.watchers).toHaveLength(1);
    await scope.commit({ enabled: true, allowedUserId: 7 }, { enabled: false, allowedUserId: null });
    expect(calls).toHaveLength(1);

    fail = true;
    await expect(scope.commit({ enabled: false, allowedUserId: 7 }, { enabled: true, allowedUserId: 7 })).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warns).toHaveLength(1));
    expect(warns[0]).toContain("reconcile failed");
  });

  it("returns the reconcile promise so the settings side can serialize commits", async () => {
    const scope = new FakeScope();
    let resolveReconcile!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      resolveReconcile = resolve;
    });
    const order: string[] = [];
    bindRuntimeToSettings(scope, async () => {
      order.push("start");
      await inFlight;
      order.push("done");
    });

    const commit = scope.commit({ enabled: true, allowedUserId: 7 }, { enabled: false, allowedUserId: null });
    // the watcher body is synchronous up to its first await and hands its promise
    // back, which is what lets the settings service await one invocation before
    // starting the next
    await vi.waitFor(() => expect(order).toEqual(["start"]));
    expect(scope.watchers).toHaveLength(1);

    resolveReconcile();
    await commit;
    expect(order).toEqual(["start", "done"]);
  });
});

describe("pollerTimingOptions", () => {
  it("keeps positive injected timings and falls back to safe defaults otherwise", () => {
    expect(pollerTimingOptions()).toEqual({ idleMs: 300, maxBackoffMs: 30_000 });
    expect(pollerTimingOptions({ idleMs: 25, maxBackoffMs: 50 })).toEqual({ idleMs: 25, maxBackoffMs: 50 });
    // 0 would spin the loop and 0 backoff would retry with no pause (task-9 ruling)
    expect(pollerTimingOptions({ idleMs: 0, maxBackoffMs: 0 })).toEqual({ idleMs: 300, maxBackoffMs: 30_000 });
    expect(pollerTimingOptions({ idleMs: -5 })).toEqual({ idleMs: 300, maxBackoffMs: 30_000 });
    expect(pollerTimingOptions({ idleMs: Number.NaN, maxBackoffMs: Number.POSITIVE_INFINITY })).toEqual({
      idleMs: 300,
      maxBackoffMs: 30_000
    });
  });
});

describe("workspaceRefFromKey", () => {
  it("maps the home key and existing projects, and rejects everything else", () => {
    expect(workspaceRefFromKey("home", [])).toEqual({ scope: "home" });
    expect(workspaceRefFromKey("project:alpha", ["alpha", "beta"])).toEqual({ scope: "project", name: "alpha" });
    expect(workspaceRefFromKey("project:gone", ["alpha"])).toBeUndefined();
    expect(workspaceRefFromKey("project:", ["alpha"])).toBeUndefined();
    expect(workspaceRefFromKey("", [])).toBeUndefined();
    expect(workspaceRefFromKey("project:alpha:beta", ["alpha"])).toBeUndefined();
    expect(workspaceRefFromKey("nonsense", [])).toBeUndefined();
  });
});

describe("restoreTelegramBoot", () => {
  const projects = (names: string[]) => ({ list: async () => ({ home: { path: "/home" }, projects: names.map((name) => ({ name, path: `/home/${name}` })) }) });

  it("restores a workspace that still exists and leaves the document untouched", async () => {
    const data: TelegramStateData = { version: 1, sessions: { home: "sess-1" }, activeWorkspace: "project:alpha", offset: 9 };
    const active: Array<unknown> = [];
    const outcome = await restoreTelegramBoot({
      load: async () => data,
      workspaces: projects(["alpha"]),
      setActive: (ref) => active.push(ref)
    });

    expect(active).toEqual([{ scope: "project", name: "alpha" }]);
    expect(outcome.clearedActive).toBe(false);
    expect(outcome.data).toEqual(data);
  });

  it("restores the home workspace", async () => {
    const active: Array<unknown> = [];
    const outcome = await restoreTelegramBoot({
      load: async () => ({ version: 1, sessions: {}, activeWorkspace: "home" }),
      workspaces: projects([]),
      setActive: (ref) => active.push(ref)
    });

    expect(active).toEqual([{ scope: "home" }]);
    expect(outcome.clearedActive).toBe(false);
  });

  it("clears a workspace that was deleted while the server was down", async () => {
    const active: Array<unknown> = [];
    const outcome = await restoreTelegramBoot({
      load: async () => ({ version: 1, sessions: { "project:gone": "sess-9" }, activeWorkspace: "project:gone", offset: 9 }),
      workspaces: projects([]),
      setActive: (ref) => active.push(ref)
    });

    expect(active).toEqual([undefined]);
    expect(outcome.clearedActive).toBe(true);
    // the key is REMOVED, never stored as an empty string, and the rest survives
    expect(outcome.data).toEqual({ version: 1, sessions: { "project:gone": "sess-9" }, offset: 9 });
    expect("activeWorkspace" in outcome.data).toBe(false);
  });

  it("clears an unparseable active workspace key", async () => {
    const outcome = await restoreTelegramBoot({
      load: async () => ({ version: 1, sessions: {}, activeWorkspace: "nonsense" }),
      workspaces: projects([]),
      setActive: () => {}
    });
    expect(outcome.clearedActive).toBe(true);
    expect("activeWorkspace" in outcome.data).toBe(false);
  });

  it("does nothing when no workspace was remembered", async () => {
    const active: Array<unknown> = [];
    const outcome = await restoreTelegramBoot({
      load: async () => ({ version: 1, sessions: { home: "sess-1" }, offset: 12 }),
      workspaces: projects([]),
      setActive: (ref) => active.push(ref)
    });

    expect(active).toEqual([]);
    expect(outcome.clearedActive).toBe(false);
    expect(outcome.data).toEqual({ version: 1, sessions: { home: "sess-1" }, offset: 12 });
  });

  it("starts empty (with a warning) when the state document is damaged", async () => {
    const warns: string[] = [];
    const outcome = await restoreTelegramBoot({
      load: async () => {
        throw new Error("telegram state file /x/telegram-state.json is not valid JSON");
      },
      workspaces: projects([]),
      setActive: () => {},
      logger: { warn: (m: string) => warns.push(m) }
    });

    expect(outcome.data).toEqual({ version: 1, sessions: {} });
    expect(outcome.clearedActive).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("not valid JSON");
  });

  it("keeps the remembered workspace when the workspace list cannot be read", async () => {
    const warns: string[] = [];
    const active: Array<unknown> = [];
    const outcome = await restoreTelegramBoot({
      load: async () => ({ version: 1, sessions: {}, activeWorkspace: "project:alpha" }),
      workspaces: { list: async () => { throw new Error("workspaces unavailable"); } },
      setActive: (ref) => active.push(ref),
      logger: { warn: (m: string) => warns.push(m) }
    });

    // a transient listing failure must not destroy the persisted selection
    expect(outcome.clearedActive).toBe(false);
    expect(outcome.data.activeWorkspace).toBe("project:alpha");
    expect(active).toEqual([undefined]);
    expect(warns).toHaveLength(1);
  });

  it("keeps the remembered workspace when no workspace service is available at all", async () => {
    const warns: string[] = [];
    const outcome = await restoreTelegramBoot({
      load: async () => ({ version: 1, sessions: {}, activeWorkspace: "project:alpha" }),
      setActive: () => {},
      logger: { warn: (m: string) => warns.push(m) }
    });

    // a missing seam is "cannot verify", never "the workspace is gone"
    expect(outcome.clearedActive).toBe(false);
    expect(outcome.data.activeWorkspace).toBe("project:alpha");
    expect(warns).toHaveLength(1);
  });
});

describe("buildTelegramStatus", () => {
  it("maps the settings and the poller into the contract shape", async () => {
    const h = harness({ scope: new FakeScope({ enabled: true, allowedUserId: 7 }), tokenConfigured: true });
    h.poller.detail = { state: "running", lastPollAt: "2026-09-10T12:00:00.000Z" };
    const status = await buildTelegramStatus(h.deps);
    expect(status).toEqual({
      state: "connected",
      tokenConfigured: true,
      enabled: true,
      allowedUserId: 7,
      lastPollAt: "2026-09-10T12:00:00.000Z"
    });
  });

  it("treats an absent allowedUserId as no allowlist", async () => {
    const scope = new FakeScope();
    scope.value = { enabled: false };
    const h = harness({ scope, tokenConfigured: true });
    const status = await buildTelegramStatus(h.deps);
    expect("allowedUserId" in status).toBe(false);
    expect(status.state).toBe("disabled");
  });
});
