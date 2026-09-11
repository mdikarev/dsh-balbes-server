import { describe, expect, it, vi } from "vitest";
import type { AgentTaskRunner, TaskProgress, TaskResult, WorkspaceRef } from "../src/agentTask.js";
import type { BotClient } from "../src/bot.js";
import {
  createChatMachine,
  type ChatDeps,
  type ChatMachine,
  type ModelConnectionRow,
  type ModelsSlice,
  type WorkspaceFileResult,
  type WorkspaceTreeEntry
} from "../src/chat.js";
import type { ClassifiedUpdate } from "../src/updates.js";

/**
 * Hermetic unit suite for the owner chat UX machine. Every dependency is a
 * recording fake: the bot captures sendMessage/editMessageText/
 * answerCallbackQuery calls, the workspaces slice answers from in-memory maps
 * (with injectable failures) and the runner returns a scripted TaskResult.
 * No network, no dsh agent, no real filesystem.
 */

const CHAT = 42;
const MAX_FILE_BYTES = 256 * 1024;

interface MarkupButton {
  text: string;
  callback_data?: string;
}
interface Markup {
  inline_keyboard: MarkupButton[][];
}
interface SentCall {
  chatId: number;
  /** The id the fake Bot API assigns to this send, like the real one does. */
  messageId: number;
  text: string;
  markup: Markup | undefined;
}
interface EditCall extends SentCall {
  messageId: number;
}

function markupOf(extra: { reply_markup?: unknown } | undefined): Markup | undefined {
  return extra?.reply_markup as Markup | undefined;
}

function makeBot(opts: { failEdits?: number; failSends?: number } = {}): {
  bot: BotClient;
  sent: SentCall[];
  edits: EditCall[];
  answers: Array<{ id: string; text: string | undefined }>;
  texts: () => string[];
  editTexts: () => string[];
  lastEdit: () => EditCall;
  buttons: (markup: Markup | undefined) => MarkupButton[];
  data: (markup: Markup | undefined) => string[];
  buttonByData: (markup: Markup | undefined, data: string) => MarkupButton | undefined;
  buttonByText: (markup: Markup | undefined, text: string) => MarkupButton | undefined;
} {
  const sent: SentCall[] = [];
  const edits: EditCall[] = [];
  const answers: Array<{ id: string; text: string | undefined }> = [];
  // Telegram assigns every sent message an id and answers sendMessage with it;
  // the fake does the same so the chat can snapshot what it sent.
  let nextSentId = 900_000;
  // The progress-card tests need a Telegram that refuses work: `failEdits`
  // refuses the first N edits (a live card gives up after three of them),
  // `failSends` the first N sends (a task whose card was never sent).
  let editFailures = opts.failEdits ?? 0;
  let sendFailures = opts.failSends ?? 0;
  const bot: BotClient = {
    async getMe() {
      return {};
    },
    async getUpdates() {
      return [];
    },
    async sendMessage(chatId, text, extra) {
      if (sendFailures > 0) {
        sendFailures -= 1;
        throw new Error("sendMessage failed");
      }
      const messageId = nextSentId++;
      sent.push({ chatId, messageId, text, markup: markupOf(extra) });
      return messageId;
    },
    async editMessageText(chatId, messageId, text, extra) {
      // Recorded BEFORE the refusal: the attempted calls are what the
      // give-up-after-three-edits test counts.
      edits.push({ chatId, messageId, text, markup: markupOf(extra) });
      if (editFailures > 0) {
        editFailures -= 1;
        throw new Error("editMessageText failed");
      }
    },
    async answerCallbackQuery(callbackQueryId, opts) {
      answers.push({ id: callbackQueryId, text: opts?.text });
    },
    async setMyCommands() {},
    async setChatMenuButton() {}
  };
  const buttons = (markup: Markup | undefined): MarkupButton[] =>
    markup === undefined ? [] : markup.inline_keyboard.flat();
  return {
    bot,
    sent,
    edits,
    answers,
    texts: () => sent.map((call) => call.text),
    editTexts: () => edits.map((call) => call.text),
    lastEdit: () => edits[edits.length - 1]!,
    buttons,
    data: (markup) => buttons(markup).map((button) => button.callback_data ?? ""),
    buttonByData: (markup, data) => buttons(markup).find((button) => button.callback_data === data),
    buttonByText: (markup, text) => buttons(markup).find((button) => button.text === text)
  };
}

type Scope = "home" | "project";
interface DirCall {
  scope: Scope;
  name: string | undefined;
  relPath: string;
}

function workspaceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function makeWorkspaces(): {
  service: ChatDeps["workspaces"];
  projects: string[];
  setDir: (scope: Scope, relPath: string, entries: WorkspaceTreeEntry[], name?: string) => void;
  setFile: (scope: Scope, relPath: string, result: WorkspaceFileResult, name?: string) => void;
  failDir: (scope: Scope, relPath: string, error: unknown, name?: string) => void;
  failFile: (scope: Scope, relPath: string, error: unknown, name?: string) => void;
  failList: (error: unknown) => void;
  dirCalls: DirCall[];
  fileCalls: DirCall[];
} {
  const projectNames: string[] = [];
  const dirs = new Map<string, WorkspaceTreeEntry[]>();
  const files = new Map<string, WorkspaceFileResult>();
  const dirFailures = new Map<string, unknown>();
  const fileFailures = new Map<string, unknown>();
  const dirCalls: DirCall[] = [];
  const fileCalls: DirCall[] = [];
  let listFailure: unknown;

  const key = (scope: Scope, name: string | undefined, relPath: string): string =>
    `${scope}:${name ?? ""}:${relPath}`;

  const service: ChatDeps["workspaces"] = {
    async list() {
      if (listFailure !== undefined) throw listFailure;
      return {
        home: { path: "/dsh/agent" },
        projects: projectNames.map((name) => ({ name, path: `/dsh/projects/${name}` }))
      };
    },
    async readDir(scope, name, relPath) {
      const call = { scope, name, relPath };
      dirCalls.push(call);
      const failure = dirFailures.get(key(scope, name, relPath));
      if (failure !== undefined) throw failure;
      const entries = dirs.get(key(scope, name, relPath));
      if (entries === undefined) throw workspaceError("not-found", `directory not found: ${relPath}`);
      return entries.map((entry) => ({ ...entry }));
    },
    async readFile(scope, name, relPath) {
      const call = { scope, name, relPath };
      fileCalls.push(call);
      const failure = fileFailures.get(key(scope, name, relPath));
      if (failure !== undefined) throw failure;
      const result = files.get(key(scope, name, relPath));
      if (result === undefined) throw workspaceError("not-found", `file not found: ${relPath}`);
      return result;
    }
  };

  return {
    service,
    projects: projectNames,
    setDir: (scope, relPath, entries, name) => dirs.set(key(scope, name, relPath), entries),
    setFile: (scope, relPath, result, name) => files.set(key(scope, name, relPath), result),
    failDir: (scope, relPath, error, name) => dirFailures.set(key(scope, name, relPath), error),
    failFile: (scope, relPath, error, name) => fileFailures.set(key(scope, name, relPath), error),
    failList: (error) => {
      listFailure = error;
    },
    dirCalls,
    fileCalls
  };
}

function makeRunner(): {
  service: AgentTaskRunner;
  runs: Array<{ ref: WorkspaceRef; text: string }>;
  resets: WorkspaceRef[];
  cancel: ReturnType<typeof vi.fn>;
  progress: ReturnType<typeof vi.fn>;
  sessionIdOf: ReturnType<typeof vi.fn>;
  setResult: (result: TaskResult) => void;
  hold: () => { release: (result: TaskResult) => void; settled: () => boolean };
} {
  const runs: Array<{ ref: WorkspaceRef; text: string }> = [];
  const resets: WorkspaceRef[] = [];
  // Configurable by the chat tests that drive the /stop surface: the default is
  // "nothing was running".
  const cancels = vi.fn(async () => ({ cancelled: false, dropped: 0 }));
  // Configurable by the menu-card tests: the default is an idle workspace with
  // no session yet.
  const progress = vi.fn((): TaskProgress => ({ phase: "idle", steps: [], queued: 0 }));
  const sessionIdOf = vi.fn((): string | undefined => undefined);
  let result: TaskResult = { ok: true, text: "готово", sessionId: "session-1" };
  let gate: Promise<TaskResult> | undefined;

  const service: AgentTaskRunner = {
    async run(ref, text) {
      runs.push({ ref, text });
      if (gate !== undefined) return gate;
      return result;
    },
    async reset(ref) {
      resets.push(ref);
    },
    cancel: cancels,
    progress,
    sessionIdOf,
    snapshot() {
      return [];
    }
  };

  return {
    service,
    runs,
    resets,
    cancel: cancels,
    progress,
    sessionIdOf,
    setResult: (next) => {
      result = next;
    },
    hold: () => {
      let release!: (next: TaskResult) => void;
      let settled = false;
      gate = new Promise<TaskResult>((resolve) => {
        release = (next) => {
          settled = true;
          resolve(next);
        };
      });
      return { release, settled: () => settled };
    }
  };
}

/** The injected models fake: the service slice plus the write log tests assert on. */
type ModelsFake = ModelsSlice & {
  saved: Array<{ provider: string; model: string }>;
  failList(error: unknown): void;
};

/**
 * The models service fake. `list()` hands out copies and `saveDefault` records
 * the write and moves the current selection, like the real service (which
 * re-reads its connections on every call and persists the new default).
 */
