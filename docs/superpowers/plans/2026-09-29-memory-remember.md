# remember (p10e) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scoped model-facing `remember` tool to `dsh-balbes-memory-context` that writes through the p10a store with `origin=agent` provenance and a layer-chosen scope.

**Architecture:** Extend the existing agent-scoped memory plugin with a structural write slice and an LLM scope classifier; both dispatch channels pass `channel`/`sessionId`/model `selection` into `attach`, so `remember` appears wherever memory is delivered.

**Tech Stack:** TypeScript (strict ESM), Cordis plugin, `@deepseek-ai/dsh-tools` `defineTool`, `@deepseek-ai/dsh-llm` `BlockAssembler`/`createUserMessage`, node:sqlite store (p10a), vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-memory-remember-design.md`

## Global Constraints

- dsh is a dependency: never edit `node_modules/@deepseek-ai/**` and never bypass the core.
- Never edit `docs/canon/**` by hand; canon changes go through the `canon-write` / `canon-future-plan` skills.
- Strict TS, ESM only; package-local relative imports use the `.js` extension; function plugins named-export `name`/`Config`/`apply` and have no default export.
- Tools register only through `ctx.tools.register(defineTool(...))`; every registration is disposed with the agent scope.
- `remember` exposes no `scope` and no `pinned` argument; scope is fixed in the closure, `pinned` is always `false`.
- All writes go through `balbesMemory.save` (p10a secret barrier); there is no side door.
- Constants: `CLASSIFY_MAX_TOKENS = 16`, `CLASSIFY_TIMEOUT_MS = 5000`, default type `note`, `originRef = "<channel> session:<sessionId>"`.
- Model-facing tool descriptions are English; the classifier call passes no `sessionId` and no `purpose`.
- Memory text is never logged; log only channel, chosen scope and whether classification ran.
- Tests live under `tests/` (vitest). The package commands: `pnpm --filter dsh-balbes-memory-context test`, `... typecheck`, `... build`.

---

## File Structure

- Create `packages/plugins/dsh-balbes-memory-context/src/classify.ts` — scope-classifier prompt, parser, one-shot LLM call.
- Create `packages/plugins/dsh-balbes-memory-context/src/remember.ts` — `resolveWriteScope` and `buildRememberTool`.
- Modify `packages/plugins/dsh-balbes-memory-context/src/types.ts` — write context, write slice, `attach` signature.
- Modify `packages/plugins/dsh-balbes-memory-context/src/context.ts` — resolve `llm`, register `remember`.
- Modify `packages/bundles/dsh-balbes-host/src/runner.ts` — pass channel/session/selection in `attach`.
- Modify `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` — pass channel/session/selection in `attach`.
- Create `packages/plugins/dsh-balbes-memory-context/tests/classify.test.ts`.
- Create `packages/plugins/dsh-balbes-memory-context/tests/remember.test.ts`.
- Modify `packages/plugins/dsh-balbes-memory-context/tests/context.test.ts`.
- Modify `packages/bundles/dsh-balbes-host/tests/runner.memory.test.ts`.
- Modify `packages/plugins/dsh-balbes-telegram/tests/agentTask.memory.test.ts`.
- Modify `packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts` — REAL write proof, extends the existing suite.
- Modify `.github/workflows/ci.yml` — run the memory-context REAL suite (currently never run in CI).
- Modify canon + runbook (`Task 1` and `Task 10`).

---

### Task 1: Canon sync and owner go-ahead gate

Per canon-first, no application code starts until the living canon names the new behavior and the owner says go. Use the `canon-write` skill (and `canon-future-plan` for the plan file/INDEX). Do not hand-edit `docs/canon/**`.

**Files:**
- Modify: `docs/canon/ARCHITECTURE.md`
- Modify: `docs/canon/GLOSSARY.md`
- Modify: `docs/canon/OVERVIEW.md`
- Modify: `docs/canon/future_plans/p10e-memory-remember.md`
- Modify: `docs/canon/future_plans/INDEX.md`
- Modify: `docs/runbooks/stage2-vps.md` (the `remember` smoke, finalized in Task 10)

**Interfaces:**
- Consumes: the approved spec `docs/superpowers/specs/2026-09-29-memory-remember-design.md`.
- Produces: canon that Task 10 audits against.

- [x] **Step 1: Update ARCHITECTURE.md**

In the memory section, add a subsection "Запись памяти: инструмент `remember`" that states: `remember` is a scoped agent tool registered beside `recall` in `dsh-balbes-memory-context`; it writes only through `balbesMemory.save`; `origin=agent` and `originRef="<channel> session:<id>"`; the layer chooses scope — `global` from the home context, and from a project context either `global` or the current project via a one-shot LLM classification with fallback to the current project; `pinned` is always `false`; delivery sees a write from the next `prepare`. Remove any sentence that says the model layer is read-only.

- [x] **Step 2: Update GLOSSARY.md**

Add the term "remember (явная запись памяти)": the model-facing tool that saves one durable fact to the owner's long-term memory with agent provenance and a layer-chosen scope.

- [x] **Step 3: Update OVERVIEW.md**

In the memory part of the stages/success signals, place explicit write: the agent can save knowledge itself through `remember`, and the owner still edits memory in the admin panel.

- [x] **Step 4: Close p10e in future plans**

Via `canon-future-plan`, set `p10e-memory-remember.md` status to `absorbed` and replace its open questions with the decisions (write immediately; layer classifies global vs current project via an LLM call; default type `note`; no agent pinning; provenance `channel + session`; visible next turn). Update row 10e in `future_plans/INDEX.md` to `absorbed`.

- [x] **Step 5: Verify canon**

Run: `doc-canon scout "remember explicit memory write"`
Expected: `p10e-memory-remember.md` shows status absorbed and ARCHITECTURE/GLOSSARY text hits mention `remember` and agent provenance; no contradictory "read-only" wording for the model layer.

- [ ] **Step 6: STOP for owner go-ahead**

Report the canon diff and wait for the owner to approve before starting Task 2. Do not write application code before this.

---

### Task 2: classify.ts — prompt and answer parser

**Files:**
- Create: `packages/plugins/dsh-balbes-memory-context/src/classify.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/classify.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ClassifiedScope = "global" | "project"`
  - `type ClassifyScope = (text: string, projectName: string) => Promise<ClassifiedScope | undefined>`
  - `const CLASSIFY_SYSTEM_PROMPT: string`, `const CLASSIFY_MAX_TOKENS = 16`, `const CLASSIFY_TIMEOUT_MS = 5000`
  - `function classifyUserMessage(projectName: string, text: string): string`
  - `function parseScopeAnswer(raw: string): ClassifiedScope | undefined`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/dsh-balbes-memory-context/tests/classify.test.ts`:

~~~ts
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
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run tests/classify.test.ts`
Expected: FAIL — `Cannot find module '../src/classify.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/plugins/dsh-balbes-memory-context/src/classify.ts`:

~~~ts
export type ClassifiedScope = "global" | "project";
export type ClassifyScope = (text: string, projectName: string) => Promise<ClassifiedScope | undefined>;

export const CLASSIFY_MAX_TOKENS = 16;
export const CLASSIFY_TIMEOUT_MS = 5000;

export const CLASSIFY_SYSTEM_PROMPT =
  "You classify exactly one memory candidate for a long-term memory store. " +
  "Answer with exactly one word: global or project. " +
  "Answer global when the fact is about the owner or the system as a whole and applies to every project. " +
  "Answer project when the fact is specific to the named project. " +
  "Do not explain, do not add punctuation, do not answer anything else.";

export function classifyUserMessage(projectName: string, text: string): string {
  return "Project: " + projectName + "\nFact: " + text;
}

export function parseScopeAnswer(raw: string): ClassifiedScope | undefined {
  const matches = raw.toLowerCase().match(/\b(global|project)\b/g);
  if (matches === null || matches.length === 0) return undefined;
  const unique = new Set(matches);
  if (unique.size !== 1) return undefined;
  return unique.has("global") ? "global" : "project";
}
~~~

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run tests/classify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: exit 0.

~~~bash
git add packages/plugins/dsh-balbes-memory-context/src/classify.ts packages/plugins/dsh-balbes-memory-context/tests/classify.test.ts
git commit -m "feat(memory-context): add scope classifier prompt and parser"
~~~

---

### Task 3: classify.ts — one-shot LLM classifier

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/src/classify.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/classify.test.ts`

**Interfaces:**
- Consumes: `ClassifyScope`, `CLASSIFY_SYSTEM_PROMPT`, `CLASSIFY_MAX_TOKENS`, `CLASSIFY_TIMEOUT_MS`, `classifyUserMessage`, `parseScopeAnswer` from Task 2.
- Produces:
  - `interface LlmClassifierSeat { stream(options: { provider: string; model: string; system?: string; messages: unknown[]; maxTokens?: number; signal?: AbortSignal }): AsyncIterable<StreamChunk> }`
  - `function createLlmClassifier(llm: LlmClassifierSeat, selection: { provider: string; model: string }, logger?: { warn(message: string): void }, timeoutMs?: number): ClassifyScope`

- [ ] **Step 1: Write the failing test**

Append to `packages/plugins/dsh-balbes-memory-context/tests/classify.test.ts`:

~~~ts
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import {
  CLASSIFY_MAX_TOKENS,
  createLlmClassifier,
  type LlmClassifierSeat
} from "../src/classify.js";

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "text-delta", index: 0, text },
    { type: "finish", reason: { kind: "stop" } }
  ];
}

function fakeLlm(
  chunks: StreamChunk[],
  onOptions?: (options: Record<string, unknown>) => void
): LlmClassifierSeat {
  return {
    stream(options: unknown) {
      onOptions?.(options as Record<string, unknown>);
      return (async function* (): AsyncGenerator<StreamChunk> {
        for (const chunk of chunks) yield chunk;
      })();
    }
  };
}

function throwingLlm(error: Error): LlmClassifierSeat {
  return {
    stream() {
      return (async function* (): AsyncGenerator<StreamChunk> {
        throw error;
      })();
    }
  };
}

describe("createLlmClassifier", () => {
  it("returns the parsed scope and calls the model as a standalone one-shot", async () => {
    let seen: Record<string, unknown> | undefined;
    const classify = createLlmClassifier(
      fakeLlm(textChunks("global"), (options) => {
        seen = options;
      }),
      { provider: "p", model: "m" }
    );
    await expect(classify("owner prefers Russian", "myproj")).resolves.toBe("global");
    expect(seen).toMatchObject({ provider: "p", model: "m", maxTokens: CLASSIFY_MAX_TOKENS });
    expect(String(seen!.system)).toContain("global or project");
    expect(seen!.sessionId).toBeUndefined();
    expect(seen!.purpose).toBeUndefined();
  });

  it("returns undefined and warns when the stream throws", async () => {
    const warnings: string[] = [];
    const classify = createLlmClassifier(
      throwingLlm(new Error("provider down")),
      { provider: "p", model: "m" },
      { warn: (message) => warnings.push(message) }
    );
    await expect(classify("fact", "myproj")).resolves.toBeUndefined();
    expect(warnings.join("\n")).toContain("classification failed");
  });

  it("returns undefined for an empty or ambiguous answer", async () => {
    const classify = createLlmClassifier(fakeLlm(textChunks("")), { provider: "p", model: "m" });
    await expect(classify("fact", "myproj")).resolves.toBeUndefined();
  });

  it("returns undefined when the call times out", async () => {
    const llm: LlmClassifierSeat = {
      stream(options) {
        return (async function* (): AsyncGenerator<StreamChunk> {
          await new Promise<void>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        })();
      }
    };
    const classify = createLlmClassifier(llm, { provider: "p", model: "m" }, undefined, 5);
    await expect(classify("fact", "myproj")).resolves.toBeUndefined();
  });
});
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run tests/classify.test.ts`
Expected: FAIL — `createLlmClassifier is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/plugins/dsh-balbes-memory-context/src/classify.ts`:

~~~ts
import { BlockAssembler, createUserMessage, type StreamChunk } from "@deepseek-ai/dsh-llm";

export interface LlmClassifierSeat {
  stream(options: {
    provider: string;
    model: string;
    system?: string;
    messages: unknown[];
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<StreamChunk>;
}

export function createLlmClassifier(
  llm: LlmClassifierSeat,
  selection: { provider: string; model: string },
  logger?: { warn(message: string): void },
  timeoutMs: number = CLASSIFY_TIMEOUT_MS
): ClassifyScope {
  return async (text: string, projectName: string): Promise<ClassifiedScope | undefined> => {
    try {
      const assembler = new BlockAssembler();
      const options = {
        provider: selection.provider,
        model: selection.model,
        system: CLASSIFY_SYSTEM_PROMPT,
        messages: [
          createUserMessage({
            content: [{ type: "text", text: classifyUserMessage(projectName, text) }],
            source: { kind: "plugin", plugin: "dsh-balbes-memory-context" }
          })
        ],
        maxTokens: CLASSIFY_MAX_TOKENS,
        signal: AbortSignal.timeout(timeoutMs)
      };
      for await (const chunk of llm.stream(options)) assembler.push(chunk);
      const answer = assembler
        .blocks()
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join(" ");
      return parseScopeAnswer(answer);
    } catch (error) {
      logger?.warn(
        "balbes-memory-context: scope classification failed: " +
          (error instanceof Error ? error.message : String(error))
      );
      return undefined;
    }
  };
}
~~~

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run tests/classify.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: exit 0.

~~~bash
git add packages/plugins/dsh-balbes-memory-context/src/classify.ts packages/plugins/dsh-balbes-memory-context/tests/classify.test.ts
git commit -m "feat(memory-context): add one-shot LLM scope classifier"
~~~

---

### Task 4: types.ts write slice and resolveWriteScope

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/src/types.ts`
- Create: `packages/plugins/dsh-balbes-memory-context/src/remember.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/remember.test.ts`

**Interfaces:**
- Consumes: `MemoryRecord`, `MemoryScope` from `dsh-balbes-contracts`; `ClassifiedScope` from Task 2.
- Produces:
  - `interface MemoryWriteContext { channel: string; sessionId: string; selection?: { provider: string; model: string } }`
  - `interface MemoryWriteSlice { save(draft: { scope: MemoryScope; type: MemoryRecord["type"]; text: string; tags?: string[]; pinned?: boolean; origin: "agent"; originRef?: string | null }): Promise<MemoryRecord> }`
  - `BalbesMemoryContextService.attach(agentCtx, scope, write?: MemoryWriteContext)`
  - `function resolveWriteScope(scope: MemoryContextScope, classified: ClassifiedScope | undefined): MemoryScope`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/dsh-balbes-memory-context/tests/remember.test.ts`:

~~~ts
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
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run tests/remember.test.ts`
Expected: FAIL — `Cannot find module '../src/remember.js'`.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/plugins/dsh-balbes-memory-context/src/types.ts` (keep the existing `BalbesMemoryReadSlice`, `MemoryContextAttachment`, `MemoryContextScope`):

~~~ts
/** Channel and live session serving the agent's current task: provenance and classifier route. */
export interface MemoryWriteContext {
  /** "admin" (POST /api/prompt) or "telegram". */
  channel: string;
  /** Live agent session; becomes part of originRef. */
  sessionId: string;
  /** Agent model selection for the classifier; without it classification is skipped. */
  selection?: { provider: string; model: string };
}

