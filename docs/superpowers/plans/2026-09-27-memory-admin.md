# Memory Admin (p10b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Give the owner a visible, editable long-term-memory surface: three bearer API routes over the p10a balbesMemory store plus a "Память" page in dsh-balbes-admin.

**Architecture:** A new pure-admin plugin dsh-balbes-memory-admin registers /api/memory/list|save|delete, reading balbesMemory lazily per request (503 when the store is down). The record primitives move into dsh-balbes-contracts; the store plugin re-exports them. The SPA adds a dedicated memory page that consumes the three routes.

**Tech Stack:** TypeScript (ESM, NodeNext) · Cordis function plugins · dsh-balbes-contracts · @deepseek-ai/schemastery · React 18 + Vite SPA · Vitest (+ RTL) · real dsh CLI for REAL composition.

**Spec:** docs/superpowers/specs/2026-09-27-memory-admin-design.md

## Global Constraints

- **R-API-1:** every /api/* route is POST; JSON body/response; errors are {error:{code,message}}.
- **Auth:** all three memory routes are bearer; nothing about memory is public.
- **Provenance:** admin-created records are always saved with origin "owner"; the wire origin value is ignored. update never changes origin.
- **Scope is immutable:** scope is required on create and rejected on update.
- **Secrets:** a secret-detected service error surfaces as HTTP 400 with the same code; the offending text is never written and never echoed.
- **Standalone plugin:** inject = ["balbesHttp"] only; read balbesMemory with ctx.get per request; missing store -> 503 memory-unavailable.
- **No upstream edits:** never touch installed @deepseek-ai/*; compose via profile patches and own packages.
- **UI copy is Russian**; reuse existing admin classes and the dark dev-tool direction.
- **Runbook is living:** a functional change updates docs/runbooks/stage2-vps.md in the same commit.

---

## Phase 0 - canon-first (before any application code)

### Task 0: Write the canon and wait for go-ahead

**Files:**
- Modify (via the canon-write skill, never by hand): docs/canon/ARCHITECTURE.md, docs/canon/API_CONTRACTS.md, docs/canon/ADMIN_UI.md, docs/canon/OVERVIEW.md, docs/canon/future_plans/p10b-memory-admin.md, docs/canon/future_plans/INDEX.md

**Interfaces:**
- Consumes: none.
- Produces: the canonical description of the memory admin surface that every later task must match.

- [ ] **Step 1: Invoke canon-write for the absorbed sections**

Apply exactly the canon changes enumerated in the spec section "Канон": ARCHITECTURE.md (admin surface: new plugin, lazy service + 503, forced origin / immutable scope, no secret echo, contract-type move), API_CONTRACTS.md (three memory.* entries + endpoint list), ADMIN_UI.md ("Память" page), OVERVIEW.md (owner control over memory; success signal), future_plans/p10b-memory-admin.md + INDEX.md (status, resolved open questions, spec link).

- [ ] **Step 2: STOP - get explicit user go-ahead**

Do not write application code until the owner approves the canon updates. Report the canon diff and wait.

- [ ] **Step 3: Commit the canon**

~~~bash
git add docs/canon
git commit -m "docs(canon): define the p10b memory admin surface"
~~~

---

## Phase 1 - shared contracts and the store type move

### Task 1: Move memory record primitives into dsh-balbes-contracts

**Files:**
- Modify: packages/contracts/src/index.ts
- Modify: packages/plugins/dsh-balbes-memory/package.json
- Modify: packages/plugins/dsh-balbes-memory/src/types.ts
- Test: packages/plugins/dsh-balbes-memory/tests/index.test.ts (existing suite is the regression net)

**Interfaces:**
- Consumes: nothing.
- Produces (exported from dsh-balbes-contracts): MemoryType, MemoryScope, MemoryOrigin, MemoryRecord, and the wire types MemoryListRequest/Response, MemorySaveRequest/Response, MemoryDeleteRequest/Response.
- Produces (still exported from packages/plugins/dsh-balbes-memory/src/types.ts): MemoryDraft, MemoryPatch, MemoryFilter, SearchHit, BalbesMemoryService, MEMORY_TYPES, LIMITS - unchanged signatures.

- [ ] **Step 1: Add the memory primitives and wire types to contracts**

Append to packages/contracts/src/index.ts:

~~~ts
// Memory surface - owner-facing long-term memory (store is p10a, admin is p10b)
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
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface MemoryListRequest {
  scope?: MemoryScope;
  type?: MemoryType;
  tag?: string;
  pinned?: boolean;
  /** Non-blank value switches the server to FTS search. */
  query?: string;
  limit?: number;
  offset?: number;
}
export interface MemoryListResponse {
  records: MemoryRecord[];
}

export interface MemorySaveRequest {
  /** Present = update; absent = create. */
  id?: string;
  /** Required on create; rejected on update (scope is immutable). */
  scope?: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  pinned?: boolean;
}
export interface MemorySaveResponse {
  record: MemoryRecord;
}

export interface MemoryDeleteRequest {
  id: string;
}
export interface MemoryDeleteResponse {
  deleted: boolean;
}
~~~

- [ ] **Step 2: Declare the workspace dependency**

In packages/plugins/dsh-balbes-memory/package.json, add to devDependencies (types only; no runtime import):

~~~json
"dsh-balbes-contracts": "workspace:*",
~~~

- [ ] **Step 3: Re-export from the store types module**

At the top of packages/plugins/dsh-balbes-memory/src/types.ts, replace the four local primitive declarations with an imported re-export, keeping the rest of the file unchanged:

~~~ts
import type { MemoryOrigin, MemoryRecord, MemoryScope, MemoryType } from "dsh-balbes-contracts";

export type { MemoryOrigin, MemoryRecord, MemoryScope, MemoryType } from "dsh-balbes-contracts";
~~~

Delete these now-duplicated declarations from the same file: export type MemoryType = ..., export type MemoryScope = ..., export type MemoryOrigin = ..., and export interface MemoryRecord { ... }. The file continues with MemoryDraft (which uses the imported MemoryScope/MemoryType/MemoryOrigin), MemoryPatch, MemoryFilter, SearchRequest, SearchHit, BalbesMemoryService, MEMORY_TYPES, LIMITS.

- [ ] **Step 4: Install and typecheck**

~~~bash
pnpm install
pnpm --filter dsh-balbes-contracts typecheck
pnpm --filter dsh-balbes-memory typecheck
~~~
Expected: both typechecks pass. (pnpm install is required once for the new workspace link.)

- [ ] **Step 5: Run the store suite**

~~~bash
pnpm --filter dsh-balbes-memory test
~~~
Expected: PASS - the existing p10a tests prove the re-export kept every signature.

- [ ] **Step 6: Commit**

~~~bash
git add packages/contracts/src/index.ts packages/plugins/dsh-balbes-memory/package.json packages/plugins/dsh-balbes-memory/src/types.ts pnpm-lock.yaml
git commit -m "refactor(contracts): move memory record types into dsh-balbes-contracts"
~~~

---

## Phase 2 - the server admin plugin

### Task 2: Create dsh-balbes-memory-admin with the three routes + unit tests

**Files:**
- Create: packages/plugins/dsh-balbes-memory-admin/package.json
- Create: packages/plugins/dsh-balbes-memory-admin/tsconfig.json
- Create: packages/plugins/dsh-balbes-memory-admin/tsconfig.build.json
- Create: packages/plugins/dsh-balbes-memory-admin/src/routes.ts
- Create: packages/plugins/dsh-balbes-memory-admin/src/index.ts
- Test: packages/plugins/dsh-balbes-memory-admin/tests/index.test.ts

