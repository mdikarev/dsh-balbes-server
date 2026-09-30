# Memory Review and Autonomy (p10f) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proposed memory records in their own table, an owner review queue (approve / reject / edit-on-approve) in the admin UI, and a fixed, owner-visible autonomy policy — without touching the `memories` truth table or the delivery layer.

**Architecture:** A new `memory_proposals` table (migration v2, additive DDL only) holds staged records; `balbesMemory` gains `propose`/`listProposals`/`getProposal`/`approve`/`reject`, and `approve` promotes a proposal into `memories` inside one transaction by reusing the existing normalizers, secret detector and insert statements. Four new bearer POST handles expose the pipeline seam and the review queue; the admin UI gets a second tab on the existing "Память" page. Because delivery reads `memories` and never the proposals table, pending knowledge is structurally invisible to the model.

**Tech Stack:** TypeScript (strict, ESM), Node 24 `node:sqlite` (`DatabaseSync`, SQLite 3.50 with JSON1), Cordis plugins (dsh), React 18 + Vite admin SPA, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-memory-review-design.md`

## Global Constraints

- TypeScript strict, ESM only, `.ts`/`.js` suffix on package-local relative imports (`../src/schema.js`).
- Never edit installed `@deepseek-ai/*`; compose through existing seams only.
- Function plugins keep named exports `name` / `inject` / `Config` / `apply`, no default export.
- R-API-1: every `/api/*` request is POST; errors are `{error:{code,message}}` with stable codes.
- `packages/contracts/src/index.ts` is the compiler SoT for HTTP forms; a new handle appears in `docs/canon/API_CONTRACTS.md` in the same commit.
- Migration v2 is additive DDL only: never alter, rebuild or re-index `memories`, `memory_tags` or `memory_fts`.
- No new runtime dependencies in any package.
- `docs/canon/**` is never edited by hand — canon changes go through the `canon-write` / `canon-future-plan` skills.
- Tests: Vitest. REAL composition suites are gated by `RUN_REAL=1` **and** `dsh` on `PATH`.
- Conventional-commit messages, one commit per task; no `git push` without the owner's go-ahead.

---

### Task 1: Canon first (blocks all code)

**Files:**
- Modify (via skills only): `docs/canon/ARCHITECTURE.md`, `docs/canon/GLOSSARY.md`, `docs/canon/ADMIN_UI.md`, `docs/canon/API_CONTRACTS.md`, `docs/canon/OVERVIEW.md`, `docs/canon/future_plans/p10f-memory-review.md`, `docs/canon/future_plans/p10-memory-system.md`, `docs/canon/future_plans/INDEX.md`

**Interfaces:**
- Consumes: the approved spec `docs/superpowers/specs/2026-09-30-memory-review-design.md`.
- Produces: living canon that describes the target behaviour; every later task implements exactly what canon now says.

- [ ] **Step 1: Update architecture, glossary and UI canon**

Load the `canon-write` skill and apply it for these sections (do not hand-edit the files):

- `ARCHITECTURE.md` — Memory layer: add a subsection "Ревью и автономия записи (p10f)" describing: the separate `memory_proposals` table and why proposals are structurally invisible to delivery; the lifecycle `proposed → accepted | rejected` with no reverse transitions; promotion in one transaction; the fixed autonomy policy (owner + `remember` immediate, pipeline reviewed, no auto-approval); the `invalid-status` error; and that `remember` (p10e) is unchanged. Remove the now-stale "ревью и автономия (p10f)" item from the "Границы" list of the delivery subsection.
- `GLOSSARY.md` — three new terms: «предложенная запись памяти», «ревью памяти», «политика автономии».
- `ADMIN_UI.md` — the "Память" page becomes two tabs («Записи» and «Очередь ревью») with the queue's toolbar, row anatomy, actions, policy line and empty/error states.
- `API_CONTRACTS.md` — four handles (`memory.propose`, `memory.review/list`, `memory.review/approve`, `memory.review/reject`) in the documented `### <id> — <название>` shape, the `MemoryProposal` and `MemoryAutonomyPolicy` types, and the `invalid-status` code in the memory error list.
- `OVERVIEW.md` — the memory paragraph: review and autonomy are now part of the implemented contour.

- [ ] **Step 2: Close the future-plan entry**

Use the `canon-future-plan` skill: `future_plans/p10f-memory-review.md` → `Status: absorbed` with the decisions recorded in the plan body (proposals table, policy, review surface, deferred items pointing at p10d/p10g/p10h); sync `future_plans/INDEX.md`; note the change in `p10-memory-system.md`.

- [ ] **Step 3: Verify canon consistency**

Run: `doc-canon scout "memory review proposed records autonomy policy"`
Expected: `ARCHITECTURE.md`, `GLOSSARY.md`, `ADMIN_UI.md`, `API_CONTRACTS.md` are hit for the review topic, and `p10f-memory-review.md` no longer reads as a draft initiative.

- [ ] **Step 4: Commit and stop for go-ahead**

```bash
git add docs/canon
git commit -m "docs(canon): add memory review and autonomy policy (p10f)"
```

**STOP.** Canon changed substantially: report the diff to the owner and wait for explicit go-ahead before Task 2. Do not start code in this step.

---

### Task 2: Contracts, store types and normalizers

**Files:**
- Modify: `packages/contracts/src/index.ts` (append after `MemoryDeleteResponse`, ~line 396)
- Modify: `packages/contracts/tests/contracts.test.ts`
- Modify: `packages/plugins/dsh-balbes-memory/src/errors.ts`
- Modify: `packages/plugins/dsh-balbes-memory/src/types.ts`
- Modify: `packages/plugins/dsh-balbes-memory/src/validate.ts`
- Test: `packages/plugins/dsh-balbes-memory/tests/validate.test.ts`

**Interfaces:**
- Consumes: nothing (first code task).
- Produces: `MemoryProposalStatus`, `MemoryProposal`, `MemoryAutonomyPolicy`, `MemoryProposeRequest/Response`, `MemoryReviewListRequest/Response`, `MemoryReviewApproveRequest/Response`, `MemoryReviewRejectRequest/Response` (contracts); `MemoryProposalDraft`, `MemoryProposalFilter`, `MemoryDecisionPatch`, `MEMORY_PROPOSAL_STATUSES` (store types); `normalizeProposalDraft(draft): NormalizedProposalDraft`, `normalizeProposalFilter(filter): MemoryProposalFilter`, `normalizeDecisionPatch(patch): MemoryDecisionPatch`; error code `"invalid-status"`.

- [ ] **Step 1: Write the failing normalizer tests**

Append to `packages/plugins/dsh-balbes-memory/tests/validate.test.ts`:

```ts
import {
  normalizeDecisionPatch,
  normalizeProposalDraft,
  normalizeProposalFilter
} from "../src/validate.js";

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
  });

  it("drops identity and provenance fields from a decision patch", () => {
    expect(
      normalizeDecisionPatch({ text: " edited ", tags: ["A"], pinned: true, id: "spoof", originRef: "spoof" })
    ).toEqual({ text: "edited", tags: ["a"], pinned: true });
    expect(normalizeDecisionPatch({})).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/plugins/dsh-balbes-memory && npx vitest run tests/validate.test.ts`
Expected: FAIL — `normalizeProposalDraft is not a function` (or a TypeScript import error).

- [ ] **Step 3: Add the contract types**

Append to `packages/contracts/src/index.ts` after `MemoryDeleteResponse`:

```ts
// Memory review surface - staged proposals and owner autonomy (p10f)
export type MemoryProposalStatus = "proposed" | "accepted" | "rejected";

export interface MemoryProposal {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags: string[];
  origin: MemoryOrigin;
  originRef: string | null;
  status: MemoryProposalStatus;
  proposedAt: string; // ISO 8601
  decidedAt: string | null; // ISO 8601
  decidedBy: string | null; // v1: always "owner"
  decidedEdit: boolean;
  memoryId: string | null;
}

export interface MemoryAutonomyPolicy {
  /** Sources whose writes are truth immediately. */
  immediate: Array<"owner" | "remember">;
  /** Sources whose writes are staged for review. */
  review: Array<"pipeline">;
  /** There is no auto-approval path in v1. */
  autoApprove: "none";
}

export interface MemoryProposeRequest {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  originRef?: string;
}
export interface MemoryProposeResponse {
  proposal: MemoryProposal;
}

export interface MemoryReviewListRequest {
  scope?: MemoryScope;
  type?: MemoryType;
  tag?: string;
  /** Absent = only `proposed`; an explicit list widens the queue to decided rows. */
  status?: MemoryProposalStatus[];
  limit?: number;
  offset?: number;
}
export interface MemoryReviewListResponse {
  proposals: MemoryProposal[];
  policy: MemoryAutonomyPolicy;
}

export interface MemoryReviewApproveRequest {
  id: string;
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
}
export interface MemoryReviewApproveResponse {
  proposal: MemoryProposal;
  record: MemoryRecord;
}

