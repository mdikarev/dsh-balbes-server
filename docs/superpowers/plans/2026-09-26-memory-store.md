# Memory Store (p10a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Balbes a durable memory store and record model — a host-side SQLite service `balbesMemory` with CRUD, scope levels, and FTS5 search.

**Architecture:** A new functional Cordis plugin `dsh-balbes-memory` opens `$DSH_HOME/storages/memory.sqlite` via `node:sqlite`, runs version-gated migrations on startup, and provides the `balbesMemory` service. No HTTP surface (p10b), no context injection (p10c), no auto-fill (p10d).

**Tech Stack:** TypeScript (strict, ESM), Cordis functional plugins, `node:sqlite` (DatabaseSync + FTS5), vitest.

**Spec:** `docs/superpowers/specs/2026-09-26-memory-store-design.md`

## Global Constraints

- dsh is a dependency, not a fork: never edit installed `\@deepseek-ai/*`; compose via profile bundles and patch layers.
- Functional plugin contract: named exports `name` / `Config` / `apply`, no default export; `apply` may be async (dsh plugins use async apply).
- TypeScript strict ESM; package-local relative imports end in `.js`; comments and code in English.
- Node >= 22 (engine pin `scripts/engine-version.txt`); `node:sqlite` is experimental but already used by dsh (`dsh-session-query-sqlite`).
- No Python. No new runtime npm dependencies for the plugin.
- Canon-first: `canon-write` runs before application code (Task 1).
- Product-visible plugin requires a REAL-composition test booting a test `cordis.yml` through the Loader/CLI.
- No secrets in git; never log credential values.
- Verification commands actually available: `pnpm typecheck`, `pnpm test`, `pnpm build` (there is no `pnpm lint` script).

---

## File Structure

```
packages/plugins/dsh-balbes-memory/
  package.json                     # package manifest (mirror of dsh-balbes-home)
  tsconfig.json                    # noEmit typecheck (src + tests)
  tsconfig.build.json              # emits lib/ + lib/types
  src/
    types.ts                       # MemoryRecord/Scope/Filter, LimITS, service interface
    errors.ts                      # MemoryError + stable codes
    validate.ts                    # scope/draft/patch/filter normalization
    secrets.ts                     # detectSecret(text)
    schema.ts                      # DDL v1, migrations, openMemoryDatabase
    service.ts                     # createMemoryService(db)
    index.ts                       # plugin entry: name/Config/apply
  tests/
    validate.test.ts
    secrets.test.ts
    schema.test.ts
    service.test.ts
    search.test.ts
    index.test.ts
    integration.test.ts            # REAL composition (RUN_REAL=1)
    fixtures/balbes-memory-profile/
      package.json
      cordis.patch.yml
```

Modified files (Task 9): `profiles/balbes/cordis.patch.yml`, `scripts/install.sh`, `docs/runbooks/stage2-vps.md`.

---

## Task 1: Canon update (canon-work, gated)

**Files:**
- Modify (via the `canon-write` skill, never by hand): `docs/canon/ARCHITECTURE.md`, `docs/canon/GLOSSARY.md`, `docs/canon/future_plans/p10a-memory-store.md`, `docs/canon/OVERVIEW.md`

**Deliverable:** living canon describes the memory store before any code exists.

- [ ] **Step 1: Run the canon-write skill on the p10a topic**

Use the `canon-write` skill. Required content (semantics, not exact wording):

- ARCHITECTURE.md, new section `Memory layer`: source of truth is SQLite (`node:sqlite`) at `$DSH_HOME/storages/memory.sqlite`; two scope levels (global = home, project = project slug); record model (id, scope, type, text, tags, pinned, origin, originRef, timestamps, reserved embedding); service `balbesMemory` with CRUD + FTS5 search; secrets rejected at the write boundary with `secret-detected`; migrations run at plugin open with a pre-migration backup; composition via the `balbes-memory` row. It is host-side and invisible to the model.
- GLOSSARY.md, new terms: `memory record` (a unit of durable knowledge with type/scope/provenance/tags), `memory scope / level` (global vs project).
- p10a-memory-store.md: `Status: refining` -> `implementing`; mark the open questions resolved by the spec (backend, scope binding, delete policy deferral, model richness, search primitive, secrets).
- OVERVIEW.md: do not remove `Долговременная память` from out-of-scope yet; record p10a as in progress.

- [ ] **Step 2: STOP for owner go-ahead**

Canon-first requires an explicit owner go-ahead after substantial canon changes. Report the canon diff and wait. Do not start Task 2 before approval.

- [ ] **Step 3: Commit**

```
git add docs/canon
git commit -m "docs(canon): define the p10a memory layer"
```

---

## Task 2: Package scaffold + types/errors + validation

**Files:**
- Create: `packages/plugins/dsh-balbes-memory/package.json`
- Create: `packages/plugins/dsh-balbes-memory/tsconfig.json`
- Create: `packages/plugins/dsh-balbes-memory/tsconfig.build.json`
- Create: `packages/plugins/dsh-balbes-memory/src/types.ts`
- Create: `packages/plugins/dsh-balbes-memory/src/errors.ts`
- Create: `packages/plugins/dsh-balbes-memory/src/validate.ts`
- Test: `packages/plugins/dsh-balbes-memory/tests/validate.test.ts`

**Interfaces (Produces):**
- `type MemoryType = "fact" | "preference" | "decision" | "note"`
- `type MemoryScope = { kind: "global" } | { kind: "project"; name: string }`
- `type MemoryOrigin = "owner" | "agent"`
- `interface MemoryRecord` (id, scope, type, text, tags, pinned, origin, originRef, createdAt, updatedAt)
- `interface MemoryDraft`, `MemoryPatch`, `MemoryFilter`, `SearchRequest`, `SearchHit`
- `interface BalbesMemoryService` (save/get/update/delete/list/search/count)
- `class MemoryError extends Error { code: MemoryErrorCode }`
- `assertScope(unknown): MemoryScope`, `normalizeDraft(unknown): NormalizedDraft`, `normalizePatch(unknown): NormalizedPatch`, `normalizeFilter(unknown): MemoryFilter`, `normalizeTags(unknown): string[]`, `normalizeTag(string): string`, `normalizeText(unknown): string`

- [ ] **Step 1: Create the package manifests**

`packages/plugins/dsh-balbes-memory/package.json`:

```json
{
  "name": "dsh-balbes-memory",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/plugins/dsh-balbes-memory/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests"]
}
```

`packages/plugins/dsh-balbes-memory/tsconfig.build.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "lib",
    "rootDir": "src",
    "declarationDir": "lib/types"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Write the failing test**

`packages/plugins/dsh-balbes-memory/tests/validate.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter dsh-balbes-memory test`
Expected: FAIL — cannot resolve `../src/errors.js` / `../src/validate.js`.

- [ ] **Step 4: Write `src/types.ts`**

```ts
export type MemoryType = "fact" | "preference" | "decision" | "note";
export type MemoryScope = { kind: "global" } | { kind: "project"; name: string };
export type MemoryOrigin = "owner" | "agent";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags: string[];
  pinned: boolean;
  origin: MemoryOrigin;
  originRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryDraft {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  pinned?: boolean;
  origin: MemoryOrigin;
  originRef?: string | null;
}

