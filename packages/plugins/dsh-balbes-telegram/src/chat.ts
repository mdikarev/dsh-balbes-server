import type { AgentTaskRunner, WorkspaceRef } from "./agentTask.js";
import { workspaceRefKey } from "./agentTask.js";
import type { BotClient } from "./bot.js";
import {
  fileKeyboard,
  listingKeyboard,
  menuKeyboard,
  resetConfirmKeyboard,
  workspaceActionsKeyboard,
  workspacesKeyboard,
  type InlineKeyboardMarkup,
  type ListingEntryButton
} from "./keyboards.js";
import { TELEGRAM_MESSAGE_LIMIT, sanitizeReply, splitMessage } from "./text.js";
import { isCommand, type ClassifiedUpdate } from "./updates.js";

/**
 * The owner's chat UX machine: the single stateful piece between the polling
 * loop and the workspace/task services.
 *
 * Everything the owner sees is plain text sent or edited through the injected
 * `BotClient`; every button carries a short protocol code, never a path or a
 * name. Rendered views are snapshotted in memory per `message_id`
 * (`Map<messageId, Snapshot>`, each snapshot pinned to the chat it was
 * rendered for), so an index in a callback is only ever a pointer into what
 * the owner actually saw — the referenced entry is re-read and re-validated on
 * disk on every press, and a callback whose snapshot is unknown (a restart,
 * another chat) resolves without touching anything.
 *
 * A task never blocks the chat: `onMessage` answers «Задача принята…» and lets
 * `runner.run` settle in the background (the runner serializes per workspace
 * itself, and the owner must stay able to browse files or reset the context
 * mid-task). Text and callback entry points swallow Telegram failures after
 * logging a code-only warning, so one failing API call cannot wedge the
 * poller.
 *
 * Callback protocol (payloads stay far below Telegram's 64-character limit):
 *   menu                      root menu (welcome + «Воркспейсы»)
 *   ws                        workspace list, first page
 *   ws:pg:<n>                 workspace list, page n
 *   ws:pick:<i>               i-th row of the last rendered workspace list
 *   act:task                  active workspace: how to send a task
 *   act:files                 active workspace: open the file-tree root
 *   act:ws                    active workspace: pick another workspace
 *   act:reset                 active workspace: ask to reset the session
 *   e:<i>                     i-th entry of the current listing snapshot
 *   up                        parent directory / back to the listing
 *   pg:<n>                    page n of the current listing or file snapshot
 *   reset:yes | reset:no      context-reset confirmation
 */

export type WorkspaceScope = "home" | "project";

/** One directory entry as the workspaces service reports it. */
export interface WorkspaceTreeEntry {
  name: string;
  kind: "dir" | "file" | "link";
}

/** The result shape of a workspace file read (Task 4 `readWorkspaceFile`). */
export type WorkspaceFileResult =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "binary"; size: number }
  | { kind: "link" };

/**
 * Structural slice of the Task 4 `BalbesWorkspacesService`
 * (packages/plugins/dsh-balbes-workspaces/src/service.ts). The telegram
 * package never imports the workspace plugin — the profile composes both — so
 * only the members the chat actually consumes are declared here.
 */
interface BalbesWorkspacesService {
  list(): Promise<{ home: { path: string }; projects: Array<{ name: string; path: string }> }>;
  readDir(scope: WorkspaceScope, name: string | undefined, relPath: string): Promise<WorkspaceTreeEntry[]>;
  readFile(scope: WorkspaceScope, name: string | undefined, relPath: string): Promise<WorkspaceFileResult>;
}

export interface ChatDeps {
  workspaces: BalbesWorkspacesService;
  runner: AgentTaskRunner;
  bot: BotClient;
  /** Configured read ceiling for one file (Config.maxFileBytes). */
  maxFileBytes: number;
  /** Rows per list page: workspace list and file listings (default 8). */
  listPageSize?: number;
  /** Characters per file text page (default 3000, capped below the API limit). */
  filePageChars?: number;
  /** The chat host persists the active workspace on every change. */
  onActiveChange(ref: WorkspaceRef | undefined): void;
  logger?: { warn(m: string): void };
}