/** Structural write slice of balbesMemory; the agent writes only through it. */
export interface MemoryWriteSlice {
  save(draft: {
    scope: MemoryScope;
    type: MemoryRecord["type"];
    text: string;
    tags?: string[];
    pinned?: boolean;
    origin: "agent";
    originRef?: string | null;
  }): Promise<MemoryRecord>;
}
~~~

Change the service interface to:

~~~ts
export interface BalbesMemoryContextService {
  attach(agentCtx: unknown, scope: MemoryContextScope, write?: MemoryWriteContext): MemoryContextAttachment;
}
~~~

Create `packages/plugins/dsh-balbes-memory-context/src/remember.ts`:

~~~ts
import type { MemoryScope } from "dsh-balbes-contracts";
import type { ClassifiedScope } from "./classify.js";
import type { MemoryContextScope } from "./types.js";

export function resolveWriteScope(
  scope: MemoryContextScope,
  classified: ClassifiedScope | undefined
): MemoryScope {
  if (scope.kind === "global") return { kind: "global" };
  return classified === "global" ? { kind: "global" } : { kind: "project", name: scope.name };
}
~~~

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run tests/remember.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: exit 0.

~~~bash
git add packages/plugins/dsh-balbes-memory-context/src/types.ts packages/plugins/dsh-balbes-memory-context/src/remember.ts packages/plugins/dsh-balbes-memory-context/tests/remember.test.ts
git commit -m "feat(memory-context): add write slice types and scope resolution"
~~~