export interface MemoryReviewRejectRequest {
  id: string;
}
export interface MemoryReviewRejectResponse {
  proposal: MemoryProposal;
}
```

Add a structural test to `packages/contracts/tests/contracts.test.ts` (import the new types in its type-only import list):

```ts
// Memory review contracts — proposals are staged, truth is a separate record.
describe("memory review contracts", () => {
  it("keeps proposal status separate from the memory record", () => {
    const proposal: MemoryProposal = {
      id: "p-1",
      scope: { kind: "global" },
      type: "fact",
      text: "staged",
      tags: [],
      origin: "agent",
      originRef: "pipeline:test",
      status: "proposed",
      proposedAt: "2026-09-30T00:00:00.000Z",
      decidedAt: null,
      decidedBy: null,
      decidedEdit: false,
      memoryId: null
    };
    const policy: MemoryAutonomyPolicy = { immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" };
    const approve: MemoryReviewApproveRequest = { id: proposal.id, text: "edited" };
    expect(JSON.parse(JSON.stringify({ proposal, policy, approve }))).toEqual({ proposal, policy, approve });
  });
});
```

- [ ] **Step 4: Add the error code and store types**

In `packages/plugins/dsh-balbes-memory/src/errors.ts`, add `"invalid-status"` to `MemoryErrorCode` after `"invalid-query"`.

In `packages/plugins/dsh-balbes-memory/src/types.ts`, extend the re-export list and append:

```ts
export type {
  MemoryOrigin,
  MemoryProposal,
  MemoryProposalStatus,
  MemoryRecord,
  MemoryScope,
  MemoryType
} from "dsh-balbes-contracts";

export interface MemoryProposalDraft {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  originRef?: string | null;
}

export interface MemoryProposalFilter {
  scope?: MemoryScope;
  type?: MemoryType;
  tag?: string;
  status?: MemoryProposalStatus[];
  limit?: number;
  offset?: number;
}

/** The owner's edit at approval time. Provenance and identity are not patchable. */
export interface MemoryDecisionPatch {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
}
```

Do **not** extend `BalbesMemoryService` in this task. `createMemoryService` returns a concrete object literal of the existing seven methods (`service.ts:277`), so adding interface methods here breaks `pnpm build`/`pnpm typecheck` with TS2739 — and both ways to silence it are worse: a cast removes compile-time checking of the whole service literal until Task 4, and throwing stubs put future-task code in this task. The five signatures below are added by Task 4, which implements them:

```ts
  propose(draft: MemoryProposalDraft): Promise<MemoryProposal>;
  getProposal(id: string): Promise<MemoryProposal | undefined>;
  listProposals(filter?: MemoryProposalFilter): Promise<MemoryProposal[]>;
  approve(id: string, patch?: MemoryDecisionPatch): Promise<{ proposal: MemoryProposal; record: MemoryRecord }>;
  reject(id: string): Promise<MemoryProposal>;
```

Add the constant next to `MEMORY_ORIGINS`:

```ts
export const MEMORY_PROPOSAL_STATUSES = ["proposed", "accepted", "rejected"] as const;
```

- [ ] **Step 5: Add the normalizers**

Append to `packages/plugins/dsh-balbes-memory/src/validate.ts` (import `MEMORY_PROPOSAL_STATUSES`, `MemoryDecisionPatch`, `MemoryProposalFilter`, `MemoryProposalStatus` from `./types.js`):

```ts
function isProposalStatus(value: unknown): value is MemoryProposalStatus {
  return typeof value === "string" && (MEMORY_PROPOSAL_STATUSES as readonly string[]).includes(value);
}

export interface NormalizedProposalDraft {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags: string[];
  originRef: string | null;
}

export function normalizeProposalDraft(draft: unknown): NormalizedProposalDraft {
  if (typeof draft !== "object" || draft === null) {
    throw new MemoryError("invalid-record", "draft must be an object");
  }
  const d = draft as Record<string, unknown>;
  if (!isMemoryType(d.type)) throw new MemoryError("invalid-record", "invalid type");
  return {
    scope: assertScope(d.scope),
    type: d.type,
    text: normalizeText(d.text),
    tags: normalizeTags(d.tags),
    originRef: normalizeOriginRef(d.originRef)
  };
}

export function normalizeProposalFilter(filter: unknown): MemoryProposalFilter {
  if (filter === undefined) return {};
  if (typeof filter !== "object" || filter === null) {
    throw new MemoryError("invalid-filter", "filter must be an object");
  }
  const f = filter as Record<string, unknown>;
  const out: MemoryProposalFilter = {};
  if (f.scope !== undefined) out.scope = assertScope(f.scope);
  if (f.type !== undefined) {
    if (!isMemoryType(f.type)) throw new MemoryError("invalid-filter", "invalid type");
    out.type = f.type;
  }
  if (f.tag !== undefined) {
    if (typeof f.tag !== "string") throw new MemoryError("invalid-filter", "tag must be a string");
    out.tag = normalizeTag(f.tag, "invalid-filter");
  }
  if (f.status !== undefined) {
    if (!Array.isArray(f.status)) throw new MemoryError("invalid-filter", "status must be an array");
    if (f.status.length === 0) throw new MemoryError("invalid-filter", "status must not be empty");
    out.status = f.status.map((status) => {
      if (!isProposalStatus(status)) throw new MemoryError("invalid-filter", "invalid proposal status");
      return status;
    });
  }
  if (f.limit !== undefined) out.limit = assertNonNegativeInteger(f.limit, "limit");
  if (f.offset !== undefined) out.offset = assertNonNegativeInteger(f.offset, "offset");
  return out;
}

export function normalizeDecisionPatch(patch: unknown): MemoryDecisionPatch {
  if (typeof patch !== "object" || patch === null) {
    throw new MemoryError("invalid-record", "patch must be an object");
  }
  const p = patch as Record<string, unknown>;
  const out: MemoryDecisionPatch = {};
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
  return out;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/plugins/dsh-balbes-memory && npx vitest run tests/validate.test.ts` then `cd packages/contracts && npx vitest run`
Expected: PASS.

Run: `pnpm -r build && pnpm typecheck`
Expected: PASS. Build comes first because `packages/contracts/lib` is gitignored and stale `lib/` output makes typecheck read old declarations. This task does not touch `BalbesMemoryService`, so `createMemoryService`'s literal stays fully checked here and in Task 3.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/tests/contracts.test.ts \
  packages/plugins/dsh-balbes-memory/src/errors.ts packages/plugins/dsh-balbes-memory/src/types.ts \
  packages/plugins/dsh-balbes-memory/src/validate.ts packages/plugins/dsh-balbes-memory/tests/validate.test.ts
git commit -m "feat(memory): add proposal contracts and normalizers (p10f)"
```

---

### Task 3: Schema migration v2

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory/src/schema.ts`
- Test: `packages/plugins/dsh-balbes-memory/tests/schema.test.ts`

**Interfaces:**
- Consumes: `MemoryError` with the `invalid-status` code (Task 2); nothing else.
- Produces: `DDL_V2`, `MIGRATIONS` at version 2, `LATEST_VERSION === 2`, `REQUIRED_SCHEMA_OBJECTS` including `memory_proposals`.

- [ ] **Step 1: Update the failing schema tests**

In `packages/plugins/dsh-balbes-memory/tests/schema.test.ts`:

- change `expect(readUserVersion(db)).toBe(1)` → `toBe(2)`, `expect(LATEST_VERSION).toBe(1)` → `toBe(2)`, the reopened assertions to `2`, and `expect(migrate(db)).toBe(1)` → `toBe(2)`;
- rename the first test to `creates schema v2 and is idempotent`;
- **both** tests that inject a custom migration at `version: 2` now collide with the real v2 and must move to `version: 3`:
  - "backs up before a pending migration and applies it" → `version: 3`, expect `readUserVersion(migrated) === 3` and the backup at `path + ".bak-v2"`;
  - "rolls back a failing migration and stays at v1" → rename to `... and stays at v2`, use `version: 3`, and expect the reopened database's `user_version` to be `2`.

Append two new tests:

```ts
  it("upgrades a v1 database, keeping its records and backing it up", async () => {
    const dir = await tempDir();
    const path = join(dir, "memory.sqlite");
    // Build the v1 fixture through the real v1 migration. Do NOT use
    // openMemoryDatabase({ migrations: [MIGRATIONS[0]!] }) here: its
    // post-migration validation runs against the module-wide required set
    // (which now includes the v2 table), so that seam only works with a list
    // that reaches this build's LATEST_VERSION.
    const v1 = new DatabaseSync(path);
    migrate(v1, [MIGRATIONS[0]!]);
    v1.prepare(
      "INSERT INTO memories (id, scope_kind, scope_name, type, text, pinned, origin, origin_ref, created_at, updated_at) " +
        "VALUES (?, 'global', NULL, 'fact', ?, 0, 'owner', NULL, ?, ?)"
    ).run("m-legacy", "kept across the upgrade", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    v1.close();

    const upgraded = await openMemoryDatabase(path);
    expect(readUserVersion(upgraded)).toBe(2);
    const row = upgraded.prepare("SELECT text FROM memories WHERE id = ?").get("m-legacy");
    expect(row?.text).toBe("kept across the upgrade");
    const tables = upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((entry) => String(entry.name));
    expect(tables).toContain("memory_proposals");
    upgraded.close();

    const backup = await stat(path + ".bak-v1");
    expect(backup.isFile()).toBe(true);
  });

  it("refuses a v2 database without the proposals table", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const created = new DatabaseSync(path);
    created.exec("PRAGMA user_version = 2");
    created.close();

    await expect(openMemoryDatabase(path)).rejects.toThrowError(MemoryError);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/plugins/dsh-balbes-memory && npx vitest run tests/schema.test.ts`
Expected: FAIL — `LATEST_VERSION` is still 1 and `memory_proposals` does not exist.

- [ ] **Step 3: Add the v2 DDL and migration**

In `packages/plugins/dsh-balbes-memory/src/schema.ts`, add after `DDL_V1`:

```ts
/**
 * v2 (p10f): staged proposals live in their own table. The truth table
 * `memories`, its normalized tags and its FTS triggers are not touched, which is
 * what makes pending knowledge structurally invisible to delivery.
 */
export const DDL_V2 = [
  "CREATE TABLE memory_proposals (",
  "  id           TEXT PRIMARY KEY,",
  "  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('global','project')),",
  "  scope_name   TEXT,",
  "  type         TEXT NOT NULL CHECK (type IN ('fact','preference','decision','note')),",
  "  text         TEXT NOT NULL,",
  "  tags         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),",
  "  origin       TEXT NOT NULL CHECK (origin IN ('owner','agent')),",
  "  origin_ref   TEXT,",
  "  status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected')),",
  "  proposed_at  TEXT NOT NULL,",
  "  decided_at   TEXT,",
  "  decided_by   TEXT,",
  "  decided_edit INTEGER NOT NULL DEFAULT 0 CHECK (decided_edit IN (0,1)),",
  "  memory_id    TEXT REFERENCES memories(id) ON DELETE SET NULL,",
  "  CHECK ((scope_kind = 'global'  AND scope_name IS NULL)",
  "      OR (scope_kind = 'project' AND scope_name IS NOT NULL)),",
  "  CHECK ((status =  'proposed' AND decided_at IS NULL)",
  "      OR (status <> 'proposed' AND decided_at IS NOT NULL))",
  ");",
  "CREATE INDEX idx_memory_proposals_status ON memory_proposals(status, proposed_at);",
  "CREATE INDEX idx_memory_proposals_scope  ON memory_proposals(scope_kind, scope_name);"
].join("\n");
```

Replace the `MIGRATIONS` constant with:

```ts
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: (db) => db.exec(DDL_V1) },
  { version: 2, up: (db) => db.exec(DDL_V2) }
];
```

Add the new table to `REQUIRED_SCHEMA_OBJECTS`:

```ts
const REQUIRED_SCHEMA_OBJECTS: ReadonlyArray<{ type: string; name: string }> = [
  { type: "table", name: "memories" },
  { type: "table", name: "memory_tags" },
  { type: "table", name: "memory_fts" },
  { type: "table", name: "memory_proposals" },
  { type: "trigger", name: "memories_ai" },
  { type: "trigger", name: "memories_ad" },
  { type: "trigger", name: "memories_au" }
];
```

No change to `migrate`, `openMemoryDatabase`, `probeUserVersion` or `validateMemorySchema` logic.

Accepted side effect: a foreign database that claims `user_version = 1` but has no `memories` table now receives the v2 objects before the post-migration `validateMemorySchema` fails closed, so the service is still not provided and `memories` is untouched. Pre-migration validation is not an option here — `REQUIRED_SCHEMA_OBJECTS` now lists a v2 table, so it would reject every genuine v1 database.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/plugins/dsh-balbes-memory && npx vitest run tests/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-memory/src/schema.ts packages/plugins/dsh-balbes-memory/tests/schema.test.ts
git commit -m "feat(memory): add the proposals table schema v2 (p10f)"
```

---

### Task 4: Proposal store — `propose`, `getProposal`, `listProposals`

**Files:**
- Create: `packages/plugins/dsh-balbes-memory/src/proposals.ts`
- Modify: `packages/plugins/dsh-balbes-memory/src/types.ts`
- Modify: `packages/plugins/dsh-balbes-memory/src/service.ts`
- Test: `packages/plugins/dsh-balbes-memory/tests/proposals.test.ts` (new)

**Interfaces:**
- Consumes: `normalizeProposalDraft`, `normalizeProposalFilter`, `normalizeTags` (Task 2); `memory_proposals` (Task 3); `LIMITS`.
- Produces: `createProposalStore(db, deps): ProposalStore` where `ProposalStore` covers `propose` / `getProposal` / `listProposals` plus the decision methods added in Task 5; `ProposalWriterDeps.insertMemoryRecord(id, input): void` and `ProposalWriterDeps.loadRecord(id): MemoryRecord | undefined`; **the extended `BalbesMemoryService`** (the five proposal signatures are added here, not in Task 2, because this task is where they are implemented); `createMemoryService` spreads the store into its return value.

- [ ] **Step 1: Write the failing store tests**

Create `packages/plugins/dsh-balbes-memory/tests/proposals.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDatabase } from "../src/schema.js";
import { createProposalStore } from "../src/proposals.js";
import { createMemoryService } from "../src/service.js";
import type { BalbesMemoryService } from "../src/types.js";

let dir: string;
let db: DatabaseSync;
let service: BalbesMemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "balbes-memory-proposals-"));
  db = await openMemoryDatabase(join(dir, "memory.sqlite"));
  service = createMemoryService(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const proposalDraft = {
  scope: { kind: "global" } as const,
  type: "fact" as const,
  text: "deploy runs under systemd",
  originRef: "pipeline:extraction admin session:s1"
};

describe("balbesMemory proposals", () => {
  it("stages a proposal without creating a memory record", async () => {
    const proposal = await service.propose({ ...proposalDraft, tags: ["Ops"] });
    expect(proposal.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(proposal.status).toBe("proposed");
    expect(proposal.origin).toBe("agent");
    expect(proposal.originRef).toBe("pipeline:extraction admin session:s1");
    expect(proposal.tags).toEqual(["ops"]);
    expect(proposal.decidedAt).toBeNull();
    expect(proposal.decidedBy).toBeNull();
    expect(proposal.decidedEdit).toBe(false);
    expect(proposal.memoryId).toBeNull();
    expect(proposal.proposedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps proposals out of every memory read path", async () => {
    await service.propose({ ...proposalDraft, text: "unapproved knowledge marker" });
    expect(await service.list()).toEqual([]);
    expect(await service.search({ query: "unapproved" })).toEqual([]);
    expect(await service.count()).toBe(0);
  });

  it("rejects a secret-looking proposal and writes nothing", async () => {
    await expect(service.propose({ ...proposalDraft, text: "token = abc123" })).rejects.toMatchObject({
      code: "secret-detected"
    });
    expect(await service.listProposals()).toEqual([]);
  });

  it("rejects an invalid scope, type and originRef", async () => {
    // Deliberately invalid runtime values: `as never` is the repo's idiom for
    // feeding a strictly typed entry point data it must reject at runtime.
    await expect(service.propose({ ...proposalDraft, scope: { kind: "galaxy" } } as never)).rejects.toMatchObject({
      code: "invalid-scope"
    });
    await expect(service.propose({ ...proposalDraft, type: "rumor" } as never)).rejects.toMatchObject({
      code: "invalid-record"
    });
    await expect(service.propose({ ...proposalDraft, originRef: 7 } as never)).rejects.toMatchObject({
      code: "invalid-record"
    });
  });

  it("lists pending proposals FIFO and filters by scope, type, tag and limit", async () => {
    // Ordering must not depend on the wall clock: the tie-break is a random
    // UUID, so pin `proposed_at` with fake timers instead of sleeping.
    vi.useFakeTimers();
    let first;
    try {
      vi.setSystemTime(new Date("2026-09-30T00:00:00.000Z"));
      first = await service.propose({ ...proposalDraft, text: "first", tags: ["ops"] });
      vi.setSystemTime(new Date("2026-09-30T00:00:05.000Z"));
      await service.propose({ ...proposalDraft, text: "second", type: "note", scope: { kind: "project", name: "alpha" } });
    } finally {
      vi.useRealTimers();
    }

    const pending = await service.listProposals();
    expect(pending.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect((await service.listProposals({ type: "note" })).map((entry) => entry.text)).toEqual(["second"]);
    expect((await service.listProposals({ scope: { kind: "project", name: "alpha" } })).map((entry) => entry.text))
      .toEqual(["second"]);
    expect((await service.listProposals({ tag: "ops" })).map((entry) => entry.text)).toEqual(["first"]);
    expect((await service.listProposals({ limit: 1 })).map((entry) => entry.text)).toEqual(["first"]);
    expect(first.status).toBe("proposed");
  });

  it("returns a proposal by id and undefined for an unknown id", async () => {
    const proposal = await service.propose(proposalDraft);
    expect(await service.getProposal(proposal.id)).toEqual(proposal);
    expect(await service.getProposal("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/plugins/dsh-balbes-memory && npx vitest run tests/proposals.test.ts`
Expected: FAIL — `service.propose is not a function`.

- [ ] **Step 3: Create the proposal store**

Create `packages/plugins/dsh-balbes-memory/src/proposals.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  MemoryProposal,
  MemoryProposalStatus,
  MemoryOrigin,
  MemoryRecord,
  MemoryType
} from "dsh-balbes-contracts";
import { MemoryError } from "./errors.js";
import { detectSecret } from "./secrets.js";
import { normalizeProposalDraft, normalizeProposalFilter } from "./validate.js";
import {
  LIMITS,
  type MemoryDecisionPatch,
  type MemoryProposalDraft,
  type MemoryProposalFilter
} from "./types.js";

type Row = Record<string, unknown>;

/** The shared truth-table writer, owned by the service so promotion is not a bypass. */
export interface ProposalWriterDeps {
  /** Insert a memory row and its tags under the given id, inside the caller's open transaction. */
  insertMemoryRecord(
    id: string,
    input: {
      scope: MemoryRecord["scope"];
      type: MemoryType;
      text: string;
      tags: string[];
      pinned: boolean;
      origin: MemoryOrigin;
      originRef: string | null;
    }
  ): void;
  loadRecord(id: string): MemoryRecord | undefined;
}

export interface ProposalStore {
  propose(draft: MemoryProposalDraft): Promise<MemoryProposal>;
  getProposal(id: string): Promise<MemoryProposal | undefined>;
  listProposals(filter?: MemoryProposalFilter): Promise<MemoryProposal[]>;
  approve(id: string, patch?: MemoryDecisionPatch): Promise<{ proposal: MemoryProposal; record: MemoryRecord }>;
  reject(id: string): Promise<MemoryProposal>;
}

function asText(value: unknown, message: string): string {
  if (typeof value !== "string") throw new MemoryError("invalid-record", message);
  return value;
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MemoryError("invalid-record", "corrupt proposal: expected text column");
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function toScope(kind: unknown, name: unknown): MemoryRecord["scope"] {
  if (kind === "global") return { kind: "global" };
  if (kind === "project") {
    return { kind: "project", name: asText(name, "corrupt proposal: project scope without a name") };
  }
  throw new MemoryError("invalid-record", "corrupt proposal: unknown scope kind");
}

/** Tags are a JSON array column; a decode failure is corruption, not a client error. */
function decodeTags(raw: unknown): string[] {
  const text = asText(raw, "corrupt proposal: missing tags");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MemoryError("invalid-record", "corrupt proposal: tags is not JSON");
  }
  if (!Array.isArray(parsed) || !parsed.every((tag) => typeof tag === "string")) {
    throw new MemoryError("invalid-record", "corrupt proposal: tags is not a string array");
  }
  return parsed;
}

function toProposal(row: Row): MemoryProposal {
  return {
    id: asText(row.id, "corrupt proposal: missing id"),
    scope: toScope(row.scope_kind, row.scope_name),
    type: asText(row.type, "corrupt proposal: missing type") as MemoryType,
    text: asText(row.text, "corrupt proposal: missing text"),
    tags: decodeTags(row.tags),
    origin: asText(row.origin, "corrupt proposal: missing origin") as MemoryOrigin,
    originRef: asNullableText(row.origin_ref),
    status: asText(row.status, "corrupt proposal: missing status") as MemoryProposalStatus,
    proposedAt: asText(row.proposed_at, "corrupt proposal: missing proposed_at"),
    decidedAt: asNullableText(row.decided_at),
    decidedBy: asNullableText(row.decided_by),
    decidedEdit: Number(row.decided_edit) === 1,
    memoryId: asNullableText(row.memory_id)
  };
}

export function createProposalStore(db: DatabaseSync, deps: ProposalWriterDeps): ProposalStore {
  const selectById = db.prepare("SELECT * FROM memory_proposals WHERE id = ?");
  const insertProposal = db.prepare(
    "INSERT INTO memory_proposals " +
      "(id, scope_kind, scope_name, type, text, tags, origin, origin_ref, status, proposed_at, decided_at, decided_by, decided_edit, memory_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, NULL, NULL, 0, NULL)"
  );

  function load(id: string): MemoryProposal | undefined {
    const row = selectById.get(id);
    return row === undefined ? undefined : toProposal(row);
  }

  function buildClauses(filter: MemoryProposalFilter): { clauses: string[]; params: SQLInputValue[] } {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    const statuses = filter.status ?? ["proposed"];
    clauses.push("p.status IN (" + statuses.map(() => "?").join(", ") + ")");
    for (const status of statuses) params.push(status);
    if (filter.scope !== undefined) {
      if (filter.scope.kind === "global") clauses.push("p.scope_kind = 'global'");
      else {
        clauses.push("p.scope_kind = 'project' AND p.scope_name = ?");
        params.push(filter.scope.name);
      }
    }
    if (filter.type !== undefined) {
      clauses.push("p.type = ?");
      params.push(filter.type);
    }
    if (filter.tag !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(p.tags) WHERE json_each.value = ?)");
      params.push(filter.tag);
    }
    return { clauses, params };
  }

  async function propose(draft: MemoryProposalDraft): Promise<MemoryProposal> {
    const normalized = normalizeProposalDraft(draft);
    const secret = detectSecret(normalized.text);
    if (secret !== null) {
      throw new MemoryError("secret-detected", 'text matches secret rule "' + secret.rule + '"');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    insertProposal.run(
      id,
      normalized.scope.kind,
      normalized.scope.kind === "project" ? normalized.scope.name : null,
      normalized.type,
      normalized.text,
      JSON.stringify(normalized.tags),
      "agent",
      normalized.originRef,
      now
    );
    const proposal = load(id);
    if (proposal === undefined) throw new MemoryError("not-found", "proposal vanished after insert: " + id);
    return proposal;
  }

  async function listProposals(rawFilter?: MemoryProposalFilter): Promise<MemoryProposal[]> {
    const filter = normalizeProposalFilter(rawFilter);
    const { clauses, params } = buildClauses(filter);
    const limit = clamp(filter.limit ?? LIMITS.defaultListLimit, 1, LIMITS.maxListLimit);
    const offset = filter.offset ?? 0;
    const rows = db
      .prepare(
        "SELECT p.* FROM memory_proposals p WHERE " + clauses.join(" AND ") +
          " ORDER BY p.proposed_at ASC, p.id ASC LIMIT ? OFFSET ?"
      )
      .all(...params, limit, offset);
    return rows.map(toProposal);
  }

  async function approve(
    id: string,
    patch?: MemoryDecisionPatch
  ): Promise<{ proposal: MemoryProposal; record: MemoryRecord }> {
    throw new MemoryError("invalid-status", "approve is implemented in Task 5");
  }

  async function reject(id: string): Promise<MemoryProposal> {
    throw new MemoryError("invalid-status", "reject is implemented in Task 5");
  }

  return { propose, getProposal: async (id) => load(id), listProposals, approve, reject };
}
```

- [ ] **Step 4: Extend the service interface**

In `packages/plugins/dsh-balbes-memory/src/types.ts`, add to `BalbesMemoryService` (after `count`):

```ts
  propose(draft: MemoryProposalDraft): Promise<MemoryProposal>;
  getProposal(id: string): Promise<MemoryProposal | undefined>;
  listProposals(filter?: MemoryProposalFilter): Promise<MemoryProposal[]>;
  approve(id: string, patch?: MemoryDecisionPatch): Promise<{ proposal: MemoryProposal; record: MemoryRecord }>;
  reject(id: string): Promise<MemoryProposal>;
```

This is the task that makes `createMemoryService`'s object literal satisfy the interface, so the literal stays fully type-checked — if you find any `as BalbesMemoryService` cast left in `service.ts` (an interim workaround), delete it here.

- [ ] **Step 5: Wire the store into the service**

In `packages/plugins/dsh-balbes-memory/src/service.ts`:

- import `createProposalStore` from `./proposals.js`;
- extract the insert body of `save` into a local function so promotion and `save` share one writer:

```ts
  interface RecordInput {
    scope: MemoryRecord["scope"];
    type: MemoryType;
    text: string;
    tags: string[];
    pinned: boolean;
    origin: MemoryOrigin;
    originRef: string | null;
  }

  /** Insert one memory row plus its tags. The caller owns the transaction. */
  function insertRecordRow(id: string, input: RecordInput, now: string): void {
    insertMemory.run(
      id,
      input.scope.kind,
      input.scope.kind === "project" ? input.scope.name : null,
      input.type,
      input.text,
      input.pinned ? 1 : 0,
      input.origin,
      input.originRef,
      now,
      now
    );
    for (const tag of input.tags) insertTag.run(id, tag);
  }
```

- rewrite `save` to use it:

```ts
  async function save(draft: Parameters<BalbesMemoryService["save"]>[0]): Promise<MemoryRecord> {
    const normalized = normalizeDraft(draft);
    const secret = detectSecret(normalized.text);
    if (secret !== null) {
      throw new MemoryError("secret-detected", 'text matches secret rule "' + secret.rule + '"');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      insertRecordRow(id, normalized, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const record = load(id);
    if (record === undefined) throw new MemoryError("not-found", "memory vanished after insert: " + id);
    return record;
  }
```

- create the store and spread it into the return value:

```ts
  const proposals = createProposalStore(db, {
    insertMemoryRecord(id, input) {
      insertRecordRow(id, input, new Date().toISOString());
    },
    loadRecord: load
  });

  return { save, get, update, delete: remove, list, search, count, ...proposals };
```

- import the needed types (`MemoryOrigin`, `MemoryType`) from `./types.js`.

- [ ] **Step 6: Run the tests**

Run: `cd packages/plugins/dsh-balbes-memory && npx vitest run tests/proposals.test.ts tests/service.test.ts`
Expected: PASS for every staged-proposal case; `service.test.ts` stays fully green — the `save` refactor is behaviour-preserving. (`approve`/`reject` still throw their placeholder `invalid-status`, which Task 5 replaces.)

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/dsh-balbes-memory/src/proposals.ts packages/plugins/dsh-balbes-memory/src/types.ts \
  packages/plugins/dsh-balbes-memory/src/service.ts packages/plugins/dsh-balbes-memory/tests/proposals.test.ts
git commit -m "feat(memory): stage proposals in their own table (p10f)"
```

---

### Task 5: Promotion — `approve` and `reject`

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory/src/proposals.ts`
- Test: `packages/plugins/dsh-balbes-memory/tests/proposals.test.ts`

**Interfaces:**
- Consumes: `ProposalWriterDeps.insertMemoryRecord` / `loadRecord` (Task 4); `normalizeDecisionPatch` (Task 2).
- Produces: working `approve(id, patch?)` → `{ proposal: MemoryProposal; record: MemoryRecord }` and `reject(id)` → `MemoryProposal`.

- [ ] **Step 1: Write the failing promotion tests**

Append to `packages/plugins/dsh-balbes-memory/tests/proposals.test.ts` inside the existing `describe`:

```ts
  it("promotes a proposal on approval and preserves agent provenance", async () => {
    const proposal = await service.propose({ ...proposalDraft, tags: ["ops"] });
    const { proposal: decided, record } = await service.approve(proposal.id, { pinned: true });

    expect(decided.status).toBe("accepted");
    expect(decided.decidedEdit).toBe(false);
    expect(decided.decidedBy).toBe("owner");
    expect(decided.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(decided.memoryId).toBe(record.id);

    expect(record.text).toBe(proposalDraft.text);
    expect(record.origin).toBe("agent");
    expect(record.originRef).toBe(proposalDraft.originRef);
    expect(record.tags).toEqual(["ops"]);
    expect(record.pinned).toBe(true);
    expect(await service.get(record.id)).toEqual(record);
  });

  it("applies an edit at approval and records it as edited", async () => {
    const proposal = await service.propose(proposalDraft);
    const { proposal: decided, record } = await service.approve(proposal.id, {
      text: "deploy runs under systemd (verified)",
      type: "decision",
      tags: ["ops"]
    });
    expect(decided.decidedEdit).toBe(true);
    expect(record.text).toBe("deploy runs under systemd (verified)");
    expect(record.type).toBe("decision");
    expect(record.tags).toEqual(["ops"]);
    expect(record.origin).toBe("agent");
  });

  it("does not count identical or pinned-only patches as an edit", async () => {
    const first = await service.propose(proposalDraft);
    const identical = await service.approve(first.id, { text: proposalDraft.text });
    expect(identical.proposal.decidedEdit).toBe(false);

    const second = await service.propose(proposalDraft);
    const pinned = await service.approve(second.id, { pinned: true });
    expect(pinned.proposal.decidedEdit).toBe(false);
  });

  it("does not count a reordered tag list as an edit", async () => {
    const proposal = await service.propose({ ...proposalDraft, tags: ["alpha", "beta"] });
    const { proposal: decided, record } = await service.approve(proposal.id, { tags: ["beta", "alpha"] });

    expect(decided.decidedEdit).toBe(false);
    expect(record.tags).toEqual(["alpha", "beta"]);
    expect(proposal.tags).toEqual(["alpha", "beta"]);
  });

  it("rolls the whole promotion back when the edited text looks like a secret", async () => {
    const proposal = await service.propose(proposalDraft);
    await expect(service.approve(proposal.id, { text: "api_key: xyz" })).rejects.toMatchObject({
      code: "secret-detected"
    });
    const stillPending = await service.getProposal(proposal.id);
    expect(stillPending?.status).toBe("proposed");
    expect(stillPending?.memoryId).toBeNull();
    expect(await service.count()).toBe(0);
  });

  it("rolls the memory insert back when the promotion fails inside the transaction", async () => {
    // The secret case above throws BEFORE `BEGIN`, so on its own it would stay
    // green even if the whole transaction disappeared. This test fails inside
    // the transaction and pins the guarantee: no memory row, no decision, and
    // the connection is left usable.
    const proposal = await service.propose(proposalDraft);
    const failing = createProposalStore(db, {
      insertMemoryRecord() {
        throw new Error("insert boom");
      },
      loadRecord: () => undefined
    });
    await expect(failing.approve(proposal.id)).rejects.toThrowError("insert boom");

    expect(await service.count()).toBe(0);
    expect((await service.getProposal(proposal.id))?.status).toBe("proposed");

    // A leaked transaction would make the next decision fail.
    const { record } = await service.approve(proposal.id);
    expect(record.text).toBe(proposalDraft.text);
    expect(await service.count()).toBe(1);
  });

  it("rolls a partial memory write back when the truth-table writer fails midway", async () => {
    // Stronger than the test above: this injected writer really writes a row (as
    // `insertRecordRow` does) before throwing, so it only passes if `approve` wraps
    // the promotion in a transaction. Delete the BEGIN/COMMIT/ROLLBACK block and
    // the partial row survives, failing `count()` below. The test above cannot do
    // that — its writer throws before writing, so there is no partial state to undo.
    const proposal = await service.propose(proposalDraft);
    const failing = createProposalStore(db, {
      insertMemoryRecord(id) {
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO memories (id, scope_kind, scope_name, type, text, pinned, origin, origin_ref, created_at, updated_at) " +
            "VALUES (?, 'global', NULL, 'fact', ?, 0, 'agent', NULL, ?, ?)"
        ).run(id, proposalDraft.text, now, now);
        throw new Error("insert boom after write");
      },
      loadRecord: () => undefined
    });
    await expect(failing.approve(proposal.id)).rejects.toThrowError("insert boom after write");

    expect(await service.count()).toBe(0);
    expect((await service.getProposal(proposal.id))?.status).toBe("proposed");

    const { record } = await service.approve(proposal.id);
    expect(await service.count()).toBe(1);
    expect(record.text).toBe(proposalDraft.text);
  });

  it("keeps the audit row on rejection without creating a record", async () => {
    const proposal = await service.propose(proposalDraft);
    const decided = await service.reject(proposal.id);
    expect(decided.status).toBe("rejected");
    expect(decided.decidedBy).toBe("owner");
    expect(decided.decidedEdit).toBe(false);
    expect(decided.memoryId).toBeNull();
    expect(await service.count()).toBe(0);
    expect((await service.getProposal(proposal.id))?.status).toBe("rejected");
  });

  it("refuses a second decision and an unknown id", async () => {
    const proposal = await service.propose(proposalDraft);
    await service.reject(proposal.id);
    await expect(service.approve(proposal.id)).rejects.toMatchObject({ code: "invalid-status" });
    await expect(service.reject(proposal.id)).rejects.toMatchObject({ code: "invalid-status" });
    await expect(service.approve("nope")).rejects.toMatchObject({ code: "not-found" });
    await expect(service.reject("nope")).rejects.toMatchObject({ code: "not-found" });
  });

  it("clears memoryId when the promoted record is deleted", async () => {
    const proposal = await service.propose(proposalDraft);
    const { record } = await service.approve(proposal.id);
    expect(await service.delete(record.id)).toBe(true);
    const after = await service.getProposal(proposal.id);
    expect(after?.status).toBe("accepted");
    expect(after?.memoryId).toBeNull();
  });

  it("widens the queue to decided proposals only when status is explicit", async () => {
    // Same clock discipline as the FIFO test: the queue order is asserted
    // exactly, so `proposed_at` must not be left to millisecond luck.
    vi.useFakeTimers();
    let pending;
    let second;
    let accepted;
    try {
      vi.setSystemTime(new Date("2026-09-30T01:00:00.000Z"));
      pending = await service.propose({ ...proposalDraft, text: "still pending" });
      vi.setSystemTime(new Date("2026-09-30T01:00:05.000Z"));
      second = await service.propose({ ...proposalDraft, text: "to reject", type: "note" });
      vi.setSystemTime(new Date("2026-09-30T01:00:10.000Z"));
      accepted = await service.propose({ ...proposalDraft, text: "to accept", tags: ["ops"] });
    } finally {
      vi.useRealTimers();
    }
    await service.reject(second.id);
    await service.approve(accepted.id);

    expect((await service.listProposals()).map((entry) => entry.id)).toEqual([pending.id]);
    expect((await service.listProposals({ status: ["rejected"] })).map((entry) => entry.id)).toEqual([second.id]);
    expect((await service.listProposals({ status: ["accepted"] })).map((entry) => entry.id)).toEqual([accepted.id]);
    expect((await service.listProposals({ status: ["proposed", "accepted", "rejected"] })).map((entry) => entry.id))
      .toEqual([pending.id, second.id, accepted.id]);
    expect((await service.listProposals({ status: ["proposed", "rejected"], tag: "ops" })).length).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/plugins/dsh-balbes-memory && npx vitest run tests/proposals.test.ts`
Expected: FAIL — `approve is implemented in Task 5`.

- [ ] **Step 3: Implement promotion**

In `packages/plugins/dsh-balbes-memory/src/proposals.ts`, import `normalizeDecisionPatch` and replace the two stubs:

```ts
  const decideProposal = db.prepare(
    "UPDATE memory_proposals SET status = ?, decided_at = ?, decided_by = ?, decided_edit = ?, memory_id = ? WHERE id = ? AND status = 'proposed'"
  );

  /** Content-only edit detection: pinning is an owner action, not an edit. */
  function isContentEdit(
    proposal: MemoryProposal,
    patch: MemoryDecisionPatch
  ): boolean {
    if (patch.type !== undefined && patch.type !== proposal.type) return true;
    if (patch.text !== undefined && patch.text !== proposal.text) return true;
    if (patch.tags !== undefined) {
      // Tags are a SET in the truth table (`memory_tags` PK is (memory_id, tag)
      // and reads come back ORDER BY tag), so a reordered list is not an edit.
      const before = [...proposal.tags].sort();
      const after = [...patch.tags].sort();
      const same = before.length === after.length && before.every((tag, index) => tag === after[index]);
      if (!same) return true;
    }
    return false;
  }

  async function approve(
    id: string,
    rawPatch?: MemoryDecisionPatch
  ): Promise<{ proposal: MemoryProposal; record: MemoryRecord }> {
    const proposal = load(id);
    if (proposal === undefined) throw new MemoryError("not-found", "proposal not found: " + id);
    if (proposal.status !== "proposed") {
      throw new MemoryError("invalid-status", "proposal is already " + proposal.status + ": " + id);
    }
    const patch = normalizeDecisionPatch(rawPatch ?? {});
    const text = patch.text ?? proposal.text;
    const secret = detectSecret(text);
    if (secret !== null) {
      throw new MemoryError("secret-detected", 'text matches secret rule "' + secret.rule + '"');
    }
    const edited = isContentEdit(proposal, patch);
    const now = new Date().toISOString();
    // The id is minted here so every post-commit read works on a plain local.
    const memoryId = randomUUID();
    db.exec("BEGIN");
    try {
      deps.insertMemoryRecord(memoryId, {
        scope: proposal.scope,
        type: patch.type ?? proposal.type,
        text,
        tags: patch.tags ?? proposal.tags,
        pinned: patch.pinned ?? false,
        origin: proposal.origin,
        originRef: proposal.originRef
      });
      const result = decideProposal.run("accepted", now, "owner", edited ? 1 : 0, memoryId, id);
      if (Number(result.changes) !== 1) {
        throw new MemoryError("invalid-status", "proposal was decided concurrently: " + id);
      }
      db.exec("COMMIT");
    } catch (error) {
      // Inside the transaction: the promotion and the decision stand or fall together.
      db.exec("ROLLBACK");
      throw error;
    }
    const record = deps.loadRecord(memoryId);
    if (record === undefined) throw new MemoryError("not-found", "memory vanished after promotion: " + memoryId);
    const decided = load(id);
    if (decided === undefined) throw new MemoryError("not-found", "proposal vanished after approval: " + id);
    return { proposal: decided, record };
  }

  async function reject(id: string): Promise<MemoryProposal> {
    const proposal = load(id);
    if (proposal === undefined) throw new MemoryError("not-found", "proposal not found: " + id);
    if (proposal.status !== "proposed") {
      throw new MemoryError("invalid-status", "proposal is already " + proposal.status + ": " + id);
    }
    const result = decideProposal.run("rejected", new Date().toISOString(), "owner", 0, null, id);
    if (Number(result.changes) !== 1) {
      throw new MemoryError("invalid-status", "proposal was decided concurrently: " + id);
    }
    const decided = load(id);
    if (decided === undefined) throw new MemoryError("not-found", "proposal vanished after rejection: " + id);
    return decided;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/plugins/dsh-balbes-memory && npx vitest run`
Expected: PASS (all suites, including `search.test.ts`, `secrets.test.ts` and `index.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-memory/src/proposals.ts packages/plugins/dsh-balbes-memory/tests/proposals.test.ts
git commit -m "feat(memory): promote approved proposals into memory (p10f)"
```

---

### Task 6: Admin HTTP surface — propose and review

**Files:**
- Create: `packages/plugins/dsh-balbes-memory-admin/src/policy.ts`
- Modify: `packages/plugins/dsh-balbes-memory-admin/src/routes.ts`
- Modify: `packages/plugins/dsh-balbes-memory-admin/src/index.ts`
- Test: `packages/plugins/dsh-balbes-memory-admin/tests/index.test.ts`

**Interfaces:**
- Consumes: contracts proposal types (Task 2); the store methods (Tasks 4–5) through the structural `MemoryServiceLike` slice.
- Produces: `MEMORY_AUTONOMY_POLICY: MemoryAutonomyPolicy`; routes `/api/memory/propose`, `/api/memory/review/list`, `/api/memory/review/approve`, `/api/memory/review/reject`; `registerMemoryRoutes(http, getService, logger?)`; `invalid-status` → 400 mapping.

- [ ] **Step 1: Update and extend the fake-seat tests**

In `packages/plugins/dsh-balbes-memory-admin/tests/index.test.ts`:

- extend `fakeService` with the five proposal methods and the recorded calls:

```ts
  const proposed: MemoryProposalDraftLike[] = [];
  const reviewed: MemoryProposalFilterLike[] = [];
  const approved: Array<{ id: string; patch?: MemoryDecisionPatchLike }> = [];
  const rejected: string[] = [];
  const base: MemoryServiceLike = {
    /* existing save/update/delete/list/search stay as they are */
    async propose(draft) {
      proposed.push(draft);
      return proposal({ scope: draft.scope, type: draft.type, text: draft.text, tags: draft.tags ?? [], originRef: draft.originRef ?? null });
    },
    async getProposal() { return undefined; },
    async listProposals(filter) { if (filter !== undefined) reviewed.push(filter); return [proposal()]; },
    async approve(id, patch) {
      approved.push({ id, ...(patch === undefined ? {} : { patch }) });
      return { proposal: proposal({ id, status: "accepted", decidedAt: "2026-09-30T01:00:00.000Z", decidedBy: "owner", memoryId: "m-1" }), record: record({ id: "m-1" }) };
    },
    async reject(id) {
      rejected.push(id);
      return proposal({ id, status: "rejected", decidedAt: "2026-09-30T01:00:00.000Z", decidedBy: "owner" });
    }
  };
  return Object.assign(base, overrides, { saved, updated, deleted, searched, listed, proposed, reviewed, approved, rejected });
```

- add a `proposal()` factory next to `record()`:

```ts
function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: "p-1",
    scope: { kind: "global" },
    type: "fact",
    text: "staged fact",
    tags: [],
    origin: "agent",
    originRef: "pipeline:test",
    status: "proposed",
    proposedAt: "2026-09-30T00:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    decidedEdit: false,
    memoryId: null,
    ...overrides
  };
}
```

- update the route-registration test to expect all seven seats in order:

```ts
    expect(h.seats.map((seat) => seat.path)).toEqual([
      "/api/memory/list",
      "/api/memory/save",
      "/api/memory/delete",
      "/api/memory/propose",
      "/api/memory/review/list",
      "/api/memory/review/approve",
      "/api/memory/review/reject"
    ]);
```

- add the behaviour tests:

```ts
  it("forces agent origin and ignores body status on propose", async () => {
    const service = fakeService();
    const h = harness({ service });
    const res = await h.call("/api/memory/propose", {
      scope: { kind: "global" },
      type: "fact",
      text: "staged",
      tags: ["Ops"],
      originRef: "pipeline:test",
      origin: "owner",
      status: "accepted",
      pinned: true
    });
    expect(res.status).toBe(200);
    expect(service.proposed).toEqual([
      { scope: { kind: "global" }, type: "fact", text: "staged", tags: ["Ops"], originRef: "pipeline:test" }
    ]);
    expect((res.json as { proposal: MemoryProposal }).proposal.status).toBe("proposed");
  });

  it("rejects a propose body without scope or with a bad tags shape", async () => {
    const service = fakeService();
    const h = harness({ service });
    expect((await h.call("/api/memory/propose", { type: "fact", text: "x" })).status).toBe(400);
    expect((await h.call("/api/memory/propose", { scope: { kind: "global" }, type: "fact", text: "x", tags: "ops" })).status).toBe(400);
    expect(service.proposed).toEqual([]);
  });

  it("serves the queue with the autonomy policy", async () => {
    const service = fakeService();
    const h = harness({ service });
    const res = await h.call("/api/memory/review/list", { status: ["proposed", "rejected"], tag: "ops", limit: 5 });
    expect(res.status).toBe(200);
    expect(service.reviewed).toEqual([{ status: ["proposed", "rejected"], tag: "ops", limit: 5 }]);
    expect(res.json).toEqual({
      proposals: [proposal()],
      policy: { immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" }
    });
  });

  it("approves with a patch and rejects by id", async () => {
    const service = fakeService();
    const h = harness({ service });
    const approved = await h.call("/api/memory/review/approve", { id: "p-1", text: "edited", pinned: true });
    expect(approved.status).toBe(200);
    expect(service.approved).toEqual([{ id: "p-1", patch: { text: "edited", pinned: true } }]);
    expect((approved.json as { record: MemoryRecord }).record.id).toBe("m-1");

    const plain = await h.call("/api/memory/review/approve", { id: "p-1" });
    expect(plain.status).toBe(200);
    expect(service.approved[1]).toEqual({ id: "p-1" });

    const rejected = await h.call("/api/memory/review/reject", { id: "p-1" });
    expect(rejected.status).toBe(200);
    expect(service.rejected).toEqual(["p-1"]);
    expect((rejected.json as { proposal: MemoryProposal }).proposal.status).toBe("rejected");
  });

  it("validates decision bodies and maps invalid-status to 400", async () => {
    const h = harness({ service: fakeService() });
    expect((await h.call("/api/memory/review/approve", {})).status).toBe(400);
    expect((await h.call("/api/memory/review/reject", { id: "" })).status).toBe(400);

    const decided = fakeService({ approve: async () => { throw { code: "invalid-status", message: "already accepted" }; } });
    const h2 = harness({ service: decided });
    const res = await h2.call("/api/memory/review/approve", { id: "p-1" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: { code: "invalid-status", message: "already accepted" } });
  });

  it("answers 503 memory-unavailable on every review route", async () => {
    const h = harness({ service: undefined });
    for (const path of ["/api/memory/propose", "/api/memory/review/list", "/api/memory/review/approve", "/api/memory/review/reject"]) {
      const res = await h.call(path, { id: "p-1", scope: { kind: "global" }, type: "fact", text: "x" });
      expect(res.status, path).toBe(503);
      expect((res.json as { error: { code: string } }).error.code).toBe("memory-unavailable");
    }
  });
```

Also import the new types (`MemoryAutonomyPolicy`, `MemoryProposal`) and the route slice types (`MemoryDecisionPatchLike`, `MemoryProposalDraftLike`, `MemoryProposalFilterLike`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/plugins/dsh-balbes-memory-admin && npx vitest run tests/index.test.ts`
Expected: FAIL — no seat is registered for `/api/memory/propose`.

- [ ] **Step 3: Create the policy constant**

Create `packages/plugins/dsh-balbes-memory-admin/src/policy.ts`:

```ts
import type { MemoryAutonomyPolicy } from "dsh-balbes-contracts";

/**
 * The v1 autonomy policy, served to the owner instead of being hardcoded in the
 * UI. It describes behaviour that is enforced structurally: `save` (owner) and
 * `remember` write truth immediately, `propose` always stages, and there is no
 * auto-approval path at all.
 */
export const MEMORY_AUTONOMY_POLICY: MemoryAutonomyPolicy = {
  immediate: ["owner", "remember"],
  review: ["pipeline"],
  autoApprove: "none"
};
```

- [ ] **Step 4: Add the routes**

In `packages/plugins/dsh-balbes-memory-admin/src/routes.ts`:

- extend the imports from `dsh-balbes-contracts` with `MemoryProposal`, `MemoryProposalStatus`;
- import `MEMORY_AUTONOMY_POLICY` from `./policy.js`;
- add `"invalid-status": 400` to `SERVICE_ERROR_STATUS`;
- extend `MemoryServiceLike`:

```ts
export interface MemoryProposalDraftLike {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  originRef?: string;
}

export interface MemoryProposalFilterLike {
  scope?: MemoryScope;
  type?: MemoryType;
  tag?: string;
  status?: MemoryProposalStatus[];
  limit?: number;
  offset?: number;
}

export interface MemoryDecisionPatchLike {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
}

export interface MemoryServiceLike {
  /* existing methods stay unchanged */
  propose(draft: MemoryProposalDraftLike): Promise<MemoryProposal>;
  getProposal(id: string): Promise<MemoryProposal | undefined>;
  listProposals(filter?: MemoryProposalFilterLike): Promise<MemoryProposal[]>;
  approve(id: string, patch?: MemoryDecisionPatchLike): Promise<{ proposal: MemoryProposal; record: MemoryRecord }>;
  reject(id: string): Promise<MemoryProposal>;
}
```

- change the registration signature and return-payload helper:

```ts
export interface RoutesLogger {
  info?(message: string): void;
}

export function registerMemoryRoutes(
  http: HttpSeatLike,
  getService: () => MemoryServiceLike | undefined,
  logger?: RoutesLogger
): void {
```

- add the parsers:

```ts
type ParsedPropose = { ok: true; draft: MemoryProposalDraftLike } | { ok: false; message: string };

function parsePropose(body: unknown): ParsedPropose {
  if (!isObject(body)) return { ok: false, message: "request body must be a JSON object" };
  if (typeof body.type !== "string" || body.type === "") return { ok: false, message: "type is required" };
  if (typeof body.text !== "string") return { ok: false, message: "text is required" };
  if (body.scope === undefined) return { ok: false, message: "scope is required" };
  const scope = parseScope(body.scope);
  if (!scope.ok) return scope;
  if (body.tags !== undefined && !(Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === "string"))) {
    return { ok: false, message: "tags must be an array of strings" };
  }
  if (body.originRef !== undefined && typeof body.originRef !== "string") {
    return { ok: false, message: "originRef must be a string" };
  }
  return {
    ok: true,
    draft: {
      scope: scope.scope,
      type: body.type as MemoryType,
      text: body.text,
      ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
      ...(typeof body.originRef === "string" ? { originRef: body.originRef } : {})
    }
  };
}

type ParsedReviewList = { ok: true; filter?: MemoryProposalFilterLike } | { ok: false; message: string };

function parseReviewList(body: unknown): ParsedReviewList {
  if (!isObject(body)) return { ok: false, message: "request body must be a JSON object" };
  const filter: MemoryProposalFilterLike = {};
  if (body.scope !== undefined) {
    const parsed = parseScope(body.scope);
    if (!parsed.ok) return parsed;
    filter.scope = parsed.scope;
  }
  if (body.type !== undefined) {
    if (typeof body.type !== "string") return { ok: false, message: "type must be a string" };
    filter.type = body.type as MemoryType;
  }
  if (body.tag !== undefined) {
    if (typeof body.tag !== "string") return { ok: false, message: "tag must be a string" };
    filter.tag = body.tag;
  }
  if (body.status !== undefined) {
    if (!Array.isArray(body.status) || !body.status.every((status) => typeof status === "string")) {
      return { ok: false, message: "status must be an array of strings" };
    }
    filter.status = body.status as MemoryProposalStatus[];
  }
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number") return { ok: false, message: "limit must be a number" };
    filter.limit = body.limit;
  }
  if (body.offset !== undefined) {
    if (typeof body.offset !== "number") return { ok: false, message: "offset must be a number" };
    filter.offset = body.offset;
  }
  return { ok: true, ...(Object.keys(filter).length === 0 ? {} : { filter }) };
}

type ParsedDecision = { ok: true; id: string; patch?: MemoryDecisionPatchLike } | { ok: false; message: string };

function parseDecision(body: unknown, withPatch: boolean): ParsedDecision {
  if (!isObject(body)) return { ok: false, message: "request body must be a JSON object" };
  if (typeof body.id !== "string" || body.id === "") return { ok: false, message: "id must be a non-empty string" };
  if (!withPatch) return { ok: true, id: body.id };
  const patch: MemoryDecisionPatchLike = {};
  if (body.type !== undefined) {
    if (typeof body.type !== "string") return { ok: false, message: "type must be a string" };
    patch.type = body.type as MemoryType;
  }
  if (body.text !== undefined) {
    if (typeof body.text !== "string") return { ok: false, message: "text must be a string" };
    patch.text = body.text;
  }
  if (body.tags !== undefined) {
    if (!(Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === "string"))) {
      return { ok: false, message: "tags must be an array of strings" };
    }
    patch.tags = body.tags as string[];
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean") return { ok: false, message: "pinned must be a boolean" };
    patch.pinned = body.pinned;
  }
  return { ok: true, id: body.id, ...(Object.keys(patch).length === 0 ? {} : { patch }) };
}

function scopeTag(scope: MemoryScope): string {
  return scope.kind === "global" ? "global" : "project:" + scope.name;
}
```

- register the four routes at the end of `registerMemoryRoutes`:

```ts
  http.post("/api/memory/propose", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parsePropose(body);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      const proposal = await service.propose(parsed.draft);
      logger?.info?.("balbes-memory-admin: propose id=" + proposal.id + " scope=" + scopeTag(proposal.scope));
      send(res, 200, { proposal });
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/review/list", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parseReviewList(body);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      const proposals = await service.listProposals(parsed.filter);
      send(res, 200, { proposals, policy: MEMORY_AUTONOMY_POLICY });
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/review/approve", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parseDecision(body, true);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      const result = await service.approve(parsed.id, parsed.patch);
      logger?.info?.("balbes-memory-admin: approve id=" + parsed.id + " edited=" + String(result.proposal.decidedEdit));
      send(res, 200, { proposal: result.proposal, record: result.record });
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/review/reject", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parseDecision(body, false);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      const proposal = await service.reject(parsed.id);
      logger?.info?.("balbes-memory-admin: reject id=" + proposal.id);
      send(res, 200, { proposal });
    } catch (error) {
      sendServiceError(res, error);
    }
  });
