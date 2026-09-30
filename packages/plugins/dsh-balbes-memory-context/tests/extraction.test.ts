import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import { createMemoryContext } from "../src/context.js";
import type { MemoryContextScope } from "../src/types.js";

function record(partial: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    scope: { kind: "global" },
    type: "fact",
    tags: [],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...partial
  };
}

/**
 * The tools seat keeps its registrations addressable by name, so the surface
 * switch is asserted the way the model sees it: by tool names, not by calls.
 */
function harness(
  options: { propose?: boolean; failProposeRegistration?: boolean; failRememberRegistration?: boolean } = {}
) {
  const registered = new Map<string, unknown>();
  let rememberRegistrations = 0;
  const proposals: unknown[] = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const memory = {
    list: async () => [record({ id: "r1", text: "known text" })],
    count: async () => 1,
    search: async () => [],
    save: async () => record({ id: "saved", text: "saved" }),
    ...(options.propose === false
      ? {}
      : {
          propose: async (draft: unknown) => {
            proposals.push(draft);
            return {
              id: "p1",
              scope: { kind: "global" },
              type: "note",
              text: "x",
              tags: [],
              origin: "agent",
              originRef: null,
              status: "proposed",
              proposedAt: "2026-09-30T00:00:00.000Z",
              decidedAt: null,
              decidedBy: null,
              decidedEdit: false,
              memoryId: null
            };
          },
          listProposals: async () => []
        })
  };
  const tools = {
    register: (definition: unknown) => {
      const name = (definition as { name: string }).name;
      if (name === "propose_memory" && options.failProposeRegistration === true) {
        throw new Error("reserved tool name");
      }
      if (name === "remember") {
        rememberRegistrations += 1;
        // Only the re-registration in `end()` fails: the agent scope died
        // after the task turn and took the tool registrations with it.
        if (options.failRememberRegistration === true && rememberRegistrations > 1) {
          throw new Error("INACTIVE_EFFECT");
        }
      }
      registered.set(name, definition);
      return () => {
        registered.delete(name);
      };
    }
  };
  const agentCtx = {
    get(key: string): unknown {
      if (key === "balbesMemory") return memory;
      if (key === "systemPrompt") return { section: () => () => {}, context: () => () => {} };
      if (key === "tools") return tools;
      return undefined;
    }
  };
  const service = createMemoryContext({
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message)
  });
  const scope: MemoryContextScope = { kind: "project", name: "alpha" };
  const attachment = service.attach(agentCtx, scope, { channel: "telegram", sessionId: "s1" });
  return { attachment, registered, names: () => [...registered.keys()].sort(), proposals, infos, warnings };
}

describe("extraction seat", () => {
  it("is absent when the store cannot propose", () => {
    const h = harness({ propose: false });
    expect(h.attachment.extraction).toBeUndefined();
    expect(h.names()).toEqual(["recall", "remember"]);
  });

  it("gates on a successful task that did work", () => {
    const h = harness({});
    expect(h.attachment.extraction).toBeDefined();
    expect(h.attachment.extraction!.qualifies({ ok: true, toolCalls: 1 })).toBe(true);
    expect(h.attachment.extraction!.qualifies({ ok: false, toolCalls: 3 })).toBe(false);
    expect(h.attachment.extraction!.qualifies({ ok: true, toolCalls: 0 })).toBe(false);
  });

  it("swaps remember for propose_memory on begin and back on end", () => {
    const h = harness({});
    const begun = h.attachment.extraction!.begin();
    expect(begun.message).toContain("propose_memory");
    expect(h.names()).toEqual(["propose_memory", "recall"]);
    h.attachment.extraction!.end();
    expect(h.names()).toEqual(["recall", "remember"]);
  });

  it("is idempotent and logs the counters once, without memory text", () => {
    const h = harness({});
    h.attachment.extraction!.begin();
    h.attachment.extraction!.end();
    h.attachment.extraction!.end();
    expect(h.names()).toEqual(["recall", "remember"]);
    const logged = h.infos.filter((line) => line.includes("extraction"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("channel=telegram");
    expect(logged[0]).toContain("scope=project:alpha");
    expect(logged[0]).toContain("proposed=0 duplicate=0 secret=0 limit=0");
  });

  it("resets the counters for every service turn", async () => {
    const h = harness({});
    const turn = h.attachment.extraction!;
    turn.begin();
    const propose = h.registered.get("propose_memory") as {
      execute(args: unknown, exec: unknown): Promise<unknown>;
    };
    await propose.execute({ text: "первый факт" }, {} as never);
    await propose.execute({ text: "первый факт" }, {} as never);
    turn.end();
    turn.begin();
    turn.end();
    const logged = h.infos.filter((line) => line.includes("extraction"));
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("proposed=1 duplicate=1 secret=0 limit=0");
    // An agent handle outlives many turns: without a reset the cap would
    // silently become per-session.
    expect(logged[1]).toContain("proposed=0 duplicate=0 secret=0 limit=0");
  });

  it("keeps remember registered when the propose tool cannot be registered", () => {
    const h = harness({ failProposeRegistration: true });
    expect(() => h.attachment.extraction!.begin()).toThrow("reserved tool name");
    // begin threw before remember was released, and end() is a no-op.
    expect(h.names()).toEqual(["recall", "remember"]);
    expect(() => h.attachment.extraction!.end()).not.toThrow();
    expect(h.names()).toEqual(["recall", "remember"]);
  });

  it("still logs the counters when the agent scope is already gone", () => {
    // The channel disposes the agent inside its try and calls end() in
    // finally: the re-registration throws, but the turn record must survive.
    const h = harness({ failRememberRegistration: true });
    h.attachment.extraction!.begin();
    expect(() => h.attachment.extraction!.end()).not.toThrow();
    expect(() => h.attachment.extraction!.end()).not.toThrow();
    // The registration died with the scope, so remember is not restored.
    expect(h.names()).toEqual(["recall"]);
    const logged = h.infos.filter((line) => line.includes("extraction"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("channel=telegram");
    expect(logged[0]).toContain("scope=project:alpha");
    expect(logged[0]).toContain("proposed=0 duplicate=0 secret=0 limit=0");
  });
});