---

### Task 5: remember tool

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/src/remember.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/remember.test.ts`

**Interfaces:**
- Consumes: `MemoryWriteSlice`, `MemoryWriteContext`, `MemoryContextScope`, `ClassifyScope`, `resolveWriteScope`.
- Produces: `function buildRememberTool(memory: MemoryWriteSlice, scope: MemoryContextScope, write: MemoryWriteContext, classify: ClassifyScope | undefined, logger?: { warn(message: string): void; info?(message: string): void }): ToolDefinition`; `const REMEMBER_DEFAULT_TYPE = "note"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/plugins/dsh-balbes-memory-context/tests/remember.test.ts`:

~~~ts
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
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run tests/remember.test.ts`
Expected: FAIL — `buildRememberTool is not exported`.

- [ ] **Step 3: Write minimal implementation**

Prepend these imports to `packages/plugins/dsh-balbes-memory-context/src/remember.ts` and append the tool:

~~~ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { MemoryRecord } from "dsh-balbes-contracts";
import type { ClassifyScope } from "./classify.js";
import type { MemoryContextScope, MemoryWriteContext, MemoryWriteSlice } from "./types.js";

export const REMEMBER_DEFAULT_TYPE = "note";
const TYPES = ["fact", "preference", "decision", "note"] as const;