```

In `packages/plugins/dsh-balbes-memory-admin/src/index.ts`, pass the logger through:

```ts
  registerMemoryRoutes(http, () => ctx.get("balbesMemory") as MemoryServiceLike | undefined, ctx.logger);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/plugins/dsh-balbes-memory-admin && npx vitest run tests/index.test.ts` then `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-admin/src/policy.ts packages/plugins/dsh-balbes-memory-admin/src/routes.ts \
  packages/plugins/dsh-balbes-memory-admin/src/index.ts packages/plugins/dsh-balbes-memory-admin/tests/index.test.ts
git commit -m "feat(memory-admin): add propose and review routes (p10f)"
```

---

### Task 7: REAL composition — admin review over HTTP

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-admin/tests/integration.test.ts`

**Interfaces:**
- Consumes: all four routes (Task 6) and the store (Tasks 4–5), booted through the real Loader with the fixture profile `balbes-memory-admin-test`.
- Produces: end-to-end proof that proposals stay out of `memory.list` until approved, that the policy travels with the queue, and that a second decision is rejected.

- [ ] **Step 1: Write the failing REAL test**

Append inside the existing `describe.skipIf(!realEnabled)` block:

```ts
  it("proposes, reviews and approves without leaking proposals into memory", async () => {
    // No hyphens: /api/memory/list feeds `query` into FTS5 MATCH verbatim and a
    // bare hyphenated token is parsed as query syntax (the runbook's memory smoke
    // says the same).
    const marker = "p10freviewmarker4c19";

    const proposed = await api("/api/memory/propose", {
      scope: { kind: "global" },
      type: "fact",
      text: "proposed fact " + marker,
      tags: ["Smoke"],
      originRef: "pipeline:real-test",
      // A hostile body must not be able to claim ownership or decide the proposal.
      origin: "owner",
      status: "accepted",
      pinned: true
    });
    expect(proposed.status, proposed.raw).toBe(200);
    const proposal = (proposed.json as { proposal: MemoryProposal }).proposal;
    expect(proposal.status).toBe("proposed");
    expect(proposal.origin).toBe("agent");
    expect(proposal.tags).toEqual(["smoke"]);
    // The proposal contract has no pinning field at all: the pipeline cannot stage one.
    expect((proposal as unknown as Record<string, unknown>).pinned).toBeUndefined();
    expect(proposal.decidedAt).toBeNull();
    expect(proposal.memoryId).toBeNull();

    const hidden = await api("/api/memory/list", { query: marker });
    expect(hidden.status, hidden.raw).toBe(200);
    expect((hidden.json as { records: unknown[] }).records).toEqual([]);

    const queue = await api("/api/memory/review/list", {});
    expect(queue.status, queue.raw).toBe(200);
    const queueJson = queue.json as { proposals: MemoryProposal[]; policy: MemoryAutonomyPolicy };
    expect(queueJson.proposals.some((entry) => entry.id === proposal.id)).toBe(true);
    expect(queueJson.policy).toEqual({ immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" });

    const approved = await api("/api/memory/review/approve", { id: proposal.id, text: "approved fact " + marker });
    expect(approved.status, approved.raw).toBe(200);
    const decided = approved.json as { proposal: MemoryProposal; record: MemoryRecord };
    expect(decided.proposal.status).toBe("accepted");
    expect(decided.proposal.decidedBy).toBe("owner");
    expect(decided.proposal.decidedEdit).toBe(true);
    expect(decided.proposal.memoryId).toBe(decided.record.id);
    expect(decided.record.origin).toBe("agent");
    expect(decided.record.originRef).toBe("pipeline:real-test");
    expect(decided.record.tags).toEqual(["smoke"]);

    const visible = await api("/api/memory/list", { query: marker });
    expect((visible.json as { records: Array<{ id: string }> }).records.some((row) => row.id === decided.record.id)).toBe(true);

    const decidedAgain = await api("/api/memory/review/approve", { id: proposal.id });
    expect(decidedAgain.status).toBe(400);
    expect((decidedAgain.json as { error: { code: string } }).error.code).toBe("invalid-status");

    const cleanup = await api("/api/memory/delete", { id: decided.record.id });
    expect(cleanup.status, cleanup.raw).toBe(200);
    expect(cleanup.json).toEqual({ deleted: true });
  });

  it("rejects a proposal, keeps it out of memory and refuses secrets", async () => {
    const marker = "p10frejectmarker8a02";
    const proposed = await api("/api/memory/propose", { scope: { kind: "global" }, type: "note", text: "rejected fact " + marker });
    const id = (proposed.json as { proposal: { id: string } }).proposal.id;

    const rejected = await api("/api/memory/review/reject", { id });
    expect(rejected.status, rejected.raw).toBe(200);
    expect((rejected.json as { proposal: MemoryProposal }).proposal.status).toBe("rejected");
    const listed = await api("/api/memory/list", { query: marker });
    expect((listed.json as { records: unknown[] }).records).toEqual([]);

    const decided = await api("/api/memory/review/list", { status: ["rejected"] });
    expect((decided.json as { proposals: MemoryProposal[] }).proposals.some((entry) => entry.id === id)).toBe(true);

    const secret = await api("/api/memory/propose", {
      scope: { kind: "global" },
      type: "note",
      text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    });
    expect(secret.status).toBe(400);
    expect((secret.json as { error: { code: string } }).error.code).toBe("secret-detected");
  });
```