**Interfaces:**
- Consumes from Task 1: MemoryRecord, MemoryScope, MemoryType from dsh-balbes-contracts.
- Produces: registerMemoryRoutes(http, getService); HttpSeatLike, ResLike, MemoryServiceLike, MemoryFilterLike, MemoryDraftLike, MemoryPatchLike from ./routes.js; plugin name = "balbes-memory-admin", inject = ["balbesHttp"], Config, apply from ./index.js.

- [ ] **Step 1: Scaffold the package**

packages/plugins/dsh-balbes-memory-admin/package.json:

~~~json
{
  "name": "dsh-balbes-memory-admin",
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
    "dsh-balbes-contracts": "workspace:*",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
~~~

packages/plugins/dsh-balbes-memory-admin/tsconfig.json:

~~~json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests"]
}
~~~

packages/plugins/dsh-balbes-memory-admin/tsconfig.build.json:

~~~json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "lib",
    "rootDir": "src",
    "declarationDir": "lib/types"
  },
  "include": ["src"]
}
~~~

- [ ] **Step 2: Write the failing unit tests**

packages/plugins/dsh-balbes-memory-admin/tests/index.test.ts:

~~~ts
import { describe, expect, it } from "vitest";
import { apply, Config, inject, name } from "../src/index.js";
import type { MemoryDraftLike, MemoryFilterLike, MemoryPatchLike, MemoryServiceLike, ResLike } from "../src/routes.js";
import type { MemoryRecord } from "dsh-balbes-contracts";

interface Seat {
  path: string;
  auth: string;
  handler(req: unknown, res: ResLike, body: unknown): Promise<void> | void;
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m-1",
    scope: { kind: "global" },
    type: "note",
    text: "hello",
    tags: [],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    ...overrides
  };
}

function makeRes(): { res: ResLike; read(): { status: number; json: unknown; raw: string } } {
  const box = { status: 0, raw: "" };
  return {
    res: {
      writeHead(status: number) { box.status = status; },
      end(body?: string) { box.raw = String(body ?? ""); }
    },
    read: () => ({ status: box.status, raw: box.raw, json: box.raw === "" ? undefined : (JSON.parse(box.raw) as unknown) })
  };
}

interface FakeService extends MemoryServiceLike {
  saved: MemoryDraftLike[];
  updated: Array<{ id: string; patch: MemoryPatchLike }>;
  deleted: string[];
  searched: Array<{ query: string; filter?: MemoryFilterLike }>;
}

function fakeService(overrides: Partial<MemoryServiceLike> = {}): FakeService {
  const saved: MemoryDraftLike[] = [];
  const updated: Array<{ id: string; patch: MemoryPatchLike }> = [];
  const deleted: string[] = [];
  const searched: Array<{ query: string; filter?: MemoryFilterLike }> = [];
  const base: MemoryServiceLike = {
    async save(draft) { saved.push(draft); return record({ scope: draft.scope, type: draft.type, text: draft.text, origin: draft.origin }); },
    async update(id, patch) { updated.push({ id, patch }); return record({ id, text: patch.text ?? "updated" }); },
    async delete(id) { deleted.push(id); return true; },
    async list() { return [record()]; },
    async search(request) { searched.push({ query: request.query, ...(request.filter === undefined ? {} : { filter: request.filter }) }); return [{ record: record({ text: "hit" }), rank: 1 }]; }
  };
  return Object.assign(base, overrides, { saved, updated, deleted, searched });
}

interface HarnessOptions { service?: MemoryServiceLike | undefined; omitHttp?: boolean; }

function harness(options: HarnessOptions = {}) {
  const seats: Seat[] = [];
  const warnings: string[] = [];
  let service = options.service;
  const ctx = {
    get(key: string): unknown {
      if (key === "balbesHttp") {
        return options.omitHttp === true
          ? undefined
          : { post(path: string, auth: string, handler: Seat["handler"]) { seats.push({ path, auth, handler }); } };
      }
      if (key === "balbesMemory") return service;
      return undefined;
    },
    logger: { warn(message: string) { warnings.push(message); } }
  };
  apply(ctx as never, {});
  async function call(path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }> {
    const seat = seats.find((candidate) => candidate.path === path);
    if (seat === undefined) throw new Error("no seat registered for " + path);
    const response = makeRes();
    await seat.handler({}, response.res, body);
    return response.read();
  }
  return { seats, warnings, call, setService(value: MemoryServiceLike | undefined) { service = value; } };
}

describe("balbes-memory-admin plugin", () => {
  it("exposes the functional plugin contract", () => {
    expect(name).toBe("balbes-memory-admin");
    expect(inject).toEqual(["balbesHttp"]);
    expect(Config({})).toEqual({});
  });

  it("registers the three bearer routes", () => {
    const h = harness({ service: fakeService() });
    expect(h.seats.map((seat) => seat.path)).toEqual([
      "/api/memory/list",
      "/api/memory/save",
      "/api/memory/delete"
    ]);
    expect(h.seats.every((seat) => seat.auth === "bearer")).toBe(true);
  });

  it("warns and registers nothing without balbesHttp", () => {
    const h = harness({ service: fakeService(), omitHttp: true });
    expect(h.seats).toEqual([]);
    expect(h.warnings.join(" ")).toContain("balbesHttp");
  });

  it("answers 503 memory-unavailable when the store is absent", async () => {
    const h = harness({ service: undefined });
    const res = await h.call("/api/memory/list", {});
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: { code: "memory-unavailable", message: "memory storage is not available" } });
  });

  it("lists records with the filters it was given", async () => {
    const service = fakeService();
    const h = harness({ service });
    const res = await h.call("/api/memory/list", { scope: { kind: "global" }, type: "note", tag: "x", pinned: true });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ records: [record()] });
    expect(service.searched).toEqual([]);
  });

  it("uses FTS search when query is non-blank", async () => {
    const service = fakeService();
    const h = harness({ service });
    const res = await h.call("/api/memory/list", { query: "  hello  " });
    expect(res.status).toBe(200);
    expect(service.searched).toEqual([{ query: "hello" }]);
    expect((res.json as { records: MemoryRecord[] }).records[0]?.text).toBe("hit");
  });

  it("forces origin owner on create even when the body claims agent", async () => {
    const service = fakeService();
    const h = harness({ service });
    const res = await h.call("/api/memory/save", { scope: { kind: "global" }, type: "note", text: "x", origin: "agent" });
    expect(res.status).toBe(200);
    expect(service.saved[0]?.origin).toBe("owner");
  });

  it("rejects scope on update and never sends it to the service", async () => {
    const service = fakeService();
    const h = harness({ service });
    const bad = await h.call("/api/memory/save", { id: "m-1", scope: { kind: "global" }, type: "note", text: "x" });
    expect(bad.status).toBe(400);
    expect(service.updated).toEqual([]);

    const ok = await h.call("/api/memory/save", { id: "m-1", type: "note", text: "new" });
    expect(ok.status).toBe(200);
    expect(service.updated).toEqual([{ id: "m-1", patch: { type: "note", text: "new" } }]);
  });

  it("reports deletion outcome and validates the id", async () => {
    const service = fakeService();
    const h = harness({ service });
    const ok = await h.call("/api/memory/delete", { id: "m-1" });
    expect(ok.json).toEqual({ deleted: true });
    expect(service.deleted).toEqual(["m-1"]);

    const bad = await h.call("/api/memory/delete", {});
    expect(bad.status).toBe(400);
  });

  it("maps MemoryError codes to HTTP statuses", async () => {
    const secret = fakeService({ save: async () => { throw { code: "secret-detected", message: "text matches secret rule sk" }; } });
    const h = harness({ service: secret });
    const res = await h.call("/api/memory/save", { scope: { kind: "global" }, type: "note", text: "sk-abc123456789012345" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: { code: "secret-detected", message: "text matches secret rule sk" } });

    const missing = fakeService({ update: async () => { throw { code: "not-found", message: "memory not found: nope" }; } });
    const h2 = harness({ service: missing });
    const res2 = await h2.call("/api/memory/save", { id: "nope", type: "note", text: "x" });
    expect(res2.status).toBe(404);

    const broken = fakeService({ list: async () => { throw new Error("boom"); } });
    const h3 = harness({ service: broken });
    const res3 = await h3.call("/api/memory/list", {});
    expect(res3.status).toBe(500);
    expect(res3.json).toEqual({ error: { code: "internal", message: "boom" } });
  });
});
~~~