const DESCRIPTION =
  "Save one durable fact to the owner's long-term memory. Use it when knowledge worth keeping " +
  "across sessions or projects appears during the task. The layer chooses where it is stored. " +
  "Do not save secrets, credentials, or one-off task details.";

export function buildRememberTool(
  memory: MemoryWriteSlice,
  scope: MemoryContextScope,
  write: MemoryWriteContext,
  classify: ClassifyScope | undefined,
  logger?: { warn(message: string): void; info?(message: string): void }
) {
  const originRef = write.channel + " session:" + write.sessionId;
  return defineTool({
    name: "remember",
    description: DESCRIPTION,
    parameters: {
      text: { type: "string", required: true, description: "The knowledge to save as one self-contained statement." },
      type: {
        type: "string",
        enum: [...TYPES],
        description: "Optional knowledge type; defaults to note."
      },
      tags: { type: "array", items: { type: "string" }, description: "Optional short tags." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          record: {
            type: "object",
            required: true,
            additionalProperties: false,
            properties: {
              id: { type: "string", required: true },
              type: { type: "string", required: true },
              text: { type: "string", required: true },
              tags: { type: "array", required: true, items: { type: "string" } },
              pinned: { type: "boolean", required: true },
              origin: { type: "string", required: true },
              originRef: { oneOf: [{ type: "string" }, { type: "null" }] },
              createdAt: { type: "string", required: true },
              updatedAt: { type: "string", required: true },
              scope: {
                oneOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: { kind: { type: "string", required: true } }
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: { type: "string", required: true },
                      name: { type: "string", required: true }
                    }
                  }
                ]
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const record = value.record as unknown as MemoryRecord;
        const target = record.scope.kind === "global" ? "global" : "project " + record.scope.name;
        return [
          {
            type: "text",
            text:
              "Saved to " + target + " as " + record.type + " (id: " + record.id +
              ", origin: agent · " + (record.originRef ?? "") + ")."
          }
        ];
      }
    },
    execute: async (args) => {
      const type = args.type ?? REMEMBER_DEFAULT_TYPE;
      let classified: "global" | "project" | undefined;
      if (scope.kind === "project" && classify !== undefined) {
        try {
          classified = await classify(args.text, scope.name);
        } catch (error) {
          logger?.warn(
            "balbes-memory-context: scope classification failed: " +
              (error instanceof Error ? error.message : String(error))
          );
          classified = undefined;
        }
      }
      const target = resolveWriteScope(scope, classified);
      try {
        const record = await memory.save({
          scope: target,
          type,
          text: args.text,
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          pinned: false,
          origin: "agent",
          originRef
        });
        logger?.info?.(
          "balbes-memory-context: remember channel=" + write.channel +
            " scope=" + (target.kind === "global" ? "global" : target.name) +
            " classified=" + (classified !== undefined)
        );
        return { record };
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (code === "secret-detected") throw new Error("remember rejected: text looks like a secret");
        throw new Error("remember failed: " + (error instanceof Error ? error.message : String(error)));
      }
    }
  });
}
~~~

