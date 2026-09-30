import { describe, expect, it } from "vitest";
import type { MemoryProposal, MemoryRecord } from "dsh-balbes-contracts";
import {
  buildProposeTool,
  createExtractionCounters,
  createProposalIndex,
  loadProposalIndex,
  normalizeProposalText,
  EXTRACTION_MAX_PROPOSALS
} from "../src/propose.js";
import type {
  MemoryContextScope,
  MemoryExtractionSlice,
  MemoryProposalDraft,
  MemoryProposalSlice
} from "../src/types.js";

/** Тип результата вызова инструмента: `defineTool` отдаёт `execute(): Promise<unknown>`. */
type ProposeResult = { status: string; proposal: MemoryProposal | null };

function proposal(partial: Partial<MemoryProposal>): MemoryProposal {
  return {
    id: "p1",
    scope: { kind: "global" },
    type: "note",
    text: "fact",
    tags: [],
    origin: "agent",
    originRef: null,
    status: "proposed",
    proposedAt: "2026-09-30T00:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    decidedEdit: false,
    memoryId: null,
    ...partial
  };
}

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

function harness(options: { scope?: MemoryContextScope; seed?: string[]; fail?: Error } = {}) {
  const drafts: MemoryProposalDraft[] = [];
  const memory: MemoryProposalSlice = {
    propose: async (draft) => {
      if (options.fail !== undefined) throw options.fail;
      drafts.push(draft);
      return proposal({ scope: draft.scope, type: draft.type, text: draft.text, originRef: draft.originRef ?? null });
    },
    listProposals: async () => []
  };
  const counters = createExtractionCounters();
  const tool = buildProposeTool(
    memory,
    options.scope ?? { kind: "global" },
    { channel: "telegram", sessionId: "s1" },
    counters,
    async () => createProposalIndex(options.seed ?? [])
  );
  return { tool, drafts, counters };
}

describe("buildProposeTool", () => {
  it("has no scope or pinned parameter", () => {
    const { tool } = harness({});
    const parameters = JSON.stringify(tool.parameters);
    expect(parameters).not.toContain("scope");
    expect(parameters).not.toContain("pinned");
  });

  it("proposes through the review path with the channel provenance", async () => {
    const { tool, drafts, counters } = harness({});
    const value = (await tool.execute(
      { text: "Деплой в пятницу", type: "fact", tags: ["deploy"] },
      {} as never
    )) as ProposeResult;
    expect(drafts).toEqual([
      {
        scope: { kind: "global" },
        type: "fact",
        text: "Деплой в пятницу",
        tags: ["deploy"],
        originRef: "telegram session:s1"
      }
    ]);
    expect(counters.proposed).toBe(1);
    expect(value.status).toBe("proposed");
    expect((value.proposal as unknown as MemoryProposal).id).toBe("p1");
  });

  it("keeps a project fact in the current project scope", async () => {
    const { tool, drafts } = harness({ scope: { kind: "project", name: "myproj" } });
    await tool.execute({ text: "в проекте свой деплой" }, {} as never);
    expect(drafts[0]).toMatchObject({ scope: { kind: "project", name: "myproj" }, type: "note" });
  });

  it("skips a normalized exact duplicate of a known text", async () => {
    const { tool, drafts, counters } = harness({ seed: [normalizeProposalText("Deploy  is  Friday")] });
    const value = (await tool.execute({ text: "deploy is friday" }, {} as never)) as ProposeResult;
    expect(value.status).toBe("duplicate");
    expect(value.proposal).toBeNull();
    expect(drafts).toHaveLength(0);
    expect(counters.duplicate).toBe(1);
  });

  it("remembers its own proposal so a repeat in one turn is a duplicate", async () => {
    const { tool, drafts, counters } = harness({});
    await tool.execute({ text: "Одно и то же" }, {} as never);
    const again = (await tool.execute({ text: "  одно   и то же " }, {} as never)) as ProposeResult;
    expect(again.status).toBe("duplicate");
    expect(drafts).toHaveLength(1);
    expect(counters).toEqual({ proposed: 1, duplicate: 1, secret: 0, limit: 0 });
  });

  it("caps one turn at three proposals", async () => {
    const { tool, drafts, counters } = harness({});
    for (let index = 0; index < EXTRACTION_MAX_PROPOSALS; index += 1) {
      await tool.execute({ text: "факт " + index }, {} as never);
    }
    await expect(tool.execute({ text: "четвёртый" }, {} as never)).rejects.toThrow(
      "propose_memory: extraction limit reached (3 proposals per turn)"
    );
    expect(drafts).toHaveLength(EXTRACTION_MAX_PROPOSALS);
    expect(counters).toEqual({ proposed: 3, duplicate: 0, secret: 0, limit: 1 });
  });

  it("rejects a secret candidate and keeps counting the turn", async () => {
    const { tool, drafts, counters } = harness({
      fail: Object.assign(new Error("looks like a key"), { code: "secret-detected" })
    });
    await expect(tool.execute({ text: "sk-secret" }, {} as never)).rejects.toThrow(
      "propose_memory rejected: text looks like a secret"
    );
    expect(drafts).toHaveLength(0);
    expect(counters.secret).toBe(1);
    expect(counters.proposed).toBe(0);
  });

  it("surfaces a store failure as a stable tool error", async () => {
    const { tool } = harness({ fail: new Error("db down") });
    await expect(tool.execute({ text: "факт" }, {} as never)).rejects.toThrow("propose_memory failed: db down");
  });
});

describe("loadProposalIndex", () => {
  it("seeds from records and from pending proposals of both scopes", async () => {
    const calls: unknown[] = [];
    const memory: MemoryExtractionSlice = {
      propose: async () => proposal({}),
      list: async (filter) => {
        calls.push(filter);
        return [record({ id: "r1", text: "Из памяти" })];
      },
      listProposals: async (filter) => {
        calls.push(filter);
        return [proposal({ text: "Из очереди" })];
      }
    };
    const warnings: string[] = [];
    const index = await loadProposalIndex(
      memory,
      [{ kind: "global" }, { kind: "project", name: "myproj" }],
      { warn: (message) => warnings.push(message) }
    );
    expect(index.has(normalizeProposalText("из памяти"))).toBe(true);
    expect(index.has(normalizeProposalText("из очереди"))).toBe(true);
    expect(index.has(normalizeProposalText("чего-то другого"))).toBe(false);
    expect(warnings).toEqual([]);
    // one record read and one pending read per scope
    expect(calls).toHaveLength(3);
  });

  it("degrades to no dedup when the store fails", async () => {
    const memory: MemoryExtractionSlice = {
      propose: async () => proposal({}),
      list: async () => {
        throw new Error("db down");
      },
      listProposals: async () => []
    };
    const warnings: string[] = [];
    const index = await loadProposalIndex(memory, [{ kind: "global" }], {
      warn: (message) => warnings.push(message)
    });
    expect(index.has(normalizeProposalText("что угодно"))).toBe(false);
    expect(warnings.join("\n")).toContain("dedup index unavailable");
  });
});
