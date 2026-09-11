import { describe, expect, it } from "vitest";
import {
  HELP_TEXT,
  MAX_TODO_LINES,
  MAX_TODO_LINE_CHARS,
  TASK_IDLE_LINE,
  formatElapsed,
  menuCard,
  modelConnectionsCard,
  modelListCard,
  pluralRu,
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

describe("pluralRu", () => {
  const step = (n: number): string => pluralRu(n, "шаг", "шага", "шагов");

  it("picks the form by the last digit: 1 шаг, 2 шага, 5 шагов", () => {
    expect(step(1)).toBe("шаг");
    expect(step(2)).toBe("шага");
    expect(step(3)).toBe("шага");
    expect(step(4)).toBe("шага");
    expect(step(5)).toBe("шагов");
    expect(step(0)).toBe("шагов");
  });

  it("keeps the 11–14 exception and resumes counting after it", () => {
    expect(step(11)).toBe("шагов");
    expect(step(12)).toBe("шагов");
    expect(step(13)).toBe("шагов");
    expect(step(14)).toBe("шагов");
    expect(step(15)).toBe("шагов");
    expect(step(21)).toBe("шаг");
    expect(step(22)).toBe("шага");
    expect(step(25)).toBe("шагов");
    expect(step(101)).toBe("шаг");
    expect(step(111)).toBe("шагов");
  });
});

describe("HELP_TEXT", () => {
  it("names every command and states what happens to other text accurately", () => {
    for (const command of ["/menu", "/status", "/ws", "/model", "/reset", "/stop", "/help"]) {
      expect(HELP_TEXT).toContain(command);
    }
    // The old line promised that ANY other text reaches the agent as a task,
    // which is untrue twice over: the alias word opens the list, and with no
    // workspace selected the text is answered with the hint instead.
    expect(HELP_TEXT).toContain(
      "Прочий текст — задача агенту (нужен воркспейс; «Воркспейсы» — список)."
    );
    expect(HELP_TEXT).not.toContain("Любой другой текст уходит агенту как задача.");
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

  it("renders the caller's slice with absolute model codes and marks the active model", () => {
    const models = Array.from({ length: 10 }, (_, i) => `m-${i}`);
    const card = modelListCard({
      label: "DeepSeek (официальный)",
      models: models.slice(8, 10),
      startIndex: 8,
      page: 1,
      pages: 2,
      currentModel: "m-8"
    });

    expect(data(card)).toEqual(["mdl:m:8", "mdl:m:9", "mdl:pg:0", "mdl:pg:1", "mdl:back"]);
    expect(card.keyboard.inline_keyboard[0]![0]!.text).toContain("• m-8");
  });

  it("never slices: it renders exactly the models and start index the caller passed", () => {
    const card = modelListCard({
      label: "DeepSeek (официальный)",
      models: ["m-4", "m-5", "m-6"],
      startIndex: 4,
      page: 0,
      pages: 1
    });

    expect(data(card)).toEqual(["mdl:m:4", "mdl:m:5", "mdl:m:6", "mdl:back"]);
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

  /**
   * The agent writes the plan, so both its length and its line count are
   * unbounded input on a surface with a hard message limit: an unbounded card
   * is one Telegram refuses to edit, and the three-failure rule then freezes it
   * for the rest of the task.
   */
  it("clamps a verbose todo list to a bounded number of lines", () => {
    const todos = Array.from({ length: 40 }, (_, i) => ({
      content: `пункт ${i + 1}`,
      status: "pending" as const
    }));

    const card = progressCard({
      workspaceLabel: "Проект: balbes",
      taskText: "t",
      elapsedMs: 1000,
      steps: [],
      todos,
      queued: 0
    });

    const lines = card.text.split("\n").filter((line) => line.startsWith("☐ "));
    expect(lines).toHaveLength(MAX_TODO_LINES);
    expect(lines[0]).toBe("☐ пункт 1");
    // The truncation is stated, never silent, and is itself one bounded line.
    expect(card.text).toContain(`…и ещё ${todos.length - MAX_TODO_LINES}`);
    expect(card.text.length).toBeLessThan(4096);
  });

  it("clamps ONE todo line: newlines collapse and the line is cut with an ellipsis", () => {
    const card = progressCard({
      workspaceLabel: "Проект: balbes",
      taskText: "t",
      elapsedMs: 1000,
      steps: [],
      todos: [{ content: `${"я".repeat(500)}\n\nвторая строка плана`, status: "in_progress" }],
      queued: 0
    });

    const todoLines = card.text.split("\n").filter((line) => line.startsWith("▸ "));
    expect(todoLines).toHaveLength(1);
    // The mark plus the bounded content plus the ellipsis, nothing more.
    expect(todoLines[0]).toHaveLength(MAX_TODO_LINE_CHARS + 3);
    expect(todoLines[0]!.endsWith("…")).toBe(true);
    expect(card.text).not.toContain("вторая строка плана");
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

  it("counts the steps in Russian: 1 шаг, 2 шага, 5 шагов", () => {
    expect(receiptCard({ kind: "done", elapsedMs: 1000, steps: 1 }).text).toBe("✅ Готово · 0:01 · 1 шаг");
    expect(receiptCard({ kind: "done", elapsedMs: 1000, steps: 2 }).text).toBe("✅ Готово · 0:01 · 2 шага");
    expect(receiptCard({ kind: "done", elapsedMs: 1000, steps: 3 }).text).toBe("✅ Готово · 0:01 · 3 шага");
    expect(receiptCard({ kind: "done", elapsedMs: 1000, steps: 5 }).text).toBe("✅ Готово · 0:01 · 5 шагов");
    expect(receiptCard({ kind: "done", elapsedMs: 1000, steps: 11 }).text).toBe("✅ Готово · 0:01 · 11 шагов");
    expect(receiptCard({ kind: "done", elapsedMs: 1000, steps: 21 }).text).toBe("✅ Готово · 0:01 · 21 шаг");
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