Keep the existing `resolveWriteScope` from Task 4 below these additions (order does not matter; TypeScript hoists function declarations).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run tests/remember.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: exit 0.

~~~bash
git add packages/plugins/dsh-balbes-memory-context/src/remember.ts packages/plugins/dsh-balbes-memory-context/tests/remember.test.ts
git commit -m "feat(memory-context): add remember tool"
~~~

---

### Task 6: context.ts registers remember

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/src/context.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/context.test.ts`

**Interfaces:**
- Consumes: `buildRememberTool`, `createLlmClassifier`, `LlmClassifierSeat`, `MemoryWriteContext`, `MemoryWriteSlice`.
- Produces: `remember` registered per agent when the store is writable and a write context is supplied.

- [ ] **Step 1: Write the failing test**

Update `packages/plugins/dsh-balbes-memory-context/tests/context.test.ts`: replace the existing `import type { BalbesMemoryReadSlice, MemoryReadFilter } from "../src/types.js";` line with the combined import block below, replace the harness options/memory slice, widen the attach type, then add three tests.

Replace the `harness` options and memory slice with:

~~~ts
import type { LlmClassifierSeat } from "../src/classify.js";
import type { BalbesMemoryReadSlice, MemoryReadFilter, MemoryWriteContext } from "../src/types.js";

function harness(
  records: MemoryRecord[],
  options: { withoutTools?: boolean; writable?: boolean; llm?: LlmClassifierSeat } = {}
): Harness {
  const sections: SectionSpec[] = [];
  const contexts: SectionSpec[] = [];
  const tools: unknown[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const memory = {
    list: async (_filter?: MemoryReadFilter) => records,
    count: async (_filter?: MemoryReadFilter) => records.length,
    search: async () =>
      records.filter((r) => r.text.includes("deploy")).map((r) => ({ record: r, rank: -1 })),
    ...(options.writable === true
      ? {
          save: async (draft: { text: string; scope: MemoryRecord["scope"]; type: MemoryRecord["type"] }) =>
            record({ id: "saved", text: draft.text, scope: draft.scope, type: draft.type, origin: "agent" })
        }
      : {})
  };
  const agentCtx = {
    get(key: string): unknown {
      if (key === "balbesMemory") return memory as unknown as BalbesMemoryReadSlice;
      if (key === "llm") return options.llm;
      if (key === "systemPrompt") {
        return {
          section: (spec: SectionSpec) => {
            sections.push(spec);
            return () => {};
          },
          context: (spec: SectionSpec) => {
            contexts.push(spec);
            return () => {};
          }
        };
      }
      if (key === "tools" && options.withoutTools !== true) {
        return {
          register: (definition: unknown) => {
            tools.push(definition);
            return () => {};
          }
        };
      }
      return undefined;
    }
  };
  const service = createMemoryContext({
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message)
  });
  const harnessValue: Harness = { agentCtx, sections, contexts, tools, warnings, infos };
  Object.defineProperty(harnessValue, "attach", {
    value: service.attach.bind(service),
    enumerable: false
  });
  return harnessValue;
}

type HarnessWithAttach = Harness & {
  attach(
    agentCtx: unknown,
    scope: { kind: "global" } | { kind: "project"; name: string },
    write?: MemoryWriteContext
  ): { prepare(taskText: string): Promise<void> };
};
~~~

Add these tests inside the `describe("createMemoryContext")` block:

~~~ts
  it("registers remember beside recall when the store is writable and a write context is given", () => {
    const h = harness([record({ id: "a", text: "hello" })], { writable: true }) as HarnessWithAttach;
    h.attach(h.agentCtx, { kind: "global" }, { channel: "admin", sessionId: "s1" });
    expect(h.tools.map((tool) => (tool as { name: string }).name)).toEqual(["recall", "remember"]);
  });

  it("does not register remember without a write context", () => {
    const h = harness([record({ id: "a", text: "hello" })], { writable: true }) as HarnessWithAttach;
    h.attach(h.agentCtx, { kind: "global" });
    expect(h.tools).toHaveLength(1);
  });

  it("does not register remember on a read-only store", () => {
    const h = harness([record({ id: "a", text: "hello" })]) as HarnessWithAttach;
    h.attach(h.agentCtx, { kind: "global" }, { channel: "admin", sessionId: "s1" });
    expect(h.tools).toHaveLength(1);
  });
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run tests/context.test.ts`
Expected: FAIL — only the `recall` tool is registered (the new tests expect `["recall", "remember"]`).