function makeModels(rows: ModelConnectionRow[]): ModelsFake {
  const copy = (source: ModelConnectionRow[]): ModelConnectionRow[] =>
    source.map((row) => ({ ...row, models: [...row.models] }));
  const saved: Array<{ provider: string; model: string }> = [];
  let connections = copy(rows);
  let listFailure: unknown;
  // The current default starts on the connection the service marked, on the
  // first of its models — the same pair `current()` reports for a fresh setup.
  const initial = connections.find((row) => row.isDefault) ?? connections[0];
  let current =
    initial === undefined
      ? { provider: "", model: "" }
      : { provider: initial.routeId, model: initial.models[0] ?? "" };

  return {
    saved,
    async list(): Promise<ModelConnectionRow[]> {
      if (listFailure !== undefined) throw listFailure;
      return copy(connections);
    },
    current: (): { provider: string; model: string } => ({ ...current }),
    async saveDefault(provider: string, model: string): Promise<{ provider: string; model: string }> {
      saved.push({ provider, model });
      current = { provider, model };
      connections = connections.map((row) => ({ ...row, isDefault: row.routeId === provider }));
      return { provider, model };
    },
    failList: (error: unknown): void => {
      listFailure = error;
    }
  };
}

interface Harness {
  machine: ChatMachine;
  bot: ReturnType<typeof makeBot>;
  workspaces: ReturnType<typeof makeWorkspaces>;
  runner: ReturnType<typeof makeRunner>;
  models: ModelsFake | undefined;
  activeChanges: Array<WorkspaceRef | undefined>;
  warns: string[];
}

function makeHarness(
  opts: {
    listPageSize?: number;
    filePageChars?: number;
    maxFileBytes?: number;
    models?: ModelsFake;
    progressIntervalMs?: number;
    failEdits?: number;
    failSends?: number;
  } = {}
): Harness {
  const bot = makeBot({
    ...(opts.failEdits === undefined ? {} : { failEdits: opts.failEdits }),
    ...(opts.failSends === undefined ? {} : { failSends: opts.failSends })
  });
  const workspaces = makeWorkspaces();
  const runner = makeRunner();
  const activeChanges: Array<WorkspaceRef | undefined> = [];
  const warns: string[] = [];
  const machine = createChatMachine({
    workspaces: workspaces.service,
    runner: runner.service,
    bot: bot.bot,
    maxFileBytes: opts.maxFileBytes ?? MAX_FILE_BYTES,
    listPageSize: opts.listPageSize ?? 8,
    filePageChars: opts.filePageChars ?? 3000,
    ...(opts.progressIntervalMs === undefined ? {} : { progressIntervalMs: opts.progressIntervalMs }),
    ...(opts.models === undefined ? {} : { models: opts.models }),
    onActiveChange: (ref) => {
      activeChanges.push(ref);
    },
    logger: {
      warn: (message) => {
        warns.push(message);
      }
    }
  });
  return { machine, bot, workspaces, runner, models: opts.models, activeChanges, warns };
}

let messageIdSeed = 500;

function message(text: string, messageId = messageIdSeed++): ClassifiedUpdate & { kind: "message" } {
  return { kind: "message", messageId, chatId: CHAT, text };
}

function callback(
  data: string,
  messageId: number,
  callbackQueryId = `cb-${messageId}-${data}`,
  chatId = CHAT
): ClassifiedUpdate & { kind: "callback" } {
  return { kind: "callback", callbackQueryId, messageId, chatId, data };
}

/** Let the detached task pipeline (runner promise continuations) drain. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * The same drain under fake timers, where `setImmediate` is faked too and
 * {@link settle} would hang forever: yielding the microtask queue repeatedly is
 * enough for every continuation of the detached pipeline to run (the fakes
 * never wait on a real timer), so no test needs to sleep.
 */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

const HOME: WorkspaceRef = { scope: "home" };

function project(name: string): WorkspaceRef {
  return { scope: "project", name };
}

describe("chat machine: root menu and workspace list", () => {
  it("/start sends the menu card with the no-workspace actions", async () => {
    const h = makeHarness();

    await h.machine.onMessage(message("/start"));

    expect(h.bot.sent).toHaveLength(1);
    expect(h.bot.sent[0]!.chatId).toBe(CHAT);
    expect(h.bot.sent[0]!.text).toContain("Воркспейс не выбран");
    expect(h.bot.sent[0]!.text).toContain("Задача: нет активной задачи");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
    expect(h.bot.buttonByData(h.bot.sent[0]!.markup, "ws")!.text).toBe("📁 Воркспейсы");
  });

  it("the mnu callback re-renders the card into the pressed message", async () => {
    const h = makeHarness();
    const id = 700;

    await h.machine.onCallback(callback("mnu", id));

    expect(h.bot.sent).toHaveLength(0);
    expect(h.bot.lastEdit().messageId).toBe(id);
    expect(h.bot.lastEdit().text).toContain("🤖 Агент сервера");
    expect(h.bot.lastEdit().text).toContain("Воркспейс не выбран");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
    expect(h.bot.answers).toEqual([{ id: `cb-${id}-mnu`, text: undefined }]);
  });

  it("the ws callback renders the workspace list as an edit with home first", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha", "bravo");

    await h.machine.onCallback(callback("ws", 710));

    expect(h.bot.lastEdit().messageId).toBe(710);
    expect(h.bot.lastEdit().text).toContain("Выберите воркспейс");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws:pick:0", "ws:pick:1", "ws:pick:2"]);
    expect(h.bot.buttons(h.bot.lastEdit().markup).map((button) => button.text)).toEqual([
      "Дом агента",
      "Проект: alpha",
      "Проект: bravo"
    ]);
  });

  it("paginates a long workspace list and clamps an out-of-range page", async () => {
    const h = makeHarness({ listPageSize: 4 });
    for (let i = 0; i < 5; i++) h.workspaces.projects.push(`p${i}`);

    await h.machine.onCallback(callback("ws", 720));
    // page 0: home + p0..p2 (4 rows) + arrows
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual([
      "ws:pick:0",
      "ws:pick:1",
      "ws:pick:2",
      "ws:pick:3",
      "ws:pg:0",
      "ws:pg:1"
    ]);
    expect(h.bot.lastEdit().text).toContain("Страница 1/2");

    await h.machine.onCallback(callback("ws:pg:1", 720));
    expect(h.bot.lastEdit().messageId).toBe(720);
    expect(h.bot.lastEdit().text).toContain("Страница 2/2");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws:pick:4", "ws:pick:5", "ws:pg:0", "ws:pg:1"]);

    const editsBefore = h.bot.edits.length;
    await h.machine.onCallback(callback("ws:pg:9", 720));
    expect(h.bot.edits.length).toBe(editsBefore + 1);
    expect(h.bot.lastEdit().messageId).toBe(720);
    expect(h.bot.lastEdit().text).toContain("Страница 2/2");
  });

  it("a one-page list carries no pagination arrows", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha");

    await h.machine.onCallback(callback("ws", 730));

    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws:pick:0", "ws:pick:1"]);
    expect(h.bot.lastEdit().text).not.toContain("Страница");
  });

  it("a text message «Воркспейсы» renders the list as a new message", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha");

    await h.machine.onMessage(message("Воркспейсы"));

    expect(h.bot.sent).toHaveLength(1);
    expect(h.bot.sent[0]!.text).toContain("Выберите воркспейс");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["ws:pick:0", "ws:pick:1"]);
  });

  it("a list rendered from a text alias is immediately usable (no false stale toast)", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha");

    await h.machine.onMessage(message("Воркспейсы"));
    const listId = h.bot.sent.at(-1)!.messageId;

    await h.machine.onCallback(callback("ws:pick:1", listId));

    expect(h.machine.activeWorkspace()).toEqual(project("alpha"));
    expect(h.bot.sent.at(-1)!.text).toBe("Выбран: Проект: alpha");
    expect(h.bot.answers).toEqual([{ id: `cb-${listId}-ws:pick:1`, text: undefined }]);
    expect(h.bot.editTexts()).toHaveLength(0);
  });

  it("a known command answers from the router instead of running a task", async () => {
    const h = makeHarness();

    await h.machine.onMessage(message("/help"));

    expect(h.bot.texts()).toHaveLength(1);
    expect(h.bot.texts()[0]).toContain("/stop — остановить задачу (контекст сохраняется)");
    expect(h.runner.runs).toHaveLength(0);
  });

  it("a failing list() answers with a safe retry text and no stack", async () => {
    const h = makeHarness();
    h.workspaces.failList(new Error("EACCES: permission denied, open '/dsh/projects.json'"));

    await h.machine.onCallback(callback("ws", 740));

    const text = h.bot.lastEdit().text;
    expect(text).toContain("Не удалось получить список воркспейсов");
    expect(text).not.toContain("EACCES");
    expect(text).not.toContain("/dsh");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).not.toContain("permission denied");
  });
});

