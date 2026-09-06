# Server Workspaces (Agent Home + Projects) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first step of the `p0-agent-workspaces` initiative: a server-side workspace entity (reserved agent home + user projects), an index-only registry at `$DSH_HOME/projects.json`, a bearer-only `/api/workspaces/{list,create,delete}` API surface, and an admin SPA page to manage projects.

**Architecture:** Filesystem is the source of truth (list = scan of `$DSH_HOME/projects/*`, home always present); `$DSH_HOME/projects.json` is a disposable metadata index (createdAt) reconciled on every list/write. A new standalone plugin package `dsh-balbes-workspaces` (pure domain module + functional Cordis plugin registering HTTP seats on `balbesHttp`) is inserted into the profile patch and copied into the profile's `node_modules` by install.sh and CI. The SPA gets a "Проекты" nav page (home section + project list/create/delete with `confirm`).

**Tech Stack:** TypeScript (strict, ESM), Cordis functional plugins (`name`/`inject`/`Config`/`apply`), `@deepseek-ai/schemastery`, `node:fs/promises`, vitest, React 18 + Vite + Testing Library, bash (install.sh), YAML (profile patch / CI).

**Spec:** `docs/superpowers/specs/2026-09-06-agent-workspaces-design.md` (authoritative; plan argues from it).

## Global Constraints

- Canon-first is done: living canon (ARCHITECTURE/GLOSSARY/OVERVIEW/ADMIN_UI) already describes this step; **do not edit `docs/canon/**`** and do not touch `future_plans/**` in this plan.
- dsh is a dependency, never a fork; installed `@deepseek-ai/*` are never edited; the plugin resolves `@deepseek-ai/*` upward to the profile mirror (do not add runtime deps to the plugin's `package.json`).
- Rule R-API-1: every `/api/*` request is POST-only; errors are `{error:{code,message}}`.
- Project name rule (verbatim from spec §3/§5): `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$`, length ≤ 64; no `/`, no `..`, no leading/trailing dot, no spaces. Name == directory name under `$DSH_HOME/projects/`.
- Paths: home = `$DSH_HOME/agent/` (reserved, auto-created, never deletable); projects root = `$DSH_HOME/projects/`; registry = `$DSH_HOME/projects.json` (mode 600, atomic tmp+rename write).
- Types: strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — never set an optional field to `undefined` explicitly); ESM; files kebab-case; code/comments English; UI copy Russian.
- REAL-composition tests are gated: run only when `RUN_REAL=1` AND a `dsh` executable exists (`describe.skipIf`), mirroring `packages/bundles/dsh-balbes-host/tests/integration.test.ts`. Unit tests stay hermetic (temp dirs, teardown cleanup).
- Every task ends with the checks it introduced passing and a commit (one change per commit, verb-first subject ≤ ~72 chars).

---

### Task 1: Workspace contract types in `dsh-balbes-contracts`

**Files:**
- Modify: `packages/contracts/src/index.ts` (append below `PromptResponse`/`ApiErrorBody` area)
- Test: `packages/contracts/tests/contracts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 5 plugin route handlers structurally, Task 8 SPA client):
  - `WorkspaceProject { name: string; path: string; createdAt?: string }`
  - `WorkspaceHome { path: string }`
  - `WorkspaceListRequest {}`, `WorkspaceListResponse { home: WorkspaceHome; projects: WorkspaceProject[] }`
  - `WorkspaceCreateRequest { name: string }`, `WorkspaceCreateResponse { project: WorkspaceProject }`
  - `WorkspaceDeleteRequest { name: string }`, `WorkspaceDeleteResponse {}`

- [ ] **Step 1: Write the failing test**

In `packages/contracts/tests/contracts.test.ts` append a compile-time/structural block. Read the file first; keep its existing style (likely `import type {...} from "../src/index.js"` + `satisfies` assertions):

```ts
import type {
  WorkspaceDeleteRequest,
  WorkspaceDeleteResponse,
  WorkspaceListRequest,
  WorkspaceListResponse,
  WorkspaceProject,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceHome
} from "../src/index.js";

