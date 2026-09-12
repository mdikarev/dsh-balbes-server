import { describe, expect, it } from "vitest";
import { buildTranscript } from "../src/transcript.js";
import { assistantText, assistantToolCall, emptyAssistant, pluginContext, systemMessage, toolResult, toolResultWithError, userMessage } from "./fixtures/events.js";

const session = { id: "session-1", createdAt: 1_700_000_000_000 } as never;

describe("buildTranscript", () => {
  it("maps durable messages, tool calls, results and current context", () => {
    const events = [
      systemMessage(0, "системный промпт"),
      pluginContext(1, "правила проекта", "instructions"),
      userMessage(2, "привет"),
      assistantToolCall(3, "read", "{\"path\":\"/a\"}", "сейчас прочитаю"),
      toolResult(4, "содержимое файла"),
      toolResult(5, "не нашёл", true)
    ];
    const entries = buildTranscript({ session, events });
    expect(entries.map((e) => [e.seq, e.kind, e.role, e.inContext])).toEqual([
      [0, "context", "system", true],
      [1, "context", "user", true],
      [2, "message", "user", true],
      [3, "message", "assistant", true],
      [3, "tool-call", "assistant", true],
      [4, "tool-result", "user", true],
      [5, "tool-result", "user", true]
    ]);
    expect(entries[0]?.detail).toBe("системный промпт");
    expect(entries[1]?.form).toBe("instructions");
    expect(entries[4]?.toolName).toBe("read");
    expect(entries[4]?.detail).toBe("{\"path\":\"/a\"}");
    expect(entries[5]?.detail).toBe("содержимое файла");
    expect(entries[6]?.isError).toBe(true);
  });

  it("drops a replaced context snapshot but keeps the durable conversation", () => {
    const events = [
      pluginContext(0, "старые правила", "instructions"),
      userMessage(1, "привет"),
      userMessage(2, "сводка", { op: "replace", startSeq: 0, endSeq: 0 }, [0])
    ];
    const entries = buildTranscript({ session, events });
    expect(entries.map((e) => [e.seq, e.kind, e.inContext])).toEqual([
      [1, "message", true],
      [2, "message", true]
    ]);
  });

  it("skips a surface event that projects to no message", () => {
    expect(buildTranscript({ session, events: [emptyAssistant(0)] })).toEqual([]);
  });

  it("falls back to extractSessionEventText for a result with no text blocks", () => {
    const entries = buildTranscript({ session, events: [toolResultWithError(0, "ToolFailure", "E_BOOM")] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("tool-result");
    expect(entries[0]?.isError).toBe(true);
    // block-join is empty (no text blocks), so detail must come from the
    // extractor's failure identity, newline-joined by extractSessionEventText.
    expect(entries[0]?.detail).toBe("ToolFailure\nE_BOOM");
  });
});
