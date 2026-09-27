import { describe, expect, it } from "vitest";
import { createAgentTaskRunner, type AgentTaskDeps } from "../src/agentTask.js";

function fakeHandle() {
  const events: Array<{ type: string; data: unknown }> = [];
  return {
    agent: {
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
      },
      cancel: () => {},
      status: "idle"
    },
    dispose: async () => {}
  };
}

describe("agentTask memory delivery wiring", () => {
  it("attaches once per workspace and prepares every task text", async () => {
    const scopes: unknown[] = [];
    const prepared: string[] = [];
    const deps = {
      workspaces: {
        list: async () => ({ home: { path: "/home" }, projects: [] }),
        root: async () => "/home",
        readDir: async () => [],
        readFile: async () => ({ content: "", truncated: false })
      },
      agents: {
        create: async (options: { setup: (agentCtx: unknown) => void }) => {
          options.setup({ on: () => () => {} });
          return fakeHandle();
        },
        resume: async (options: { setup: (agentCtx: unknown) => void }) => {
          options.setup({ on: () => () => {} });
          return fakeHandle();
        }
      },
      sessions: { flush: async () => {} },
      defaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
      memory: {
        attach: (_agentCtx: unknown, scope: unknown) => {
          scopes.push(scope);
          return { prepare: async (text: string) => void prepared.push(text) };
        }
      }
    } as unknown as AgentTaskDeps;
    const runner = createAgentTaskRunner(deps);
    await runner.run({ scope: "project", name: "alpha" }, "first task");
    await runner.run({ scope: "project", name: "alpha" }, "second task");
    await runner.run({ scope: "home" }, "home task");
    expect(scopes).toEqual([{ kind: "project", name: "alpha" }, { kind: "global" }]);
    expect(prepared).toEqual(["first task", "second task", "home task"]);
  });
});