// Workspace contracts — structural shape is the contract (R-API-1 + types win).
describe("workspace contracts", () => {
  it("shapes line up with the documented API", () => {
    const listReq: WorkspaceListRequest = {};
    const listRes: WorkspaceListResponse = {
      home: { path: "/home/u/.dsh/agent" },
      projects: [{ name: "alpha", path: "/home/u/.dsh/projects/alpha", createdAt: "2026-09-06T00:00:00.000Z" }]
    };
    const handMade: WorkspaceProject = { name: "hand", path: "/home/u/.dsh/projects/hand" }; // createdAt optional
    const createReq: WorkspaceCreateRequest = { name: "alpha" };
    const createRes: WorkspaceCreateResponse = {
      project: { name: "alpha", path: "/home/u/.dsh/projects/alpha", createdAt: "2026-09-06T00:00:00.000Z" }
    };
    const deleteReq: WorkspaceDeleteRequest = { name: "alpha" };
    const deleteRes: WorkspaceDeleteResponse = {};
    const home: WorkspaceHome = { path: "/home/u/.dsh/agent" };
    expect([listReq, listRes, handMade, createReq, createRes, deleteReq, deleteRes, home]).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dsh-balbes-contracts test`
Expected: FAIL — TS2305/import of `WorkspaceProject` etc. does not exist.

- [ ] **Step 3: Implement the types**

Append to `packages/contracts/src/index.ts`:

```ts
export interface WorkspaceProject {
  name: string;
  path: string;
  createdAt?: string; // ISO 8601; absent for hand-made dirs without a registry row
}
export interface WorkspaceHome {
  path: string;
}

export interface WorkspaceListRequest {}
export interface WorkspaceListResponse {
  home: WorkspaceHome;
  projects: WorkspaceProject[];
}
export interface WorkspaceCreateRequest {
  name: string;
}
export interface WorkspaceCreateResponse {
  project: WorkspaceProject;
}
export interface WorkspaceDeleteRequest {
  name: string;
}
export interface WorkspaceDeleteResponse {}
```

- [ ] **Step 4: Run the test to verify it passes + typecheck**

Run: `pnpm --filter dsh-balbes-contracts test && pnpm --filter dsh-balbes-contracts typecheck`
Expected: PASS both. (If the package lacks a `typecheck` script, run `pnpm --filter dsh-balbes-contracts build` instead — it type-checks via `tsc`.)

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/tests/contracts.test.ts
git commit -m "add workspace contract types to dsh-balbes-contracts"
```

---

### Task 2: Plugin package scaffold + domain module

**Files:**
- Create: `packages/plugins/dsh-balbes-workspaces/package.json`
- Create: `packages/plugins/dsh-balbes-workspaces/tsconfig.json`
- Create: `packages/plugins/dsh-balbes-workspaces/tsconfig.build.json`
- Create: `packages/plugins/dsh-balbes-workspaces/src/workspaces.ts`
- Test: `packages/plugins/dsh-balbes-workspaces/tests/workspaces.test.ts`

**Interfaces:**
- Consumes: nothing (pure Node, no Cordis).
- Produces (used by Task 3 plugin and Task 5 REAL test):
  - `PROJECT_NAME_RE: RegExp`
  - `validateProjectName(name: string): boolean`
  - `homeDir(dshHome: string): string` → `join(dshHome, "agent")`
  - `projectsRoot(dshHome: string): string` → `join(dshHome, "projects")`
  - `registryFile(dshHome: string): string` → `join(dshHome, "projects.json")`
  - `ensureHome(dshHome: string): Promise<string>`
  - `listWorkspaces(dshHome: string): Promise<{ home: { path: string }; projects: WorkspaceProject[] }>`
  - `createProject(dshHome: string, name: string): Promise<WorkspaceProject>`
  - `deleteProject(dshHome: string, name: string): Promise<void>`
  - `readRegistry(dshHome: string): Promise<RegistryData>` and `writeRegistry(dshHome: string, data: RegistryData): Promise<void>`
  - `WorkspaceError extends Error` with `code: "invalid-name" | "name-exists" | "not-found" | "registry-invalid"` and factory `workspaceError(code, message)`
  - `RegistryData { version: 1; projects: Record<string, { createdAt: string }> }`
  - Local structural `WorkspaceProject` (identical shape to the contract; do NOT import `dsh-balbes-contracts` — plugin must not take a workspace dependency)

- [ ] **Step 1: Create the package manifests**

`packages/plugins/dsh-balbes-workspaces/package.json`:

```json
{
  "name": "dsh-balbes-workspaces",
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

`packages/plugins/dsh-balbes-workspaces/tsconfig.build.json` (emit like the host bundle — `lib/` + `lib/types/`):

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

`packages/plugins/dsh-balbes-workspaces/tsconfig.json` (typecheck src + tests, no emit):

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests"]
}
```

- [ ] **Step 2: Write the failing domain tests**

Create `packages/plugins/dsh-balbes-workspaces/tests/workspaces.test.ts`. Use a temp DSH_HOME per test (`mkdtemp` in `beforeEach`, `rm` in `afterEach`). Key cases (write the full file):

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateProjectName,
  ensureHome,
  listWorkspaces,
  createProject,
  deleteProject,
  readRegistry,
  writeRegistry,
  homeDir,
  projectsRoot,
  registryFile,
  WorkspaceError
} from "../src/workspaces.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ws-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("validateProjectName", () => {
  it("accepts slugs and rejects unsafe names", () => {
    for (const ok of ["alpha", "my-proj_1", "a.b", "a1", "A-2"]) {
      expect(validateProjectName(ok), ok).toBe(true);
    }
    for (const bad of ["", ".", "..", ".alpha", "alpha.", "a..b", "a/b", "a b", "-x", "x-", "_x", "a".repeat(65)]) {
      expect(validateProjectName(bad), `name=${bad}`).toBe(false);
    }
  });
});

describe("ensureHome", () => {
  it("creates $DSH_HOME/agent idempotently", async () => {
    const first = await ensureHome(home);
    expect(first).toBe(homeDir(home));
    const again = await ensureHome(home);
    expect(again).toBe(homeDir(home));
    const s = await stat(homeDir(home));
    expect(s.isDirectory()).toBe(true);
  });
});

describe("registry", () => {
  it("readRegistry on a missing file returns an empty registry", async () => {
    const reg = await readRegistry(home);
    expect(reg).toEqual({ version: 1, projects: {} });
  });

  it("writeRegistry persists atomically and readRegistry parses it back", async () => {
    await writeRegistry(home, { version: 1, projects: { alpha: { createdAt: "2026-09-06T00:00:00.000Z" } } });
    const reg = await readRegistry(home);
    expect(reg.projects.alpha?.createdAt).toBe("2026-09-06T00:00:00.000Z");
    // atomic: no tmp leftovers
    const entries = await readFile(registryFile(home), "utf8");
    expect(entries).not.toContain(".tmp");
  });

  it("readRegistry fails loud on malformed content", async () => {
    await writeFile(registryFile(home), "{ not json", "utf8");
    await expect(readRegistry(home)).rejects.toThrow(WorkspaceError);
    await expect(readRegistry(home)).rejects.toMatchObject({ code: "registry-invalid" });
  });
});

describe("listWorkspaces", () => {
  it("returns the home plus an empty project list on a fresh home", async () => {
    const res = await listWorkspaces(home);
    expect(res.home.path).toBe(homeDir(home));
    expect(res.projects).toEqual([]);
    // the home dir exists after the list (self-heal before answering)
    await expect(stat(homeDir(home))).resolves.toBeTruthy();
  });

  it("returns hand-made directories and hides non-directories and dotfiles", async () => {
    await mkdir(join(home, "projects"), { recursive: true });
    await mkdir(join(home, "projects", "handmade"));
    await mkdir(join(home, "projects", ".hidden"));
    await writeFile(join(home, "projects", "file.txt"), "x");
    const res = await listWorkspaces(home);
    const names = res.projects.map((p) => p.name);
    expect(names).toContain("handmade");
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain("file.txt");
  });

  it("merges createdAt from the registry and leaves hand-made rows without it", async () => {
    await createProject(home, "server-made");
    await mkdir(join(home, "projects", "handmade"), { recursive: true });
    const res = await listWorkspaces(home);
    const byName = Object.fromEntries(res.projects.map((p) => [p.name, p]));
    expect(byName["server-made"]?.createdAt).toBeTruthy();
    expect(byName["handmade"]?.createdAt).toBeUndefined();
  });

  it("reconciles: prunes registry rows whose directory vanished", async () => {
    const created = await createProject(home, "gone");
    expect(created.name).toBe("gone");
    await rm(created.path, { recursive: true, force: true });
    const res = await listWorkspaces(home);
    expect(res.projects.map((p) => p.name)).not.toContain("gone");
    const reg = await readRegistry(home);
    expect(reg.projects.gone).toBeUndefined();
  });
});

describe("createProject", () => {
  it("creates an empty directory and upserts a registry row", async () => {
    const created = await createProject(home, "alpha");
    expect(created.path).toBe(join(home, "projects", "alpha"));
    expect(created.createdAt).toBeTruthy();
    const s = await stat(created.path);
    expect(s.isDirectory()).toBe(true);
  });

  it("rejects invalid names with invalid-name", async () => {
    await expect(createProject(home, "a/b")).rejects.toMatchObject({ code: "invalid-name" });
    await expect(createProject(home, "..")).rejects.toMatchObject({ code: "invalid-name" });
  });

  it("fails with name-exists when the directory already exists (incl. hand-made)", async () => {
    await mkdir(join(home, "projects", "alpha"), { recursive: true });
    await expect(createProject(home, "alpha")).rejects.toMatchObject({ code: "name-exists" });
  });
});

describe("deleteProject", () => {
  it("removes the directory and prunes the registry row", async () => {
    await createProject(home, "alpha");
    await deleteProject(home, "alpha");
    await expect(stat(join(home, "projects", "alpha"))).rejects.toThrow();
    const reg = await readRegistry(home);
    expect(reg.projects.alpha).toBeUndefined();
  });

  it("fails with not-found when the directory is missing", async () => {
    await expect(deleteProject(home, "alpha")).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses path-traversal names", async () => {
    await expect(deleteProject(home, "..")).rejects.toMatchObject({ code: "invalid-name" });
    await expect(deleteProject(home, "/etc")).rejects.toMatchObject({ code: "invalid-name" });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter dsh-balbes-workspaces test`
Expected: FAIL — `../src/workspaces.js` cannot be resolved.

- [ ] **Step 4: Implement the domain module**

Create `packages/plugins/dsh-balbes-workspaces/src/workspaces.ts`:

```ts
import { mkdir, readFile, readdir, rm, rename, stat, writeFile, chmod } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** Structural slice of the workspace contract (see dsh-balbes-contracts). */
export interface WorkspaceProject {
  name: string;
  path: string;
  createdAt?: string;
}
export interface WorkspaceHome {
  path: string;
}

export type WorkspaceErrorCode = "invalid-name" | "name-exists" | "not-found" | "registry-invalid";
export class WorkspaceError extends Error {
  constructor(public code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}
export function workspaceError(code: WorkspaceErrorCode, message: string): WorkspaceError {
  return new WorkspaceError(code, message);
}

export const PROJECT_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

/** Registry index shape: metadata only, never the source of truth. */
export interface RegistryData {
  version: 1;
  projects: Record<string, { createdAt: string }>;
}

export function validateProjectName(name: string): boolean {
  return typeof name === "string" && name.length > 0 && name.length <= 64 && PROJECT_NAME_RE.test(name) && !name.includes("..");
}

export function homeDir(dshHome: string): string {
  return join(dshHome, "agent");
}
export function projectsRoot(dshHome: string): string {
  return join(dshHome, "projects");
}
export function registryFile(dshHome: string): string {
  return join(dshHome, "projects.json");
}

/** The home always exists: mkdir -p, idempotent. */
export async function ensureHome(dshHome: string): Promise<string> {
  const dir = homeDir(dshHome);
  await mkdir(dir, { recursive: true });
  return dir;
}

function emptyRegistry(): RegistryData {
  return { version: 1, projects: {} };
}

export async function readRegistry(dshHome: string): Promise<RegistryData> {
  const file = registryFile(dshHome);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw workspaceError("registry-invalid", `registry ${file} unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw workspaceError("registry-invalid", `registry ${file} is not valid JSON`);
  }
  const record = parsed as { version?: unknown; projects?: unknown };
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    record.version !== 1 ||
    typeof record.projects !== "object" ||
    record.projects === null
  ) {
    throw workspaceError("registry-invalid", `registry ${file} misses required fields`);
  }
  const projects: Record<string, { createdAt: string }> = {};
  for (const [name, meta] of Object.entries(record.projects as Record<string, unknown>)) {
    const m = meta as { createdAt?: unknown };
    if (typeof m?.createdAt === "string") projects[name] = { createdAt: m.createdAt };
  }
  return { version: 1, projects };
}

export async function writeRegistry(dshHome: string, data: RegistryData): Promise<void> {
  const file = registryFile(dshHome);
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/** Keep only rows whose project directory still exists. */
async function reconcileRegistry(dshHome: string, data: RegistryData): Promise<RegistryData> {
  const root = projectsRoot(dshHome);
  const next: RegistryData = { version: 1, projects: {} };
  for (const [name, meta] of Object.entries(data.projects)) {
    try {
      const s = await stat(join(root, name));
      if (s.isDirectory()) next.projects[name] = meta;
    } catch {
      // row orphaned: drop it
    }
  }
  return next;
}

function isHidden(entry: string): boolean {
  return entry.startsWith(".");
}

/** Scan the projects root. Returns [] when the root does not exist yet. */
async function scanProjectDirs(dshHome: string): Promise<string[]> {
  const root = projectsRoot(dshHome);
  let entries: string[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = entries
    .filter((e) => e.isDirectory() && !isHidden(e.name))
    .map((e) => e.name)
    .sort();
  return names;
}

function withOptionalCreatedAt(name: string, path: string, createdAt?: string): WorkspaceProject {
  return createdAt === undefined ? { name, path } : { name, path, createdAt };
}

export async function listWorkspaces(dshHome: string): Promise<{ home: WorkspaceHome; projects: WorkspaceProject[] }> {
  const home = await ensureHome(dshHome);
  const reg = await readRegistry(dshHome);
  const names = await scanProjectDirs(dshHome);
  // Reconcile: rows whose directory vanished are cleaned from the FILE too
  // (spec: вычищаются при list), not just hidden from this response.
  const present = new Set(names);
  let changed = false;
  const cleaned: RegistryData = { version: 1, projects: {} };
  for (const [name, meta] of Object.entries(reg.projects)) {
    if (present.has(name)) cleaned.projects[name] = meta;
    else changed = true;
  }
  if (changed) await writeRegistry(dshHome, cleaned);
  const projects = names.map((name) => {
    const row = cleaned.projects[name];
    return withOptionalCreatedAt(name, join(projectsRoot(dshHome), name), row?.createdAt);
  });
  return { home: { path: home }, projects };
}

export async function createProject(dshHome: string, name: string): Promise<WorkspaceProject> {
  if (!validateProjectName(name)) {
    throw workspaceError("invalid-name", `invalid project name: ${name}`);
  }
  const root = projectsRoot(dshHome);
  const target = resolve(root, name);
  // containment: the resolved path must live directly under the projects root
  if (target !== join(root, name) || !target.startsWith(root + sep)) {
    throw workspaceError("invalid-name", `project name escapes the projects root: ${name}`);
  }
  const reg = await readRegistry(dshHome);
  const reconciled = await reconcileRegistry(dshHome, reg);
  try {
    await mkdir(target, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw workspaceError("name-exists", `project already exists: ${name}`);
    }
    throw error;
  }
  const createdAt = new Date().toISOString();
  reconciled.projects[name] = { createdAt };
  await writeRegistry(dshHome, reconciled);
  return withOptionalCreatedAt(name, target, createdAt);
}

export async function deleteProject(dshHome: string, name: string): Promise<void> {
  if (typeof name !== "string" || name === "" || name === "." || name === ".." || name.includes("/") || name.includes(sep) || isHidden(name)) {
    throw workspaceError("invalid-name", `invalid project name: ${name}`);
  }
  const root = projectsRoot(dshHome);
  const target = resolve(root, name);
  if (target !== join(root, name) || !target.startsWith(root + sep)) {
    throw workspaceError("invalid-name", `project name escapes the projects root: ${name}`);
  }
  try {
    const s = await stat(target);
    if (!s.isDirectory()) throw workspaceError("not-found", `project not found: ${name}`);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw workspaceError("not-found", `project not found: ${name}`);
  }
  await rm(target, { recursive: true, force: true });
  const reg = await readRegistry(dshHome);
  if (reg.projects[name] !== undefined) {
    delete reg.projects[name];
    await writeRegistry(dshHome, reg);
  }
}
```

Note: `resolve` is intentionally unused-fallback-safe; the `target !== join(...)` check plus `startsWith(root + sep)` blocks traversal. The dotfile ban on delete keeps UI/API names canonical while still letting list scan reveal (but not manage) dotfiles — consistent with the spec (create uses the slug; delete is safe by construction).

- [ ] **Step 5: Run the tests to verify they pass + typecheck**

Run: `pnpm --filter dsh-balbes-workspaces test && pnpm --filter dsh-balbes-workspaces typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/dsh-balbes-workspaces
git commit -m "add workspace domain module with registry index"
```

---

### Task 3: Functional plugin `balbes-workspaces` registering the three routes

**Files:**
- Create: `packages/plugins/dsh-balbes-workspaces/src/index.ts`
- Test: `packages/plugins/dsh-balbes-workspaces/tests/index.test.ts`

**Interfaces:**
- Consumes: `balbesHttp` (from Task structure — structural `{ post(path, auth, handler) }`), domain funcs from Task 2 (`ensureHome`, `listWorkspaces`, `createProject`, `deleteProject`, `WorkspaceError`, `validateProjectName`).
- Produces: plugin export `name = "balbes-workspaces"`, `inject = ["balbesHttp"]`, `Config` (schemastery `{ dshHome: z.string() }`), `apply(ctx, config)` registering `/api/workspaces/list|create|delete` as bearer seats.

- [ ] **Step 1: Write the failing wiring test**

Create `packages/plugins/dsh-balbes-workspaces/tests/index.test.ts` — registers the plugin against a fake `balbesHttp` and drives the handler closures (mirrors how `auth.ts` is unit-tested, but on the plugin's own wiring):

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, inject } from "../src/index.js";

interface Seat {
  path: string;
  auth: string;
  handler(req: unknown, res: unknown, body: unknown): Promise<void> | void;
}

let home: string;
let seats: Seat[];
let http: { post(path: string, auth: string, handler: Seat["handler"]): void };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ws-plugin-"));
  seats = [];
  http = {
    post(path, auth, handler) {
      seats.push({ path, auth, handler });
    }
  };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("balbes-workspaces plugin", () => {
  it("exposes name/inject/apply contract", () => {
    expect(name).toBe("balbes-workspaces");
    expect(inject).toEqual(["balbesHttp"]);
    expect(typeof apply).toBe("function");
  });

  it("registers the three bearer routes and ensures the home at apply time", async () => {
    const ctx = {
      get(key: string): unknown {
        return key === "balbesHttp" ? http : undefined;
      },
      logger: { warn(_m: string): void {} }
    };
    apply(ctx as never, { dshHome: home });
    expect(seats.map((s) => s.path).sort()).toEqual([
      "/api/workspaces/create",
      "/api/workspaces/delete",
      "/api/workspaces/list"
    ]);
    for (const seat of seats) expect(seat.auth).toBe("bearer");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dsh-balbes-workspaces test`
Expected: FAIL — `../src/index.js` cannot be resolved.

- [ ] **Step 3: Implement the plugin**

Create `packages/plugins/dsh-balbes-workspaces/src/index.ts`:

```ts
import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { ensureHome, listWorkspaces, createProject, deleteProject, WorkspaceError } from "./workspaces.js";

export const name = "balbes-workspaces";
export const inject = ["balbesHttp"];
export const Config = z.object({ dshHome: z.string() });

interface HttpSeatLike {
  post(path: string, auth: "public" | "bearer", handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void): void;
}
interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function send(res: ResLike, status: number, body: unknown): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

export function apply(ctx: {
  get(key: string): unknown;
  logger: { warn(m: string): void };
}, config: { dshHome?: string }): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-workspaces: balbesHttp service missing; routes not registered");
    return;
  }
  // resolve the data home the same way auth/static do (config wins, env falls back)
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");

  // The home must exist from boot onward; a failure is logged, never fatal.
  ensureHome(dshHome).catch((error: unknown) => {
    ctx.logger.warn(`balbes-workspaces: ensureHome failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  http.post("/api/workspaces/list", "bearer", async (_req, res) => {
    try {
      const result = await listWorkspaces(dshHome);
      send(res, 200, result);
    } catch (error) {
      send(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  http.post("/api/workspaces/create", "bearer", async (_req, res, body) => {
    const b = body as { name?: unknown };
    const rawName = typeof b?.name === "string" ? b.name : "";
    try {
      const project = await createProject(dshHome, rawName);
      send(res, 200, { project });
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const status = error.code === "invalid-name" ? 400 : error.code === "name-exists" ? 409 : 500;
        send(res, status, { error: { code: error.code, message: error.message } });
        return;
      }
      send(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  http.post("/api/workspaces/delete", "bearer", async (_req, res, body) => {
    const b = body as { name?: unknown };
    const rawName = typeof b?.name === "string" ? b.name : "";
    try {
      await deleteProject(dshHome, rawName);
      send(res, 200, {});
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const status = error.code === "invalid-name" ? 400 : error.code === "not-found" ? 404 : 500;
        send(res, status, { error: { code: error.code, message: error.message } });
        return;
      }
      send(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
    }
  });
}
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `pnpm --filter dsh-balbes-workspaces test && pnpm --filter dsh-balbes-workspaces typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-workspaces/src/index.ts packages/plugins/dsh-balbes-workspaces/tests/index.test.ts
git commit -m "add balbes-workspaces plugin with workspace api routes"
```

---

### Task 4: Profile patch insert + install.sh/CI packaging for the new plugin

**Files:**
- Modify: `profiles/balbes/cordis.patch.yml`
- Modify: `scripts/install.sh` (add `copy_workspaces_into_profile` next to `copy_host_into_profile`, call it after it, and update the summary/help text that enumerates copied pieces)
- Modify: `.github/workflows/ci.yml` (sync step: copy the built plugin into the profile's node_modules before `--dump-config`)

**Interfaces:**
- Consumes: built `dsh-balbes-workspaces` package (Task 2/3 artifacts).
- Produces: profile that composes `balbes-workspaces` (visible via `dsh --profile balbes --dump-config`), matching the design spec §6.

- [ ] **Step 1: Insert the plugin into the profile patch**

Rewrite `profiles/balbes/cordis.patch.yml` from `[]` to:

```yaml
# balbes profile patch layer: standalone plugins over the bundle patches.
# The host bundle patch (dsh-balbes-host/cordis.patch.yml) inserts its own
# plugins; this layer adds plugins that live in separate packages. Applies
# after the bundle patches (profile patch is the outermost layer).

- insert:
    - id: balbes-workspaces
      name: 'dsh-balbes-workspaces'
```

- [ ] **Step 2: Extend install.sh to copy the plugin into the profile**

In `scripts/install.sh`, right after the `copy_host_into_profile()` function definition, add a sibling (read the file around the function first to copy its exact house style):

```bash
# copy_workspaces_into_profile — собранный плагин воркспейсов реальным
# каталогом в node_modules профиля (тот же рецепт, что и host).
copy_workspaces_into_profile() {
    local profile_dir="$DSH_HOME/profiles/$PROFILE_NAME"
    local src="$REPO_DIR/packages/plugins/dsh-balbes-workspaces"
    local dst="$profile_dir/node_modules/dsh-balbes-workspaces"
    if [[ ! -d "$src/lib" ]]; then
        die "workspaces plugin not built at $src/lib — build step failed"
    fi
    mkdir -p "$profile_dir/node_modules"
    rm -rf "$dst"
    cp -R "$src" "$dst"
    rm -f "$dst/tsconfig.json" "$dst/tsconfig.build.json"
    rm -rf "$dst/tests" "$dst/src" "$dst/lib/types"
    chmod -R u+rwX,go-w "$dst"
    info "Workspaces plugin copied into $dst"
}
```

Then, in the main flow (find where `copy_host_into_profile` is invoked — likely inside an `install_profile`/`deploy` function) add the call immediately after it:

```bash
    copy_host_into_profile
    copy_workspaces_into_profile
```

Update the file's top comment (the enumerated list that names what gets copied: `syncs profiles/balbes ... copies the built host ...`) to also mention the workspaces plugin, and the summary text if it lists artifacts.

- [ ] **Step 3: Extend CI to copy the plugin**

In `.github/workflows/ci.yml`, in the "Sync balbes profile + host bundle into DSH_HOME" step, after the existing `cp -R packages/bundles/dsh-balbes-host ...` block, add:

```yaml
          mkdir -p "$HOME/.dsh/profiles/balbes/node_modules"
          cp -R packages/plugins/dsh-balbes-workspaces "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-workspaces"
          rm -f "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-workspaces/tsconfig.json" \
                "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-workspaces/tsconfig.build.json"
          rm -rf "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-workspaces/tests" \
                 "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-workspaces/src" \
                 "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-workspaces/lib/types"
```

(Also add the same two `mkdir`/`cp` lines guarded to run after `cp -R profiles/balbes ...` if the step is restructured; read the step as it is now and extend it minimally.)

- [ ] **Step 4: Verify locally (composition)**

Build + compose against a scratch `DSH_HOME` (must NOT touch a real dsh install):

```bash
cd /Volumes/Maxon/dsh-balbes-server
pnpm install >/dev/null 2>&1
node scripts/link-core.mjs
pnpm -r --if-present run build
H=$(mktemp -d)
mkdir -p "$H/profiles"
cp -R profiles/balbes "$H/profiles/balbes"
mkdir -p "$H/profiles/balbes/node_modules"
cp -R packages/bundles/dsh-balbes-host "$H/profiles/balbes/node_modules/dsh-balbes-host"
cp -R packages/plugins/dsh-balbes-workspaces "$H/profiles/balbes/node_modules/dsh-balbes-workspaces"
DSH_HOME="$H" dsh --profile balbes --dump-config | grep -q "balbes-workspaces" && echo COMPOSES_OK
rm -rf "$H"
```

Expected: prints `COMPOSES_OK` (dsh must be on PATH; if not installed locally, note it and rely on CI — do not fake the result).

- [ ] **Step 5: Validate scripts syntax + commit**

Run: `bash -n scripts/install.sh` then

```bash
git add profiles/balbes/cordis.patch.yml scripts/install.sh .github/workflows/ci.yml
git commit -m "wire balbes-workspaces into profile, installer and CI"
```

---

### Task 5: REAL composition test for the plugin

**Files:**
- Create: `packages/plugins/dsh-balbes-workspaces/tests/fixtures/balbes-workspaces-profile/package.json`
- Create: `packages/plugins/dsh-balbes-workspaces/tests/fixtures/balbes-workspaces-profile/cordis.patch.yml`
- Test: `packages/plugins/dsh-balbes-workspaces/tests/integration.test.ts`

**Interfaces:**
- Consumes: built `dsh-balbes-workspaces` lib + built `dsh-balbes-host` bundle (repo build order: run `pnpm -r run build` first, or the test builds both defensively like the host suite does), global `dsh` CLI.
- Produces: end-to-end proof that a composed profile answers `/api/workspaces/*` over HTTP with auth, disk effects, and error codes.

- [ ] **Step 1: Create the fixture profile**

`tests/fixtures/balbes-workspaces-profile/package.json`:

```json
{
  "name": "dsh-profile-balbes-workspaces-test",
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

`tests/fixtures/balbes-workspaces-profile/cordis.patch.yml`:

```yaml
- insert:
    - id: balbes-workspaces
      name: 'dsh-balbes-workspaces'
```

- [ ] **Step 2: Write the REAL test**

Create `packages/plugins/dsh-balbes-workspaces/tests/integration.test.ts` modeled on `packages/bundles/dsh-balbes-host/tests/integration.test.ts` (read that file first; reuse its helpers pattern: `buildHost`-style tsc invocation, `postJson`, `waitForHealth`, `freePort`, `hasDsh`):

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url)); // tests/ dir
const pkgRoot = join(here, ".."); // dsh-balbes-workspaces package root
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const fixtureProfile = join(here, "fixtures", "balbes-workspaces-profile");

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

/** Compile src -> lib for both our plugin and the host bundle (tsc straight from the store). */
async function buildPackages(): Promise<void> {
  // host has a single tsconfig.json (build = tsc -p tsconfig.json); the plugin
  // uses tsconfig.build.json so its tsconfig.json can typecheck src + tests.
  const configs: Array<[string, string]> = [
    [pkgRoot, "tsconfig.build.json"],
    [hostPkgRoot, "tsconfig.json"]
  ];
  for (const [root, cfg] of configs) {
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    await execFileP(process.execPath, [tsc, "-p", join(root, cfg)], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024
    });
  }
}

async function postJson(url: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function waitForHealth(port: number, child: ReturnType<typeof spawn>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dsh exited early (code ${child.exitCode}) before serving health`);
    }
    try {
      const { status, json } = await postJson(`http://127.0.0.1:${port}/api/health`, {});
      if (status === 200 && (json as { ok?: boolean }).ok === true) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

const runReal = (process.env.RUN_REAL ?? "").trim() !== "";
const realEnabled = runReal ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (workspaces API)", () => {
  let home: string | undefined;
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    await buildPackages();
    port = await freePort();
    home = await mkdtemp(join(tmpdir(), "balbes-ws-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, "balbes-ws-test"), { recursive: true });
    const nm = join(profiles, "balbes-ws-test", "node_modules");
    await mkdir(nm, { recursive: true });
    // copy built host bundle
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    // copy built plugin
    await cp(join(pkgRoot, "lib"), join(nm, "dsh-balbes-workspaces", "lib"), { recursive: true });
    await cp(join(pkgRoot, "package.json"), join(nm, "dsh-balbes-workspaces", "package.json"));
    // credentials
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(home, creds);
  }, 240_000);

  afterAll(async () => {
    if (child !== null && child.exitCode === null) child.kill("SIGKILL");
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  }, 60_000);

  async function bootServer(): Promise<string> {
    if (home === undefined) throw new Error("home not initialized");
    const env = {
      ...process.env,
      DSH_HOME: home,
      BALBES_PORT: String(port),
      DSH_TELEMETRY_DISABLED: "1"
    };
    child = spawn("dsh", ["--profile", "balbes-ws-test"], { env, cwd: home, stdio: "ignore" });
    await waitForHealth(port, child);
    const loginRes = await postJson(`http://127.0.0.1:${port}/api/auth/login`, { login, password });
    expect(loginRes.status, JSON.stringify(loginRes.json)).toBe(200);
    return (loginRes.json as { token: string }).token;
  }

  async function stopServer(): Promise<void> {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child?.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      ]);
    }
    child = null;
  }

  it("dump-config composes balbes-workspaces", async () => {
    if (home === undefined) throw new Error("home not initialized");
    const { stdout } = await execFileP("dsh", ["--profile", "balbes-ws-test", "--dump-config"], {
      env: { ...process.env, DSH_HOME: home },
      maxBuffer: 16 * 1024 * 1024
    });
    expect(stdout).toContain("balbes-workspaces");
  }, 120_000);

  it("workspaces API: auth, list/create/delete, error codes and disk effects", async () => {
    if (home === undefined) throw new Error("home not initialized");
    const base = `http://127.0.0.1:${port}`;
    try {
      const token = await bootServer();

      // 401 without a token
      const anon = await postJson(`${base}/api/workspaces/list`, {});
      expect(anon.status).toBe(401);

      // list on a fresh home: home + empty projects, and $DSH_HOME/agent exists
      const empty = await postJson(`${base}/api/workspaces/list`, {}, token);
      expect(empty.status, JSON.stringify(empty.json)).toBe(200);
      const emptyBody = empty.json as { home?: { path?: string }; projects?: unknown[] };
      expect(emptyBody.home?.path).toBe(join(home, "agent"));
      expect(emptyBody.projects).toEqual([]);
      expect(existsSync(join(home, "agent"))).toBe(true);

      // create
      const created = await postJson(`${base}/api/workspaces/create`, { name: "alpha" }, token);
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      expect((created.json as { project?: { name?: string; path?: string } }).project?.name).toBe("alpha");
      expect(existsSync(join(home, "projects", "alpha"))).toBe(true);

      // duplicate create -> 409 name-exists
      const dup = await postJson(`${base}/api/workspaces/create`, { name: "alpha" }, token);
      expect(dup.status).toBe(409);
      expect((dup.json as { error?: { code?: string } }).error?.code).toBe("name-exists");

      // invalid name -> 400 invalid-name
      const bad = await postJson(`${base}/api/workspaces/create`, { name: "a/b" }, token);
      expect(bad.status).toBe(400);
      expect((bad.json as { error?: { code?: string } }).error?.code).toBe("invalid-name");

      // list now contains alpha with createdAt
      const afterCreate = await postJson(`${base}/api/workspaces/list`, {}, token);
      const projects = (afterCreate.json as { projects?: Array<{ name?: string; createdAt?: string }> }).projects ?? [];
      expect(projects.map((p) => p.name)).toEqual(["alpha"]);
      expect(projects[0]?.createdAt).toBeTruthy();

      // delete
      const deleted = await postJson(`${base}/api/workspaces/delete`, { name: "alpha" }, token);
      expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
      expect(existsSync(join(home, "projects", "alpha"))).toBe(false);

      // delete of a missing project -> 404 not-found
      const missing = await postJson(`${base}/api/workspaces/delete`, { name: "alpha" }, token);
      expect(missing.status).toBe(404);
      expect((missing.json as { error?: { code?: string } }).error?.code).toBe("not-found");

      // traversal names are refused
      const traversal = await postJson(`${base}/api/workspaces/delete`, { name: ".." }, token);
      expect(traversal.status).toBe(400);
    } finally {
      await stopServer();
    }
  }, 240_000);
});
```

- [ ] **Step 3: Run the REAL suite**

Build the repo packages first, then:

Run: `pnpm --filter dsh-balbes-workspaces run build && RUN_REAL=1 pnpm --filter dsh-balbes-workspaces test`
Expected: PASS (skip when no `dsh` CLI / no `RUN_REAL` — that is the intended hermetic gate).

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/dsh-balbes-workspaces/tests
git commit -m "add real composition test for workspace api"
```

---

### Task 6: API contracts registry (`docs/api-contracts.md`)

**Files:**
- Modify: `docs/api-contracts.md` (append three contract blocks after `prompt`)

**Interfaces:**
- Consumes: spec §4 wording (already read above).
- Produces: human-readable registry matching the types from Task 1 — rule: registry and types must not diverge.

- [ ] **Step 1: Append the three contracts**

Append to `docs/api-contracts.md`:

```markdown
### workspaces.list — список воркспейсов (дом + проекты)
- method: POST
- path: /api/workspaces/list
- auth: bearer
- request: `{}`
- response: `{home: {path: string}, projects: [{name: string, path: string, createdAt?: string(ISO)}]}`
- errors: 401, 500 (нечитаемый корень/реестр)
- notes: каталог — источник правды: дом `$DSH_HOME/agent/` всегда в ответе,
  проекты — скан `$DSH_HOME/projects/*` (только каталоги, без скрытых);
  `createdAt` берётся из реестра-индекса `$DSH_HOME/projects.json`, если строка
  есть; осиротевшие строки реестра вычищаются при list.

### workspaces.create — создать проект (пустой каталог)
- method: POST
- path: /api/workspaces/create
- auth: bearer
- request: `{name: string}`
- response: `{project: {name: string, path: string, createdAt: string(ISO)}}`
- errors: 400 `invalid-name` (нарушение slug-правила), 409 `name-exists`
  (каталог уже существует — включая созданный руками), 401, 500
- notes: имя — строгий slug `[A-Za-z0-9._-]` ≤ 64 без `/`, `..`, пробелов и
  ведущих/хвостовых точек; создаёт пустой каталог
  `$DSH_HOME/projects/<имя>/` + upsert строки реестра (`createdAt: now`).

### workspaces.delete — удалить проект (каталог + запись)
- method: POST
- path: /api/workspaces/delete
- auth: bearer
- request: `{name: string}`
- response: `{}`
- errors: 400 `invalid-name` (в т.ч. traversal-имена), 404 `not-found`
  (каталога нет), 401, 500
- notes: рекурсивно удаляет каталог проекта + prune строки реестра.
  Подтверждение — на стороне UI. Дом удалить нельзя: имя — один сегмент пути,
  проверка containment под `$DSH_HOME/projects/`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/api-contracts.md
git commit -m "document workspace api contracts in the registry"
```

---

### Task 7: SPA API client methods

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/api/client.ts`
- Test: `packages/frontend/dsh-balbes-admin/tests/client.test.ts`

**Interfaces:**
- Consumes: contract types from Task 1 (`WorkspaceListResponse`, `WorkspaceCreateRequest`, `WorkspaceCreateResponse`, `WorkspaceDeleteRequest`, `WorkspaceDeleteResponse`).
- Produces: `AdminApi.listWorkspaces(): Promise<WorkspaceListResponse>`, `AdminApi.createWorkspace(name: string): Promise<WorkspaceCreateResponse>`, `AdminApi.deleteWorkspace(name: string): Promise<WorkspaceDeleteResponse>` (used by Task 8 page).

- [ ] **Step 1: Write the failing client tests**

Append to `packages/frontend/dsh-balbes-admin/tests/client.test.ts` (keep existing `mockFetchOnce` helper style):

```ts
it("listWorkspaces POSTs to /api/workspaces/list with the token", async () => {
  localStorage.setItem(TOKEN_KEY, "tok-1");
  const body = { home: { path: "/h/agent" }, projects: [{ name: "a", path: "/h/projects/a", createdAt: "2026-09-06T00:00:00.000Z" }] };
  const fetchMock = mockFetchOnce(200, body);
  vi.stubGlobal("fetch", fetchMock);
  const api = createApiClient();
  const res = await api.listWorkspaces();
  expect(res.projects[0]?.name).toBe("a");
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/workspaces/list");
  expect(init.method).toBe("POST");
  expect(init.headers).toMatchObject({ authorization: "Bearer tok-1" });
});

it("createWorkspace and deleteWorkspace send the name", async () => {
  localStorage.setItem(TOKEN_KEY, "tok-1");
  const created = { project: { name: "a", path: "/h/projects/a", createdAt: "2026-09-06T00:00:00.000Z" } };
  vi.stubGlobal("fetch", mockFetchOnce(200, created));
  const api = createApiClient();
  const res = await api.createWorkspace("a");
  expect(res.project.name).toBe("a");

  vi.stubGlobal("fetch", mockFetchOnce(200, {}));
  await api.deleteWorkspace("a");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL — `api.listWorkspaces is not a function`.

- [ ] **Step 3: Implement the client methods**

In `packages/frontend/dsh-balbes-admin/src/api/client.ts`, extend the type import list and the `AdminApi` interface and `createApiClient()` return object:

```ts
import type {
  HealthResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  PromptRequest,
  PromptResponse,
  ApiErrorBody,
  WorkspaceListResponse,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResponse
} from "dsh-balbes-contracts";
```

In `AdminApi` add:

```ts
  listWorkspaces(): Promise<WorkspaceListResponse>;
  createWorkspace(name: string): Promise<WorkspaceCreateResponse>;
  deleteWorkspace(name: string): Promise<WorkspaceDeleteResponse>;
```

In the returned object add:

```ts
    listWorkspaces: () => guard(request<WorkspaceListResponse>("/api/workspaces/list", {})),
    createWorkspace: (name) => guard(request<WorkspaceCreateResponse>("/api/workspaces/create", { name } satisfies WorkspaceCreateRequest)),
    deleteWorkspace: (name) => guard(request<WorkspaceDeleteResponse>("/api/workspaces/delete", { name } satisfies WorkspaceDeleteRequest))
```

- [ ] **Step 4: Run tests + typecheck + build the SPA**

Run: `pnpm --filter dsh-balbes-admin test && pnpm --filter dsh-balbes-admin typecheck && pnpm --filter dsh-balbes-admin build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/api/client.ts packages/frontend/dsh-balbes-admin/tests/client.test.ts
git commit -m "add workspace api methods to the admin client"
```

---

### Task 8: SPA — Sidebar navigation + Workspaces page

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/App.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/components/Sidebar.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/components/Topbar.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/styles.css` (page/list/form styles following existing tokens)
- Create: `packages/frontend/dsh-balbes-admin/src/pages/WorkspacesPage.tsx`
- Test: `packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/tests/App.test.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/tests/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `AdminApi` from Task 7 (`listWorkspaces/createWorkspace/deleteWorkspace`).
- Produces: navigable "Проекты" view with home section + project CRUD UI.

- [ ] **Step 1: Write the failing page test**

Create `packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import WorkspacesPage from "../src/pages/WorkspacesPage";
import type { AdminApi } from "../src/api/client";
import type { WorkspaceListResponse } from "dsh-balbes-contracts";

const listBody: WorkspaceListResponse = {
  home: { path: "/home/u/.dsh/agent" },
  projects: [{ name: "alpha", path: "/home/u/.dsh/projects/alpha", createdAt: "2026-09-06T00:00:00.000Z" }]
};

function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    health: vi.fn(),
    login: vi.fn(),
    me: vi.fn(),
    prompt: vi.fn(),
    onUnauthorized: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue(listBody),
    createWorkspace: vi.fn().mockResolvedValue({ project: { name: "beta", path: "/h/projects/beta", createdAt: "2026-09-06T00:00:00.000Z" } }),
    deleteWorkspace: vi.fn().mockResolvedValue({}),
    ...overrides
  } as AdminApi;
}

describe("WorkspacesPage", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the home section and the project list", async () => {
    render(<WorkspacesPage api={makeApi()} />);
    expect(await screen.findByText("Дом агента")).toBeTruthy();
    expect(screen.getByText("/home/u/.dsh/agent")).toBeTruthy();
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByText("Проекты")).toBeTruthy();
  });

  it("creates a project from the form and refreshes the list", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    fireEvent.change(screen.getByTestId("workspace-name-input"), { target: { value: "beta" } });
    fireEvent.click(screen.getByTestId("workspace-create-submit"));
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledWith("beta"));
    await waitFor(() => expect(api.listWorkspaces).toHaveBeenCalledTimes(2));
  });

  it("deletes a project after confirm and refreshes", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    fireEvent.click(screen.getByTestId("workspace-delete-alpha"));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.deleteWorkspace).toHaveBeenCalledWith("alpha"));
    await waitFor(() => expect(api.listWorkspaces).toHaveBeenCalledTimes(2));
  });

  it("does not delete when confirm is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    fireEvent.click(screen.getByTestId("workspace-delete-alpha"));
    expect(api.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("renders a dash for a project without createdAt", async () => {
    const noDate: WorkspaceListResponse = {
      home: { path: "/h/agent" },
      projects: [{ name: "hand", path: "/h/projects/hand" }]
    };
    const api = makeApi({ listWorkspaces: vi.fn().mockResolvedValue(noDate) });
    render(<WorkspacesPage api={api} />);
    expect(await screen.findByText("—")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the page test to verify it fails**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL — `../src/pages/WorkspacesPage` cannot be resolved.

- [ ] **Step 3: Implement the page**

Create `packages/frontend/dsh-balbes-admin/src/pages/WorkspacesPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import type { AdminApi } from "../api/client";
import type { WorkspaceListResponse, WorkspaceProject } from "dsh-balbes-contracts";

interface WorkspacesPageProps {
  api: AdminApi;
}

function formatDate(iso?: string): string {
  return iso === undefined ? "—" : new Date(iso).toLocaleString("ru-RU");
}

/**
 * Workspaces page: the reserved agent home shown as its own section, then the
 * project list with a create form and confirm-gated delete per project.
 */
export default function WorkspacesPage({ api }: WorkspacesPageProps) {
  const [data, setData] = useState<WorkspaceListResponse | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setData(await api.listWorkspaces());
  }, [api]);

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : "list failed"));
  }, [refresh]);

  async function handleCreate(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createWorkspace(trimmed);
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(project: WorkspaceProject): Promise<void> {
    const ok = window.confirm(`Удалить проект «${project.name}»? Каталог ${project.path} будет удалён безвозвратно.`);
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteWorkspace(project.name);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  if (data === null) {
    return (
      <div className="page">
        <h1>Воркспейсы</h1>
        <p className="lead">Загрузка…</p>
      </div>
    );
  }

  return (
    <div className="page" data-testid="workspaces-page">
      <h1>Воркспейсы</h1>
      <p className="lead">Дом агента и проекты на сервере — каталоги в $DSH_HOME.</p>

      <section className="ws-section">
        <h2>Дом агента</h2>
        <div className="card ws-home-card">
          <code data-testid="workspace-home-path">{data.home.path}</code>
          <span className="chip">зарезервирован</span>
        </div>
      </section>

      <section className="ws-section">
        <h2>Проекты</h2>
        {error !== null && (
          <p className="form-error" role="alert" data-testid="workspace-error">
            {error}
          </p>
        )}
        <form
          className="ws-create"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <input
            data-testid="workspace-name-input"
            className="ws-name-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="имя проекта (a-z, 0-9, . _ -)"
            aria-label="Имя нового проекта"
          />
          <button type="submit" className="btn" disabled={busy} data-testid="workspace-create-submit">
            {busy ? "Создаётся…" : "Создать проект"}
          </button>
        </form>

        {data.projects.length === 0 ? (
          <p className="ws-empty">Проектов пока нет.</p>
        ) : (
          <ul className="ws-list">
            {data.projects.map((project) => (
              <li className="card ws-project" key={project.name} data-testid={`workspace-project-${project.name}`}>
                <div className="ws-project-main">
                  <code className="ws-project-name">{project.name}</code>
                  <code className="ws-project-path">{project.path}</code>
                </div>
                <span className="ws-project-date">{formatDate(project.createdAt)}</span>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => void handleDelete(project)}
                  disabled={busy}
                  data-testid={`workspace-delete-${project.name}`}
                >
                  Удалить
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Implement navigation (App, Sidebar, Topbar)**

`Sidebar.tsx`: turn nav items with an `id` into real buttons and add props:

```tsx
interface NavItem {
  id?: string;
  label: string;
  soon: boolean;
}

interface SidebarProps {
  active: string;
  onNavigate(id: string): void;
}
```

Render each item with an `id` as:

```tsx
<button
  type="button"
  className={classes.join(" ")}
  key={item.label}
  onClick={() => item.id !== undefined && onNavigate(item.id)}
  aria-current={isActive ? "page" : undefined}
>
  {item.label}
  {item.soon && <span className="soon">скоро</span>}
</button>
```

Change the NAV_GROUPS «Проекты» entry from `{ label: "Проекты", soon: true }` to `{ id: "workspaces", label: "Проекты", soon: false }`.

`Topbar.tsx`: accept a `title` prop and render it in the crumb:

```tsx
interface TopbarProps {
  title: string;
  onLogout: () => void;
}
// inside: balbes / <b>{title}</b>
```

`App.tsx`: introduce a view union and render pages by it:

```tsx
import WorkspacesPage from "./pages/WorkspacesPage";
type View = "loading" | "login" | "main";
type Page = "test" | "workspaces";
// add state: const [page, setPage] = useState<Page>("test");
// on successful login: setPage("test")
// main view render:
<Sidebar active={page} onNavigate={setPage} />
<main className="content">
  <Topbar title={page === "test" ? "Тестовая страница" : "Проекты"} onLogout={handleLogout} />
  {page === "test" ? <TestPage api={api} /> : <WorkspacesPage api={api} />}
</main>
```

Add minimal styles to `styles.css` (following existing tokens — read the file for `:root` var names before adding). Note: nav items become `<button>`s, so reset their chrome first:

```css
/* sidebar items are buttons now */
button.nav-item { font: inherit; color: inherit; background: none; border: none; padding: 0; cursor: pointer; text-align: left; }

/* workspaces page */
.ws-section { margin-top: 18px; }
.ws-home-card { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ws-create { display: flex; gap: 8px; margin: 10px 0 14px; }
.ws-name-input { flex: 1; }
.ws-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ws-project { display: flex; align-items: center; gap: 12px; }
.ws-project-main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.ws-project-name { color: var(--text); }
.ws-project-path { color: var(--text-dim); font-size: 12px; }
.ws-project-date { color: var(--text-dim); font-size: 12px; white-space: nowrap; }
.ws-empty { color: var(--text-dim); }
.btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
.btn-danger:hover { background: var(--danger); color: var(--bg); }
```

- [ ] **Step 5: Update existing tests for the new props**

`tests/Sidebar.test.tsx`: pass `onNavigate={() => {}}`; assert «Проекты» is now clickable (not ghost) and clicking fires navigate:

```tsx
it("fires onNavigate for live items", () => {
  const onNavigate = vi.fn();
  render(<Sidebar active="test" onNavigate={onNavigate} />);
  fireEvent.click(screen.getByText("Проекты"));
  expect(onNavigate).toHaveBeenCalledWith("workspaces");
});
```

(Import `vi` and `fireEvent` at the top; keep the ghost assertion but remove «Проекты» from the ghost label list.)

`tests/App.test.tsx`: after login the default page is still the test page; add one navigation case. The mock queue must answer `me` → `health` (Topbar) → `listWorkspaces` (page mount):

```tsx
it("переходит на страницу воркспейсов по клику в сайдбаре", async () => {
  vi.stubGlobal("fetch", mockFetchSequence(
    { status: 200, body: { login: "balbes-x" } },
    { status: 200, body: { ok: true, version: "test" } },
    { status: 200, body: { home: { path: "/h/agent" }, projects: [] } }
  ));
  localStorage.setItem("balbes.authToken", "t");
  render(<App api={createApiClient()} />);
  fireEvent.click(await screen.findByText("Проекты"));
  expect(await screen.findByTestId("workspaces-page")).toBeTruthy();
  expect(screen.getByText("/h/agent")).toBeTruthy();
});
```

(The extra fetch responses feed Topbar's `useHealth` and `WorkspacesPage`'s initial `listWorkspaces`.)

- [ ] **Step 6: Run the whole frontend gate**

Run: `pnpm --filter dsh-balbes-admin test && pnpm --filter dsh-balbes-admin typecheck && pnpm --filter dsh-balbes-admin build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src packages/frontend/dsh-balbes-admin/tests
git commit -m "add workspaces page and navigation to the admin ui"
```

---

### Task 9: Runbook sync + final verification

**Files:**
- Modify: `docs/runbooks/stage2-vps.md` (structure section: mention `dsh-balbes-workspaces` in the profile; smoke section: add workspaces curl; DoD if it enumerates features)

**Interfaces:**
- Consumes: everything above.
- Produces: operations doc that reflects the new artifact and a manual smoke path.

- [ ] **Step 1: Update the runbook**

Read `docs/runbooks/stage2-vps.md` first. In the profile-structure paragraph that currently lists `dsh-balbes-host` (around line 13), add the workspaces plugin; in the smoke section add after the prompt curl:

```bash
# воркспейсы (bearer; подставьте TOKEN из входа выше)
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/list \
  -H "authorization: Bearer $TOKEN"
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/create \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"my-project"}'
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/delete \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"my-project"}'
```

- [ ] **Step 2: Full repo verification**

Run each and report the actual output:
`pnpm typecheck`
`pnpm test` (unit suites, no LLM)
`bash -n scripts/install.sh`
`pnpm --filter dsh-balbes-admin build`
Then (local only, if a `dsh` CLI exists) the Task 4 Step 4 composition check and `RUN_REAL=1 pnpm --filter dsh-balbes-workspaces test`.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/stage2-vps.md
git commit -m "document workspace api smoke in the stage2 runbook"
```

- [ ] **Step 4: canon-audit handoff**

Run `doc-canon audit` (via the canon-audit skill, per repo rules) on the workspace topic, then tell the owner to run `canon-future-plan` to mark `p0-agent-workspaces` as absorbed and sync `future_plans/INDEX.md`. Do not edit `future_plans/**` yourself.
