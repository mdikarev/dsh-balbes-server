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

import type { MemoryRecord } from "dsh-balbes-contracts";
import { buildRememberTool } from "../src/remember.js";
import type { ClassifyScope } from "../src/classify.js";
import type { MemoryContextScope, MemoryWriteContext, MemoryWriteSlice } from "../src/types.js";

function savedRecord(partial: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "new",
    scope: { kind: "global" },
    type: "note",
    text: "fact",
    tags: [],
    pinned: false,
    origin: "agent",
    originRef: "admin session:s1",
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...partial
  };
}

function harness(options: {
  scope?: MemoryContextScope;
  classify?: ClassifyScope;
  fail?: Error;
}) {
  const drafts: Array<Record<string, unknown>> = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const memory: MemoryWriteSlice = {
    save: async (draft) => {
      if (options.fail !== undefined) throw options.fail;
      drafts.push(draft as unknown as Record<string, unknown>);
      return savedRecord({ scope: draft.scope, type: draft.type, text: draft.text, originRef: draft.originRef ?? null });
    }
  };
  const write: MemoryWriteContext = { channel: "admin", sessionId: "s1" };
  const tool = buildRememberTool(
    memory,
    options.scope ?? { kind: "global" },
    write,
    options.classify,
    { warn: (message) => warnings.push(message), info: (message) => infos.push(message) }
  );
  return { tool, drafts, infos, warnings };
}

describe("buildRememberTool", () => {
  it("has no scope or pinned parameter", () => {
    const { tool } = harness({});
    const parameters = JSON.stringify(tool.parameters);
    expect(parameters).not.toContain("scope");
    expect(parameters).not.toContain("pinned");
  });

  it("writes to global from a global context without classifying", async () => {
    let classified = 0;
    const { tool, drafts } = harness({
      classify: async () => {
        classified += 1;
        return "global";
      }
    });
    await tool.execute({ text: "owner prefers Russian" }, {} as never);
    expect(classified).toBe(0);
    expect(drafts).toEqual([
      {
        scope: { kind: "global" },
        type: "note",
        text: "owner prefers Russian",
        pinned: false,
        origin: "agent",
        originRef: "admin session:s1"
      }
    ]);
  });

  it("lets the classifier promote a project fact to global", async () => {
    const { tool, drafts } = harness({
      scope: { kind: "project", name: "myproj" },
      classify: async () => "global"
    });
    await tool.execute({ text: "global fact", type: "fact" }, {} as never);
    expect(drafts[0]).toMatchObject({ scope: { kind: "global" }, type: "fact" });
  });

  it("keeps a project fact in the current project", async () => {
    const { tool, drafts } = harness({
      scope: { kind: "project", name: "myproj" },
      classify: async () => "project"
    });
    await tool.execute({ text: "project fact", tags: ["deploy"] }, {} as never);
    expect(drafts[0]).toMatchObject({
      scope: { kind: "project", name: "myproj" },
      tags: ["deploy"]
    });
  });

  it("falls back to the current project when classification is undefined or throws", async () => {
    const none = harness({ scope: { kind: "project", name: "myproj" } });
    await none.tool.execute({ text: "a" }, {} as never);
    expect(none.drafts[0]).toMatchObject({ scope: { kind: "project", name: "myproj" } });

    const boom = harness({
      scope: { kind: "project", name: "myproj" },
      classify: async () => {
        throw new Error("llm down");
      }
    });
    await boom.tool.execute({ text: "b" }, {} as never);
    expect(boom.drafts[0]).toMatchObject({ scope: { kind: "project", name: "myproj" } });
    expect(boom.warnings.join("\n")).toContain("classification failed");
  });

  it("rejects a secret without saving", async () => {
    const { tool, drafts } = harness({
      fail: Object.assign(new Error("looks like a key"), { code: "secret-detected" })
    });
    await expect(tool.execute({ text: "sk-secret" }, {} as never)).rejects.toThrow(
      "remember rejected: text looks like a secret"
    );
    expect(drafts).toHaveLength(0);
  });

  it("surfaces a write failure as a stable tool error", async () => {
    const { tool } = harness({ fail: new Error("db down") });
    await expect(tool.execute({ text: "fact" }, {} as never)).rejects.toThrow("remember failed: db down");
  });

  it("logs the chosen scope without the memory text", async () => {
    const { tool, infos } = harness({ scope: { kind: "project", name: "myproj" }, classify: async () => "project" });
    await tool.execute({ text: "super secret text" }, {} as never);
    expect(infos.join("\n")).toContain("scope=myproj");
    expect(infos.join("\n")).toContain("classified=true");
    expect(infos.join("\n")).not.toContain("super secret text");
  });
});
