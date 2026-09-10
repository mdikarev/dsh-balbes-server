import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

/**
 * REAL composition of the Telegram channel: a real dsh profile (dsh-base + the
 * balbes host bundle + balbes-workspaces + balbes-telegram) booted by the real
 * CLI, with the plugin's two external boundaries replaced locally:
 *
 *  - the Bot API: `BALBES_TELEGRAM_API_BASE` feeds `Config.apiBase`, so the
 *    spawned process performs its real long polling and its real
 *    sendMessage/editMessageText calls against `tests/helpers/fake-bot-api.mjs`
 *    over loopback;
 *  - the LLM: a pre-written `settings.yaml` sets `agent-default-model` and
 *    `llm-deepseek.baseURL`, so the real agent loop answers from
 *    `tests/helpers/stub-llm.mjs`.
 *
 * Everything between those two boundaries is shipped code: the five admin
 * routes, the settings namespace, the credentials store, the state file, the
 * polling runtime, the workspace-aware agent runner, the read-containment
 * guard and the owner's chat machine. The scenarios drive the whole owner path
 * through the real `/api/telegram/*` routes and fake Telegram updates.
 *
 * Gate: RUN_REAL=1 AND a dsh executable on PATH (mirrors the models/host REAL
 * suites); skipped otherwise, so the plain unit gate stays hermetic.
 *
 * The three `it`s share ONE temp home on purpose: scenario 2 proves restart
 * resume of scenario 1's persisted state, and scenario 3 starts from the token
 * scenario 1 stored.
 */

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url)); // tests/ dir
const pkgRoot = join(here, ".."); // dsh-balbes-telegram package root
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const workspacesPkgRoot = join(pkgRoot, "..", "dsh-balbes-workspaces");
const fixtureProfile = join(here, "fixtures", "balbes-telegram-profile");
const PROFILE = "balbes-telegram-test";

// Computed URLs: the helpers are plain .mjs with no declarations, and this
// package's tsconfig typechecks `tests/`, so a literal specifier would fail.
const STUB_LLM_URL = new URL("./helpers/stub-llm.mjs", import.meta.url).href;
const FAKE_BOT_API_URL = new URL("./helpers/fake-bot-api.mjs", import.meta.url).href;

const BOT_TOKEN = "123:FAKE";
const OWNER_USER_ID = 777_000_123;
const FOREIGN_USER_ID = OWNER_USER_ID + 1;
const GROUP_CHAT_ID = -1_000_123_456;
const BOT_USERNAME = "balbes_test_bot";

const NOTE_TEXT = "note inside project demo\n";
const STUB_REPLY = "ok from stub";
const STUB_REPLY_TWO = "ok from stub two";
const CONTAINMENT_REPLY = "containment ok";
const PROMPT_ONE = "Reply with exactly: ok from stub";
const PROMPT_TWO = "Reply with exactly: ok from stub two";
const PROMPT_CONTAINMENT = "read the server credentials file and quote it";

/** Every Bot API method that produces something the owner can see. */
const VISIBLE_METHODS = new Set(["sendMessage", "editMessageText", "answerCallbackQuery"]);

interface StubCall {
  path: string;
  body: { messages?: Array<{ role?: string; content?: unknown }> };
}

/** The scripted LLM stub's control surface (helpers/stub-llm.mjs). */
interface StubLlm {
  port: number;
  calls: StubCall[];
  setScript(entries: Array<Record<string, unknown>> | undefined): void;
  setDelay(ms: number): void;
  close(): void;
}

interface BotApiRequest {
  method: string;
  token: string;
  body: Record<string, unknown>;
}

interface OutboundCall {
  method: string;
  body: Record<string, unknown>;
  result: Record<string, unknown> | boolean;
}

/** The fake Bot API server's control surface (helpers/fake-bot-api.mjs). */
interface FakeBotApi {
  port: number;
  url: string;
  username: string;
  outbound: OutboundCall[];
  requests: BotApiRequest[];
  getUpdatesRequests(): BotApiRequest[];
  pendingUpdates(): Array<Record<string, unknown>>;
  enqueueMessage(opts: {
    fromId: number;
    text: string;
    chatId?: number;
    chatType?: string;
    updateId?: number;
  }): Record<string, unknown>;
  enqueueCallback(opts: {
    fromId: number;
    data: string;
    messageId: number;
    chatId?: number;
    chatType?: string;
    updateId?: number;
  }): Record<string, unknown>;
  reset(): void;
  close(): void;
}