Add `import type { MemoryAutonomyPolicy, MemoryProposal, MemoryRecord } from "dsh-balbes-contracts";` at the top of the file.

- [ ] **Step 2: Run the REAL suite to verify it passes**

Run: `cd packages/plugins/dsh-balbes-memory-admin && RUN_REAL=1 npx vitest run tests/integration.test.ts`
Expected: PASS (requires `dsh` on `PATH`; if `dsh` is missing the suite is skipped — report that honestly rather than claiming a pass).

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-admin/tests/integration.test.ts
git commit -m "test(memory-admin): prove the review flow over the real composition (p10f)"
```

---

### Task 8: REAL composition — proposals never reach the model

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts`

**Interfaces:**
- Consumes: `POST /api/memory/propose` and `POST /api/memory/review/approve` (Task 6); the existing stub-LLM harness and fixture profile `balbes-memory-context-test` (which already loads `balbes-memory-admin`).
- Produces: proof that a pending proposal appears in no request body sent to the model (system prompt, messages or tool payloads) and appears after approval.

- [ ] **Step 1: Add the isolation block to the existing delivery test**

Append inside `it("delivers the pinned core, the task-relevant push and the recall tool", ...)`, after the `remember` assertions:

```ts
      // p10f: a staged proposal is not knowledge until the owner approves it.
      const proposalMarker = "p10fproposalmarker6e40";
      const proposalRes = await postJson(
        base + "/api/memory/propose",
        {
          scope: { kind: "global" },
          type: "fact",
          text: "Pending " + proposalMarker + " must not be delivered before review",
          originRef: "pipeline:real-test"
        },
        token
      );
      expect(proposalRes.status, proposalRes.raw).toBe(200);
      const proposalId = (proposalRes.json as { proposal: { id: string } }).proposal.id;

      stub.setScript([{ text: "pending run" }]);
      const beforePending = stub.calls.length;
      const pendingRun = await postJson(base + "/api/prompt", { prompt: "anything about pending" }, token);
      expect(pendingRun.status, pendingRun.raw).toBe(200);
      const pendingBodies = JSON.stringify(stub.calls.slice(beforePending).map((call) => call.body));
      expect(pendingBodies, pendingBodies.slice(0, 4000)).not.toContain(proposalMarker);

      const approveRes = await postJson(base + "/api/memory/review/approve", { id: proposalId }, token);
      expect(approveRes.status, approveRes.raw).toBe(200);

      stub.setScript([{ text: "approved run" }]);
      const beforeApproved = stub.calls.length;
      const approvedRun = await postJson(base + "/api/prompt", { prompt: "anything about pending" }, token);
      expect(approvedRun.status, approvedRun.raw).toBe(200);
      const approvedBodies = JSON.stringify(stub.calls.slice(beforeApproved).map((call) => call.body));
      expect(approvedBodies, approvedBodies.slice(0, 4000)).toContain(proposalMarker);
```

