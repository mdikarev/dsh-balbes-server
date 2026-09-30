import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

/**
 * REAL extraction composition of the Telegram channel (p10g). The harness is
 * COPIED from `integration.test.ts` (same imports, helpers, beforeAll/afterAll);
 * the profile is `balbes-telegram-extraction-profile`, i.e. the very same
 * composition as `balbes-telegram-test` PLUS the three memory rows
 * (`balbes-memory`, `balbes-memory-context`, `balbes-memory-admin`).
 *
 * Why a copy and a separate profile instead of extending the shared REAL suite:
 * the approval scenarios there run tasks that do tool work, and with the memory
 * rows composed every such successful turn would spend one more model request
 * on the p10g service turn — that would desynchronise their stub scripts. This
 * file isolates the extraction proof in its own profile and leaves the shared
 * REAL suite untouched.
 *
 * What it proves end to end, over the real dsh composition:
 *  - a successful task whose turn did tool work triggers exactly one service
 *    turn, and the agent's request during that turn offers `propose_memory` and
 *    no longer offers `remember` (dynamic tool registration after `setup` on
 *    the REAL registry); the task turn's request is the mirror image;
 *  - the `propose_memory` call stages a proposal in the review queue with the
 *    channel provenance, and stages it only — the record list does not carry it;
 *  - a chat-only task spends exactly ONE model request, so no extraction turn
 *    happened and nothing was staged.
 *
 * Like the shared suite, the two external boundaries are local: the Bot API is
 * `tests/helpers/fake-bot-api.mjs` through `BALBES_TELEGRAM_API_BASE`, and the
 * LLM is `tests/helpers/stub-llm.mjs` through `settings.yaml`.
 *
 * Gate: RUN_REAL=1 AND a dsh executable on PATH (mirrors the models/host REAL
 * suites); skipped otherwise, so the plain unit gate stays hermetic.
 */

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url)); // tests/ dir
const pkgRoot = join(here, ".."); // dsh-balbes-telegram package root
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const workspacesPkgRoot = join(pkgRoot, "..", "dsh-balbes-workspaces");
const sessionsPkgRoot = join(pkgRoot, "..", "dsh-balbes-sessions");
const modelsPkgRoot = join(pkgRoot, "..", "dsh-balbes-models");
const memoryPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory");
const memoryContextPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory-context");
const memoryAdminPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory-admin");
const fixtureProfile = join(here, "fixtures", "balbes-telegram-extraction-profile");
const PROFILE = "balbes-telegram-extraction-test";

// Computed URLs: the helpers are plain .mjs with no declarations, and this
// package's tsconfig typechecks `tests/`, so a literal specifier would fail.
const STUB_LLM_URL = new URL("./helpers/stub-llm.mjs", import.meta.url).href;
const FAKE_BOT_API_URL = new URL("./helpers/fake-bot-api.mjs", import.meta.url).href;

const BOT_TOKEN = "123:FAKE";
const OWNER_USER_ID = 777_000_123;
const GROUP_CHAT_ID = -1_000_123_456;
const BOT_USERNAME = "balbes_test_bot";

const STUB_REPLY = "ok from stub";

interface StubCall {
  path: string;
  body: { messages?: Array<{ role?: string; content?: unknown }>; system?: unknown };
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
  /** The `result` of an `ok:true` envelope; absent for a refused call. */
  result?: Record<string, unknown> | boolean;
  /** The envelope of a refused call (e.g. the fake's 409 conflict). */
  error?: Record<string, unknown>;
}

