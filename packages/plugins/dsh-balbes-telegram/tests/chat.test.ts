import { describe, expect, it } from "vitest";
import type { AgentTaskRunner, TaskResult, WorkspaceRef } from "../src/agentTask.js";
import type { BotClient } from "../src/bot.js";
import {
  createChatMachine,
  type ChatDeps,
  type ChatMachine,
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

function makeBot(): {
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
  const bot: BotClient = {
    async getMe() {
      return {};
    },
    async getUpdates() {
      return [];
    },
    async sendMessage(chatId, text, extra) {
      const messageId = nextSentId++;
      sent.push({ chatId, messageId, text, markup: markupOf(extra) });
      return messageId;
    },
    async editMessageText(chatId, messageId, text, extra) {
      edits.push({ chatId, messageId, text, markup: markupOf(extra) });
    },
    async answerCallbackQuery(callbackQueryId, opts) {
      answers.push({ id: callbackQueryId, text: opts?.text });
    }
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
  setResult: (result: TaskResult) => void;
  hold: () => { release: (result: TaskResult) => void; settled: () => boolean };
} {
  const runs: Array<{ ref: WorkspaceRef; text: string }> = [];
  const resets: WorkspaceRef[] = [];
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
    sessionIdOf() {
      return undefined;
    },
    snapshot() {
      return [];
    }
  };

  return {
    service,
    runs,
    resets,
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

interface Harness {
  machine: ChatMachine;
  bot: ReturnType<typeof makeBot>;
  workspaces: ReturnType<typeof makeWorkspaces>;
  runner: ReturnType<typeof makeRunner>;
  activeChanges: Array<WorkspaceRef | undefined>;
  warns: string[];
}

function makeHarness(
  opts: { listPageSize?: number; filePageChars?: number; maxFileBytes?: number } = {}
): Harness {
  const bot = makeBot();
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
    onActiveChange: (ref) => {
      activeChanges.push(ref);
    },
    logger: {
      warn: (message) => {
        warns.push(message);
      }
    }
  });
  return { machine, bot, workspaces, runner, activeChanges, warns };
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

const HOME: WorkspaceRef = { scope: "home" };

function project(name: string): WorkspaceRef {
  return { scope: "project", name };
}

describe("chat machine: root menu and workspace list", () => {
  it("/start sends the welcome with a single «Воркспейсы» button", async () => {
    const h = makeHarness();

    await h.machine.onMessage(message("/start"));

    expect(h.bot.sent).toHaveLength(1);
    expect(h.bot.sent[0]!.chatId).toBe(CHAT);
    expect(h.bot.sent[0]!.text).toBe("Привет! Я агент твоего сервера.");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["ws"]);
    expect(h.bot.buttonByData(h.bot.sent[0]!.markup, "ws")!.text).toBe("Воркспейсы");
  });

  it("the menu callback edits the pressed message into the welcome", async () => {
    const h = makeHarness();
    const id = 700;

    await h.machine.onCallback(callback("menu", id));

    expect(h.bot.sent).toHaveLength(0);
    expect(h.bot.lastEdit().messageId).toBe(id);
    expect(h.bot.lastEdit().text).toBe("Привет! Я агент твоего сервера.");
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws"]);
    expect(h.bot.answers).toEqual([{ id: `cb-${id}-menu`, text: undefined }]);
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

  it("an unknown command shows the root menu instead of running a task", async () => {
    const h = makeHarness();

    await h.machine.onMessage(message("/help"));

    expect(h.bot.texts()).toEqual(["Привет! Я агент твоего сервера."]);
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
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws"]);
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
    expect(h.bot.data(selected.markup)).toEqual(["act:task", "act:files", "act:reset", "act:ws"]);
    expect(h.bot.buttons(selected.markup).map((button) => button.text)).toEqual([
      "Задачи",
      "Файлы",
      "Сбросить контекст",
      "Другой воркспейс"
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
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["ws"]);
    expect(h.runner.runs).toHaveLength(0);
    await settle();
  });

  it("does not start a task for a blank message", async () => {
    const h = makeHarness();
    withActive(h);

    await h.machine.onMessage(message("   "));
    await settle();

    expect(h.runner.runs).toHaveLength(0);
    expect(h.bot.sent[0]!.text).toContain("Активный воркспейс: Дом агента");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["act:task", "act:files", "act:reset", "act:ws"]);
  });

  it("accepts the task, then sends the agent reply", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({ ok: true, text: "готово: 3 файла", sessionId: "session-1" });

    await h.machine.onMessage(message("посчитай файлы"));
    await settle();

    expect(h.runner.runs).toEqual([{ ref: HOME, text: "посчитай файлы" }]);
    expect(h.bot.texts()).toEqual(["Задача принята…", "готово: 3 файла"]);
    expect(h.bot.sent[0]!.chatId).toBe(CHAT);
  });

  it("answers «Задача принята…» before the run settles", async () => {
    const h = makeHarness();
    withActive(h);
    const gate = h.runner.hold();

    await h.machine.onMessage(message("долгая задача"));

    expect(h.bot.texts()).toEqual(["Задача принята…"]);
    expect(gate.settled()).toBe(false);

    gate.release({ ok: true, text: "готово", sessionId: "session-1" });
    await settle();
    expect(h.bot.texts()).toEqual(["Задача принята…", "готово"]);
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

    expect(h.bot.texts()).toEqual(["Задача принята…", "ab\nc"]);
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
      "Задача принята…",
      "В этом воркспейсе уже 3 задачи в очереди — дождитесь завершения"
    ]);
    expect(h.machine.activeWorkspace()).toEqual(HOME);
  });

  it("reports busy with the already-running copy", async () => {
    const h = makeHarness();
    withActive(h);
    h.runner.setResult({ ok: false, code: "busy", message: "a task for this workspace is already running" });

    await h.machine.onMessage(message("дубль"));
    await settle();

    expect(h.bot.texts()).toEqual(["Задача принята…", "Задача уже выполняется…"]);
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
    expect(h.bot.data(h.bot.sent[1]!.markup)).toEqual(["ws"]);
    expect(h.bot.texts()[1]).not.toContain("not-found");
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
    expect(h.bot.texts()).toEqual(["Задача принята…", "Воркспейс удалён — выберите другой"]);
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
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws"]);
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
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["act:task", "act:files", "act:reset", "act:ws"]);
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
    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["ws"]);
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
    await h.machine.onCallback(callback("menu", 1041));

    await h.machine.onCallback(callback("e:0", 1040));

    expect(h.workspaces.fileCalls).toEqual([{ scope: "home", name: undefined, relPath: "a.txt" }]);
    expect(h.bot.lastEdit().messageId).toBe(1040);
    expect(h.bot.lastEdit().text).toBe("тело файла");
  });
});