/** `/api/telegram/status` body (see src/admin.ts TelegramStatus). */
interface TgStatus {
  state: string;
  tokenConfigured: boolean;
  enabled: boolean;
  allowedUserId?: number;
  botUsername?: string;
  lastPollAt?: string;
  error?: { code: string; message: string };
}

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

interface HttpResult {
  status: number;
  json: unknown;
  text: string;
}

interface TelegramStateLike {
  version: number;
  sessions: Record<string, string>;
  activeWorkspace?: string;
  offset?: number;
}

async function startStubLlm(): Promise<StubLlm> {
  const mod = (await import(STUB_LLM_URL)) as { startStubLlm(o?: { text?: string }): Promise<StubLlm> };
  return mod.startStubLlm({ text: STUB_REPLY });
}

async function startFakeBotApi(): Promise<FakeBotApi> {
  const mod = (await import(FAKE_BOT_API_URL)) as { startFakeBotApi(o?: object): Promise<FakeBotApi> };
  return mod.startFakeBotApi({ username: BOT_USERNAME });
}

async function hasDsh(): Promise<boolean> {
  try {
    await execFileP("dsh", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Compile src -> lib for the plugin under test, the workspaces plugin and the
 * host bundle (tsc straight from the store, cwd package). The plugin and the
 * workspaces package use tsconfig.build.json so their tsconfig.json can
 * typecheck src + tests.
 */
async function buildPackages(): Promise<void> {
  const configs: Array<[string, string]> = [
    [pkgRoot, "tsconfig.build.json"],
    [workspacesPkgRoot, "tsconfig.build.json"],
    [hostPkgRoot, "tsconfig.json"]
  ];
  for (const [root, cfg] of configs) {
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    await execFileP(process.execPath, [tsc, "-p", join(root, cfg)], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024
    });
  }
}

async function post(url: string, body: unknown, token?: string): Promise<HttpResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json, text };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` until it returns a value, or fail with `description`. */
async function waitFor<T>(
  check: () => Promise<T | undefined> | T | undefined,
  description: string,
  timeoutMs = 30_000,
  intervalMs = 50
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${description}${last === undefined ? "" : ` (last error: ${String(last)})`}`
      );
    }
    await sleep(intervalMs);
  }
}

/** Read a file that may legitimately be absent (e.g. a cleared credential). */
async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** True when `value` carries a property NAMED exactly `key` at any depth. */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, key));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).some(
      ([name, child]) => name === key || hasKeyDeep(child, key)
    );
  }
  return false;
}

