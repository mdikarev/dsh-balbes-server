import { describe, expect, it } from "vitest";
import { MemoryError } from "../src/errors.js";
import {
  assertScope,
  normalizeDecisionPatch,
  normalizeDraft,
  normalizeFilter,
  normalizeProposalDraft,
  normalizeProposalFilter,
  normalizeTags
} from "../src/validate.js";

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

  it("reports invalid-record for a malformed record tag", () => {
    expect(codeOf(() => normalizeDraft({ ...base, tags: ["bad tag"] }))).toBe("invalid-record");
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

  it("reports invalid-filter for a malformed tag", () => {
    expect(codeOf(() => normalizeFilter({ tag: "bad tag" }))).toBe("invalid-filter");
    expect(codeOf(() => normalizeFilter({ tag: "" }))).toBe("invalid-filter");
  });
});

/** The stable error code a throwing call produced, or undefined. */
function codeOf(call: () => unknown): string | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("proposal normalizers", () => {
  const base = { scope: { kind: "global" }, type: "fact", text: "deploy runs under systemd" };

  it("normalizes a proposal draft, trims text and lowercases tags", () => {
    expect(normalizeProposalDraft({ ...base, text: "  deploy runs  ", tags: ["Ops", "ops"] })).toEqual({
      scope: { kind: "global" },
      type: "fact",
      text: "deploy runs",
      tags: ["ops"],
      originRef: null
    });
  });

  it("keeps a provided originRef and rejects a non-string one", () => {
    expect(normalizeProposalDraft({ ...base, originRef: "pipeline:extraction telegram session:s1" }).originRef)
      .toBe("pipeline:extraction telegram session:s1");
    expect(codeOf(() => normalizeProposalDraft({ ...base, originRef: 5 }))).toBe("invalid-record");
  });

  it("rejects an unknown type and a bad scope", () => {
    expect(codeOf(() => normalizeProposalDraft({ ...base, type: "rumor" }))).toBe("invalid-record");
    expect(codeOf(() => normalizeProposalDraft({ ...base, scope: { kind: "galaxy" } }))).toBe("invalid-scope");
  });

  it("normalizes a proposal filter and rejects unknown statuses", () => {
    expect(normalizeProposalFilter({ status: ["proposed", "rejected"], tag: "Ops", limit: 5 })).toEqual({
      status: ["proposed", "rejected"],
      tag: "ops",
      limit: 5
    });
    expect(codeOf(() => normalizeProposalFilter({ status: ["maybe"] }))).toBe("invalid-filter");
    expect(codeOf(() => normalizeProposalFilter({ status: "proposed" }))).toBe("invalid-filter");
    expect(codeOf(() => normalizeProposalFilter({ status: [] }))).toBe("invalid-filter");
    expect(codeOf(() => normalizeProposalFilter({ tag: "bad tag" }))).toBe("invalid-filter");
    expect(codeOf(() => normalizeProposalFilter({ tag: "" }))).toBe("invalid-filter");
  });

  it("drops identity and provenance fields from a decision patch", () => {
    expect(
      normalizeDecisionPatch({ text: " edited ", tags: ["A"], pinned: true, id: "spoof", originRef: "spoof" })
    ).toEqual({ text: "edited", tags: ["a"], pinned: true });
    expect(normalizeDecisionPatch({})).toEqual({});
  });
});