- [ ] **Step 3: Run the tests to verify they fail**

~~~bash
pnpm install
pnpm --filter dsh-balbes-memory-admin test
~~~
Expected: FAIL - Cannot find module ../src/index.js.

- [ ] **Step 4: Implement src/routes.ts**

~~~ts
import type { MemoryRecord, MemoryScope, MemoryType } from "dsh-balbes-contracts";

/** The registration seat slice of the balbesHttp service. */
export interface HttpSeatLike {
  post(
    path: string,
    auth: "public" | "bearer",
    handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void
  ): void;
}

/** The response seat slice these routes write through. */
export interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** Structural slice of the balbesMemory service the routes consume. */
export interface MemoryFilterLike {
  scope?: MemoryScope;
  type?: MemoryType;
  tag?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryDraftLike {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  pinned?: boolean;
  origin: "owner";
  originRef?: string | null;
}

export interface MemoryPatchLike {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
  originRef?: string | null;
}

export interface MemoryServiceLike {
  save(draft: MemoryDraftLike): Promise<MemoryRecord>;
  update(id: string, patch: MemoryPatchLike): Promise<MemoryRecord>;
  delete(id: string): Promise<boolean>;
  list(filter?: MemoryFilterLike): Promise<MemoryRecord[]>;
  search(request: { query: string; filter?: MemoryFilterLike; limit?: number }): Promise<Array<{ record: MemoryRecord; rank: number }>>;
}

function send(res: ResLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
  res.end(payload);
}

function sendError(res: ResLike, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

const SERVICE_ERROR_STATUS: Record<string, number> = {
  "invalid-record": 400,
  "invalid-scope": 400,
  "invalid-filter": 400,
  "invalid-query": 400,
  "secret-detected": 400,
  "not-found": 404
};

function serviceErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function sendServiceError(res: ResLike, error: unknown): void {
  const code = serviceErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const status = code === undefined ? undefined : SERVICE_ERROR_STATUS[code];
  if (code !== undefined && status !== undefined) {
    sendError(res, status, code, message);
    return;
  }
  sendError(res, 500, "internal", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScope(value: unknown): { ok: true; scope: MemoryScope } | { ok: false; message: string } {
  if (!isObject(value)) return { ok: false, message: "scope must be a JSON object" };
  if (value.kind === "global") {
    if (value.name !== undefined) return { ok: false, message: "scope.name is not allowed for a global scope" };
    return { ok: true, scope: { kind: "global" } };
  }
  if (value.kind === "project") {
    if (typeof value.name !== "string" || value.name === "") {
      return { ok: false, message: "scope.name is required for a project scope" };
    }
    return { ok: true, scope: { kind: "project", name: value.name } };
  }
  return { ok: false, message: "scope.kind must be global or project" };
}

type ParsedList = { ok: true; filter: MemoryFilterLike; query?: string } | { ok: false; message: string };

function parseList(body: unknown): ParsedList {
  if (!isObject(body)) return { ok: false, message: "request body must be a JSON object" };
  const filter: MemoryFilterLike = {};
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
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean") return { ok: false, message: "pinned must be a boolean" };
    filter.pinned = body.pinned;
  }
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number") return { ok: false, message: "limit must be a number" };
    filter.limit = body.limit;
  }
  if (body.offset !== undefined) {
    if (typeof body.offset !== "number") return { ok: false, message: "offset must be a number" };
    filter.offset = body.offset;
  }
  if (body.query !== undefined && typeof body.query !== "string") {
    return { ok: false, message: "query must be a string" };
  }
  return { ok: true, filter, ...(typeof body.query === "string" ? { query: body.query } : {}) };
}

type ParsedSave =
  | { ok: true; mode: "create"; scope: MemoryScope; type: MemoryType; text: string; tags?: string[]; pinned?: boolean }
  | { ok: true; mode: "update"; id: string; type: MemoryType; text: string; tags?: string[]; pinned?: boolean }
  | { ok: false; message: string };

function parseSave(body: unknown): ParsedSave {
  if (!isObject(body)) return { ok: false, message: "request body must be a JSON object" };
  if (typeof body.type !== "string" || body.type === "") return { ok: false, message: "type is required" };
  if (typeof body.text !== "string") return { ok: false, message: "text is required" };
  if (body.tags !== undefined && !(Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === "string"))) {
    return { ok: false, message: "tags must be an array of strings" };
  }
  if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
    return { ok: false, message: "pinned must be a boolean" };
  }
  const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined;
  const pinned = typeof body.pinned === "boolean" ? body.pinned : undefined;
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || body.id === "") return { ok: false, message: "id must be a non-empty string" };
    if (body.scope !== undefined) return { ok: false, message: "scope is immutable and not allowed on update" };
    return {
      ok: true,
      mode: "update",
      id: body.id,
      type: body.type as MemoryType,
      text: body.text,
      ...(tags === undefined ? {} : { tags }),
      ...(pinned === undefined ? {} : { pinned })
    };
  }
  if (body.scope === undefined) return { ok: false, message: "scope is required when creating a memory" };
  const parsedScope = parseScope(body.scope);
  if (!parsedScope.ok) return parsedScope;
  return {
    ok: true,
    mode: "create",
    scope: parsedScope.scope,
    type: body.type as MemoryType,
    text: body.text,
    ...(tags === undefined ? {} : { tags }),
    ...(pinned === undefined ? {} : { pinned })
  };
}

export function registerMemoryRoutes(
  http: HttpSeatLike,
  getService: () => MemoryServiceLike | undefined
): void {
  const unavailable = (res: ResLike): void =>
    sendError(res, 503, "memory-unavailable", "memory storage is not available");

  http.post("/api/memory/list", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parseList(body);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      const records = parsed.query !== undefined && parsed.query.trim() !== ""
        ? (await service.search({ query: parsed.query.trim(), filter: parsed.filter })).map((hit) => hit.record)
        : await service.list(parsed.filter);
      send(res, 200, { records });
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/save", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parseSave(body);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      if (parsed.mode === "create") {
        const draft: MemoryDraftLike = {
          scope: parsed.scope,
          type: parsed.type,
          text: parsed.text,
          origin: "owner",
          ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
          ...(parsed.pinned === undefined ? {} : { pinned: parsed.pinned })
        };
        send(res, 200, { record: await service.save(draft) });
      } else {
        const patch: MemoryPatchLike = {
          type: parsed.type,
          text: parsed.text,
          ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
          ...(parsed.pinned === undefined ? {} : { pinned: parsed.pinned })
        };
        send(res, 200, { record: await service.update(parsed.id, patch) });
      }
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/delete", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    if (!isObject(body) || typeof body.id !== "string" || body.id === "") {
      sendError(res, 400, "bad-request", "id is required");
      return;
    }
    try {
      send(res, 200, { deleted: await service.delete(body.id) });
    } catch (error) {
      sendServiceError(res, error);
    }
  });
}
~~~