describe("chat machine: picking a workspace", () => {
  it("picks agent home and persists the active workspace", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha");
    await h.machine.onCallback(callback("ws", 750));

    await h.machine.onCallback(callback("ws:pick:0", 750));

    expect(h.machine.activeWorkspace()).toEqual(HOME);
    expect(h.activeChanges).toEqual([HOME]);
    const selected = h.bot.sent.at(-1)!;
    expect(selected.text).toBe("Выбран: Дом агента");
    expect(h.bot.data(selected.markup)).toEqual(["act:files", "mdl", "ws", "act:reset", "stp", "mnu:refresh"]);
    expect(h.bot.buttons(selected.markup).map((button) => button.text)).toEqual([
      "📄 Файлы",
      "🧠 Модель",
      "📁 Воркспейс",
      "🔄 Сбросить контекст",
      "⏹ Стоп",
      "🔄 Обновить"
    ]);
  });

  it("picks a project by the index of the last rendered list", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha", "bravo");
    await h.machine.onCallback(callback("ws", 760));

    await h.machine.onCallback(callback("ws:pick:2", 760));

    expect(h.machine.activeWorkspace()).toEqual(project("bravo"));
    expect(h.activeChanges).toEqual([project("bravo")]);
    expect(h.bot.sent.at(-1)!.text).toBe("Выбран: Проект: bravo");
  });

  it("answers «Список устарел» and re-renders when the index is out of range", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha");
    await h.machine.onCallback(callback("ws", 770));

    await h.machine.onCallback(callback("ws:pick:9", 770));

    expect(h.bot.answers.at(-1)).toEqual({ id: "cb-770-ws:pick:9", text: "Список устарел, откройте заново" });
    expect(h.machine.activeWorkspace()).toBeUndefined();
    expect(h.activeChanges).toEqual([]);
    expect(h.bot.sent).toHaveLength(0);
    expect(h.bot.lastEdit().text).toContain("Выберите воркспейс");
  });

  it("does not activate a project deleted after the list was rendered", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha", "bravo");
    await h.machine.onCallback(callback("ws", 780));
    h.workspaces.projects.length = 0;

    await h.machine.onCallback(callback("ws:pick:1", 780));

    expect(h.bot.answers.at(-1)).toEqual({ id: "cb-780-ws:pick:1", text: "Список устарел, откройте заново" });
    expect(h.machine.activeWorkspace()).toBeUndefined();
    expect(h.activeChanges).toEqual([]);
    expect(h.bot.lastEdit().text).toContain("Выберите воркспейс");
  });

  it("treats a pick on a message with no snapshot as stale and re-renders the list", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha");

    await h.machine.onCallback(callback("ws:pick:1", 790));

    expect(h.bot.answers.at(-1)).toEqual({ id: "cb-790-ws:pick:1", text: "Список устарел, откройте заново" });
    expect(h.machine.activeWorkspace()).toBeUndefined();
    // the re-render registers a snapshot, so a second press works
    expect(h.bot.lastEdit().messageId).toBe(790);
    await h.machine.onCallback(callback("ws:pick:1", 790));
    expect(h.machine.activeWorkspace()).toEqual(project("alpha"));
  });

  it("evicts the least recently USED snapshot, so a pressed listing survives the next overflow", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha");
    // 1) the listing the owner will keep pressing
    const keep = 800;
    await h.machine.onCallback(callback("ws", keep));
    // 2) fill the bound (64 remembered snapshots) with newer listings
    for (let i = 1; i < 64; i++) await h.machine.onCallback(callback("ws", keep + i));
    // 3) press the oldest listing: resolving it must refresh its recency
    await h.machine.onCallback(callback("ws:pick:1", keep));
    expect(h.machine.activeWorkspace()).toEqual(project("alpha"));
    // 4) one more render overflows the bound and evicts the true LRU entry
    await h.machine.onCallback(callback("ws", 900));
    // 5) the pressed listing is still pressable. Without the recency refresh it
    //    would still have been the oldest entry, and step 4 would have dropped it.
    await h.machine.onCallback(callback("ws:pick:0", keep));
    expect(h.machine.activeWorkspace()).toEqual(HOME);
    expect(h.bot.answers.at(-1)!.text ?? "").not.toContain("устарел");
  });

  it("keeps the active workspace across a boot restore without persisting it again", () => {
    const h = makeHarness();

    h.machine.setActiveWorkspace(project("alpha"));

    expect(h.machine.activeWorkspace()).toEqual(project("alpha"));
    expect(h.activeChanges).toEqual([]);
    // the returned ref is a copy: mutating it cannot corrupt the machine state
    const ref = h.machine.activeWorkspace() as { scope: "project"; name: string };
    ref.name = "tampered";
    expect(h.machine.activeWorkspace()).toEqual(project("alpha"));

    h.machine.setActiveWorkspace(undefined);
    expect(h.machine.activeWorkspace()).toBeUndefined();
  });
});

describe("chat machine: tasks", () => {
  function withActive(h: Harness): void {
    h.machine.setActiveWorkspace(HOME);
  }

  it("hints at workspace selection when no workspace is active", async () => {
    const h = makeHarness();

    await h.machine.onMessage(message("сделай отчёт"));

    expect(h.bot.sent).toHaveLength(1);
    expect(h.bot.sent[0]!.text).toContain("Воркспейс не выбран");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
    expect(h.runner.runs).toHaveLength(0);
    await settle();
  });

  it("does not start a task for a blank message", async () => {
    const h = makeHarness();
    withActive(h);

    await h.machine.onMessage(message("   "));
    await settle();

    expect(h.runner.runs).toHaveLength(0);
    expect(h.bot.sent[0]!.text).toContain("Воркспейс: Дом агента");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["act:files", "mdl", "ws", "act:reset", "stp", "mnu:refresh"]);
  });

  it("accepts the task, then sends the agent reply", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({ ok: true, text: "готово: 3 файла", sessionId: "session-1" });

    await h.machine.onMessage(message("посчитай файлы"));
    await settle();

    expect(h.runner.runs).toEqual([{ ref: HOME, text: "посчитай файлы" }]);
    expect(h.bot.texts()).toEqual(["⏳ Дом агента · 0:00", "готово: 3 файла"]);
    expect(h.bot.sent[0]!.chatId).toBe(CHAT);
    expect(h.bot.lastEdit().text).toContain("✅ Готово");
  });

  it("sends the task card before the run settles", async () => {
    const h = makeHarness();
    withActive(h);
    const gate = h.runner.hold();

    await h.machine.onMessage(message("долгая задача"));

    expect(h.bot.texts()).toEqual(["⏳ Дом агента · 0:00"]);
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["stp", "mnu"]);
    expect(gate.settled()).toBe(false);

    gate.release({ ok: true, text: "готово", sessionId: "session-1" });
    await settle();
    expect(h.bot.texts()).toEqual(["⏳ Дом агента · 0:00", "готово"]);
  });

  it("splits a long agent reply into one message per chunk", async () => {
    const h = makeHarness();
    withActive(h);
    const line = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX"; // 60 chars
    const reply = Array.from({ length: 100 }, () => line).join("\n"); // 6099 chars
    h.runner.setResult({ ok: true, text: reply, sessionId: "session-1" });

    await h.machine.onMessage(message("длинная задача"));
    await settle();

    const chunks = h.bot.texts().slice(1);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join("")).toBe(reply);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
  });

  it("sanitizes the agent reply (NUL removed, CRLF normalized) before sending", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({ ok: true, text: "a\u0000b\r\nc", sessionId: "session-1" });

    await h.machine.onMessage(message("задача"));
    await settle();

    expect(h.bot.texts()).toEqual(["⏳ Дом агента · 0:00", "ab\nc"]);
  });

  it("reports a safe text when the agent returns an empty reply", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({ ok: true, text: "", sessionId: "session-1" });

    await h.machine.onMessage(message("пустая задача"));
    await settle();

    expect(h.bot.texts()[1]).toContain("пустой ответ");
  });

  it("reports queue-full with the waiting-limit copy", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({ ok: false, code: "queue-full", message: "the workspace task queue is full" });

    await h.machine.onMessage(message("четвёртая задача"));
    await settle();

    expect(h.bot.texts()).toEqual([
      "⏳ Дом агента · 0:00",
      "В этом воркспейсе уже 3 задачи в очереди — дождитесь завершения"
    ]);
    // Refused before it ran: the card stops claiming a task is on its way.
    expect(h.bot.lastEdit().text).toBe("✅ Готово · 0:00 · 0 шагов");
    expect(h.machine.activeWorkspace()).toEqual(HOME);
  });

  it("reports busy with the already-running copy", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({ ok: false, code: "busy", message: "a task for this workspace is already running" });

    await h.machine.onMessage(message("дубль"));
    await settle();

    expect(h.bot.texts()).toEqual(["⏳ Дом агента · 0:00", "Задача уже выполняется…"]);
    expect(h.bot.lastEdit().text).toBe("✅ Готово · 0:00 · 0 шагов");
    expect(h.machine.activeWorkspace()).toEqual(HOME);
  });

  it("clears the active workspace when it is gone and offers the list again", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({ ok: false, code: "workspace-gone", message: "not-found: project deleted" });

    await h.machine.onMessage(message("задача в удалённом"));
    await settle();

    expect(h.machine.activeWorkspace()).toBeUndefined();
    expect(h.activeChanges).toEqual([undefined]);
    expect(h.bot.texts()[1]).toBe("Воркспейс удалён — выберите другой");
    expect(h.bot.data(h.bot.sent[1]!.markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
    expect(h.bot.texts()[1]).not.toContain("not-found");
    expect(h.bot.lastEdit().text).toBe("⚠️ Ошибка · 0:00: воркспейс удалён");
  });

  it("does not clear a newer active workspace when a stale task reports workspace-gone", async () => {
    const h = makeHarness();
    withActive(h);
    const gate = h.runner.hold();
    await h.machine.onMessage(message("задача в доме"));
    // the owner switches while the detached task is still in flight
    h.machine.setActiveWorkspace(project("alpha"));

    gate.release({ ok: false, code: "workspace-gone", message: "not-found: project deleted" });
    await settle();

    expect(h.machine.activeWorkspace()).toEqual(project("alpha"));
    expect(h.activeChanges).toEqual([]);
    expect(h.bot.texts()).toEqual(["⏳ Дом агента · 0:00", "Воркспейс удалён — выберите другой"]);
  });

  it("reports the agent failure with its safe phrase", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({ ok: false, code: "agent-error", message: "llm request timed out" });

    await h.machine.onMessage(message("задача"));
    await settle();

    expect(h.bot.texts()[1]).toBe("Агент не смог выполнить задачу: llm request timed out");
  });

  it("keeps only the first line of an agent failure (no stack trace)", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({
      ok: false,
      code: "agent-error",
      message: "boom\n    at Object.run (/dsh/packages/bundles/dsh-balbes-host/lib/runner.js:12:5)"
    });

    await h.machine.onMessage(message("задача"));
    await settle();

    expect(h.bot.texts()[1]).toBe("Агент не смог выполнить задачу: boom");
    expect(h.bot.texts()[1]).not.toContain("runner.js");
  });

  it("maps a reset-abort agent failure to the reset copy instead of an agent failure", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({
      ok: false,
      code: "agent-error",
      message: "task aborted because the workspace context was reset"
    });

    await h.machine.onMessage(message("задача"));
    await settle();

    const text = h.bot.texts()[1]!;
    expect(text).toContain("контекст воркспейса был сброшен");
    expect(text).not.toContain("Агент не смог");
    expect(h.machine.activeWorkspace()).toEqual(HOME);
  });

  it("maps a reset-dropped queued task to the same reset copy", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({
      ok: false,
      code: "agent-error",
      message: "task dropped because the workspace context was reset"
    });

    await h.machine.onMessage(message("задача"));
    await settle();

    expect(h.bot.texts()[1]).toContain("контекст воркспейса был сброшен");
    expect(h.machine.activeWorkspace()).toEqual(HOME);
  });

  it("still reports a rejected run() promise as a safe agent failure", async () => {
    const h = makeHarness();
    withActive(h);
    const failing: AgentTaskRunner = {
      ...h.runner.service,
      async run() {
        throw new Error("socket hang up");
      }
    };
    const bot = makeBot();
    const machine = createChatMachine({
      workspaces: h.workspaces.service,
      runner: failing,
      bot: bot.bot,
      maxFileBytes: MAX_FILE_BYTES,
      onActiveChange: () => {},
      logger: { warn: () => {} }
    });
    machine.setActiveWorkspace(HOME);

    await machine.onMessage(message("задача"));
    await settle();

    expect(bot.texts()[1]).toContain("Агент не смог выполнить задачу");
    expect(bot.texts()[1]).not.toContain("socket hang up\n");
  });
});

