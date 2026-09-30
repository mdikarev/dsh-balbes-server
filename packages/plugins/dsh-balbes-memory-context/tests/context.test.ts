import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import {
  createMemoryContext,
  MEMORY_CONTEXT_NAME,
  MEMORY_CONTEXT_ORDER,
  MEMORY_SECTION_NAME,
  MEMORY_SECTION_ORDER
} from "../src/context.js";
import { createMemoryMetricsLedger } from "../src/metrics.js";
import { renderCore, renderMap, renderPush } from "../src/render.js";
import type { LlmClassifierSeat } from "../src/classify.js";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import type {
  BalbesMemoryReadSlice,
  MemoryMetricsSnapshot,
  MemoryMetricsSink,
  MemoryReadFilter,
  MemoryWriteContext
} from "../src/types.js";

function record(partial: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    scope: { kind: "global" },
    type: "fact",
    tags: [],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    ...partial
  };
}

interface SectionSpec {
  name: string;
  order: number;
  text: () => string;
}
interface Harness {
  agentCtx: unknown;
  sections: SectionSpec[];
  contexts: SectionSpec[];
  tools: unknown[];
  warnings: string[];
  infos: string[];
  debugs: string[];
  /** Drafts the fake store's save received, in call order. */
  drafts: Array<Record<string, unknown>>;
}

