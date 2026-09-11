/**
 * Pure builders for the owner chat's inline keyboards.
 *
 * The Telegram callback protocol is short-code only: buttons never carry a
 * path or a name, just an operation code plus an index into a snapshot the
 * machine keeps in memory (`ws:pick:<i>`, `e:<i>`, `pg:<n>`, ...). Everything
 * here is a pure function of its arguments — no I/O, no bot client — so the
 * wire shape of every keyboard is unit-testable on its own.
 */

/** One inline button, always actioned through a short callback code. */
export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** The `reply_markup` object the Bot API expects for an inline keyboard. */
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

const PREV_LABEL = "◀";
const NEXT_LABEL = "▶";
const UP_LABEL = "⬆ вверх";
const NEXT_PAGE_LABEL = "Дальше";
const BACK_TO_LIST_LABEL = "⬆ назад к списку";

/**
 * The «◀ ▶» row of a paged view. Both arrows are always rendered (the owner
 * keeps a stable layout) and each points at a page clamped into range, so an
 * arrow at an edge is a harmless re-render of the current page instead of a
 * callback the machine would have to reject.
 */
export function paginationRow(prefix: string, page: number, pages: number): InlineKeyboardButton[] {
  const last = Math.max(0, pages - 1);
  const current = Math.min(Math.max(0, page), last);
  const prev = Math.max(0, current - 1);
  const next = Math.min(last, current + 1);
  return [
    { text: PREV_LABEL, callback_data: `${prefix}:${prev}` },
    { text: NEXT_LABEL, callback_data: `${prefix}:${next}` }
  ];
}

/** One workspace row as rendered on a page: the index is global, not page-local. */
export interface WorkspaceRowButton {
  index: number;
  label: string;
}

/** The workspace list: one button per row plus the pagination row. */
export function workspacesKeyboard(opts: {
  rows: WorkspaceRowButton[];
  page: number;
  pages: number;
}): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = opts.rows.map((row) => [
    { text: row.label, callback_data: `ws:pick:${row.index}` }
  ]);
  if (opts.pages > 1) rows.push(paginationRow("ws:pg", opts.page, opts.pages));
  return { inline_keyboard: rows };
}

/** One directory-listing row: index into the listing snapshot plus its kind. */
export interface ListingEntryButton {
  index: number;
  name: string;
  kind: "dir" | "file" | "link";
}

/**
 * The file-tree listing. A link keeps a button (Telegram requires an action
 * field on an inline button, so an action-less "disabled" row would make the
 * whole keyboard invalid) but is labelled with the «(ссылка)» suffix; the
 * machine answers that press with a metadata refusal and never reads through
 * the link.
 */
export function listingKeyboard(opts: {
  entries: ListingEntryButton[];
  page: number;
  pages: number;
  withUp: boolean;
}): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = opts.entries.map((entry) => [
    { text: entryLabel(entry), callback_data: `e:${entry.index}` }
  ]);
  if (opts.withUp) rows.push([{ text: UP_LABEL, callback_data: "up" }]);
  if (opts.pages > 1) rows.push(paginationRow("pg", opts.page, opts.pages));
  return { inline_keyboard: rows };
}

function entryLabel(entry: ListingEntryButton): string {
  if (entry.kind === "dir") return `📁 ${entry.name}`;
  if (entry.kind === "link") return `🔗 ${entry.name} (ссылка)`;
  return `📄 ${entry.name}`;
}

/**
 * The keyboard of one file page: «Дальше» while more text remains (wrapping to
 * the truncation note page when the read was cut short) and always the way back
 * to the listing the file was opened from.
 */
export function fileKeyboard(opts: { page: number; hasMore: boolean }): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  if (opts.hasMore) rows.push([{ text: NEXT_PAGE_LABEL, callback_data: `pg:${opts.page + 1}` }]);
  rows.push([{ text: BACK_TO_LIST_LABEL, callback_data: "up" }]);
  return { inline_keyboard: rows };
}

/** The context-reset confirmation. */
export function resetConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Да, сбросить", callback_data: "reset:yes" },
        { text: "Отмена", callback_data: "reset:no" }
      ]
    ]
  };
}