describe("chat machine: progress card", () => {
  /** The card an accepted task in the agent home gets before anything ran. */
  const HOME_CARD = "⏳ Дом агента · 0:00";

  function withActive(h: Harness): void {
    h.machine.setActiveWorkspace(HOME);
  }

  /** How many edits one card message received. */
  function editsOf(h: Harness, messageId: number): number {
    return h.bot.edits.filter((edit) => edit.messageId === messageId).length;
  }

  it("replaces «Задача принята…» with a progress card carrying the stop button", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.hold();

    await h.machine.onMessage(message("починить парсер"));

    expect(h.bot.sent).toHaveLength(1);
    expect(h.bot.sent[0]!.text).toBe(HOME_CARD);
    expect(h.bot.texts()).not.toContain("Задача принята…");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["stp", "mnu"]);
  });

  it("marks a task accepted while another runs as queued", async () => {
    const h = makeHarness();
    withActive(h);
    const gate = h.runner.hold();
    h.runner.progress.mockReturnValue({ phase: "running", taskText: "первая", startedAt: Date.now(), steps: [], queued: 1 });

    await h.machine.onMessage(message("первая"));
    await h.machine.onMessage(message("вторая"));

    // The shipped queue card states the workspace and the place in the queue.
    expect(h.bot.sent.at(-1)!.text).toBe("🕓 Дом агента · в очереди №2\n\nвторая");
    expect(h.bot.data(h.bot.sent.at(-1)!.markup)).toEqual(["stp", "mnu"]);
    // Both detached runs settle on the same gate: neither card keeps its timer.
    h.runner.progress.mockReturnValue({ phase: "idle", steps: [], queued: 0 });
    gate.release({ ok: true, text: "готово", sessionId: "s-1" });
    await settle();
  });

  it("turns a queued card live only when its own task starts", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ progressIntervalMs: 3500 });
      withActive(h);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("первая"));
      // «Первая» уже в работе, поэтому «вторая» встаёт в очередь.
      h.runner.progress.mockReturnValue({ phase: "running", taskText: "первая", startedAt: Date.now(), steps: [], queued: 1 });
      await h.machine.onMessage(message("вторая"));
      const firstCard = h.bot.sent[0]!.messageId;
      const secondCard = h.bot.sent[1]!.messageId;
      expect(h.bot.sent[1]!.text).toContain("🕓");

      // Ход всё ещё у чужой задачи: карточка очереди не трогается.
      await vi.advanceTimersByTimeAsync(3500);
      expect(editsOf(h, firstCard)).toBe(1);
      expect(editsOf(h, secondCard)).toBe(0);
      expect(h.bot.sent[1]!.text).toContain("🕓");

      // Ход дошёл до «второй»: её карточка сама становится живой, чужая — нет.
      h.runner.progress.mockReturnValue({
        phase: "running",
        taskText: "вторая",
        startedAt: Date.now(),
        steps: [{ name: "read", status: "running" }],
        queued: 0
      });
      const firstCardEdits = editsOf(h, firstCard);
      await vi.advanceTimersByTimeAsync(3500);

      expect(editsOf(h, secondCard)).toBe(1);
      expect(editsOf(h, firstCard)).toBe(firstCardEdits);
      expect(h.bot.lastEdit().messageId).toBe(secondCard);
      expect(h.bot.lastEdit().text).toContain("⏳ Дом агента");
      expect(h.bot.lastEdit().text).toContain("🔧 read");
      expect(h.bot.lastEdit().text).not.toContain("🕓");

      h.runner.progress.mockReturnValue({ phase: "idle", steps: [], queued: 0 });
      gate.release({ ok: true, text: "готово", sessionId: "s-1" });
      await drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("edits the card while the task runs and turns it into a receipt when it finishes", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ progressIntervalMs: 3500 });
      withActive(h);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("починить парсер"));
      const cardId = h.bot.sent[0]!.messageId;

      h.runner.progress.mockReturnValue({
        phase: "running",
        taskText: "починить парсер",
        startedAt: Date.now() - 72_000,
        step: 4,
        steps: [{ name: "read", target: "notes.txt", status: "ok" }],
        todos: [{ content: "Разобрать логи", status: "completed" }],
        queued: 0
      });
      await vi.advanceTimersByTimeAsync(3500);

      expect(h.bot.lastEdit().messageId).toBe(cardId);
      expect(h.bot.lastEdit().text).toContain("⏳ Дом агента · 0:03 · шаг 4");
      expect(h.bot.lastEdit().text).toContain("☑ Разобрать логи");
      expect(h.bot.lastEdit().text).toContain("🔧 read notes.txt ✔");

      gate.release({ ok: true, text: "готово", sessionId: "s-1" });
      await drain();

      expect(h.bot.lastEdit().messageId).toBe(cardId);
      expect(h.bot.lastEdit().text).toContain("✅ Готово");
      expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["mnu"]);
      // The answer itself stays a separate message, never part of the card.
      expect(h.bot.sent.at(-1)!.text).toBe("готово");
      expect(h.bot.lastEdit().text).not.toContain("готово");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never re-edits the card with a text it already shows", async () => {
    vi.useFakeTimers();
    try {
      // Тик короче секунды: два рендера попадают в одну показанную секунду и
      // совпадают, поэтому второй в Telegram не уходит.
      const h = makeHarness({ progressIntervalMs: 300 });
      withActive(h);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("долгая"));
      h.runner.progress.mockReturnValue({
        phase: "running",
        taskText: "долгая",
        startedAt: Date.now(),
        steps: [{ name: "read", status: "running" }],
        queued: 0
      });

      await vi.advanceTimersByTimeAsync(300);
      expect(h.bot.edits).toHaveLength(1);
      expect(h.bot.lastEdit().text).toContain("⏳ Дом агента · 0:00");

      await vi.advanceTimersByTimeAsync(300);
      expect(h.bot.edits).toHaveLength(1);

      gate.release({ ok: true, text: "готово", sessionId: "s-1" });
      await drain();
      expect(h.bot.lastEdit().text).toContain("✅ Готово");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops editing the card once the receipt is stamped", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ progressIntervalMs: 3500 });
      withActive(h);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("долгая"));
      const cardId = h.bot.sent[0]!.messageId;
      // The runner keeps reporting this task as running (a lie the real one
      // never tells after a settle): only stopping the timer keeps the receipt.
      h.runner.progress.mockReturnValue({
        phase: "running",
        taskText: "долгая",
        startedAt: Date.now(),
        steps: [{ name: "read", status: "running" }],
        queued: 0
      });

      await vi.advanceTimersByTimeAsync(3500);
      expect(editsOf(h, cardId)).toBe(1);

      gate.release({ ok: true, text: "готово", sessionId: "s-1" });
      await drain();
      const afterReceipt = h.bot.edits.length;
      expect(h.bot.lastEdit().text).toContain("✅ Готово");

      await vi.advanceTimersByTimeAsync(3500 * 3);

      expect(h.bot.edits).toHaveLength(afterReceipt);
      expect(h.bot.lastEdit().text).toContain("✅ Готово");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps a receipt for a stopped task and never reports it as an agent failure", async () => {
    const h = makeHarness();
    withActive(h);
    const gate = h.runner.hold();
    await h.machine.onMessage(message("долгая"));

    gate.release({ ok: false, code: "cancelled", message: "task cancelled by the owner" });
    await settle();

    expect(h.bot.lastEdit().text).toBe("⏹ Остановлено владельцем · 0:00");
    expect(h.bot.texts()).toEqual([HOME_CARD]);
    expect(h.bot.texts().some((text) => text.includes("Агент не смог выполнить задачу"))).toBe(false);
  });

  it("stamps the reset receipt when the context reset aborted the task", async () => {
    const h = makeHarness();
    withActive(h);
    const gate = h.runner.hold();
    await h.machine.onMessage(message("долгая"));

    gate.release({
      ok: false,
      code: "agent-error",
      message: "task aborted because the workspace context was reset"
    });
    await settle();

    expect(h.bot.lastEdit().text).toBe("⏹ Остановлено сбросом контекста");
    expect(h.bot.texts().at(-1)).toContain("контекст воркспейса был сброшен");
  });

  it("stamps an error receipt naming the safe phrase, never the raw failure", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({
      ok: false,
      code: "agent-error",
      message: "llm request timed out\n    at Object.run (/dsh/packages/host/lib/runner.js:12:5)"
    });

    await h.machine.onMessage(message("задача"));
    await settle();

    expect(h.bot.lastEdit().text).toBe("⚠️ Ошибка · 0:00: llm request timed out");
    expect(h.bot.lastEdit().text).not.toContain("runner.js");
  });

  it("stops updating the card after three failed edits but keeps the task running", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ progressIntervalMs: 3500, failEdits: 3 });
      withActive(h);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("долгая"));
      h.runner.progress.mockReturnValue({
        phase: "running", taskText: "долгая", startedAt: Date.now(), steps: [{ name: "read", status: "running" }], queued: 0
      });

      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(3500);

      expect(h.bot.edits).toHaveLength(3);
      expect(h.warns.filter((line) => line.includes("progress card edit failed"))).toHaveLength(3);

      gate.release({ ok: true, text: "готово", sessionId: "s-1" });
      await drain();
      expect(h.runner.runs).toEqual([{ ref: HOME, text: "долгая" }]);
      expect(h.bot.sent.at(-1)!.text).toBe("готово");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a long echoed task text inside the Telegram limit", async () => {
    const h = makeHarness();
    withActive(h);
    const gate = h.runner.hold();
    // Another task holds the workspace, so the card repeats the owner's text.
    h.runner.progress.mockReturnValue({ phase: "running", taskText: "первая", startedAt: Date.now(), steps: [], queued: 0 });

    await h.machine.onMessage(message("я".repeat(5000)));

    const card = h.bot.sent.at(-1)!;
    expect(card.text).toContain("🕓 Дом агента · в очереди №1");
    expect(card.text).toContain("…");
    expect(card.text.length).toBeLessThanOrEqual(4096);

    h.runner.progress.mockReturnValue({ phase: "idle", steps: [], queued: 0 });
    gate.release({ ok: true, text: "готово", sessionId: "s-1" });
    await settle();
  });

  it("runs the task and edits nothing when its card could not be sent", async () => {
    // Only the card's own send is refused: the answer still reaches the owner.
    const h = makeHarness({ failSends: 1 });
    withActive(h);
    h.runner.setResult({ ok: true, text: "готово", sessionId: "s-1" });

    await h.machine.onMessage(message("задача"));
    await settle();

    expect(h.runner.runs).toEqual([{ ref: HOME, text: "задача" }]);
    expect(h.bot.texts()).toEqual(["готово"]);
    // Nothing was sent for this task, so there is no card message to edit.
    expect(h.bot.edits).toHaveLength(0);
    expect(h.warns.some((line) => line.includes("sendMessage failed"))).toBe(true);
  });
});

