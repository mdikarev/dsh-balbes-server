# Апрувы из Telegram — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Владелец получает в Telegram запрос на подтверждение гейтованной операции (sandbox-эскалация bash и прочие штатные approval) и даёт одноразовое решение кнопкой; без ответа — fail-closed.

**Architecture:** Новый модуль approvals.ts владеет реестром pending и callback-протоколом ap:\<id\>:y|n. Answerer вешается agent-scoped листенером approval/request в setup раннера (там же, где installModelSelection вешает agent/request). index.ts роутит callback-код ap: в gate до машины чата; cards/keyboards дают карточку; chat показывает ожидание в живом прогрессе.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Cordis-плагины dsh, vitest.

**Spec:** docs/superpowers/specs/2026-09-24-telegram-approvals-design.md

## Global Constraints

- dsh — зависимость, не форк: @deepseek-ai/* не редактируются; только штатные швы.
- docs/canon/** не редактируется вручную — только через canon-write / canon-future-plan / canon-audit.
- После существенных правок canon — STOP и ждать явного go-ahead владельца перед кодом.
- Функциональное изменение серверной поверхности правит docs/runbooks/stage2-vps.md в том же коммите.
- ESM only, относительные импорты внутри пакета — с расширением .js; strict TS, exactOptionalPropertyTypes, noUncheckedIndexedAccess.
- UI-копия на русском; стиль текстов — существующий.
- Автотесты не ходят в модель (R-TEST-1); REAL-тесты за гейтом RUN_REAL=1.
- Каждая задача завершается зелёными typecheck/тестами и коммитом.
- Никаких новых HTTP-ручек, настроек и SPA-правок: всегда включено, тайм-аут — константа.

---

### Task 1: Canon-first — живые секции и статус инициативы

**Files:**
- Modify (через skill canon-write, не вручную): docs/canon/ARCHITECTURE.md, docs/canon/GLOSSARY.md, docs/canon/OVERVIEW.md
- Modify (через canon-future-plan): docs/canon/future_plans/p9-telegram-approvals.md, docs/canon/future_plans/INDEX.md

**Interfaces:**
- Consumes: spec docs/superpowers/specs/2026-09-24-telegram-approvals-design.md.
- Produces: живой SoT approval-answerer'а канала, на который опираются задачи 2–9.

- [ ] **Step 1: Вызвать skill canon-write**

  - ARCHITECTURE.md — в разделе Telegram-канала описать approval-answerer: канал принимает approval/request своих агентов (agent-scoped dispatch), доставляет владельцу сообщение с инструментом, reason и меткой воркспейса, возвращает allowed-once/rejected/cancelled/unavailable; тайм-аут 5 минут без ответа даёт rejected; недоставка вопроса даёт unavailable; уточнить безусловное «гейтованная операция без интерактивного отвечающего отклоняется» для канала (теперь отвечающий — владелец, fail-closed сохраняется при неответе).
  - GLOSSARY.md — термины «approval-answerer канала» и «approval-запрос в Telegram»; уточнить статью «Telegram-канал».
  - OVERVIEW.md — в составе Telegram-канала добавить «запрос подтверждений у владельца (одноразовые гранты)».
  - API_CONTRACTS.md и ADMIN_UI.md — не меняются: новых ручек и настроек нет.

- [ ] **Step 2: Вызвать skill canon-future-plan** для p9-telegram-approvals.md: status draft → implementing; закрыть открытые вопросы решением из spec (только кнопки; тайм-аут-константа 5 мин; показываем инструмент + reason + метку воркспейса + эхо задачи; несколько параллельных pending; /stop отзывает запрос; in-memory; single-owner); синхронизировать INDEX.md.

- [ ] **Step 3: Проверить canon**

Run: doc-canon scout 'telegram approval answerer'

Expected: в выдаче — обновлённые ARCHITECTURE.md / GLOSSARY.md / OVERVIEW.md / future_plans/p9-telegram-approvals.md.

- [ ] **Step 4: Commit**

~~~bash
git add docs/canon
git commit -m "docs(canon): define Telegram approval answerer"
~~~

- [ ] **Step 5: STOP — go-ahead.** Сообщить владельцу, что canon обновлён, и ждать явного разрешения перед кодом (правило репозитория).

---

### Task 2: Карточка запроса и клавиатура (cards.ts + keyboards.ts)

**Files:**
- Modify: packages/plugins/dsh-balbes-telegram/src/keyboards.ts
- Modify: packages/plugins/dsh-balbes-telegram/src/cards.ts
- Test: packages/plugins/dsh-balbes-telegram/tests/keyboards.test.ts
- Test: packages/plugins/dsh-balbes-telegram/tests/cards.test.ts

**Interfaces:**
- Consumes: существующие InlineKeyboardMarkup, CardView.
- Produces:
  - keyboards.approvalKeyboard(id: string): InlineKeyboardMarkup — callback_data «ap:\<id\>:y» / «ap:\<id\>:n».
  - cards.approvalCard(opts: { id: string; workspaceLabel: string; toolName: string; reason?: string; taskText?: string }): CardView.
  - cards.approvalResolvedText(opts: { toolName: string; outcome: ApprovalView }): string, где ApprovalView = "allowed" | "rejected" | "expired" | "cancelled".
  - cards.progressCard получает необязательное waitingFor?: string и рисует строку «⏳ ждёт подтверждения: X».

- [ ] **Step 1: Write the failing tests**

Добавить в tests/keyboards.test.ts:

~~~ts
import { approvalKeyboard } from "../src/keyboards.js";

describe("approvalKeyboard", () => {
  it("renders the one-shot decision as ap:<id>:y / ap:<id>:n", () => {
    expect(approvalKeyboard("deadbeef")).toEqual({
      inline_keyboard: [[
        { text: "✅ Разрешить один раз", callback_data: "ap:deadbeef:y" },
        { text: "⛔ Отклонить", callback_data: "ap:deadbeef:n" }
      ]]
    });
  });
});
~~~

Добавить в tests/cards.test.ts:

~~~ts
import { approvalCard, approvalResolvedText, progressCard } from "../src/cards.js";

describe("approvalCard", () => {
  it("renders tool, reason, workspace label and task echo with the decision keyboard", () => {
    const card = approvalCard({
      id: "deadbeef",
      workspaceLabel: "Дом агента",
      toolName: "bash",
      reason: "escalate sandbox to danger-full-access: нужно",
      taskText: "почини сборку"
    });
    expect(card.text).toBe(
      [
        "🔐 Запрос подтверждения · Дом агента",
        "",
        "Инструмент: bash",
        "Причина: escalate sandbox to danger-full-access: нужно",
        "",
        "Задача: почини сборку"
      ].join("\n")
    );
    expect(card.keyboard.inline_keyboard[0]![0]!.callback_data).toBe("ap:deadbeef:y");
  });

  it("omits reason and task when absent", () => {
    const card = approvalCard({ id: "deadbeef", workspaceLabel: "Проект: demo", toolName: "bash" });
    expect(card.text).toBe("🔐 Запрос подтверждения · Проект: demo\n\nИнструмент: bash");
  });
});

describe("approvalResolvedText", () => {
  it("names every view", () => {
    expect(approvalResolvedText({ toolName: "bash", outcome: "allowed" })).toBe("✅ Разрешено · bash");
    expect(approvalResolvedText({ toolName: "bash", outcome: "rejected" })).toBe("⛔ Отклонено · bash");
    expect(approvalResolvedText({ toolName: "bash", outcome: "expired" })).toBe("⌛ Истёк тайм-аут · bash");
    expect(approvalResolvedText({ toolName: "bash", outcome: "cancelled" })).toBe("⏹ Отменено · bash");
  });
});

describe("progressCard waitingFor", () => {
  it("renders the waiting line while a request is pending", () => {
    const view = progressCard({
      workspaceLabel: "Дом агента",
      taskText: "почини",
      elapsedMs: 1000,
      steps: [],
      queued: 0,
      waitingFor: "bash"
    });
    expect(view.text).toContain("⏳ ждёт подтверждения: bash");
  });
});
~~~

- [ ] **Step 2: Run tests to verify they fail**

Run: pnpm --filter dsh-balbes-telegram test -- tests/keyboards.test.ts tests/cards.test.ts
Expected: FAIL — approvalKeyboard/approvalCard/approvalResolvedText are not exported; waitingFor not rendered.

- [ ] **Step 3: Implement**

В keyboards.ts добавить:

~~~ts
export const APPROVAL_ALLOW_LABEL = "✅ Разрешить один раз";
export const APPROVAL_REJECT_LABEL = "⛔ Отклонить";

/** The one-shot decision of one approval request. */
export function approvalKeyboard(id: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: APPROVAL_ALLOW_LABEL, callback_data: "ap:" + id + ":y" },
      { text: APPROVAL_REJECT_LABEL, callback_data: "ap:" + id + ":n" }
    ]]
  };
}
~~~

