import {
  deriveEventMessage,
  foldSurface,
  isAppendSurfaceEvent,
  isSurfaceEvent
} from "@deepseek-ai/dsh-session";
import type { ContentBlock, Message, ToolCallBlock, ToolResultBlock } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { extractSessionEventText } from "@deepseek-ai/dsh-session-query";

export type TranscriptRole = "user" | "assistant" | "system";
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

function contextForm(message: Message): string | undefined {
  if (message.source.kind !== "plugin") return undefined;
  const form = (message.source as { form?: unknown }).form;
  return typeof form === "string" ? form : undefined;
}

function entriesForEvent(event: SessionEvent, message: Message, inContext: boolean): TranscriptEntry[] {
  const head = { seq: event.seq, time: new Date(event.time).toISOString(), role: message.role, inContext };
  if (message.source.kind === "tool") {
    const blocks = message.content.filter((block): block is ToolResultBlock => block.type === "tool-result");
    const detail = joinTextBlocks(blocks.flatMap((block) => block.content)) || extractSessionEventText(event);
    const entry: TranscriptEntry = { ...head, kind: "tool-result", text: "", detail };
    return blocks.some((block) => block.isError === true) ? [{ ...entry, isError: true }] : [entry];
  }
  if (message.source.kind === "plugin") {
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
    const isContext = message.source.kind === "plugin";
    if (isContext && !inContext) continue;
    if (!isContext && !isAppendSurfaceEvent(event) && !inContext) continue;
    entries.push(...entriesForEvent(event, message, inContext));
  }
  return entries;
}