describe("chat machine: file tree", () => {
  function withActive(h: Harness): void {
    h.machine.setActiveWorkspace(HOME);
  }

  const ROOT_ENTRIES: WorkspaceTreeEntry[] = [
    { name: "src", kind: "dir" },
    { name: "notes.txt", kind: "file" },
    { name: "shortcut", kind: "link" }
  ];

  function prepareTree(h: Harness): void {
    withActive(h);
    h.workspaces.setDir("home", "", ROOT_ENTRIES);
    h.workspaces.setDir("home", "src", [{ name: "a.txt", kind: "file" }]);
    h.workspaces.setFile("home", "notes.txt", { kind: "text", content: "привет", truncated: false });
    h.workspaces.setFile("home", "src/a.txt", { kind: "text", content: "вложенный", truncated: false });
  }

  it("opens the workspace root on act:files with one button per entry", async () => {
    const h = makeHarness();
    prepareTree(h);

    await h.machine.onCallback(callback("act:files", 800));

    expect(h.workspaces.dirCalls).toEqual([{ scope: "home", name: undefined, relPath: "" }]);
    expect(h.bot.lastEdit().messageId).toBe(800);
    expect(h.bot.lastEdit().text).toContain("Файлы: Дом агента");
    expect(h.bot.buttons(h.bot.lastEdit().markup).map((button) => button.text)).toEqual([
      "📁 src",
      "📄 notes.txt",
      "🔗 shortcut (ссылка)"
    ]);
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["e:0", "e:1", "e:2"]);
    // no parent directory above the workspace root
    expect(h.bot.buttonByData(h.bot.lastEdit().markup, "up")).toBeUndefined();
  });

  it("opens a directory by index, then goes back up to the parent", async () => {
    const h = makeHarness();
    prepareTree(h);
    await h.machine.onCallback(callback("act:files", 810));

    await h.machine.onCallback(callback("e:0", 810));

    expect(h.workspaces.dirCalls.at(-1)).toEqual({ scope: "home", name: undefined, relPath: "src" });
    expect(h.bot.lastEdit().messageId).toBe(810);
    expect(h.bot.lastEdit().text).toContain("Дом агента / src");
    expect(h.bot.data(h.bot.lastEdit().markup)).toContain("up");

    await h.machine.onCallback(callback("up", 810));

    expect(h.workspaces.dirCalls.at(-1)).toEqual({ scope: "home", name: undefined, relPath: "" });
    expect(h.bot.lastEdit().text).toContain("Файлы: Дом агента");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["e:0", "e:1", "e:2"]);
  });

  it("opens a text file and pages it with «Дальше», re-reading it each time", async () => {
    const h = makeHarness({ filePageChars: 10 });
    prepareTree(h);
    h.workspaces.setFile("home", "notes.txt", { kind: "text", content: "0123456789abcdefghij", truncated: false });
    await h.machine.onCallback(callback("act:files", 820));

    await h.machine.onCallback(callback("e:1", 820));

    expect(h.workspaces.fileCalls).toEqual([{ scope: "home", name: undefined, relPath: "notes.txt" }]);
    expect(h.bot.lastEdit().messageId).toBe(820);
    const first = h.bot.lastEdit();
    expect(first.text).toContain("0123456789");
    expect(first.text).toContain("1/2");
    expect(h.bot.data(first.markup)).toEqual(["pg:1", "up"]);
    expect(h.bot.buttonByData(first.markup, "pg:1")!.text).toBe("Дальше");
    expect(h.bot.buttonByData(first.markup, "up")!.text).toBe("⬆ назад к списку");

    await h.machine.onCallback(callback("pg:1", 820));

    expect(h.workspaces.fileCalls).toHaveLength(2);
    const second = h.bot.lastEdit();
    expect(second.text).toContain("abcdefghij");
    expect(second.text).toContain("2/2");
    expect(h.bot.buttonByData(second.markup, "pg:1")).toBeUndefined();

    await h.machine.onCallback(callback("up", 820));

    expect(h.bot.lastEdit().text).toContain("Файлы: Дом агента");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["e:0", "e:1", "e:2"]);
  });

  it("shows a short file without a page header", async () => {
    const h = makeHarness({ filePageChars: 10 });
    prepareTree(h);
    await h.machine.onCallback(callback("act:files", 830));

    await h.machine.onCallback(callback("e:1", 830));

    expect(h.bot.lastEdit().text).toBe("привет");
    expect(h.bot.buttonByData(h.bot.lastEdit().markup, "pg:1")).toBeUndefined();
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["up"]);
  });

  it("reports a binary file with its size and never shows content", async () => {
    const h = makeHarness();
    prepareTree(h);
    h.workspaces.setFile("home", "notes.txt", { kind: "binary", size: 2048 });
    await h.machine.onCallback(callback("act:files", 840));

    await h.machine.onCallback(callback("e:1", 840));

    expect(h.bot.lastEdit().text).toBe("Это бинарный файл (2048 байт) — просмотр недоступен");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["up"]);
  });

  it("never reads a link entry and answers that it cannot be opened", async () => {
    const h = makeHarness();
    prepareTree(h);
    await h.machine.onCallback(callback("act:files", 850));
    const linkButton = h.bot.buttonByText(h.bot.lastEdit().markup, "🔗 shortcut (ссылка)")!;

    await h.machine.onCallback(callback(linkButton.callback_data!, 850));

    expect(h.workspaces.fileCalls).toHaveLength(0);
    expect(h.workspaces.dirCalls).toHaveLength(1);
    expect(h.bot.answers.at(-1)).toEqual({ id: "cb-850-e:2", text: "Это ссылка — просмотр недоступен" });
    expect(h.bot.edits).toHaveLength(1);
  });

  it("reports the metadata message when a file read reports a link", async () => {
    const h = makeHarness();
    prepareTree(h);
    h.workspaces.setFile("home", "src/a.txt", { kind: "link" });
    await h.machine.onCallback(callback("act:files", 855));
    await h.machine.onCallback(callback("e:0", 855));

    await h.machine.onCallback(callback("e:0", 855));

    expect(h.workspaces.fileCalls).toEqual([{ scope: "home", name: undefined, relPath: "src/a.txt" }]);
    expect(h.bot.lastEdit().text).toBe("Это ссылка — просмотр недоступен");
  });

  it("reports an unexpected read error (EISDIR) with a safe text and no stack", async () => {
    const h = makeHarness();
    prepareTree(h);
    h.workspaces.failFile("home", "notes.txt", workspaceError("EISDIR", "EISDIR: illegal operation on a directory, read"));
    await h.machine.onCallback(callback("act:files", 860));

    await h.machine.onCallback(callback("e:1", 860));

    const text = h.bot.lastEdit().text;
    expect(text).toContain("Не удалось открыть");
    expect(text).not.toContain("EISDIR");
    expect(text).not.toContain("illegal operation");
    expect(h.warns).toHaveLength(1);
  });

  it("falls back to the parent listing when a directory disappeared", async () => {
    const h = makeHarness();
    prepareTree(h);
    await h.machine.onCallback(callback("act:files", 870));
    h.workspaces.failDir("home", "src", workspaceError("not-found", "directory not found: src"));

    await h.machine.onCallback(callback("e:0", 870));

    expect(h.workspaces.dirCalls.at(-1)).toEqual({ scope: "home", name: undefined, relPath: "" });
    expect(h.bot.lastEdit().text).toContain("Файлы: Дом агента");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["e:0", "e:1", "e:2"]);
    expect(h.warns).toHaveLength(1);
  });

  it("falls back to the root listing when a parent directory is gone too", async () => {
    const h = makeHarness();
    prepareTree(h);
    h.workspaces.setDir("home", "src", [{ name: "deep", kind: "dir" }]);
    h.workspaces.setDir("home", "src/deep", [{ name: "a.txt", kind: "file" }]);
    await h.machine.onCallback(callback("act:files", 880));
    await h.machine.onCallback(callback("e:0", 880));
    await h.machine.onCallback(callback("e:0", 880)); // now inside src/deep
    expect(h.bot.lastEdit().text).toContain("Дом агента / src/deep");
    h.workspaces.failDir("home", "src/deep", workspaceError("not-found", "directory not found: src/deep"));
    h.workspaces.failDir("home", "src", workspaceError("not-found", "directory not found: src"));

    await h.machine.onCallback(callback("up", 880));

    expect(h.workspaces.dirCalls.at(-1)).toEqual({ scope: "home", name: undefined, relPath: "" });
    expect(h.bot.lastEdit().text).toContain("Файлы: Дом агента");
  });

  it("pages a long directory listing with pg:<n>", async () => {
    const h = makeHarness({ listPageSize: 2 });
    withActive(h);
    h.workspaces.setDir("home", "", [
      { name: "a", kind: "file" },
      { name: "b", kind: "file" },
      { name: "c", kind: "file" }
    ]);
    h.workspaces.setFile("home", "a", { kind: "text", content: "a", truncated: false });
    h.workspaces.setFile("home", "b", { kind: "text", content: "b", truncated: false });
    h.workspaces.setFile("home", "c", { kind: "text", content: "c", truncated: false });

    await h.machine.onCallback(callback("act:files", 890));
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["e:0", "e:1", "pg:0", "pg:1"]);

    await h.machine.onCallback(callback("pg:1", 890));

    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["e:2", "pg:0", "pg:1"]);
    expect(h.bot.lastEdit().text).toContain("Страница 2/2");
  });

  it("shows a note page when the file was truncated at the read limit", async () => {
    const h = makeHarness({ filePageChars: 10 });
    prepareTree(h);
    h.workspaces.setFile("home", "notes.txt", { kind: "text", content: "0123456789", truncated: true });
    await h.machine.onCallback(callback("act:files", 900));

    await h.machine.onCallback(callback("e:1", 900));

    expect(h.bot.lastEdit().text).toContain("0123456789");
    expect(h.bot.buttonByData(h.bot.lastEdit().markup, "pg:1")).toBeDefined();

    await h.machine.onCallback(callback("pg:1", 900));

    expect(h.bot.lastEdit().text).toContain("не полностью");
    expect(h.bot.buttonByData(h.bot.lastEdit().markup, "pg:1")).toBeUndefined();
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["up"]);
  });

  it("never sends an empty message for an empty file", async () => {
    const h = makeHarness();
    prepareTree(h);
    h.workspaces.setFile("home", "notes.txt", { kind: "text", content: "", truncated: false });
    await h.machine.onCallback(callback("act:files", 910));

    await h.machine.onCallback(callback("e:1", 910));

    expect(h.bot.lastEdit().text.trim()).not.toBe("");
  });

  it("cuts the display at the configured maxFileBytes ceiling", async () => {
    const h = makeHarness({ maxFileBytes: 10 });
    prepareTree(h);
    h.workspaces.setFile("home", "notes.txt", {
      kind: "text",
      content: "0123456789abcdefghij",
      truncated: false
    });
    await h.machine.onCallback(callback("act:files", 915));

    await h.machine.onCallback(callback("e:1", 915));

    expect(h.bot.lastEdit().text).toContain("0123456789");
    expect(h.bot.lastEdit().text).not.toContain("abcdefghij");
    expect(h.bot.buttonByData(h.bot.lastEdit().markup, "pg:1")).toBeDefined();

    await h.machine.onCallback(callback("pg:1", 915));

    expect(h.bot.lastEdit().text).toContain("не полностью");
    expect(h.bot.lastEdit().text).not.toContain("abcdefghij");
  });

  it("hints at workspace selection when act:files arrives with no active workspace", async () => {
    const h = makeHarness();

    await h.machine.onCallback(callback("act:files", 920));

    expect(h.bot.lastEdit().text).toContain("Воркспейс не выбран");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
    expect(h.workspaces.dirCalls).toHaveLength(0);
  });

  it("reports a safe text when even the workspace root is unreadable", async () => {
    const h = makeHarness();
    withActive(h);
    h.workspaces.failDir("home", "", workspaceError("invalid-path", "path escapes the workspace root: /etc"));

    await h.machine.onCallback(callback("act:files", 930));

    const text = h.bot.lastEdit().text;
    expect(text).toContain("Не удалось открыть");
    expect(text).not.toContain("/etc");
    expect(text).not.toContain("escapes");
  });
});

