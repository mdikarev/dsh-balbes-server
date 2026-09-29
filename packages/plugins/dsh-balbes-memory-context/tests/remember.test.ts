import { describe, expect, it } from "vitest";
import { resolveWriteScope } from "../src/remember.js";

describe("resolveWriteScope", () => {
  it("always writes to global from a global context", () => {
    expect(resolveWriteScope({ kind: "global" }, undefined)).toEqual({ kind: "global" });
    expect(resolveWriteScope({ kind: "global" }, "project")).toEqual({ kind: "global" });
  });

  it("honours a global classification inside a project context", () => {
    expect(resolveWriteScope({ kind: "project", name: "myproj" }, "global")).toEqual({ kind: "global" });
  });

  it("falls back to the current project", () => {
    expect(resolveWriteScope({ kind: "project", name: "myproj" }, "project")).toEqual({
      kind: "project",
      name: "myproj"
    });
    expect(resolveWriteScope({ kind: "project", name: "myproj" }, undefined)).toEqual({
      kind: "project",
      name: "myproj"
    });
  });
});
