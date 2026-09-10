import { describe, expect, it } from "vitest";
import {
  fileKeyboard,
  listingKeyboard,
  menuKeyboard,
  paginationRow,
  resetConfirmKeyboard,
  workspaceActionsKeyboard,
  workspacesKeyboard
} from "../src/keyboards.js";

/**
 * Pure unit suite for the inline-keyboard builders: no I/O, no bot client.
 * Every assertion is about the wire shape Telegram receives (rows of buttons
 * with short callback codes) and about the pagination clamps.
 */

function data(markup: { inline_keyboard: Array<Array<{ callback_data: string }>> }): string[] {
  return markup.inline_keyboard.flat().map((button) => button.callback_data);
}

describe("keyboard builders", () => {
  it("menuKeyboard carries the single ws code", () => {
    expect(menuKeyboard()).toEqual({ inline_keyboard: [[{ text: "Воркспейсы", callback_data: "ws" }]] });
  });

  it("workspaceActionsKeyboard carries the four active-workspace actions", () => {
    expect(data(workspaceActionsKeyboard())).toEqual(["act:task", "act:files", "act:reset", "act:ws"]);
  });

  it("resetConfirmKeyboard carries reset:yes and reset:no", () => {
    expect(data(resetConfirmKeyboard())).toEqual(["reset:yes", "reset:no"]);
  });

  it("workspacesKeyboard renders one row per workspace with global indices", () => {
    const markup = workspacesKeyboard({
      rows: [
        { index: 0, label: "Дом агента" },
        { index: 1, label: "Проект: alpha" }
      ],
      page: 0,
      pages: 1
    });

    expect(markup.inline_keyboard).toEqual([
      [{ text: "Дом агента", callback_data: "ws:pick:0" }],
      [{ text: "Проект: alpha", callback_data: "ws:pick:1" }]
    ]);
  });

  it("workspacesKeyboard adds ws:pg arrows only when there are several pages", () => {
    const rows = [{ index: 0, label: "Дом агента" }];
    expect(data(workspacesKeyboard({ rows, page: 0, pages: 1 }))).toEqual(["ws:pick:0"]);

    const paged = workspacesKeyboard({
      rows: [{ index: 8, label: "Проект: i" }],
      page: 1,
      pages: 2
    });
    expect(paged.inline_keyboard.at(-1)).toEqual([
      { text: "◀", callback_data: "ws:pg:0" },
      { text: "▶", callback_data: "ws:pg:1" }
    ]);
  });

  it("paginationRow clamps both arrows to the available pages", () => {
    expect(paginationRow("pg", 0, 3)).toEqual([
      { text: "◀", callback_data: "pg:0" },
      { text: "▶", callback_data: "pg:1" }
    ]);
    expect(paginationRow("pg", 2, 3)).toEqual([
      { text: "◀", callback_data: "pg:1" },
      { text: "▶", callback_data: "pg:2" }
    ]);
    expect(paginationRow("ws:pg", 5, 1)).toEqual([
      { text: "◀", callback_data: "ws:pg:0" },
      { text: "▶", callback_data: "ws:pg:0" }
    ]);
  });

  it("listingKeyboard labels every kind and suffixes links", () => {
    const markup = listingKeyboard({
      entries: [
        { index: 0, name: "src", kind: "dir" },
        { index: 1, name: "notes.txt", kind: "file" },
        { index: 2, name: "shortcut", kind: "link" }
      ],
      page: 0,
      pages: 1,
      withUp: false
    });

    expect(markup.inline_keyboard.map((row) => row[0]!.text)).toEqual([
      "📁 src",
      "📄 notes.txt",
      "🔗 shortcut (ссылка)"
    ]);
    expect(data(markup)).toEqual(["e:0", "e:1", "e:2"]);
  });

  it("listingKeyboard adds the parent row and pagination rows when asked", () => {
    const markup = listingKeyboard({
      entries: [{ index: 2, name: "a.txt", kind: "file" }],
      page: 1,
      pages: 2,
      withUp: true
    });

    expect(data(markup)).toEqual(["e:2", "up", "pg:0", "pg:1"]);
    expect(markup.inline_keyboard.at(-2)).toEqual([{ text: "⬆ вверх", callback_data: "up" }]);
  });

  it("listingKeyboard of an empty root produces no rows", () => {
    expect(listingKeyboard({ entries: [], page: 0, pages: 1, withUp: false })).toEqual({ inline_keyboard: [] });
  });

  it("fileKeyboard offers «Дальше» only while more text remains", () => {
    expect(data(fileKeyboard({ page: 0, hasMore: true }))).toEqual(["pg:1", "up"]);
    expect(data(fileKeyboard({ page: 1, hasMore: false }))).toEqual(["up"]);
    expect(fileKeyboard({ page: 0, hasMore: true }).inline_keyboard[0]![0]!.text).toBe("Дальше");
    expect(fileKeyboard({ page: 1, hasMore: false }).inline_keyboard[0]![0]!.text).toBe("⬆ назад к списку");
  });
});