describe("chat machine: context reset", () => {
  function withActive(h: Harness): void {
    h.machine.setActiveWorkspace(HOME);
  }

  it("asks for confirmation and resets on reset:yes", async () => {
    const h = makeHarness();
    withActive(h);

    await h.machine.onCallback(callback("act:reset", 950));

    expect(h.bot.lastEdit().messageId).toBe(950);
    expect(h.bot.lastEdit().text).toContain("Сбросить контекст");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["reset:yes", "reset:no"]);

    await h.machine.onCallback(callback("reset:yes", 950));

    expect(h.runner.resets).toEqual([HOME]);
    expect(h.bot.lastEdit().text).toBe("Контекст сессии сброшен");
    expect(h.machine.activeWorkspace()).toEqual(HOME);
  });

  it("cancels the reset on reset:no without touching the runner", async () => {
    const h = makeHarness();
    withActive(h);
    await h.machine.onCallback(callback("act:reset", 960));

    await h.machine.onCallback(callback("reset:no", 960));

    expect(h.runner.resets).toHaveLength(0);
    expect(h.bot.lastEdit().text).toBe("Выбран: Дом агента");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["act:files", "mdl", "ws", "act:reset", "stp", "mnu:refresh"]);
    expect(h.machine.activeWorkspace()).toEqual(HOME);
  });

  it("does not reset when the confirmation message is unknown (restart)", async () => {
    const h = makeHarness();
    withActive(h);

    await h.machine.onCallback(callback("reset:yes", 970));

    expect(h.runner.resets).toHaveLength(0);
    expect(h.bot.answers).toEqual([{ id: "cb-970-reset:yes", text: "Действие устарело — повторите" }]);
    expect(h.bot.edits).toHaveLength(0);
  });

  it("does not reset a workspace that stopped being active since the confirmation", async () => {
    const h = makeHarness();
    withActive(h);
    await h.machine.onCallback(callback("act:reset", 980));
    h.machine.setActiveWorkspace(project("alpha"));

    await h.machine.onCallback(callback("reset:yes", 980));

    expect(h.runner.resets).toHaveLength(0);
    expect(h.bot.answers.at(-1)!.text).toBe("Действие устарело — повторите");
  });

  it("hints at workspace selection when act:reset arrives with no active workspace", async () => {
    const h = makeHarness();

    await h.machine.onCallback(callback("act:reset", 990));

    expect(h.bot.lastEdit().text).toContain("Воркспейс не выбран");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
  });
});

describe("chat machine: stale and unknown callbacks", () => {
  it("answers an unknown callback code without touching any dependency", async () => {
    const h = makeHarness();

    await h.machine.onCallback(callback("totally-unknown", 1000));

    expect(h.bot.answers).toEqual([{ id: "cb-1000-totally-unknown", text: "Действие устарело — повторите" }]);
    expect(h.bot.sent).toHaveLength(0);
    expect(h.bot.edits).toHaveLength(0);
    expect(h.workspaces.dirCalls).toHaveLength(0);
    expect(h.workspaces.fileCalls).toHaveLength(0);
  });

  it("answers a malformed index without disclosing anything", async () => {
    const h = makeHarness();

    await h.machine.onCallback(callback("e:abc", 1010));
    await h.machine.onCallback(callback("ws:pick:-1", 1010));
    await h.machine.onCallback(callback("pg:", 1010));

    expect(h.bot.answers.map((answer) => answer.text)).toEqual([
      "Действие устарело — повторите",
      "Действие устарело — повторите",
      "Действие устарело — повторите"
    ]);
    expect(h.workspaces.fileCalls).toHaveLength(0);
  });

  it("answers an entry callback whose message snapshot is unknown (after a restart)", async () => {
    const h = makeHarness();

    await h.machine.onCallback(callback("e:0", 1020));

    expect(h.bot.answers).toEqual([{ id: "cb-1020-e:0", text: "Действие устарело — повторите" }]);
    expect(h.workspaces.fileCalls).toHaveLength(0);
    expect(h.workspaces.dirCalls).toHaveLength(0);
    expect(h.bot.edits).toHaveLength(0);
  });

  it("answers an out-of-range entry index inside a known snapshot", async () => {
    const h = makeHarness();
    h.machine.setActiveWorkspace(HOME);
    h.workspaces.setDir("home", "", [{ name: "a.txt", kind: "file" }]);
    h.workspaces.setFile("home", "a.txt", { kind: "text", content: "a", truncated: false });
    await h.machine.onCallback(callback("act:files", 1030));

    await h.machine.onCallback(callback("e:7", 1030));

    expect(h.bot.answers.at(-1)).toEqual({ id: "cb-1030-e:7", text: "Действие устарело — повторите" });
    expect(h.workspaces.fileCalls).toHaveLength(0);
    expect(h.bot.edits).toHaveLength(1);
  });

  it("never resolves a snapshot rendered for another chat", async () => {
    const h = makeHarness();
    h.machine.setActiveWorkspace(HOME);
    h.workspaces.setDir("home", "", [{ name: "secret.txt", kind: "file" }]);
    h.workspaces.setFile("home", "secret.txt", { kind: "text", content: "секрет", truncated: false });
    await h.machine.onCallback(callback("act:files", 1050));

    await h.machine.onCallback(callback("e:0", 1050, "cb-foreign", CHAT + 1));

    expect(h.bot.answers.at(-1)).toEqual({ id: "cb-foreign", text: "Действие устарело — повторите" });
    expect(h.workspaces.fileCalls).toHaveLength(0);
    expect(h.bot.edits).toHaveLength(1);
    expect(h.bot.editTexts()[0]).not.toContain("secret.txt");
  });

  it("keeps a surviving listing snapshot after other messages are rendered", async () => {
    const h = makeHarness();
    h.machine.setActiveWorkspace(HOME);
    h.workspaces.setDir("home", "", [{ name: "a.txt", kind: "file" }]);
    h.workspaces.setFile("home", "a.txt", { kind: "text", content: "тело файла", truncated: false });
    await h.machine.onCallback(callback("act:files", 1040));
    await h.machine.onCallback(callback("mnu", 1041));

    await h.machine.onCallback(callback("e:0", 1040));

    expect(h.workspaces.fileCalls).toEqual([{ scope: "home", name: undefined, relPath: "a.txt" }]);
    expect(h.bot.lastEdit().messageId).toBe(1040);
    expect(h.bot.lastEdit().text).toBe("тело файла");
  });
});

