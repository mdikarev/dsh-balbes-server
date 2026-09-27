import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import { buildRecallTool, clampRecallLimit, RECALL_DEFAULT_LIMIT, RECALL_MAX_LIMIT } from "../src/recall.js";
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

describe("clampRecallLimit", () => {
  it("defaults, floors and caps", () => {
    expect(clampRecallLimit(undefined)).toBe(RECALL_DEFAULT_LIMIT);
    expect(clampRecallLimit(0)).toBe(1);
    expect(clampRecallLimit(999)).toBe(RECALL_MAX_LIMIT);
  });
});