The marker sits inside the 100-character map preview (it starts at offset 8), so the positive assertion exercises the map path, not only the push path.

- [ ] **Step 2: Run the REAL suite to verify it passes**

Run: `cd packages/plugins/dsh-balbes-memory-context && RUN_REAL=1 npx vitest run tests/integration.test.ts`
Expected: PASS; skipped when `dsh` is absent.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts
git commit -m "test(memory-context): prove staged proposals never reach the model (p10f)"
```

---

### Task 9: Admin API client and the review queue component

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/api/client.ts`
- Create: `packages/frontend/dsh-balbes-admin/src/pages/memoryShared.ts`
- Create: `packages/frontend/dsh-balbes-admin/src/pages/MemoryReviewQueue.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/styles.css`
- Test: `packages/frontend/dsh-balbes-admin/tests/MemoryReviewQueue.test.tsx` (new)

**Interfaces:**
- Consumes: `MemoryReviewListRequest/Response`, `MemoryReviewApproveRequest/Response`, `MemoryReviewRejectRequest/Response`, `MemoryProposal`, `MemoryAutonomyPolicy` (Task 2).
- Produces: `AdminApi.listMemoryReview`, `AdminApi.approveMemoryReview`, `AdminApi.rejectMemoryReview`; `memoryShared.ts` exporting `MEMORY_TYPES`, `TYPE_LABELS`, `MemoryLevel`, `LevelSelection`, `levelKey`, `levelLabel`, `parseScope`, `parseTags`, `formatTime`; the default-exported `MemoryReviewQueue({ api })` component used by Task 10.