describe("chat machine: commands and menu card", () => {
  it("/start and /menu render the menu card as a new message", async () => {
    const h = makeHarness();
    await h.machine.onMessage(message("/start"));

    expect(h.bot.sent).toHaveLength(1);
    expect(h.bot.sent[0]!.text).toContain("🤖 Агент сервера");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
  });

  it("an unknown command answers with the card and never reaches the agent", async () => {
    const h = makeHarness();
    await h.machine.onMessage(message("/foo"));

    expect(h.runner.runs).toHaveLength(0);
    expect(h.bot.sent[0]!.text).toContain("Не знаю такой команды.");
    expect(h.bot.sent[1]!.text).toContain("🤖 Агент сервера");
  });

  it("a path-looking text is an unknown command, never a task", async () => {
    const h = makeHarness();
    h.machine.setActiveWorkspace(HOME);

    await h.machine.onMessage(message("/etc/hosts почини"));

    expect(h.runner.runs).toHaveLength(0);
    expect(h.bot.sent[0]!.text).toContain("Не знаю такой команды.");
  });

  it("/help answers with the reference text", async () => {
    const h = makeHarness();
    await h.machine.onMessage(message("/help"));

    expect(h.bot.sent[0]!.text).toContain("/stop — остановить задачу (контекст сохраняется)");
  });

  it("/ws routes on the first token and opens the list", async () => {
    const h = makeHarness();
    h.workspaces.projects.push("alpha");

    await h.machine.onMessage(message("/ws alpha"));

    expect(h.runner.runs).toHaveLength(0);
    expect(h.bot.sent[0]!.text).toContain("Выберите воркспейс");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["ws:pick:0", "ws:pick:1"]);
  });

  it("the menu card reflects the active workspace and the live task line", async () => {
    const h = makeHarness();
    await h.machine.setActiveWorkspace(HOME);
    await h.machine.onMessage(message("/status"));

    expect(h.bot.sent[0]!.text).toContain("Воркспейс: Дом агента");
    expect(h.bot.sent[0]!.text).toContain("Задача: нет активной задачи");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["act:files", "mdl", "ws", "act:reset", "stp", "mnu:refresh"]);
  });

  it("renders the running task line, the step and the queue from live progress", async () => {
    const h = makeHarness();
    h.machine.setActiveWorkspace(HOME);
    h.runner.progress.mockReturnValue({
      phase: "running",
      taskText: "посчитай файлы",
      startedAt: Date.now(),
      step: 3,
      steps: [],
      queued: 2
    });

    await h.machine.onMessage(message("/status"));

    expect(h.bot.sent[0]!.text).toMatch(/Задача: выполняется · \d:\d\d · шаг 3/);
    expect(h.bot.sent[0]!.text).toContain("Очередь: 2");
  });

  it("the extended card reports a session that exists", async () => {
    const h = makeHarness();
    h.machine.setActiveWorkspace(HOME);
    h.runner.sessionIdOf.mockReturnValue("session-1");
    await h.machine.onMessage(message("/menu"));
    const sentId = h.bot.sent[0]!.messageId;

    await h.machine.onCallback(callback("mnu:refresh", sentId));

    expect(h.bot.lastEdit().text).toContain("Сессия: активна");
  });

  it("renders the model line only when the models slice is injected", async () => {
    const without = makeHarness();
    await without.machine.onMessage(message("/menu"));
    expect(without.bot.sent[0]!.text).not.toContain("Модель: ");

    const withModels = makeHarness({
      models: makeModels([
        {
          routeId: "deepseek",
          displayName: "DeepSeek",
          hasKey: true,
          models: ["deepseek-chat"],
          isDefault: true
        }
      ])
    });
    await withModels.machine.onMessage(message("/menu"));

    expect(withModels.bot.sent[0]!.text).toContain("Модель: deepseek-chat · deepseek");
  });

  it("mnu:refresh re-renders the card in place", async () => {
    const h = makeHarness();
    const sentId = (await h.machine.onMessage(message("/menu")), h.bot.sent[0]!.messageId);

    await h.machine.onCallback(callback("mnu:refresh", sentId));

    expect(h.bot.lastEdit().messageId).toBe(sentId);
    expect(h.bot.lastEdit().text).toContain("🤖 Агент сервера");
    expect(h.bot.lastEdit().text).toContain("Сессия: не создана");
  });

  it("mnu re-renders the card in place without the session line", async () => {
    const h = makeHarness();
    const sentId = (await h.machine.onMessage(message("/menu")), h.bot.sent[0]!.messageId);

    await h.machine.onCallback(callback("mnu", sentId));

    expect(h.bot.lastEdit().messageId).toBe(sentId);
    expect(h.bot.lastEdit().text).toContain("🤖 Агент сервера");
    expect(h.bot.lastEdit().text).not.toContain("Сессия:");
  });

  it("/reset from text confirms first, and that reset:yes reaches the runner", async () => {
    const h = makeHarness();
    h.machine.setActiveWorkspace(HOME);

    await h.machine.onMessage(message("/reset"));

    const confirm = h.bot.sent.at(-1)!;
    expect(confirm.text).toContain("Сбросить контекст");
    expect(h.bot.data(confirm.markup)).toEqual(["reset:yes", "reset:no"]);
    expect(h.runner.resets).toHaveLength(0);

    await h.machine.onCallback(callback("reset:yes", confirm.messageId));

    expect(h.runner.resets).toEqual([HOME]);
  });
});

