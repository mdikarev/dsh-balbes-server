import { describe, expect, it } from "vitest";
import { createSseParser } from "../src/api/sse";

describe("createSseParser", () => {
  it("emits data payloads split across arbitrary chunk boundaries", () => {
    const out: string[] = [];
    const feed = createSseParser((d) => out.push(d));
    feed('data: {"a":1}\n\ndata: {"b');
    feed('":2}\n\n');
    feed(': ping\n\n');
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("ignores comment-only frames and trailing partials", () => {
    const out: string[] = [];
    const feed = createSseParser((d) => out.push(d));
    feed(": ping\n\n");
    feed('data: {"x":1}\n\n');
    feed("data: {");
    expect(out).toEqual(['{"x":1}']);
  });
});