export interface ChatMachine {
  onMessage(update: ClassifiedUpdate & { kind: "message" }): Promise<void>;
  onCallback(update: ClassifiedUpdate & { kind: "callback" }): Promise<void>;
  activeWorkspace(): WorkspaceRef | undefined;
  /** Boot-restore from the persisted state; does not persist back. */
  setActiveWorkspace(ref: WorkspaceRef | undefined): void;
}

type MessageUpdate = ClassifiedUpdate & { kind: "message" };
type CallbackUpdate = ClassifiedUpdate & { kind: "callback" };

/** One rendered workspace list, keyed by the message that shows it. */
interface WorkspacesSnapshot {
  kind: "workspaces";
  /** The chat the message belongs to: a foreign chat never resolves here. */
  chatId: number;
  rows: WorkspaceRef[];
  page: number;
}

/** One rendered directory listing, keyed by the message that shows it. */
interface ListingSnapshot {
  kind: "listing";
  /** The chat the message belongs to: a foreign chat never resolves here. */
  chatId: number;
  ref: WorkspaceRef;
  relPath: string;
  entries: WorkspaceTreeEntry[];
  page: number;
}

/** One rendered file page; keeps the listing it was opened from for «назад». */
interface FileSnapshot {
  kind: "file";
  /** The chat the message belongs to: a foreign chat never resolves here. */
  chatId: number;
  ref: WorkspaceRef;
  relPath: string;
  page: number;
  listingRelPath: string;
  listingPage: number;
}

/** A pending context-reset confirmation. */
interface ResetSnapshot {
  kind: "reset";
  /** The chat the message belongs to: a foreign chat never resolves here. */
  chatId: number;
  ref: WorkspaceRef;
}

type Snapshot = WorkspacesSnapshot | ListingSnapshot | FileSnapshot | ResetSnapshot;

const DEFAULT_LIST_PAGE_SIZE = 8;
const DEFAULT_FILE_PAGE_CHARS = 3000;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
/** Headroom kept free on a file page for its header and the truncation note. */
const FILE_PAGE_HEADROOM = 256;
/** Bound on remembered rendered views: a long-lived chat cannot grow forever. */
const MAX_SNAPSHOTS = 64;

const WELCOME = "Привет! Я агент твоего сервера.";
const LIST_TITLE = "Выберите воркспейс:";
const LIST_FAILED =
  "Не удалось получить список воркспейсов. Попробуйте позже.";
const HOME_LABEL = "Дом агента";
const NO_ACTIVE_HINT = "Воркспейс не выбран — нажмите «Воркспейсы».";
const TASK_ACCEPTED = "Задача принята…";
const TASK_HINT =
  "Отправьте задачу текстом — я выполню её в этом воркспейсе.";
const QUEUE_FULL =
  "В этом воркспейсе уже 3 задачи в очереди — дождитесь завершения";
const BUSY = "Задача уже выполняется…";
const WORKSPACE_GONE = "Воркспейс удалён — выберите другой";
const RESET_CONFIRM =
  "Сбросить контекст этого воркспейса? Текущая сессия завершится, " +
  "следующая задача начнётся с чистого контекста.";
const RESET_DONE = "Контекст сессии сброшен";
const RESET_ABORTED =
  "Задача прервана: контекст воркспейса был сброшен — отправьте её снова.";
const EMPTY_REPLY = "Задача выполнена, но агент вернул пустой ответ.";
const LINK_NOT_OPENABLE = "Это ссылка — просмотр недоступен";
const EMPTY_FILE = "(файл пуст)";
const TRUNCATION_NOTE =
  "…файл показан не полностью: достигнут лимит чтения.";
const INTERNAL_FAILURE = "внутренняя ошибка";
const STALE_LIST = "Список устарел, откройте заново";
const STALE_ACTION = "Действие устарело — повторите";

