import {
  deriveEventMessage,
  foldSurface,
  isAppendSurfaceEvent,
  isSurfaceEvent
} from "@deepseek-ai/dsh-session";
import type { ContentBlock, Message, ToolCallBlock } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { extractSessionEventText } from "@deepseek-ai/dsh-session-query";

export type TranscriptRole = "user" | "assistant" | "system" | "developer" | "tool";
export type TranscriptKind = "message" | "tool-call" | "tool-result" | "context";

export interface TranscriptEntry {
  seq: number;
  time: string;
  role: TranscriptRole;
  kind: TranscriptKind;
  text: string;
  detail?: string;
  toolName?: string;
  form?: string;
  isError?: boolean;
  inContext: boolean;
}

export interface TranscriptLog {
  session: SessionHeader;
  events: readonly SessionEvent[];
}

function joinTextBlocks(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => (block as Extract<ContentBlock, { type: "text" }>).text)
    .join("\n");
}

/**
 * Whether a message is injected context rather than a conversation turn
 * (dsh 0.1.7-rc.1 seam fact). Producer context arrives as a user-role message
 * whose source kind is producer-declared (e.g. `agent-instructions`) — the
 * engine has no shared `plugin` kind — while a real prompt carries `kind:
 * "user"`. The system prompt and developer session changes are context by
 * role; assistant and tool messages never are.
 */
function isContextMessage(message: Message): boolean {
  if (message.role === "system" || message.role === "developer") return true;
  if (message.role === "user") return message.source.kind !== "user";
  return false;
}

function contextForm(message: Message): string | undefined {
  const form = (message.source as { form?: unknown }).form;
  return typeof form === "string" ? form : undefined;
}

function entriesForEvent(event: SessionEvent, message: Message, inContext: boolean): TranscriptEntry[] {
  const head = { seq: event.seq, time: new Date(event.time).toISOString(), role: message.role, inContext };
  if (message.role === "tool") {
    // dsh 0.1.7-rc.1: a tool result is its own `role: "tool"` message; its
    // blocks are the model-facing content and `isError` sits on the message.
    // The 0.1.5 `tool-result` content block no longer exists.
    const detail = joinTextBlocks(message.content) || extractSessionEventText(event);
    const entry: TranscriptEntry = { ...head, kind: "tool-result", text: "", detail };
    return message.isError === true ? [{ ...entry, isError: true }] : [entry];
  }
  if (isContextMessage(message)) {
    const entry: TranscriptEntry = { ...head, kind: "context", text: "", detail: joinTextBlocks(message.content) };
    const form = contextForm(message);
    return form === undefined ? [entry] : [{ ...entry, form }];
  }
  const entries: TranscriptEntry[] = [];
  const text = joinTextBlocks(message.content);
  if (text !== "") entries.push({ ...head, kind: "message", text });
  for (const call of message.content.filter((block): block is ToolCallBlock => block.type === "tool-call")) {
    entries.push({ ...head, kind: "tool-call", text: "", detail: call.arguments, toolName: call.name });
  }
  return entries;
}

/** Гибридный транскрипт: реплики — append-origin, контекст — текущая поверхность. */
export function buildTranscript(log: TranscriptLog): TranscriptEntry[] {
  const currentNodes = new Set(foldSurface(log.events).nodes);
  const entries: TranscriptEntry[] = [];
  for (const event of log.events) {
    if (!isSurfaceEvent(event)) continue;
    const message = deriveEventMessage(event);
    if (message === null) continue;
    const inContext = currentNodes.has(event.seq);
    const isContext = isContextMessage(message);
    if (isContext && !inContext) continue;
    if (!isContext && !isAppendSurfaceEvent(event) && !inContext) continue;
    entries.push(...entriesForEvent(event, message, inContext));
  }
  return entries;
}
