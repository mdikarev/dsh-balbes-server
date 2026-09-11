/**
 * Pure builders of the owner's cards: every function returns the exact text and
 * inline keyboard one message needs. No I/O, no bot client, no state — the chat
 * machine owns snapshots and dispatch, this module owns copy and layout.
 */
import type { TaskProgressStep, TaskProgressTodo } from "./agentTask.js";
import { menuRow, paginationRow } from "./keyboards.js";
import type { InlineKeyboardMarkup } from "./keyboards.js";

export interface CardView {
  text: string;
  keyboard: InlineKeyboardMarkup;
}

export const MENU_TITLE = "🤖 Агент сервера";
export const TASK_IDLE_LINE = "нет активной задачи";
export const NO_ACTIVE_WORKSPACE_LINE = "Воркспейс не выбран";
export const STOP_IDLE_ANSWER = "Сейчас ничего не выполняется";
export const MODEL_HINT = "Смена применится со следующего шага; текущий шаг доигрывает на прежней модели.";
export const NO_KEY_HINT = "Ключ не задан — добавьте в админке";
export const MODELS_UNAVAILABLE = "Раздел моделей недоступен";
export const UNKNOWN_COMMAND = "Не знаю такой команды.";
export const HELP_TEXT = [
  "/menu — меню и состояние",
  "/status — воркспейс, модель, задача, очередь",
  "/ws — сменить воркспейс",
  "/model — сменить модель",
  "/reset — сбросить контекст (сессия удаляется)",
  "/stop — остановить задачу (контекст сохраняется)",
  "/help — эта справка.",
  // Accurate, and no longer a promise the chat does not keep: the alias word
  // opens the workspace list instead of running, and text with no workspace
  // selected is answered with the hint, never handed to the agent.
  "Прочий текст — задача агенту (нужен воркспейс; «Воркспейсы» — список)."
].join("\n");

/** `m:ss` below one hour, `h:mm:ss` above. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * The Russian form of the counted noun: `pluralRu(1, "шаг", "шага", "шагов")`
 * is «шаг», 2 → «шага», 5 → «шагов». The 11–14 range takes the "many" form
 * whatever its last digit («11 шагов», «12 шагов»), while 21/22/25 follow the
 * last digit again («21 шаг», «22 шага») — the exception a bare `% 10` gets
 * wrong. Counts are taken by absolute value, so a negative never parses as 1.
 */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(Math.trunc(count));
  if (Number.isNaN(n)) return many;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

const REFRESH_ROW = [{ text: "🔄 Обновить", callback_data: "mnu:refresh" }];

export function menuCard(opts: {
  workspaceLabel: string | undefined;
  modelLabel: string | undefined;
  taskLine: string;
  queue: number;
  sessionLabel?: string;
}): CardView {
  const lines = [MENU_TITLE, ""];
  lines.push(opts.workspaceLabel === undefined ? NO_ACTIVE_WORKSPACE_LINE : `Воркспейс: ${opts.workspaceLabel}`);
  if (opts.modelLabel !== undefined) lines.push(`Модель: ${opts.modelLabel}`);
  lines.push(`Задача: ${opts.taskLine}`);
  if (opts.sessionLabel !== undefined) lines.push(`Сессия: ${opts.sessionLabel}`);
  if (opts.queue > 0) lines.push(`Очередь: ${opts.queue}`);
  const rows = opts.workspaceLabel === undefined
    ? [
        [{ text: "📁 Воркспейсы", callback_data: "ws" }],
        [{ text: "🧠 Модель", callback_data: "mdl" }],
        REFRESH_ROW
      ]
    : [
        [
          { text: "📄 Файлы", callback_data: "act:files" },
          { text: "🧠 Модель", callback_data: "mdl" }
        ],
        [
          { text: "📁 Воркспейс", callback_data: "ws" },
          { text: "🔄 Сбросить контекст", callback_data: "act:reset" }
        ],
        [
          { text: "⏹ Стоп", callback_data: "stp" },
          ...REFRESH_ROW
        ]
      ];
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}

export function modelConnectionsCard(opts: {
  currentLabel: string | undefined;
  rows: Array<{ index: number; label: string; selectable: boolean; isDefault: boolean }>;
  page: number;
  pages: number;
}): CardView {
  const header = opts.currentLabel === undefined
    ? "🧠 Модель"
    : `🧠 Модель сейчас: ${opts.currentLabel}`;
  const lines = [header, "", "Выберите соединение:"];
  const rows = opts.rows.map((row) => [
    { text: `${row.isDefault ? "• " : ""}${row.label}`, callback_data: `mdl:c:${row.index}` }
  ]);
  if (opts.pages > 1) rows.push(paginationRow("mdl:pg", opts.page, opts.pages));
  rows.push(menuRow());
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}