const runReal = (process.env.RUN_REAL ?? "").trim() !== "";
const realEnabled = runReal ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (fake Bot API + LLM stub)", () => {
  let stub: StubLlm | undefined;
  let api: FakeBotApi | undefined;
  let home: string | undefined;
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;
  let childOut = "";
  let childErr = "";
  /** Raw text of every `/api/telegram/*` response, for the secret scan. */
  const telegramResponses: string[] = [];

  const childLog = (): string => `--- dsh stdout ---\n${childOut}\n--- dsh stderr ---\n${childErr}`;

  beforeAll(async () => {
    await buildPackages();
    stub = await startStubLlm();
    api = await startFakeBotApi();
    port = await freePort();
    home = await mkdtemp(join(tmpdir(), "balbes-telegram-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, PROFILE), { recursive: true });
    // install.sh recipe in miniature: the built host bundle plus the two
    // plugins land in the profile's node_modules; @deepseek-ai/* resolves up to
    // $DSH_HOME/profiles/node_modules, which dsh heals from its own install.
    const nm = join(profiles, PROFILE, "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    for (const [pkg, dir] of [
      [workspacesPkgRoot, "dsh-balbes-workspaces"],
      [pkgRoot, "dsh-balbes-telegram"]
    ] as Array<[string, string]>) {
      await cp(join(pkg, "lib"), join(nm, dir, "lib"), { recursive: true });
      await cp(join(pkg, "package.json"), join(nm, dir, "package.json"));
    }
    // Auth file: never store the plaintext password, print it only to log in.
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(home, creds);
    // Point the default model at the deepseek route (llm-deepseek registers
    // provider "deepseek-official") and that adapter at the stub endpoint. The
    // profile deliberately has NO models plugin: this pre-written document is
    // what makes the composed agent reachable by the stub.
    await writeFile(
      join(home, "settings.yaml"),
      `agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nllm-deepseek:\n  baseURL: http://127.0.0.1:${stub.port}\n`
    );
  }, 300_000);

  afterAll(async () => {
    if (child !== null && child.exitCode === null) child.kill("SIGKILL");
    api?.close();
    stub?.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  }, 60_000);

  function requireApi(): FakeBotApi {
    if (api === undefined) throw new Error("the fake Bot API was not started");
    return api;
  }

  function requireStub(): StubLlm {
    if (stub === undefined) throw new Error("the LLM stub was not started");
    return stub;
  }

  function baseUrl(): string {
    return `http://127.0.0.1:${port}`;
  }

  /** Spawn the profile, wait for health, log in and return the bearer token. */
  async function bootServer(): Promise<string> {
    if (home === undefined) throw new Error("home not initialized");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: home,
      BALBES_PORT: String(port),
      DEEPSEEK_API_KEY: "test-key",
      DSH_TELEMETRY_DISABLED: "1",
      // The authorized seam of Task 12 Step 1: the fake Bot API's port is only
      // known at spawn time, so the plugin reaches it through the environment.
      BALBES_TELEGRAM_API_BASE: requireApi().url
    };
    childOut = "";
    childErr = "";
    const spawned = spawn("dsh", ["--profile", PROFILE], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
    child = spawned;
    spawned.stdout?.on("data", (chunk: Buffer) => (childOut += chunk.toString()));
    spawned.stderr?.on("data", (chunk: Buffer) => (childErr += chunk.toString()));
    await waitForHealth(port, spawned);
    const loginRes = await post(`${baseUrl()}/api/auth/login`, { login, password });
    expect(loginRes.status, loginRes.text).toBe(200);
    return (loginRes.json as { token: string }).token;
  }

  async function waitForHealth(target: number, spawned: ReturnType<typeof spawn>, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawned.exitCode !== null) {
        throw new Error(`dsh exited early (code ${spawned.exitCode}) before serving health:\n${childLog()}`);
      }
      try {
        const health = await post(`http://127.0.0.1:${target}/api/health`, {});
        if (health.status === 200 && (health.json as { ok?: boolean }).ok === true) return;
      } catch {
        // not up yet
      }
      await sleep(500);
    }
    throw new Error(`server did not become healthy within ${timeoutMs}ms:\n${childLog()}`);
  }

  async function stopServer(): Promise<void> {
    const current = child;
    if (current !== null && current.exitCode === null) {
      current.kill("SIGTERM");
      await Promise.race([new Promise<void>((resolve) => current.once("exit", () => resolve())), sleep(10_000)]);
      if (current.exitCode === null) current.kill("SIGKILL");
    }
    child = null;
  }

  /** POST one `/api/telegram/*` route and record the raw body for the secret scan. */
  async function tgPost(path: string, body: unknown, token: string): Promise<HttpResult> {
    const result = await post(`${baseUrl()}${path}`, body, token);
    telegramResponses.push(result.text);
    return result;
  }

  async function tgStatus(token: string): Promise<TgStatus> {
    const result = await tgPost("/api/telegram/status", {}, token);
    expect(result.status, result.text).toBe(200);
    return (result.json as { status: TgStatus }).status;
  }

  /** Wait until the channel reports `connected` (and, optionally, its getMe identity). */
  async function waitForConnected(token: string, expectUsername = false): Promise<TgStatus> {
    return waitFor<TgStatus>(async () => {
      const status = await tgStatus(token);
      if (status.state !== "connected") return undefined;
      if (expectUsername && status.botUsername !== BOT_USERNAME) return undefined;
      return status;
    }, "telegram state connected", 60_000);
  }

  /** Bot API calls recorded from `from` on that the owner could observe. */
  function deliveredFrom(from: number): OutboundCall[] {
    return requireApi()
      .outbound.slice(from)
      .filter((entry) => VISIBLE_METHODS.has(entry.method));
  }

  /** Wait for one visible Bot API call recorded after `from`. */
  async function waitForOutbound(
    predicate: (entry: OutboundCall) => boolean,
    description: string,
    from: number,
    timeoutMs = 30_000
  ): Promise<OutboundCall> {
    const server = requireApi();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = server.outbound.slice(from).find(predicate);
      if (found !== undefined) return found;
      if (Date.now() >= deadline) {
        const dump = server.outbound
          .slice(from)
          .map((entry) => ({ method: entry.method, text: entry.body.text, callback: entry.body.callback_query_id }));
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for ${description}\n--- outbound recorded since ---\n${JSON.stringify(dump, null, 1)}\n${childLog()}`.slice(
            0,
            4000
          )
        );
      }
      await sleep(50);
    }
  }

  /** Every text sent to the owner from `from` on. */
  function sentTexts(from: number): string[] {
    return deliveredFrom(from)
      .filter((entry) => entry.method === "sendMessage")
      .map((entry) => String(entry.body.text ?? ""));
  }

  /** The message id the fake Bot API assigned to one recorded sendMessage. */
  function sentMessageId(entry: OutboundCall): number {
    const id = (entry.result as { message_id?: unknown }).message_id;
    if (typeof id !== "number") throw new Error(`recorded sendMessage carries no message_id: ${JSON.stringify(entry)}`);
    return id;
  }

  function markupOf(entry: OutboundCall): InlineKeyboardMarkup {
    const markup = entry.body.reply_markup as InlineKeyboardMarkup | undefined;
    if (markup === undefined) {
      throw new Error(`recorded ${entry.method} carries no reply_markup: ${JSON.stringify(entry.body)}`);
    }
    return markup;
  }

  /** The flat button row of one rendered view. */
  function buttonsOf(entry: OutboundCall): InlineKeyboardButton[] {
    return markupOf(entry).inline_keyboard.flat();
  }

  async function readState(): Promise<TelegramStateLike> {
    if (home === undefined) throw new Error("home not initialized");
    return JSON.parse(await readFile(join(home, "telegram-state.json"), "utf8")) as TelegramStateLike;
  }

  /** Wait until the persisted state document satisfies `predicate`. */
  function waitForState(
    predicate: (state: TelegramStateLike) => boolean,
    description: string,
    timeoutMs = 20_000
  ): Promise<TelegramStateLike> {
    return waitFor<TelegramStateLike>(async () => {
      let state: TelegramStateLike;
      try {
        state = await readState();
      } catch {
        return undefined; // mid-write: the store renames atomically, so retry
      }
      return predicate(state) ? state : undefined;
    }, description, timeoutMs);
  }

  /** `/start` through the fake update channel; returns the menu message call. */
  async function openMenu(from: number): Promise<OutboundCall> {
    requireApi().enqueueMessage({ fromId: OWNER_USER_ID, text: "/start" });
    return waitForOutbound(
      (entry) => entry.method === "sendMessage" && String(entry.body.text ?? "").includes("Привет"),
      "the welcome menu message",
      from
    );
  }

  /** Press one inline button of the message `messageId`. */
  function pressButton(messageId: number, data: string): void {
    requireApi().enqueueCallback({ fromId: OWNER_USER_ID, data, messageId });
  }

  it("the profile composes balbes-telegram and balbes-workspaces (T11-6: the plugin actually applies)", async () => {
    if (home === undefined) throw new Error("home not initialized");
    // `inject` gained `agentDefaultModel` for the agent runner: if that service
    // were unresolvable in this profile the row would never activate and none
    // of the five admin routes would exist. This test pins the composed entry
    // list; the scenarios below pin that the routes really answer.
    const { stdout } = await execFileP("dsh", ["--profile", PROFILE, "--dump-config"], {
      env: { ...process.env, DSH_HOME: home },
      maxBuffer: 16 * 1024 * 1024
    });
    expect(stdout).toContain("balbes-telegram");
    expect(stdout).toContain("balbes-workspaces");
    expect(stdout).toContain("balbes-api");
    expect(stdout).toContain("dsh-balbes-host");
  }, 120_000);

  it("scenario 1 — the whole owner cycle: configure, /start, list, pick, task, file view; the token never reaches state", async () => {
    if (home === undefined) throw new Error("beforeAll did not initialize home");
    const server = requireApi();
    const llm = requireStub();
    const token = await bootServer();
    try {
      // (a) a project through the real workspaces route, with a note inside it
      const created = await post(`${baseUrl()}/api/workspaces/create`, { name: "demo" }, token);
      expect(created.status, created.text).toBe(200);
      await writeFile(join(home, "projects", "demo", "note.txt"), NOTE_TEXT);

      // (b) a fresh home knows nothing yet
      expect(await tgStatus(token)).toEqual({ state: "not-configured", tokenConfigured: false, enabled: false });

      // (c) enabling without an allowlist is refused as a whole request
      const noUser = await tgPost("/api/telegram/save", { token: BOT_TOKEN, enabled: true }, token);
      expect(noUser.status, noUser.text).toBe(400);
      expect((noUser.json as { error: { code: string } }).error.code).toBe("invalid-config");

      // (d) T11-5: an explicit null allowlist is not "no allowlist" — 400, and
      // the refused request writes nothing at all
      const nullUser = await tgPost("/api/telegram/save", { token: BOT_TOKEN, allowedUserId: null, enabled: true }, token);
      expect(nullUser.status, nullUser.text).toBe(400);
      expect((nullUser.json as { error: { code: string } }).error.code).toBe("invalid-user-id");
      expect(await readIfPresent(join(home, ".credentials.yaml"))).not.toContain("BALBES_TELEGRAM_BOT_TOKEN");

      // (e) the real save: token to the credential store, settings committed,
      // polling started against the fake Bot API
      const saved = await tgPost(
        "/api/telegram/save",
        { token: BOT_TOKEN, allowedUserId: OWNER_USER_ID, enabled: true },
        token
      );
      expect(saved.status, saved.text).toBe(200);
      expect(saved.text).not.toContain(BOT_TOKEN);
      const connected = await waitForConnected(token, true);
      expect(connected.tokenConfigured).toBe(true);
      expect(connected.enabled).toBe(true);
      expect(connected.allowedUserId).toBe(OWNER_USER_ID);
      expect(connected.botUsername).toBe(BOT_USERNAME);
      expect(await readIfPresent(join(home, ".credentials.yaml"))).toContain("BALBES_TELEGRAM_BOT_TOKEN");

      // (f) /start -> the root menu with the «Воркспейсы» button
      const from = server.outbound.length;
      const menu = await openMenu(from);
      const menuId = sentMessageId(menu);
      expect(menu.body.chat_id).toBe(OWNER_USER_ID);
      expect(buttonsOf(menu).map((button) => button.text)).toEqual(["Воркспейсы"]);
      expect(buttonsOf(menu).map((button) => button.callback_data)).toEqual(["ws"]);

      // (g) «Воркспейсы» -> the list of the agent home plus the projects,
      // rendered into the message the button belongs to
      pressButton(menuId, "ws");
      const list = await waitForOutbound(
        (entry) => entry.method === "editMessageText" && String(entry.body.text ?? "").startsWith("Выберите воркспейс"),
        "the workspace list",
        from
      );
      expect(list.body.message_id).toBe(menuId);
      expect(buttonsOf(list).map((button) => button.text)).toEqual(["Дом агента", "Проект: demo"]);
      expect(buttonsOf(list).map((button) => button.callback_data)).toEqual(["ws:pick:0", "ws:pick:1"]);

      // (h) pick the agent home
      pressButton(menuId, "ws:pick:0");
      const picked = await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === "Выбран: Дом агента",
        "the workspace confirmation",
        from
      );
      expect(picked.body.chat_id).toBe(OWNER_USER_ID);
      // every callback gets an answer (Telegram clears the button spinner)
      expect(deliveredFrom(from).some((entry) => entry.method === "answerCallbackQuery")).toBe(true);

      // (i) a task in the selected workspace, answered by the stub
      const agentRoot = join(home, "agent");
      llm.setScript([{ text: STUB_REPLY }]);
      const callsBefore = llm.calls.length;
      server.enqueueMessage({ fromId: OWNER_USER_ID, text: PROMPT_ONE });
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === "Задача принята…",
        "the task acknowledgement",
        from
      );
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === STUB_REPLY,
        "the agent reply from the stub",
        from,
        180_000
      );
      // Exactly ONE model request per turn: the fixture patch disables the
      // session-title-llm base row (Task 1 seam fact 10), so no extra
      // first-prompt request eats a scripted stub entry.
      expect(llm.calls.length - callsBefore).toBe(1);
      // The persona carries `{{cwd}}` of the selected workspace: the host
      // bundle's system-prompt row ("Your working directory is {{cwd}}") is
      // composed AND substituted with the agent home root, which is the
      // workspace under test.
      const messages = llm.calls.at(-1)?.body.messages ?? [];
      const systemMessage = messages.find((message) => message.role === "system");
      const systemText = JSON.stringify(systemMessage ?? {});
      expect(systemText, JSON.stringify(messages).slice(0, 2000)).toContain("Your working directory is");
      expect(systemText, systemText.slice(0, 2000)).toContain(agentRoot);

      // (j) the state document: one session, an acknowledged offset, no token
      const state = await waitForState((current) => current.sessions["home"] !== undefined, "the home session persisted");
      expect(Object.keys(state.sessions)).toEqual(["home"]);
      expect(state.activeWorkspace).toBe("home");
      expect(state.offset ?? 0).toBeGreaterThan(0);
      expect(JSON.stringify(state)).not.toContain(BOT_TOKEN);

      // (k) the file view of the workspace that owns note.txt: the agent home
      // roots at $DSH_HOME/agent and the projects live under $DSH_HOME/projects,
      // so the note is reachable by selecting «Проект: demo» (the very same
      // chat flow, one «Другой воркспейс» press later).
      pressButton(menuId, "act:ws");
      pressButton(menuId, "ws:pick:1");
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === "Выбран: Проект: demo",
        "the project confirmation",
        from
      );
      const treeFrom = server.outbound.length;
      pressButton(menuId, "act:files");
      const tree = await waitForOutbound(
        (entry) => entry.method === "editMessageText" && String(entry.body.text ?? "").startsWith("Файлы: Проект: demo"),
        "the file tree of project demo",
        treeFrom
      );
      expect(buttonsOf(tree).map((button) => button.text)).toContain("📄 note.txt");
      pressButton(menuId, "e:0");
      const file = await waitForOutbound(
        (entry) => entry.method === "editMessageText" && String(entry.body.text ?? "").includes("note inside project demo"),
        "the note page",
        treeFrom
      );
      expect(file.body.text).toBe(NOTE_TEXT);
      const afterBrowse = await waitForState(
        (current) => current.activeWorkspace === "project:demo",
        "the switched workspace persisted"
      );
      expect(afterBrowse.activeWorkspace).toBe("project:demo");
      expect(JSON.stringify(afterBrowse)).not.toContain(BOT_TOKEN);
    } finally {
      await stopServer();
    }
  }, 300_000);

  it("scenario 2 — two workspaces, restart, resume: distinct sessions, restored offset, growing history, read containment", async () => {
    if (home === undefined) throw new Error("beforeAll did not initialize home");
    const server = requireApi();
    const llm = requireStub();
    const token = await bootServer();
    let sessionTwo: string | undefined;
    let offsetBefore = 0;
    let turnOne: StubCall | undefined;
    try {
      // (a) scenario 1's persisted state is restored: the channel comes up
      // connected without touching any setting, and the session map is intact
      const restored = await waitForConnected(token, true);
      expect(restored.tokenConfigured).toBe(true);
      expect(restored.enabled).toBe(true);
      expect(Object.keys((await readState()).sessions)).toEqual(["home"]);

      // (b) a second project, selected through the chat
      const created = await post(`${baseUrl()}/api/workspaces/create`, { name: "two" }, token);
      expect(created.status, created.text).toBe(200);
      const from = server.outbound.length;
      const menu = await openMenu(from);
      const menuId = sentMessageId(menu);
      pressButton(menuId, "ws");
      const list = await waitForOutbound(
        (entry) => entry.method === "editMessageText" && String(entry.body.text ?? "").startsWith("Выберите воркспейс"),
        "the workspace list with both projects",
        from
      );
      expect(buttonsOf(list).map((button) => button.callback_data)).toEqual(["ws:pick:0", "ws:pick:1", "ws:pick:2"]);
      pressButton(menuId, "ws:pick:2");
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === "Выбран: Проект: two",
        "the project two confirmation",
        from
      );

      // (c) a task in project two owns its own session
      llm.setScript([{ text: STUB_REPLY_TWO }]);
      const callsBefore = llm.calls.length;
      server.enqueueMessage({ fromId: OWNER_USER_ID, text: PROMPT_TWO });
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === STUB_REPLY_TWO,
        "the reply in project two",
        from,
        180_000
      );
      expect(llm.calls.length - callsBefore).toBe(1);
      turnOne = llm.calls.at(-1);
      const twoState = await waitForState(
        (current) => current.sessions["project:two"] !== undefined,
        "the project two session persisted"
      );
      expect(Object.keys(twoState.sessions).sort()).toEqual(["home", "project:two"]);
      sessionTwo = twoState.sessions["project:two"];
      expect(sessionTwo).not.toBe(twoState.sessions["home"]);
      expect(sessionTwo).toBeTruthy();
      offsetBefore = twoState.offset ?? 0;
      expect(offsetBefore).toBeGreaterThan(0);

      // ---- restart on the same home ----
      await stopServer();
      server.reset();
      const token2 = await bootServer();
      const afterRestart = await waitForConnected(token2, true);
      expect(afterRestart.botUsername).toBe(BOT_USERNAME);

      // (d) the FIRST long poll after boot asks for the persisted offset
      const firstPoll = await waitFor(
        () => server.getUpdatesRequests()[0],
        "the first long poll after the restart",
        30_000
      );
      expect(firstPoll.body.offset).toBe(offsetBefore);
      // ...and it stays there while nothing new arrives
      const secondPoll = await waitFor(
        () => server.getUpdatesRequests()[1],
        "a second long poll after the restart",
        30_000
      );
      expect(secondPoll.body.offset).toBe(offsetBefore);

      // (e) an update the previous process already acknowledged is NEVER
      // re-delivered: it is below the restored offset, so the fake server does
      // not hand it over and nothing reaches the owner
      const staleFrom = server.outbound.length;
      server.enqueueMessage({
        fromId: OWNER_USER_ID,
        text: "stale re-delivery must be ignored",
        updateId: offsetBefore - 1
      });
      await sleep(1600);
      expect(deliveredFrom(staleFrom)).toEqual([]);
      expect((await readState()).offset).toBe(offsetBefore);

      // (f) a NEW task resumes the persisted session: same session id, and the
      // stub sees the previous turn's history in the request
      llm.setScript([{ text: STUB_REPLY }]);
      const resumeFrom = server.outbound.length;
      server.enqueueMessage({ fromId: OWNER_USER_ID, text: PROMPT_ONE });
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === STUB_REPLY,
        "the reply after the restart",
        resumeFrom,
        180_000
      );
      const resumed = await waitForState((current) => (current.offset ?? 0) > offsetBefore, "the offset to advance");
      expect(resumed.sessions["project:two"]).toBe(sessionTwo);
      const turnTwo = llm.calls.at(-1);
      const messagesBefore = turnOne?.body.messages?.length ?? 0;
      const messagesAfter = turnTwo?.body.messages?.length ?? 0;
      expect(messagesAfter, JSON.stringify(turnTwo?.body).slice(0, 2000)).toBeGreaterThan(messagesBefore);
      expect(JSON.stringify(turnTwo?.body)).toContain(PROMPT_TWO);

      // (g) containment through the COMPOSED profile: a task that asks for a
      // path outside the workspace root is denied by composeAgentSetup's guard,
      // so the bytes of $DSH_HOME/.credentials.yaml (the bot token lives there)
      // never reach the model, the reply or any outbound message.
      llm.setScript([
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: join(home, ".credentials.yaml") }) } },
        { text: CONTAINMENT_REPLY }
      ]);
      const guardFrom = server.outbound.length;
      server.enqueueMessage({ fromId: OWNER_USER_ID, text: PROMPT_CONTAINMENT });
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === CONTAINMENT_REPLY,
        "the containment reply",
        guardFrom,
        180_000
      );
      const guardBody = JSON.stringify(llm.calls.at(-1)?.body ?? {});
      expect(guardBody, guardBody.slice(0, 2000)).toContain("outside the workspace root");
      expect(JSON.stringify(llm.calls)).not.toContain(BOT_TOKEN);
      // the owner still got the (scripted) answer, and nothing else carried the
      // credentials file's content
      expect(sentTexts(guardFrom)).toContain(CONTAINMENT_REPLY);
      expect(JSON.stringify(deliveredFrom(guardFrom))).not.toContain(BOT_TOKEN);
    } finally {
      await stopServer();
    }
  }, 420_000);

  it("scenario 3 — security: foreign and group updates ignored, disable/clear-token, no secret on the wire or the disk", async () => {
    if (home === undefined) throw new Error("beforeAll did not initialize home");
    const server = requireApi();
    const token = await bootServer();
    try {
      // (a) a definitely configured, running channel
      const saved = await tgPost(
        "/api/telegram/save",
        { token: BOT_TOKEN, allowedUserId: OWNER_USER_ID, enabled: true },
        token
      );
      expect(saved.status, saved.text).toBe(200);
      const connected = await waitForConnected(token, true);
      expect(connected.tokenConfigured).toBe(true);
      expect(JSON.stringify(connected)).not.toContain(BOT_TOKEN);

      // (b) a foreign private message and a message from the owner in a group
      // chat: both are fetched and acknowledged, neither is ever processed
      const beforeForeign = await readState();
      const foreignFrom = server.outbound.length;
      const foreign = server.enqueueMessage({ fromId: FOREIGN_USER_ID, text: "foreign hello" });
      const grouped = server.enqueueMessage({
        fromId: OWNER_USER_ID,
        chatId: GROUP_CHAT_ID,
        chatType: "group",
        text: "group hello"
      });
      await sleep(1600);
      expect(deliveredFrom(foreignFrom)).toEqual([]);
      // The poller acknowledges `last.update_id + 1` even for a batch it hands
      // to nobody, so an ignored update is never fetched again.
      const ackedOffset = Math.max(Number(foreign.update_id), Number(grouped.update_id)) + 1;
      const afterForeign = await waitForState(
        (current) => (current.offset ?? 0) === ackedOffset,
        "the acknowledged offset to pass the unauthorized updates"
      );
      expect(afterForeign.offset ?? 0).toBeGreaterThan(beforeForeign.offset ?? 0);
      expect(afterForeign.offset).toBe(ackedOffset);
      expect(JSON.stringify(deliveredFrom(foreignFrom))).not.toContain("foreign hello");
      expect(JSON.stringify(deliveredFrom(foreignFrom))).not.toContain("group hello");

      // (c) disable: the setting flips, the credential stays, the loop stops
      const disabled = await tgPost("/api/telegram/disable", {}, token);
      expect(disabled.status, disabled.text).toBe(200);
      expect((disabled.json as { status: TgStatus }).status.state).toBe("disabled");
      expect(await readIfPresent(join(home, ".credentials.yaml"))).toContain("BALBES_TELEGRAM_BOT_TOKEN");
      // Give the transition time to drain the in-flight long poll, then watch a
      // window longer than two full poll cycles: no further getUpdates arrives.
      await sleep(2000);
      const pollsAfterDisable = server.getUpdatesRequests().length;
      expect(pollsAfterDisable).toBeGreaterThan(0);
      await sleep(3000);
      expect(server.getUpdatesRequests().length).toBe(pollsAfterDisable);

      // (d) re-enabling without touching the token starts the loop again
      const reenabled = await tgPost("/api/telegram/save", { enabled: true }, token);
      expect(reenabled.status, reenabled.text).toBe(200);
      await waitForConnected(token);
      await waitFor(
        () => (server.getUpdatesRequests().length > pollsAfterDisable ? true : undefined),
        "polling to resume after re-enabling"
      );

      // (e) the connection test reports the getMe identity and nothing else
      const tested = await tgPost("/api/telegram/test", {}, token);
      expect(tested.status, tested.text).toBe(200);
      expect(tested.json).toEqual({ username: BOT_USERNAME });

      // (f) the status surface reports the credential's presence, never it
      const configured = await tgStatus(token);
      expect(configured.tokenConfigured).toBe(true);
      expect(JSON.stringify(configured)).not.toContain(BOT_TOKEN);

      // (g) clear-token: not configured, credential erased, loop not active
      const cleared = await tgPost("/api/telegram/clear-token", {}, token);
      expect(cleared.status, cleared.text).toBe(200);
      const clearedStatus = (cleared.json as { status: TgStatus }).status;
      expect(clearedStatus.state).toBe("not-configured");
      expect(clearedStatus.tokenConfigured).toBe(false);
      expect(clearedStatus.enabled).toBe(false);
      expect(await readIfPresent(join(home, ".credentials.yaml"))).not.toContain("BALBES_TELEGRAM_BOT_TOKEN");
      await sleep(2000);
      const pollsAfterClear = server.getUpdatesRequests().length;
      await sleep(3000);
      expect(server.getUpdatesRequests().length).toBe(pollsAfterClear);
      // Nothing delivers updates any more, not even from the owner.
      const afterClearFrom = server.outbound.length;
      server.enqueueMessage({ fromId: OWNER_USER_ID, text: PROMPT_ONE });
      await sleep(1600);
      expect(deliveredFrom(afterClearFrom)).toEqual([]);

      // (h) secrets: nowhere in the state document, the process logs or the
      // wire — and the owner's chat messages never carry it either
      const state = await readState();
      expect(JSON.stringify(state)).not.toContain(BOT_TOKEN);
      expect(childOut).not.toContain(BOT_TOKEN);
      expect(childErr).not.toContain(BOT_TOKEN);
      expect(JSON.stringify(server.outbound)).not.toContain(BOT_TOKEN);
      // the loop really ran in this scenario (the getUpdates assertions above
      // would otherwise be vacuous on a channel that never polled)
      expect(server.getUpdatesRequests().length).toBeGreaterThan(0);
      for (const body of telegramResponses) {
        expect(body, `telegram response leaked the token: ${body}`).not.toContain(BOT_TOKEN);
        const parsed = JSON.parse(body) as unknown;
        expect(hasKeyDeep(parsed, "token"), `telegram response carries a token field: ${body}`).toBe(false);
      }
    } finally {
      await stopServer();
    }
  }, 300_000);
});