- [ ] **Step 5: Implement src/index.ts**

~~~ts
import z from "@deepseek-ai/schemastery";
import { registerMemoryRoutes, type HttpSeatLike, type MemoryServiceLike } from "./routes.js";

export const name = "balbes-memory-admin";

/**
 * balbesHttp is the only injected service. The balbesMemory store is read
 * lazily per request, so this plugin applies regardless of the store plugin
 * load order and answers 503 (instead of a generic 404) when the store failed
 * to open its database.
 */
export const inject = ["balbesHttp"];

export const Config = z.object({});

interface CtxLike {
  get(key: string): unknown;
  logger: { warn(message: string): void };
}

export function apply(ctx: CtxLike, _config: unknown): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-memory-admin: balbesHttp service missing; routes not registered");
    return;
  }
  registerMemoryRoutes(http, () => ctx.get("balbesMemory") as MemoryServiceLike | undefined);
}
~~~

- [ ] **Step 6: Run the tests to verify they pass**

~~~bash
pnpm --filter dsh-balbes-memory-admin test
pnpm --filter dsh-balbes-memory-admin typecheck
~~~
Expected: PASS.

- [ ] **Step 7: Commit**

~~~bash
git add packages/plugins/dsh-balbes-memory-admin
git commit -m "feat(memory-admin): add the bearer memory routes over balbesMemory"
~~~

### Task 3: REAL composition test for the memory routes

**Files:**
- Create: packages/plugins/dsh-balbes-memory-admin/tests/fixtures/balbes-memory-admin-profile/cordis.patch.yml
- Create: packages/plugins/dsh-balbes-memory-admin/tests/fixtures/balbes-memory-admin-profile/package.json
- Create: packages/plugins/dsh-balbes-memory-admin/tests/integration.test.ts

