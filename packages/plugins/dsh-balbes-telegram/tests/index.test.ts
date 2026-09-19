import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apply, name, inject, Config, telegramSettingsSchema, TELEGRAM_BOT_TOKEN_REF } from "../src/index.js";
import type { ResLike } from "../src/admin.js";
import type { WorkspaceRef } from "../src/agentTask.js";
import type { ChatDeps, ChatMachine, SessionsSlice } from "../src/chat.js";
import type { TelegramStateData } from "../src/state.js";

/** One title snapshot as `sessionQuery.readTitleSnapshots` reports it. */
interface TitleObservationLike {
  sessionId: string;
  status: "fulfilled" | "rejected";
  value?: { session: { createdAt: number }; title?: { title: string } };
}

/**
 * Capture the `ChatDeps` `apply` hands to the real chat machine.
 *
 * The plugin's session catalog (`channelSessions`) is a local const inside
 * `apply` with no exported accessor, so the only way to reach it from a test
 * without building a second composition is to wrap the real factory and record
 * its argument. The wrapper DELEGATES to the real `createChatMachine`, so every
 * other test in this file sees unchanged behavior.
 */
const captured = vi.hoisted(() => ({ chatDeps: [] as ChatDeps[] }));

vi.mock("../src/chat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat.js")>();
  return {
    ...actual,
    createChatMachine: (deps: ChatDeps): ChatMachine => {
      captured.chatDeps.push(deps);
      return actual.createChatMachine(deps);
    }
  };
});

interface Seat {
  path: string;
  auth: string;
  handler(req: unknown, res: unknown, body: unknown): Promise<void> | void;
}

const TOKEN = "123456789:AAHsecretTOKENvalue";

/** Mirrors the settings namespace scope: get/update/watch over one section. */
class FakeScope {
  updates: object[] = [];
  watchers: Array<() => void> = [];

  constructor(public value: { enabled: boolean; allowedUserId?: number | null } = { enabled: false, allowedUserId: null }) {}

  get(): { enabled: boolean; allowedUserId?: number | null } {
    return { ...this.value };
  }

  async update(patch: object): Promise<void> {
    this.updates.push(patch);
    const prev = this.value;
    this.value = { ...this.value, ...(patch as { enabled?: boolean; allowedUserId?: number | null }) };
    await this.commit(this.value, prev);
  }

  watch(callback: () => void): () => void {
    this.watchers.push(callback);
    return () => {
      this.watchers = this.watchers.filter((w) => w !== callback);
    };
  }

  /** Simulate a settings commit made outside the routes (the SPA's settings UI). */
  async commit(next: typeof this.value, prev: typeof this.value): Promise<void> {
    this.value = next;
    for (const watcher of this.watchers) await watcher();
    void prev;
  }
}

/** Fake of the settings seam: records every register call and hands out the scope. */
class FakeSettings {
  readonly calls: Array<{ namespace: string; schema: unknown }> = [];
  scope = new FakeScope();

  register(namespace: string, schema: unknown): FakeScope {
    this.calls.push({ namespace, schema });
    return this.scope;
  }
}

class FakeCredentials {
  refs = new Map<string, string>();
  unsetCalls: string[] = [];
  async describe(ref: string) { return { configured: this.refs.has(ref), writable: true }; }
  async resolve(ref: string) {
    const value = this.refs.get(ref);
    return value === undefined ? undefined : { value, source: "test" };
  }
  async set(ref: string, value: string) { this.refs.set(ref, value); }
  async unset(ref: string) { this.unsetCalls.push(ref); this.refs.delete(ref); }
}

class FakeWorkspaces {
  projects: Array<{ name: string; path: string }> = [];

  async list() {
    return { home: { path: "/data/home" }, projects: this.projects };
  }

  async root(scope: string, projectName: string | undefined) {
    return projectName === undefined ? "/data/home" : `/data/projects/${projectName}`;
  }

