import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import {
  createMemoryContext,
  MEMORY_CONTEXT_NAME,
  MEMORY_CONTEXT_ORDER,
  MEMORY_SECTION_NAME,
  MEMORY_SECTION_ORDER
} from "../src/context.js";
import type { BalbesMemoryReadSlice, MemoryReadFilter } from "../src/types.js";

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
}

function harness(records: MemoryRecord[], options: { withoutTools?: boolean } = {}): Harness {
  const sections: SectionSpec[] = [];
  const contexts: SectionSpec[] = [];
  const tools: unknown[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const memory: BalbesMemoryReadSlice = {
    list: async (_filter?: MemoryReadFilter) => records,
    count: async (_filter?: MemoryReadFilter) => records.length,
    search: async () =>
      records.filter((r) => r.text.includes("deploy")).map((r) => ({ record: r, rank: -1 }))
  };
  const agentCtx = {
    get(key: string): unknown {
      if (key === "balbesMemory") return memory;
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
  const service = createMemoryContext({
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message)
  });
  const harnessValue: Harness = { agentCtx, sections, contexts, tools, warnings, infos };
  Object.defineProperty(harnessValue, "attach", {
    value: service.attach.bind(service),
    enumerable: false
  });
  return harnessValue;
}

type HarnessWithAttach = Harness & {
  attach(agentCtx: unknown, scope: { kind: "global" } | { kind: "project"; name: string }): {
    prepare(taskText: string): Promise<void>;
  };
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
    expect(h.infos.join("\n")).toContain("scope=global");
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
});