В cards.ts импортировать approvalKeyboard рядом с menuRow, paginationRow и добавить:

~~~ts
export type ApprovalView = "allowed" | "rejected" | "expired" | "cancelled";

const APPROVAL_VIEW_MARK: Record<ApprovalView, string> = {
  allowed: "✅ Разрешено",
  rejected: "⛔ Отклонено",
  expired: "⌛ Истёк тайм-аут",
  cancelled: "⏹ Отменено"
};

/**
 * The request card: who asks (workspace), what (tool), why (reason) and the
 * task echo. Free text arrives already clamped by the gate.
 */
export function approvalCard(opts: {
  id: string;
  workspaceLabel: string;
  toolName: string;
  reason?: string;
  taskText?: string;
}): CardView {
  const lines = ["🔐 Запрос подтверждения · " + opts.workspaceLabel, "", "Инструмент: " + opts.toolName];
  if (opts.reason !== undefined && opts.reason !== "") lines.push("Причина: " + opts.reason);
  if (opts.taskText !== undefined && opts.taskText !== "") lines.push("", "Задача: " + opts.taskText);
  return { text: lines.join("\n"), keyboard: approvalKeyboard(opts.id) };
}

/** What the request message becomes once the decision is made. */
export function approvalResolvedText(opts: { toolName: string; outcome: ApprovalView }): string {
  return APPROVAL_VIEW_MARK[opts.outcome] + " · " + opts.toolName;
}
~~~

В progressCard (cards.ts) добавить поле waitingFor?: string и строку сразу после head:

~~~ts
export function progressCard(opts: {
  workspaceLabel: string;
  taskText: string;
  elapsedMs: number;
  step?: number;
  steps: TaskProgressStep[];
  todos?: TaskProgressTodo[];
  queued: number;
  waitingFor?: string;
}): CardView {
  const head = "⏳ " + opts.workspaceLabel + " · " + formatElapsed(opts.elapsedMs) + (opts.step === undefined ? "" : " · шаг " + opts.step);
  const lines = [head];
  if (opts.waitingFor !== undefined) lines.push("⏳ ждёт подтверждения: " + opts.waitingFor);
  // …остальное тело без изменений
}
~~~

- [ ] **Step 4: Run tests to verify they pass**

Run: pnpm --filter dsh-balbes-telegram test -- tests/keyboards.test.ts tests/cards.test.ts
Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/plugins/dsh-balbes-telegram/src/keyboards.ts packages/plugins/dsh-balbes-telegram/src/cards.ts packages/plugins/dsh-balbes-telegram/tests/keyboards.test.ts packages/plugins/dsh-balbes-telegram/tests/cards.test.ts
git commit -m "feat(telegram): approval request card and decision keyboard"
~~~

---

### Task 3: Модуль approvals.ts — реестр pending и callback-протокол

**Files:**
- Create: packages/plugins/dsh-balbes-telegram/src/approvals.ts
- Test: packages/plugins/dsh-balbes-telegram/tests/approvals.test.ts

**Interfaces:**
- Consumes: BotClient, WorkspaceRef/workspaceRefKey, cards.approvalCard/approvalResolvedText/ApprovalView, keyboards.approvalKeyboard (через cards).
- Produces:
  - createApprovalGate(deps: ApprovalGateDeps): ApprovalGate.
  - ApprovalGate.attach(agentCtx, ref), handles(data), onCallback(update): Promise<void>, pendingFor(ref), withdrawAll().
  - ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable".
  - clampApprovalLine(value, max?), parseApprovalCallback(data).

- [ ] **Step 1: Write the failing tests**

Создать tests/approvals.test.ts:

~~~ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotClient } from "../src/bot.js";
import {
  clampApprovalLine,
  createApprovalGate,
  parseApprovalCallback,
  type ApprovalAgentCtxLike,
  type ApprovalGate,
  type ApprovalOutcome,
  type ApprovalRequestLike
} from "../src/approvals.js";

const CHAT = 777;

function makeBot(opts: { failSends?: number } = {}) {
  const sent: Array<{ chatId: number; text: string; markup: unknown }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string; markup: unknown }> = [];
  const answers: Array<{ id: string; text: string | undefined }> = [];
  let nextId = 100;
  let sendFailures = opts.failSends ?? 0;
  const bot: BotClient = {
    async getMe() { return {}; },
    async getUpdates() { return []; },
    async sendMessage(chatId, text, extra) {
      if (sendFailures > 0) { sendFailures -= 1; throw new Error("send failed"); }
      const messageId = nextId++;
      sent.push({ chatId, text, markup: extra?.reply_markup });
      return messageId;
    },
    async editMessageText(chatId, messageId, text, extra) {
      edits.push({ chatId, messageId, text, markup: extra?.reply_markup });
    },
    async answerCallbackQuery(id, o) { answers.push({ id, text: o?.text }); },
    async setMyCommands() {},
    async setChatMenuButton() {}
  };
  return { bot, sent, edits, answers };
}

