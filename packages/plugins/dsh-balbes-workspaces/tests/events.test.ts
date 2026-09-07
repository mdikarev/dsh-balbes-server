import { describe, expect, it } from "vitest";
import { toChangeEvent } from "../src/events.js";

describe("toChangeEvent mapping", () => {
  it("maps home changes to the parent dir of the changed entry", () => {
    expect(toChangeEvent("home", "self.md")).toEqual({ kind: "fs", scope: "home", path: "" });
    expect(toChangeEvent("home", "notes/a.md")).toEqual({ kind: "fs", scope: "home", path: "notes" });
    expect(toChangeEvent("home", "skills/")?.kind).toBe("fs");
  });

  it("maps project-internal changes with the project scope and name", () => {
    expect(toChangeEvent("projects", "alpha/src/main.ts")).toEqual({ kind: "fs", scope: "project", name: "alpha", path: "src" });
    expect(toChangeEvent("projects", "alpha/readme.md")).toEqual({ kind: "fs", scope: "project", name: "alpha", path: "" });
  });

  it("maps depth-0 changes under projects to a list event", () => {
    expect(toChangeEvent("projects", "alpha")).toEqual({ kind: "list" });
    expect(toChangeEvent("projects", "beta/")).toEqual({ kind: "list" });
  });

  it("ignores changes of hidden project dirs (registry bookkeeping)", () => {
    expect(toChangeEvent("projects", ".alpha/x")).toBeNull();
  });

  it("handles empty and null-ish raw paths defensively", () => {
    expect(toChangeEvent("home", "")).toEqual({ kind: "fs", scope: "home", path: "" });
  });
});
