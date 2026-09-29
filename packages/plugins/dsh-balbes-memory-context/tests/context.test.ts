import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import {
  createMemoryContext,
  MEMORY_CONTEXT_NAME,
  MEMORY_CONTEXT_ORDER,
  MEMORY_SECTION_NAME,
  MEMORY_SECTION_ORDER
} from "../src/context.js";
import type { LlmClassifierSeat } from "../src/classify.js";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import type { BalbesMemoryReadSlice, MemoryReadFilter, MemoryWriteContext } from "../src/types.js";

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
  /** Drafts the fake store's save received, in call order. */
  drafts: Array<Record<string, unknown>>;
}

function harness(
  records: MemoryRecord[],
  options: { withoutTools?: boolean; writable?: boolean; llm?: LlmClassifierSeat } = {}
): Harness {
  const sections: SectionSpec[] = [];
  const contexts: SectionSpec[] = [];
  const tools: unknown[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
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
  const service = createMemoryContext({
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message)
  });
  const harnessValue: Harness = { agentCtx, sections, contexts, tools, warnings, infos, drafts };
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
