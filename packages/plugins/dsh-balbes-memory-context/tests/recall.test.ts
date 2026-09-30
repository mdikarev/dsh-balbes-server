import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import { buildRecallTool, clampRecallLimit, RECALL_DEFAULT_LIMIT, RECALL_MAX_LIMIT } from "../src/recall.js";
import { createMemoryMetricsLedger } from "../src/metrics.js";
import type { BalbesMemoryReadSlice } from "../src/types.js";

function record(id: string, text: string): MemoryRecord {
  return {
    id,
    scope: { kind: "global" },
    type: "fact",
    text,
    tags: ["deploy"],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z"
  };
}

describe("buildRecallTool", () => {
  it("searches within the fixed scopes and returns the records", async () => {
    const calls: unknown[] = [];
    const memory: BalbesMemoryReadSlice = {
      list: async () => [],
      count: async () => 0,
      search: async (request) => {
        calls.push(request);
        return [{ record: record("a", "deploy procedure"), rank: -1 }];
      }
    };
    const tool = buildRecallTool(memory, [{ kind: "global" }, { kind: "project", name: "proj" }]);
    const value = (await tool.execute({ query: "deploy rollback", limit: 5 }, {} as never)) as {
      records: MemoryRecord[];
    };
    expect(value.records.map((r) => r.id)).toEqual(["a"]);
    expect(calls).toEqual([
      {
        query: '"deploy" OR "rollback"',
        filter: { scopes: [{ kind: "global" }, { kind: "project", name: "proj" }] },
        limit: 5
      }
    ]);
  });

  it("returns nothing for a query with no usable terms", async () => {
    const memory: BalbesMemoryReadSlice = {
      list: async () => [],
      count: async () => 0,
      search: async () => {
        throw new Error("search must not be called");
      }
    };
    const tool = buildRecallTool(memory, [{ kind: "global" }]);
    const value = (await tool.execute({ query: "!!!" }, {} as never)) as { records: MemoryRecord[] };
    expect(value.records).toEqual([]);
  });

  it("surfaces a service failure as a stable tool error", async () => {
    const memory: BalbesMemoryReadSlice = {
      list: async () => [],
      count: async () => 0,
      search: async () => {
        throw new Error("db exploded");
      }
    };
    const tool = buildRecallTool(memory, [{ kind: "global" }]);
    await expect(tool.execute({ query: "deploy" }, {} as never)).rejects.toThrow(
      new Error("recall failed: memory search is unavailable")
    );
  });

  it("passes type/tag/pinned filters through", async () => {
    let seen: unknown;
    const memory: BalbesMemoryReadSlice = {
      list: async () => [],
      count: async () => 0,
      search: async (request) => {
        seen = request;
        return [];
      }
    };
    const tool = buildRecallTool(memory, [{ kind: "global" }]);
    await tool.execute({ query: "deploy", type: "decision", tag: "prod", pinned: true }, {} as never);
    expect(seen).toEqual({
      query: '"deploy"',
      filter: { scopes: [{ kind: "global" }], type: "decision", tag: "prod", pinned: true },
      limit: RECALL_DEFAULT_LIMIT
    });
  });

  it("renders provenance in the model-facing text", () => {
    const tool = buildRecallTool({ list: async () => [], count: async () => 0, search: async () => [] }, [
      { kind: "global" }
    ]);
    const value = { records: [record("a", "deploy procedure")] };
    const blocks = tool.output.render({ query: "deploy" } as never, value as never);
    const text = blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(text).toContain("deploy procedure");
    expect(text).toContain("id: a");
    expect(text).toContain("владелец");
  });
});

describe("buildRecallTool metrics", () => {
  it("records ok with the delivered ids and the latency", async () => {
    const ledger = createMemoryMetricsLedger();
    const memory: BalbesMemoryReadSlice = {
      list: async () => [],
      count: async () => 0,
      search: async () => [{ record: record("a", "deploy procedure"), rank: -1 }]
    };
    const tool = buildRecallTool(memory, [{ kind: "global" }], ledger, { channel: "telegram", scope: "project:proj" });
    await tool.execute({ query: "deploy" }, {} as never);
    const snap = ledger.snapshot();
    expect(snap.recall.calls).toBe(1);
    expect(snap.recall.empty).toBe(0);
    expect(snap.recall.latencyMs.max).toBeGreaterThanOrEqual(0);
    expect(snap.topRecords.find((entry) => entry.id === "a")).toMatchObject({
      type: "fact",
      scope: "project:proj",
      recallDelivered: 1,
      recallQueries: 1
    });
  });

  it("records empty for a blank query without touching the store", async () => {
    const ledger = createMemoryMetricsLedger();
    const memory: BalbesMemoryReadSlice = {
      list: async () => [],
      count: async () => 0,
      search: async () => {
        throw new Error("search must not be called");
      }
    };
    const tool = buildRecallTool(memory, [{ kind: "global" }], ledger, { channel: "admin", scope: "global" });
    await tool.execute({ query: "!!!" }, {} as never);
    expect(ledger.snapshot().recall.empty).toBe(1);
  });

  it("records empty when the search returns nothing", async () => {
    const ledger = createMemoryMetricsLedger();
    const memory: BalbesMemoryReadSlice = { list: async () => [], count: async () => 0, search: async () => [] };
    const tool = buildRecallTool(memory, [{ kind: "global" }], ledger, { channel: "admin", scope: "global" });
    await tool.execute({ query: "deploy" }, {} as never);
    expect(ledger.snapshot().recall.empty).toBe(1);
  });

  it("records failed and still surfaces the tool error", async () => {
    const ledger = createMemoryMetricsLedger();
    const memory: BalbesMemoryReadSlice = {
      list: async () => [],
      count: async () => 0,
      search: async () => {
        throw new Error("db down");
      }
    };
    const tool = buildRecallTool(memory, [{ kind: "global" }], ledger, { channel: "admin", scope: "global" });
    await expect(tool.execute({ query: "deploy" }, {} as never)).rejects.toThrow(/recall failed/);
    const snap = ledger.snapshot();
    expect(snap.recall.failed).toBe(1);
    expect(snap.recall.empty).toBe(0);
  });
});

describe("clampRecallLimit", () => {
  it("defaults, floors and caps", () => {
    expect(clampRecallLimit(undefined)).toBe(RECALL_DEFAULT_LIMIT);
    expect(clampRecallLimit(0)).toBe(1);
    expect(clampRecallLimit(999)).toBe(RECALL_MAX_LIMIT);
  });
});
