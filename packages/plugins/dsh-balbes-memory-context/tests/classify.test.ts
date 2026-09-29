import { describe, expect, it } from "vitest";
import { classifyUserMessage, parseScopeAnswer } from "../src/classify.js";

describe("parseScopeAnswer", () => {
  it("accepts a single clear word", () => {
    expect(parseScopeAnswer("global")).toBe("global");
    expect(parseScopeAnswer("project")).toBe("project");
    expect(parseScopeAnswer("  GLOBAL\n")).toBe("global");
  });

  it("accepts a one-word sentence", () => {
    expect(parseScopeAnswer("project.")).toBe("project");
  });

  it("rejects an ambiguous answer that names both scopes", () => {
    expect(parseScopeAnswer("not project-specific but global")).toBeUndefined();
  });

  it("rejects empty or unrelated text", () => {
    expect(parseScopeAnswer("")).toBeUndefined();
    expect(parseScopeAnswer("maybe later")).toBeUndefined();
  });
});

describe("classifyUserMessage", () => {
  it("carries the project name and the fact", () => {
    expect(classifyUserMessage("myproj", "deploy via install.sh")).toBe(
      "Project: myproj\nFact: deploy via install.sh"
    );
  });
});