function captureListener(gate: ApprovalGate): (r: ApprovalRequestLike, n: () => Promise<unknown>) => Promise<ApprovalOutcome> {
  let captured: ((r: ApprovalRequestLike, n: () => Promise<unknown>) => Promise<ApprovalOutcome>) | undefined;
  const agentCtx: ApprovalAgentCtxLike = {
    on(_event, listener) { captured = listener as typeof captured; return () => {}; }
  };
  gate.attach(agentCtx, { scope: "home" });
  return captured!;
}

afterEach(() => vi.useRealTimers());

describe("parseApprovalCallback", () => {
  it("accepts only ap:<8hex>:y|n", () => {
    expect(parseApprovalCallback("ap:deadbeef:y")).toEqual({ id: "deadbeef", allow: true });
    expect(parseApprovalCallback("ap:deadbeef:n")).toEqual({ id: "deadbeef", allow: false });
    expect(parseApprovalCallback("ap:deadbeef:x")).toBeUndefined();
    expect(parseApprovalCallback("ap:xyz:y")).toBeUndefined();
    expect(parseApprovalCallback("other")).toBeUndefined();
  });
});

describe("clampApprovalLine", () => {
  it("collapses whitespace and cuts with an ellipsis", () => {
    expect(clampApprovalLine("a\n b\tc")).toBe("a b c");
    expect(clampApprovalLine("abcdef", 3)).toBe("abc…");
  });
});

describe("ApprovalGate", () => {
  it("sends the card and resolves allowed-once on the allow press", async () => {
    const fake = makeBot();
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => CHAT, workspaceLabel: () => "Дом агента",
      taskText: () => "сделай X", newId: () => "deadbeef"
    });
    const listener = captureListener(gate);
    const promise = listener({ toolName: "bash", reason: "escalate" }, () => Promise.resolve("unavailable"));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]!.text).toContain("Инструмент: bash");
    await gate.onCallback({ callbackQueryId: "cb1", messageId: 100, chatId: CHAT, data: "ap:deadbeef:y" });
    await expect(promise).resolves.toBe("allowed-once");
    expect(fake.edits.at(-1)!.text).toContain("✅ Разрешено");
    expect(fake.answers.at(-1)!.text).toBe("Разрешено");
  });

  it("rejects on the reject press", async () => {
    const fake = makeBot();
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => CHAT, workspaceLabel: () => "Дом агента",
      taskText: () => undefined, newId: () => "deadbeef"
    });
    const listener = captureListener(gate);
    const promise = listener({ toolName: "bash" }, () => Promise.resolve("unavailable"));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    await gate.onCallback({ callbackQueryId: "cb1", messageId: 100, chatId: CHAT, data: "ap:deadbeef:n" });
    await expect(promise).resolves.toBe("rejected");
  });

  it("times out to rejected and edits the message", async () => {
    vi.useFakeTimers();
    const fake = makeBot();
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => CHAT, workspaceLabel: () => "Дом агента",
      taskText: () => undefined, newId: () => "deadbeef", timeoutMs: 1000
    });
    const listener = captureListener(gate);
    const promise = listener({ toolName: "bash" }, () => Promise.resolve("unavailable"));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe("rejected");
    expect(fake.edits.at(-1)!.text).toContain("⌛");
  });

  it("aborts to cancelled when the request signal aborts", async () => {
    const fake = makeBot();
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => CHAT, workspaceLabel: () => "Дом агента",
      taskText: () => undefined, newId: () => "deadbeef"
    });
    const listener = captureListener(gate);
    const controller = new AbortController();
    const promise = listener({ toolName: "bash", signal: controller.signal }, () => Promise.resolve("unavailable"));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    controller.abort();
    await expect(promise).resolves.toBe("cancelled");
    expect(fake.edits.at(-1)!.text).toContain("⏹");
  });

  it("returns unavailable when the message cannot be sent", async () => {
    const fake = makeBot({ failSends: 1 });
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => CHAT, workspaceLabel: () => "Дом агента",
      taskText: () => undefined, newId: () => "deadbeef"
    });
    const listener = captureListener(gate);
    await expect(listener({ toolName: "bash" }, () => Promise.resolve("unavailable"))).resolves.toBe("unavailable");
    expect(fake.sent).toHaveLength(0);
  });

  it("calls next when no owner chat is available", async () => {
    const fake = makeBot();
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => undefined, workspaceLabel: () => "Дом агента",
      taskText: () => undefined, newId: () => "deadbeef"
    });
    const listener = captureListener(gate);
    await expect(listener({ toolName: "bash" }, () => Promise.resolve("unavailable"))).resolves.toBe("unavailable");
    expect(fake.sent).toHaveLength(0);
  });

  it("ignores a duplicate press after the decision", async () => {
    const fake = makeBot();
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => CHAT, workspaceLabel: () => "Дом агента",
      taskText: () => undefined, newId: () => "deadbeef"
    });
    const listener = captureListener(gate);
    const promise = listener({ toolName: "bash" }, () => Promise.resolve("unavailable"));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    await gate.onCallback({ callbackQueryId: "cb1", messageId: 100, chatId: CHAT, data: "ap:deadbeef:n" });
    await expect(promise).resolves.toBe("rejected");
    const editsAfter = fake.edits.length;
    await gate.onCallback({ callbackQueryId: "cb2", messageId: 100, chatId: CHAT, data: "ap:deadbeef:y" });
    expect(fake.edits.length).toBe(editsAfter);
    expect(fake.answers.at(-1)!.text).toBe("Уже решено");
  });

  it("refuses a press from another chat or message", async () => {
    const fake = makeBot();
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => CHAT, workspaceLabel: () => "Дом агента",
      taskText: () => undefined, newId: () => "deadbeef"
    });
    const listener = captureListener(gate);
    const promise = listener({ toolName: "bash" }, () => Promise.resolve("unavailable"));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    await gate.onCallback({ callbackQueryId: "cb1", messageId: 999, chatId: CHAT, data: "ap:deadbeef:y" });
    expect(fake.answers.at(-1)!.text).toBe("Устарело");
    await gate.onCallback({ callbackQueryId: "cb2", messageId: 100, chatId: CHAT, data: "ap:deadbeef:y" });
    await expect(promise).resolves.toBe("allowed-once");
  });

  it("answers Устарело for an unknown id", async () => {
    const fake = makeBot();
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => CHAT, workspaceLabel: () => "Дом агента",
      taskText: () => undefined, newId: () => "deadbeef"
    });
    await gate.onCallback({ callbackQueryId: "cb1", messageId: 1, chatId: CHAT, data: "ap:ffffffff:y" });
    expect(fake.answers.at(-1)!.text).toBe("Устарело");
  });

  it("reports the latest pending tool for the workspace and withdraws on demand", async () => {
    const fake = makeBot();
    let id = 0;
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => CHAT, workspaceLabel: () => "Дом агента",
      taskText: () => undefined, newId: () => (id++).toString(16).padStart(8, "0")
    });
    const listener = captureListener(gate);
    void listener({ toolName: "bash" }, () => Promise.resolve("unavailable"));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    void listener({ toolName: "edit" }, () => Promise.resolve("unavailable"));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(gate.pendingFor({ scope: "home" })).toEqual({ toolName: "edit" });
    expect(gate.pendingFor({ scope: "project", name: "x" })).toBeUndefined();
    gate.withdrawAll();
    expect(gate.pendingFor({ scope: "home" })).toBeUndefined();
    expect(fake.edits.at(-1)!.text).toContain("⏹");
  });

  it("degrades to next above the pending ceiling", async () => {
    const fake = makeBot();
    let id = 0;
    const gate = createApprovalGate({
      bot: fake.bot, ownerChatId: () => CHAT, workspaceLabel: () => "Дом агента",
      taskText: () => undefined, newId: () => (id++).toString(16).padStart(8, "0"),
      maxPending: 1
    });
    const listener = captureListener(gate);
    void listener({ toolName: "bash" }, () => Promise.resolve("unavailable"));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    await expect(listener({ toolName: "edit" }, () => Promise.resolve("unavailable"))).resolves.toBe("unavailable");
    expect(fake.sent).toHaveLength(1);
  });
});
~~~

