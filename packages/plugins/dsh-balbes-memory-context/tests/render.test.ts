import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import {
  CORE_BUDGET,
  escapeInterpolation,
  renderCore,
  renderMap,
  renderPush
} from "../src/render.js";

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

describe("renderCore", () => {
  it("renders only the records it is given, with provenance", () => {
    const result = renderCore([
      record({ id: "a", text: "Deploy via install.sh", pinned: true, tags: ["deploy"] }),
      record({ id: "b", text: "Prefer pnpm", type: "preference", origin: "agent", scope: { kind: "project", name: "proj" }, pinned: true })
    ]);
    expect(result.shown).toEqual(["a", "b"]);
    expect(result.text).toContain("## Long-term memory (pinned)");
    expect(result.text).toContain("- [fact · владелец] (дом) Deploy via install.sh #deploy");
    expect(result.text).toContain("- [preference · агент] (проект proj) Prefer pnpm");
  });

  it("is empty for no records", () => {
    expect(renderCore([])).toEqual({ text: "", shown: [], omitted: 0, records: [] });
  });

  it("omits records that do not fit and counts them", () => {
    const big = record({ id: "big", text: "x".repeat(CORE_BUDGET), pinned: true });
    const result = renderCore([record({ id: "small", text: "fits", pinned: true }), big]);
    expect(result.shown).toEqual(["small"]);
    expect(result.text).toContain("ещё 1 закреплённых записей не поместились");
  });

  it("truncates the first oversized record and renders no later record", () => {
    const result = renderCore([
      record({ id: "huge", text: "y".repeat(CORE_BUDGET * 2), pinned: true }),
      record({ id: "next", text: "must not appear", pinned: true })
    ]);
    expect(result.shown).toEqual(["huge"]);
    expect(result.text).not.toContain("must not appear");
    expect(result.text).toContain("…");
  });
});

describe("renderMap", () => {
  it("skips core-shown records and counts the remainder", () => {
    const records = [
      record({ id: "a", text: "core", pinned: true }),
      record({ id: "b", text: "mapped one" }),
      record({ id: "c", text: "mapped two" })
    ];
    const result = renderMap(records, 3, new Set(["a"]));
    expect(result.shown).toEqual(["b", "c"]);
    expect(result.text).toContain("## Memory map");
    expect(result.text).not.toContain("core");
  });

  it("counts records beyond the returned list", () => {
    const result = renderMap([record({ id: "b", text: "one" })], 10, new Set());
    expect(result.text).toContain("ещё 9 записей не показаны");
  });

  it("is empty when nothing remains", () => {
    expect(renderMap([record({ id: "a", text: "core", pinned: true })], 1, new Set(["a"]))).toEqual({
      text: "",
      shown: [],
      omitted: 0,
      records: []
    });
  });
});

describe("renderPush", () => {
  it("renders hits and skips core-shown records", () => {
    const result = renderPush(
      [
        { record: record({ id: "a", text: "core" }), rank: -1 },
        { record: record({ id: "b", text: "relevant deploy note", tags: ["deploy"] }), rank: -2 }
      ],
      new Set(["a"])
    );
    expect(result.shown).toEqual(["b"]);
    expect(result.text).toContain("- [fact · владелец] (дом) relevant deploy note #deploy");
  });

  it("is empty with no hits", () => {
    expect(renderPush([], new Set())).toEqual({ text: "", shown: [], omitted: 0, records: [] });
  });
});

describe("escapeInterpolation", () => {
  it("escapes strict prompt interpolation to a fixed point", () => {
    expect(escapeInterpolation("{{{x}}}")).toBe("{ { {x}}}");
    expect(escapeInterpolation("plain")).toBe("plain");
  });
});