  async readDir() {
    return [];
  }

  async readFile() {
    return { kind: "text", content: "", truncated: false };
  }
}

let home: string;
let stateFile: string;
let seats: Seat[];
let http: { post(path: string, auth: string, handler: Seat["handler"]): void };
let settings: FakeSettings;
let credentials: FakeCredentials;
let workspaces: FakeWorkspaces;
/** Every `balbesSessions.register` call the plugin made during one test. */
let registered: Array<{ ref: unknown; sessionId: string; channel: string }>;
/** Entries `balbesSessions.list` answers with (the fake registry's content). */
let registryEntries: Array<{ sessionId: string; channel: string }>;
/** The optional engine seam; undefined exercises the degraded catalog path. */
let sessionQuery: { readTitleSnapshots(ids: readonly string[]): Promise<TitleObservationLike[]> } | undefined;
/** Ids the catalog asked titles for, in call order. */
let observedIds: string[];
let warns: string[];
let disposers: Array<() => unknown>;
let servers: Server[];

interface MakeCtxOptions {
  withEffect?: boolean;
  omitHttp?: boolean;
  /** Omit the sessions registry service to exercise the un-wired catalog path. */
  omitSessions?: boolean;
}

function makeCtx(o: MakeCtxOptions = {}): {
  get(key: string): unknown;
  logger: { warn(message: string): void };
  effect?(execute: () => () => void, label?: string): unknown;
} {
  return {
    get(key: string): unknown {
      return key === "balbesHttp" ? (o.omitHttp === true ? undefined : http)
        : key === "settings" ? settings
        : key === "credentials" ? credentials
        : key === "balbesWorkspaces" ? workspaces
        : key === "balbesSessions" ? (o.omitSessions === true ? undefined : {
            register: async (ref: unknown, sessionId: string, channel: string) => {
              registered.push({ ref, sessionId, channel });
            },
            list: async () => registryEntries
          })
        : key === "sessionQuery" ? sessionQuery
        : key === "agents" ? { create: async () => {}, resume: async () => {} }
        : key === "sessions" ? { flush: async () => {} }
        : key === "agentDefaultModel" ? { currentSelection: () => ({ provider: "test-provider", model: "test-model" }) }
        : undefined;
    },
    logger: { warn(message: string) { warns.push(message); } },
    ...(o.withEffect === true
      ? {
          effect(execute: () => () => void): unknown {
            disposers.push(execute());
            return () => {};
          }
        }
      : {})
  };
}

/** Invoke one registered route and decode its R-API-1 response. */
async function call(path: string, body: unknown = {}): Promise<{ status: number; raw: string; json: unknown }> {
  const seat = seats.find((s) => s.path === path);
  if (seat === undefined) throw new Error(`no seat for ${path}`);
  const box = { status: 0, raw: "" };
  const res: ResLike = {
    writeHead(status: number) {
      box.status = status;
    },
    end(payload?: string) {
      box.raw = String(payload ?? "");
    }
  };
  await seat.handler({}, res, body);
  return { status: box.status, raw: box.raw, json: JSON.parse(box.raw) as unknown };
}

interface StubCall {
  method: string;
  body: Record<string, unknown>;
}

interface StubBotOptions {
  /** Methods answered with a Telegram error envelope instead of success. */
  failMethods?: string[];
}

interface StubBot {
  url: string;
  /** Every method name the plugin called, in call order. */
  methods: string[];
  calls: StubCall[];
  lastCall(method: string): StubCall | undefined;
  /** True once the stub has answered one more getUpdates: the loop is alive. */
  polling(timeoutMs?: number): Promise<boolean>;
}

/**
 * Answer the Bot API over loopback and record every call.
 *
 * The queued update batch belongs to `getUpdates` ALONE: a registration call
 * (`setMyCommands` / `setChatMenuButton`) that was handed the batch would
 * corrupt this file's delivery assertions instead of reporting the mistake.
 * Every other method therefore answers the plain `true` Telegram sends.
 */