- [ ] **Step 2: Run tests to verify they fail**

Run: pnpm --filter dsh-balbes-telegram test -- tests/approvals.test.ts
Expected: FAIL — Cannot find module ../src/approvals.js.

- [ ] **Step 3: Implement approvals.ts**

Создать packages/plugins/dsh-balbes-telegram/src/approvals.ts (полный текст):

~~~ts
import { randomBytes } from "node:crypto";
import type { BotClient } from "./bot.js";
import { approvalCard, approvalResolvedText, type ApprovalView } from "./cards.js";
import type { WorkspaceRef } from "./agentTask.js";
import { workspaceRefKey } from "./agentTask.js";

/**
 * Telegram-side answerer for the stock approval/request waterfall.
 *
 * One gate per plugin process owns the pending registry and the short
 * callback protocol ap:<id>:y|n. The gate NEVER invents approval semantics: it
 * returns the exact dsh vocabulary (allowed-once / rejected / cancelled /
 * unavailable). A request is valid only inside an open turn, so the registry
 * is deliberately in-memory.
 */

export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
export const APPROVAL_MAX_PENDING = 32;
const TOOL_MAX_CHARS = 80;
const REASON_MAX_CHARS = 300;
const TASK_MAX_CHARS = 300;
const CALLBACK_PREFIX = "ap:";
const ID_PATTERN = /^[0-9a-f]{8}$/;

/** The approval request slice the gate reads (structural, no dsh import). */
export interface ApprovalRequestLike {
  toolName: string;
  reason?: string;
  callId?: string;
  signal?: AbortSignal;
}

/** The agent scope slice the gate registers on. */
export interface ApprovalAgentCtxLike {
  on(
    event: "approval/request",
    listener: (request: ApprovalRequestLike, next: () => Promise<unknown>) => unknown
  ): unknown;
}

export interface ApprovalCallbackUpdate {
  callbackQueryId: string;
  messageId: number;
  chatId: number;
  data: string;
}

export interface ApprovalGateDeps {
  bot: BotClient;
  ownerChatId(): number | undefined;
  workspaceLabel(ref: WorkspaceRef): string;
  taskText(ref: WorkspaceRef): string | undefined;
  timeoutMs?: number;
  maxPending?: number;
  logger?: { warn(m: string): void };
  newId?(): string;
}

export interface ApprovalGate {
  attach(agentCtx: ApprovalAgentCtxLike, ref: WorkspaceRef): void;
  handles(data: string): boolean;
  onCallback(update: ApprovalCallbackUpdate): Promise<void>;
  pendingFor(ref: WorkspaceRef): { toolName: string } | undefined;
  withdrawAll(): void;
}

interface PendingApproval {
  id: string;
  refKey: string;
  chatId: number;
  messageId: number;
  toolName: string;
  resolve(outcome: ApprovalOutcome): void;
  cleanup(): void;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Collapse the asker's free text to one bounded, sendable line. */
export function clampApprovalLine(value: string, max = REASON_MAX_CHARS): string {
  const collapsed = value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= max) return collapsed;
  const last = collapsed.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return collapsed.slice(0, end) + "…";
}