- [ ] **Step 3: Write minimal implementation**

In `packages/plugins/dsh-balbes-memory-context/src/context.ts` add imports:

~~~ts
import { createLlmClassifier, type LlmClassifierSeat } from "./classify.js";
import { buildRememberTool } from "./remember.js";
import type {
  BalbesMemoryContextService,
  BalbesMemoryReadSlice,
  MemoryContextScope,
  MemoryWriteContext,
  MemoryWriteSlice
} from "./types.js";
~~~

Inside `attach`, after `const memory = ...`, add `const llm = ctx.get("llm") as LlmClassifierSeat | undefined;`. After `tools.register(buildRecallTool(memory, scopes));` add:

~~~ts
      const writable = memory as BalbesMemoryReadSlice & Partial<MemoryWriteSlice>;
      if (typeof writable.save === "function" && write !== undefined) {
        const classify =
          llm !== undefined && write.selection !== undefined
            ? createLlmClassifier(llm, write.selection, logger)
            : undefined;
        tools.register(buildRememberTool(writable as MemoryWriteSlice, scope, write, classify, logger));
      }
~~~

Change the `attach` signature to `attach(agentCtx: unknown, scope: MemoryContextScope, write?: MemoryWriteContext)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run tests/context.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the whole package suite and commit**

Run: `pnpm --filter dsh-balbes-memory-context test`
Expected: PASS (all unit tests; the REAL suite skips without `RUN_REAL`).

~~~bash
git add packages/plugins/dsh-balbes-memory-context/src/context.ts packages/plugins/dsh-balbes-memory-context/tests/context.test.ts
git commit -m "feat(memory-context): register remember per agent"
~~~

---

### Task 7: Host runner passes channel, session and selection

**Files:**
- Modify: `packages/bundles/dsh-balbes-host/src/runner.ts`
- Test: `packages/bundles/dsh-balbes-host/tests/runner.memory.test.ts`

**Interfaces:**
- Consumes: `BalbesMemoryContextService.attach` with the optional third argument (Task 4).
- Produces: admin prompts attach with `{ channel: "admin", sessionId, selection }`.

- [ ] **Step 1: Write the failing test**

In `packages/bundles/dsh-balbes-host/tests/runner.memory.test.ts` add a `writes` capture:

~~~ts
    const writes: unknown[] = [];
~~~

Change the fake `attach` to:

~~~ts
              attach: (agentCtx: unknown, scope: unknown, write: unknown) => {
                expect(agentCtx).toBe(seenAgentCtx);
                scopes.push(scope);
                writes.push(write);
                return { prepare: async (text: string) => void prepared.push(text) };
              }
~~~

Add after the existing assertions:

~~~ts
    expect(writes).toEqual([
      {
        channel: "admin",
        sessionId: expect.stringMatching(/^session-/),
        selection: { provider: "p", model: "m" }
      }
    ]);
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-host exec vitest run tests/runner.memory.test.ts`
Expected: FAIL — `write` is `undefined` (attach is still called with two arguments).

- [ ] **Step 3: Write minimal implementation**

In `packages/bundles/dsh-balbes-host/src/runner.ts` widen the structural slice:

~~~ts
interface MemoryContextServiceLike {
  attach(
    agentCtx: unknown,
    scope: { kind: "global" },
    write?: { channel: string; sessionId: string; selection?: { provider: string; model: string } }
  ): { prepare(taskText: string): Promise<void> };
}
~~~

Hoist the session id and pass the write context. Replace the `try` block's `agents.create` call with:

~~~ts
    const sessionId = brandString(`session-${randomUUID()}`);
    handle = await agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx as never, { current: selection, assembled: undefined });
        memoryAttachment = memory?.attach(agentCtx, { kind: "global" }, {
          channel: "admin",
          sessionId,
          selection: { provider: selection.provider, model: selection.model }
        });
      }
    });
~~~

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-host exec vitest run tests/runner.memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter dsh-balbes-host typecheck`
Expected: exit 0.

~~~bash
git add packages/bundles/dsh-balbes-host/src/runner.ts packages/bundles/dsh-balbes-host/tests/runner.memory.test.ts
git commit -m "feat(host): pass admin write context into memory attach"
~~~

---

### Task 8: Telegram agent task passes channel, session and selection

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/agentTask.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/agentTask.memory.test.ts`