async function startStubBot(updateId: number | undefined, options: StubBotOptions = {}): Promise<StubBot> {
  const methods: string[] = [];
  const calls: StubCall[] = [];
  const failMethods = options.failMethods ?? [];
  let delivered = false;
  const server = createServer((req, res) => {
    const method = (req.url ?? "").split("/").pop() ?? "";
    methods.push(method);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
      } catch {
        body = {};
      }
      calls.push({ method, body });

      if (failMethods.includes(method)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error_code: 400, description: `stub rejected ${method}` }));
        return;
      }

      let result: unknown = true;
      if (method === "getMe") result = { username: "stub_bot", id: 1 };
      else if (method === "getUpdates") {
        result = [];
        if (updateId !== undefined && !delivered) {
          delivered = true;
          result = [
            {
              update_id: updateId,
              message: { message_id: 1, chat: { id: 5, type: "private" }, from: { id: 999, is_bot: false }, text: "hello" }
            }
          ];
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    methods,
    calls,
    lastCall(method: string): StubCall | undefined {
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i]!.method === method) return calls[i];
      return undefined;
    },
    async polling(timeoutMs = 2000): Promise<boolean> {
      const polls = (): number => methods.filter((name) => name === "getUpdates").length;
      const seen = polls();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (polls() > seen) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    }
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "telegram-plugin-"));
  stateFile = join(home, "telegram-state.json");
  seats = [];
  http = {
    post(path: string, auth: string, handler: Seat["handler"]) {
      seats.push({ path, auth, handler });
    }
  };
  settings = new FakeSettings();
  credentials = new FakeCredentials();
  workspaces = new FakeWorkspaces();
  registered = [];
  registryEntries = [];
  sessionQuery = undefined;
  observedIds = [];
  captured.chatDeps.length = 0;
  warns = [];
  disposers = [];
  servers = [];
});