/**
 * Task 7 settles a run that the owner's own «Сбросить контекст» interrupted as
 * `agent-error` — either the in-flight turn ("aborted") or a queued task
 * ("dropped"). Matching those two exact phrases is what keeps an intentional
 * reset from being reported as an agent crash; a genuine agent failure never
 * produces them (they mirror `RESET_ABORT_MESSAGE`/`RESET_DROP_MESSAGE` in
 * agentTask.ts).
 */
const RESET_ABORT_PHRASES = new Set([
  "task aborted because the workspace context was reset",
  "task dropped because the workspace context was reset"
]);

/** Text commands that open the workspace list instead of running a task. */
const LIST_COMMANDS = new Set(["/ws", "Воркспейсы"]);

function copyRef(ref: WorkspaceRef | undefined): WorkspaceRef | undefined {
  if (ref === undefined) return undefined;
  return ref.scope === "home" ? { scope: "home" } : { scope: "project", name: ref.name };
}

function scopeOf(ref: WorkspaceRef): WorkspaceScope {
  return ref.scope === "home" ? "home" : "project";
}

function nameOf(ref: WorkspaceRef): string | undefined {
  return ref.scope === "project" ? ref.name : undefined;
}

function refLabel(ref: WorkspaceRef): string {
  return ref.scope === "home" ? HOME_LABEL : `Проект: ${ref.name}`;
}

/** The error code of a domain error, never its message (no paths, no content). */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code !== "" ? code : "unexpected";
}

/** A safe Russian reason for a failed open; never the raw error text. */
function openFailureReason(error: unknown): string {
  const code = codeOf(error);
  if (code === "not-found" || code === "ENOENT" || code === "ENOTDIR") {
    return "запись не найдена";
  }
  if (code === "invalid-path" || code === "invalid-name") return "путь недоступен";
  if (code === "EISDIR") return "это каталог, а не файл";
  if (code === "EACCES" || code === "EPERM") return "нет доступа";
  return "ошибка чтения";
}

/** One-line, length-bounded agent failure phrase (never a multi-line stack). */
function safePhrase(message: string): string {
  const firstLine = message.split("\n", 1)[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed === "") return INTERNAL_FAILURE;
  return collapsed.length > 300 ? `${collapsed.slice(0, 299)}…` : collapsed;
}

/** `^\d{1,6}$` — an index/page from a callback payload, or nothing. */
function parseIndex(raw: string): number | undefined {
  return /^\d{1,6}$/.test(raw) ? Number(raw) : undefined;
}

function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(0, page), Math.max(0, pages - 1));
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(min, Math.floor(value)), max);
}

