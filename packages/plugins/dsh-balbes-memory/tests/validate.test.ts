import { describe, expect, it } from "vitest";
import { MemoryError } from "../src/errors.js";
import { assertScope, normalizeDraft, normalizeFilter, normalizeTags } from "../src/validate.js";

describe("assertScope", () => {
  it("accepts global without a name", () => {
    expect(assertScope({ kind: "global" })).toEqual({ kind: "global" });
  });

  it("accepts a project slug", () => {
    expect(assertScope({ kind: "project", name: "dsh-balbes-server" })).toEqual({
      kind: "project",
      name: "dsh-balbes-server"
    });
  });

  it("rejects a global scope with a name", () => {
    expect(() => assertScope({ kind: "global", name: "x" })).toThrowError(MemoryError);
  });

  it("rejects a project scope without a name", () => {
    expect(() => assertScope({ kind: "project" })).toThrowError(MemoryError);
  });

  it("rejects traversal, hidden, empty and slash names", () => {
    for (const name of ["..", ".", ".hidden", "trailing.", "a/b", ""]) {
      expect(() => assertScope({ kind: "project", name })).toThrowError(MemoryError);
    }
  });
});

describe("normalizeTags", () => {
  it("lowercases, trims and dedups", () => {
    expect(normalizeTags([" Ops ", "ops", "Deploy"])).toEqual(["ops", "deploy"]);
  });

  it("rejects invalid tags", () => {
    expect(() => normalizeTags(["bad tag"])).toThrowError(MemoryError);
    expect(() => normalizeTags([1])).toThrowError(MemoryError);
  });

  it("returns an empty array for undefined", () => {
    expect(normalizeTags(undefined)).toEqual([]);
  });
});

describe("normalizeDraft", () => {
  const base = { scope: { kind: "global" }, type: "fact", text: " hello ", origin: "owner" };

  it("trims text and defaults tags/pinned/originRef", () => {
    expect(normalizeDraft(base)).toEqual({
      scope: { kind: "global" },
      type: "fact",
      text: "hello",
      tags: [],
      pinned: false,
      origin: "owner",
      originRef: null
    });
  });

  it("rejects an unknown type or origin", () => {
    expect(() => normalizeDraft({ ...base, type: "diary" })).toThrowError(MemoryError);
    expect(() => normalizeDraft({ ...base, origin: "system" })).toThrowError(MemoryError);
  });

  it("rejects empty and oversized text", () => {
    expect(() => normalizeDraft({ ...base, text: "   " })).toThrowError(MemoryError);
    expect(() => normalizeDraft({ ...base, text: "x".repeat(9000) })).toThrowError(MemoryError);
  });
});

describe("normalizeFilter", () => {
  it("returns an empty filter for undefined", () => {
    expect(normalizeFilter(undefined)).toEqual({});
  });

  it("validates and normalizes a tag", () => {
    expect(normalizeFilter({ tag: " OPS " })).toEqual({ tag: "ops" });
  });

  it("rejects a negative limit", () => {
    expect(() => normalizeFilter({ limit: -1 })).toThrowError(MemoryError);
  });
});