/** The fake Bot API server's control surface (helpers/fake-bot-api.mjs). */
interface FakeBotApi {
  port: number;
  url: string;
  username: string;
  groupChatId?: number;
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

async function startStubLlm(): Promise<StubLlm> {
  const mod = (await import(STUB_LLM_URL)) as { startStubLlm(o?: { text?: string }): Promise<StubLlm> };
  return mod.startStubLlm({ text: STUB_REPLY });
}

async function startFakeBotApi(): Promise<FakeBotApi> {
  const mod = (await import(FAKE_BOT_API_URL)) as { startFakeBotApi(o?: object): Promise<FakeBotApi> };
  // The group chat id makes the fake report `chat.type: "group"` for that chat,
  // like the real API, instead of always answering "private".
  return mod.startFakeBotApi({ username: BOT_USERNAME, groupChatId: GROUP_CHAT_ID });
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
 * Compile src -> lib for the plugin under test, the workspaces plugin, the
 * sessions plugin (composed as a dependency: the registry the plugin under test
 * writes into lives there), the models plugin (its `balbesModels` service is a
 * required dependency of the channel), the three memory plugins the extraction
 * profile composes, and the host bundle (tsc straight from the store, cwd
 * package). The plugin and the other packages use tsconfig.build.json so their
 * tsconfig.json can typecheck src + tests.
 */
async function buildPackages(): Promise<void> {
  const configs: Array<[string, string]> = [
    [pkgRoot, "tsconfig.build.json"],
    [workspacesPkgRoot, "tsconfig.build.json"],
    [sessionsPkgRoot, "tsconfig.build.json"],
    [modelsPkgRoot, "tsconfig.build.json"],
    [memoryPkgRoot, "tsconfig.build.json"],
    [memoryContextPkgRoot, "tsconfig.build.json"],
    [memoryAdminPkgRoot, "tsconfig.build.json"],
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

const runReal = (process.env.RUN_REAL ?? "").trim() === "1";
const realEnabled = runReal ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL extraction composition (fake Bot API + LLM stub)", () => {
  let stub: StubLlm | undefined;
  let api: FakeBotApi | undefined;
  /** The home the running boot uses; this file's single scenario owns it. */
  let home: string | undefined;
  let port: number;
  let login: string;
  let password: string;
  let auth: Awaited<ReturnType<typeof createAdminAuth>> | undefined;
  let child: ReturnType<typeof spawn> | null = null;
  /** Logs of the CURRENT boot, for the failure diagnostics of waitForHealth. */
  let childOut = "";
  let childErr = "";
  /** Every temp home created here, removed in afterAll. */
  const homes: string[] = [];

  const childLog = (): string => `--- dsh stdout ---\n${childOut}\n--- dsh stderr ---\n${childErr}`;

  /**
   * One deployable test home: the extraction fixture profile plus the built
   * host bundle and all seven plugins in its node_modules (install.sh in
   * miniature), an admin auth file and a `settings.yaml` that points the agent
   * at the LLM stub. The plugin under test, the sessions/models plugins its
   * `inject` list requires and the three memory rows the extraction scenario
   * needs are all mirrored, exactly as the fixture patch composes them.
   */
  async function prepareHome(prefix: string): Promise<string> {
    if (auth === undefined || stub === undefined) throw new Error("beforeAll did not initialize auth/stub");
    const dir = await mkdtemp(join(tmpdir(), prefix));
    homes.push(dir);
    const profiles = join(dir, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, PROFILE), { recursive: true });
    // @deepseek-ai/* resolves up to $DSH_HOME/profiles/node_modules, which dsh
    // heals from its own install on first boot.
    const nm = join(profiles, PROFILE, "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    for (const [pkg, dirName] of [
      [workspacesPkgRoot, "dsh-balbes-workspaces"],
      [sessionsPkgRoot, "dsh-balbes-sessions"],
      // The channel's `inject` list carries `balbesSessions` and `balbesModels`,
      // and Cordis has no optional inject: without these two mirrors the telegram
      // row stays pending and the whole boot fails (the fixture patch composes
      // the same rows).
      [modelsPkgRoot, "dsh-balbes-models"],
      // The extraction rows: the store (`balbesMemory`), the extraction seat on
      // the agent attachment (`balbesMemoryContext`) and the review routes the
      // scenario reads the staged proposal from.
      [memoryPkgRoot, "dsh-balbes-memory"],
      [memoryContextPkgRoot, "dsh-balbes-memory-context"],
      [memoryAdminPkgRoot, "dsh-balbes-memory-admin"],
      [pkgRoot, "dsh-balbes-telegram"]
    ] as Array<[string, string]>) {
      await cp(join(pkg, "lib"), join(nm, dirName, "lib"), { recursive: true });
      await cp(join(pkg, "package.json"), join(nm, dirName, "package.json"));
    }
    // Auth file: never store the plaintext password, print it only to log in.
    await writeAdminAuth(dir, auth);
    // Point the default model at the deepseek route (llm-deepseek registers
    // provider "deepseek-official") and that adapter at the stub endpoint. The
    // models plugin reads this very section as the selection in force, so it is
    // what both makes the composed agent reachable by the stub AND gives the
    // /model picker its starting state (the same document `saveDefault`
    // rewrites when the owner picks another model).
    await writeFile(
      join(dir, "settings.yaml"),
      `agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nllm-deepseek:\n  baseURL: http://127.0.0.1:${stub.port}\n`
    );
    return dir;
  }

  beforeAll(async () => {
    await buildPackages();
    stub = await startStubLlm();
    api = await startFakeBotApi();
    port = await freePort();
    const creds = await createAdminAuth();
    auth = creds;
    login = creds.login;
    password = creds.plaintextPassword;
    // This file's scenario owns this home: a fresh channel state is what makes
    // the chat-only leg of the extraction proof (one model request for the
    // task) independent of anything another scenario left behind.
    home = await prepareHome("balbes-telegram-extraction-");
  }, 300_000);

  afterAll(async () => {
    if (child !== null && child.exitCode === null) child.kill("SIGKILL");
    api?.close();
    stub?.close();
    for (const dir of homes) await rm(dir, { recursive: true, force: true });
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
    // Keep this boot's output for the failure diagnostics of waitForHealth
    // (childLog) — the health timeout is the one place a boot log is reported.
    spawned.stdout?.on("data", (chunk: Buffer) => {
      childOut += chunk.toString();
    });
    spawned.stderr?.on("data", (chunk: Buffer) => {
      childErr += chunk.toString();
    });
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

  /** POST one `/api/telegram/*` route. */
  async function tgPost(path: string, body: unknown, token: string): Promise<HttpResult> {
    return post(`${baseUrl()}${path}`, body, token);
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

  /** Wait for one recorded Bot API call after `from`. */
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

  /** The message id the fake Bot API assigned to one recorded sendMessage. */
  function sentMessageId(entry: OutboundCall): number {
    const result = entry.result;
    const id =
      typeof result === "object" && result !== null ? (result as { message_id?: unknown }).message_id : undefined;
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

  /** `/start` through the fake update channel; returns the menu card message call. */
  async function openMenu(from: number): Promise<OutboundCall> {
    requireApi().enqueueMessage({ fromId: OWNER_USER_ID, text: "/start" });
    return waitForOutbound(
      (entry) => entry.method === "sendMessage" && String(entry.body.text ?? "").startsWith("🤖 Агент сервера"),
      "the menu card",
      from
    );
  }

  /** Press one inline button of the message `messageId`. */
  function pressButton(messageId: number, data: string): void {
    requireApi().enqueueCallback({ fromId: OWNER_USER_ID, data, messageId });
  }

  const EXTRACTION_TASK_PROMPT = "Прочитай extraction-smoke.txt и ответь одной строкой";
  const EXTRACTION_TASK_REPLY = "прочитал";
  const EXTRACTION_PROPOSAL_TEXT = "Балбес: smoke-задача p10g доходит до очереди ревью";
  const EXTRACTION_DONE_REPLY = "предложил";
  const EXTRACTION_CHAT_REPLY = "привет";

  /**
   * p10g end to end: a task that does real tool work triggers the service
   * extraction turn, whose `propose_memory` call lands a proposal in the review
   * queue with the channel provenance and NOT in memory; a chat-only task
   * spends exactly one model request, so no extraction turn happened.
   */
  it("extraction proposes after tool work, and a chat-only task proposes nothing", async () => {
    if (home === undefined) throw new Error("beforeAll did not initialize home");
    const server = requireApi();
    const llm = requireStub();
    const token = await bootServer();
    try {
      // (a0) This home is FRESH, so the channel boots unconfigured and the fake
      // Bot API can deliver nothing until the owner path enables it: token to
      // the credential store, allowlist, polling started. The shared suite's
      // scenario 1 does the same; this file owns its own home and cannot
      // inherit that store.
      const saved = await tgPost(
        "/api/telegram/save",
        { token: BOT_TOKEN, allowedUserId: OWNER_USER_ID, enabled: true },
        token
      );
      expect(saved.status, saved.text).toBe(200);
      await waitForConnected(token, true);

      // (a) the agent home is the active workspace for this scenario
      const from = server.outbound.length;
      const menu = await openMenu(from);
      const menuId = sentMessageId(menu);
      pressButton(menuId, "ws");
      const list = await waitForOutbound(
        (entry) => entry.method === "editMessageText" && String(entry.body.text ?? "").startsWith("Выберите воркспейс"),
        "the workspace list",
        from
      );
      expect(buttonsOf(list).map((button) => button.callback_data)).toContain("ws:pick:0");
      pressButton(menuId, "ws:pick:0");
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === "Выбран: Дом агента",
        "the agent home confirmation",
        from
      );

      // (b) a real tool read, then an answer; the service turn follows and
      // proposes once, then answers
      await mkdir(join(home, "agent"), { recursive: true });
      await writeFile(join(home, "agent", "extraction-smoke.txt"), "smoke\n");
      llm.setScript([
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: "extraction-smoke.txt" }) } },
        { text: EXTRACTION_TASK_REPLY },
        { toolCall: { name: "propose_memory", arguments: JSON.stringify({ text: EXTRACTION_PROPOSAL_TEXT, type: "fact", tags: ["p10g"] }) } },
        { text: EXTRACTION_DONE_REPLY }
      ]);
      server.enqueueMessage({ fromId: OWNER_USER_ID, text: EXTRACTION_TASK_PROMPT });
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === EXTRACTION_TASK_REPLY,
        "the task answer",
        from,
        180_000
      );

      // (b2) the model request of the service turn proves the surface switch on
      // the REAL registry: during extraction the agent may propose and cannot
      // write memory immediately; the task turn is the mirror image.
      //
      // The service turn is CONCURRENT with the delivery of the task answer:
      // `task.resolve` settles before `runExtractionTurn` starts (src/agentTask
      // .ts), so waiting for the answer alone leaves the extraction request in
      // flight. Wait for it before asserting (the bounded-wait discipline Task 3
      // already pinned for the same boundary).
      const toolNames = (body: unknown): string[] =>
        ((body as { tools?: Array<{ name?: string }> }).tools ?? []).map((tool) => tool.name ?? "");
      const isExtractionRequest = (call: StubCall): boolean =>
        JSON.stringify(call.body.messages ?? []).includes("Служебный шаг после успешной задачи");
      const extractionCall = await waitFor(
        () => llm.calls.find(isExtractionRequest),
        "the extraction turn's model request"
      );
      expect(toolNames(extractionCall.body)).toContain("propose_memory");
      expect(toolNames(extractionCall.body)).not.toContain("remember");
      const taskCall = llm.calls.find((call) =>
        JSON.stringify(call.body.messages ?? []).includes(EXTRACTION_TASK_PROMPT)
      );
      expect(taskCall, "the task turn's model request").toBeDefined();
      expect(toolNames(taskCall!.body)).toContain("remember");
      expect(toolNames(taskCall!.body)).not.toContain("propose_memory");

      // (c) the proposal is staged for review with the channel provenance
      const reviewList = async (): Promise<Array<{ id: string; text: string; originRef: string | null }>> => {
        const response = await post(`${baseUrl()}/api/memory/review/list`, { status: ["proposed"] }, token);
        expect(response.status, response.text).toBe(200);
        const body = response.json as { proposals?: Array<{ id: string; text: string; originRef: string | null }> };
        expect(Array.isArray(body.proposals), response.text).toBe(true);
        return body.proposals ?? [];
      };
      const staged = await waitFor(
        async () => (await reviewList()).find((candidate) => candidate.text === EXTRACTION_PROPOSAL_TEXT),
        "the extraction proposal in the review queue"
      );
      expect(staged.originRef).toMatch(/^telegram session:.+$/);

      // (d) staged means staged: the record list does not carry it. The negative
      // assertion is only meaningful on a WELL-FORMED 200 records response — an
      // error body (or an absent `records`) must fail here instead of satisfying
      // "the text is not there".
      const records = await post(`${baseUrl()}/api/memory/list`, { query: "smoke" }, token);
      expect(records.status, records.text).toBe(200);
      const recordList = (records.json as { records?: Array<{ text: string }> }).records;
      expect(Array.isArray(recordList), records.text).toBe(true);
      expect(records.text).not.toContain(EXTRACTION_PROPOSAL_TEXT);

      // (e) a chat-only task spends exactly ONE model request (an extraction
      // turn would spend another) and stages nothing
      //
      // The service turn must be OVER before the chat-only count is taken: its
      // CLOSING model request is issued right after the proposal, and a count
      // that still has it in flight would charge it to the chat task. The
      // service turn ends with a request that replays the `propose_memory`
      // tool result, so wait for the second extraction request.
      await waitFor(
        () => (llm.calls.filter(isExtractionRequest).length >= 2 ? true : undefined),
        "the extraction turn to close"
      );
      // Compare the identities of the pending proposals, not their count: a
      // chat-only turn that staged one proposal while another disappeared would
      // keep the count equal and must still fail.
      const pendingBefore = (await reviewList()).map((proposal) => proposal.id).sort();
      const callsBefore = llm.calls.length;
      llm.setScript([{ text: EXTRACTION_CHAT_REPLY }]);
      server.enqueueMessage({ fromId: OWNER_USER_ID, text: "привет" });
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === EXTRACTION_CHAT_REPLY,
        "the chat answer",
        from,
        180_000
      );
      expect(llm.calls.length - callsBefore).toBe(1);
      const pendingAfter = (await reviewList()).map((proposal) => proposal.id).sort();
      expect(pendingAfter).toEqual(pendingBefore);
    } finally {
      await stopServer();
    }
  }, 300_000);
});