afterEach(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

/** Read and parse the persisted channel document. */
async function readState(): Promise<TelegramStateData> {
  return JSON.parse(await readFile(stateFile, "utf8")) as TelegramStateData;
}

/** `home` | `project:<имя>` -> ref; mirrors the plugin's own key mapping. */
function refFromStateKeyForTest(key: string): WorkspaceRef | undefined {
  if (key === "home") return { scope: "home" };
  if (key.startsWith("project:")) {
    const projectName = key.slice("project:".length);
    return projectName === "" ? undefined : { scope: "project", name: projectName };
  }
  return undefined;
}

interface BootTelegramOptions {
  /** Seed telegram-state.json before apply. */
  state?: TelegramStateData;
  /** Entries the fake registry lists. */
  registry?: Array<{ sessionId: string; channel: string }>;
  /** When given, compose the optional sessionQuery seam with this answer. */
  observations?: TitleObservationLike[];
}

interface TelegramHarness {
  channelSessions: SessionsSlice;
  deps: ChatDeps;
}

/**
 * Compose the plugin through its real entry point (`apply`) and hand back the
 * session slice `apply` wired into the chat machine. Reuses the existing
 * `makeCtx`/`apply` harness; no second composition is built.
 */
async function bootTelegram(options: BootTelegramOptions = {}): Promise<TelegramHarness> {
  if (options.state !== undefined) {
    await writeFile(stateFile, JSON.stringify(options.state), "utf8");
  }
  registryEntries = options.registry ?? [];
  if (options.observations !== undefined) {
    observedIds = [];
    sessionQuery = {
      readTitleSnapshots: async (ids) => {
        observedIds.push(...ids);
        return options.observations ?? [];
      }
    };
  } else {
    sessionQuery = undefined;
  }

  apply(makeCtx(), { dshHome: home });

  const deps = captured.chatDeps.at(-1);
  if (deps === undefined || deps.sessions === undefined) {
    throw new Error("channelSessions was not wired into the chat machine");
  }

  // The boot restore loads the document into `live` in a continuation; its
  // registry sync is the observable signal that `live` now holds the seed.
  const expected = Object.entries(options.state?.sessions ?? {})
    .map(([key, sessionId]) => ({ ref: refFromStateKeyForTest(key), sessionId }))
    .filter((entry): entry is { ref: WorkspaceRef; sessionId: string } => entry.ref !== undefined);
  if (expected.length > 0) {
    await vi.waitFor(() => {
      for (const entry of expected) {
        expect(registered).toContainEqual({ ...entry, channel: "telegram" });
      }
    }, { timeout: 5000 });
  }

  return { channelSessions: deps.sessions, deps };
}

describe("balbes-telegram plugin", () => {
  it("exposes the name/inject/Config/apply contract", () => {
    expect(name).toBe("balbes-telegram");
    expect(inject).toEqual(
      expect.arrayContaining([
        "balbesHttp",
        "settings",
        "credentials",
        "balbesWorkspaces",
        "agents",
        "sessions",
        "agentDefaultModel",
        // the models plugin's service: without it /model answers MODELS_UNAVAILABLE
        "balbesModels"
      ])
    );
    expect(typeof Config).toBe("function");
    expect(typeof apply).toBe("function");
  });

  it("declares balbesSessions as a dependency", () => {
    expect(inject).toContain("balbesSessions");
  });

  it("pins the bot token credentials ref", () => {
    expect(TELEGRAM_BOT_TOKEN_REF).toBe("BALBES_TELEGRAM_BOT_TOKEN");
  });

  it("registers the balbes-telegram settings namespace at apply time", () => {
    apply(makeCtx(), { dshHome: home });
    expect(warns).toEqual([]);
    expect(settings.calls).toHaveLength(1);
    expect(settings.calls[0]!.namespace).toBe("balbes-telegram");
    expect(settings.calls[0]!.schema).toBe(telegramSettingsSchema);
  });

  it("registers the exact settings schema semantics (enabled default, positive-int or null allowlist)", () => {
    apply(makeCtx(), { dshHome: home });
    const schema = settings.calls[0]!.schema as (data?: unknown) => unknown;
    // defaults: disabled, no allowlist
    expect(schema({})).toMatchObject({ enabled: false });
    // an explicit positive user id is kept
    expect(schema({ enabled: true, allowedUserId: 5 })).toMatchObject({ enabled: true, allowedUserId: 5 });
    // null means "no allowlist"
    expect(schema({ allowedUserId: null })).toMatchObject({ allowedUserId: null });
    // zero and non-integers are rejected (z.natural() enforces the integer)
    expect(() => schema({ allowedUserId: 0 })).toThrow();
    expect(() => schema({ allowedUserId: 1.5 })).toThrow();
  });

  it("warns without crashing when balbesHttp is absent", () => {
    expect(() => apply(makeCtx({ omitHttp: true }), { dshHome: home })).not.toThrow();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("balbesHttp");
    // the early return mirrors the models plugin: no namespace registration
    expect(settings.calls).toHaveLength(0);
    expect(seats).toHaveLength(0);
  });

  it("registers the five bearer POST routes", () => {
    apply(makeCtx(), { dshHome: home });
    expect(seats.map((s) => [s.path, s.auth])).toEqual([
      ["/api/telegram/status", "bearer"],
      ["/api/telegram/save", "bearer"],
      ["/api/telegram/test", "bearer"],
      ["/api/telegram/disable", "bearer"],
      ["/api/telegram/clear-token", "bearer"]
    ]);
  });

  it("reports not-configured on a fresh boot and disabled once a token is saved", async () => {
    apply(makeCtx(), { dshHome: home });

    const first = await call("/api/telegram/status");
    expect(first.json).toEqual({ status: { state: "not-configured", tokenConfigured: false, enabled: false } });

    const saved = await call("/api/telegram/save", { token: TOKEN });
    expect(saved.status).toBe(200);
    expect(credentials.refs.get(TELEGRAM_BOT_TOKEN_REF)).toBe(TOKEN);
    expect(saved.json).toEqual({ status: { state: "disabled", tokenConfigured: true, enabled: false } });
  });

  it("refuses to enable the bot through the assembled plugin without a token", async () => {
    apply(makeCtx(), { dshHome: home });
    const { status, json } = await call("/api/telegram/save", { enabled: true, allowedUserId: 7 });
    expect(status).toBe(400);
    expect(json).toEqual({ error: { code: "invalid-config", message: expect.any(String) } });
    expect(settings.scope.updates).toEqual([]);
  });

  it("answers not-configured for the connection test and never asks Telegram anything", async () => {
    apply(makeCtx(), { dshHome: home });
    const { status, json } = await call("/api/telegram/test");
    expect(status).toBe(400);
    expect(json).toEqual({ error: { code: "not-configured", message: expect.any(String) } });
  });

  it("clears the token through the assembled plugin", async () => {
    apply(makeCtx(), { dshHome: home });
    await call("/api/telegram/save", { token: TOKEN });

    const { status, json } = await call("/api/telegram/clear-token");
    expect(status).toBe(200);
    expect(credentials.unsetCalls).toEqual([TELEGRAM_BOT_TOKEN_REF]);
    expect(settings.scope.updates).toEqual([{ enabled: false }]);
    expect(json).toEqual({ status: { state: "not-configured", tokenConfigured: false, enabled: false } });
  });

  it("never returns the token through the assembled plugin", async () => {
    // Every route that could touch the bot is pointed at the loopback stub: this
    // test must never depend on reaching api.telegram.org.
    const stub = await startStubBot(undefined);
    apply(makeCtx(), { dshHome: home, apiBase: stub.url });
    await call("/api/telegram/save", { token: TOKEN, allowedUserId: 7 });
    const responses = [
      await call("/api/telegram/status"),
      await call("/api/telegram/test"),
      await call("/api/telegram/save", { token: TOKEN }),
      await call("/api/telegram/disable"),
      await call("/api/telegram/clear-token")
    ];
    for (const response of responses) {
      expect(response.raw).not.toContain(TOKEN);
      expect(response.raw).not.toMatch(/"token"\s*:/);
      expect(response.raw).not.toContain("botToken");
    }
  });

  it("reaches no outbound endpoint on the admin paths that do not poll", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected outbound fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      apply(makeCtx(), { dshHome: home });
      await call("/api/telegram/status");
      await call("/api/telegram/save", { token: TOKEN, allowedUserId: 7 });
      await call("/api/telegram/status");
      await call("/api/telegram/disable");
      await call("/api/telegram/clear-token");
      // a connection test without a credential must answer before any client exists
      await call("/api/telegram/test");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("subscribes the polling runtime to settings commits and disposes it through ctx.effect", async () => {
    apply(makeCtx({ withEffect: true }), { dshHome: home });
    expect(settings.scope.watchers).toHaveLength(1);
    expect(disposers).toHaveLength(1);

    // the disposer stops polling and leaves nothing pending (no throw, resolves)
    expect(() => disposers[0]!()).not.toThrow();
  });

  it("clears a remembered workspace that was deleted while the server was down", async () => {
    await writeFile(
      stateFile,
      `${JSON.stringify({ version: 1, sessions: { "project:gone": "sess-1" }, activeWorkspace: "project:gone", offset: 4 })}\n`
    );

    apply(makeCtx(), { dshHome: home });

    await vi.waitFor(async () => {
      const repaired = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
      expect("activeWorkspace" in repaired).toBe(false);
      // the key is removed, never blanked, and the rest of the document survives
      expect(repaired).toEqual({ version: 1, sessions: { "project:gone": "sess-1" }, offset: 4 });
    });
  });

  it("keeps a remembered workspace that still exists", async () => {
    workspaces.projects = [{ name: "alpha", path: "/data/projects/alpha" }];
    const original = `${JSON.stringify({ version: 1, sessions: {}, activeWorkspace: "project:alpha" })}\n`;
    await writeFile(stateFile, original);

    apply(makeCtx(), { dshHome: home });
    await sleep(50);

    expect(await readFile(stateFile, "utf8")).toBe(original);
  });

  it("syncs the persisted session map into the workspace registry on apply", async () => {
    // Состояние до старта: так выглядит уже работавший сервер после обновления.
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        sessions: { home: "session-home", "project:alpha": "session-alpha" },
        activeWorkspace: "project:alpha"
      }),
      "utf8"
    );

    apply(makeCtx(), { dshHome: home });

    // Синк идёт в продолжении загрузки состояния — ждём эффект, а не тайминг.
    await vi.waitFor(() => expect(registered).toHaveLength(2), { timeout: 5000 });
    expect([...registered].sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { ref: { scope: "project", name: "alpha" }, sessionId: "session-alpha", channel: "telegram" },
      { ref: { scope: "home" }, sessionId: "session-home", channel: "telegram" }
    ]);
  });

  it("ignores an unmappable state key and warns instead of inventing a workspace", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ version: 1, sessions: { "weird:key": "session-weird" } }),
      "utf8"
    );

    apply(makeCtx(), { dshHome: home });

    await vi.waitFor(() => expect(warns.some((w) => w.includes("weird:key"))).toBe(true), { timeout: 5000 });
    expect(registered).toEqual([]);
  });
});