**Interfaces:**
- Consumes: `BalbesMemoryContextService.attach` with the optional third argument (Task 4).
- Produces: Telegram agents attach with `{ channel: "telegram", sessionId, selection }` using the effective session id (`opts.sessionId` for resume, the freshly generated id for create).

- [ ] **Step 1: Write the failing test**

In `packages/plugins/dsh-balbes-telegram/tests/agentTask.memory.test.ts` add `const writes: unknown[] = [];` and change the fake memory to:

~~~ts
      memory: {
        attach: (_agentCtx: unknown, scope: unknown, write: unknown) => {
          scopes.push(scope);
          writes.push(write);
          return { prepare: async (text: string) => void prepared.push(text) };
        }
      }
~~~

Add after the existing assertions:

~~~ts
    expect(writes).toEqual([
      {
        channel: "telegram",
        sessionId: expect.stringMatching(/^session-/),
        selection: { provider: "p", model: "m" }
      },
      {
        channel: "telegram",
        sessionId: expect.stringMatching(/^session-/),
        selection: { provider: "p", model: "m" }
      }
    ]);
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.memory.test.ts`
Expected: FAIL — `write` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` widen the structural slice:

~~~ts
export interface MemoryContextServiceLike {
  attach(
    agentCtx: unknown,
    scope: { kind: "global" } | { kind: "project"; name: string },
    write?: { channel: string; sessionId: string; selection?: { provider: string; model: string } }
  ): MemoryContextAttachmentLike;
}
~~~

In `acquireHandle` hoist a fresh id and pass the write context:

~~~ts
    const selection = liveSelection(deps.defaultModel);
    const freshSessionId = brandString(`session-${randomUUID()}`);
    let memory: MemoryContextAttachmentLike | undefined;
    const setup = (agentCtx: unknown): void => {
      composeAgentSetup(agentCtx, { selection: selection.ref });
      deps.approvals?.attach(agentCtx, ref);
      memory = deps.memory?.attach(
        agentCtx,
        ref.scope === "home" ? { kind: "global" } : { kind: "project", name: ref.name },
        {
          channel: "telegram",
          sessionId: opts?.sessionId ?? freshSessionId,
          selection: { provider: selection.initial.provider, model: selection.initial.model }
        }
      );
    };
~~~

Replace the create branch's `const sessionId = brandString(...)` with `const sessionId = freshSessionId;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter dsh-balbes-telegram typecheck`
Expected: exit 0.

~~~bash
git add packages/plugins/dsh-balbes-telegram/src/agentTask.ts packages/plugins/dsh-balbes-telegram/tests/agentTask.memory.test.ts
git commit -m "feat(telegram): pass telegram write context into memory attach"
~~~

---

### Task 9: REAL composition proves the model writes memory

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the full composition built through Tasks 2-8.
- Produces: REAL evidence that a model tool call reaches the p10a store with `origin=agent` and admin-session provenance.

- [ ] **Step 1: Extend the stub type and add the write phase**

In `packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts` widen the imported stub type:

~~~ts
    const { startStubLlm } = (await import(stubUrl)) as {
      startStubLlm(options?: { text?: string }): Promise<{
        port: number;
        calls: Array<{ path: string; body: { system?: unknown; tools?: unknown; messages?: unknown } }>;
        setScript(
          script: Array<{ text?: string; toolCall?: { name: string; arguments: string } }>
        ): void;
        close(): Promise<void>;
      }>;
    };
~~~

At the end of the existing `it(...)` body (after the liveness assertion, inside the same `try`), add:

~~~ts
      const rememberMarker = "p10eremembermarker7a31";
      stub.setScript([
        {
          toolCall: {
            name: "remember",
            arguments: JSON.stringify({ text: "durable fact " + rememberMarker, type: "fact" })
          }
        },
        { text: "saved" }
      ]);
      const writeRun = await postJson(base + "/api/prompt", { prompt: "Remember the durable fact" }, token);
      expect(writeRun.status, writeRun.raw).toBe(200);

      const listRes = await postJson(base + "/api/memory/list", { query: rememberMarker }, token);
      expect(listRes.status, listRes.raw).toBe(200);
      const records = (listRes.json as { records: Array<Record<string, unknown>> }).records;
      const saved = records.find(
        (entry) => typeof entry.text === "string" && entry.text.includes(rememberMarker)
      );
      expect(saved, JSON.stringify(records)).toBeDefined();
      expect(saved!.origin).toBe("agent");
      expect(saved!.pinned).toBe(false);
      expect(saved!.type).toBe("fact");
      expect(String(saved!.originRef)).toMatch(/^admin session:/);
~~~

- [ ] **Step 2: Run the REAL suite**

This test exercises code already implemented in Tasks 2-8, so it should pass. If it fails, the defect is in Tasks 2-8 or in this test; debug before continuing.

Run (from `packages/plugins/dsh-balbes-memory-context`, with `dsh` on PATH):
`RUN_REAL=1 bash node_modules/.bin/vitest run tests/integration.test.ts`
Expected: PASS — the `remember` marker is found with `origin "agent"` and `originRef` starting `admin session:`.

