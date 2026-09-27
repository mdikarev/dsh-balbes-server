import { describe, expect, it } from "vitest";
import { buildFtsQuery, tokenizeQuery, MAX_QUERY_TOKENS } from "../src/query.js";

describe("buildFtsQuery", () => {
  it("lower-cases, de-duplicates and quotes terms joined by OR", () => {
    expect(buildFtsQuery("Deploy the Deploy command!")).toBe('"deploy" OR "the" OR "command"');
  });

  it("drops one-character terms", () => {
    expect(buildFtsQuery("a go to x y")).toBe('"go" OR "to"');
  });

  it("returns an empty string when no usable term remains", () => {
    expect(buildFtsQuery(" !!! ,, a ")).toBe("");
    expect(tokenizeQuery("!!!")).toEqual([]);
  });

  it("caps the number of terms", () => {
    const words = Array.from({ length: 40 }, (_, index) => "term" + index).join(" ");
    expect(tokenizeQuery(words).length).toBe(MAX_QUERY_TOKENS);
  });

  it("never emits a bare FTS operator from raw task text", () => {
    expect(buildFtsQuery('deploy AND "prod" OR *')).toBe('"deploy" OR "and" OR "prod" OR "or"');
  });
});
