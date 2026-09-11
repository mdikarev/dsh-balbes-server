import type { AgentTaskRunner, WorkspaceRef } from "./agentTask.js";
import { QUEUE_MAX_WAITING, workspaceRefKey } from "./agentTask.js";
import type { BotClient } from "./bot.js";
import {
  HELP_TEXT,
  MODELS_UNAVAILABLE,
  NO_ACTIVE_WORKSPACE_LINE,
  NO_KEY_HINT,
  STOP_IDLE_ANSWER,
  TASK_IDLE_LINE,
  UNKNOWN_COMMAND,
  formatElapsed,
  menuCard,
  modelConnectionsCard,
  modelListCard
} from "./cards.js";
import { parseCommand } from "./commands.js";
import {
  fileKeyboard,
  listingKeyboard,
  resetConfirmKeyboard,
  workspacesKeyboard,
  type InlineKeyboardMarkup,
  type ListingEntryButton
} from "./keyboards.js";
import { TELEGRAM_MESSAGE_LIMIT, sanitizeReply, splitMessage } from "./text.js";
import type { ClassifiedUpdate } from "./updates.js";

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
 * Text is routed through the `commands.ts` table: a text command is answered
 * here and NEVER handed to the agent as a task. The owner's state and every
 * action live in ONE card (`menuView`), sent by `/menu`, `/start` and `/status`
 * and re-rendered in place by its own «Обновить» button.
 *
 * A task never blocks the chat: `onMessage` answers «Задача принята…» and lets
 * `runner.run` settle in the background (the runner serializes per workspace
 * itself, and the owner must stay able to browse files or reset the context
 * mid-task). Text and callback entry points swallow Telegram failures after
 * logging a code-only warning, so one failing API call cannot wedge the
 * poller.
 *
 * Callback protocol (payloads stay far below Telegram's 64-character limit):
 *   mnu                       re-render the menu card in the message it is in
 *   mnu:refresh               the same card, with its extended state lines
 *   stp                       stop the active task and clear its queue
 *   ws                        workspace list, first page
 *   ws:pg:<n>                 workspace list, page n
 *   ws:pick:<i>               i-th row of the last rendered workspace list
 *   mdl                       the model picker: the configured connections
 *   mdl:c:<i>                 i-th connection of the last rendered picker
 *   mdl:pg:<n>                page n of the picker's own list
 *   mdl:m:<i>                 i-th model of the last rendered model list
 *   mdl:back                  back from a model list to the connections
 *   act:task                  legacy: how to send a task (the card supersedes it)
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

/**
 * One configured model connection as the admin surface reports it. Structural
 * slice only: the telegram package never imports the host bundle.
 */
export interface ModelConnectionRow {
  routeId: string;
  displayName: string;
  hasKey: boolean;
  models: string[];
  isDefault: boolean;
}

/**
 * The models slice the card reads its «Модель:» line from. Optional on purpose:
 * a profile without the model surface composes the chat without it, and the
 * line is then simply absent (Task 9 wires the picker onto this same slice).
 */
export interface ModelsSlice {
  list(): Promise<ModelConnectionRow[]>;
  current(): { provider: string; model: string };
  saveDefault(provider: string, model: string): Promise<{ provider: string; model: string }>;
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
  /** The models surface the menu card reports; absent when not composed. */
  models?: ModelsSlice;
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

/**
 * One rendered connection list. The snapshot keeps the WHOLE list while the
 * card renders one page's slice, so a `mdl:c:<i>` index stays absolute.
 */
interface ModelConnectionsSnapshot {
  kind: "modelConnections";
  /** The chat the message belongs to: a foreign chat never resolves here. */
  chatId: number;
  rows: ModelConnectionRow[];
  page: number;
  pages: number;
}

/**
 * One rendered model list, kept per connection: `routeId` and every model come
 * from what the owner saw, so a press writes the model the card showed.
 */
interface ModelListSnapshot {
  kind: "modelList";
  /** The chat the message belongs to: a foreign chat never resolves here. */
  chatId: number;
  routeId: string;
  label: string;
  models: string[];
  page: number;
  pages: number;
}

/**
 * One rendered menu card. The card's buttons are pure codes and its content is
 * read live from the machine, so nothing about it needs remembering — the
 * snapshot exists so a message showing the card is known to BE the card (and
 * so every card leaves the same trace as the lists it replaces).
 */
interface MenuSnapshot {
  kind: "menu";
  /** The chat the message belongs to: a foreign chat never resolves here. */
  chatId: number;
}

type Snapshot =
  | WorkspacesSnapshot
  | ListingSnapshot
  | FileSnapshot
  | ResetSnapshot
  | MenuSnapshot
  | ModelConnectionsSnapshot
  | ModelListSnapshot;

const DEFAULT_LIST_PAGE_SIZE = 8;
const DEFAULT_FILE_PAGE_CHARS = 3000;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
/** Headroom kept free on a file page for its header and the truncation note. */
const FILE_PAGE_HEADROOM = 256;
/**
 * Bound on remembered rendered views: a long-lived chat cannot grow forever.
 * Eviction drops the LEAST RECENTLY USED entry, so a listing the owner keeps
 * pressing stays pressable while unattended ones fall out.
 */
const MAX_SNAPSHOTS = 64;

const LIST_TITLE = "Выберите воркспейс:";
const LIST_FAILED =
  "Не удалось получить список воркспейсов. Попробуйте позже.";
const HOME_LABEL = "Дом агента";
const NO_ACTIVE_HINT = "Воркспейс не выбран — нажмите «Воркспейсы».";
const TASK_ACCEPTED = "Задача принята…";
const STOP_HINT = "Остановил.";
const STOP_CONTEXT_SAVED = "Контекст сохранён — можно ставить новую задачу.";
const STOP_DROPPED = (count: number): string => `Отменено задач в очереди: ${count}.`;
/**
 * Stated with the runner's own constant: the queue depth is the runner's
 * contract, and a copy that hardcoded "3" would lie the moment it changed.
 * (The Russian plural is written for the current value; changing the constant
 * to 1 or 5 needs the wording revisited — chat.test.ts pins the rendered text.)
 */
const QUEUE_FULL =
  `В этом воркспейсе уже ${QUEUE_MAX_WAITING} задачи в очереди — дождитесь завершения`;
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
 * A rejected default-model write. The models service re-reads its connections
 * before it saves (rejecting an unknown route and a model it does not offer),
 * so this is also the answer for a connection or model that vanished after the
 * card was rendered: nothing was written, and the owner refreshes and retries.
 */
const MODEL_SAVE_FAILED = "Не удалось сменить модель — обновите список";

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

/** The legacy text alias an older keyboard may still send for the list. */
const WS_ALIAS = "Воркспейсы";

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

  /**
   * The snapshot of one rendered message. The chat is checked as well as the
   * message id: `message_id` is only unique per chat, and a lookup that mixed
   * two chats would render one chat's data into the other.
   *
   * A hit is re-inserted so the map's insertion order is recency order, which
   * is what {@link putSnapshot}'s eviction relies on (LRU). `Map.set` alone
   * does NOT refresh an existing key's position, so the delete is required.
   */
  function snapshotOf(chatId: number, messageId: number): Snapshot | undefined {
    const snapshot = snapshots.get(messageId);
    if (snapshot === undefined || snapshot.chatId !== chatId) return undefined;
    snapshots.delete(messageId);
    snapshots.set(messageId, snapshot);
    return snapshot;
  }

  function applyActive(ref: WorkspaceRef | undefined): void {
    active = copyRef(ref);
    deps.onActiveChange(copyRef(active));
  }

  /**
   * Send one message and resolve the id Telegram assigned to it, so a view
   * that was sent (not edited) can be snapshotted too. `undefined` means the
   * message is either unsent or carries no usable id: its buttons then fall
   * back to the stale-but-safe path.
   */
  async function send(chatId: number, text: string, keyboard?: InlineKeyboardMarkup): Promise<number | undefined> {
    try {
      const messageId =
        keyboard === undefined
          ? await deps.bot.sendMessage(chatId, text)
          : await deps.bot.sendMessage(chatId, text, { reply_markup: keyboard });
      return typeof messageId === "number" && messageId > 0 ? messageId : undefined;
    } catch (error) {
      warn(`sendMessage failed (${codeOf(error)})`);
      return undefined;
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

  /**
   * The owner's single control panel: the live state (workspace, model, task,
   * queue) plus every action the chat offers. One builder for both the send and
   * the edit path, so a card that was just sent and a card re-rendered in place
   * can never drift apart.
   *
   * `extended` adds the session line: it is what «🔄 Обновить» asks for, while
   * the plain card stays short enough to be read at a glance.
   */
  async function menuView(opts: { extended?: boolean } = {}): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
    const ref = active;
    const progress = ref === undefined ? undefined : deps.runner.progress(ref);
    const model = deps.models?.current();
    const taskLine =
      progress === undefined || progress.phase === "idle"
        ? TASK_IDLE_LINE
        : [
            "выполняется",
            formatElapsed(Date.now() - (progress.startedAt ?? Date.now())),
            progress.step === undefined ? undefined : `шаг ${progress.step}`
          ]
            .filter((part): part is string => part !== undefined)
            .join(" · ");
    const card = menuCard({
      workspaceLabel: ref === undefined ? undefined : refLabel(ref),
      modelLabel: model === undefined ? undefined : `${model.model} · ${model.provider}`,
      taskLine,
      queue: progress?.queued ?? 0,
      ...(opts.extended === true
        ? {
            sessionLabel:
              ref !== undefined && deps.runner.sessionIdOf(ref) !== undefined ? "активна" : "не создана"
          }
        : {})
    });
    return { text: card.text, keyboard: card.keyboard };
  }

  /**
   * Send one message that carries the menu keyboard and remember it as a card,
   * so the buttons of a message that was SENT work exactly like the buttons of
   * one that was edited: `text` defaults to the card's own text (a hint, or a
   * confirmation line, reuses the same keyboard).
   */
  async function sendMenu(chatId: number, text?: string): Promise<void> {
    const view = await menuView();
    const messageId = await send(chatId, text ?? view.text, view.keyboard);
    if (messageId !== undefined) putSnapshot(messageId, { kind: "menu", chatId });
  }

  /** Re-render the menu card into the message it lives in. */
  async function renderMenu(chatId: number, messageId: number, extended = false): Promise<void> {
    const view = await menuView({ extended });
    putSnapshot(messageId, { kind: "menu", chatId });
    await edit(chatId, messageId, view.text, view.keyboard);
  }

  /** Replace one message with `text` plus the current menu keyboard. */
  async function editWithMenu(chatId: number, messageId: number, text: string): Promise<void> {
    const view = await menuView();
    putSnapshot(messageId, { kind: "menu", chatId });
    await edit(chatId, messageId, text, view.keyboard);
  }

  /**
   * Cancel the active workspace's task and its queue. `undefined` means there is
   * no active workspace at all, which is a different answer than "nothing ran".
   */
  async function cancelActive(): Promise<{ cancelled: boolean; dropped: number } | undefined> {
    const ref = active;
    return ref === undefined ? undefined : deps.runner.cancel(ref);
  }

  /**
   * What to tell the owner after a stop, or `undefined` when the stop was a
   * no-op (nothing was running and nothing was queued). The session outlives
   * the stop on purpose: the copy says so.
   */
  function stopText(outcome: { cancelled: boolean; dropped: number }): string | undefined {
    if (!outcome.cancelled && outcome.dropped === 0) return undefined;
    const parts = [STOP_HINT];
    if (outcome.dropped > 0) parts.push(STOP_DROPPED(outcome.dropped));
    parts.push(STOP_CONTEXT_SAVED);
    return parts.join(" ");
  }

  /** Stop the active task as a text command: the owner gets a reply. */
  async function stopTask(chatId: number): Promise<void> {
    const outcome = await cancelActive();
    if (outcome === undefined) {
      await sendMenu(chatId, NO_ACTIVE_HINT);
      return;
    }
    await send(chatId, stopText(outcome) ?? STOP_IDLE_ANSWER);
  }

  /** Send the workspace list as a new message, snapshotted under its own id. */
  async function sendWorkspaces(chatId: number): Promise<void> {
    const view = await buildWorkspaceView(chatId, 0);
    if (view === undefined) {
      await sendMenu(chatId, LIST_FAILED);
      return;
    }
    const sentId = await send(chatId, view.text, view.keyboard);
    // The list is snapshotted under the id Telegram assigned to it, so its
    // first press already resolves the row the owner saw instead of answering
    // «Список устарел» on a list that was just rendered.
    if (sentId !== undefined) putSnapshot(sentId, view.snapshot);
  }

  /** Ask to reset the active context, as a new message (`/reset`). */
  async function sendResetConfirm(chatId: number): Promise<void> {
    const ref = active;
    if (ref === undefined) {
      await sendMenu(chatId, NO_ACTIVE_HINT);
      return;
    }
    const messageId = await send(chatId, RESET_CONFIRM, resetConfirmKeyboard());
    if (messageId !== undefined) putSnapshot(messageId, { kind: "reset", chatId, ref: copyRef(ref)! });
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
      await editWithMenu(chatId, messageId, LIST_FAILED);
      return;
    }
    putSnapshot(messageId, view.snapshot);
    await edit(chatId, messageId, view.text, view.keyboard);
  }

  /**
   * One page of the model picker, or `undefined` when there is no model surface
   * to render (not composed, or its read failed): the caller then answers with
   * the one honest text it has (`MODELS_UNAVAILABLE`).
   *
   * The card gets this page's slice with its global start index while the
   * snapshot keeps the whole list, so `mdl:c:<i>` is an index into what the
   * owner actually saw — paged by the chat's own list page size, never a second
   * one. A connection without a key is listed (the owner must be able to see it
   * exists) but labelled as unusable; opening it is refused where it is pressed.
   */
  async function buildConnectionsView(chatId: number, page: number): Promise<
    | {
        text: string;
        keyboard: InlineKeyboardMarkup;
        snapshot: ModelConnectionsSnapshot;
      }
    | undefined
  > {
    if (deps.models === undefined) return undefined;
    let rows: ModelConnectionRow[];
    try {
      rows = await deps.models.list();
    } catch (error) {
      warn(`models list failed (${codeOf(error)})`);
      return undefined;
    }
    const current = deps.models.current();
    const pages = Math.max(1, Math.ceil(rows.length / listPageSize));
    const currentPage = clampPage(page, pages);
    const start = currentPage * listPageSize;
    const visible = rows.slice(start, start + listPageSize).map((row, offset) => ({
      index: start + offset,
      label: row.hasKey ? row.displayName : `${row.displayName} (нет ключа)`,
      selectable: row.hasKey,
      isDefault: row.isDefault
    }));
    const card = modelConnectionsCard({
      currentLabel: `${current.model} · ${current.provider}`,
      rows: visible,
      page: currentPage,
      pages
    });
    return {
      text: card.text,
      keyboard: card.keyboard,
      snapshot: {
        kind: "modelConnections",
        chatId,
        rows: rows.map((row) => ({ ...row, models: [...row.models] })),
        page: currentPage,
        pages
      }
    };
  }

  /** Send the model picker as a new message, snapshotted under its own id. */
  async function sendModelsCard(chatId: number): Promise<void> {
    const view = await buildConnectionsView(chatId, 0);
    if (view === undefined) {
      await sendMenu(chatId, MODELS_UNAVAILABLE);
      return;
    }
    const sentId = await send(chatId, view.text, view.keyboard);
    // Snapshotted under the id Telegram assigned, so the picker's first press
    // already resolves the row the owner saw.
    if (sentId !== undefined) putSnapshot(sentId, view.snapshot);
  }

  /** Render (or re-render) the connection list into a known message. */
  async function renderConnections(chatId: number, messageId: number, page: number): Promise<void> {
    const view = await buildConnectionsView(chatId, page);
    if (view === undefined) {
      await editWithMenu(chatId, messageId, MODELS_UNAVAILABLE);
      return;
    }
    putSnapshot(messageId, view.snapshot);
    await edit(chatId, messageId, view.text, view.keyboard);
  }

  /**
   * Render one page of one connection's models. The models come from the
   * snapshot the owner's card was rendered from, sliced with the chat's own
   * page size and passed with the GLOBAL index of the slice's first row, so
   * `mdl:m:<i>` keeps pointing at the model the owner saw.
   *
   * The bullet marks the model in force, which is why it is only passed for the
   * connection the current default belongs to: a same-named model of another
   * connection is not the one running.
   */
  async function renderModelList(
    chatId: number,
    messageId: number,
    connection: { routeId: string; label: string; models: string[] },
    requestedPage: number
  ): Promise<void> {
    const pages = Math.max(1, Math.ceil(connection.models.length / listPageSize));
    const page = clampPage(requestedPage, pages);
    const start = page * listPageSize;
    const current = deps.models?.current();
    const card = modelListCard({
      // The card owns its copy and renders no page line of its own, so the page
      // is stated through its header — the same «Страница n/m» shape the
      // workspace and file listings use.
      label: withPageLine(connection.label, page, pages),
      models: connection.models.slice(start, start + listPageSize),
      startIndex: start,
      page,
      pages,
      ...(current !== undefined && current.provider === connection.routeId
        ? { currentModel: current.model }
        : {})
    });
    putSnapshot(messageId, {
      kind: "modelList",
      chatId,
      routeId: connection.routeId,
      label: connection.label,
      models: [...connection.models],
      page,
      pages
    });
    await edit(chatId, messageId, card.text, card.keyboard);
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
    await editWithMenu(chatId, messageId, `Не удалось открыть: ${openFailureReason(lastError)}.`);
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
    await sendMenu(chatId, `Выбран: ${refLabel(ref)}`);
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
    if (result.code === "cancelled") {
      // The owner stopped this task themselves: their own stop already answered
      // in the chat (Task 10 owns the receipt card), and a deliberate stop must
      // never be reported as an agent failure. Nothing is sent here.
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
      // The run is detached, so the owner may have switched workspaces while it
      // was in flight: clear the selection only while it still points at the
      // workspace the task ran in, otherwise keep the newer one (mirrors the
      // still-active guard of the reset confirmation).
      if (active !== undefined && workspaceRefKey(active) === workspaceRefKey(ref)) {
        applyActive(undefined);
      }
      await sendMenu(chatId, WORKSPACE_GONE);
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
    await editWithMenu(chatId, messageId, NO_ACTIVE_HINT);
  }

  /** Route one callback; the returned text (if any) is the callback answer. */
  async function dispatchCallback(update: CallbackUpdate): Promise<string | undefined> {
    const { chatId, messageId, data } = update;

    if (data === "mnu") {
      await renderMenu(chatId, messageId);
      return undefined;
    }
    if (data === "mnu:refresh") {
      await renderMenu(chatId, messageId, true);
      return undefined;
    }
    if (data === "stp") {
      const outcome = await cancelActive();
      const stopped = outcome === undefined ? undefined : stopText(outcome);
      // Nothing to stop is a toast, not a message: the owner pressed stop on a
      // chat that had no task, and the card they are looking at still holds.
      if (stopped === undefined) return STOP_IDLE_ANSWER;
      await send(chatId, stopped);
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
    if (data === "mdl") {
      await renderConnections(chatId, messageId, 0);
      return undefined;
    }
    if (data.startsWith("mdl:c:")) {
      const index = parseIndex(data.slice("mdl:c:".length));
      if (index === undefined) return STALE_ACTION;
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined || snapshot.kind !== "modelConnections") return STALE_ACTION;
      const row = snapshot.rows[index];
      if (row === undefined) return STALE_ACTION;
      // A connection without a key is listed but never opened: its models
      // cannot be used, and the press must not look like a step towards a save.
      if (!row.hasKey) return NO_KEY_HINT;
      await renderModelList(
        chatId,
        messageId,
        { routeId: row.routeId, label: row.displayName, models: row.models },
        0
      );
      return undefined;
    }
    if (data.startsWith("mdl:pg:")) {
      const page = parseIndex(data.slice("mdl:pg:".length));
      if (page === undefined) return STALE_ACTION;
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined) return STALE_ACTION;
      // Both model cards page with the same code, so the page is resolved by
      // the kind of list the pressed message is showing.
      if (snapshot.kind === "modelConnections") {
        await renderConnections(chatId, messageId, page);
        return undefined;
      }
      if (snapshot.kind === "modelList") {
        await renderModelList(chatId, messageId, snapshot, page);
        return undefined;
      }
      return STALE_ACTION;
    }
    if (data.startsWith("mdl:m:")) {
      const index = parseIndex(data.slice("mdl:m:".length));
      if (index === undefined) return STALE_ACTION;
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined || snapshot.kind !== "modelList") return STALE_ACTION;
      const model = snapshot.models[index];
      if (model === undefined || deps.models === undefined) return STALE_ACTION;
      // The connection and the model are read from the snapshot the card was
      // rendered from — never from the payload, which only carries an index.
      // The service re-reads its own connections before writing, so a
      // connection or model that vanished since then is rejected there and
      // reported here instead of being written silently.
      try {
        await deps.models.saveDefault(snapshot.routeId, model);
      } catch (error) {
        warn(`saving the default model failed (${codeOf(error)})`);
        return MODEL_SAVE_FAILED;
      }
      // The card the picker was opened from becomes the menu again, so the new
      // model shows in its «Модель:» line and no separate confirmation is sent.
      await renderMenu(chatId, messageId, true);
      return undefined;
    }
    if (data === "mdl:back") {
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined || snapshot.kind !== "modelList") return STALE_ACTION;
      await renderConnections(chatId, messageId, 0);
      return undefined;
    }
    if (data === "act:task") {
      const ref = active;
      if (ref === undefined) {
        await answerNoActive(chatId, messageId);
        return undefined;
      }
      // An older keyboard's «Задачи» press: the card it becomes says the same
      // thing and carries the actions, so no reply text is needed.
      await renderMenu(chatId, messageId, true);
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
        // Report the workspace the owner is on now (the message is edited back
        // into a card, not into the abandoned confirmation).
        const shown = active ?? snapshot.ref;
        await editWithMenu(chatId, messageId, `Выбран: ${refLabel(shown)}`);
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
      await editWithMenu(chatId, messageId, RESET_DONE);
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
      const text = update.text.trim();
      // The plain-text alias an older keyboard still sends: the list, not a task.
      if (text === WS_ALIAS) {
        await sendWorkspaces(update.chatId);
        return;
      }
      // Routed on the FIRST token only: `/ws my-name` is the workspace list, and
      // a path-looking text (`/etc/hosts …`) is an unknown command that never
      // reaches the agent.
      const command = parseCommand(text.split(/\s+/, 1)[0] ?? text);
      if (command !== undefined) {
        if (command === "unknown") {
          await send(update.chatId, UNKNOWN_COMMAND);
          await sendMenu(update.chatId);
          return;
        }
        if (command === "help") {
          await send(update.chatId, HELP_TEXT);
          return;
        }
        if (command === "menu" || command === "status") {
          await sendMenu(update.chatId);
          return;
        }
        if (command === "ws") {
          await sendWorkspaces(update.chatId);
          return;
        }
        if (command === "model") {
          await sendModelsCard(update.chatId);
          return;
        }
        if (command === "reset") {
          await sendResetConfirm(update.chatId);
          return;
        }
        await stopTask(update.chatId);
        return;
      }
      const ref = active;
      // A blank message carries no task; the card answers with the live state.
      if (text === "") {
        await sendMenu(update.chatId);
        return;
      }
      if (ref === undefined) {
        await sendMenu(update.chatId, NO_ACTIVE_HINT);
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
