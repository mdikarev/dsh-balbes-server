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
