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
    // Strict TS narrows `aborted` to false|undefined after the early check at
    // the top of this function (it cannot know the signal changed across the
    // await), so compare truthily: `=== true` is a TS2367 no-overlap error.
    if (request.signal?.aborted) onAbort();

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