describe("chat machine: model picker", () => {
  const CONNECTIONS: ModelConnectionRow[] = [
    {
      routeId: "deepseek-official",
      displayName: "DeepSeek (официальный)",
      hasKey: true,
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      isDefault: true
    },
    { routeId: "openai", displayName: "OpenAI", hasKey: false, models: ["gpt-4o"], isDefault: false }
  ];

  it("lists connections, marks the current one and never accepts a raw model string", async () => {
    const h = makeHarness({ models: makeModels(CONNECTIONS) });
    await h.machine.onMessage(message("/model"));

    expect(h.bot.sent[0]!.text).toContain("🧠 Модель сейчас: deepseek-v4-flash · deepseek-official");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["mdl:c:0", "mdl:c:1", "mnu"]);

    const openai = h.bot.buttonByData(h.bot.sent[0]!.markup, "mdl:c:1")!;
    expect(openai.text).toContain("нет ключа");
    // A press resolves a row of the snapshot rendered into the message it is
    // pressed in, so it carries the id of the card that was sent.
    const cardId = h.bot.sent[0]!.messageId;
    h.bot.sent.length = 0;
    await h.machine.onCallback(callback("mdl:c:1", cardId));

    expect(h.models!.saved).toHaveLength(0);
    expect(h.bot.answers.at(-1)!.text).toBe("Ключ не задан — добавьте в админке");
    // The refusal changes nothing: the card the owner pressed stays as it was.
    expect(h.bot.edits).toHaveLength(0);
  });

  it("opens a connection, saves the chosen model and reflects it in the menu", async () => {
    const h = makeHarness({ models: makeModels(CONNECTIONS) });
    const listId = (await h.machine.onMessage(message("/model")), h.bot.sent[0]!.messageId);
    await h.machine.onCallback(callback("mdl:c:0", listId));

    expect(h.bot.lastEdit().messageId).toBe(listId);
    expect(h.bot.lastEdit().text).toContain("🧠 DeepSeek (официальный)");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["mdl:m:0", "mdl:m:1", "mdl:back"]);
    await h.machine.onCallback(callback("mdl:m:1", listId));

    expect(h.models!.saved).toEqual([{ provider: "deepseek-official", model: "deepseek-v4-pro" }]);
    expect(h.bot.lastEdit().messageId).toBe(listId);
    expect(h.bot.lastEdit().text).toContain("🤖 Агент сервера");
    expect(h.bot.lastEdit().text).toContain("deepseek-v4-pro · deepseek-official");
  });

  it("opens the picker from the mdl button of a card that was sent", async () => {
    const h = makeHarness({ models: makeModels(CONNECTIONS) });
    const menuId = (await h.machine.onMessage(message("/menu")), h.bot.sent[0]!.messageId);

    await h.machine.onCallback(callback("mdl", menuId));

    expect(h.bot.lastEdit().messageId).toBe(menuId);
    expect(h.bot.lastEdit().text).toContain("🧠 Модель сейчас: deepseek-v4-flash · deepseek-official");
    // The rendered picker is pressable at once: the edit registered the snapshot.
    await h.machine.onCallback(callback("mdl:c:0", menuId));

    expect(h.bot.lastEdit().text).toContain("🧠 DeepSeek (официальный)");
  });

  it("pages a long model list and returns to the connections", async () => {
    const many = { ...CONNECTIONS[0]!, models: Array.from({ length: 10 }, (_, i) => `m-${i}`) };
    const h = makeHarness({ models: makeModels([many]), listPageSize: 8 });
    const listId = (await h.machine.onMessage(message("/model")), h.bot.sent[0]!.messageId);
    await h.machine.onCallback(callback("mdl:c:0", listId));

    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `mdl:m:${i}`),
      "mdl:pg:0",
      "mdl:pg:1",
      "mdl:back"
    ]);
    await h.machine.onCallback(callback("mdl:pg:1", listId));
    expect(h.bot.lastEdit().text).toContain("Страница 2/2");
    // The page carries the GLOBAL indices, so a press is absolute either way.
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["mdl:m:8", "mdl:m:9", "mdl:pg:0", "mdl:pg:1", "mdl:back"]);
    await h.machine.onCallback(callback("mdl:back", listId));
    expect(h.bot.lastEdit().text).toContain("Выберите соединение:");
  });

  it("pages the connection list with the same mdl:pg code (global row indices)", async () => {
    const rows: ModelConnectionRow[] = [
      { routeId: "a", displayName: "A", hasKey: true, models: ["a-1"], isDefault: true },
      { routeId: "b", displayName: "B", hasKey: true, models: ["b-1"], isDefault: false },
      { routeId: "c", displayName: "C", hasKey: false, models: ["c-1"], isDefault: false }
    ];
    const h = makeHarness({ models: makeModels(rows), listPageSize: 2 });
    const cardId = (await h.machine.onMessage(message("/model")), h.bot.sent[0]!.messageId);

    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["mdl:c:0", "mdl:c:1", "mdl:pg:0", "mdl:pg:1", "mnu"]);
    await h.machine.onCallback(callback("mdl:pg:1", cardId));

    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["mdl:c:2", "mdl:pg:0", "mdl:pg:1", "mnu"]);
    // The third row sits on page 2 and is still refused for its missing key.
    await h.machine.onCallback(callback("mdl:c:2", cardId));
    expect(h.bot.answers.at(-1)!.text).toBe("Ключ не задан — добавьте в админке");
    expect(h.models!.saved).toHaveLength(0);
  });

  it("marks the active model only on the connection that provides it", async () => {
    const rows: ModelConnectionRow[] = [
      { routeId: "a", displayName: "A", hasKey: true, models: ["shared", "a-only"], isDefault: false },
      { routeId: "b", displayName: "B", hasKey: true, models: ["shared"], isDefault: true }
    ];
    const h = makeHarness({ models: makeModels(rows) });
    const cardId = (await h.machine.onMessage(message("/model")), h.bot.sent[0]!.messageId);

    await h.machine.onCallback(callback("mdl:c:0", cardId));
    expect(h.bot.buttonByData(h.bot.lastEdit().markup, "mdl:m:0")!.text).toBe("shared");

    await h.machine.onCallback(callback("mdl:back", cardId));
    await h.machine.onCallback(callback("mdl:c:1", cardId));
    expect(h.bot.buttonByData(h.bot.lastEdit().markup, "mdl:m:0")!.text).toBe("• shared");
  });

  it("degrades when the models service is absent", async () => {
    const h = makeHarness();
    await h.machine.onMessage(message("/model"));

    expect(h.bot.sent[0]!.text).toBe("Раздел моделей недоступен");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["ws", "mdl", "mnu:refresh"]);

    await h.machine.onCallback(callback("mdl", 4242));

    expect(h.bot.lastEdit().text).toBe("Раздел моделей недоступен");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
  });

  it("reports an unreadable connection list without leaking the failure", async () => {
    const models = makeModels(CONNECTIONS);
    models.failList(Object.assign(new Error("EACCES: permission denied, open '/dsh/models.json'"), { code: "EACCES" }));
    const h = makeHarness({ models });

    await h.machine.onMessage(message("/model"));

    expect(h.bot.sent[0]!.text).toBe("Раздел моделей недоступен");
    expect(h.bot.sent[0]!.text).not.toContain("/dsh");
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).not.toContain("permission denied");

    await h.machine.onCallback(callback("mdl", 4300));

    expect(h.bot.lastEdit().text).toBe("Раздел моделей недоступен");
    expect(h.warns).toHaveLength(2);
  });

  it("reports a vanished connection instead of saving it", async () => {
    const models = makeModels(CONNECTIONS);
    models.saveDefault = async () => {
      throw Object.assign(new Error("no such provider connection"), { code: "invalid-route" });
    };
    const h = makeHarness({ models });
    const listId = (await h.machine.onMessage(message("/model")), h.bot.sent[0]!.messageId);
    await h.machine.onCallback(callback("mdl:c:0", listId));
    const editsBefore = h.bot.edits.length;

    await h.machine.onCallback(callback("mdl:m:0", listId));

    expect(h.bot.answers.at(-1)!.text).toBe("Не удалось сменить модель — обновите список");
    // A rejected write leaves the card exactly as it was.
    expect(h.bot.edits).toHaveLength(editsBefore);
    expect(h.warns.at(-1)).toContain("saving the default model failed");
    expect(h.warns.at(-1)).not.toContain("no such provider connection");
  });

  it("never reads a provider or a model out of the callback payload", async () => {
    const h = makeHarness({ models: makeModels(CONNECTIONS) });
    const cardId = (await h.machine.onMessage(message("/model")), h.bot.sent[0]!.messageId);
    await h.machine.onCallback(callback("mdl:c:0", cardId));
    const editsBefore = h.bot.edits.length;
    const answersBefore = h.bot.answers.length;

    await h.machine.onCallback(callback("mdl:m:deepseek-v4-pro", cardId));
    await h.machine.onCallback(callback("mdl:c:deepseek-official", cardId));

    expect(h.models!.saved).toHaveLength(0);
    expect(h.bot.answers.slice(answersBefore).map((answer) => answer.text)).toEqual([
      "Действие устарело — повторите",
      "Действие устарело — повторите"
    ]);
    expect(h.bot.edits).toHaveLength(editsBefore);
  });

  it("answers a stale or foreign model snapshot without touching the models service", async () => {
    const h = makeHarness({ models: makeModels(CONNECTIONS) });
    const cardId = (await h.machine.onMessage(message("/model")), h.bot.sent[0]!.messageId);
    await h.machine.onCallback(callback("mdl:c:0", cardId));
    const editsBefore = h.bot.edits.length;
    const answersBefore = h.bot.answers.length;

    // out-of-range index inside a known snapshot, and an unknown message (restart)
    await h.machine.onCallback(callback("mdl:m:9", cardId));
    await h.machine.onCallback(callback("mdl:m:0", 4400));
    // a snapshot rendered for another chat never resolves here
    await h.machine.onCallback(callback("mdl:m:0", cardId, "cb-foreign", CHAT + 1));

    expect(h.bot.answers.slice(answersBefore).map((answer) => answer.text)).toEqual([
      "Действие устарело — повторите",
      "Действие устарело — повторите",
      "Действие устарело — повторите"
    ]);
    expect(h.models!.saved).toHaveLength(0);
    expect(h.bot.edits).toHaveLength(editsBefore);
  });
});

describe("chat machine: stop", () => {
  it("stops the running task, reports the dropped queue and keeps the context", async () => {
    const h = makeHarness();
    await h.machine.setActiveWorkspace(HOME);
    h.runner.cancel.mockResolvedValue({ cancelled: true, dropped: 2 });

    const sentId = (await h.machine.onMessage(message("/menu")), h.bot.sent[0]!.messageId);
    await h.machine.onCallback(callback("stp", sentId));

    expect(h.runner.cancel).toHaveBeenCalledWith(HOME);
    expect(h.bot.sent.at(-1)!.text).toBe(
      "Остановил. Отменено задач в очереди: 2. Контекст сохранён — можно ставить новую задачу."
    );
  });

  it("/stop from text keeps the context when nothing was queued", async () => {
    const h = makeHarness();
    h.machine.setActiveWorkspace(HOME);
    h.runner.cancel.mockResolvedValue({ cancelled: true, dropped: 0 });

    await h.machine.onMessage(message("/stop"));

    expect(h.runner.cancel).toHaveBeenCalledWith(HOME);
    expect(h.bot.sent.at(-1)!.text).toBe("Остановил. Контекст сохранён — можно ставить новую задачу.");
    expect(h.machine.activeWorkspace()).toEqual(HOME);
  });

  it("answers «Сейчас ничего не выполняется» without a message when idle", async () => {
    const h = makeHarness();
    await h.machine.setActiveWorkspace(HOME);
    h.runner.cancel.mockResolvedValue({ cancelled: false, dropped: 0 });

    await h.machine.onCallback(callback("stp", 777));

    expect(h.bot.answers.at(-1)!.text).toBe("Сейчас ничего не выполняется");
    expect(h.bot.sent).toHaveLength(0);
  });

  it("never reports the task it stopped as an agent failure", async () => {
    const h = makeHarness();
    h.machine.setActiveWorkspace(HOME);
    h.runner.cancel.mockResolvedValue({ cancelled: true, dropped: 0 });
    const gate = h.runner.hold();
    await h.machine.onMessage(message("долгая задача"));

    await h.machine.onMessage(message("/stop"));
    gate.release({ ok: false, code: "cancelled", message: "task cancelled by the owner" });
    await settle();

    expect(h.bot.texts()).toEqual([
      "⏳ Дом агента · 0:00",
      "Остановил. Контекст сохранён — можно ставить новую задачу."
    ]);
    // The stopped task's own card becomes the receipt instead of a failure.
    expect(h.bot.lastEdit().text).toBe("⏹ Остановлено владельцем · 0:00");
  });

  it("hints at the workspace instead of cancelling when none is active", async () => {
    const h = makeHarness();

    await h.machine.onMessage(message("/stop"));

    expect(h.runner.cancel).not.toHaveBeenCalled();
    expect(h.bot.sent.at(-1)!.text).toContain("Воркспейс не выбран");
    expect(h.bot.data(h.bot.sent.at(-1)!.markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
  });
});
