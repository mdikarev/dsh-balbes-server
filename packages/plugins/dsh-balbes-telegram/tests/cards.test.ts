import { describe, expect, it } from "vitest";
import {
  TASK_IDLE_LINE,
  formatElapsed,
  menuCard,
  modelConnectionsCard,
  modelListCard,
  progressCard,
  queuedCard,
  receiptCard
} from "../src/cards.js";

const data = (card: { keyboard: { inline_keyboard: Array<Array<{ callback_data: string }>> } }): string[] =>
  card.keyboard.inline_keyboard.flat().map((button) => button.callback_data);

describe("formatElapsed", () => {
  it("renders m:ss below an hour and h:mm:ss above", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(134_000)).toBe("2:14");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  it("pads the seconds of a sub-hour value and never goes negative", () => {
    expect(formatElapsed(61_000)).toBe("1:01");
    expect(formatElapsed(3_599_000)).toBe("59:59");
    expect(formatElapsed(-1)).toBe("0:00");
  });
});

describe("menuCard", () => {
  it("shows workspace, model, task line and the action grid", () => {
    const card = menuCard({
      workspaceLabel: "Проект: balbes",
      modelLabel: "deepseek-v4-pro · deepseek-official",
      taskLine: "выполняется · 2:14 · шаг 5",
      queue: 1
    });

    expect(card.text).toContain("🤖 Агент сервера");
    expect(card.text).toContain("Воркспейс: Проект: balbes");
    expect(card.text).toContain("Модель: deepseek-v4-pro · deepseek-official");
    expect(card.text).toContain("Задача: выполняется · 2:14 · шаг 5");
    expect(card.text).toContain("Очередь: 1");
    expect(data(card)).toEqual(["act:files", "mdl", "ws", "act:reset", "stp", "mnu:refresh"]);
  });

  it("offers only workspace and model buttons without an active workspace", () => {
    const card = menuCard({ workspaceLabel: undefined, modelLabel: undefined, taskLine: "нет активной задачи", queue: 0 });

    expect(card.text).toContain("Воркспейс не выбран");
    expect(data(card)).toEqual(["ws", "mdl", "mnu:refresh"]);
  });

  it("keeps the idle card free of stray lines or a zero queue", () => {
    const card = menuCard({ workspaceLabel: undefined, modelLabel: undefined, taskLine: TASK_IDLE_LINE, queue: 0 });

    expect(card.text).toBe("🤖 Агент сервера\n\nВоркспейс не выбран\nЗадача: нет активной задачи");
  });

  it("states the session only when the caller knows it", () => {
    const card = menuCard({
      workspaceLabel: "Проект: balbes",
      modelLabel: undefined,
      taskLine: TASK_IDLE_LINE,
      queue: 2,
      sessionLabel: "активна"
    });

    expect(card.text).toContain("Сессия: активна");
    expect(card.text).toContain("Очередь: 2");
    expect(card.text).not.toContain("Модель:");
  });
});

describe("model cards", () => {
  it("marks the current connection and refuses the keyless one", () => {
    const card = modelConnectionsCard({
      currentLabel: "deepseek-v4-pro · deepseek-official",
      rows: [
        { index: 0, label: "DeepSeek (официальный)", selectable: true, isDefault: true },
        { index: 1, label: "OpenAI (нет ключа)", selectable: false, isDefault: false }
      ],
      page: 0,
      pages: 1
    });

    expect(data(card)).toEqual(["mdl:c:0", "mdl:c:1", "mnu"]);
    expect(card.keyboard.inline_keyboard[0]![0]!.text).toContain("• ");
    expect(card.keyboard.inline_keyboard[1]![0]!.text).toContain("нет ключа");
  });

  it("pages a long model list and marks the active model", () => {
    const models = Array.from({ length: 10 }, (_, i) => `m-${i}`);
    const card = modelListCard({ label: "DeepSeek (официальный)", models, page: 1, pages: 2, currentModel: "m-8" });

    expect(data(card)).toEqual(["mdl:m:8", "mdl:m:9", "mdl:pg:0", "mdl:pg:1", "mdl:back"]);
    expect(card.keyboard.inline_keyboard[0]![0]!.text).toContain("• m-8");
  });

  it("pages the connection list and omits the current model when none is known", () => {
    const card = modelConnectionsCard({
      currentLabel: undefined,
      rows: [{ index: 0, label: "DeepSeek (официальный)", selectable: true, isDefault: false }],
      page: 0,
      pages: 3
    });

    expect(data(card)).toEqual(["mdl:c:0", "mdl:pg:0", "mdl:pg:1", "mnu"]);
    expect(card.text).toBe("🧠 Модель\n\nВыберите соединение:");
  });
});