export interface MemoryPatch {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
  originRef?: string | null;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  scopes?: MemoryScope[];
  type?: MemoryType;
  tag?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchRequest {
  query: string;
  filter?: MemoryFilter;
  limit?: number;
}

export interface SearchHit {
  record: MemoryRecord;
  rank: number;
}

export interface BalbesMemoryService {
  save(draft: MemoryDraft): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  update(id: string, patch: MemoryPatch): Promise<MemoryRecord>;
  delete(id: string): Promise<boolean>;
  list(filter?: MemoryFilter): Promise<MemoryRecord[]>;
  search(request: SearchRequest): Promise<SearchHit[]>;
  count(filter?: MemoryFilter): Promise<number>;
}

export const MEMORY_TYPES = ["fact", "preference", "decision", "note"] as const;
export const MEMORY_ORIGINS = ["owner", "agent"] as const;

export const LIMITS = {
  maxTextBytes: 8192,
  maxTags: 32,
  maxTagLength: 32,
  maxOriginRefLength: 512,
  maxScopeNameLength: 64,
  defaultSearchLimit: 20,
  maxSearchLimit: 100,
  defaultListLimit: 100,
  maxListLimit: 500
} as const;
```

- [ ] **Step 5: Write `src/errors.ts`**

```ts
export type MemoryErrorCode =
  | "secret-detected"
  | "invalid-record"
  | "not-found"
  | "invalid-scope"
  | "invalid-filter"
  | "invalid-query";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}
```

- [ ] **Step 6: Write `src/validate.ts`**

```ts
import { MemoryError } from "./errors.js";
import {
  LIMITS,
  MEMORY_ORIGINS,
  MEMORY_TYPES,
  type MemoryDraft,
  type MemoryFilter,
  type MemoryOrigin,
  type MemoryPatch,
  type MemoryScope,
  type MemoryType
} from "./types.js";

const SCOPE_NAME = /^[A-Za-z0-9._-]+$/;
const TAG = /^[a-z0-9._-]+$/;

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

function isMemoryOrigin(value: unknown): value is MemoryOrigin {
  return typeof value === "string" && (MEMORY_ORIGINS as readonly string[]).includes(value);
}

export function assertScope(scope: unknown): MemoryScope {
  if (typeof scope !== "object" || scope === null) {
    throw new MemoryError("invalid-scope", "scope must be an object");
  }
  const candidate = scope as { kind?: unknown; name?: unknown };
  if (candidate.kind === "global") {
    if (candidate.name !== undefined) {
      throw new MemoryError("invalid-scope", "global scope must not carry a name");
    }
    return { kind: "global" };
  }
  if (candidate.kind === "project") {
    const name = candidate.name;
    if (typeof name !== "string" || name === "") {
      throw new MemoryError("invalid-scope", "project scope requires a name");
    }
    if (
      name.length > LIMITS.maxScopeNameLength ||
      !SCOPE_NAME.test(name) ||
      name.startsWith(".") ||
      name.endsWith(".")
    ) {
      throw new MemoryError("invalid-scope", "invalid project name: " + name);
    }
    return { kind: "project", name };
  }
  throw new MemoryError("invalid-scope", 'scope.kind must be "global" or "project"');
}

export function normalizeTag(tag: string): string {
  const normalized = tag.trim().toLowerCase();
  if (normalized === "" || normalized.length > LIMITS.maxTagLength || !TAG.test(normalized)) {
    throw new MemoryError("invalid-record", "invalid tag: " + tag);
  }
  return normalized;
}

export function normalizeTags(tags: unknown): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) throw new MemoryError("invalid-record", "tags must be an array");
  if (tags.length > LIMITS.maxTags) throw new MemoryError("invalid-record", "too many tags");
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") throw new MemoryError("invalid-record", "tags must be strings");
    const normalized = normalizeTag(tag);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export function normalizeText(text: unknown): string {
  if (typeof text !== "string") throw new MemoryError("invalid-record", "text must be a string");
  const trimmed = text.trim();
  if (trimmed === "") throw new MemoryError("invalid-record", "text must not be empty");
  if (Buffer.byteLength(trimmed, "utf8") > LIMITS.maxTextBytes) {
    throw new MemoryError("invalid-record", "text exceeds the size limit");
  }
  return trimmed;
}

export function normalizeOriginRef(ref: unknown): string | null {
  if (ref === undefined || ref === null) return null;
  if (typeof ref !== "string") throw new MemoryError("invalid-record", "originRef must be a string or null");
  if (ref.length > LIMITS.maxOriginRefLength) throw new MemoryError("invalid-record", "originRef is too long");
  return ref;
}

export interface NormalizedDraft {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags: string[];
  pinned: boolean;
  origin: MemoryOrigin;
  originRef: string | null;
}

export function normalizeDraft(draft: unknown): NormalizedDraft {
  if (typeof draft !== "object" || draft === null) {
    throw new MemoryError("invalid-record", "draft must be an object");
  }
  const d = draft as Record<string, unknown>;
  if (!isMemoryType(d.type)) throw new MemoryError("invalid-record", "invalid type");
  if (!isMemoryOrigin(d.origin)) throw new MemoryError("invalid-record", "invalid origin");
  if (d.pinned !== undefined && typeof d.pinned !== "boolean") {
    throw new MemoryError("invalid-record", "pinned must be a boolean");
  }
  return {
    scope: assertScope(d.scope),
    type: d.type,
    text: normalizeText(d.text),
    tags: normalizeTags(d.tags),
    pinned: d.pinned === true,
    origin: d.origin,
    originRef: normalizeOriginRef(d.originRef)
  };
}

export interface NormalizedPatch {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
  originRef?: string | null;
}

export function normalizePatch(patch: unknown): NormalizedPatch {
  if (typeof patch !== "object" || patch === null) {
    throw new MemoryError("invalid-record", "patch must be an object");
  }
  const p = patch as Record<string, unknown>;
  const out: NormalizedPatch = {};
  if (p.type !== undefined) {
    if (!isMemoryType(p.type)) throw new MemoryError("invalid-record", "invalid type");
    out.type = p.type;
  }
  if (p.text !== undefined) out.text = normalizeText(p.text);
  if (p.tags !== undefined) out.tags = normalizeTags(p.tags);
  if (p.pinned !== undefined) {
    if (typeof p.pinned !== "boolean") throw new MemoryError("invalid-record", "pinned must be a boolean");
    out.pinned = p.pinned;
  }
  if (p.originRef !== undefined) out.originRef = normalizeOriginRef(p.originRef);
  return out;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MemoryError("invalid-filter", field + " must be a non-negative integer");
  }
  return value;
}