function parentRelPath(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

function joinRelPath(relPath: string, name: string): string {
  return relPath === "" ? name : `${relPath}/${name}`;
}

/** A directory entry name is only usable when it is a plain child segment. */
function isSafeName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  return !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

/** The paths to try for a view: the target, its parent, then the root. */
function candidatePaths(relPath: string): string[] {
  const candidates = [relPath];
  let current = relPath;
  while (current !== "") {
    current = parentRelPath(current);
    if (!candidates.includes(current)) candidates.push(current);
  }
  return candidates;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Cut text at `limit` characters without splitting a surrogate pair. */
function cutToLimit(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text;
  let end = limit;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** Page ranges of `text`; always at least one (possibly empty) range. */
function pageRanges(text: string, size: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const limit = Math.max(1, size);
  let start = 0;
  for (;;) {
    let end = Math.min(text.length, start + limit);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    ranges.push({ start, end });
    if (end >= text.length || end <= start) break;
    start = end;
  }
  return ranges;
}

function withPageLine(header: string, page: number, pages: number): string {
  return pages > 1 ? `${header}\nСтраница ${page + 1}/${pages}` : header;
}

export function createChatMachine(deps: ChatDeps): ChatMachine {
  const listPageSize = clampInt(deps.listPageSize, DEFAULT_LIST_PAGE_SIZE, 1, 100);
  const filePageChars = clampInt(
    deps.filePageChars,
    DEFAULT_FILE_PAGE_CHARS,
    1,
    TELEGRAM_MESSAGE_LIMIT - FILE_PAGE_HEADROOM
  );
  /**
   * The configured read ceiling is applied as the chat's own display cut as
   * well: the injected service may read up to its own (larger) default, and a
   * configured limit must never push more content into the chat than the owner
   * allowed. The note stays unit-free so the copy is truthful for multi-byte
   * content too. A non-positive/absent value falls back to the service default
   * rather than becoming "no ceiling at all".
   */
  const displayLimit =
    Number.isFinite(deps.maxFileBytes) && deps.maxFileBytes > 0
      ? Math.floor(deps.maxFileBytes)
      : DEFAULT_MAX_FILE_BYTES;

  const snapshots = new Map<number, Snapshot>();
  let active: WorkspaceRef | undefined;

  function warn(message: string): void {
    deps.logger?.warn(`dsh-balbes-telegram: chat: ${message}`);
  }

  function putSnapshot(messageId: number, snapshot: Snapshot): void {
    if (snapshots.size >= MAX_SNAPSHOTS && !snapshots.has(messageId)) {
      const oldest = snapshots.keys().next().value;
      if (oldest !== undefined) snapshots.delete(oldest);
    }
    snapshots.set(messageId, snapshot);
  }

  function deleteSnapshot(messageId: number): void {
    snapshots.delete(messageId);
  }

  /**
   * The snapshot of one rendered message. The chat is checked as well as the
   * message id: `message_id` is only unique per chat, and a lookup that mixed
   * two chats would render one chat's data into the other.
   */
  function snapshotOf(chatId: number, messageId: number): Snapshot | undefined {
    const snapshot = snapshots.get(messageId);
    return snapshot !== undefined && snapshot.chatId === chatId ? snapshot : undefined;
  }

  function applyActive(ref: WorkspaceRef | undefined): void {
    active = copyRef(ref);
    deps.onActiveChange(copyRef(active));
  }

  async function send(chatId: number, text: string, keyboard?: InlineKeyboardMarkup): Promise<void> {
    try {
      if (keyboard === undefined) await deps.bot.sendMessage(chatId, text);
      else await deps.bot.sendMessage(chatId, text, { reply_markup: keyboard });
    } catch (error) {
      warn(`sendMessage failed (${codeOf(error)})`);
    }
  }

  async function edit(
    chatId: number,
    messageId: number,
    text: string,
    keyboard: InlineKeyboardMarkup
  ): Promise<void> {
    try {
      await deps.bot.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
    } catch (error) {
      warn(`editMessageText failed (${codeOf(error)})`);
    }
  }

  async function answer(callbackQueryId: string, text: string | undefined): Promise<void> {
    try {
      if (text === undefined) await deps.bot.answerCallbackQuery(callbackQueryId);
      else await deps.bot.answerCallbackQuery(callbackQueryId, { text });
    } catch (error) {
      warn(`answerCallbackQuery failed (${codeOf(error)})`);
    }
  }

  /** The content of one workspace list page, or undefined when list() failed. */
  async function buildWorkspaceView(chatId: number, page: number): Promise<
    | {
        text: string;
        keyboard: InlineKeyboardMarkup;
        snapshot: WorkspacesSnapshot;
      }
    | undefined
  > {
    let list: { home: { path: string }; projects: Array<{ name: string; path: string }> };
    try {
      list = await deps.workspaces.list();
    } catch (error) {
      warn(`workspace list failed (${codeOf(error)})`);
      return undefined;
    }
    // Agent home always exists (spec), so the list is never empty; a project
    // row is only ever offered from a freshly read list.
    const rows: WorkspaceRef[] = [
      { scope: "home" },
      ...list.projects.map((project): WorkspaceRef => ({ scope: "project", name: project.name }))
    ];
    const pages = Math.max(1, Math.ceil(rows.length / listPageSize));
    const current = clampPage(page, pages);
    const start = current * listPageSize;
    const buttons = rows.slice(start, start + listPageSize).map((ref, offset) => ({
      index: start + offset,
      label: refLabel(ref)
    }));
    return {
      text: withPageLine(LIST_TITLE, current, pages),
      keyboard: workspacesKeyboard({ rows: buttons, page: current, pages }),
      snapshot: { kind: "workspaces", chatId, rows: rows.map((ref) => copyRef(ref)!), page: current }
    };
  }

  /** Render (or re-render) the workspace list into a known message. */
  async function renderWorkspaces(chatId: number, messageId: number, page: number): Promise<void> {
    const view = await buildWorkspaceView(chatId, page);
    if (view === undefined) {
      deleteSnapshot(messageId);
      await edit(chatId, messageId, LIST_FAILED, menuKeyboard());
      return;
    }
    putSnapshot(messageId, view.snapshot);
    await edit(chatId, messageId, view.text, view.keyboard);
  }

  /** Render a directory listing, falling back to the parent and then the root. */
  async function openListing(
    chatId: number,
    messageId: number,
    ref: WorkspaceRef,
    relPath: string,
    page: number
  ): Promise<void> {
    let lastError: unknown;
    for (const candidate of candidatePaths(relPath)) {
      let entries: WorkspaceTreeEntry[];
      try {
        entries = await deps.workspaces.readDir(scopeOf(ref), nameOf(ref), candidate);
      } catch (error) {
        // Logged as a code and a depth only: never a path, never content.
        lastError = error;
        const depth = candidate === "" ? 0 : candidate.split("/").length;
        warn(`readDir failed at depth ${depth} (${codeOf(error)})`);
        continue;
      }
      await renderListing(chatId, messageId, ref, candidate, entries, page);
      return;
    }
    deleteSnapshot(messageId);
    await edit(
      chatId,
      messageId,
      `Не удалось открыть: ${openFailureReason(lastError)}.`,
      workspaceActionsKeyboard()
    );
  }

  async function renderListing(
    chatId: number,
    messageId: number,
    ref: WorkspaceRef,
    relPath: string,
    entries: WorkspaceTreeEntry[],
    requestedPage: number
  ): Promise<void> {
    const pages = Math.max(1, Math.ceil(entries.length / listPageSize));
    const page = clampPage(requestedPage, pages);
    const start = page * listPageSize;
    const pageEntries: ListingEntryButton[] = entries
      .slice(start, start + listPageSize)
      .map((entry, offset) => ({ index: start + offset, name: entry.name, kind: entry.kind }));
    const header = `Файлы: ${refLabel(ref)}${relPath === "" ? "" : ` / ${relPath}`}`;
    const text =
      entries.length === 0 ? `${header}\nПапка пуста.` : withPageLine(header, page, pages);
    putSnapshot(messageId, {
      kind: "listing",
      chatId,
      ref: copyRef(ref)!,
      relPath,
      entries: entries.map((entry) => ({ ...entry })),
      page
    });
    await edit(
      chatId,
      messageId,
      text,
      listingKeyboard({ entries: pageEntries, page, pages, withUp: relPath !== "" })
    );
  }

  /** Render one page of a file, re-reading it so the page is always current. */
  async function renderFile(
    chatId: number,
    messageId: number,
    ref: WorkspaceRef,
    relPath: string,
    requestedPage: number,
    listingRelPath: string,
    listingPage: number
  ): Promise<void> {
    const snapshot: FileSnapshot = {
      kind: "file",
      chatId,
      ref: copyRef(ref)!,
      relPath,
      page: 0,
      listingRelPath,
      listingPage
    };
    let result: WorkspaceFileResult;
    try {
      result = await deps.workspaces.readFile(scopeOf(ref), nameOf(ref), relPath);
    } catch (error) {
      const depth = relPath === "" ? 0 : relPath.split("/").length;
      warn(`readFile failed at depth ${depth} (${codeOf(error)})`);
      putSnapshot(messageId, snapshot);
      await edit(
        chatId,
        messageId,
        `Не удалось открыть: ${openFailureReason(error)}.`,
        fileKeyboard({ page: 0, hasMore: false })
      );
      return;
    }
    if (result.kind !== "text") {
      putSnapshot(messageId, snapshot);
      const text =
        result.kind === "link"
          ? LINK_NOT_OPENABLE
          : `Это бинарный файл (${result.size} байт) — просмотр недоступен`;
      await edit(chatId, messageId, text, fileKeyboard({ page: 0, hasMore: false }));
      return;
    }

    const content = cutToLimit(result.content, displayLimit);
    // A byte cut may also end a character; either way the tail is unreachable,
    // so the view admits it with a trailing note page.
    const cutShort = result.truncated || content.length < result.content.length;
    const ranges = pageRanges(content, filePageChars);
    const contentPages = ranges.length;
    const pages = cutShort ? contentPages + 1 : contentPages;
    const page = clampPage(requestedPage, pages);
    const range = ranges[page];
    const body = range === undefined ? TRUNCATION_NOTE : content.slice(range.start, range.end);
    const pageBody = body === "" ? EMPTY_FILE : body;
    const text = sanitizeReply(
      pages > 1 ? `Файл: ${relPath} — страница ${page + 1}/${pages}\n\n${pageBody}` : pageBody
    );
    putSnapshot(messageId, { ...snapshot, page });
    await edit(chatId, messageId, text, fileKeyboard({ page, hasMore: page < pages - 1 }));
  }

  /** Pick one row of the last rendered workspace list, re-validating on disk. */
  async function pickWorkspace(
    chatId: number,
    messageId: number,
    index: number
  ): Promise<string | undefined> {
    const snapshot = snapshotOf(chatId, messageId);
    let list: { home: { path: string }; projects: Array<{ name: string; path: string }> };
    try {
      list = await deps.workspaces.list();
    } catch (error) {
      warn(`workspace list failed (${codeOf(error)})`);
      return STALE_ACTION;
    }
    if (snapshot === undefined || snapshot.kind !== "workspaces") {
      // Nothing was snapshotted for this message (a list sent as a new message
      // carries no id we could key): re-render it in place, which registers a
      // snapshot, so the next press works.
      await renderWorkspaces(chatId, messageId, 0);
      return STALE_LIST;
    }
    const ref = snapshot.rows[index];
    const exists =
      ref !== undefined &&
      (ref.scope === "home" || list.projects.some((project) => project.name === ref.name));
    if (ref === undefined || !exists) {
      await renderWorkspaces(chatId, messageId, snapshot.page);
      return STALE_LIST;
    }
    applyActive(ref);
    await send(chatId, `Выбран: ${refLabel(ref)}`, workspaceActionsKeyboard());
    return undefined;
  }

  /** Run one accepted task; settles in the background, never blocks the chat. */
  async function runTask(chatId: number, ref: WorkspaceRef, text: string): Promise<void> {
    let result: Awaited<ReturnType<AgentTaskRunner["run"]>>;
    try {
      result = await deps.runner.run(ref, text);
    } catch (error) {
      warn(`task run failed (${codeOf(error)})`);
      await send(chatId, `Агент не смог выполнить задачу: ${INTERNAL_FAILURE}`);
      return;
    }
    if (result.ok) {
      const chunks = splitMessage(sanitizeReply(result.text));
      if (chunks.length === 0) {
        await send(chatId, EMPTY_REPLY);
        return;
      }
      for (const chunk of chunks) await send(chatId, chunk);
      return;
    }
    if (result.code === "queue-full") {
      await send(chatId, QUEUE_FULL);
      return;
    }
    if (result.code === "busy") {
      await send(chatId, BUSY);
      return;
    }
    if (result.code === "workspace-gone") {
      applyActive(undefined);
      await send(chatId, WORKSPACE_GONE, menuKeyboard());
      return;
    }
    const phrase = safePhrase(result.message);
    if (RESET_ABORT_PHRASES.has(phrase)) {
      await send(chatId, RESET_ABORTED);
      return;
    }
    await send(chatId, `Агент не смог выполнить задачу: ${phrase}`);
  }

  async function answerNoActive(chatId: number, messageId: number): Promise<void> {
    deleteSnapshot(messageId);
    await edit(chatId, messageId, NO_ACTIVE_HINT, menuKeyboard());
  }

  /** Route one callback; the returned text (if any) is the callback answer. */
  async function dispatchCallback(update: CallbackUpdate): Promise<string | undefined> {
    const { chatId, messageId, data } = update;

    if (data === "menu") {
      deleteSnapshot(messageId);
      await edit(chatId, messageId, WELCOME, menuKeyboard());
      return undefined;
    }
    if (data === "ws") {
      await renderWorkspaces(chatId, messageId, 0);
      return undefined;
    }
    if (data.startsWith("ws:pg:")) {
      const page = parseIndex(data.slice("ws:pg:".length));
      if (page === undefined) return STALE_ACTION;
      await renderWorkspaces(chatId, messageId, page);
      return undefined;
    }
    if (data.startsWith("ws:pick:")) {
      const index = parseIndex(data.slice("ws:pick:".length));
      if (index === undefined) return STALE_ACTION;
      return pickWorkspace(chatId, messageId, index);
    }
    if (data === "act:task") {
      const ref = active;
      if (ref === undefined) {
        await answerNoActive(chatId, messageId);
        return undefined;
      }
      deleteSnapshot(messageId);
      await edit(
        chatId,
        messageId,
        `Активный воркспейс: ${refLabel(ref)}\n${TASK_HINT}`,
        workspaceActionsKeyboard()
      );
      return undefined;
    }
    if (data === "act:files") {
      const ref = active;
      if (ref === undefined) {
        await answerNoActive(chatId, messageId);
        return undefined;
      }
      await openListing(chatId, messageId, ref, "", 0);
      return undefined;
    }
    if (data === "act:ws") {
      await renderWorkspaces(chatId, messageId, 0);
      return undefined;
    }
    if (data === "act:reset") {
      const ref = active;
      if (ref === undefined) {
        await answerNoActive(chatId, messageId);
        return undefined;
      }
      putSnapshot(messageId, { kind: "reset", chatId, ref: copyRef(ref)! });
      await edit(chatId, messageId, RESET_CONFIRM, resetConfirmKeyboard());
      return undefined;
    }
    if (data === "reset:yes" || data === "reset:no") {
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined || snapshot.kind !== "reset") return STALE_ACTION;
      if (data === "reset:no") {
        deleteSnapshot(messageId);
        // Report the workspace the owner is on now (the message is edited back
        // into a workspace view, not into the abandoned confirmation).
        const shown = active ?? snapshot.ref;
        await edit(chatId, messageId, `Выбран: ${refLabel(shown)}`, workspaceActionsKeyboard());
        return undefined;
      }
      // The confirmation is only honoured for the workspace that is still
      // active: a stale confirmation must not reset a context the owner has
      // meanwhile switched away from.
      const ref = active;
      if (ref === undefined || workspaceRefKey(ref) !== workspaceRefKey(snapshot.ref)) return STALE_ACTION;
      try {
        await deps.runner.reset(ref);
      } catch (error) {
        warn(`session reset failed (${codeOf(error)})`);
      }
      deleteSnapshot(messageId);
      await edit(chatId, messageId, RESET_DONE, workspaceActionsKeyboard());
      return undefined;
    }
    if (data === "up") {
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined) return STALE_ACTION;
      if (snapshot.kind === "listing") {
        await openListing(chatId, messageId, snapshot.ref, parentRelPath(snapshot.relPath), 0);
        return undefined;
      }
      if (snapshot.kind === "file") {
        await openListing(chatId, messageId, snapshot.ref, snapshot.listingRelPath, snapshot.listingPage);
        return undefined;
      }
      return STALE_ACTION;
    }
    if (data.startsWith("pg:")) {
      const page = parseIndex(data.slice("pg:".length));
      if (page === undefined) return STALE_ACTION;
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined) return STALE_ACTION;
      if (snapshot.kind === "listing") {
        await openListing(chatId, messageId, snapshot.ref, snapshot.relPath, page);
        return undefined;
      }
      if (snapshot.kind === "file") {
        await renderFile(
          chatId,
          messageId,
          snapshot.ref,
          snapshot.relPath,
          page,
          snapshot.listingRelPath,
          snapshot.listingPage
        );
        return undefined;
      }
      return STALE_ACTION;
    }
    if (data.startsWith("e:")) {
      const index = parseIndex(data.slice("e:".length));
      if (index === undefined) return STALE_ACTION;
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined || snapshot.kind !== "listing") return STALE_ACTION;
      const entry = snapshot.entries[index];
      if (entry === undefined || !isSafeName(entry.name)) return STALE_ACTION;
      // A link is never dereferenced: the button exists (Telegram rejects an
      // action-less inline button) but its press only reports metadata.
      if (entry.kind === "link") return LINK_NOT_OPENABLE;
      if (entry.kind === "dir") {
        await openListing(chatId, messageId, snapshot.ref, joinRelPath(snapshot.relPath, entry.name), 0);
        return undefined;
      }
      if (entry.kind === "file") {
        await renderFile(
          chatId,
          messageId,
          snapshot.ref,
          joinRelPath(snapshot.relPath, entry.name),
          0,
          snapshot.relPath,
          snapshot.page
        );
        return undefined;
      }
      // An entry kind this build does not know is not opened.
      return STALE_ACTION;
    }
    return STALE_ACTION;
  }

  return {
    async onMessage(update: MessageUpdate): Promise<void> {
      const command = update.text.trim();
      if (LIST_COMMANDS.has(command)) {
        const view = await buildWorkspaceView(update.chatId, 0);
        if (view === undefined) {
          await send(update.chatId, LIST_FAILED, menuKeyboard());
          return;
        }
        await send(update.chatId, view.text, view.keyboard);
        return;
      }
      // Every other command (including /start) answers with the root menu: an
      // unknown command must never be handed to the agent as a task.
      if (isCommand(command)) {
        await send(update.chatId, WELCOME, menuKeyboard());
        return;
      }
      const ref = active;
      // A blank message carries no task; answer with the state hint instead.
      if (command === "") {
        if (ref === undefined) {
          await send(update.chatId, NO_ACTIVE_HINT, menuKeyboard());
        } else {
          await send(
            update.chatId,
            `Активный воркспейс: ${refLabel(ref)}\n${TASK_HINT}`,
            workspaceActionsKeyboard()
          );
        }
        return;
      }
      if (ref === undefined) {
        await send(update.chatId, NO_ACTIVE_HINT, menuKeyboard());
        return;
      }
      await send(update.chatId, TASK_ACCEPTED);
      // Deliberately not awaited: the runner serializes per workspace, and the
      // owner must stay able to browse files or reset the context mid-task.
      void runTask(update.chatId, copyRef(ref)!, update.text).catch((error: unknown) => {
        warn(`task pipeline failed (${codeOf(error)})`);
      });
    },

    async onCallback(update: CallbackUpdate): Promise<void> {
      let answerText: string | undefined;
      try {
        answerText = await dispatchCallback(update);
      } catch (error) {
        warn(`callback handling failed (${codeOf(error)})`);
      }
      await answer(update.callbackQueryId, answerText);
    },

    activeWorkspace(): WorkspaceRef | undefined {
      return copyRef(active);
    },

    setActiveWorkspace(ref: WorkspaceRef | undefined): void {
      // Boot restore: the host owns persistence, so this never echoes back.
      active = copyRef(ref);
    }
  };
}