describe("progressCard", () => {
  it("renders todos, steps and the stop/menu row", () => {
    const card = progressCard({
      workspaceLabel: "Проект: balbes",
      taskText: "починить парсер",
      elapsedMs: 72_000,
      step: 4,
      steps: [
        { name: "read", target: "notes.txt", status: "ok" },
        { name: "grep", target: "TODO", status: "ok" },
        { name: "edit", target: "notes.txt", status: "running" }
      ],
      todos: [
        { content: "Разобрать логи", status: "completed" },
        { content: "Починить парсер", status: "in_progress" }
      ],
      queued: 0
    });

    expect(card.text).toContain("⏳ Проект: balbes · 1:12 · шаг 4");
    expect(card.text).toContain("☑ Разобрать логи");
    expect(card.text).toContain("▸ Починить парсер");
    expect(card.text).toContain("🔧 edit notes.txt …");
    expect(card.text).toContain("🔧 read notes.txt ✔");
    expect(data(card)).toEqual(["stp", "mnu"]);
  });

  it("never renders a tool result body", () => {
    const card = progressCard({
      workspaceLabel: "Проект: balbes",
      taskText: "t",
      elapsedMs: 1000,
      steps: [{ name: "grep", status: "ok" }],
      queued: 0
    });

    expect(card.text).toContain("🔧 grep ✔");
  });

  it("marks a failed step, a pending todo and a non-empty queue", () => {
    const card = progressCard({
      workspaceLabel: "Проект: balbes",
      taskText: "t",
      elapsedMs: 1000,
      steps: [{ name: "edit", target: "notes.txt", status: "failed" }],
      todos: [{ content: "Дописать тесты", status: "pending" }],
      queued: 2
    });

    expect(card.text).toContain("🔧 edit notes.txt ✖");
    expect(card.text).toContain("☐ Дописать тесты");
    expect(card.text).toContain("Очередь: 2");
  });
});

describe("queuedCard", () => {
  it("states the task's place in the queue and offers stop", () => {
    const card = queuedCard({ workspaceLabel: "Проект: balbes", taskText: "вторая", position: 2 });

    expect(card.text).toContain("🕓 Проект: balbes");
    expect(card.text).toContain("в очереди №2");
    expect(card.text).toContain("вторая");
    expect(data(card)).toEqual(["stp", "mnu"]);
  });
});

describe("receiptCard", () => {
  it("replaces the stop row with a menu row and states the outcome", () => {
    expect(receiptCard({ kind: "done", elapsedMs: 100_000, steps: 6 }).text).toBe("✅ Готово · 1:40 · 6 шагов");
    expect(receiptCard({ kind: "stopped", elapsedMs: 10_000, steps: 2 }).text).toBe("⏹ Остановлено владельцем · 0:10");
    expect(receiptCard({ kind: "reset", elapsedMs: 10_000, steps: 2 }).text).toBe("⏹ Остановлено сбросом контекста");
    expect(receiptCard({ kind: "error", elapsedMs: 10_000, steps: 2 }).text).toBe("⚠️ Ошибка · 0:10");
    expect(data(receiptCard({ kind: "done", elapsedMs: 1, steps: 0 }))).toEqual(["mnu"]);
  });

  it("appends the failure detail to an error and nothing else", () => {
    expect(receiptCard({ kind: "error", elapsedMs: 1000, steps: 1, detail: "таймаут" }).text).toBe(
      "⚠️ Ошибка · 0:01: таймаут"
    );
    expect(receiptCard({ kind: "stopped", elapsedMs: 1000, steps: 1, detail: "таймаут" }).text).toBe(
      "⏹ Остановлено владельцем · 0:01"
    );
  });
});