export function normalizeFilter(filter: unknown): MemoryFilter {
  if (filter === undefined) return {};
  if (typeof filter !== "object" || filter === null) {
    throw new MemoryError("invalid-filter", "filter must be an object");
  }
  const f = filter as Record<string, unknown>;
  const out: MemoryFilter = {};
  if (f.scope !== undefined) out.scope = assertScope(f.scope);
  if (f.scopes !== undefined) {
    if (!Array.isArray(f.scopes)) throw new MemoryError("invalid-filter", "scopes must be an array");
    out.scopes = f.scopes.map((scope) => assertScope(scope));
  }
  if (f.type !== undefined) {
    if (!isMemoryType(f.type)) throw new MemoryError("invalid-filter", "invalid type");
    out.type = f.type;
  }
  if (f.tag !== undefined) {
    if (typeof f.tag !== "string") throw new MemoryError("invalid-filter", "tag must be a string");
    out.tag = normalizeTag(f.tag);
  }
  if (f.pinned !== undefined) {
    if (typeof f.pinned !== "boolean") throw new MemoryError("invalid-filter", "pinned must be a boolean");
    out.pinned = f.pinned;
  }
  if (f.limit !== undefined) out.limit = assertNonNegativeInteger(f.limit, "limit");
  if (f.offset !== undefined) out.offset = assertNonNegativeInteger(f.offset, "offset");
  return out;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter dsh-balbes-memory test`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm --filter dsh-balbes-memory typecheck`
Expected: no errors.

```
git add packages/plugins/dsh-balbes-memory
git commit -m "feat(memory): scaffold package with types, errors and validation"
```

---

## Task 3: Secret detector

**Files:**
- Create: `packages/plugins/dsh-balbes-memory/src/secrets.ts`
- Test: `packages/plugins/dsh-balbes-memory/tests/secrets.test.ts`

**Interfaces (Produces):**
- `interface SecretMatch { rule: string }`
- `detectSecret(text: string): SecretMatch | null` — returns the matching rule name, never the secret value.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { detectSecret } from "../src/secrets.js";

describe("detectSecret", () => {
  it("flags provider keys", () => {
    expect(detectSecret("key sk-abcdefghijklmnop1234")?.rule).toBe("provider-key");
    expect(detectSecret("ghp_abcdefghijklmnopqrstuvwxyz0123")?.rule).toBe("github-token");
    expect(detectSecret("AKIAIOSFODNN7EXAMPLE")?.rule).toBe("aws-key");
  });

  it("flags a telegram bot token", () => {
    expect(detectSecret("123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")?.rule).toBe("telegram-token");
  });

  it("flags assignments and bearer tokens", () => {
    expect(detectSecret("api_key = abc123")?.rule).toBe("assignment");
    expect(detectSecret("Authorization: Bearer abcdefghijklmnopqrstuvwx")?.rule).toBe("bearer-token");
  });

  it("flags PEM private keys and connection strings", () => {
    expect(detectSecret("-----BEGIN RSA PRIVATE KEY-----")?.rule).toBe("private-key");
    expect(detectSecret("postgres://user:secret@host/db")?.rule).toBe("connection-string");
  });

  it("does not flag ordinary sentences", () => {
    expect(detectSecret("password policy: rotate every 90 days")).toBeNull();
    expect(detectSecret("we decided to use pnpm workspaces")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dsh-balbes-memory test -- secrets`
Expected: FAIL — cannot resolve `../src/secrets.js`.

- [ ] **Step 3: Write `src/secrets.ts`**

```ts
export interface SecretMatch {
  rule: string;
}

interface SecretRule {
  name: string;
  pattern: RegExp;
}

/** Patterns are stateless (no /g) so repeated .test calls are safe. */
const RULES: readonly SecretRule[] = [
  { name: "provider-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "github-token", pattern: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: "slack-token", pattern: /\bxox[bp]-[A-Za-z0-9-]{10,}/ },
  { name: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "telegram-token", pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: "private-key", pattern: /-----BEGIN[^-]*PRIVATE KEY-----/ },
  { name: "assignment", pattern: /\b(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S+/i },
  { name: "connection-string", pattern: /:\/\/[^/:\s]+:[^/@\s]+@/ },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/i }
];

/**
 * Detect a secret-looking fragment. Returns the rule name only — never the
 * matched value — so an error message cannot leak the secret into logs.
 */
export function detectSecret(text: string): SecretMatch | null {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { rule: rule.name };
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dsh-balbes-memory test -- secrets`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/plugins/dsh-balbes-memory/src/secrets.ts packages/plugins/dsh-balbes-memory/tests/secrets.test.ts
git commit -m "feat(memory): reject secret-looking text at the write boundary"
```

---

## Task 4: Schema, migrations and database open

**Files:**
- Create: `packages/plugins/dsh-balbes-memory/src/schema.ts`
- Test: `packages/plugins/dsh-balbes-memory/tests/schema.test.ts`

**Interfaces (Consumes):** `MemoryError` (Task 2).
**Interfaces (Produces):**
- `interface Migration { version: number; up(db: DatabaseSync): void }`
- `@MIGRATIONS: readonly Migration[]`, `LATEST_VERSION: number`
- `readUserVersion(db): number`, `latestVersion(migrations): number`, `migrate(db, migrations?): number`
- `openMemoryDatabase(path: string, options?: { migrations?: readonly Migration[] }): Promise<DatabaseSync>`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryError } from "../src/errors.js";
import {
  LATEST_VERSION,
  MIGRATIONS,
  migrate,
  openMemoryDatabase,
  readUserVersion,
  type Migration
} from "../src/schema.js";

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "balbes-memory-schema-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe("openMemoryDatabase", () => {
  it("creates schema v1 and is idempotent", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const db = await openMemoryDatabase(path);
    expect(readUserVersion(db)).toBe(1);
    expect(LATEST_VERSION).toBe(1);
    db.close();
    const reopened = await openMemoryDatabase(path);
    expect(readUserVersion(reopened)).toBe(1);
    reopened.close();
  });

  it("refuses a newer schema version", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const db = await openMemoryDatabase(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    await expect(openMemoryDatabase(path)).rejects.toThrowError(MemoryError);
  });

  it("backs up before a pending migration and applies it", async () => {
    const dir = await tempDir();
    const path = join(dir, "memory.sqlite");
    const db = await openMemoryDatabase(path);
    db.close();
    const v2: Migration = {
      version: 2,
      up: (target) => target.exec("ALTER TABLE memories ADD COLUMN note TEXT")
    };
    const migrated = await openMemoryDatabase(path, { migrations: [...MIGRATIONS, v2] });
    expect(readUserVersion(migrated)).toBe(2);
    migrated.close();
    const backup = await stat(path + ".bak-v1");
    expect(backup.isFile()).toBe(true);
  });

  it("rolls back a failing migration and stays at v1", async () => {
    const dir = await tempDir();
    const path = join(dir, "memory.sqlite");
    const db = await openMemoryDatabase(path);
    db.close();
    const broken: Migration = {
      version: 2,
      up: (target) => {
        target.exec("ALTER TABLE memories ADD COLUMN note TEXT");
        throw new Error("boom");
      }
    };
    await expect(openMemoryDatabase(path, { migrations: [...MIGRATIONS, broken] })).rejects.toThrowError("boom");
    const reopened = new DatabaseSync(path);
    expect(readUserVersion(reopened)).toBe(1);
    reopened.close();
  });

  it("migrate returns the current version when nothing is pending", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const db = await openMemoryDatabase(path);
    expect(migrate(db)).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dsh-balbes-memory test -- schema`
Expected: FAIL — cannot resolve `../src/schema.js`.

- [ ] **Step 3: Write `src/schema.ts`**

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { MemoryError } from "./errors.js";

export const DDL_V1 = [
  "CREATE TABLE memories (",
  "  id          TEXT PRIMARY KEY,",
  "  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('global','project')),",
  "  scope_name  TEXT,",
  "  type        TEXT NOT NULL CHECK (type IN ('fact','preference','decision','note')),",
  "  text        TEXT NOT NULL,",
  "  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),",
  "  origin      TEXT NOT NULL CHECK (origin IN ('owner','agent')),",
  "  origin_ref  TEXT,",
  "  created_at  TEXT NOT NULL,",
  "  updated_at  TEXT NOT NULL,",
  "  embedding   BLOB,",
  "  CHECK ((scope_kind = 'global'  AND scope_name IS NULL)",
  "      OR (scope_kind = 'project' AND scope_name IS NOT NULL))",
  ");",
  "CREATE INDEX idx_memories_scope ON memories(scope_kind, scope_name);",
  "CREATE INDEX idx_memories_type  ON memories(type);",
  "CREATE TABLE memory_tags (",
  "  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,",
  "  tag       TEXT NOT NULL,",
  "  PRIMARY KEY (memory_id, tag)",
  ");",
  "CREATE INDEX idx_memory_tags_tag ON memory_tags(tag);",
  "CREATE VIRTUAL TABLE memory_fts USING fts5(",
  "  text,",
  "  content='memories', content_rowid='rowid',",
  "  tokenize='unicode61 remove_diacritics 2'",
  ");",
  "CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN",
  "  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);",
  "END;",
  "CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN",
  "  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);",
  "END;",
  "CREATE TRIGGER memories_au AFTER UPDATE OF text ON memories BEGIN",
  "  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);",
  "  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);",
  "END;"
].join("\n");

export interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, up: (db) => db.exec(DDL_V1) }];

export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, migration) => (migration.version > max ? migration.version : max), 0);
}

export const LATEST_VERSION = latestVersion(MIGRATIONS);

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.user_version;
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** Apply pending migrations in one transaction. Idempotent. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  const current = readUserVersion(db);
  const target = latestVersion(migrations);
  if (current > target) {
    throw new MemoryError(
      "invalid-record",
      "database schema v" + current + " is newer than supported v" + target
    );
  }
  if (current === target) return current;
  const pending = migrations
    .filter((migration) => migration.version > current)
    .slice()
    .sort((a, b) => a.version - b.version);
  db.exec("BEGIN");
  try {
    for (const migration of pending) {
      migration.up(db);
      db.exec("PRAGMA user_version = " + migration.version);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return target;
}

/** Open the database, back up before any pending migration, then migrate. */
export async function openMemoryDatabase(
  path: string,
  options?: { migrations?: readonly Migration[] }
): Promise<DatabaseSync> {
  const migrations = options?.migrations ?? MIGRATIONS;
  const target = latestVersion(migrations);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
  db.exec("PRAGMA journal_mode=WAL");
  const current = readUserVersion(db);
  if (current > target) {
    db.close();
    throw new MemoryError(
      "invalid-record",
      "database schema v" + current + " is newer than supported v" + target
    );
  }
  if (current > 0 && current < target) {
    await backup(db, path + ".bak-v" + current);
  }
  try {
    migrate(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dsh-balbes-memory test -- schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/plugins/dsh-balbes-memory/src/schema.ts packages/plugins/dsh-balbes-memory/tests/schema.test.ts
git commit -m "feat(memory): add the sqlite schema, migrations and open path"
```

## Task 5: Memory service (CRUD, filters, FTS5 search)

**Files:**
- Create: `packages/plugins/dsh-balbes-memory/src/service.ts`
- Test: `packages/plugins/dsh-balbes-memory/tests/service.test.ts`
- Test: `packages/plugins/dsh-balbes-memory/tests/search.test.ts`

**Interfaces (Consumes):** `MemoryError` (Task 2), `detectSecret` (Task 3), `normalize*` (Task 2), `openMemoryDatabase` (Task 4), `BalbesMemoryService` (Task 2).
**Interfaces (Produces):** `createMemoryService(db: DatabaseSync): BalbesMemoryService`.

- [ ] **Step 1: Write the failing CRUD test**

`packages/plugins/dsh-balbes-memory/tests/service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDatabase } from "../src/schema.js";
import { createMemoryService } from "../src/service.js";
import type { BalbesMemoryService } from "../src/types.js";

let dir: string;
let db: DatabaseSync;
let service: BalbesMemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "balbes-memory-service-"));
  db = await openMemoryDatabase(join(dir, "memory.sqlite"));
  service = createMemoryService(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const globalDraft = {
  scope: { kind: "global" } as const,
  type: "fact" as const,
  text: "Deployment runs under systemd",
  origin: "owner" as const
};

describe("balbesMemory service", () => {
  it("saves and reads a record with tags", async () => {
    const saved = await service.save({ ...globalDraft, tags: ["Ops", "deploy"], pinned: true });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.tags).toEqual(["deploy", "ops"]);
    expect(saved.pinned).toBe(true);
    expect(saved.originRef).toBeNull();
    expect(await service.get(saved.id)).toEqual(saved);
  });

  it("rejects secret-looking text without writing anything", async () => {
    await expect(service.save({ ...globalDraft, text: "token = abc123" })).rejects.toMatchObject({
      code: "secret-detected"
    });
    expect(await service.count()).toBe(0);
  });

  it("rejects a secret on update and keeps the old text", async () => {
    const saved = await service.save(globalDraft);
    await expect(service.update(saved.id, { text: "api_key: xyz" })).rejects.toMatchObject({
      code: "secret-detected"
    });
    expect((await service.get(saved.id))?.text).toBe(globalDraft.text);
  });

  it("lists by scope, type, tag and pinned", async () => {
    await service.save({ ...globalDraft, tags: ["ops"] });
    await service.save({
      scope: { kind: "project", name: "alpha" },
      type: "decision",
      text: "alpha uses pnpm",
      origin: "agent",
      tags: ["build"],
      pinned: true
    });
    await service.save({
      scope: { kind: "project", name: "beta" },
      type: "preference",
      text: "beta is quiet",
      origin: "owner"
    });

    expect((await service.list({ scope: { kind: "global" } })).length).toBe(1);
    expect((await service.list({ scope: { kind: "project", name: "alpha" } })).length).toBe(1);
    expect((await service.list({ type: "preference" })).length).toBe(1);
    expect((await service.list({ tag: "BUILD" })).length).toBe(1);
    expect((await service.list({ pinned: true })).length).toBe(1);
    expect(
      (await service.list({ scopes: [{ kind: "global" }, { kind: "project", name: "alpha" }] })).length
    ).toBe(2);
    expect(await service.count()).toBe(3);
  });

  it("updates fields and replaces tags", async () => {
    const saved = await service.save({ ...globalDraft, tags: ["old"] });
    const updated = await service.update(saved.id, {
      text: "Deployment runs under systemd on the VPS",
      tags: ["new", "ops"],
      pinned: true
    });
    expect(updated.text).toContain("VPS");
    expect(updated.tags).toEqual(["new", "ops"]);
    expect(updated.pinned).toBe(true);
    expect(updated.createdAt).toBe(saved.createdAt);
  });

  it("reports not-found on update of a missing record", async () => {
    await expect(service.update("nope", { pinned: true })).rejects.toMatchObject({ code: "not-found" });
  });

  it("deletes records and reports misses", async () => {
    const saved = await service.save(globalDraft);
    await expect(service.delete(saved.id)).resolves.toBe(true);
    await expect(service.delete(saved.id)).resolves.toBe(false);
    await expect(service.get(saved.id)).resolves.toBeUndefined();
  });

  it("persists across a close and reopen", async () => {
    const saved = await service.save({ ...globalDraft, tags: ["durable"] });
    db.close();
    db = await openMemoryDatabase(join(dir, "memory.sqlite"));
    service = createMemoryService(db);
    expect((await service.get(saved.id))?.tags).toEqual(["durable"]);
  });
});
```

- [ ] **Step 2: Write the failing search test**

`packages/plugins/dsh-balbes-memory/tests/search.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDatabase } from "../src/schema.js";
import { createMemoryService } from "../src/service.js";
import type { BalbesMemoryService } from "../src/types.js";

let dir: string;
let db: DatabaseSync;
let service: BalbesMemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "balbes-memory-search-"));
  db = await openMemoryDatabase(join(dir, "memory.sqlite"));
  service = createMemoryService(db);
  await service.save({ scope: { kind: "global" }, type: "fact", text: "Deployment runs under systemd on the VPS", origin: "owner", tags: ["ops"] });
  await service.save({ scope: { kind: "global" }, type: "preference", text: "Owner prefers concise answers in Russian", origin: "owner", tags: ["style"] });
  await service.save({ scope: { kind: "project", name: "alpha" }, type: "decision", text: "alpha uses pnpm workspaces", origin: "agent", tags: ["build"] });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("search", () => {
  it("ranks full-text matches", async () => {
    const hits = await service.search({ query: "systemd OR deployment" });
    expect(hits.map((hit) => hit.record.text)).toContain("Deployment runs under systemd on the VPS");
    expect(hits[0]?.rank).toBeLessThan(0);
  });

  it("filters by scope and tag", async () => {
    expect((await service.search({ query: "pnpm", filter: { scope: { kind: "project", name: "alpha" } } })).length).toBe(1);
    expect((await service.search({ query: "pnpm", filter: { tag: "build" } })).length).toBe(1);
    expect((await service.search({ query: "pnpm", filter: { scopes: [{ kind: "global" }] } })).length).toBe(0);
  });

  it("rejects an empty query", async () => {
    await expect(service.search({ query: "   " })).rejects.toMatchObject({ code: "invalid-query" });
  });

  it("maps an invalid FTS expression to invalid-query", async () => {
    await expect(service.search({ query: "(" })).rejects.toMatchObject({ code: "invalid-query" });
  });

  it("keeps the index in sync on update and delete", async () => {
    const hits = await service.search({ query: "concise" });
    const target = hits[0]?.record;
    expect(target).toBeDefined();
    await service.update(target!.id, { text: "Owner prefers detailed answers" });
    expect((await service.search({ query: "concise" })).length).toBe(0);
    expect((await service.search({ query: "detailed" })).length).toBe(1);
    await service.delete(target!.id);
    expect((await service.search({ query: "detailed" })).length).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter dsh-balbes-memory test`
Expected: FAIL — cannot resolve `../src/service.js`.

- [ ] **Step 4: Write `src/service.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { MemoryError } from "./errors.js";
import { detectSecret } from "./secrets.js";
import { normalizeDraft, normalizeFilter, normalizePatch } from "./validate.js";
import {
  LIMITS,
  type BalbesMemoryService,
  type MemoryFilter,
  type MemoryRecord,
  type MemoryType,
  type MemoryOrigin,
  type SearchHit
} from "./types.js";

type Row = Record<string, unknown>;

function asText(value: unknown, message: string): string {
  if (typeof value !== "string") throw new MemoryError("invalid-record", message);
  return value;
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MemoryError("invalid-record", "corrupt record: expected text column");
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function toScope(kind: unknown, name: unknown): MemoryRecord["scope"] {
  if (kind === "global") return { kind: "global" };
  if (kind === "project") return { kind: "project", name: asText(name, "corrupt record: project scope without a name") };
  throw new MemoryError("invalid-record", "corrupt record: unknown scope kind");
}

function toRecord(row: Row, tags: string[]): MemoryRecord {
  return {
    id: asText(row.id, "corrupt record: missing id"),
    scope: toScope(row.scope_kind, row.scope_name),
    type: asText(row.type, "corrupt record: missing type") as MemoryType,
    text: asText(row.text, "corrupt record: missing text"),
    tags,
    pinned: Number(row.pinned) === 1,
    origin: asText(row.origin, "corrupt record: missing origin") as MemoryOrigin,
    originRef: asNullableText(row.origin_ref),
    createdAt: asText(row.created_at, "corrupt record: missing created_at"),
    updatedAt: asText(row.updated_at, "corrupt record: missing updated_at")
  };
}

export function createMemoryService(db: DatabaseSync): BalbesMemoryService {
  const selectById = db.prepare("SELECT * FROM memories WHERE id = ?");
  const selectTags = db.prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag");
  const insertMemory = db.prepare(
    "INSERT INTO memories (id, scope_kind, scope_name, type, text, pinned, origin, origin_ref, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertTag = db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)");
  const deleteTags = db.prepare("DELETE FROM memory_tags WHERE memory_id = ?");
  const deleteMemoryStatement = db.prepare("DELETE FROM memories WHERE id = ?");
  const updateMemory = db.prepare(
    "UPDATE memories SET type = ?, text = ?, pinned = ?, origin_ref = ?, updated_at = ? WHERE id = ?"
  );

  function tagsOf(id: string): string[] {
    return selectTags.all(id).map((row) => asText(row.tag, "corrupt tag"));
  }

  function load(id: string): MemoryRecord | undefined {
    const row = selectById.get(id);
    if (row === undefined) return undefined;
    return toRecord(row, tagsOf(id));
  }

  function attachTags(rows: Row[]): MemoryRecord[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => asText(row.id, "corrupt record: missing id"));
    const placeholders = ids.map(() => "?").join(", ");
    const tagRows = db
      .prepare("SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (" + placeholders + ") ORDER BY tag")
      .all(...ids);
    const byId = new Map<string, string[]>();
    for (const row of tagRows) {
      const id = asText(row.memory_id, "corrupt tag row");
      const list = byId.get(id);
      if (list === undefined) byId.set(id, [asText(row.tag, "corrupt tag")]);
      else list.push(asText(row.tag, "corrupt tag"));
    }
    return rows.map((row) => {
      const id = asText(row.id, "corrupt record: missing id");
      return toRecord(row, byId.get(id) ?? []);
    });
  }

  function buildClauses(filter: MemoryFilter): { clauses: string[]; params: SQLInputValue[] } {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.scope !== undefined) {
      if (filter.scope.kind === "global") clauses.push("m.scope_kind = 'global'");
      else {
        clauses.push("m.scope_kind = 'project' AND m.scope_name = ?");
        params.push(filter.scope.name);
      }
    }
    if (filter.scopes !== undefined) {
      if (filter.scopes.length === 0) clauses.push("0 = 1");
      else {
        const ors: string[] = [];
        for (const scope of filter.scopes) {
          if (scope.kind === "global") ors.push("m.scope_kind = 'global'");
          else {
            ors.push("(m.scope_kind = 'project' AND m.scope_name = ?)");
            params.push(scope.name);
          }
        }
        clauses.push("(" + ors.join(" OR ") + ")");
      }
    }
    if (filter.type !== undefined) {
      clauses.push("m.type = ?");
      params.push(filter.type);
    }
    if (filter.pinned !== undefined) {
      clauses.push("m.pinned = ?");
      params.push(filter.pinned ? 1 : 0);
    }
    if (filter.tag !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM memory_tags t WHERE t.memory_id = m.id AND t.tag = ?)");
      params.push(filter.tag);
    }
    return { clauses, params };
  }

  function whereOf(clauses: string[]): string {
    return clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
  }

  async function save(draft: Parameters<BalbesMemoryService["save"]>[0]): Promise<MemoryRecord> {
    const normalized = normalizeDraft(draft);
    const secret = detectSecret(normalized.text);
    if (secret !== null) {
      throw new MemoryError("secret-detected", 'text matches secret rule "' + secret.rule + '"');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const scopeName = normalized.scope.kind === "project" ? normalized.scope.name : null;
    db.exec("BEGIN");
    try {
      insertMemory.run(
        id,
        normalized.scope.kind,
        scopeName,
        normalized.type,
        normalized.text,
        normalized.pinned ? 1 : 0,
        normalized.origin,
        normalized.originRef,
        now,
        now
      );
      for (const tag of normalized.tags) insertTag.run(id, tag);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const record = load(id);
    if (record === undefined) throw new MemoryError("not-found", "memory vanished after insert: " + id);
    return record;
  }

  async function get(id: string): Promise<MemoryRecord | undefined> {
    return load(id);
  }

  async function update(id: string, patch: Parameters<BalbesMemoryService["update"]>[1]): Promise<MemoryRecord> {
    const existing = load(id);
    if (existing === undefined) throw new MemoryError("not-found", "memory not found: " + id);
    const normalized = normalizePatch(patch);
    if (normalized.text !== undefined) {
      const secret = detectSecret(normalized.text);
      if (secret !== null) {
        throw new MemoryError("secret-detected", 'text matches secret rule "' + secret.rule + '"');
      }
    }
    const now = new Date().toISOString();
    const nextPinned = normalized.pinned ?? existing.pinned;
    const nextOriginRef = normalized.originRef !== undefined ? normalized.originRef : existing.originRef;
    db.exec("BEGIN");
    try {
      updateMemory.run(
        normalized.type ?? existing.type,
        normalized.text ?? existing.text,
        nextPinned ? 1 : 0,
        nextOriginRef,
        now,
        id
      );
      if (normalized.tags !== undefined) {
        deleteTags.run(id);
        for (const tag of normalized.tags) insertTag.run(id, tag);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const updated = load(id);
    if (updated === undefined) throw new MemoryError("not-found", "memory vanished during update: " + id);
    return updated;
  }

  async function remove(id: string): Promise<boolean> {
    const result = deleteMemoryStatement.run(id);
    return Number(result.changes) > 0;
  }

  async function list(rawFilter?: MemoryFilter): Promise<MemoryRecord[]> {
    const filter = normalizeFilter(rawFilter);
    const { clauses, params } = buildClauses(filter);
    const limit = clamp(filter.limit ?? LIMITS.defaultListLimit, 1, LIMITS.maxListLimit);
    const offset = filter.offset ?? 0;
    const rows = db
      .prepare(
        "SELECT m.* FROM memories m " +
          whereOf(clauses) +
          " ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ? OFFSET ?"
      )
      .all(...params, limit, offset);
    return attachTags(rows);
  }

  async function search(request: Parameters<BalbesMemoryService["search"]>[0]): Promise<SearchHit[]> {
    if (typeof request !== "object" || request === null) {
      throw new MemoryError("invalid-query", "request must be an object");
    }
    const query = typeof request.query === "string" ? request.query.trim() : "";
    if (query === "") throw new MemoryError("invalid-query", "query must not be empty");
    const filter = normalizeFilter(request.filter);
    const limit = clamp(request.limit ?? filter.limit ?? LIMITS.defaultSearchLimit, 1, LIMITS.maxSearchLimit);
    const { clauses, params } = buildClauses(filter);
    let rows: Row[];
    try {
      rows = db
        .prepare(
          "SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts " +
            "JOIN memories m ON m.rowid = memory_fts.rowid " +
            whereOf(["memory_fts MATCH ?", ...clauses]) +
            " ORDER BY m.pinned DESC, rank ASC LIMIT ?"
        )
        .all(query, ...params, limit);
    } catch (error) {
      throw new MemoryError(
        "invalid-query",
        "invalid search query: " + (error instanceof Error ? error.message : String(error))
      );
    }
    const records = attachTags(rows);
    return rows.map((row, index) => {
      const record = records[index];
      if (record === undefined) throw new MemoryError("invalid-record", "row mapping mismatch");
      return { record, rank: Number(row.rank) };
    });
  }

  async function count(rawFilter?: MemoryFilter): Promise<number> {
    const filter = normalizeFilter(rawFilter);
    const { clauses, params } = buildClauses(filter);
    const row = db.prepare("SELECT COUNT(*) AS n FROM memories m " + whereOf(clauses)).get(...params);
    return Number(row?.n ?? 0);
  }

  return { save, get, update, delete: remove, list, search, count };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter dsh-balbes-memory test`
Expected: PASS (validate, secrets, schema, service, search).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter dsh-balbes-memory typecheck`
Expected: no errors.

```bash
git add packages/plugins/dsh-balbes-memory/src/service.ts packages/plugins/dsh-balbes-memory/tests/service.test.ts packages/plugins/dsh-balbes-memory/tests/search.test.ts
git commit -m "feat(memory): add the balbesMemory service with filters and FTS5 search"
```

## Task 6: Plugin entry (apply)

**Files:**
- Create: `packages/plugins/dsh-balbes-memory/src/index.ts`
- Test: `packages/plugins/dsh-balbes-memory/tests/index.test.ts`

**Interfaces (Consumes):** `openMemoryDatabase` (Task 4), `createMemoryService` (Task 5).
**Interfaces (Produces):** `name = "balbes-memory"`, `Config`, `apply(ctx, config)` that provides `balbesMemory` and registers a disposer.

- [ ] **Step 1: Write the failing test**

`packages/plugins/dsh-balbes-memory/tests/index.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config, name } from "../src/index.js";
import type { BalbesMemoryService } from "../src/types.js";

interface Harness {
  provided: Map<string, unknown>;
  effects: Array<() => void>;
  warnings: string[];
}

function harness(): { ctx: unknown; h: Harness } {
  const h: Harness = { provided: new Map(), effects: [], warnings: [] };
  const ctx = {
    provide(key: string, value: unknown): void {
      h.provided.set(key, value);
    },
    effect(callback: () => (() => void) | void): void {
      const disposer = callback();
      if (typeof disposer === "function") h.effects.push(disposer);
    },
    logger: {
      warn(message: string): void {
        h.warnings.push(message);
      }
    }
  };
  return { ctx, h };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "balbes-memory-plugin-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("balbes-memory plugin", () => {
  it("exposes the functional plugin contract", () => {
    expect(name).toBe("balbes-memory");
    expect(Config({})).toEqual({});
    expect(Config({ dshHome: "/x" })).toEqual({ dshHome: "/x" });
  });

  it("provides balbesMemory and registers a disposer", async () => {
    const { ctx, h } = harness();
    await apply(ctx as never, { dshHome: dir });
    const service = h.provided.get("balbesMemory") as BalbesMemoryService;
    expect(service).toBeDefined();
    const saved = await service.save({
      scope: { kind: "global" },
      type: "note",
      text: "hello memory",
      origin: "owner"
    });
    expect((await service.get(saved.id))?.text).toBe("hello memory");
    expect(h.effects.length).toBe(1);
    h.effects[0]?.();
  });

  it("warns and provides nothing when the database cannot be opened", async () => {
    await writeFile(join(dir, "not-a-dir"), "x", "utf8");
    const { ctx, h } = harness();
    await apply(ctx as never, { dshHome: dir, memoryPath: join(dir, "not-a-dir", "memory.sqlite") });
    expect(h.provided.has("balbesMemory")).toBe(false);
    expect(h.warnings.join(" ")).toContain("balbes-memory");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dsh-balbes-memory test -- index`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 3: Write `src/index.ts`**

```ts
import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { openMemoryDatabase } from "./schema.js";
import { createMemoryService } from "./service.js";

export const name = "balbes-memory";

export const Config = z.object({
  dshHome: z.string().required(false),
  memoryPath: z.string().required(false)
});

interface CtxLike {
  provide(key: string, value: unknown): void;
  effect(callback: () => (() => void) | void, label?: string): void;
  logger: { warn(message: string): void };
}

interface MemoryConfig {
  dshHome?: string;
  memoryPath?: string;
}

/**
 * Host-side memory store. Opens the SQLite database, migrates it, and provides
 * the balbesMemory service. On any open/migration failure it logs and provides
 * nothing, so the rest of the server keeps running.
 */
export async function apply(ctx: CtxLike, config: MemoryConfig): Promise<void> {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const dbPath = config.memoryPath ?? join(dshHome, "storages", "memory.sqlite");
  let db;
  try {
    db = await openMemoryDatabase(dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn("balbes-memory: failed to open " + dbPath + ": " + message);
    return;
  }
  ctx.provide("balbesMemory", createMemoryService(db));
  ctx.effect(() => () => {
    db.close();
  }, "balbesMemory.close");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dsh-balbes-memory test -- index`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter dsh-balbes-memory typecheck`
Expected: no errors.

```bash
git add packages/plugins/dsh-balbes-memory/src/index.ts packages/plugins/dsh-balbes-memory/tests/index.test.ts
git commit -m "feat(memory): provide the balbesMemory service from the plugin entry"
```

---

## Task 7: REAL-composition test

**Files:**
- Create: `packages/plugins/dsh-balbes-memory/tests/fixtures/balbes-memory-profile/package.json`
- Create: `packages/plugins/dsh-balbes-memory/tests/fixtures/balbes-memory-profile/cordis.patch.yml`
- Test: `packages/plugins/dsh-balbes-memory/tests/integration.test.ts`

**Interfaces (Consumes):** built `lib/` of the plugin and `dsh-balbes-host` (run `pnpm build` first), admin auth helpers from `dsh-balbes-host/src/core.ts`.

- [ ] **Step 1: Create the fixture profile**

`packages/plugins/dsh-balbes-memory/tests/fixtures/balbes-memory-profile/package.json`:

```json
{
  "name": "dsh-profile-balbes-memory-test",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-balbes-host"],
      "patchReload": "startup"
    }
  }
}
```

`packages/plugins/dsh-balbes-memory/tests/fixtures/balbes-memory-profile/cordis.patch.yml`:

```yaml
# Test composition for the memory plugin: dsh-base + the balbes host bundle
# (so the server has /api/health) + the plugin under test. The plugin resolves
# $DSH_HOME from the environment and creates $DSH_HOME/storages/memory.sqlite.
- insert:
    - id: balbes-memory
      name: 'dsh-balbes-memory'
```

- [ ] **Step 2: Write the REAL-composition test**

`packages/plugins/dsh-balbes-memory/tests/integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

/**
 * REAL composition: a real dsh profile (dsh-base + host bundle + balbes-memory)
 * booted by the real CLI. p10a has no HTTP surface, so the observable proof is
 * the durable artifact: the plugin must create and migrate
 * $DSH_HOME/storages/memory.sqlite without breaking server startup.
 *
 * Gate: RUN_REAL=1 and dsh in PATH (like the neighboring REAL suites).
 */
const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const fixtureProfile = join(here, "fixtures", "balbes-memory-profile");
const PROFILE = "balbes-memory-test";

async function hasDsh(): Promise<boolean> {
  try {
    await execFileP("dsh", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, child: ReturnType<typeof spawn>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("dsh exited early (code " + child.exitCode + ")");
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/api/health", { method: "POST" });
      const json = (await response.json()) as { ok?: boolean };
      if (response.status === 200 && json.ok === true) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server did not become healthy within " + timeoutMs + "ms");
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare("PRAGMA user_version").get();
  db.close();
  return Number(row?.user_version ?? 0);
}

const realEnabled = (process.env.RUN_REAL ?? "").trim() !== "" ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (balbes-memory)", () => {
  let home: string;
  let child: ReturnType<typeof spawn> | null = null;
  let port: number;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "balbes-memory-real-"));
    await mkdir(join(home, "profiles"), { recursive: true });
    await cp(fixtureProfile, join(home, "profiles", PROFILE), { recursive: true });
    const nm = join(home, "profiles", PROFILE, "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    for (const piece of ["lib", "package.json"]) {
      await cp(join(pkgRoot, piece), join(nm, "dsh-balbes-memory", piece), { recursive: true });
    }
    const creds = await createAdminAuth();
    await writeAdminAuth(home, creds);
    port = await freePort();
    child = spawn("dsh", ["--profile", PROFILE], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home, BALBES_PORT: String(port) },
      stdio: "ignore"
    });
    await waitForHealth(port, child);
  }, 120_000);

  afterAll(async () => {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child!.once("exit", resolve));
    }
    await rm(home, { recursive: true, force: true });
  });

  it("creates and migrates the memory database without breaking startup", async () => {
    const dbPath = join(home, "storages", "memory.sqlite");
    const info = await stat(dbPath);
    expect(info.isFile()).toBe(true);
    expect(userVersion(dbPath)).toBe(1);
  });
});
```

- [ ] **Step 3: Build the packages, then run the REAL test**

Run:
```bash
pnpm build
RUN_REAL=1 pnpm --filter dsh-balbes-memory test -- integration
```
Expected: PASS when `dsh` is on PATH; otherwise the suite is skipped.

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/dsh-balbes-memory/tests/fixtures packages/plugins/dsh-balbes-memory/tests/integration.test.ts
git commit -m "test(memory): REAL composition creates and migrates the store"
```

## Task 8: Profile registration, installer, runbook

**Files:**
- Modify: `profiles/balbes/cordis.patch.yml`
- Modify: `scripts/install.sh`
- Modify: `docs/runbooks/stage2-vps.md`

- [ ] **Step 1: Register the plugin in the profile patch**

In `profiles/balbes/cordis.patch.yml`, add after the `balbes-home` row:

```yaml
    - id: balbes-memory
      name: 'dsh-balbes-memory'
```

- [ ] **Step 2: Add the installer copy step**

In `scripts/install.sh`:

(a) In the header comment listing built packages, add `dsh-balbes-memory` to the list.

(b) Add this function after `copy_home_into_profile()` (mirror of the existing copy functions):

```bash
# copy_memory_into_profile — зеркало copy_home_into_profile: собранный
# плагин памяти копируется реальным каталогом в node_modules профиля.
copy_memory_into_profile() {
    local profile_dir="$DSH_HOME/profiles/$PROFILE_NAME"
    local src="$REPO_DIR/packages/plugins/dsh-balbes-memory"
    local dst="$profile_dir/node_modules/dsh-balbes-memory"
    if [[ ! -d "$src/lib" ]]; then
        die "memory plugin not built at $src/lib — build step failed"
    fi
    mkdir -p "$profile_dir/node_modules"
    rm -rf "$dst"
    cp -R "$src" "$dst"
    rm -f "$dst/tsconfig.json" "$dst/tsconfig.build.json"
    rm -rf "$dst/tests" "$dst/src" "$dst/lib/types"
    chmod -R u+rwX,go-w "$dst"
    info "Memory plugin copied into $dst"
}
```

(c) In `main()`, add `copy_memory_into_profile` right after `copy_home_into_profile`.

- [ ] **Step 3: Update the runbook**

In `docs/runbooks/stage2-vps.md`:

(a) In `## Обновление`, after the paragraph that says the installer restarts the unit on every run, add:

````markdown
### Миграции памяти

Плагин `balbes-memory` прогоняет миграции схемы при открытии БД на старте
сервиса, поэтому отдельного шага обновления не требует: `install.sh`
перезапускает юнит, плагин применяет недостающие миграции и выставляет
`PRAGMA user_version`. Перед миграцией создаётся WAL-безопасный бэкап
`$DSH_HOME/storages/memory.sqlite.bak-v<прежняя версия>`. Если открытие или
миграция падает, плагин пишет ошибку в журнал и **не** предоставляет сервис
`balbesMemory`, но сервер продолжает работать.
````

(b) In `## Smoke без браузера (curl + JWT)`, add a memory block:

````markdown
```bash
# память: файл БД создан и схема на v1 (серверного API в p10a нет)
ls -l "$HOME/.dsh/storages/memory.sqlite"
node --no-warnings -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.HOME+"/.dsh/storages/memory.sqlite");console.log("user_version:",db.prepare("PRAGMA user_version").get().user_version)'
# ожидается: файл существует, user_version: 1
```
````

(c) In `## Устранение неполадок`, add:

````markdown
### Память не открылась / миграция не применилась

Симптом: в `journalctl -u dsh-balbes` строка `balbes-memory: failed to open ...`.
Сервер при этом живой.

Восстановление из предмиграционного бэкапа:

```bash
sudo systemctl stop dsh-balbes
cp "$HOME/.dsh/storages/memory.sqlite.bak-v1" "$HOME/.dsh/storages/memory.sqlite"
rm -f "$HOME/.dsh/storages/memory.sqlite-wal" "$HOME/.dsh/storages/memory.sqlite-shm"
sudo systemctl start dsh-balbes
```
````

- [ ] **Step 4: Verify the installer syntax and the wiring (read-only)**

Run: `bash -n scripts/install.sh`
Expected: no syntax errors.

Run: `grep -n "balbes-memory" profiles/balbes/cordis.patch.yml scripts/install.sh`
Expected: the profile row, the function, and the `main()` call all appear.

- [ ] **Step 5: Commit**

```bash
git add profiles/balbes/cordis.patch.yml scripts/install.sh docs/runbooks/stage2-vps.md
git commit -m "feat(profile): compose balbes-memory and document its migrations"
```

---

## Task 9: Final verification and canon audit

**Files:** none (verification only).

- [ ] **Step 1: Install, typecheck, test, build the whole workspace**

Run:
```bash
pnpm install
node scripts/link-core.mjs
pnpm typecheck
pnpm test
pnpm build
```
Expected: all pass. `pnpm test` may print the experimental `node:sqlite` warning; that is expected and not a failure.

- [ ] **Step 2: Confirm the composition loads**

Run: `DSH_HOME="$(mktemp -d)" dsh --profile balbes --dump-config >/dev/null && echo OK`
Expected: `OK` (the `balbes-memory` row resolves).

- [ ] **Step 3: Close with canon-audit**

Use the `canon-audit` skill on the memory topic; resolve any docs/code divergence and update `docs/canon/DISCREPANCIES.md` if needed.

- [ ] **Step 4: Commit any audit fix**

```bash
git add -A
git commit -m "docs(canon): audit the p10a memory layer against the code"
```

- [ ] **Step 5: Server verification handoff**

Report to the owner (do not push without go-ahead), grounded in `docs/runbooks/stage2-vps.md`:

```bash
bash ~/dsh-balbes-server/scripts/install.sh
curl -fsS -X POST http://127.0.0.1:8080/api/health
ls -l "$HOME/.dsh/storages/memory.sqlite"
node --no-warnings -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.HOME+"/.dsh/storages/memory.sqlite");console.log("user_version:",db.prepare("PRAGMA user_version").get().user_version)'
```

Expected: installer completes, health returns `{"ok":true,...}`, the DB file exists, `user_version: 1`.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Package and composition | Task 2 (manifest), Task 6 (entry), Task 8 (profile + installer) |
| Storage / node:sqlite / pragmas | Task 4 |
| Data model and schema v1 | Task 4 |
| Validation | Task 2 |
| `balbesMemory` service API | Task 2 (interface), Task 5 (impl) |
| Privacy / secret detector | Task 3, Task 5 (enforcement) |
| Migrations + backup + refusal policy | Task 4 (migrate/backup), Task 6 (degrade on failure) |
| Testing (unit + REAL) | Tasks 2-7 |
| Server update + runbook | Task 8 |
| Canon | Task 1 (write), Task 9 (audit) |

**Placeholder scan:** no TBD/TODO; every code step carries complete code.

**Type consistency:** `BalbesMemoryService` is defined once in `src/types.ts` and implemented in `src/service.ts`; `createMemoryService` returns it; `openMemoryDatabase` returns `DatabaseSync`; `MemoryError.code` values are `secret-detected | invalid-record | not-found | invalid-scope | invalid-filter | invalid-query` and are used consistently in tests.

**Known limitation:** the pre-migration backup path is exercised in tests through an injected v2 migration (there is only one real migration today).

## Execution Handoff

After Task 9, offer the owner the two execution options (subagent-driven per task, or inline with checkpoints).