- [ ] **Step 1: Write the failing component test**

Create `packages/frontend/dsh-balbes-admin/tests/MemoryReviewQueue.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MemoryReviewQueue from "../src/pages/MemoryReviewQueue";
import type { AdminApi } from "../src/api/client";
import type {
  MemoryAutonomyPolicy,
  MemoryProposal,
  MemoryReviewApproveRequest,
  MemoryReviewListRequest,
  MemoryReviewListResponse,
  MemoryRecord
} from "dsh-balbes-contracts";

afterEach(cleanup);

const POLICY: MemoryAutonomyPolicy = { immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" };

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: "p-1",
    scope: { kind: "global" },
    type: "fact",
    text: "staged fact",
    tags: ["x"],
    origin: "agent",
    originRef: "pipeline:extraction admin session:s1",
    status: "proposed",
    proposedAt: "2026-09-30T00:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    decidedEdit: false,
    memoryId: null,
    ...overrides
  };
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m-1",
    scope: { kind: "global" },
    type: "fact",
    text: "staged fact",
    tags: ["x"],
    pinned: false,
    origin: "agent",
    originRef: "pipeline:extraction admin session:s1",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides
  };
}

function makeApi(list: MemoryReviewListResponse, overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listWorkspaces: vi.fn(async () => ({ home: { path: "/h/agent" }, projects: [{ name: "alpha", path: "/p/alpha" }] })),
    listMemoryReview: vi.fn(async (_req: MemoryReviewListRequest) => list),
    approveMemoryReview: vi.fn(async (req: MemoryReviewApproveRequest) => ({
      proposal: proposal({ id: req.id, status: "accepted", decidedAt: "2026-09-30T01:00:00.000Z", decidedBy: "owner", decidedEdit: req.text !== undefined, memoryId: "m-1" }),
      record: record({ id: "m-1", text: req.text ?? "staged fact" })
    })),
    rejectMemoryReview: vi.fn(async (req: { id: string }) => ({
      proposal: proposal({ id: req.id, status: "rejected", decidedAt: "2026-09-30T01:00:00.000Z", decidedBy: "owner" })
    })),
    ...overrides
  } as unknown as AdminApi;
}

describe("MemoryReviewQueue", () => {
  it("renders the policy line, provenance and the empty state", async () => {
    render(<MemoryReviewQueue api={makeApi({ proposals: [], policy: POLICY })} />);
    expect(await screen.findByTestId("memory-review-empty")).toBeTruthy();
    expect(screen.getByTestId("memory-review-policy").textContent).toContain("remember");
  });

  it("approves a proposal as-is", async () => {
    const api = makeApi({ proposals: [proposal()], policy: POLICY });
    render(<MemoryReviewQueue api={api} />);
    fireEvent.click(await screen.findByTestId("memory-review-approve:p-1"));
    fireEvent.click(await screen.findByTestId("memory-review-form-approve"));
    await waitFor(() => expect(api.approveMemoryReview).toHaveBeenCalledWith({ id: "p-1" }));
  });

  it("sends only the changed fields when the owner edits before approving", async () => {
    const api = makeApi({ proposals: [proposal()], policy: POLICY });
    render(<MemoryReviewQueue api={api} />);
    fireEvent.click(await screen.findByTestId("memory-review-approve:p-1"));
    fireEvent.change(screen.getByTestId("memory-review-form-text"), { target: { value: "edited fact" } });
    fireEvent.click(screen.getByTestId("memory-review-form-approve"));
    await waitFor(() => expect(api.approveMemoryReview).toHaveBeenCalledWith({ id: "p-1", text: "edited fact" }));
  });

  it("rejects after confirmation and refreshes the queue", async () => {
    const api = makeApi({ proposals: [proposal()], policy: POLICY });
    render(<MemoryReviewQueue api={api} />);
    fireEvent.click(await screen.findByTestId("memory-review-reject:p-1"));
    fireEvent.click(await screen.findByTestId("memory-review-reject-confirm"));
    await waitFor(() => expect(api.rejectMemoryReview).toHaveBeenCalledWith({ id: "p-1" }));
    expect(api.listMemoryReview).toHaveBeenCalledTimes(2);
  });

  it("shows decided proposals with their verdict when the toggle is on", async () => {
    const decided = proposal({ id: "p-2", status: "rejected", decidedAt: "2026-09-30T02:00:00.000Z", decidedBy: "owner" });
    const api = makeApi({ proposals: [decided], policy: POLICY });
    render(<MemoryReviewQueue api={api} />);
    fireEvent.click(await screen.findByTestId("memory-review-decided-toggle"));
    await waitFor(() =>
      expect(api.listMemoryReview).toHaveBeenCalledWith(expect.objectContaining({ status: ["accepted", "rejected"] }))
    );
    expect(await screen.findByTestId("memory-review-status:p-2")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/frontend/dsh-balbes-admin && npx vitest run tests/MemoryReviewQueue.test.tsx`