function harness(
  records: MemoryRecord[],
  options: { withoutTools?: boolean; writable?: boolean; llm?: LlmClassifierSeat } = {},
  metrics?: MemoryMetricsSink
): Harness {
  const sections: SectionSpec[] = [];
  const contexts: SectionSpec[] = [];
  const tools: unknown[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const debugs: string[] = [];
  const drafts: Array<Record<string, unknown>> = [];
  const memory = {
    list: async (_filter?: MemoryReadFilter) => records,
    count: async (_filter?: MemoryReadFilter) => records.length,
    search: async () =>
      records.filter((r) => r.text.includes("deploy")).map((r) => ({ record: r, rank: -1 })),
    ...(options.writable === true
      ? {
          save: async (draft: { text: string; scope: MemoryRecord["scope"]; type: MemoryRecord["type"] }) => {
            drafts.push(draft as unknown as Record<string, unknown>);
            return record({ id: "saved", text: draft.text, scope: draft.scope, type: draft.type, origin: "agent" });
          }
        }
      : {})
  };
  const agentCtx = {
    get(key: string): unknown {
      if (key === "balbesMemory") return memory as unknown as BalbesMemoryReadSlice;
      if (key === "llm") return options.llm;
      if (key === "systemPrompt") {
        return {
          section: (spec: SectionSpec) => {
            sections.push(spec);
            return () => {};
          },
          context: (spec: SectionSpec) => {
            contexts.push(spec);
            return () => {};
          }
        };
      }
      if (key === "tools" && options.withoutTools !== true) {
        return {
          register: (definition: unknown) => {
            tools.push(definition);
            return () => {};
          }
        };
      }
      return undefined;
    }
  };
  const service = createMemoryContext(
    {
      warn: (message) => warnings.push(message),
      info: (message) => infos.push(message),
      debug: (message) => debugs.push(message)
    },
    metrics
  );
  const harnessValue: Harness = { agentCtx, sections, contexts, tools, warnings, infos, debugs, drafts };
  Object.defineProperty(harnessValue, "attach", {
    value: service.attach.bind(service),
    enumerable: false
  });
  return harnessValue;
}

type HarnessWithAttach = Harness & {
  attach(
    agentCtx: unknown,
    scope: { kind: "global" } | { kind: "project"; name: string },
    write?: MemoryWriteContext
  ): { prepare(taskText: string): Promise<void> };
};

describe("createMemoryContext", () => {
  it("registers the section, the push context and the recall tool", () => {
    const h = harness([record({ id: "a", text: "hello" })]) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "global" });
    expect(h.sections.map((s) => [s.name, s.order])).toEqual([[MEMORY_SECTION_NAME, MEMORY_SECTION_ORDER]]);
    expect(h.contexts.map((c) => [c.name, c.order])).toEqual([[MEMORY_CONTEXT_NAME, MEMORY_CONTEXT_ORDER]]);
    expect(h.tools).toHaveLength(1);
    expect(typeof attachment.prepare).toBe("function");
  });

  it("renders core+map into the section and push into the context", async () => {
    const h = harness([
      record({ id: "core", text: "Pinned deploy rule", pinned: true }),
      record({ id: "push", text: "deploy rollback procedure" })
    ]) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "global" });
    await attachment.prepare("deploy");
    expect(h.sections[0]!.text()).toContain("Pinned deploy rule");
    expect(h.sections[0]!.text()).toContain("## Memory map");
    expect(h.contexts[0]!.text()).toContain("deploy rollback procedure");
    expect(h.debugs.join("\n")).toContain("scope=global");
    expect(h.infos.join("\n")).not.toContain("scope=global");
  });

  it("escapes {{ in memory text", async () => {
    const h = harness([record({ id: "a", text: "literal {{name}}", pinned: true })]) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "global" });
    await attachment.prepare("anything");
    expect(h.sections[0]!.text()).toContain("{ {name}}");
  });

  it("is a no-op without tools", () => {
    const h = harness([], { withoutTools: true }) as HarnessWithAttach;
    h.attach(h.agentCtx, { kind: "global" });
    expect(h.sections).toHaveLength(0);
    expect(h.warnings[0]).toMatch(/missing/);
  });

  it("never throws from prepare when the store fails", async () => {
    const h = harness([]) as HarnessWithAttach;
    const failing = {
      get(key: string): unknown {
        if (key === "balbesMemory") {
          return { list: async () => { throw new Error("db down"); }, count: async () => 0, search: async () => [] };
        }
        return (h.agentCtx as { get(key: string): unknown }).get(key);
      }
    };
    const attachment = h.attach(failing, { kind: "global" });
    await expect(attachment.prepare("x")).resolves.toBeUndefined();
    expect(h.warnings.join("\n")).toContain("prepare failed");
  });

  it("registers remember beside recall when the store is writable and a write context is given", () => {
    const h = harness([record({ id: "a", text: "hello" })], { writable: true }) as HarnessWithAttach;
    h.attach(h.agentCtx, { kind: "global" }, { channel: "admin", sessionId: "s1" });
    expect(h.tools.map((tool) => (tool as { name: string }).name)).toEqual(["recall", "remember"]);
  });

  it("does not register remember without a write context", () => {
    const h = harness([record({ id: "a", text: "hello" })], { writable: true }) as HarnessWithAttach;
    h.attach(h.agentCtx, { kind: "global" });
    expect(h.tools).toHaveLength(1);
  });

  it("does not register remember on a read-only store", () => {
    const h = harness([record({ id: "a", text: "hello" })]) as HarnessWithAttach;
    h.attach(h.agentCtx, { kind: "global" }, { channel: "admin", sessionId: "s1" });
    expect(h.tools).toHaveLength(1);
  });

  it("classifies a project fact to global through the llm seat when selection is present", async () => {
    const llm: LlmClassifierSeat = {
      stream() {
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: "text-delta", index: 0, text: "global" };
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      }
    };
    const h = harness([record({ id: "a", text: "hello" })], { writable: true, llm }) as HarnessWithAttach;
    h.attach(
      h.agentCtx,
      { kind: "project", name: "myproj" },
      { channel: "telegram", sessionId: "s1", selection: { provider: "p", model: "m" } }
    );
    expect(h.tools.map((tool) => (tool as { name: string }).name)).toEqual(["recall", "remember"]);
    const remember = h.tools[1] as { execute(args: { text: string }, ctx: never): Promise<unknown> };
    await remember.execute({ text: "owner prefers Russian" }, {} as never);
    expect(h.drafts).toHaveLength(1);
    expect(h.drafts[0]).toMatchObject({ scope: { kind: "global" }, text: "owner prefers Russian" });
    expect(h.infos.join("\n")).toContain("classified=true");
  });
});