describe("balbes-telegram polling runtime (loopback Bot API)", () => {
  it("starts polling on a settings commit, persists the acknowledged offset and stops on dispose", async () => {
    const stub = await startStubBot(7);
    credentials.refs.set(TELEGRAM_BOT_TOKEN_REF, TOKEN);
    apply(makeCtx({ withEffect: true }), { dshHome: home, apiBase: stub.url });

    expect(stub.methods).toEqual([]);

    // the SPA (or the settings UI) commits the change; nothing else is called
    await settings.scope.commit({ enabled: true, allowedUserId: 7 }, { enabled: false, allowedUserId: null });

    await vi.waitFor(() => expect(stub.methods).toContain("getUpdates"), { timeout: 5000 });
    await vi.waitFor(() => expect(stub.methods).toContain("getMe"), { timeout: 5000 });

    // update_id 7 was acknowledged although it was not delivered: 999 is not the
    // allowlisted user, and the ack offset (8) is what reaches the state file
    await vi.waitFor(
      async () => {
        const persisted = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
        expect(persisted).toMatchObject({ version: 1, offset: 8 });
      },
      { timeout: 5000 }
    );

    const polls = stub.methods.filter((method) => method === "getUpdates").length;
    disposers[0]!();
    await sleep(900);
    expect(stub.methods.filter((method) => method === "getUpdates")).toHaveLength(polls);
  });

  it("stops polling when the owner switches the bot off", async () => {
    const stub = await startStubBot(undefined);
    credentials.refs.set(TELEGRAM_BOT_TOKEN_REF, TOKEN);
    apply(makeCtx(), { dshHome: home, apiBase: stub.url });

    await settings.scope.commit({ enabled: true, allowedUserId: 7 }, { enabled: false, allowedUserId: null });
    await vi.waitFor(() => expect(stub.methods).toContain("getUpdates"), { timeout: 5000 });

    const polls = stub.methods.filter((method) => method === "getUpdates").length;
    const disabled = await call("/api/telegram/disable");
    expect(disabled.json).toMatchObject({
      status: {
        state: "disabled",
        tokenConfigured: true,
        enabled: false,
        allowedUserId: 7,
        botUsername: "stub_bot",
        lastPollAt: expect.any(String)
      }
    });

    await sleep(900);
    expect(stub.methods.filter((method) => method === "getUpdates")).toHaveLength(polls);
  });

  it("pushes the command list on every successful runtime transition", async () => {
    const stub = await startStubBot(undefined);
    // Enabled from boot onward: the boot transition starts the loop, and the
    // registration must ride that same transition rather than wait for a commit.
    settings.scope = new FakeScope({ enabled: true, allowedUserId: 7 });
    credentials.refs.set(TELEGRAM_BOT_TOKEN_REF, TOKEN);
    apply(makeCtx(), { dshHome: home, apiBase: stub.url });

    await vi.waitFor(() => expect(stub.methods).toContain("setMyCommands"), { timeout: 2000 });

    // The list the owner sees is the command table, in order and nothing else.
    const call = stub.lastCall("setMyCommands")!;
    const commands = call.body.commands as Array<{ command: string; description: string }>;
    expect(commands.map((entry) => entry.command)).toEqual([
      "menu",
      "status",
      "ws",
      "model",
      "sessions",
      "reset",
      "stop",
      "help"
    ]);
    expect(commands.every((entry) => entry.description.trim() !== "")).toBe(true);
    // …and the native «Меню» button is switched on with it.
    await vi.waitFor(() => expect(stub.methods).toContain("setChatMenuButton"), { timeout: 2000 });

    // A later successful transition (the allowlist moves) registers again.
    const registered = stub.calls.filter((entry) => entry.method === "setMyCommands").length;
    await settings.scope.commit({ enabled: true, allowedUserId: 9 }, { enabled: true, allowedUserId: 7 });
    await vi.waitFor(
      () => expect(stub.calls.filter((entry) => entry.method === "setMyCommands").length).toBeGreaterThan(registered),
      { timeout: 2000 }
    );
  });

  it("keeps polling alive when command registration fails", async () => {
    const stub = await startStubBot(undefined, { failMethods: ["setMyCommands"] });
    credentials.refs.set(TELEGRAM_BOT_TOKEN_REF, TOKEN);
    apply(makeCtx(), { dshHome: home, apiBase: stub.url });

    await settings.scope.commit({ enabled: true, allowedUserId: 7 }, { enabled: false, allowedUserId: null });

    expect(warns.some((line) => line.includes("command registration failed"))).toBe(true);
    // The failure trace names the failure and never the credential.
    expect(warns.join("\n")).not.toContain(TOKEN);
    // The rejected registration is best-effort: the loop keeps polling.
    await expect(stub.polling()).resolves.toBe(true);
  });
});