- [ ] **Step 3: Add the suite to CI**

In `.github/workflows/ci.yml`, after the "REAL suites — memory admin" step (the last step before the file ends), append:

~~~yaml
      - name: REAL suites — memory delivery and remember (p10c/p10e)
        working-directory: packages/plugins/dsh-balbes-memory-context
        env:
          RUN_REAL: "1"
        run: bash node_modules/.bin/vitest run tests/integration.test.ts
~~~

- [ ] **Step 4: Verify YAML and commit**

Run: `git diff --check .github/workflows/ci.yml && grep -n "memory delivery and remember" .github/workflows/ci.yml`
Expected: `git diff --check` prints nothing (no whitespace errors) and the grep prints the new step name. GitHub parses the workflow YAML when the branch is pushed, so a malformed block fails there.

~~~bash
git add packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts .github/workflows/ci.yml
git commit -m "test(memory-context): prove remember writes with agent provenance"
~~~

---

### Task 10: Runbook, full verification, canon audit and server handoff

**Files:**
- Modify: `docs/runbooks/stage2-vps.md`
- Modify: `docs/canon/**` via `canon-audit` (only if the audit finds divergence)

**Interfaces:**
- Consumes: everything above.
- Produces: the verified branch and the owner-facing deploy/smoke instructions.

- [ ] **Step 1: Update the runbook**

In `docs/runbooks/stage2-vps.md`, add a "Память: явная запись (remember, p10e)" smoke block after the existing memory smoke:

~~~bash
# remember: модель пишет память, провенанс агента
TOKEN=... # POST /api/auth/login
curl -fsS -X POST http://127.0.0.1:8080/api/prompt \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"Сохрани в долговременную память инструментом remember факт: smoke-remember-marker: код запуска Балбеса — dsh-balbes"}'

curl -fsS -X POST http://127.0.0.1:8080/api/memory/list \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query":"smoke-remember-marker"}'
  # ожидается: запись с origin "agent", originRef "admin session:..." и pinned false
~~~

Also confirm the plugin inventory already lists `balbes-memory-context` (it does; no installer change is needed because the package copies `lib/` in `copy_memory_context_into_profile()`).

- [ ] **Step 2: Run the full local verification**

Run, and report the raw results:

~~~bash
pnpm -r --if-present run build
pnpm -r --if-present run typecheck
pnpm -r --if-present run test
~~~

Expected: all exit 0; no new failures versus `main`.

Then the focused REAL suite (from the package directory, `dsh` on PATH):

~~~bash
cd packages/plugins/dsh-balbes-memory-context
RUN_REAL=1 bash node_modules/.bin/vitest run tests/integration.test.ts
~~~

Expected: PASS.

- [ ] **Step 3: Canon audit**

Run the `canon-audit` skill over topic "memory remember explicit write". Resolve any `docs↔code` divergence by fixing docs (via `canon-write`) or code — never by silently choosing a side. Record `code_stale`/`docs_stale` outcomes in `docs/canon/DISCREPANCIES.md` through the skill if a discrepancy remains.

- [ ] **Step 4: Commit the runbook and close**

~~~bash
git add docs/runbooks/stage2-vps.md
git commit -m "docs(runbook): add remember memory smoke"
git log --oneline -12
~~~

- [ ] **Step 5: Server handoff (owner runs)**

Do not push; report these grounded steps and offer to interpret output. On the server:

~~~bash
cd /path/to/dsh-balbes-server
bash scripts/install.sh
~~~

Then run the Step 1 smoke block and confirm: `journalctl -u dsh-balbes -n 200 | grep balbes-memory-context` shows no missing-service warnings, and the saved record carries `origin "agent"` and `originRef "admin session:..."`.

---

## Self-Review

- **Spec coverage:** scope table (`Task 4/5`), classifier one-shot and no `sessionId`/`purpose` (`Task 3`), no `scope`/`pinned` parameters and always `pinned=false` (`Task 5`), provenance `channel session:<id>` (`Task 5/7/8`), secret barrier and stable tool errors (`Task 5`), degradation without `llm`/`selection`/`save` (`Task 5/6`), delivery visibility next turn (no snapshot mutation — `Task 5` does not touch `prepare` state), observability line (`Task 5`), unit + REAL tests (`Task 2-6, 9`), canon and runbook (`Task 1, 10`), hook wiring both channels (`Task 7, 8`). No spec section is untasked.
- **Placeholder scan:** no `TBD`/`TODO`/`implement later`; every code step carries runnable code and an exact command.
- **Type consistency:** `ClassifiedScope`/`ClassifyScope` (`Task 2`) are reused verbatim in `remember.ts` (`Task 4/5`) and `context.ts` (`Task 6`); `LlmClassifierSeat` (`Task 3`) is the same shape used by `context.ts`; `MemoryWriteContext` field names (`channel`, `sessionId`, `selection`) match `runner.ts` (`Task 7`) and `agentTask.ts` (`Task 8`).