describe("createMemoryContext metrics", () => {
  it("records one delivery event with the path ids, the omitted counts and the block sizes", async () => {
    const ledger = createMemoryMetricsLedger();
    const records = [
      record({ id: "core", text: "Pinned deploy rule", pinned: true }),
      record({ id: "push", text: "deploy rollback procedure" })
    ];
    const h = harness(records, {}, ledger) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "global" }, { channel: "admin", sessionId: "s1" });
    await attachment.prepare("deploy");
    const snap: MemoryMetricsSnapshot = ledger.snapshot();
    expect(snap.window.turns).toBe(1);
    expect(snap.byChannel.admin).toEqual({ turns: 1, deliveries: 3 });
    expect(snap.byScope.global).toEqual({ turns: 1, deliveries: 3 });
    const core = snap.topRecords.find((entry) => entry.id === "core");
    const push = snap.topRecords.find((entry) => entry.id === "push");
    expect(core).toMatchObject({ type: "fact", scope: "global", inCore: 1, inMap: 0, inPush: 0 });
    expect(push).toMatchObject({ inCore: 0, inMap: 1, inPush: 1 });
    expect(snap.unqueriedDelivered).toBe(2);
    // chars must be the summed size of the rendered blocks the production code
    // delivered, so a `chars: 0` regression cannot slip through.
    const coreBlock = renderCore(records.filter((entry) => entry.pinned));
    const mapBlock = renderMap(records, records.length, new Set(coreBlock.shown));
    const pushBlock = renderPush(
      records.filter((entry) => entry.text.includes("deploy")).map((entry) => ({ record: entry, rank: -1 })),
      new Set(coreBlock.shown)
    );
    const expectedChars = coreBlock.text.length + mapBlock.text.length + pushBlock.text.length;
    expect(expectedChars).toBeGreaterThan(0);
    expect(ledger.windowChars()).toBe(expectedChars);
  });

  it("keeps the rendered blocks when the delivery sink throws", async () => {
    const throwing: MemoryMetricsSink = {
      recordDelivery() {
        throw new Error("sink exploded");
      },
      recordRecall() {}
    };
    const h = harness(
      [
        record({ id: "core", text: "Pinned deploy rule", pinned: true }),
        record({ id: "push", text: "deploy rollback procedure" })
      ],
      {},
      throwing
    ) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "global" }, { channel: "admin", sessionId: "s1" });
    await expect(attachment.prepare("deploy")).resolves.toBeUndefined();
    expect(h.sections[0]!.text()).toContain("Pinned deploy rule");
    expect(h.contexts[0]!.text()).toContain("deploy rollback procedure");
    expect(h.warnings.join("\n")).toMatch(/metrics/);
    expect(h.warnings.join("\n")).not.toContain("prepare failed");
    expect(h.warnings.join("\n")).not.toContain("deploy rollback procedure");
  });

  it("does not record a delivery when prepare fails", async () => {
    const ledger = createMemoryMetricsLedger();
    const h = harness([], {}, ledger) as HarnessWithAttach;
    const failing = {
      get(key: string): unknown {
        if (key === "balbesMemory") {
          return { list: async () => { throw new Error("db down"); }, count: async () => 0, search: async () => [] };
        }
        return (h.agentCtx as { get(key: string): unknown }).get(key);
      }
    };
    const attachment = h.attach(failing, { kind: "global" }, { channel: "admin", sessionId: "s1" });
    await attachment.prepare("x");
    const snap = ledger.snapshot();
    expect(snap.window.turns).toBe(0);
    expect(snap.topRecords).toEqual([]);
  });

  it("tags an unattributed delivery as project-less and unknown channel", async () => {
    const ledger = createMemoryMetricsLedger();
    const h = harness([record({ id: "a", text: "anything" })], {}, ledger) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "project", name: "proj" });
    await attachment.prepare("anything");
    const snap = ledger.snapshot();
    expect(snap.byChannel.unknown).toEqual({ turns: 1, deliveries: 1 });
    expect(snap.byScope["project:proj"]).toEqual({ turns: 1, deliveries: 1 });
  });
});