describe("balbes-telegram session catalog wiring", () => {
  it("selects a stored session and persists the active id", async () => {
    const harness = await bootTelegram({ state: { version: 1, sessions: { home: "session-a" } } });
    await harness.channelSessions.select({ scope: "home" }, "session-b");
    await vi.waitFor(async () => {
      expect(await readState()).toMatchObject({ sessions: { home: "session-b" } });
    });
  });

  it("archives the active session: clears the active id and records the archive", async () => {
    const harness = await bootTelegram({ state: { version: 1, sessions: { home: "session-a" } } });
    await harness.channelSessions.archive({ scope: "home" }, "session-a");
    await vi.waitFor(async () => {
      const state = await readState();
      expect(state).toMatchObject({ archived: { home: ["session-a"] } });
      expect(state.sessions.home).toBeUndefined();
    });
  });

  it("unarchives without touching the active id", async () => {
    const harness = await bootTelegram({
      state: { version: 1, sessions: { home: "session-a" }, archived: { home: ["session-old"] } }
    });
    await harness.channelSessions.unarchive({ scope: "home" }, "session-old");
    await vi.waitFor(async () => {
      const state = await readState();
      expect(state.sessions).toEqual({ home: "session-a" });
      expect(state.archived).toBeUndefined();
    });
  });

  it("lists only telegram sessions, newest first, marking the active and archived ones", async () => {
    const harness = await bootTelegram({
      state: { version: 1, sessions: { home: "s3" }, archived: { home: ["s1"] } },
      registry: [
        { sessionId: "s1", channel: "telegram" },
        { sessionId: "s2", channel: "admin" },
        { sessionId: "s3", channel: "telegram" }
      ],
      observations: [
        { sessionId: "s1", status: "fulfilled", value: { session: { createdAt: 1000 }, title: { title: "First" } } },
        { sessionId: "s3", status: "fulfilled", value: { session: { createdAt: 3000 } } }
      ]
    });

    const rows = await harness.channelSessions.list({ scope: "home" });
    expect(rows).toEqual([
      { id: "s3", title: null, createdAt: new Date(3000).toISOString(), available: true, archived: false, active: true },
      { id: "s1", title: "First", createdAt: new Date(1000).toISOString(), available: true, archived: true, active: false }
    ]);
    // The engine is asked only about the telegram entries, in registry order.
    expect(observedIds).toEqual(["s1", "s3"]);
  });

  it("marks a session unavailable when its title snapshot rejects", async () => {
    const harness = await bootTelegram({
      registry: [{ sessionId: "gone", channel: "telegram" }],
      observations: [{ sessionId: "gone", status: "rejected" }]
    });
    const rows = await harness.channelSessions.list({ scope: "home" });
    expect(rows).toEqual([
      { id: "gone", title: null, createdAt: null, available: false, archived: false, active: false }
    ]);
  });

  it("places unavailable (undated) sessions after every dated one", async () => {
    const harness = await bootTelegram({
      registry: [
        { sessionId: "s1", channel: "telegram" },
        { sessionId: "s2", channel: "telegram" },
        { sessionId: "s3", channel: "telegram" }
      ],
      observations: [
        { sessionId: "s1", status: "fulfilled", value: { session: { createdAt: 1000 }, title: { title: "First" } } },
        { sessionId: "s2", status: "rejected" },
        { sessionId: "s3", status: "fulfilled", value: { session: { createdAt: 3000 } } }
      ]
    });

    const rows = await harness.channelSessions.list({ scope: "home" });
    // A null createdAt in the middle must not break the dated ordering: s3 is
    // newest, s1 next, and the unavailable s2 goes last.
    expect(rows.map((row) => row.id)).toEqual(["s3", "s1", "s2"]);
    expect(rows[2]).toMatchObject({ id: "s2", available: false, createdAt: null });
  });

  it("degrades without sessionQuery: reversed registry order, all available, no titles", async () => {
    const harness = await bootTelegram({
      registry: [
        { sessionId: "older", channel: "telegram" },
        { sessionId: "newer", channel: "telegram" }
      ]
    });
    const rows = await harness.channelSessions.list({ scope: "home" });
    expect(rows).toEqual([
      { id: "newer", title: null, createdAt: null, available: true, archived: false, active: false },
      { id: "older", title: null, createdAt: null, available: true, archived: false, active: false }
    ]);
  });

  it("reports the selected session before its first turn", async () => {
    const harness = await bootTelegram({ state: { version: 1, sessions: { home: "session-a" } } });
    await harness.channelSessions.select({ scope: "home" }, "session-b");
    // Let the fire-and-forget save settle before the temp dir is torn down.
    await vi.waitFor(async () => {
      expect(await readState()).toMatchObject({ sessions: { home: "session-b" } });
    });
    // The raw runner holds no handle yet; the mapping must supply the answer.
    expect(harness.deps.runner.sessionIdOf({ scope: "home" })).toBe("session-b");
  });

  it("wires the session slice into the chat machine only when the registry is composed", () => {
    apply(makeCtx(), { dshHome: home });
    expect(captured.chatDeps.at(-1)?.sessions).toBeDefined();

    captured.chatDeps.length = 0;
    apply(makeCtx({ omitSessions: true }), { dshHome: home });
    expect(captured.chatDeps.at(-1)?.sessions).toBeUndefined();
  });
});

