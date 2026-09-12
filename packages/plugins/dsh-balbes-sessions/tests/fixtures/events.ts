import type { SessionEvent } from "@deepseek-ai/dsh-session";

const T = 1_700_000_000_000;
type Replace = { op: "replace"; startSeq: number; endSeq: number };

function event(
  type: string,
  seq: number,
  surfaceOp: "append" | Replace,
  data: unknown,
  sourceEventSeqs?: number[]
): SessionEvent {
  return {
    type,
    seq,
    time: T + seq,
    surfaceOp,
    data,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs })
  } as unknown as SessionEvent;
}

export function userMessage(
  seq: number,
  text: string,
  surfaceOp: "append" | Replace = "append",
  sourceEventSeqs?: number[]
): SessionEvent {
  return event(
    "user/message",
    seq,
    surfaceOp,
    { id: `m${seq}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
    sourceEventSeqs
  );
}

export function pluginContext(seq: number, text: string, form?: string): SessionEvent {
  return event("user/message", seq, "append", {
    id: `m${seq}`,
    role: "user",
    content: [{ type: "text", text }],
    source: form === undefined ? { kind: "plugin", plugin: "test" } : { kind: "plugin", plugin: "test", form }
  });
}

function assistantContent(seq: number, content: unknown[]): SessionEvent {
  return event("assistant/message", seq, "append", {
    turn: 0,
    step: 0,
    stream: [],
    message: { id: `m${seq}`, role: "assistant", content, source: { kind: "model", provider: "test", model: "test" } }
  });
}

export function assistantText(seq: number, text: string): SessionEvent {
  return assistantContent(seq, [{ type: "text", text }]);
}

export function assistantToolCall(seq: number, name: string, args: string, text?: string): SessionEvent {
  const call = { type: "tool-call", id: "call-1", name, arguments: args };
  return assistantContent(seq, text === undefined ? [call] : [{ type: "text", text }, call]);
}

export function emptyAssistant(seq: number): SessionEvent {
  return assistantContent(seq, []);
}

export function systemMessage(seq: number, text: string): SessionEvent {
  return event("system/message", seq, "append", {
    turn: 0,
    step: 0,
    message: { id: `m${seq}`, role: "system", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "test" } }
  });
}

export function toolResult(seq: number, text: string, isError = false): SessionEvent {
  return event("tool/result", seq, "append", {
    turn: 0,
    step: 0,
    message: {
      id: `m${seq}`,
      role: "user",
      content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text }], isError }],
      source: { kind: "tool", callId: "call-1" }
    }
  });
}

/**
 * Текст-less результат инструмента: блок пуст, но у события есть failure-identity
 * (error.name/error.code). Конкатенация text-блоков даёт пустую строку, поэтому
 * detail обязан прийти из fallback extractSessionEventText.
 */
export function toolResultWithError(seq: number, name: string, code: string): SessionEvent {
  return event("tool/result", seq, "append", {
    turn: 0,
    step: 0,
    message: {
      id: `m${seq}`,
      role: "user",
      content: [{ type: "tool-result", toolCallId: "call-1", content: [], isError: true }],
      source: { kind: "tool", callId: "call-1" }
    },
    error: { name, code }
  });
}
