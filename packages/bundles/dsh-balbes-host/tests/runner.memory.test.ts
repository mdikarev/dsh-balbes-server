import { describe, expect, it } from "vitest";
import { runPrompt } from "../src/runner.js";

function fakeAgent() {
  const events: Array<{ type: string; data: unknown }> = [];
  return {
    session: {
      get seq(): number {
        return events.length;
      },
      eventAt(seq: number) {
        return events[seq];
      }
    },
    whenIdle: async () => {},
    followup: () => {
      events.push({ type: "turn/start", data: {} });
      events.push({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "ok" }] } } });
      events.push({ type: "turn/end", data: { reason: { kind: "completed" } } });
    }
  };
}

describe("runPrompt memory delivery wiring", () => {
  it("attaches memory for the global scope and prepares the prompt", async () => {
    const scopes: unknown[] = [];
    const prepared: string[] = [];
    let seenAgentCtx: unknown;
    const ctx = {
      get(key: string): unknown {
        switch (key) {
          case "loader":
            return { await: async () => {} };
          case "agents":
            return {
              create: async (options: { setup: (agentCtx: unknown) => void }) => {
                seenAgentCtx = { on: () => () => {}, marker: "agent-ctx" };
                options.setup(seenAgentCtx);
                return { agent: fakeAgent(), dispose: async () => {} };
              }
            };
          case "agentDefaultModel":
            return { currentSelection: () => ({ provider: "p", model: "m" }) };
          case "sessions":
            return { flush: async () => {} };
          case "balbesMemoryContext":
            return {
              attach: (agentCtx: unknown, scope: unknown) => {
                expect(agentCtx).toBe(seenAgentCtx);
                scopes.push(scope);
                return { prepare: async (text: string) => void prepared.push(text) };
              }
            };
          default:
            return undefined;
        }
      }
    };
    const outcome = await runPrompt(ctx, "hello memory");
    expect(scopes).toEqual([{ kind: "global" }]);
    expect(prepared).toEqual(["hello memory"]);
    expect(outcome.text).toBe("ok");
  });
});