**Interfaces:**
- Consumes from Task 2: the plugin routes and name.
- Produces: a bootable fixture profile used by CI; the proof that a real server serves /api/memory/*.

- [ ] **Step 1: Write the fixture profile**

packages/plugins/dsh-balbes-memory-admin/tests/fixtures/balbes-memory-admin-profile/cordis.patch.yml:

~~~yaml
# Test composition for the memory admin plugin: dsh-base + the balbes host
# bundle (server + auth + /api/health) + the memory store + the admin routes.
- insert:
    - id: balbes-memory
      name: 'dsh-balbes-memory'

    - id: balbes-memory-admin
      name: 'dsh-balbes-memory-admin'
~~~

packages/plugins/dsh-balbes-memory-admin/tests/fixtures/balbes-memory-admin-profile/package.json:

~~~json
{
  "name": "dsh-profile-balbes-memory-admin-test",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-balbes-host"],
      "patchReload": "startup"
    }
  }
}
~~~

- [ ] **Step 2: Write the REAL test**

packages/plugins/dsh-balbes-memory-admin/tests/integration.test.ts:

~~~ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const memoryPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory");
const fixtureProfile = join(here, "fixtures", "balbes-memory-admin-profile");
const PROFILE = "balbes-memory-admin-test";

async function hasDsh(): Promise<boolean> {
  try { await execFileP("dsh", ["--version"], { timeout: 10_000 }); return true; } catch { return false; }
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
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server did not become healthy within " + timeoutMs + "ms");
}

async function postJson(url: string, body: unknown, token?: string): Promise<{ status: number; json: unknown; raw: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = "Bearer " + token;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  return { status: response.status, json, raw };
}

const realEnabled = (process.env.RUN_REAL ?? "").trim() !== "" ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (memory admin API)", () => {
  let home: string;
  let port: number;
  let login: string;
  let password: string;
  let token: string;
  let child: ReturnType<typeof spawn> | null = null;

  async function prepareHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "balbes-memory-admin-real-"));
    const profiles = join(dir, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, PROFILE), { recursive: true });
    const nm = join(profiles, PROFILE, "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    for (const [root, dirName] of [[memoryPkgRoot, "dsh-balbes-memory"], [pkgRoot, "dsh-balbes-memory-admin"]] as Array<[string, string]>) {
      await cp(join(root, "lib"), join(nm, dirName, "lib"), { recursive: true });
      await cp(join(root, "package.json"), join(nm, dirName, "package.json"));
    }
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(dir, creds);
    return dir;
  }

  async function boot(dir: string): Promise<void> {
    child = spawn("dsh", ["--profile", PROFILE], {
      env: { ...process.env, DSH_HOME: dir, BALBES_PORT: String(port), DSH_TELEMETRY_DISABLED: "1" },
      cwd: dir,
      stdio: "ignore"
    });
    await waitForHealth(port, child);
    const loginRes = await postJson("http://127.0.0.1:" + port + "/api/auth/login", { login, password });
    expect(loginRes.status, loginRes.raw).toBe(200);
    token = (loginRes.json as { token: string }).token;
  }

  async function stop(): Promise<void> {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child!.once("exit", resolve));
    }
    child = null;
  }

  const api = (path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }> =>
    postJson("http://127.0.0.1:" + port + path, body, token);

  beforeAll(async () => {
    home = await prepareHome();
    port = await freePort();
    await boot(home);
  }, 120_000);

  afterAll(async () => {
    await stop();
    await rm(home, { recursive: true, force: true });
  });

  it("requires bearer auth", async () => {
    const res = await postJson("http://127.0.0.1:" + port + "/api/memory/list", {});
    expect(res.status).toBe(401);
  });

  it("creates, lists, updates, rejects secrets and deletes over HTTP", async () => {
    const empty = await api("/api/memory/list", {});
    expect(empty.status, empty.raw).toBe(200);
    expect(empty.json).toEqual({ records: [] });

    const saved = await api("/api/memory/save", {
      scope: { kind: "global" },
      type: "note",
      text: "smoke note",
      tags: ["smoke"]
    });
    expect(saved.status, saved.raw).toBe(200);
    const created = (saved.json as { record: { id: string; origin: string; text: string } }).record;
    expect(created.origin).toBe("owner");
    expect(created.text).toBe("smoke note");

    const listed = await api("/api/memory/list", {});
    expect((listed.json as { records: Array<{ id: string }> }).records.some((r) => r.id === created.id)).toBe(true);

    const projectSaved = await api("/api/memory/save", {
      scope: { kind: "project", name: "alpha" },
      type: "fact",
      text: "project fact"
    });
    expect(projectSaved.status, projectSaved.raw).toBe(200);
    const globalOnly = await api("/api/memory/list", { scope: { kind: "global" } });
    expect((globalOnly.json as { records: Array<{ scope: { kind: string } }> }).records.every((r) => r.scope.kind === "global")).toBe(true);

    const updated = await api("/api/memory/save", { id: created.id, type: "note", text: "edited note" });
    expect((updated.json as { record: { text: string; origin: string } }).record.text).toBe("edited note");
    expect((updated.json as { record: { origin: string } }).record.origin).toBe("owner");

    const rejected = await api("/api/memory/save", {
      scope: { kind: "global" },
      type: "note",
      text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    });
    expect(rejected.status, rejected.raw).toBe(400);
    expect((rejected.json as { error: { code: string } }).error.code).toBe("secret-detected");

    const search = await api("/api/memory/list", { query: "edited" });
    expect((search.json as { records: Array<{ id: string }> }).records.some((r) => r.id === created.id)).toBe(true);

    const removed = await api("/api/memory/delete", { id: created.id });
    expect(removed.json).toEqual({ deleted: true });
    const again = await api("/api/memory/delete", { id: created.id });
    expect(again.json).toEqual({ deleted: false });
  });

  it("keeps records across a server restart", async () => {
    const saved = await api("/api/memory/save", { scope: { kind: "global" }, type: "note", text: "durable" });
    const id = (saved.json as { record: { id: string } }).record.id;
    await stop();
    await boot(home);
    const listed = await api("/api/memory/list", { scope: { kind: "global" } });
    expect((listed.json as { records: Array<{ id: string }> }).records.some((r) => r.id === id)).toBe(true);
  });
});
~~~

- [ ] **Step 3: Run the REAL test (skips without dsh)**

~~~bash
pnpm -r --if-present run build
cd packages/plugins/dsh-balbes-memory-admin
RUN_REAL=1 bash node_modules/.bin/vitest run tests/integration.test.ts
~~~
Expected: PASS with dsh on PATH. Without dsh or RUN_REAL, the suite is skipped.

- [ ] **Step 4: Commit**

~~~bash
git add packages/plugins/dsh-balbes-memory-admin/tests
git commit -m "test(memory-admin): REAL composition serves the memory routes"
~~~

### Task 4: Production composition, installer, runbook and CI

**Files:**
- Modify: profiles/balbes/cordis.patch.yml
- Modify: scripts/install.sh
- Modify: docs/runbooks/stage2-vps.md
- Modify: .github/workflows/ci.yml

**Interfaces:**
- Consumes from Task 2/3: package name dsh-balbes-memory-admin and its REAL suite path.
- Produces: the deployable profile row and the documented smoke.

- [ ] **Step 1: Add the profile row**

In profiles/balbes/cordis.patch.yml, immediately after the balbes-memory insert:

~~~yaml
    - id: balbes-memory-admin
      name: 'dsh-balbes-memory-admin'
~~~

- [ ] **Step 2: Add the installer copy step**

In scripts/install.sh, add this function right after copy_memory_into_profile():

~~~bash
# copy_memory_admin_into_profile - зеркало copy_memory_into_profile: собранный
# плагин админ-поверхности памяти копируется в node_modules профиля.
copy_memory_admin_into_profile() {
    local profile_dir="$DSH_HOME/profiles/$PROFILE_NAME"
    local src="$REPO_DIR/packages/plugins/dsh-balbes-memory-admin"
    local dst="$profile_dir/node_modules/dsh-balbes-memory-admin"
    if [[ ! -d "$src/lib" ]]; then
        die "memory admin plugin not built at $src/lib - build step failed"
    fi
    mkdir -p "$profile_dir/node_modules"
    rm -rf "$dst"
    cp -R "$src" "$dst"
    rm -f "$dst/tsconfig.json" "$dst/tsconfig.build.json"
    rm -rf "$dst/tests" "$dst/src" "$dst/lib/types"
    chmod -R u+rwX,go-w "$dst"
    info "Memory admin plugin copied into $dst"
}
~~~

Add copy_memory_admin_into_profile after copy_memory_into_profile in main(), and update the header comment plugin list to include dsh-balbes-memory-admin.

- [ ] **Step 3: Update the runbook**

In docs/runbooks/stage2-vps.md, add dsh-balbes-memory-admin to both plugin inventories (the copy-step list near the dsh-balbes-memory line and the node_modules inventory list, e.g. dsh-balbes-memory-admin/ (ручки управления памятью)), and add a smoke block to the manual-smoke/DoD section:

~~~bash
TOKEN=... # POST /api/auth/login
curl -fsS -X POST http://127.0.0.1:8080/api/memory/list \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
# ожидается: {"records":[]} (или непустой список)

curl -fsS -X POST http://127.0.0.1:8080/api/memory/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":{"kind":"global"},"type":"note","text":"smoke note","tags":["smoke"]}'
# ожидается: {"record":{...,"origin":"owner",...}}; id берётся из ответа

curl -fsS -X POST http://127.0.0.1:8080/api/memory/delete \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"id":"<id>"}'
# ожидается: {"deleted":true}
~~~

- [ ] **Step 4: Add the CI REAL step**

In .github/workflows/ci.yml, after the "REAL suites - memory store" step:

~~~yaml
      - name: REAL suites - memory admin (memory routes over HTTP)
        working-directory: packages/plugins/dsh-balbes-memory-admin
        env:
          RUN_REAL: "1"
        run: bash node_modules/.bin/vitest run tests/integration.test.ts
~~~

- [ ] **Step 5: Verify the profile manifest and composer wiring**

~~~bash
node -e "JSON.parse(require('fs').readFileSync('profiles/balbes/package.json','utf8'))"
grep -n "balbes-memory-admin" profiles/balbes/cordis.patch.yml scripts/install.sh docs/runbooks/stage2-vps.md .github/workflows/ci.yml
~~~
Expected: the JSON parses and the grep lists every intended location.

- [ ] **Step 6: Commit**

~~~bash
git add profiles/balbes/cordis.patch.yml scripts/install.sh docs/runbooks/stage2-vps.md .github/workflows/ci.yml
git commit -m "feat(profile): compose the memory admin plugin and document its smoke"
~~~

---

## Phase 3 - the admin SPA

### Task 5: Client methods for the memory routes

**Files:**
- Modify: packages/frontend/dsh-balbes-admin/src/api/client.ts
- Test: packages/frontend/dsh-balbes-admin/tests/client.test.ts

**Interfaces:**
- Consumes from Task 1: MemoryListRequest/Response, MemorySaveRequest/Response, MemoryDeleteRequest/Response.
- Produces on AdminApi: listMemory(req), saveMemory(req), deleteMemory(id).

- [ ] **Step 1: Write the failing client test**

Append inside the existing describe("api client") in packages/frontend/dsh-balbes-admin/tests/client.test.ts:

~~~ts
  it("memory methods POST to their endpoints", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const seen: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ path: url, body: JSON.parse(String(init.body)) as unknown });
      return { ok: true, status: 200, statusText: "200", json: async () => ({ records: [], record: {}, deleted: false }) };
    }));
    const api = createApiClient();
    await api.listMemory({ scope: { kind: "global" } });
    await api.saveMemory({ scope: { kind: "global" }, type: "note", text: "x" });
    await api.deleteMemory("m-1");
    expect(seen).toEqual([
      { path: "/api/memory/list", body: { scope: { kind: "global" } } },
      { path: "/api/memory/save", body: { scope: { kind: "global" }, type: "note", text: "x" } },
      { path: "/api/memory/delete", body: { id: "m-1" } }
    ]);
  });
~~~

- [ ] **Step 2: Run it to verify it fails**

~~~bash
pnpm --filter dsh-balbes-admin test -- client.test.ts
~~~
Expected: FAIL - api.listMemory is not a function.

- [ ] **Step 3: Add the methods**

In packages/frontend/dsh-balbes-admin/src/api/client.ts, extend the contracts import with MemoryListRequest, MemoryListResponse, MemorySaveRequest, MemorySaveResponse, MemoryDeleteRequest, MemoryDeleteResponse; add to the AdminApi interface:

~~~ts
  listMemory(req: MemoryListRequest): Promise<MemoryListResponse>;
  saveMemory(req: MemorySaveRequest): Promise<MemorySaveResponse>;
  deleteMemory(id: string): Promise<MemoryDeleteResponse>;
~~~

and to the returned object in createApiClient():

~~~ts
    listMemory: (req) => guard(request<MemoryListResponse>("/api/memory/list", req satisfies MemoryListRequest)),
    saveMemory: (req) => guard(request<MemorySaveResponse>("/api/memory/save", req satisfies MemorySaveRequest)),
    deleteMemory: (id) => guard(request<MemoryDeleteResponse>("/api/memory/delete", { id } satisfies MemoryDeleteRequest)),
~~~

- [ ] **Step 4: Run the test and typecheck**

~~~bash
pnpm --filter dsh-balbes-admin test -- client.test.ts
pnpm --filter dsh-balbes-admin typecheck
~~~
Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/frontend/dsh-balbes-admin/src/api/client.ts packages/frontend/dsh-balbes-admin/tests/client.test.ts
git commit -m "feat(admin): add memory API client methods"
~~~

### Task 6: Sidebar entry and App routing

**Files:**
- Modify: packages/frontend/dsh-balbes-admin/src/components/Sidebar.tsx
- Modify: packages/frontend/dsh-balbes-admin/src/App.tsx
- Test: packages/frontend/dsh-balbes-admin/tests/Sidebar.test.tsx
- Test: packages/frontend/dsh-balbes-admin/tests/App.test.tsx

**Interfaces:**
- Consumes from Task 5/7: MemoryPage via AdminApi.listMemory.
- Produces: page id "memory", title "Память".

- [ ] **Step 1: Write the failing sidebar test**

Append to tests/Sidebar.test.tsx:

~~~tsx
  it("Память is a live item in the Управление group", () => {
    const onNavigate = vi.fn();
    render(<Sidebar active="memory" onNavigate={onNavigate} />);
    const memory = screen.getByRole("button", { name: "Память" });
    expect(memory.className).not.toContain("ghost");
    expect(memory.getAttribute("aria-current")).toBe("page");
    fireEvent.click(memory);
    expect(onNavigate).toHaveBeenCalledWith("memory");
  });
~~~

- [ ] **Step 2: Run it to verify it fails**

~~~bash
pnpm --filter dsh-balbes-admin test -- Sidebar.test.tsx
~~~
Expected: FAIL - no button named Память.

- [ ] **Step 3: Add the nav item**

In Sidebar.tsx, add to the Управление group right after the Telegram item:

~~~ts
      { id: "memory", label: "Память", soon: false },
~~~

- [ ] **Step 4: Route the page in App**

In App.tsx: add "memory" to the Page union, add memory: "Память" to PAGE_TITLES, import MemoryPage from "./pages/MemoryPage", and extend the final ternary so telegram renders TelegramPage and the fallback renders MemoryPage:

~~~tsx
        ) : page === "telegram" ? (
          <TelegramPage api={api} />
        ) : (
          <MemoryPage api={api} />
        )}
~~~

- [ ] **Step 5: Add the App navigation test**

Append to tests/App.test.tsx (the page mount calls listWorkspaces then listMemory, in that order):

~~~tsx
  it("переходит на страницу памяти по клику в сайдбаре", async () => {
    vi.stubGlobal("fetch", mockFetchSequence(
      { status: 200, body: { login: "balbes-x" } },
      { status: 200, body: { home: { path: "/h/agent" }, projects: [] } },
      { status: 200, body: { records: [] } }
    ));
    localStorage.setItem("balbes.authToken", "t");
    render(<App api={createApiClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Память" }));
    expect(await screen.findByTestId("memory-page")).toBeTruthy();
    expect(await screen.findByTestId("memory-empty")).toBeTruthy();
    const crumb = screen.getByText("balbes /");
    expect(crumb.querySelector("b")?.textContent).toBe("Память");
  });
~~~

- [ ] **Step 6: Run the tests**

~~~bash
pnpm --filter dsh-balbes-admin test -- Sidebar.test.tsx App.test.tsx
pnpm --filter dsh-balbes-admin typecheck
~~~
Expected: PASS (Task 7 must have created MemoryPage.tsx first; run Task 7 before this step if going task by task).

- [ ] **Step 7: Commit**

~~~bash
git add packages/frontend/dsh-balbes-admin/src/components/Sidebar.tsx packages/frontend/dsh-balbes-admin/src/App.tsx packages/frontend/dsh-balbes-admin/tests/Sidebar.test.tsx packages/frontend/dsh-balbes-admin/tests/App.test.tsx
git commit -m "feat(admin): add the Память navigation entry and page route"
~~~

### Task 7: The MemoryPage component and its styles

**Files:**
- Create: packages/frontend/dsh-balbes-admin/src/pages/MemoryPage.tsx
- Modify: packages/frontend/dsh-balbes-admin/src/styles.css
- Test: packages/frontend/dsh-balbes-admin/tests/MemoryPage.test.tsx

**Interfaces:**
- Consumes from Task 5: AdminApi.listMemory/saveMemory/deleteMemory and listWorkspaces.
- Produces: the page component used by Task 6 App.tsx and testids memory-page, memory-level, memory-search, memory-type-filter, memory-tag-filter, memory-pinned-only, memory-add, memory-refresh, memory-empty, memory-load-error, memory-load-retry, memory-list, memory-row:<id>, memory-edit:<id>, memory-delete:<id>, memory-form-type, memory-form-text, memory-form-tags, memory-form-pinned, memory-form-save, memory-form-cancel, memory-form-error, memory-delete-confirm, memory-delete-cancel, memory-action-error.

- [ ] **Step 1: Write the failing component tests**

packages/frontend/dsh-balbes-admin/tests/MemoryPage.test.tsx:

~~~tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MemoryPage from "../src/pages/MemoryPage";
import { ApiError, type AdminApi } from "../src/api/client";
import type { MemoryRecord, MemorySaveRequest } from "dsh-balbes-contracts";

afterEach(cleanup);

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m-1",
    scope: { kind: "global" },
    type: "note",
    text: "hello memory",
    tags: ["x"],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    ...overrides
  };
}

function makeApi(records: MemoryRecord[], overrides: Partial<AdminApi> = {}): AdminApi {
  const store = [...records];
  return {
    listWorkspaces: vi.fn(async () => ({ home: { path: "/h/agent" }, projects: [] })),
    listMemory: vi.fn(async () => ({ records: [...store] })),
    saveMemory: vi.fn(async (req: MemorySaveRequest) => {
      const saved = record({ id: "m-new", text: req.text, type: req.type, tags: req.tags ?? [], pinned: req.pinned ?? false });
      store.push(saved);
      return { record: saved };
    }),
    deleteMemory: vi.fn(async (id: string) => {
      const index = store.findIndex((item) => item.id === id);
      if (index >= 0) store.splice(index, 1);
      return { deleted: index >= 0 };
    }),
    ...overrides
  } as unknown as AdminApi;
}

describe("MemoryPage", () => {
  it("shows the empty state", async () => {
    render(<MemoryPage api={makeApi([])} />);
    expect(await screen.findByTestId("memory-empty")).toBeTruthy();
  });

  it("renders a record with provenance and time", async () => {
    render(<MemoryPage api={makeApi([record()])} />);
    expect(await screen.findByTestId("memory-row:m-1")).toBeTruthy();
    expect(screen.getByText("hello memory")).toBeTruthy();
    expect(screen.getByText(/владелец ·/)).toBeTruthy();
    expect(screen.getByTestId("memory-row:m-1").textContent).toContain("x");
  });

  it("creates a record through the editor and refreshes the list", async () => {
    const api = makeApi([]);
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-add"));
    fireEvent.change(screen.getByTestId("memory-form-text"), { target: { value: "new note" } });
    fireEvent.click(screen.getByTestId("memory-form-save"));
    await waitFor(() => expect(api.saveMemory).toHaveBeenCalled());
    expect(api.saveMemory).toHaveBeenCalledWith(expect.objectContaining({ text: "new note", type: "note", scope: { kind: "global" } }));
    expect(await screen.findByTestId("memory-row:m-new")).toBeTruthy();
  });

  it("shows the secret-detected error inline and keeps the editor open", async () => {
    const api = makeApi([], {
      saveMemory: vi.fn(async () => { throw new ApiError(400, "secret-detected", 'text matches secret rule "ghp_"'); })
    });
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-add"));
    fireEvent.change(screen.getByTestId("memory-form-text"), { target: { value: "ghp_secret" } });
    fireEvent.click(screen.getByTestId("memory-form-save"));
    expect(await screen.findByTestId("memory-form-error")).toBeTruthy();
    expect(screen.getByTestId("memory-form-error").textContent).toContain("secret-detected");
  });

  it("deletes through the confirmation modal", async () => {
    const api = makeApi([record()]);
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-delete:m-1"));
    fireEvent.click(screen.getByTestId("memory-delete-confirm"));
    await waitFor(() => expect(api.deleteMemory).toHaveBeenCalledWith("m-1"));
    expect(await screen.findByTestId("memory-empty")).toBeTruthy();
  });
});
~~~

- [ ] **Step 2: Run the tests to verify they fail**

~~~bash
pnpm --filter dsh-balbes-admin test -- MemoryPage.test.tsx
~~~
Expected: FAIL - cannot resolve ../src/pages/MemoryPage.

- [ ] **Step 3: Implement MemoryPage.tsx**

packages/frontend/dsh-balbes-admin/src/pages/MemoryPage.tsx:

~~~tsx
import { useCallback, useEffect, useState } from "react";
import type { AdminApi } from "../api/client";
import type { MemoryRecord, MemoryScope, MemoryType, WorkspaceProject } from "dsh-balbes-contracts";
import Modal from "../components/Modal";

const MEMORY_TYPES: MemoryType[] = ["fact", "preference", "decision", "note"];

const TYPE_LABELS: Record<MemoryType, string> = {
  fact: "факт",
  preference: "предпочтение",
  decision: "решение",
  note: "заметка"
};

const ORIGIN_LABELS: Record<MemoryRecord["origin"], string> = {
  owner: "владелец",
  agent: "агент"
};

type Level = MemoryScope;
type Editor = { mode: "create" } | { mode: "edit"; record: MemoryRecord };

function levelKey(level: Level): string {
  return level.kind === "global" ? "global" : "project:" + level.name;
}

function parseTags(raw: string): string[] {
  return raw.split(/[\s,]+/).map((tag) => tag.trim()).filter((tag) => tag !== "");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "неизвестная ошибка";
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ru-RU");
}

export default function MemoryPage({ api }: { api: AdminApi }) {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [level, setLevel] = useState<Level>({ kind: "global" });
  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MemoryType | "all">("all");
  const [tag, setTag] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [toDelete, setToDelete] = useState<MemoryRecord | null>(null);
  const [formType, setFormType] = useState<MemoryType>("note");
  const [formText, setFormText] = useState("");
  const [formTags, setFormTags] = useState("");
  const [formPinned, setFormPinned] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const res = await api.listMemory({
        scope: level,
        ...(type === "all" ? {} : { type }),
        ...(tag.trim() === "" ? {} : { tag: tag.trim() }),
        ...(pinnedOnly ? { pinned: true } : {}),
        ...(query.trim() === "" ? {} : { query: query.trim() })
      });
      setRecords(res.records);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [api, level, type, tag, pinnedOnly, query]);

  useEffect(() => {
    let cancelled = false;
    void api
      .listWorkspaces()
      .then((res) => { if (!cancelled) { setProjects(res.projects); setProjectsLoaded(true); } })
      .catch(() => { if (!cancelled) setProjectsLoaded(true); });
    return () => { cancelled = true; };
  }, [api]);

  // keep the selected project valid; fall back to the home level when it vanishes
  useEffect(() => {
    if (!projectsLoaded || level.kind !== "project") return;
    if (!projects.some((project) => project.name === level.name)) setLevel({ kind: "global" });
  }, [projectsLoaded, projects, level]);

  // reload on level/filter change; debounce only the free-text query
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, query === "" ? 0 : 300);
    return () => clearTimeout(timer);
  }, [load, query]);

  function openCreate(): void {
    setFormType("note");
    setFormText("");
    setFormTags("");
    setFormPinned(false);
    setFormError(null);
    setEditor({ mode: "create" });
  }

  function openEdit(record: MemoryRecord): void {
    setFormType(record.type);
    setFormText(record.text);
    setFormTags(record.tags.join(", "));
    setFormPinned(record.pinned);
    setFormError(null);
    setEditor({ mode: "edit", record });
  }

  async function saveEditor(): Promise<void> {
    if (editor === null || busy) return;
    if (formText.trim() === "") {
      setFormError("Текст не может быть пустым");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      if (editor.mode === "create") {
        await api.saveMemory({ scope: level, type: formType, text: formText, tags: parseTags(formTags), pinned: formPinned });
      } else {
        await api.saveMemory({ id: editor.record.id, type: formType, text: formText, tags: parseTags(formTags), pinned: formPinned });
      }
      setEditor(null);
      await load();
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (toDelete === null || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteMemory(toDelete.id);
      setToDelete(null);
      await load();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="memory-page" data-testid="memory-page">
      {actionError !== null && (
        <p className="form-error memory-banner" role="alert" data-testid="memory-action-error">{actionError}</p>
      )}

      <div className="memory-toolbar">
        <select
          className="memory-level"
          aria-label="Уровень памяти"
          data-testid="memory-level"
          value={levelKey(level)}
          onChange={(event) => {
            const value = event.target.value;
            setLevel(value === "global" ? { kind: "global" } : { kind: "project", name: value.slice("project:".length) });
          }}
        >
          <option value="global">Дом</option>
          {projects.map((project) => (
            <option key={project.name} value={"project:" + project.name}>{project.name}</option>
          ))}
        </select>

        <input
          className="ws-name-input memory-search"
          aria-label="Поиск по тексту"
          data-testid="memory-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Поиск по тексту..."
        />

        <select
          className="memory-type-filter"
          aria-label="Тип"
          data-testid="memory-type-filter"
          value={type}
          onChange={(event) => setType(event.target.value as MemoryType | "all")}
        >
          <option value="all">Все типы</option>
          {MEMORY_TYPES.map((value) => (
            <option key={value} value={value}>{TYPE_LABELS[value]}</option>
          ))}
        </select>

        <input
          className="ws-name-input memory-tag-filter"
          aria-label="Тег"
          data-testid="memory-tag-filter"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder="тег"
        />

        <label className="memory-pinned-toggle">
          <input
            type="checkbox"
            data-testid="memory-pinned-only"
            checked={pinnedOnly}
            onChange={(event) => setPinnedOnly(event.target.checked)}
          />
          Только пиннутые
        </label>

        <button type="button" className="btn" onClick={openCreate} data-testid="memory-add">+ Добавить запись</button>
        <button type="button" className="btn-ghost" onClick={() => void load()} data-testid="memory-refresh">Обновить</button>
      </div>

      {records === null ? (
        <div className="ws-center-state">
          {loadError !== null ? (
            <>
              <p className="form-error" role="alert" data-testid="memory-load-error">{loadError}</p>
              <button type="button" className="btn" onClick={() => void load()} data-testid="memory-load-retry">Повторить</button>
            </>
          ) : (
            <p className="ws-placeholder">Загрузка...</p>
          )}
        </div>
      ) : loadError !== null ? (
        <div className="ws-center-state">
          <p className="form-error" role="alert" data-testid="memory-load-error">{loadError}</p>
          <button type="button" className="btn" onClick={() => void load()} data-testid="memory-load-retry">Повторить</button>
        </div>
      ) : records.length === 0 ? (
        <p className="ws-placeholder" data-testid="memory-empty">Память пуста - добавьте первую запись</p>
      ) : (
        <ul className="memory-list" data-testid="memory-list">
          {records.map((record) => (
            <li className="memory-row" key={record.id} data-testid={"memory-row:" + record.id}>
              <div className="memory-row-head">
                <span className="memory-type">{TYPE_LABELS[record.type]}</span>
                {record.pinned && <span className="memory-pin" title="пиннуто">★</span>}
                <span className="memory-provenance">{ORIGIN_LABELS[record.origin]} · {formatTime(record.updatedAt)}</span>
                <span className="memory-row-actions">
                  <button type="button" className="btn-ghost" onClick={() => openEdit(record)} data-testid={"memory-edit:" + record.id}>Изменить</button>
                  <button type="button" className="btn-danger" onClick={() => setToDelete(record)} data-testid={"memory-delete:" + record.id}>Удалить</button>
                </span>
              </div>
              <p className="memory-row-text">{record.text}</p>
              {record.tags.length > 0 && (
                <div className="memory-tags">
                  {record.tags.map((value) => <span className="memory-tag" key={value}>{value}</span>)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editor !== null && (
        <Modal title={editor.mode === "create" ? "Добавить запись" : "Изменить запись"} onClose={() => setEditor(null)}>
          <p className="memory-scope-line">
            Уровень: <b>{level.kind === "global" ? "Дом" : level.name}</b>
            {editor.mode === "edit" && " (не меняется)"}
          </p>
          <select
            className="memory-type-select"
            aria-label="Тип записи"
            data-testid="memory-form-type"
            value={formType}
            onChange={(event) => setFormType(event.target.value as MemoryType)}
          >
            {MEMORY_TYPES.map((value) => <option key={value} value={value}>{TYPE_LABELS[value]}</option>)}
          </select>
          <textarea
            className="memory-form-text"
            aria-label="Текст записи"
            data-testid="memory-form-text"
            value={formText}
            onChange={(event) => setFormText(event.target.value)}
            rows={5}
          />
          <input
            className="ws-name-input"
            aria-label="Теги"
            data-testid="memory-form-tags"
            value={formTags}
            onChange={(event) => setFormTags(event.target.value)}
            placeholder="теги через запятую"
          />
          <label className="memory-pinned-toggle">
            <input
              type="checkbox"
              data-testid="memory-form-pinned"
              checked={formPinned}
              onChange={(event) => setFormPinned(event.target.checked)}
            />
            Пиннуть
          </label>
          {formError !== null && <p className="form-error" role="alert" data-testid="memory-form-error">{formError}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setEditor(null)} data-testid="memory-form-cancel">Отмена</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void saveEditor()} data-testid="memory-form-save">{busy ? "Сохраняется..." : "Сохранить"}</button>
          </div>
        </Modal>
      )}

      {toDelete !== null && (
        <Modal title="Удалить запись" onClose={() => setToDelete(null)}>
          <p className="ws-modal-text">Удалить запись «{toDelete.text.slice(0, 80)}» безвозвратно?</p>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setToDelete(null)} data-testid="memory-delete-cancel">Отмена</button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => void confirmDelete()} data-testid="memory-delete-confirm">{busy ? "Удаляется..." : "Удалить"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
~~~

- [ ] **Step 4: Add the styles**

Append to packages/frontend/dsh-balbes-admin/src/styles.css:

~~~css
/* memory page */
.memory-page { padding: 18px 20px; height: 100%; overflow: auto; }
.memory-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
.memory-level, .memory-type-filter, .memory-type-select {
  background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 8px;
}
.memory-search { flex: 1 1 220px; }
.memory-tag-filter { width: 140px; }
.memory-pinned-toggle { display: flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 12px; }
.memory-banner { margin: 0 0 12px; }
.memory-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.memory-row { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius); padding: 10px 12px; }
.memory-row-head { display: flex; align-items: center; gap: 8px; }
.memory-type { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--accent-hi); }
.memory-pin { color: var(--accent); }
.memory-provenance { color: var(--text-dim); font-size: 12px; }
.memory-row-actions { margin-left: auto; display: flex; gap: 6px; }
.memory-row-text { white-space: pre-wrap; margin: 8px 0 0; }
.memory-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.memory-tag { font-family: var(--mono); font-size: 11px; color: var(--text-dim); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; }
.memory-scope-line { color: var(--text-dim); margin: 0 0 10px; }
.memory-type-select { width: 100%; margin-bottom: 8px; }
.memory-form-text { width: 100%; margin-bottom: 8px; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; font: inherit; resize: vertical; }
~~~