Expected: FAIL — cannot resolve `../src/pages/MemoryReviewQueue`.

- [ ] **Step 3: Extend the API client**

In `packages/frontend/dsh-balbes-admin/src/api/client.ts`:

- add to the `dsh-balbes-contracts` type import block: `MemoryReviewApproveRequest`, `MemoryReviewApproveResponse`, `MemoryReviewListRequest`, `MemoryReviewListResponse`, `MemoryReviewRejectRequest`, `MemoryReviewRejectResponse`;
- add to the `AdminApi` interface next to `deleteMemory`:

```ts
  listMemoryReview(req: MemoryReviewListRequest): Promise<MemoryReviewListResponse>;
  approveMemoryReview(req: MemoryReviewApproveRequest): Promise<MemoryReviewApproveResponse>;
  rejectMemoryReview(req: MemoryReviewRejectRequest): Promise<MemoryReviewRejectResponse>;
```

- add to the returned object next to `deleteMemory`:

```ts
    listMemoryReview: (req) => guard(request<MemoryReviewListResponse>("/api/memory/review/list", req satisfies MemoryReviewListRequest)),
    approveMemoryReview: (req) => guard(request<MemoryReviewApproveResponse>("/api/memory/review/approve", req satisfies MemoryReviewApproveRequest)),
    rejectMemoryReview: (req) => guard(request<MemoryReviewRejectResponse>("/api/memory/review/reject", req satisfies MemoryReviewRejectRequest)),
```

- [ ] **Step 4: Extract the shared page helpers**

Create `packages/frontend/dsh-balbes-admin/src/pages/memoryShared.ts` by moving these helpers out of `MemoryPage.tsx` verbatim (Task 10 deletes the local copies and imports from here, so both memory surfaces share one implementation instead of duplicating it):

```ts
import type { MemoryScope, MemoryType } from "dsh-balbes-contracts";

export const MEMORY_TYPES: MemoryType[] = ["fact", "preference", "decision", "note"];

export const TYPE_LABELS: Record<MemoryType, string> = {
  fact: "факт",
  preference: "предпочтение",
  decision: "решение",
  note: "заметка"
};

export type MemoryLevel = MemoryScope;
/** A concrete level, or the «Все» pseudo-level listing every scope. */
export type LevelSelection = MemoryLevel | { kind: "all" };

export function levelKey(level: LevelSelection): string {
  if (level.kind === "all") return "all";
  return level.kind === "global" ? "global" : "project:" + level.name;
}

export function levelLabel(level: MemoryLevel): string {
  return level.kind === "global" ? "Дом" : level.name;
}

/** Parses a concrete level option value; «Все» is not a concrete level. */
export function parseScope(value: string): MemoryLevel {
  return value === "global" ? { kind: "global" } : { kind: "project", name: value.slice("project:".length) };
}

export function parseTags(raw: string): string[] {
  return raw.split(/[\s,]+/).map((tag) => tag.trim()).filter((tag) => tag !== "");
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ru-RU");
}
```

- [ ] **Step 5: Create the queue component**

Create `packages/frontend/dsh-balbes-admin/src/pages/MemoryReviewQueue.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { ApiError, type AdminApi } from "../api/client";
import type { MemoryAutonomyPolicy, MemoryProposal, MemoryType, WorkspaceProject } from "dsh-balbes-contracts";
import Modal from "../components/Modal";
import {
  MEMORY_TYPES,
  TYPE_LABELS,
  formatTime,
  levelKey,
  levelLabel,
  parseScope,
  parseTags,
  type LevelSelection
} from "./memoryShared";

const STATUS_LABELS: Record<MemoryProposal["status"], string> = {
  proposed: "ожидает",
  accepted: "принято",
  rejected: "отклонено"
};

function policyLine(policy: MemoryAutonomyPolicy): string {
  const immediate = policy.immediate.map((source) => (source === "owner" ? "владелец" : "явный remember")).join(" и ");
  const review = policy.review.map((source) => (source === "pipeline" ? "предложения пайплайна" : source)).join(", ");
  const auto = policy.autoApprove === "none" ? " Автоодобрения нет." : "";
  return "Политика: " + immediate + " пишут сразу; " + review + " — через ревью." + auto;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "secret-detected") return "текст похож на секрет — правка отклонена";
    if (error.code === "invalid-status") return "Предложение уже решено — очередь обновлена";
    if (error.code === "memory-unavailable") return "Память недоступна";
    return error.message;
  }
  return error instanceof Error ? error.message : "неизвестная ошибка";
}

export default function MemoryReviewQueue({
  api,
  onPendingCount
}: {
  api: AdminApi;
  /**
   * Reports how many proposals are waiting whenever the load used the default
   * (pending) filter. The canon puts a pending counter on the tab label, and the
   * queue is the only place that fetches the queue — the page must not fetch twice.
   */
  onPendingCount?: (count: number) => void;
}) {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [level, setLevel] = useState<LevelSelection>({ kind: "global" });
  const [type, setType] = useState<MemoryType | "all">("all");
  const [tag, setTag] = useState("");
  const [showDecided, setShowDecided] = useState(false);
  const [proposals, setProposals] = useState<MemoryProposal[] | null>(null);
  const [policy, setPolicy] = useState<MemoryAutonomyPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MemoryProposal | null>(null);
  const [toReject, setToReject] = useState<MemoryProposal | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formType, setFormType] = useState<MemoryType>("note");
  const [formText, setFormText] = useState("");
  const [formTags, setFormTags] = useState("");
  const [formPinned, setFormPinned] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const res = await api.listMemoryReview({
        ...(level.kind === "all" ? {} : { scope: level }),
        ...(type === "all" ? {} : { type }),
        ...(tag.trim() === "" ? {} : { tag: tag.trim() }),
        ...(showDecided ? { status: ["accepted", "rejected"] as MemoryProposal["status"][] } : {})
      });
      setProposals(res.proposals);
      setPolicy(res.policy);
      if (!showDecided) onPendingCount?.(res.proposals.length);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [api, level, type, tag, showDecided, onPendingCount]);

  useEffect(() => {
    let cancelled = false;
    void api
      .listWorkspaces()
      .then((res) => { if (!cancelled) setProjects(res.projects); })
      .catch(() => { /* the level falls back to «Дом» */ });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (level.kind !== "project") return;
    if (!projects.some((project) => project.name === level.name)) setLevel({ kind: "global" });
  }, [projects, level]);

  useEffect(() => { void load(); }, [load]);

  function openApprove(entry: MemoryProposal): void {
    setFormType(entry.type);
    setFormText(entry.text);
    setFormTags(entry.tags.join(", "));
    setFormPinned(false);
    setFormError(null);
    setEditing(entry);
  }

  async function confirmApprove(): Promise<void> {
    if (editing === null || busy) return;
    if (formText.trim() === "") { setFormError("Текст не может быть пустым"); return; }
    // Send only what changed: the server derives decidedEdit from the diff.
    const tags = parseTags(formTags);
    const patch: { id: string; type?: MemoryType; text?: string; tags?: string[]; pinned?: boolean } = { id: editing.id };
    if (formType !== editing.type) patch.type = formType;
    if (formText.trim() !== editing.text) patch.text = formText;
    if (tags.join(",") !== editing.tags.join(",")) patch.tags = tags;
    if (formPinned) patch.pinned = true;

    setBusy(true);
    setFormError(null);
    try {
      await api.approveMemoryReview(patch);
      setEditing(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.code === "invalid-status")) {
        setEditing(null);
        await load();
      } else {
        setFormError(messageOf(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmReject(): Promise<void> {
    if (toReject === null || busy) return;
    setBusy(true);
    try {
      await api.rejectMemoryReview({ id: toReject.id });
      setToReject(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.code === "invalid-status")) {
        setToReject(null);
        await load();
      } else {
        setLoadError(messageOf(error));
      }
    } finally {
      setBusy(false);
    }
  }

  const filtersActive = type !== "all" || tag.trim() !== "";

  return (
    <div className="memory-review" data-testid="memory-review">
      {policy !== null && (
        <p className="memory-review-policy" data-testid="memory-review-policy">{policyLine(policy)}</p>
      )}

      <div className="memory-toolbar">
        <select
          className="memory-level"
          aria-label="Уровень предложения"
          data-testid="memory-review-level"
          value={levelKey(level)}
          onChange={(event) => {
            const value = event.target.value;
            setLevel(value === "all" ? { kind: "all" } : parseScope(value));
          }}
        >
          <option value="global">Дом</option>
          {projects.map((project) => (
            <option key={project.name} value={"project:" + project.name}>{project.name}</option>
          ))}
          <option value="all">Все</option>
        </select>

        <select
          className="memory-type-filter"
          aria-label="Тип предложения"
          data-testid="memory-review-type"
          value={type}
          onChange={(event) => setType(event.target.value as MemoryType | "all")}
        >
          <option value="all">Все типы</option>
          {MEMORY_TYPES.map((value) => <option key={value} value={value}>{TYPE_LABELS[value]}</option>)}
        </select>

        <input
          className="ws-name-input memory-tag-filter"
          aria-label="Тег предложения"
          data-testid="memory-review-tag"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder="тег"
        />

        <label className="memory-pinned-toggle">
          <input
            type="checkbox"
            data-testid="memory-review-decided-toggle"
            checked={showDecided}
            onChange={(event) => setShowDecided(event.target.checked)}
          />
          Показать решённые
        </label>

        <button type="button" className="btn-ghost" onClick={() => void load()} data-testid="memory-review-refresh">Обновить</button>
      </div>

      {proposals === null ? (
        <div className="ws-center-state">
          {loadError !== null ? (
            <>
              <p className="form-error" role="alert" data-testid="memory-review-load-error">{loadError}</p>
              <button type="button" className="btn" onClick={() => void load()} data-testid="memory-review-retry">Повторить</button>
            </>
          ) : (
            <p className="ws-placeholder">Загрузка...</p>
          )}
        </div>
      ) : loadError !== null ? (
        <div className="ws-center-state">
          <p className="form-error" role="alert" data-testid="memory-review-load-error">{loadError}</p>
          <button type="button" className="btn" onClick={() => void load()} data-testid="memory-review-retry">Повторить</button>
        </div>
      ) : proposals.length === 0 ? (
        <p className="ws-placeholder" data-testid={showDecided || filtersActive ? "memory-review-no-results" : "memory-review-empty"}>
          {showDecided ? "Решённых предложений нет" : filtersActive ? "Ничего не найдено" : "Очередь пуста — предложений нет"}
        </p>
      ) : (
        <ul className="memory-list" data-testid="memory-review-list">
          {proposals.map((entry) => (
            <li className="memory-row" key={entry.id} data-testid={"memory-review-row:" + entry.id}>
              <div className="memory-row-head">
                <span className="memory-type">{TYPE_LABELS[entry.type]}</span>
                <span className="memory-level-badge" data-testid="memory-review-row-level">{levelLabel(entry.scope)}</span>
                <span
                  className={"memory-review-status memory-review-status-" + entry.status}
                  data-testid={"memory-review-status:" + entry.id}
                >
                  {STATUS_LABELS[entry.status]}
                  {entry.decidedEdit ? " (с правкой)" : ""}
                </span>
                <span className="memory-provenance">
                  предложено пайплайном · {entry.originRef ?? "без источника"} · {formatTime(entry.decidedAt ?? entry.proposedAt)}
                </span>
                {entry.status === "proposed" && (
                  <span className="memory-row-actions">
                    <button type="button" className="btn" onClick={() => openApprove(entry)} data-testid={"memory-review-approve:" + entry.id}>Одобрить</button>
                    <button type="button" className="btn-danger" onClick={() => setToReject(entry)} data-testid={"memory-review-reject:" + entry.id}>Отклонить</button>
                  </span>
                )}
              </div>
              <p className="memory-row-text">{entry.text}</p>
              {entry.tags.length > 0 && (
                <div className="memory-tags">
                  {entry.tags.map((value) => <span className="memory-tag" key={value}>{value}</span>)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing !== null && (
        <Modal title="Одобрить предложение" onClose={() => setEditing(null)}>
          <p className="memory-scope-line">Уровень: <b>{levelLabel(editing.scope)}</b> (задаёт предложение)</p>
          <p className="memory-scope-line">Источник: <b>{editing.originRef ?? "не указан"}</b></p>
          <select
            className="memory-type-select"
            aria-label="Тип записи"
            data-testid="memory-review-form-type"
            value={formType}
            onChange={(event) => setFormType(event.target.value as MemoryType)}
          >
            {MEMORY_TYPES.map((value) => <option key={value} value={value}>{TYPE_LABELS[value]}</option>)}
          </select>
          <textarea
            className="memory-form-text"
            aria-label="Текст записи"
            data-testid="memory-review-form-text"
            value={formText}
            onChange={(event) => setFormText(event.target.value)}
            rows={5}
          />
          <input
            className="ws-name-input"
            aria-label="Теги"
            data-testid="memory-review-form-tags"
            value={formTags}
            onChange={(event) => setFormTags(event.target.value)}
            placeholder="теги через запятую"
          />
          <label className="memory-pinned-toggle">
            <input
              type="checkbox"
              data-testid="memory-review-form-pinned"
              checked={formPinned}
              onChange={(event) => setFormPinned(event.target.checked)}
            />
            Пиннуть
          </label>
          {formError !== null && <p className="form-error" role="alert" data-testid="memory-review-form-error">{formError}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setEditing(null)} data-testid="memory-review-form-cancel">Отмена</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void confirmApprove()} data-testid="memory-review-form-approve">{busy ? "Одобряется..." : "Одобрить"}</button>
          </div>
        </Modal>
      )}

      {toReject !== null && (
        <Modal title="Отклонить предложение" onClose={() => setToReject(null)}>
          <p className="ws-modal-text">Отклонить предложение «{toReject.text.slice(0, 80)}»? Оно не станет записью памяти.</p>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setToReject(null)} data-testid="memory-review-reject-cancel">Отмена</button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => void confirmReject()} data-testid="memory-review-reject-confirm">{busy ? "Отклоняется..." : "Отклонить"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
```