export function parseApprovalCallback(data: string): { id: string; allow: boolean } | undefined {
  if (!data.startsWith(CALLBACK_PREFIX)) return undefined;
  const rest = data.slice(CALLBACK_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return undefined;
  const id = rest.slice(0, sep);
  const decision = rest.slice(sep + 1);
  if (decision !== "y" && decision !== "n") return undefined;
  if (!ID_PATTERN.test(id)) return undefined;
  return { id, allow: decision === "y" };
}

export function createApprovalGate(deps: ApprovalGateDeps): ApprovalGate {
  const timeoutMs = deps.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const maxPending = deps.maxPending ?? APPROVAL_MAX_PENDING;
  const newId = deps.newId ?? (() => randomBytes(4).toString("hex"));
  const pending = new Map<string, PendingApproval>();
  // Recently settled ids, so a duplicate press answers «Уже решено» while a
  // truly unknown id answers «Устарело». Bounded: only containment data.
  const resolved = new Map<string, { chatId: number; messageId: number }>();
  const maxResolved = 64;

  function warn(message: string): void {
    deps.logger?.warn("dsh-balbes-telegram: approval: " + message);
  }

  async function editResolved(entry: PendingApproval, view: ApprovalView): Promise<void> {
    try {
      await deps.bot.editMessageText(
        entry.chatId,
        entry.messageId,
        approvalResolvedText({ toolName: entry.toolName, outcome: view }),
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch (error) {
      warn("editing the resolved request failed (" + reasonOf(error) + ")");
    }
  }

  /** Close one entry exactly once; a late event is a no-op. */
  function settle(entry: PendingApproval, outcome: ApprovalOutcome, view: ApprovalView): boolean {
    if (pending.get(entry.id) !== entry) return false;
    pending.delete(entry.id);
    resolved.set(entry.id, { chatId: entry.chatId, messageId: entry.messageId });
    if (resolved.size > maxResolved) {
      const oldest = resolved.keys().next().value;
      if (oldest !== undefined) resolved.delete(oldest);
    }
    entry.cleanup();
    entry.resolve(outcome);
    void editResolved(entry, view);
    return true;
  }

  async function handleRequest(
    ref: WorkspaceRef,
    request: ApprovalRequestLike,
    next: () => Promise<unknown>
  ): Promise<ApprovalOutcome> {
    const chatId = deps.ownerChatId();
    if (chatId === undefined) return (await next()) as ApprovalOutcome;
    if (pending.size >= maxPending) return (await next()) as ApprovalOutcome;
    if (request.signal?.aborted === true) return "cancelled";

    const id = newId();
    const toolName = clampApprovalLine(request.toolName, TOOL_MAX_CHARS);
    const taskText = deps.taskText(ref);
    const card = approvalCard({
      id,
      workspaceLabel: deps.workspaceLabel(ref),
      toolName,
      ...(request.reason !== undefined && request.reason.trim() !== ""
        ? { reason: clampApprovalLine(request.reason, REASON_MAX_CHARS) }
        : {}),
      ...(taskText !== undefined && taskText.trim() !== ""
        ? { taskText: clampApprovalLine(taskText, TASK_MAX_CHARS) }
        : {})
    });

    let messageId: number;
    try {
      messageId = await deps.bot.sendMessage(chatId, card.text, { reply_markup: card.keyboard });
    } catch (error) {
      warn("sending the request failed (" + reasonOf(error) + ")");
      return "unavailable";
    }
    if (!(messageId > 0)) return "unavailable";

    let resolveOutcome!: (outcome: ApprovalOutcome) => void;
    const promise = new Promise<ApprovalOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry: PendingApproval = {
      id,
      refKey: workspaceRefKey(ref),
      chatId,
      messageId,
      toolName,
      resolve: resolveOutcome,
      cleanup: () => {}
    };
    const onAbort = (): void => {
      settle(entry, "cancelled", "cancelled");
    };
    entry.cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    };

    pending.set(id, entry);
    timer = setTimeout(() => {
      settle(entry, "rejected", "expired");
    }, timeoutMs);
    timer.unref?.();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted === true) onAbort();

    return promise;
  }

  function attach(agentCtx: ApprovalAgentCtxLike, ref: WorkspaceRef): void {
    agentCtx.on("approval/request", (request, next) => handleRequest(ref, request, next));
  }

  async function onCallback(update: ApprovalCallbackUpdate): Promise<void> {
    let answerText: string;
    const parsed = parseApprovalCallback(update.data);
    const entry = parsed === undefined ? undefined : pending.get(parsed.id);
    if (parsed === undefined) {
      answerText = "Устарело";
    } else if (entry !== undefined) {
      if (entry.chatId !== update.chatId || entry.messageId !== update.messageId) {
        answerText = "Устарело";
      } else {
        const allowed = parsed.allow;
        const settledNow = settle(entry, allowed ? "allowed-once" : "rejected", allowed ? "allowed" : "rejected");
        answerText = settledNow ? (allowed ? "Разрешено" : "Отклонено") : "Уже решено";
      }
    } else {
      const done = resolved.get(parsed.id);
      answerText =
        done !== undefined && done.chatId === update.chatId && done.messageId === update.messageId
          ? "Уже решено"
          : "Устарело";
    }
    try {
      await deps.bot.answerCallbackQuery(update.callbackQueryId, { text: answerText });
    } catch (error) {
      warn("answering the callback failed (" + reasonOf(error) + ")");
    }
  }

  function pendingFor(ref: WorkspaceRef): { toolName: string } | undefined {
    const key = workspaceRefKey(ref);
    let latest: PendingApproval | undefined;
    for (const entry of pending.values()) {
      if (entry.refKey === key) latest = entry;
    }
    return latest === undefined ? undefined : { toolName: latest.toolName };
  }

  function withdrawAll(): void {
    for (const entry of [...pending.values()]) settle(entry, "cancelled", "cancelled");
  }

  function handles(data: string): boolean {
    return data.startsWith(CALLBACK_PREFIX);
  }

  return { attach, handles, onCallback, pendingFor, withdrawAll };
}
~~~

- [ ] **Step 4: Run tests to verify they pass**

Run: pnpm --filter dsh-balbes-telegram test -- tests/approvals.test.ts
Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/plugins/dsh-balbes-telegram/src/approvals.ts packages/plugins/dsh-balbes-telegram/tests/approvals.test.ts
git commit -m "feat(telegram): approval gate with pending registry and callback protocol"
~~~

---

### Task 4: Привязка gate к агентам раннера (agentTask.ts)

**Files:**
- Modify: packages/plugins/dsh-balbes-telegram/src/agentTask.ts
- Test: packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts

**Interfaces:**
- Consumes: ApprovalGate.attach из Task 3 (structurally, through an optional dep).
- Produces: AgentTaskDeps.approvals?: ApprovalAttachment, где ApprovalAttachment = { attach(agentCtx: unknown, ref: WorkspaceRef): void }. Setup каждого агента вызывает deps.approvals?.attach(agentCtx, ref).

- [ ] **Step 1: Write the failing test**

Добавить в tests/agentTask.test.ts тест, который создаёт раннер с фейковым agents.create, запоминающим setup, и проверяет, что setup дёргает attach с тем же ref и agentCtx:

~~~ts
it("attaches the approval listener through setup for every created agent", async () => {
  const base = await mkdtemp(join(tmpdir(), "agenttask-approval-"));
  const agents = makeAgents();
  const attached: Array<{ ctx: unknown; ref: WorkspaceRef }> = [];
  const runner = createAgentTaskRunner({
    agents: agents as unknown as AgentTaskDeps["agents"],
    sessions: { flush: vi.fn(async () => {}) },
    defaultModel: { currentSelection: () => SELECTION },
    workspaces: makeWorkspaces(base) as unknown as AgentTaskDeps["workspaces"],
    approvals: { attach: (ctx, ref) => { attached.push({ ctx, ref }); } },
    logger: { warn: vi.fn() }
  });
  const result = runner.run({ scope: "home" }, "task");
  await waitFor(() => agents.createOpts.length === 1);
  const agentCtx = { on: vi.fn(), get: vi.fn() };
  agents.createOpts[0]!.setup(agentCtx);
  expect(attached).toEqual([{ ctx: agentCtx, ref: { scope: "home" } }]);
  await runToCompletion(agents.created[0]!, 1);
  await result;
});
~~~

Переиспользуются существующие билдеры того же файла: makeAgents()/makeWorkspaces() дают фейковые agents/workspaces, runToCompletion() проводит один turn, а setup тест зовёт явно — фейковый agents.create его не вызывает (так же поступает существующий тест composeAgentSetup).

- [ ] **Step 2: Run test to verify it fails**

Run: pnpm --filter dsh-balbes-telegram test -- tests/agentTask.test.ts -t "attaches the approval listener"
Expected: FAIL — approvals не принимается (TS) / attach не вызывается.

- [ ] **Step 3: Implement**

В agentTask.ts:
- Добавить экспортируемый интерфейс рядом с AgentTaskDeps:

~~~ts
/** Structural seam the runner uses to compose an approval answerer on each agent. */
export interface ApprovalAttachment {
  attach(agentCtx: unknown, ref: WorkspaceRef): void;
}
~~~

- В AgentTaskDeps добавить: approvals?: ApprovalAttachment;
- Изменить acquireHandle на acquireHandle(root, ref, opts) и в setup добавить строку:

~~~ts
    const setup = (agentCtx: unknown): void => {
      composeAgentSetup(agentCtx, { selection: selection.ref });
      deps.approvals?.attach(agentCtx, ref);
    };
~~~

- В executeTurn вызов acquireHandle(root, opts) заменить на acquireHandle(root, ref, opts).

- [ ] **Step 4: Run tests to verify they pass**

Run: pnpm --filter dsh-balbes-telegram test -- tests/agentTask.test.ts
Expected: PASS (включая прежние тесты).

- [ ] **Step 5: Commit**

~~~bash
git add packages/plugins/dsh-balbes-telegram/src/agentTask.ts packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts
git commit -m "feat(telegram): attach the approval gate to every runner agent"
~~~

### Task 5: Ожидание approval в живом прогрессе (chat.ts)

**Files:**
- Modify: packages/plugins/dsh-balbes-telegram/src/chat.ts
- Test: packages/plugins/dsh-balbes-telegram/tests/chat.test.ts

**Interfaces:**
- Consumes: ApprovalGate.pendingFor из Task 3.
- Produces:
  - ChatDeps.approvals?: { pendingFor(ref: WorkspaceRef): { toolName: string } | undefined }.
  - export function refLabel(ref: WorkspaceRef): string (нужен index.ts для gate.workspaceLabel).
  - progressCard при живом тике получает waitingFor с инструментом pending-запроса; menuView добавляет «· ждёт подтверждения: X» в строку «Задача:».

- [ ] **Step 1: Write the failing tests**

В tests/chat.test.ts расширить makeHarness: добавить в opts поле approvals?: { pendingFor(ref: WorkspaceRef): { toolName: string } | undefined } и в createChatMachine(...) передать ...(opts.approvals === undefined ? {} : { approvals: opts.approvals }).

Добавить тест (использует существующие withActive/runner.hold/drain/message):

~~~ts
it("shows the waiting-for-approval line on the live card and on the menu card", async () => {
  vi.useFakeTimers();
  try {
    const approvals = { pendingFor: vi.fn(() => ({ toolName: "bash" })) };
    const h = makeHarness({ progressIntervalMs: 3500, approvals });
    withActive(h);
    const gate = h.runner.hold();
    await h.machine.onMessage(message("починить парсер"));
    const cardId = h.bot.sent[0]!.messageId;
    h.runner.progress.mockReturnValue({
      phase: "running", taskText: "починить парсер", startedAt: Date.now(), steps: [], queued: 0
    });
    await vi.advanceTimersByTimeAsync(3500);
    expect(h.bot.lastEdit().messageId).toBe(cardId);
    expect(h.bot.lastEdit().text).toContain("⏳ ждёт подтверждения: bash");

    await h.machine.onMessage(message("/menu"));
    expect(h.bot.sent.at(-1)!.text).toContain("ждёт подтверждения: bash");

    h.runner.progress.mockReturnValue({ phase: "idle", steps: [], queued: 0 });
    gate.release({ ok: true, text: "готово", sessionId: "s-1" });
    await drain();
  } finally {
    vi.useRealTimers();
  }
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: pnpm --filter dsh-balbes-telegram test -- tests/chat.test.ts -t "waiting-for-approval"
Expected: FAIL — approvals не принимается; строка отсутствует.

- [ ] **Step 3: Implement**

В chat.ts:
- В ChatDeps добавить:

~~~ts
  /** The gate's pending read; absent when no approval surface is composed. */
  approvals?: { pendingFor(ref: WorkspaceRef): { toolName: string } | undefined };
~~~

- Сделать refLabel экспортируемым: заменить function refLabel на export function refLabel.
- В startProgressCard.tick после const progress = deps.runner.progress(ref); вычислить:

~~~ts
        const waiting = deps.approvals?.pendingFor(ref);
~~~

и передать в progressCard:

~~~ts
          ...(waiting === undefined ? {} : { waitingFor: waiting.toolName }),
~~~

- В menuView заменить формирование taskLine так, чтобы после базовой строки добавлялось ожидание:

~~~ts
    const waiting = ref === undefined ? undefined : deps.approvals?.pendingFor(ref);
    const baseTaskLine = /* существующее выражение taskLine */;
    const taskLine = waiting === undefined ? baseTaskLine : baseTaskLine + " · ждёт подтверждения: " + waiting.toolName;
~~~

- [ ] **Step 4: Run tests to verify they pass**

Run: pnpm --filter dsh-balbes-telegram test -- tests/chat.test.ts
Expected: PASS (включая прежние тесты).

- [ ] **Step 5: Commit**

~~~bash
git add packages/plugins/dsh-balbes-telegram/src/chat.ts packages/plugins/dsh-balbes-telegram/tests/chat.test.ts
git commit -m "feat(telegram): show pending approval on the live and menu cards"
~~~

---

### Task 6: Сборка в index.ts — gate, маршрутизация ap:, disposal

**Files:**
- Modify: packages/plugins/dsh-balbes-telegram/src/index.ts
- Test: packages/plugins/dsh-balbes-telegram/tests/index.test.ts

**Interfaces:**
- Consumes: createApprovalGate (Task 3), ApprovalAttachment (Task 4), refLabel (Task 5).
- Produces: рабочая сборка канала: gate создан, передан раннеру (attach) и машине чата (pendingFor), callback-код ap: уходит в gate, dispose отзывает pending.

- [ ] **Step 1: Write the failing test**

В tests/index.test.ts добавить:

~~~ts
it("wires the approval gate into the chat machine", () => {
  apply(makeCtx(), { dshHome: home });
  expect(captured.chatDeps.at(-1)!.approvals).toBeDefined();
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: pnpm --filter dsh-balbes-telegram test -- tests/index.test.ts -t "approval gate"
Expected: FAIL — approvals undefined.

- [ ] **Step 3: Implement**

В index.ts:
- Импорты: добавить createApprovalGate, type ApprovalAgentCtxLike, type ApprovalGate из ./approvals.js; добавить refLabel в импорт из ./chat.js.
- Перед const runner = createAgentTaskRunner({ объявить let gate: ApprovalGate | undefined; и добавить в deps раннера:

~~~ts
    approvals: {
      attach: (agentCtx, ref) => {
        gate?.attach(agentCtx as ApprovalAgentCtxLike, ref);
      }
    },
~~~

- Сразу после создания runner:

~~~ts
  gate = createApprovalGate({
    bot: chatBot,
    ownerChatId: () => {
      const section = settingsScope.get();
      return section.enabled ? section.allowedUserId ?? undefined : undefined;
    },
    workspaceLabel: refLabel,
    taskText: (ref) => runner.progress(ref).taskText,
    logger: ctx.logger
  });
~~~

- В createChatMachine передать approvals: gate (рядом с models/sessions).
- В creation poller (onUpdate) заменить тело на:

~~~ts
      onUpdate: async (update) => {
        const classified = classify(update);
        if (classified === null) return;
        if (classified.kind === "callback" && gate !== undefined && gate.handles(classified.data)) {
          await gate.onCallback(classified);
          return;
        }
        await (classified.kind === "message" ? chat.onMessage(classified) : chat.onCallback(classified));
      },
~~~

- В ctx.effect disposer добавить отзыв pending:

~~~ts
  ctx.effect?.(() => () => {
    gate?.withdrawAll();
    void poller.stop();
  }, "balbes-telegram:poller");
~~~

- [ ] **Step 4: Run tests to verify they pass**

Run: pnpm --filter dsh-balbes-telegram test -- tests/index.test.ts
Expected: PASS.

- [ ] **Step 5: Typecheck the package**

Run: pnpm --filter dsh-balbes-telegram typecheck
Expected: PASS (TS ловит несовпадение типов gate/ApprovalGateDeps).

- [ ] **Step 6: Commit**

~~~bash
git add packages/plugins/dsh-balbes-telegram/src/index.ts packages/plugins/dsh-balbes-telegram/tests/index.test.ts
git commit -m "feat(telegram): route approval callbacks and compose the gate"
~~~

---

### Task 7: REAL-композиция — запрос, кнопка, пропуск и отказ

**Files:**
- Modify: packages/plugins/dsh-balbes-telegram/tests/integration.test.ts

**Interfaces:**
- Consumes: всё, что собрано в Task 6; helpers bootServer/tgPost/waitForConnected/openMenu/pressButton/waitForMessage/waitForOutbound/buttonsOf/sentMessageId/requireApi/requireStub.
- Produces: доказательство сквозного пути на реальной композиции dsh.

- [ ] **Step 1: Write the failing scenario**

Добавить константы рядом с остальными:

~~~ts
const APPROVAL_PROMPT = "Запиши отчёт по доступу.";
const APPROVAL_ALLOW_REPLY = "отчёт записан";
const APPROVAL_DENY_REPLY = "запись отменена";
~~~

Добавить два it в общий describe (после существующих сценариев). Каждый начинается с bootServer/tgPost/waitForConnected, выбирает «Дом агента» и скриптует стаб.

Первый (allow):

~~~ts
  it("asks the owner before a gated escalation and runs it on the allow press", async () => {
    const server = requireApi();
    const llm = requireStub();
    const token = await bootServer();
    await tgPost("/api/telegram/save", { token: BOT_TOKEN, allowedUserId: OWNER_USER_ID, enabled: true }, token);
    await waitForConnected(token, true);

    const from = server.outbound.length;
    const menu = await openMenu(from);
    const menuId = sentMessageId(menu);
    pressButton(menuId, "ws:pick:0");
    await waitForOutbound(
      (e) => e.method === "sendMessage" && e.body.text === "Выбран: Дом агента",
      "the home selection",
      from
    );

    const callsBefore = llm.calls.length;
    llm.setScript([
      {
        toolCalls: [
          {
            name: "bash",
            arguments: JSON.stringify({
              command: "echo approval-ok",
              sandbox_permissions: "danger-full-access",
              justification: "нужно записать отчёт вне песочницы"
            })
          }
        ]
      },
      { text: APPROVAL_ALLOW_REPLY }
    ]);

    const approvalFrom = server.outbound.length;
    server.enqueueMessage({ fromId: OWNER_USER_ID, text: APPROVAL_PROMPT });
    const request = await waitForMessage(
      (text) => text.startsWith("🔐 Запрос подтверждения"),
      "the approval request",
      approvalFrom,
      60_000
    );
    expect(request.text).toContain("Инструмент: bash");
    expect(request.text).toContain("escalate sandbox to danger-full-access");
    const buttons = buttonsOf(request.entry);
    expect(buttons.map((b) => b.text)).toEqual(["✅ Разрешить один раз", "⛔ Отклонить"]);
    const allow = buttons.find((b) => b.callback_data.endsWith(":y"));
    expect(allow).toBeDefined();
    expect(allow!.callback_data.startsWith("ap:")).toBe(true);

    pressButton(request.messageId, allow!.callback_data);
    await waitForMessage((text) => text.startsWith("✅ Разрешено"), "the resolved request", approvalFrom, 60_000);
    await waitForOutbound(
      (e) => e.method === "sendMessage" && e.body.text === APPROVAL_ALLOW_REPLY,
      "the agent reply after the allowance",
      approvalFrom,
      180_000
    );
    expect(llm.calls.length - callsBefore).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(llm.calls.at(-1)?.body ?? {})).toContain("approval-ok");
  });
~~~

Второй (deny):

~~~ts
  it("refuses the gated escalation on the reject press and the tool does not run", async () => {
    const server = requireApi();
    const llm = requireStub();
    const token = await bootServer();
    await tgPost("/api/telegram/save", { token: BOT_TOKEN, allowedUserId: OWNER_USER_ID, enabled: true }, token);
    await waitForConnected(token, true);

    const from = server.outbound.length;
    const menu = await openMenu(from);
    const menuId = sentMessageId(menu);
    pressButton(menuId, "ws:pick:0");
    await waitForOutbound(
      (e) => e.method === "sendMessage" && e.body.text === "Выбран: Дом агента",
      "the home selection",
      from
    );

    llm.setScript([
      {
        toolCalls: [
          {
            name: "bash",
            arguments: JSON.stringify({
              command: "echo should-not-run",
              sandbox_permissions: "danger-full-access",
              justification: "нужно записать отчёт"
            })
          }
        ]
      },
      { text: APPROVAL_DENY_REPLY }
    ]);

    const approvalFrom = server.outbound.length;
    server.enqueueMessage({ fromId: OWNER_USER_ID, text: APPROVAL_PROMPT });
    const request = await waitForMessage(
      (text) => text.startsWith("🔐 Запрос подтверждения"),
      "the approval request",
      approvalFrom,
      60_000
    );
    const reject = buttonsOf(request.entry).find((b) => b.callback_data.endsWith(":n"));
    expect(reject).toBeDefined();

    pressButton(request.messageId, reject!.callback_data);
    await waitForMessage((text) => text.startsWith("⛔ Отклонено"), "the rejection", approvalFrom, 60_000);
    await waitForOutbound(
      (e) => e.method === "sendMessage" && e.body.text === APPROVAL_DENY_REPLY,
      "the agent reply after the rejection",
      approvalFrom,
      180_000
    );
    expect(JSON.stringify(llm.calls.at(-1)?.body ?? {})).not.toContain("should-not-run");
  });
~~~

- [ ] **Step 2: Run the REAL suite**

Run: RUN_REAL=1 pnpm --filter dsh-balbes-telegram test -- tests/integration.test.ts
Expected: PASS (гейт RUN_REAL=1 и dsh на PATH; без них сьют скипается — это не провал).
Если сценарий не проходит из-за скриптовки стаба (например, агент не эмитит sandbox_permissions), править сценарий, а не продакшн-код: инструмент bash вызывает approveEscalation детерминированно при наличии обоих аргументов.

- [ ] **Step 3: Commit**

~~~bash
git add packages/plugins/dsh-balbes-telegram/tests/integration.test.ts
git commit -m "test(telegram): REAL approval round-trip through a gated escalation"
~~~

---

### Task 8: Runbook — smoke approval

**Files:**
- Modify: docs/runbooks/stage2-vps.md

**Interfaces:**
- Consumes: рабочая функциональность Task 7.
- Produces: операторские инструкции проверки approval на VPS.

- [ ] **Step 1: Найти секцию smoke Telegram** в docs/runbooks/stage2-vps.md и после неё добавить подраздел «Проверка approval из Telegram».

Содержание (точные шаги и ожидаемые результаты):

~~~markdown
### Проверка approval из Telegram

1. В Telegram откройте бота, выберите воркспейс и отправьте задачу, требующую
   sandbox-эскалации, например: «Запиши файл вне воркспейса».
2. Ожидаемо: бот присылает сообщение «🔐 Запрос подтверждения · <воркспейс>» с
   «Инструмент: bash», причиной и кнопками «✅ Разрешить один раз» / «⛔ Отклонить».
   В карточке задачи появляется строка «⏳ ждёт подтверждения: bash».
3. Нажмите «✅ Разрешить один раз»: сообщение становится «✅ Разрешено · bash»,
   кнопки исчезают, задача продолжается и приходит обычный ответ агента.
4. Повторите и нажмите «⛔ Отклонить»: сообщение становится «⛔ Отклонено · bash»,
   команда не выполняется, агент получает отказ.
5. Проверка fail-closed: не отвечайте на запрос 5 минут — сообщение становится
   «⌛ Истёк тайм-аут · bash», операция не выполняется.
6. Отмена: остановите задачу кнопкой «⏹ Стоп» — сообщение-запрос становится
   «⏹ Отменено · bash».
~~~

- [ ] **Step 2: Commit**

~~~bash
git add docs/runbooks/stage2-vps.md
git commit -m "docs(runbook): approval smoke for the Telegram channel"
~~~

---

### Task 9: Закрытие — полный gate, canon-audit, абсорбция инициативы

**Files:**
- Modify (через canon-future-plan): docs/canon/future_plans/p9-telegram-approvals.md, docs/canon/future_plans/INDEX.md
- Modify (через canon-audit): docs/canon/DISCREPANCIES.md (при необходимости)

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces: зелёный полный прогон и закрытая инициатива.

- [ ] **Step 1: Полный gate по репозиторию**

Run: pnpm typecheck && pnpm lint && pnpm test
Expected: PASS. Если верхнеуровневых скриптов нет — прогнать их по каждому затронутому пакету: dsh-balbes-telegram (typecheck, test). Зафиксировать фактические команды в коммит-сообщении/отчёте.

- [ ] **Step 2: Вызвать skill canon-audit** по теме «Telegram approval»: сверить живые секции (ARCHITECTURE/GLOSSARY/OVERVIEW) с реализацией; если API_CONTRACTS/ADMIN_UI остались без изменений — подтвердить это; при расхождении занести в DISCREPANCIES.md.

- [ ] **Step 3: Вызвать skill canon-future-plan**: p9-telegram-approvals.md status implementing → absorbed (с ссылкой на spec и план); синхронизировать INDEX.md.

- [ ] **Step 4: Commit**

~~~bash
git add docs/canon
git commit -m "docs(canon): absorb the Telegram approvals initiative"
~~~

- [ ] **Step 5: Отчёт владельцу + инструкции проверки на сервере**

Сообщить: что сделано, какие команды реально прогонялись и с каким результатом; что пуш в origin/main — только с go-ahead; что после пуша на VPS нужно повторить scripts/install.sh и пройти smoke из Task 8.

## Self-Review

**Spec coverage:**
- agent-scoped listener через setup — Task 4.
- Несколько параллельных pending, потолок, in-memory — Task 3 (Map + maxPending), Task 6 (сборка).
- Только кнопки, протокол ap:<id>:y|n — Task 2, Task 3.
- Тайм-аут-константа 5 мин и маппинг исходов — Task 3 (APPROVAL_TIMEOUT_MS, settle), Task 8 (smoke).
- Всегда включено, без новых настроек — Task 6 (ownerChatId из settingsScope, gate не гейтуется отдельно).
- Что видит владелец (инструмент + reason + метка + эхо) — Task 2 (карточка), Task 3 (clamp), Task 6 (workspaceLabel/taskText).
- Живой прогресс показывает ожидание; /stop отзывает — Task 5, Task 3 (abort), Task 6 (withdrawAll).
- Безопасность (allowlist поллера + containment chatId/messageId, первый ответ) — Task 3.
- Canon и runbook — Task 1, Task 8, Task 9.
- REAL-тест — Task 7.

**Placeholder scan:** конкретные сигнатуры и тела даны для всех новых модулей; шаги тестов содержат исполняемый код. Единственные места, требующие сверки с существующим файлом, — механика фейкового агента в agentTask.test.ts (Task 4) и расширение makeHarness (Task 5): оба явно указывают переиспользовать существующие билдеры файла.

**Type consistency:**
- createApprovalGate(deps: ApprovalGateDeps): ApprovalGate; ApprovalGate.attach(agentCtx, ref), handles(data), onCallback(update): Promise<void>, pendingFor(ref), withdrawAll() — совпадают в Tasks 3, 4, 5, 6.
- AgentTaskDeps.approvals?: ApprovalAttachment { attach(agentCtx: unknown, ref: WorkspaceRef): void } — Task 4 и вызов из Task 6.
- ChatDeps.approvals?: { pendingFor(ref): { toolName: string } | undefined } — Task 5 и передача gate из Task 6.
- cards.progressCard получает waitingFor?: string; approvals карточка — approvalCard({ id, workspaceLabel, toolName, reason?, taskText? }) и approvalResolvedText({ toolName, outcome }) — Task 2, используются в Task 3.
- Тип ApprovalView = "allowed" | "rejected" | "expired" | "cancelled" — Task 2 (cards.ts), импортируется в Task 3.