- [ ] **Step 5: Run the tests and typecheck**

~~~bash
pnpm --filter dsh-balbes-admin test -- MemoryPage.test.tsx
pnpm --filter dsh-balbes-admin typecheck
~~~
Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add packages/frontend/dsh-balbes-admin/src/pages/MemoryPage.tsx packages/frontend/dsh-balbes-admin/src/styles.css packages/frontend/dsh-balbes-admin/tests/MemoryPage.test.tsx
git commit -m "feat(admin): add the Память page with filters and CRUD"
~~~

---

## Phase 4 - verification and close

### Task 8: Full verification and canon-audit

**Files:**
- No new files; verification and discrepancy closure.

**Interfaces:**
- Consumes: every earlier task.
- Produces: a green workspace and a canon audit.

- [ ] **Step 1: Run the whole workspace checks**

~~~bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
~~~
Expected: all pass.

- [ ] **Step 2: Run the REAL suites touched (with dsh on PATH)**

~~~bash
pnpm -r --if-present run build
cd packages/plugins/dsh-balbes-memory-admin && RUN_REAL=1 bash node_modules/.bin/vitest run tests/integration.test.ts
cd ../../plugins/dsh-balbes-memory && RUN_REAL=1 bash node_modules/.bin/vitest run tests/integration.test.ts
~~~
Expected: PASS; skipped only where dsh is absent.