export function modelListCard(opts: {
  label: string;
  /** The page's models, in order (the caller pages; the card never slices). */
  models: string[];
  /** Global index of models[0], so callback codes stay absolute. */
  startIndex: number;
  page: number;
  pages: number;
  currentModel?: string;
}): CardView {
  const rows = opts.models.map((model, offset) => [
    { text: `${opts.currentModel === model ? "• " : ""}${model}`, callback_data: `mdl:m:${opts.startIndex + offset}` }
  ]);
  if (opts.pages > 1) rows.push(paginationRow("mdl:pg", opts.page, opts.pages));
  rows.push([{ text: "⬅ Назад", callback_data: "mdl:back" }]);
  return {
    text: [`🧠 ${opts.label}`, "", "Выберите модель:", MODEL_HINT].join("\n"),
    keyboard: { inline_keyboard: rows }
  };
}

const STEP_MARK: Record<TaskProgressStep["status"], string> = { running: "…", ok: "✔", failed: "✖" };
const TODO_MARK: Record<TaskProgressTodo["status"], string> = { completed: "☑", in_progress: "▸", pending: "☐" };

/**
 * How many todo lines a live card renders at most, and how long one of them may
 * be. The agent writes BOTH the number of todos and their text, so without a
 * ceiling a verbose plan grows the card past Telegram's message limit — and a
 * card that cannot be edited is frozen by the three-failure rule, which costs
 * the owner the receipt too. Bounded here, the card renders at any plan size.
 */
export const MAX_TODO_LINES = 10;
export const MAX_TODO_LINE_CHARS = 100;

/** One agent-written line: whitespace collapsed (its own newlines included) and cut. */
function clampCardLine(line: string, max: number): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  // Never cut a surrogate pair in half: half a pair is not sendable text.
  const last = collapsed.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return `${collapsed.slice(0, end)}…`;
}

export function progressCard(opts: {
  workspaceLabel: string;
  taskText: string;
  elapsedMs: number;
  step?: number;
  steps: TaskProgressStep[];
  todos?: TaskProgressTodo[];
  queued: number;
}): CardView {
  const head = `⏳ ${opts.workspaceLabel} · ${formatElapsed(opts.elapsedMs)}${opts.step === undefined ? "" : ` · шаг ${opts.step}`}`;
  const lines = [head];
  if (opts.todos !== undefined && opts.todos.length > 0) {
    // Both ends are capped: the plan of a long task may be dozens of items long
    // and any single item may be a paragraph. The hidden count is stated rather
    // than silently dropped.
    const shown = opts.todos.slice(0, MAX_TODO_LINES);
    lines.push(
      "",
      ...shown.map((todo) => `${TODO_MARK[todo.status]} ${clampCardLine(todo.content, MAX_TODO_LINE_CHARS)}`)
    );
    const hidden = opts.todos.length - shown.length;
    if (hidden > 0) lines.push(`…и ещё ${hidden}`);
  }
  if (opts.steps.length > 0) {
    lines.push("", ...opts.steps.map((step) => `🔧 ${step.name}${step.target === undefined ? "" : ` ${step.target}`} ${STEP_MARK[step.status]}`));
  }
  if (opts.queued > 0) lines.push("", `Очередь: ${opts.queued}`);
  return {
    text: lines.join("\n"),
    keyboard: { inline_keyboard: [[{ text: "⏹ Стоп", callback_data: "stp" }, ...menuRow()]] }
  };
}

/**
 * A task accepted while another one runs: the card states its place in the
 * queue and carries the same stop button, so the owner can cancel before the
 * task ever starts. The chat replaces it with a live progress card once this
 * task's own turn begins.
 */
export function queuedCard(opts: { workspaceLabel: string; taskText: string; position: number }): CardView {
  return {
    text: [`🕓 ${opts.workspaceLabel} · в очереди №${opts.position}`, "", opts.taskText].join("\n"),
    keyboard: { inline_keyboard: [[{ text: "⏹ Стоп", callback_data: "stp" }, ...menuRow()]] }
  };
}

export function receiptCard(opts: {
  kind: "done" | "stopped" | "reset" | "error";
  elapsedMs: number;
  steps: number;
  detail?: string;
}): CardView {
  const elapsed = formatElapsed(opts.elapsedMs);
  const text =
    opts.kind === "done"
      ? `✅ Готово · ${elapsed} · ${opts.steps} ${pluralRu(opts.steps, "шаг", "шага", "шагов")}`
      : opts.kind === "stopped"
        ? `⏹ Остановлено владельцем · ${elapsed}`
        : opts.kind === "reset"
          ? "⏹ Остановлено сбросом контекста"
          : `⚠️ Ошибка · ${elapsed}${opts.detail === undefined ? "" : `: ${opts.detail}`}`;
  return { text, keyboard: { inline_keyboard: [menuRow()] } };
}