Note on the test "approves a proposal as-is": the modal defaults `formPinned` to `false`, so the patch is `{ id }` only — matching the assertion.

- [ ] **Step 6: Add styles**

Append to `packages/frontend/dsh-balbes-admin/src/styles.css`:

```css
.memory-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.memory-tab { background: transparent; border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
.memory-tab-active { background: var(--accent); color: #fff; border-color: var(--accent); }
.memory-review-policy { margin: 0 0 12px; opacity: 0.8; font-size: 13px; }
.memory-review-status { padding: 1px 6px; border-radius: 4px; font-size: 12px; }
.memory-tab-count { margin-left: 6px; padding: 0 6px; border-radius: 8px; background: rgba(255, 255, 255, 0.25); font-size: 12px; }
.memory-review-status-accepted { background: rgba(46, 160, 67, 0.18); }
.memory-review-status-rejected { background: rgba(200, 60, 60, 0.18); }
```

If the variable names above do not exist in this stylesheet, reuse the closest existing tokens from `styles.css` instead of introducing new ones.

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/frontend/dsh-balbes-admin && npx vitest run tests/MemoryReviewQueue.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/api/client.ts packages/frontend/dsh-balbes-admin/src/pages/memoryShared.ts \
  packages/frontend/dsh-balbes-admin/src/pages/MemoryReviewQueue.tsx \
  packages/frontend/dsh-balbes-admin/src/styles.css packages/frontend/dsh-balbes-admin/tests/MemoryReviewQueue.test.tsx
git commit -m "feat(admin): add the memory review queue (p10f)"
```

---

### Task 10: Memory page tabs

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/pages/MemoryPage.tsx`
- Test: `packages/frontend/dsh-balbes-admin/tests/MemoryPage.test.tsx`

**Interfaces:**
- Consumes: `MemoryReviewQueue` (Task 9).
- Produces: one "Память" page with a «Записи» / «Очередь ревью» switch; the records tab behaviour is unchanged.

- [ ] **Step 1: Write the failing tab tests**

`MemoryPage.test.tsx`'s existing `makeApi` fake predates the review client, so first add `listMemoryReview` to it (returning an empty queue with the policy) — the page seeds the tab badge from it, and a fake without it would throw inside the effect. Then append:

```tsx
  it("switches to the review queue and back", async () => {
    const api = makeApi([record()]);
    render(<MemoryPage api={api} />);
    expect(await screen.findByTestId("memory-row:m-1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("memory-tab-review"));
    expect(await screen.findByTestId("memory-review-empty")).toBeTruthy();
    expect(api.listMemoryReview).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("memory-tab-records"));
    expect(await screen.findByTestId("memory-row:m-1")).toBeTruthy();
  });

  it("shows the pending counter on the review tab label", async () => {
    // The canon puts a pending counter on the tab label, so the page seeds it
    // once on mount — before the owner ever opens the queue.
    const api = makeApi([record()], {
      listMemoryReview: vi.fn(async () => ({
        proposals: [queueProposal(), queueProposal({ id: "p-2" })],
        policy: { immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" }
      }))
    } as Partial<AdminApi>);
    render(<MemoryPage api={api} />);
    expect(await screen.findByTestId("memory-tab-review-count")).toBeTruthy();
    expect(screen.getByTestId("memory-tab-review-count").textContent).toBe("2");
  });
```

`queueProposal` is the small factory the queue's own test file uses; import it from `./MemoryReviewQueue.test` is not possible, so declare a local one in this file (id, scope, type, text, tags, origin, originRef, status, proposedAt, decidedAt, decidedBy, decidedEdit, memoryId).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/frontend/dsh-balbes-admin && npx vitest run tests/MemoryPage.test.tsx`
Expected: FAIL — no element with `data-testid="memory-tab-review"`.

- [ ] **Step 3: Add the tab shell**

In `packages/frontend/dsh-balbes-admin/src/pages/MemoryPage.tsx`:

- import the queue: `import MemoryReviewQueue from "./MemoryReviewQueue";`
- replace the now-shared local helpers with imports and delete their local copies (`MEMORY_TYPES`, `TYPE_LABELS`, `type Level`, `type LevelSelection`, `levelKey`, `levelLabel`, `parseScope`, `parseTags`, `formatTime`). `secretRule` and `messageOf` stay local — their wording is page-specific:

```tsx
import {
  MEMORY_TYPES,
  TYPE_LABELS,
  formatTime,
  levelKey,
  levelLabel,
  parseScope,
  parseTags,
  type MemoryLevel as Level,
  type LevelSelection
} from "./memoryShared";
```

- add the tab state and the pending counter next to the other state:

```tsx
  const [tab, setTab] = useState<"records" | "review">("records");
  const [pendingCount, setPendingCount] = useState(0);
```

- seed the counter once on mount, so the badge is correct before the queue is ever opened (the canon puts the counter on the tab label, and the queue component reports its own count upward after every pending-mode load):

```tsx
  useEffect(() => {
    let cancelled = false;
    void api
      .listMemoryReview({})
      .then((res) => { if (!cancelled) setPendingCount(res.proposals.length); })
      .catch(() => { /* the queue tab reports the real error */ });
    return () => { cancelled = true; };
  }, [api]);
```

- replace the opening of the returned JSX so the toolbar and list render only on the records tab:

```tsx
  return (
    <div className="memory-page" data-testid="memory-page">
      <div className="memory-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "records"}
          className={tab === "records" ? "memory-tab memory-tab-active" : "memory-tab"}
          data-testid="memory-tab-records"
          onClick={() => setTab("records")}
        >
          Записи
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "review"}
          className={tab === "review" ? "memory-tab memory-tab-active" : "memory-tab"}
          data-testid="memory-tab-review"
          onClick={() => setTab("review")}
        >
          Очередь ревью
          {pendingCount > 0 && (
            <span className="memory-tab-count" data-testid="memory-tab-review-count">{pendingCount}</span>
          )}
        </button>
      </div>

      {tab === "review" ? (
        <MemoryReviewQueue api={api} onPendingCount={setPendingCount} />
      ) : (
        <>
          {/* the existing toolbar, states, list and modals stay verbatim in here */}
        </>
      )}
    </div>
  );
```

Keep every existing JSX block for the records tab verbatim inside the fragment; only the wrapper and the tab bar are new. The review tab must not be mounted until selected, so `listMemoryReview` is not called from the records tab.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/frontend/dsh-balbes-admin && npx vitest run tests/MemoryPage.test.tsx tests/MemoryReviewQueue.test.tsx`
Expected: PASS — including every pre-existing MemoryPage test.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/pages/MemoryPage.tsx packages/frontend/dsh-balbes-admin/tests/MemoryPage.test.tsx
git commit -m "feat(admin): split the memory page into records and review tabs (p10f)"
```

---

### Task 11: Runbook, full verification, canon-audit and handoff

**Files:**
- Modify: `docs/runbooks/stage2-vps.md`
- Modify (via skills only): `docs/canon/**` final sync if `canon-audit` finds divergence

**Interfaces:**
- Consumes: every previous task.
- Produces: a current runbook, a verified repository state, and the server verification handoff for the owner.

- [ ] **Step 1: Update the runbook in the same change**

In `docs/runbooks/stage2-vps.md`:

- in the memory smoke section (the block around `POST /api/memory/list|save|delete`), add the review smoke from the spec's "Обновление на сервере" section — render it as a numbered sequence: `propose` → `review/list` (queue + policy) → `memory/list` (empty, proposals are not truth) → `review/approve` with an edited text → `memory/list` (now present) → second `approve` returns 400 → `memory/delete` cleanup, each with its expected output;
- update the schema-version expectation (`# память: файл БД создан и схема на v1` and the `PRAGMA user_version` example) from v1 to v2;
- in the "Миграции памяти" section, state that v1→v2 is additive, creates `memory.sqlite.bak-v1` automatically, and needs no manual step.

- [ ] **Step 2: Run the full local verification**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm test`
Expected: PASS; report how many REAL suites were skipped because `dsh` was not on `PATH`.

Run: `pnpm build`
Expected: PASS.

Run: `cd packages/plugins/dsh-balbes-memory-admin && RUN_REAL=1 npx vitest run tests/integration.test.ts` and
`cd packages/plugins/dsh-balbes-memory-context && RUN_REAL=1 npx vitest run tests/integration.test.ts`
Expected: PASS, or an explicit statement that `dsh` is unavailable and the suites skipped. Never claim a REAL pass that did not run.

- [ ] **Step 3: Close the initiative with canon-audit**

Run the `canon-audit` skill on the memory topic. Expected outcome: `ARCHITECTURE.md`, `GLOSSARY.md`, `ADMIN_UI.md`, `API_CONTRACTS.md` and the implemented code agree; `future_plans/p10f-memory-review.md` is `absorbed`; no new `DISCREPANCIES.md` entries. Record any divergence instead of silently fixing it.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/stage2-vps.md docs/canon
git commit -m "docs: verify memory review against the runbook and canon (p10f)"
```

- [ ] **Step 5: Hand over server verification (owner runs it)**

Report to the owner, grounded in `docs/runbooks/stage2-vps.md`:

1. the change is only on `main` after the owner's go-ahead to push;
2. update the server by re-running `scripts/install.sh` there (`git pull --ff-only` → build → profile sync → plugin copy → SPA deploy → restart);
3. run the runbook's review smoke (steps 0–7 from the spec, as written into the runbook) and report the raw output;
4. expected: `user_version: 2`, `.bak-v1` present, `propose` returns `status: "proposed"`, `memory/list` is empty for the marker, `review/approve` flips `decidedEdit`/`memoryId`, and the second decision is 400.

Offer to interpret the output; do not assume agent-side server access.

---

## Self-review notes

- **Spec coverage:** proposals table and migration (Task 3), service semantics and promotion (Tasks 4–5), contracts and error code (Task 2), four handles plus policy (Task 6), admin REAL flow (Task 7), structural delivery isolation (Tasks 4 and 8), UI queue and tabs (Tasks 9–10), autonomy policy visibility (Tasks 6 and 9), audit columns (Tasks 3–5), degradation 503 (Task 6), runbook and canon (Tasks 1 and 11).
- **Type consistency:** `MemoryProposal.decidedEdit` ↔ `decided_edit`; `MemoryProposalDraft` (service) ↔ `MemoryProposalDraftLike` (routes) ↔ `MemoryProposeRequest` (contracts) all carry `scope`/`type`/`text`/`tags?`/`originRef?`; `approve` returns `{ proposal, record }` everywhere; `invalid-status` is spelled identically in `MemoryErrorCode`, `SERVICE_ERROR_STATUS` and the tests.
- **Every task ends green:** the proposal store in Task 4 covers `propose`/`getProposal`/`listProposals` only; `reject` and `approve` arrive in Task 5, and the decided-row filtering test lives with them.