- [ ] **Step 3: Invoke canon-audit**

Run the canon-audit skill on the memory topic and resolve any discrepancy it raises in docs/canon/DISCREPANCIES.md.

- [ ] **Step 4: Final commit**

~~~bash
git add -A
git commit -m "docs(canon): audit the p10b memory admin surface"
~~~

## Self-Review

- **Spec coverage:** contracts move -> Task 1; lazy service/503, forced origin, immutable scope, error mapping -> Task 2; no-secret echo -> Tasks 2/3; plugin packaging -> Tasks 3/4; profile row/installer/runbook/CI -> Task 4; UI placement/filters/provenance/modals/states -> Tasks 5-7; canon + audit -> Tasks 0/8. All spec sections have a task.
- **Placeholders:** none - every code and test step contains the real content.
- **Type consistency:** MemoryRecord/MemoryScope/MemoryType come from dsh-balbes-contracts in Tasks 1-7; registerMemoryRoutes(http, getService) and MemoryServiceLike are stable across Tasks 2-3; SPA method names listMemory/saveMemory/deleteMemory match across Tasks 5-7; page id "memory" matches Tasks 6-7.
- **Note:** Task 6 tests depend on MemoryPage.tsx from Task 7; run Tasks 5 -> 7 -> 6 if executing tasks individually, or the whole phase together.
