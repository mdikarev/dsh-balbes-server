# Workspaces Section Layout (list + live file tree) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the workspaces page («Проекты») into a three-pane workbench — fixed workspace list (pinned reserved agent home, projects with a «⋮» action menu), a lazy directory/file tree of the selected workspace (~1/3 of the remaining width, resizable against the right pane), and an empty reserved right pane — with a scoped server-side directory reader and a push channel that keeps the tree in sync when directories change from outside.

**Architecture:** The filesystem stays the source of truth. A new domain module in `dsh-balbes-workspaces` reads directory listings scoped to a workspace root (lexical + realpath containment, no `..`/symlink escape) behind a new bearer POST endpoint `/api/workspaces/tree` (lazy children of one directory per call). A second new endpoint, `/api/workspaces/events`, is a long-lived POST whose response streams server-sent events (SSE framing over the existing `node:http` POST router — no protocol upgrade, no new dependency, R-API-1 preserved) fed by `fs.watch` (recursive) on the agent home and projects root, with debounced, mapped events per affected directory; the SPA consumes it via `fetch` + a small SSE parser and re-reads affected listings. The SPA keeps `Sidebar`/`Topbar`, drops the page `h1`, and renders three panes; selection state (and pane width) persist in `localStorage`.

**Tech Stack:** TypeScript (strict, ESM), Cordis functional plugin (`dsh-balbes-workspaces`: pure domain modules + `apply` registering POST seats on `balbesHttp`), `node:fs/promises`, `node:fs` watchers, vitest, React 18 + Vite + Testing Library (jsdom), bash install.sh + YAML profile (unchanged), runbook `docs/runbooks/stage2-vps.md`.

**Spec:** Canon updated 2026-09-08 via canon-write — `docs/canon/ADMIN_UI.md` (Current state: three-pane layout, list semantics, ⋮ menu, modals, empty states, localStorage selection, live tree), `docs/canon/ARCHITECTURE.md` (Building blocks + Key flows: scoped tree read, watcher + push channel), `docs/canon/OVERVIEW.md` (Scope / Success signals). Approved chat sketch of the same date. This plan argues from those sections.

## Global Constraints

- **Canon-first already done**: the canon edits above are committed by the owner **before** task 1 starts; do **not** edit `docs/canon/**` inside code tasks. The only exception is Task 13, which syncs `docs/canon/API_CONTRACTS.md` through the canon-write skill.
- Wire contracts land in `docs/canon/API_CONTRACTS.md` **in the same commit as the code that implements them** (API_CONTRACTS.md rule); use canon-write for that, never a raw edit.
- dsh is a dependency, never a fork; installed `@deepseek-ai/*` are never edited; the plugin adds **no** runtime dependencies (watcher/SSE use `node:*` only).
- Rule R-API-1: every `/api/*` request is POST-only; errors are `{error:{code,message}}`. The events endpoint keeps this rule: POST request, streaming response body (no GET, no EventSource).
- Workspace layout (verbatim): home = `$DSH_HOME/agent/` (reserved, auto-created, never deletable); projects root = `$DSH_HOME/projects/`; project names = strict slug `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$`, ≤ 64 chars, no `/`, no `..`. Tree reads must never escape a workspace root: lexical containment AND realpath containment; entries classified from `Dirent` only (never follow symlinks); symlinks are reported as `kind: "link"` and are not expandable.
- Types: strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — never assign `undefined` to an optional field explicitly); ESM; kebab-case files; code/comments English; UI copy Russian; source of truth for wire shapes is `dsh-balbes-contracts` (`packages/contracts/src/index.ts`).
- REAL-composition tests are gated: run only when `RUN_REAL=1` **and** `dsh` exists on PATH (`describe.skipIf`), mirroring `packages/plugins/dsh-balbes-workspaces/tests/integration.test.ts`. Unit tests stay hermetic (temp dirs under `os.tmpdir()`, teardown cleanup).
- fs events are nondeterministic: unit tests cover pure mapping/dedupe logic and the subscription registry (injected sink); only REAL tests touch live `fs.watch` glue.
- Every task ends with the checks it introduced passing and a commit (one logical change per commit, verb-first subject ≤ ~72 chars). Verify with `pnpm --filter <pkg> test` / `pnpm --filter <pkg> typecheck` (root `pnpm typecheck` / `pnpm test` at the end).
- UI copy (Russian, verbatim): «Воркспейсы», «Дом агента», «зарезервирован», «Проектов нет», «Выберите воркспейс», «Каталог пуст», «Создать проект», «Удалить», «Отмена», «Удалить проект», «Каталог будет удалён безвозвратно», «Не удалось загрузить воркспейсы», «Загрузка…», «Повторить», «Закрыть».

---

### Task 1: Tree/events contract types in `dsh-balbes-contracts`

**Files:**
- Modify: `packages/contracts/src/index.ts` (append below the workspace types, after `WorkspaceDeleteResponse`)
- Test: `packages/contracts/tests/contracts.test.ts`

**Interfaces:**
- Consumes: existing `WorkspaceProject`/`WorkspaceHome` types.
- Produces (used by Task 2/3 server domain structurally, Task 6 SPA client, Task 13 registry):
  - `WorkspaceScope = "home" | "project"`
  - `WorkspaceTreeRequest { scope: WorkspaceScope; name?: string; path: string }` — `name` required when `scope === "project"`; `path` is a relative dir path, `""` = workspace root
  - `WorkspaceTreeEntryKind = "dir" | "file" | "link"`
  - `WorkspaceTreeEntry { name: string; kind: WorkspaceTreeEntryKind }`
  - `WorkspaceTreeResponse { entries: WorkspaceTreeEntry[] }`
  - `WorkspaceEventsRequest {}`
  - `WorkspaceFsEvent { kind: "fs"; scope: WorkspaceScope; name?: string; path: string }` — the dir whose listing changed (`""` = root); `name` present iff `scope === "project"`
  - `WorkspaceListEvent { kind: "list" }` — projects root changed (project added/removed/renamed)
  - `WorkspaceEvent = WorkspaceFsEvent | WorkspaceListEvent`

- [ ] **Step 1: Write the failing test**

Read `packages/contracts/tests/contracts.test.ts` first. Append a compile-time block in its existing style (type import from `../src/index.js` + assertions), e.g.:

```ts
import type {
  WorkspaceDeleteRequest,
  WorkspaceDeleteResponse,
  WorkspaceFsEvent,
  WorkspaceHome,
  WorkspaceListEvent,
  WorkspaceListRequest,
  WorkspaceListResponse,
  WorkspaceProject,
  WorkspaceScope,
  WorkspaceTreeEntry,
  WorkspaceTreeEntryKind,
  WorkspaceTreeRequest,
  WorkspaceTreeResponse,
  WorkspaceEvent
} from "../src/index.js";

describe("workspace tree/events contracts", () => {
  it("exposes the documented shapes", () => {
    const scope: WorkspaceScope = "project";
    const req: WorkspaceTreeRequest = { scope, name: "alpha", path: "src" };
    const homeReq: WorkspaceTreeRequest = { scope: "home", path: "" };
    const entry: WorkspaceTreeEntry = { name: "main.ts", kind: "file" };
    const kind: WorkspaceTreeEntryKind = "dir";
    const resp: WorkspaceTreeResponse = { entries: [entry] };
    const fsEvt: WorkspaceFsEvent = { kind: "fs", scope, name: "alpha", path: "src" };
    const listEvt: WorkspaceListEvent = { kind: "list" };
    const evt: WorkspaceEvent = fsEvt;
    void [scope, req, homeReq, entry, kind, resp, fsEvt, listEvt, evt] as unknown[];
    // exactOptionalPropertyTypes guard: an omitted name is absent, never undefined
    const e = evt as WorkspaceFsEvent;
    void e;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-contracts test`
Expected: FAIL — the new named exports do not exist yet.

- [ ] **Step 3: Add the types**

Append to `packages/contracts/src/index.ts` (style mirrors the existing block):

```ts
export type WorkspaceScope = "home" | "project";

export interface WorkspaceTreeRequest {
  scope: WorkspaceScope;
  /** Project slug; required when scope === "project", absent for "home". */
  name?: string;
  /** Relative directory path inside the workspace root; "" means the root. */
  path: string;
}
export type WorkspaceTreeEntryKind = "dir" | "file" | "link";
export interface WorkspaceTreeEntry {
  name: string;
  kind: WorkspaceTreeEntryKind;
}
export interface WorkspaceTreeResponse {
  entries: WorkspaceTreeEntry[];
}

export interface WorkspaceEventsRequest {}

/** Directory whose listing changed ("" = workspace root). */
export interface WorkspaceFsEvent {
  kind: "fs";
  scope: WorkspaceScope;
  name?: string;
  path: string;
}
/** Projects root changed: a project directory appeared/disappeared/was renamed. */
export interface WorkspaceListEvent {
  kind: "list";
}
export type WorkspaceEvent = WorkspaceFsEvent | WorkspaceListEvent;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-contracts test && pnpm --filter dsh-balbes-contracts typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/tests/contracts.test.ts
git commit -m "feat(contracts): add workspace tree and event types"
```

---

### Task 2: Scoped directory reader (`src/tree.ts`) with unit tests

**Files:**
- Modify: `packages/plugins/dsh-balbes-workspaces/src/workspaces.ts` (one line: widen `WorkspaceErrorCode` union)
- Create: `packages/plugins/dsh-balbes-workspaces/src/tree.ts`
- Test: `packages/plugins/dsh-balbes-workspaces/tests/tree.test.ts`

**Interfaces:**
- Consumes (from `./workspaces.js`): `homeDir`, `projectsRoot`, `WorkspaceError`, `workspaceError`, `validateProjectName`, `WorkspaceErrorCode`, `PROJECT_NAME_RE`.
- Produces (used by Task 3 route handler and Task 4 watcher mapping, which reuse `relDirOf`):
  - `TreeEntry { name: string; kind: "dir" | "file" | "link" }`
  - `isValidRelPath(relPath: string): boolean` — `""` ok; no leading `/`, no `\`, no NUL, no `.`/`..`/empty segments
  - `relDirOf(rel: string): string` — parent dir of a rel path (`""` when none); normalizes `/` and `\`
  - `workspaceBase(dshHome: string, scope: "home" | "project", name: string | undefined): Promise<string>` — resolves+validates the root (throws `invalid-name` for a bad project name, `not-found` when the project dir is missing); home root is `homeDir(dshHome)`
  - `readWorkspaceDir(dshHome, scope, name, relPath): Promise<TreeEntry[]>` — children of one directory; throws `invalid-path` (400), `not-found` (404); never escapes the root

- [ ] **Step 1: Widen the error-code union**

In `packages/plugins/dsh-balbes-workspaces/src/workspaces.ts` change the union on line 16 to:

```ts
export type WorkspaceErrorCode = "invalid-name" | "name-exists" | "not-found" | "registry-invalid" | "invalid-path";
```

- [ ] **Step 2: Write the failing test**

Create `packages/plugins/dsh-balbes-workspaces/tests/tree.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDir, projectsRoot } from "../src/workspaces.js";
import { isValidRelPath, readWorkspaceDir, relDirOf } from "../src/tree.js";

const dirs: string[] = [];
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ws-tree-"));
  dirs.push(dir);
  await mkdir(homeDir(dir), { recursive: true });
  await mkdir(join(projectsRoot(dir), "alpha"), { recursive: true });
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("relDirOf / isValidRelPath", () => {
  it("maps a rel path to its parent dir", () => {
    expect(relDirOf("src/main.ts")).toBe("src");
    expect(relDirOf("src")).toBe("");
    expect(relDirOf("src/")).toBe("src");
    expect(relDirOf("")).toBe("");
  });
  it("accepts root and rejects traversal/absolute/backslash", () => {
    expect(isValidRelPath("")).toBe(true);
    expect(isValidRelPath("a/b")).toBe(true);
    expect(isValidRelPath("../x")).toBe(false);
    expect(isValidRelPath("a/../b")).toBe(false);
    expect(isValidRelPath("/a")).toBe(false);
    expect(isValidRelPath("a\\b")).toBe(false);
    expect(isValidRelPath("a\0b")).toBe(false);
  });
});

describe("readWorkspaceDir", () => {
  it("lists children of the project root: dirs first, dotfiles included", async () => {
    const home = await tempHome();
    const root = join(projectsRoot(home), "alpha");
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, ".hidden"), "h");
    const entries = await readWorkspaceDir(home, "project", "alpha", "");
    expect(entries).toEqual([
      { name: "src", kind: "dir" },
      { name: ".hidden", kind: "file" },
      { name: "b.txt", kind: "file" }
    ]);
  });

  it("reads a nested dir and reports symlinks as links without following them", async () => {
    const home = await tempHome();
    const outside = await mkdtemp(join(tmpdir(), "ws-outside-"));
    dirs.push(outside);
    const root = join(projectsRoot(home), "alpha");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "x");
    await symlink(outside, join(root, "leak"));
    const nested = await readWorkspaceDir(home, "project", "alpha", "src");
    expect(nested).toEqual([{ name: "main.ts", kind: "file" }]);
    const top = await readWorkspaceDir(home, "project", "alpha", "");
    expect(top).toContainEqual({ name: "leak", kind: "link" });
  });

  it("refuses to read through a symlink that escapes the workspace", async () => {
    const home = await tempHome();
    const outside = await mkdtemp(join(tmpdir(), "ws-outside-"));
    dirs.push(outside);
    const root = join(projectsRoot(home), "alpha");
    await symlink(outside, join(root, "escape"));
    await expect(readWorkspaceDir(home, "project", "alpha", "escape")).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects traversal paths and unknown targets", async () => {
    const home = await tempHome();
    await expect(readWorkspaceDir(home, "project", "alpha", "../..")).rejects.toMatchObject({ code: "invalid-path" });
    await expect(readWorkspaceDir(home, "project", "alpha", "nope")).rejects.toMatchObject({ code: "not-found" });
    await expect(readWorkspaceDir(home, "project", "missing", "")).rejects.toMatchObject({ code: "not-found" });
    await expect(readWorkspaceDir(home, "bogus", undefined, "")).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("reads the agent home root", async () => {
    const home = await tempHome();
    await writeFile(join(homeDir(home), "self.md"), "# agent");
    const entries = await readWorkspaceDir(home, "home", undefined, "");
    expect(entries).toEqual([{ name: "self.md", kind: "file" }]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-workspaces test`
Expected: FAIL — `../src/tree.js` does not exist.

- [ ] **Step 4: Implement `src/tree.ts`**

```ts
import { readdir, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homeDir, projectsRoot, validateProjectName, workspaceError, type WorkspaceError } from "./workspaces.js";

export type WorkspaceScope = "home" | "project";
export interface TreeEntry {
  name: string;
  kind: "dir" | "file" | "link";
}

const INVALID = /[\\\0]/;

/** Parent dir of a watch/rel path; "" when there is none. Accepts / and \. */
export function relDirOf(rel: string): string {
  const norm = rel.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? "" : norm.slice(0, idx);
}

/** "" (root) or segments without "", ".", "..", "/", "\", NUL. */
export function isValidRelPath(relPath: string): boolean {
  if (typeof relPath !== "string" || relPath.startsWith("/") || INVALID.test(relPath)) return false;
  if (relPath === "") return true;
  return relPath.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

async function isWithin(root: string, target: string): Promise<boolean> {
  const realRoot = await realpath(root);
  const realTarget = await realpath(target);
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep);
}

/** Resolve + validate the workspace root for the given scope. */
export async function workspaceBase(
  dshHome: string,
  scope: WorkspaceScope,
  name: string | undefined
): Promise<string> {
  if (scope === "home") return homeDir(dshHome);
  if (scope === "project") {
    if (name === undefined || !validateProjectName(name)) {
      throw workspaceError("invalid-name", `invalid project name: ${name ?? ""}`);
    }
    const base = resolve(projectsRoot(dshHome), name);
    // containment: direct child of the projects root
    if (base !== join(projectsRoot(dshHome), name) || !base.startsWith(projectsRoot(dshHome) + sep)) {
      throw workspaceError("invalid-name", `project name escapes the projects root: ${name}`);
    }
    return base;
  }
  throw workspaceError("invalid-path", `unknown scope: ${String(scope)}`);
}

function classify(dirent: Dirent): TreeEntry["kind"] {
  if (dirent.isDirectory()) return "dir";
  if (dirent.isSymbolicLink()) return "link";
  return "file";
}

/** Children of one directory inside a workspace; never escapes the root. */
export async function readWorkspaceDir(
  dshHome: string,
  scope: WorkspaceScope,
  name: string | undefined,
  relPath: string
): Promise<TreeEntry[]> {
  if (!isValidRelPath(relPath)) throw workspaceError("invalid-path", `invalid relative path: ${relPath}`);
  const base = await workspaceBase(dshHome, scope, name);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw workspaceError("invalid-path", `path escapes the workspace root: ${relPath}`);
  }
  // realpath containment: refuse to read dirs reached through an escaping symlink
  let realOk = false;
  try {
    realOk = await isWithin(base, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw workspaceError("not-found", `directory not found: ${relPath}`);
    }
    throw error;
  }
  if (!realOk) throw workspaceError("not-found", `directory is outside the workspace: ${relPath}`);
  const dirents = await readdir(target, { withFileTypes: true });
  const entries: TreeEntry[] = dirents.map((d) => ({ name: d.name, kind: classify(d) }));
  const byKind = (a: TreeEntry, b: TreeEntry): number => {
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (a.kind !== "dir" && b.kind === "dir") return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };
  return entries.sort(byKind);
}
```

Note: do not add an unused `WorkspaceError` import — import only what the code uses (`workspaceError`, `validateProjectName`, path helpers; drop `type WorkspaceError` if unused).

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter dsh-balbes-workspaces test && pnpm --filter dsh-balbes-workspaces typecheck`
Expected: PASS (all tree tests green, no unused-import error).

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/dsh-balbes-workspaces/src/workspaces.ts packages/plugins/dsh-balbes-workspaces/src/tree.ts packages/plugins/dsh-balbes-workspaces/tests/tree.test.ts
git commit -m "feat(workspaces): scoped directory reader for the file tree"
```

---

### Task 3: `/api/workspaces/tree` route in the plugin

**Files:**
- Modify: `packages/plugins/dsh-balbes-workspaces/src/index.ts` (register the route next to the existing three)

**Interfaces:**
- Consumes: `readWorkspaceDir`, `WorkspaceScope` from `./tree.js`; existing `send`/`ResLike`/`HttpSeatLike`.
- Produces: route `POST /api/workspaces/tree`, bearer; 200 `WorkspaceTreeResponse`; errors per Global Constraints; later REAL-tested in Task 5 and registered in Task 13.

- [ ] **Step 1: Add the route**

In `packages/plugins/dsh-balbes-workspaces/src/index.ts`, add the import and a handler mirroring `create`/`delete` error mapping (place the route after the `delete` route):

```ts
import { readWorkspaceDir, type WorkspaceScope } from "./tree.js";
```

```ts
  http.post("/api/workspaces/tree", "bearer", async (_req, res, body) => {
    const b = body as { scope?: unknown; name?: unknown; path?: unknown };
    const scope = typeof b?.scope === "string" ? (b.scope as WorkspaceScope) : "";
    const name = typeof b?.name === "string" ? b.name : undefined;
    const path = typeof b?.path === "string" ? b.path : "";
    try {
      const entries = await readWorkspaceDir(dshHome, scope, name, path);
      send(res, 200, { entries });
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const status = error.code === "invalid-name" || error.code === "invalid-path" ? 400 : error.code === "not-found" ? 404 : 500;
        send(res, status, { error: { code: error.code, message: error.message } });
        return;
      }
      send(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
    }
  });
```

(`WorkspaceError` is already imported in this file.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter dsh-balbes-workspaces typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/dsh-balbes-workspaces/src/index.ts
git commit -m "feat(workspaces): add tree endpoint route"
```

---

### Task 4: Change hub + watcher (`src/events.ts`) with unit tests

**Files:**
- Create: `packages/plugins/dsh-balbes-workspaces/src/events.ts`
- Test: `packages/plugins/dsh-balbes-workspaces/tests/events.test.ts`

**Interfaces:**
- Consumes: `relDirOf` from `./tree.js`, `homeDir`/`projectsRoot` from `./workspaces.js`.
- Produces (used by Task 5 route, wired in `apply`):
  - `ChangeEvent = { kind: "fs"; scope: "home" | "project"; name?: string; path: string } | { kind: "list" }`
  - `toChangeEvent(rootLabel: "home" | "projects", rel: string): ChangeEvent | null` — pure mapping: a change at a path → the dir whose listing changed (`""` = watched root); depth-0 changes under `projects` → `{ kind: "list" }`
  - `createChangeHub(dshHome: string): { subscribe(fn: (e: ChangeEvent) => void): () => void; close(): void }` — lazily starts the watcher on first subscriber, stops on last unsubscribe; debounces raw fs events (~120 ms) and emits deduped `ChangeEvent`s

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/dsh-balbes-workspaces/tests/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toChangeEvent } from "../src/events.js";

describe("toChangeEvent mapping", () => {
  it("maps home changes to the parent dir of the changed entry", () => {
    expect(toChangeEvent("home", "self.md")).toEqual({ kind: "fs", scope: "home", path: "" });
    expect(toChangeEvent("home", "notes/a.md")).toEqual({ kind: "fs", scope: "home", path: "notes" });
    expect(toChangeEvent("home", "skills/").kind).toBe("fs");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-workspaces test`
Expected: FAIL — `../src/events.js` does not exist.

- [ ] **Step 3: Implement `src/events.ts`**

```ts
import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homeDir, projectsRoot } from "./workspaces.js";
import { relDirOf } from "./tree.js";

export type ChangeEvent =
  | { kind: "fs"; scope: "home" | "project"; name?: string; path: string }
  | { kind: "list" };

/** Pure mapping from a watched root + raw relative path to a ChangeEvent. */
export function toChangeEvent(rootLabel: "home" | "projects", rel: string): ChangeEvent | null {
  const norm = (rel ?? "").replace(/\\/g, "/");
  const segments = norm.split("/").filter((s) => s !== "");
  if (rootLabel === "home") {
    return { kind: "fs", scope: "home", path: relDirOf(norm) };
  }
  if (segments.length === 0) return { kind: "list" }; // projects root itself changed
  const [name, ...rest] = segments;
  if (name === undefined || name.startsWith(".")) return null; // hidden bookkeeping under the projects root
  if (rest.length === 0) return { kind: "list" }; // project dir added/removed/renamed
  const restPath = rest.join("/");
  return { kind: "fs", scope: "project", name, path: relDirOf(restPath) };
}

const DEBOUNCE_MS = 120;
const REARM_MS = 30_000;

export interface ChangeHub {
  subscribe(fn: (e: ChangeEvent) => void): () => void;
  close(): void;
}

/** Lazy, debounced fs watcher over the agent home + projects root. */
export function createChangeHub(dshHome: string): ChangeHub {
  const listeners = new Set<(e: ChangeEvent) => void>();
  const pending = new Set<ChangeEvent>();
  let watchers: FSWatcher[] = [];
  let started = false;
  let prootArmed = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let rearm: ReturnType<typeof setInterval> | null = null;

  const emit = (e: ChangeEvent): void => {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch {
        // a broken listener must not kill the watcher loop
      }
    }
  };

  const flush = (): void => {
    debounce = null;
    for (const e of pending) emit(e);
    pending.clear();
  };

  const queue = (rootLabel: "home" | "projects", rel: string): void => {
    const e = toChangeEvent(rootLabel, rel);
    if (e === null) return;
    pending.add(e);
    if (debounce === null) debounce = setTimeout(flush, DEBOUNCE_MS);
  };

  const armHome = (): void => {
    try {
      const w = watch(homeDir(dshHome), { recursive: true }, (_eventType, filename) => {
        queue("home", typeof filename === "string" ? filename : "");
      });
      w.on("error", () => { /* home never vanishes in practice; ignore */ });
      watchers.push(w);
    } catch {
      /* home is ensured at boot; ignore */
    }
  };

  const armProjects = (): void => {
    if (prootArmed) return;
    const dir = projectsRoot(dshHome);
    if (!existsSync(dir)) return; // rearmed by the interval once it appears
    try {
      const w = watch(dir, { recursive: true }, (_eventType, filename) => {
        queue("projects", typeof filename === "string" ? filename : "");
      });
      w.on("error", () => {
        prootArmed = false; // root vanished (deleted): rearm when it returns
      });
      watchers.push(w);
      prootArmed = true;
    } catch {
      // e.g. ENOENT race with the interval check; retried on the next tick
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    armHome();
    armProjects();
    rearm = setInterval(armProjects, REARM_MS);
  };

  const stop = (): void => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    watchers = [];
    prootArmed = false;
    if (rearm !== null) clearInterval(rearm);
    rearm = null;
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
    pending.clear();
    started = false;
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      start();
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) stop();
      };
    },
    close() {
      listeners.clear();
      stop();
    }
  };
}
```

Note for the implementer: the agent-home watch is armed once (the home always exists); the projects root is re-armed on a 30 s interval until it exists and re-armed after errors. This glue is exercised by the REAL test (Task 5), not by unit tests — do not add unit tests that depend on live `fs.watch` timing.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter dsh-balbes-workspaces test && pnpm --filter dsh-balbes-workspaces typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-workspaces/src/events.ts packages/plugins/dsh-balbes-workspaces/tests/events.test.ts
git commit -m "feat(workspaces): debounced fs change hub for tree events"
```

---

### Task 5: `/api/workspaces/events` stream + REAL-composition coverage for both new endpoints

**Files:**
- Modify: `packages/plugins/dsh-balbes-workspaces/src/index.ts` (events route + widened response interface)
- Test: `packages/plugins/dsh-balbes-workspaces/tests/integration.test.ts`

**Interfaces:**
- Consumes: `createChangeHub` from `./events.js`.
- Produces: route `POST /api/workspaces/events`, bearer; 200 `text/event-stream` body kept open; frames are `data: <json ChangeEvent>\n\n`, heartbeat `: ping\n\n` every 25 s; connection close unsubscribes. Registry entry in Task 13.

- [ ] **Step 1: Widen the local response interface and add the route**

In `packages/plugins/dsh-balbes-workspaces/src/index.ts`, extend `ResLike` (the real value is Node's `ServerResponse`, which satisfies the wider shape):

```ts
interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
  write(chunk: string): boolean;
  on(event: "close", listener: () => void): unknown;
}
```

Add the import and the route after the `/tree` route:

```ts
import { createChangeHub } from "./events.js";
```

```ts
  const changeHub = createChangeHub(dshHome);
  http.post("/api/workspaces/events", "bearer", async (_req, res, body) => {
    void body; // events request body is {} (R-API-1)
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    const sendEvent = (e: unknown): void => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = changeHub.subscribe(sendEvent);
    const heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      res.write(": ping\n\n");
    }, 25_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on("close", cleanup);
    // The stream lives until the client disconnects; dispatch must not end it.
  });
```

(The hub is created inside `apply` next to `ensureHome`; no per-process leak concern — the plugin lives for the server's lifetime.)

- [ ] **Step 2: Extend the REAL composition test**

In `packages/plugins/dsh-balbes-workspaces/tests/integration.test.ts`, after the existing `it(...)` inside the `describe.skipIf(!realEnabled)` block, add a second `it` (reuses `bootServer`, `postJson`, `home`, `port`, `token`):

```ts
  it("workspaces API: tree reads are scoped, events stream file changes", async () => {
    if (home === undefined) throw new Error("home not initialized");
    const base = `http://127.0.0.1:${port}`;
    const write = (await import("node:fs/promises")).writeFile;
    const mkdir = (await import("node:fs/promises")).mkdir;
    try {
      const token = await bootServer();

      // anon gets 401 on both new routes
      expect((await postJson(`${base}/api/workspaces/tree`, { scope: "home", path: "" })).status).toBe(401);
      expect((await postJson(`${base}/api/workspaces/events`, {})).status).toBe(401);

      const created = await postJson(`${base}/api/workspaces/create`, { name: "alpha" }, token);
      expect(created.status, JSON.stringify(created.json)).toBe(200);

      // seed files directly on disk (the server process watches the same home)
      const proot = join(home, "projects", "alpha");
      await mkdir(join(proot, "src"), { recursive: true });
      await write(join(proot, "src", "main.ts"), "export {}");
      await write(join(proot, ".hidden"), "x");

      // tree: project root lists dirs first, dotfiles included
      const tree = await postJson(`${base}/api/workspaces/tree`, { scope: "project", name: "alpha", path: "" }, token);
      expect(tree.status, JSON.stringify(tree.json)).toBe(200);
      expect((tree.json as { entries?: Array<{ name: string; kind: string }> }).entries).toEqual([
        { name: "src", kind: "dir" },
        { name: ".hidden", kind: "file" }
      ]);

      // tree: nested dir, home scope, and error codes
      const nested = await postJson(`${base}/api/workspaces/tree`, { scope: "project", name: "alpha", path: "src" }, token);
      expect((nested.json as { entries?: unknown[] }).entries).toEqual([{ name: "main.ts", kind: "file" }]);
      const homeTree = await postJson(`${base}/api/workspaces/tree`, { scope: "home", path: "" }, token);
      expect(homeTree.status).toBe(200);
      const bad = await postJson(`${base}/api/workspaces/tree`, { scope: "project", name: "alpha", path: "../.." }, token);
      expect(bad.status).toBe(400);
      expect((bad.json as { error?: { code?: string } }).error?.code).toBe("invalid-path");
      const gone = await postJson(`${base}/api/workspaces/tree`, { scope: "project", name: "alpha", path: "nope" }, token);
      expect(gone.status).toBe(404);

      // events: open the stream, mutate the tree, expect a fs event for the project
      const ac = new AbortController();
      const streamRes = await fetch(`${base}/api/workspaces/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{}",
        signal: ac.signal
      });
      expect(streamRes.status).toBe(200);
      expect(streamRes.headers.get("content-type")).toContain("text/event-stream");
      const reader = streamRes.body?.getReader();
      if (reader === undefined) throw new Error("no stream body");

      await mkdir(join(proot, "src", "lib"), { recursive: true });
      const deadline = Date.now() + 15_000;
      let sawAlpha = false;
      let acc = "";
      while (Date.now() < deadline && !sawAlpha) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += new TextDecoder().decode(value);
        sawAlpha = acc.includes('"scope":"project"') && acc.includes('"name":"alpha"');
      }
      ac.abort();
      expect(sawAlpha, `expected a project fs event, got: ${acc}`).toBe(true);
    } finally {
      await stopServer();
    }
  }, 240_000);
```

- [ ] **Step 3: Run the REAL suite (requires dsh on PATH)**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-workspaces test`
Expected: PASS, including the new `it`. If fs events are flaky in your environment, increase the deadline to 30 s rather than weakening the assertion.

- [ ] **Step 4: Typecheck + regular unit suite**

Run: `pnpm --filter dsh-balbes-workspaces typecheck && pnpm --filter dsh-balbes-workspaces test`
Expected: PASS (unit-only run skips the REAL describe).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-workspaces/src/index.ts packages/plugins/dsh-balbes-workspaces/tests/integration.test.ts
git commit -m "feat(workspaces): stream fs change events to the SPA"
```

---

### Task 6: SPA client — tree reads and the events stream (SSE parser)

**Files:**
- Create: `packages/frontend/dsh-balbes-admin/src/api/sse.ts`
- Modify: `packages/frontend/dsh-balbes-admin/src/api/client.ts`
- Test: `packages/frontend/dsh-balbes-admin/tests/sse.test.ts`, `packages/frontend/dsh-balbes-admin/tests/client.test.ts`

**Interfaces:**
- Consumes: contracts types; `TOKEN_KEY`; existing `request`/`guard` helpers.
- Produces (used by Task 9 FileTree and Task 12 page wiring):
  - `createSseParser(onData: (data: string) => void): (chunk: string) => void` — incremental; emits each `data:` payload; ignores comment (`:`-prefixed) lines; survives chunk splits anywhere
  - On `AdminApi`:
    - `readWorkspaceDir(scope: WorkspaceScope, name: string | undefined, path: string): Promise<WorkspaceTreeResponse>`
    - `subscribeWorkspaceEvents(cb: (e: WorkspaceEvent) => void): () => void` — one shared connection while ≥1 listener; auto-reconnect (1.5 s) while listeners remain; a 401 from the stream calls the 401 handler (logout)

- [ ] **Step 1: Write the failing parser test**

Create `packages/frontend/dsh-balbes-admin/tests/sse.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/api/sse.ts`**

```ts
/**
 * Minimal incremental SSE parser: buffers until a blank line, then emits the
 * payload of the last "data:" line in the frame. Comment lines (": ...") and
 * event/id fields are ignored — the server sends only data frames.
 */
export function createSseParser(onData: (data: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string): void => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let data: string | null = null;
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) data = line.slice("data:".length).trimStart();
        // other fields and comments are ignored
      }
      if (data !== null) onData(data);
    }
  };
}
```

- [ ] **Step 4: Extend the client**

In `packages/frontend/dsh-balbes-admin/src/api/client.ts`, import the new types and `createSseParser`; add to the `AdminApi` interface and to `createApiClient`:

```ts
import type {
  WorkspaceEvent,
  WorkspaceScope,
  WorkspaceTreeRequest,
  WorkspaceTreeResponse
} from "dsh-balbes-contracts";
import { createSseParser } from "./sse";
```

Interface additions (inside `AdminApi`):

```ts
  readWorkspaceDir(scope: WorkspaceScope, name: string | undefined, path: string): Promise<WorkspaceTreeResponse>;
  subscribeWorkspaceEvents(cb: (e: WorkspaceEvent) => void): () => void;
```

Implementation additions (inside the returned object; add helper locals above it in `createApiClient`):

```ts
    readWorkspaceDir: (scope, name, path) => {
      const body: WorkspaceTreeRequest = name === undefined ? { scope, path } : { scope, name, path };
      return guard(request<WorkspaceTreeResponse>("/api/workspaces/tree", body));
    },
```

Event subscription (module-private helper functions declared inside `createApiClient`, before the `return`, so `notify401` is in scope):

```ts
  const eventListeners = new Set<(e: WorkspaceEvent) => void>();
  let eventController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const EVENT_RETRY_MS = 1500;

  const openEventStream = (): void => {
    if (eventController !== null || eventListeners.size === 0) return;
    const controller = new AbortController();
    eventController = controller;
    void (async () => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const stored = localStorage.getItem(TOKEN_KEY);
      if (stored !== null) headers.authorization = `Bearer ${stored}`;
      let retry = true; // reconnect only on network/EOF failures, never on HTTP errors
      try {
        const res = await fetch("/api/workspaces/events", {
          method: "POST",
          headers,
          body: "{}",
          signal: controller.signal
        });
        if (!res.ok) {
          retry = false;
          if (res.status === 401) notify401();
          throw new ApiError(res.status, "events", `events stream failed: ${res.status}`);
        }
        if (res.body === null) throw new Error("events stream has no body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const onData = (data: string): void => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data) as WorkspaceEvent;
          } catch {
            return;
          }
          for (const fn of eventListeners) fn(parsed as WorkspaceEvent);
        };
        const feed = createSseParser(onData);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          feed(decoder.decode(value, { stream: true }));
        }
      } catch {
        // aborted by unsubscribe or network error: handled below
      } finally {
        eventController = null;
        if (eventListeners.size > 0 && retry && !controller.signal.aborted) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            openEventStream();
          }, EVENT_RETRY_MS);
        }
      }
    })();
  };
```

And in the returned object:

```ts
    subscribeWorkspaceEvents: (cb) => {
      eventListeners.add(cb);
      openEventStream();
      let alive = true;
      return () => {
        if (!alive) return;
        alive = false;
        eventListeners.delete(cb);
        if (eventListeners.size === 0) {
          eventController?.abort();
          eventController = null;
          if (reconnectTimer !== null) clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      };
    },
```

- [ ] **Step 5: Extend the client tests**

In `packages/frontend/dsh-balbes-admin/tests/client.test.ts`, read it first, then append tests in its existing style (a fake `res` with a fake body reader; `vi.useFakeTimers()` where reconnect timing matters). Add:

```ts
  it("readWorkspaceDir posts the tree request", async () => {
    const seen: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ path: String(_url), body });
      return { ok: true, status: 200, json: async () => ({ entries: [{ name: "src", kind: "dir" }] }) };
    }));
    localStorage.setItem("balbes.authToken", "t");
    const api = createApiClient();
    const res = await api.readWorkspaceDir("project", "alpha", "src");
    expect(res.entries).toEqual([{ name: "src", kind: "dir" }]);
    expect(seen[0]?.path).toBe("/api/workspaces/tree");
    expect(seen[0]?.body).toEqual({ scope: "project", name: "alpha", path: "src" });
    vi.unstubAllGlobals();
  });

  it("subscribeWorkspaceEvents parses streamed events and unsubscribes cleanly", async () => {
    const chunks = [
      'data: {"kind":"fs","scope":"project","name":"alpha","path":"src"}\n\n',
      ": ping\n\n",
      'data: {"kind":"list"}\n\n'
    ];
    const reader = {
      getReader: () => {
        let i = 0;
        return {
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: new TextEncoder().encode(chunks[i++]) };
          },
          cancel: async () => undefined,
          releaseLock: () => undefined
        };
      }
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body: reader })));
    localStorage.setItem("balbes.authToken", "t");
    const api = createApiClient();
    const got: unknown[] = [];
    const unsub = api.subscribeWorkspaceEvents((e) => got.push(e));
    await vi.waitFor(() => expect(got.length).toBe(2));
    expect(got[0]).toEqual({ kind: "fs", scope: "project", name: "alpha", path: "src" });
    expect(got[1]).toEqual({ kind: "list" });
    unsub();
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 6: Run the frontend suite**

Run: `pnpm --filter dsh-balbes-admin test && pnpm --filter dsh-balbes-admin typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/api/sse.ts packages/frontend/dsh-balbes-admin/src/api/client.ts packages/frontend/dsh-balbes-admin/tests/sse.test.ts packages/frontend/dsh-balbes-admin/tests/client.test.ts
git commit -m "feat(admin): workspace tree reads and event stream client"
```

---

### Task 7: Shared `Modal` component

**Files:**
- Create: `packages/frontend/dsh-balbes-admin/src/components/Modal.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/styles.css` (append a `modal` block)
- Test: `packages/frontend/dsh-balbes-admin/tests/Modal.test.tsx`

**Interfaces:**
- Consumes: nothing beyond React.
- Produces (used by Task 11 page flows):
  - `ModalProps { title: string; onClose(): void; children: ReactNode }`
  - Renders `div.modal-backdrop` (click closes) with `div.modal` inside (click stops propagation), `role="dialog"` + `aria-modal="true"`, header with title and a close button `aria-label="Закрыть"` (`data-testid="modal-close"`), body for children.

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/dsh-balbes-admin/tests/Modal.test.tsx` (mirror existing test style — see `Sidebar.test.tsx` for conventions):

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Modal from "../src/components/Modal";

describe("Modal", () => {
  it("renders title and children and closes via the close button", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Создать проект" onClose={onClose}>
        <input aria-label="Имя" />
      </Modal>
    );
    expect(screen.getByText("Создать проект")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("modal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click but not on content click", () => {
    const onClose = vi.fn();
    render(
      <Modal title="t" onClose={onClose}>
        <button type="button">inside</button>
      </Modal>
    );
    fireEvent.click(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL.

- [ ] **Step 3: Implement `Modal.tsx`**

```tsx
import type { ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose(): void;
  children: ReactNode;
}

export default function Modal({ title, onClose, children }: ModalProps) {
  return (
    <div
      className="modal-backdrop"
      data-testid="modal-backdrop"
      onClick={onClose}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" data-testid="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
```

Append to `styles.css` (reuse tokens only; values are reference, not contract):

```css
/* ── modal ─────────────────────────────────────────────────── */
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, .55);
  display: flex; align-items: center; justify-content: center; z-index: 40;
}
.modal {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  width: 420px; max-width: calc(100vw - 48px);
  box-shadow: 0 20px 60px rgba(0, 0, 0, .5);
}
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px 0; }
.modal-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
.modal-body { padding: 14px 18px 20px; display: flex; flex-direction: column; gap: 12px; }
.icon-btn {
  background: transparent; border: none; color: var(--text-dim); cursor: pointer;
  font-size: 14px; line-height: 1; padding: 6px; border-radius: 6px;
}
.icon-btn:hover { color: var(--text); background: var(--surface-2); }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/components/Modal.tsx packages/frontend/dsh-balbes-admin/src/styles.css packages/frontend/dsh-balbes-admin/tests/Modal.test.tsx
git commit -m "feat(admin): shared modal component"
```

---

### Task 8: `WorkspaceList` pane (pinned home + projects with «⋮» menu)

**Files:**
- Create: `packages/frontend/dsh-balbes-admin/src/workspaceRef.ts`, `packages/frontend/dsh-balbes-admin/src/components/WorkspaceList.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/styles.css`
- Test: `packages/frontend/dsh-balbes-admin/tests/WorkspaceList.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceProject`/`WorkspaceScope` contracts types; `WorkspaceRef` (created here).
- Produces (used by Tasks 9–12):
  - `WorkspaceRef { scope: WorkspaceScope; name?: string }` + helpers in `src/workspaceRef.ts`: `refKey(ref): string` (`"home"` | `"project:alpha"`), `isSameRef(a: WorkspaceRef | null, b: WorkspaceRef | null): boolean`
  - `WorkspaceListProps { homePath: string; projects: WorkspaceProject[]; selected: WorkspaceRef | null; busy: boolean; onSelect(ref: WorkspaceRef): void; onCreate(): void; onDelete(p: WorkspaceProject): void }`

- [ ] **Step 1: Write the failing tests**

Create `src/workspaceRef.ts` (tiny, pure — no test file needed; covered through component tests and page tests):

```ts
import type { WorkspaceScope } from "dsh-balbes-contracts";

export interface WorkspaceRef {
  scope: WorkspaceScope;
  name?: string;
}

export function refKey(ref: WorkspaceRef): string {
  return ref.scope === "home" ? "home" : `project:${ref.name ?? ""}`;
}

export function isSameRef(a: WorkspaceRef | null, b: WorkspaceRef | null): boolean {
  if (a === null || b === null) return a === b;
  return refKey(a) === refKey(b);
}
```

Create `tests/WorkspaceList.test.tsx`:

```tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkspaceList from "../src/components/WorkspaceList";
import type { WorkspaceProject } from "dsh-balbes-contracts";
import type { WorkspaceRef } from "../src/workspaceRef";

const projects: WorkspaceProject[] = [
  { name: "alpha", path: "/h/projects/alpha", createdAt: "2026-09-06T00:00:00.000Z" },
  { name: "beta", path: "/h/projects/beta" }
];
const homePath = "/h/agent";

function setup(overrides: Partial<Parameters<typeof WorkspaceList>[0]> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides
  };
  render(
    <WorkspaceList
      homePath={homePath}
      projects={projects}
      selected={null}
      busy={false}
      onSelect={handlers.onSelect}
      onCreate={handlers.onCreate}
      onDelete={handlers.onDelete}
    />
  );
  return handlers;
}

afterEach(() => cleanup());

describe("WorkspaceList", () => {
  it("renders the pinned home with a reserved chip and no action menu", () => {
    setup();
    expect(screen.getByText("Воркспейсы")).toBeTruthy();
    expect(screen.getByText("Дом агента")).toBeTruthy();
    expect(screen.getByText("зарезервирован")).toBeTruthy();
    expect(screen.queryByTestId("ws-menu-home")).toBeNull();
  });

  it("selects a project on row click and marks it active", () => {
    const handlers = setup();
    fireEvent.click(screen.getByTestId("ws-row-project:alpha"));
    expect(handlers.onSelect).toHaveBeenCalledWith({ scope: "project", name: "alpha" });
  });

  it("selects the home on click", () => {
    const handlers = setup();
    fireEvent.click(screen.getByTestId("ws-row-home"));
    expect(handlers.onSelect).toHaveBeenCalledWith({ scope: "home" });
  });

  it("opens the ⋮ menu and offers delete; outside click closes it", () => {
    const handlers = setup();
    fireEvent.click(screen.getByTestId("ws-menu-project:beta"));
    expect(screen.getByText("Удалить")).toBeTruthy();
    fireEvent.click(screen.getByText("Удалить"));
    expect(handlers.onDelete).toHaveBeenCalledWith(projects[1]);
  });

  it("shows the empty hint when there are no projects", () => {
    setup({ projects: [] });
    expect(screen.getByText("Проектов нет.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement `WorkspaceList.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import type { WorkspaceProject } from "dsh-balbes-contracts";
import type { WorkspaceRef } from "../workspaceRef";
import { refKey } from "../workspaceRef";

interface WorkspaceListProps {
  homePath: string;
  projects: WorkspaceProject[];
  selected: WorkspaceRef | null;
  busy: boolean;
  onSelect(ref: WorkspaceRef): void;
  onCreate(): void;
  onDelete(p: WorkspaceProject): void;
}

/** Pinned agent home + projects, each row with a ⋮ action menu (delete today). */
export default function WorkspaceList({ homePath, projects, selected, busy, onSelect, onCreate, onDelete }: WorkspaceListProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openMenu === null) return;
    const onPointer = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [openMenu]);

  const homeRef: WorkspaceRef = { scope: "home" };
  return (
    <div className="ws-pane ws-list-pane" ref={rootRef} data-testid="workspace-list-pane">
      <div className="ws-pane-header">
        <h2>Воркспейсы</h2>
        <button type="button" className="icon-btn ws-add" aria-label="Создать проект" data-testid="workspace-create-open" onClick={onCreate} disabled={busy}>
          +
        </button>
      </div>
      <ul className="ws-rows">
        <li className="ws-row-wrap" data-testid="ws-row-wrap-home">
          <button
            type="button"
            className={refKey(homeRef) === (selected !== null ? refKey(selected) : "") ? "ws-row active" : "ws-row"}
            data-testid="ws-row-home"
            onClick={() => onSelect(homeRef)}
          >
            <span className="ws-row-main">
              <code>Дом агента</code>
              <span className="ws-row-path">{homePath}</span>
            </span>
          </button>
          <span className="chip">зарезервирован</span>
        </li>
        {projects.map((p) => {
          const ref: WorkspaceRef = { scope: "project", name: p.name };
          const key = refKey(ref);
          const active = key === (selected !== null ? refKey(selected) : "");
          return (
            <li className="ws-row-wrap" key={p.name} data-testid={`ws-row-wrap-${key}`}>
              <button type="button" className={active ? "ws-row active" : "ws-row"} data-testid={`ws-row-${key}`} onClick={() => onSelect(ref)}>
                <span className="ws-row-main">
                  <code>{p.name}</code>
                  <span className="ws-row-path">{p.path}</span>
                </span>
              </button>
              <div className="ws-row-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Действия для «${p.name}»`}
                  aria-expanded={openMenu === key}
                  data-testid={`ws-menu-${key}`}
                  onClick={() => setOpenMenu(openMenu === key ? null : key)}
                  disabled={busy}
                >
                  ⋮
                </button>
                {openMenu === key && (
                  <div className="ws-menu" data-testid={`ws-dropdown-${key}`}>
                    <button
                      type="button"
                      className="ws-menu-item danger"
                      data-testid={`ws-delete-${p.name}`}
                      onClick={() => {
                        setOpenMenu(null);
                        onDelete(p);
                      }}
                    >
                      Удалить
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {projects.length === 0 && <p className="ws-empty">Проектов нет.</p>}
    </div>
  );
}
```

Append CSS to `styles.css` (values are reference; keep tokens):

```css
/* ── workspaces layout panes ───────────────────────────────── */
.workspaces-page {
  flex: 1; min-height: 0; display: flex; width: 100%;
  overflow: hidden; background: var(--bg);
}
.ws-pane { display: flex; flex-direction: column; min-height: 0; }
.ws-list-pane { width: 260px; flex: none; border-right: 1px solid var(--border); background: var(--surface); }
.ws-pane-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.ws-pane-header h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); }
.ws-rows { list-style: none; margin: 0; padding: 8px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.ws-row-wrap { position: relative; display: flex; align-items: center; gap: 6px; border-radius: 6px; }
.ws-row-wrap:hover { background: var(--surface-2); }
.ws-row { flex: 1; min-width: 0; text-align: left; background: none; border: none; color: var(--text); cursor: pointer; padding: 7px 9px; border-radius: 6px; border-left: 3px solid transparent; }
.ws-row.active { background: var(--surface-2); border-left-color: var(--accent); }
.ws-row-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ws-row-main code { font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ws-row-path { color: var(--text-dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ws-row-actions { position: relative; flex: none; padding-right: 4px; }
.ws-menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; min-width: 150px; padding: 4px; box-shadow: 0 8px 24px rgba(0, 0, 0, .4); }
.ws-menu-item { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text); padding: 7px 10px; border-radius: 5px; cursor: pointer; }
.ws-menu-item:hover { background: var(--surface); }
.ws-menu-item.danger { color: var(--danger); }
.ws-menu-item.danger:hover { background: var(--danger); color: var(--bg); }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/workspaceRef.ts packages/frontend/dsh-balbes-admin/src/components/WorkspaceList.tsx packages/frontend/dsh-balbes-admin/src/styles.css packages/frontend/dsh-balbes-admin/tests/WorkspaceList.test.tsx
git commit -m "feat(admin): workspace list pane with action menu"
```

---

### Task 9: `FileTree` pane (lazy directory tree)

**Files:**
- Create: `packages/frontend/dsh-balbes-admin/src/components/FileTree.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/styles.css`
- Test: `packages/frontend/dsh-balbes-admin/tests/FileTree.test.tsx`

**Interfaces:**
- Consumes: `AdminApi.readWorkspaceDir`, `WorkspaceRef` helpers.
- Produces (used by Task 10 page):
  - `FileTreeProps { api: AdminApi; workspace: WorkspaceRef | null; refreshKey: number }` — bumping `refreshKey` clears the listing cache and refetches expanded dirs (used for live events); switching `workspace` resets expansion + cache
  - Behavior: root (`path: ""`) auto-loaded when a workspace is selected; dirs expand on click (fetch children lazily); empty dir shows «Каталог пуст»; no workspace shows «Выберите воркспейс»; `kind: "link"` rows render the name with a trailing `→` and no expander; per-dir fetch failures render an error line with a «Повторить» retry.

- [ ] **Step 1: Write the failing test**

Create `tests/FileTree.test.tsx`:

```tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import FileTree from "../src/components/FileTree";
import type { AdminApi } from "../src/api/client";
import type { WorkspaceTreeResponse } from "dsh-balbes-contracts";
import type { WorkspaceRef } from "../src/workspaceRef";

const alpha: WorkspaceRef = { scope: "project", name: "alpha" };
const rootBody: WorkspaceTreeResponse = { entries: [{ name: "src", kind: "dir" }, { name: "readme.md", kind: "file" }] };
const srcBody: WorkspaceTreeResponse = { entries: [{ name: "main.ts", kind: "file" }] };

function makeApi(dirResponses: Record<string, WorkspaceTreeResponse>): AdminApi {
  return {
    readWorkspaceDir: vi.fn(async (_scope, _name, path) => dirResponses[path] ?? { entries: [] }),
    subscribeWorkspaceEvents: vi.fn(() => () => {})
  } as unknown as AdminApi;
}

afterEach(() => cleanup());

describe("FileTree", () => {
  it("prompts to select a workspace when none is selected", () => {
    render(<FileTree api={makeApi({})} workspace={null} refreshKey={0} />);
    expect(screen.getByText("Выберите воркспейс")).toBeTruthy();
  });

  it("loads the root lazily and expands directories on demand", async () => {
    const api = makeApi({ "": rootBody, src: srcBody });
    render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    expect(await screen.findByText("src")).toBeTruthy();
    expect(screen.getByText("readme.md")).toBeTruthy();
    expect(screen.queryByText("main.ts")).toBeNull();
    fireEvent.click(screen.getByTestId("tree-dir-src"));
    expect(await screen.findByText("main.ts")).toBeTruthy();
    expect(api.readWorkspaceDir).toHaveBeenCalledWith("project", "alpha", "src");
  });

  it("shows an empty hint for an empty directory", async () => {
    const api = makeApi({ "": { entries: [] } });
    render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    expect(await screen.findByText("Каталог пуст")).toBeTruthy();
  });

  it("bumping refreshKey refetches the loaded root", async () => {
    const read = vi.fn(async () => rootBody);
    const api = { readWorkspaceDir: read } as unknown as AdminApi;
    const { rerender } = render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    expect(await screen.findByText("src")).toBeTruthy();
    rerender(<FileTree api={api} workspace={alpha} refreshKey={1} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("switching workspace resets the tree", async () => {
    const read = vi.fn(async (_s: string, n: string | undefined, p: string) =>
      p === "" && n === "alpha" ? rootBody : { entries: [] }
    );
    const api = { readWorkspaceDir: read } as unknown as AdminApi;
    const { rerender } = render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    expect(await screen.findByText("src")).toBeTruthy();
    rerender(<FileTree api={api} workspace={{ scope: "project", name: "beta" }} refreshKey={0} />);
    await waitFor(() => expect(read).toHaveBeenCalledWith("project", "beta", ""));
    expect(read).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement `FileTree.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceTreeEntry } from "dsh-balbes-contracts";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";

interface FileTreeProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
  refreshKey: number;
}

const ROOT = "";

function joinRel(dir: string, name: string): string {
  return dir === ROOT ? name : `${dir}/${name}`;
}

function dirIdOf(dir: string): string {
  return dir === ROOT ? "root" : dir.replace(/\//g, "_");
}

/**
 * Lazy directory tree keyed by relative dir path ("" = workspace root): the
 * root loads when a workspace is selected; each dir's children load on first
 * expand. `refreshKey` bumps re-read every expanded dir (used after fs events).
 */
export default function FileTree({ api, workspace, refreshKey }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Map<string, WorkspaceTreeEntry[]>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const lastWorkspace = useRef<WorkspaceRef | null>(null);
  const seq = useRef(0);

  const loadDir = useCallback(
    async (dir: string) => {
      if (workspace === null) return;
      const mySeq = ++seq.current;
      setLoading((s) => new Set(s).add(dir));
      setErrors((m) => {
        const next = new Map(m);
        next.delete(dir);
        return next;
      });
      try {
        const res = await api.readWorkspaceDir(workspace.scope, workspace.name, dir);
        if (mySeq !== seq.current) return; // superseded by a newer load
        setCache((m) => new Map(m).set(dir, res.entries));
      } catch (err) {
        if (mySeq !== seq.current) return;
        setErrors((m) => new Map(m).set(dir, err instanceof Error ? err.message : "load failed"));
      } finally {
        setLoading((s) => {
          const next = new Set(s);
          next.delete(dir);
          return next;
        });
      }
    },
    [api, workspace]
  );

  // workspace switch: full reset
  useEffect(() => {
    if (!isSameRef(lastWorkspace.current, workspace)) {
      lastWorkspace.current = workspace;
      setExpanded(new Set());
      setCache(new Map());
      setErrors(new Map());
    }
  }, [workspace]);

  // (re)load the root when the selection or refreshKey changes
  useEffect(() => {
    if (workspace === null) return;
    void loadDir(ROOT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, refreshKey]);

  // on refreshKey bumps only, re-read every expanded dir (external changes).
  // `expanded` is deliberately omitted from deps: on a workspace switch the
  // reset effect above clears it in the same commit, and this effect must not
  // fire for stale expansion state against the new workspace.
  useEffect(() => {
    if (workspace === null) return;
    for (const dir of expanded) void loadDir(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const toggle = (dir: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void loadDir(dir);
      }
      return next;
    });
  };

  if (workspace === null) {
    return (
      <div className="ws-pane ws-tree-pane" data-testid="tree-pane">
        <div className="ws-pane-header"><h2>Содержимое</h2></div>
        <p className="ws-placeholder" data-testid="tree-prompt">Выберите воркспейс</p>
      </div>
    );
  }

  const rootEntries = cache.get(ROOT);
  const rootError = errors.get(ROOT);
  const rootLoaded = rootEntries !== undefined || rootError !== undefined;

  return (
    <div className="ws-pane ws-tree-pane" data-testid="tree-pane">
      <div className="ws-pane-header">
        <h2>{workspace.scope === "home" ? "Дом агента" : workspace.name}</h2>
      </div>
      <div className="ws-tree">
        {!rootLoaded && <p className="ws-placeholder">Загрузка…</p>}
        {rootLoaded && rootEntries !== undefined && rootEntries.length === 0 && (
          <p className="ws-placeholder" data-testid="tree-empty">Каталог пуст</p>
        )}
        {rootError !== undefined && (
          <p className="form-error" data-testid="tree-load-error">
            {rootError}{" "}
            <button type="button" className="btn-ghost" onClick={() => void loadDir(ROOT)}>
              Повторить
            </button>
          </p>
        )}
        {rootEntries !== undefined &&
          rootEntries
            .filter((e) => e.kind === "dir")
            .map((d) => (
              <DirRow
                key={d.name}
                dir={joinRel(ROOT, d.name)}
                depth={0}
                expanded={expanded}
                cache={cache}
                errors={errors}
                loading={loading}
                onToggle={toggle}
              />
            ))}
        {rootEntries !== undefined &&
          rootEntries
            .filter((e) => e.kind !== "dir")
            .map((e) => <LeafRow key={e.name} entry={e} depth={0} />)}
      </div>
    </div>
  );
}

interface DirRowProps {
  dir: string;
  depth: number;
  expanded: Set<string>;
  cache: Map<string, WorkspaceTreeEntry[]>;
  errors: Map<string, string>;
  loading: Set<string>;
  onToggle(dir: string): void;
}

function DirRow({ dir, depth, expanded, cache, errors, loading, onToggle }: DirRowProps) {
  const name = dir.split("/").pop() ?? dir;
  const open = expanded.has(dir);
  const children = cache.get(dir);
  const hasChildren = children !== undefined && children.length > 0;
  const id = dirIdOf(dir);
  return (
    <div className="ws-tree-branch">
      <button
        type="button"
        className="ws-tree-row"
        data-testid={`tree-dir-${id}`}
        aria-expanded={open}
        onClick={() => onToggle(dir)}
        style={{ paddingLeft: 10 + depth * 14 }}
      >
        <span className={open ? "ws-caret open" : "ws-caret"}>▸</span>
        <span className="ws-dir">{name}</span>
        {loading.has(dir) && <span className="ws-file">…</span>}
      </button>
      {open && children !== undefined && children.length === 0 && (
        <p className="ws-tree-empty-note" data-testid={`tree-empty-${id}`}>Каталог пуст</p>
      )}
      {open && hasChildren &&
        children
          .filter((c) => c.kind === "dir")
          .map((c) => <DirRow key={c.name} dir={joinRel(dir, c.name)} depth={depth + 1} expanded={expanded} cache={cache} errors={errors} loading={loading} onToggle={onToggle} />)}
      {open && hasChildren &&
        children
          .filter((c) => c.kind !== "dir")
          .map((c) => <LeafRow key={c.name} entry={c} depth={depth + 1} />)}
      {open && errors.has(dir) && (
        <p className="form-error">
          {errors.get(dir)}{" "}
          <button type="button" className="btn-ghost" onClick={() => onToggle(dir)}>
            Повторить
          </button>
        </p>
      )}
    </div>
  );
}

function LeafRow({ entry, depth }: { entry: WorkspaceTreeEntry; depth: number }) {
  return (
    <span className="ws-leaf" style={{ paddingLeft: 10 + depth * 14 }}>
      <span className="ws-file">
        {entry.name}
        {entry.kind === "link" ? " →" : ""}
      </span>
    </span>
  );
}
```

Append CSS to `styles.css`:

```css
.ws-tree-pane { flex: 1; min-width: 0; border-right: 1px solid var(--border); }
.ws-tree { overflow: auto; padding: 8px 6px; }
.ws-tree-row {
  display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  background: none; border: none; color: var(--text); padding: 3px 8px;
  border-radius: 5px; cursor: pointer; font-family: var(--mono); font-size: 13px;
  white-space: nowrap;
}
button.ws-tree-row:hover { background: var(--surface); }
.ws-caret { display: inline-block; width: 10px; color: var(--text-dim); transition: transform .1s; }
.ws-caret.open { transform: rotate(90deg); }
.ws-dir { color: var(--text); }
.ws-leaf { display: flex; align-items: center; color: var(--text-dim); font-family: var(--mono); font-size: 13px; white-space: nowrap; padding: 3px 8px; }
.ws-file { color: var(--text-dim); font-family: var(--mono); font-size: 13px; white-space: nowrap; }
.ws-tree-empty-note { margin: 2px 0 2px 34px; color: var(--text-dim); font-size: 12px; }
.ws-placeholder { margin: 0; padding: 22px 16px; color: var(--text-dim); font-size: 13px; }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter dsh-balbes-admin test && pnpm --filter dsh-balbes-admin typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/components/FileTree.tsx packages/frontend/dsh-balbes-admin/src/styles.css packages/frontend/dsh-balbes-admin/tests/FileTree.test.tsx
git commit -m "feat(admin): lazy file tree pane"
```

---

### Task 10: `WorkspacesPage` — three-pane layout, selection state, resizer

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/pages/WorkspacesPage.tsx` (rewrite), `src/styles.css`
- Test: `packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx` (rewrite)

**Interfaces:**
- Consumes: Tasks 6/8/9 pieces (`AdminApi` + new methods, `WorkspaceList`, `FileTree`, `WorkspaceRef` helpers).
- Produces: page with:
  - Three panes under the topbar, full height, no page `h1`/lead; right pane `ws-void-pane` empty.
  - Resizable splitter between tree pane and void pane (pointer drag; width persisted under localStorage key `balbes.treePaneWidth`, default = 1/3 of the available width minus list width, clamped [220, 0.6 × available]).
  - Selection persisted under `balbes.selectedWorkspace` (`WorkspaceRef` JSON); restored on mount and validated against the loaded list (project gone → cleared).
  - Initial empty state (nothing selected → «Выберите воркспейс» via FileTree); list load error + retry retained (`workspace-load-error`, `workspace-load-retry`, text «Не удалось загрузить воркспейсы» / «Загрузка…»).
  - Deleting the selected project deselects; creating a project selects it.

- [ ] **Step 1: Write the failing tests (rewrite)**

Rewrite `tests/WorkspacesPage.test.tsx` (no more `window.confirm` usage — delete flows move to Task 11; keep this file focused on layout/selection/list):

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
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
    readWorkspaceDir: vi.fn(async () => ({ entries: [] })),
    subscribeWorkspaceEvents: vi.fn(() => () => {}),
    ...overrides
  } as AdminApi;
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("WorkspacesPage layout", () => {
  it("shows the pinned home and projects in the list pane", async () => {
    render(<WorkspacesPage api={makeApi()} />);
    expect(await screen.findByText("Дом агента")).toBeTruthy();
    expect(screen.getByText("/home/u/.dsh/agent")).toBeTruthy();
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByTestId("workspace-list-pane")).toBeTruthy();
    expect(screen.getByTestId("tree-pane")).toBeTruthy();
  });

  it("starts unselected and prompts to choose a workspace", async () => {
    render(<WorkspacesPage api={makeApi()} />);
    expect(await screen.findByText("Выберите воркспейс")).toBeTruthy();
  });

  it("selecting a project loads its tree; the choice survives remount", async () => {
    const api = makeApi({
      readWorkspaceDir: vi.fn(async (scope, name, path) => {
        expect(path).toBe("");
        return { entries: scope === "project" && name === "alpha" ? [{ name: "src", kind: "dir" }] : [] };
      })
    });
    const { unmount } = render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("ws-row-project:alpha"));
    expect(await screen.findByText("src")).toBeTruthy();
    unmount();

    // remount restores the last selection from localStorage
    const api2 = makeApi({
      readWorkspaceDir: vi.fn(async () => ({ entries: [{ name: "src", kind: "dir" }] }))
    });
    render(<WorkspacesPage api={api2} />);
    expect(await screen.findByText("src")).toBeTruthy();
    expect(api2.readWorkspaceDir).toHaveBeenCalledWith("project", "alpha", "");
  });

  it("selecting the home loads the agent home tree", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("ws-row-home"));
    await waitFor(() => expect(api.readWorkspaceDir).toHaveBeenCalledWith("home", undefined, ""));
  });

  it("shows an error with retry when the initial list load fails, then recovers", async () => {
    const api = makeApi({
      listWorkspaces: vi.fn().mockRejectedValueOnce(new Error("registry unreadable")).mockResolvedValueOnce(listBody)
    });
    render(<WorkspacesPage api={api} />);
    expect(await screen.findByTestId("workspace-load-error")).toBeTruthy();
    expect(screen.getByText(/Не удалось загрузить воркспейсы/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("workspace-load-retry"));
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(api.listWorkspaces).toHaveBeenCalledTimes(2);
  });
});
```

Note: deselection of a removed project is covered by a real list event in Task 12 (a list refresh happens only on mount, retry, create/delete, or a Task 12 list event) — do not add a stale provisional test here.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL (old markup/ids are gone; component not yet rewritten).

- [ ] **Step 3: Rewrite `WorkspacesPage.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminApi } from "../api/client";
import type { WorkspaceListResponse, WorkspaceProject } from "dsh-balbes-contracts";
import WorkspaceList from "../components/WorkspaceList";
import FileTree from "../components/FileTree";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";

const SELECTED_KEY = "balbes.selectedWorkspace";
const TREE_WIDTH_KEY = "balbes.treePaneWidth";

function readSelected(): WorkspaceRef | null {
  try {
    const raw = localStorage.getItem(SELECTED_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as WorkspaceRef;
    if (parsed !== null && typeof parsed === "object" && (parsed.scope === "home" || parsed.scope === "project")) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

interface WorkspacesPageProps {
  api: AdminApi;
}

export default function WorkspacesPage({ api }: WorkspacesPageProps) {
  const [data, setData] = useState<WorkspaceListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<WorkspaceRef | null>(readSelected);
  const [refreshKey, setRefreshKey] = useState(0);
  const pageRef = useRef<HTMLDivElement>(null);
  const [treeWidth, setTreeWidth] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(TREE_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null; // null = CSS default (33%)
  });

  const refresh = useCallback(async (): Promise<WorkspaceListResponse> => {
    const next = await api.listWorkspaces();
    setData(next);
    return next;
  }, [api]);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "list failed");
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  // keep the selection valid: project rows can disappear on refresh/events
  useEffect(() => {
    if (data === null || selected === null) return;
    if (selected.scope === "project" && !data.projects.some((p) => p.name === selected.name)) {
      setSelected(null);
      localStorage.removeItem(SELECTED_KEY);
    }
  }, [data, selected]);

  const select = useCallback((ref: WorkspaceRef): void => {
    setSelected(ref);
    localStorage.setItem(SELECTED_KEY, JSON.stringify(ref));
  }, []);

  async function handleDelete(project: WorkspaceProject): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteWorkspace(project.name);
      if (selected !== null && selected.scope === "project" && selected.name === project.name) {
        setSelected(null);
        localStorage.removeItem(SELECTED_KEY);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  if (data === null) {
    return (
      <div className="workspaces-page" data-testid="workspaces-page">
        <div className="ws-center-state">
          {error !== null ? (
            <>
              <p className="form-error" role="alert" data-testid="workspace-load-error">
                Не удалось загрузить воркспейсы: {error}
              </p>
              <button type="button" className="btn" onClick={() => void load()} data-testid="workspace-load-retry">
                Повторить
              </button>
            </>
          ) : (
            <p className="ws-placeholder">Загрузка…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="workspaces-page" data-testid="workspaces-page" ref={pageRef}>
      <WorkspaceList
        homePath={data.home.path}
        projects={data.projects}
        selected={selected}
        busy={busy}
        onSelect={select}
        onCreate={() => {/* modal wiring lands in Task 11 */}
        onDelete={() => {/* modal wiring lands in Task 11 */}
      />
      <div
        className="ws-tree-shell"
        style={treeWidth === null ? undefined : ({ "--tree-w": `${treeWidth}px` } as React.CSSProperties)}
      >
        <FileTree api={api} workspace={selected} refreshKey={refreshKey} />
      </div>
      <div className="ws-splitter" data-testid="ws-splitter" onPointerDown={startResize} />
      <div className="ws-pane ws-void-pane" data-testid="ws-void-pane" />
    </div>
  );

  function startResize(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    const container = pageRef.current;
    if (container === null) return;
    const startX = e.clientX;
    const startW = treeWidth ?? Math.round(container.clientWidth / 3);
    let lastW = startW;
    const onMove = (ev: PointerEvent): void => {
      const maxW = container.clientWidth - 360; // room for the list pane and a void minimum
      lastW = Math.min(Math.max(startW + (ev.clientX - startX), 220), Math.max(maxW, 220));
      setTreeWidth(lastW);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(TREE_WIDTH_KEY, String(lastW));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
}
```

Implementation notes for the implementer:
- Until Task 11 both `onCreate` and `onDelete` must be safe no-ops — **delete** the `async function handleDelete(...)` block shown in the layout draft above (it deleted immediately on row-click; that path is replaced by modal flows in Task 11, where `confirmDelete` is reintroduced). Keep the code compiling and the suite green at the end of this task.
- The tree pane width is applied by `.ws-tree-shell` via the CSS variable `--tree-w` (default `33%`); dragging sets an explicit px value and persists it. `startResize` above is complete — no further seams.

Append CSS to `styles.css`:

```css
.ws-tree-shell {
  flex: 0 0 var(--tree-w, 33%); min-width: 220px; min-height: 0;
  display: flex; border-right: 1px solid var(--border);
}
.ws-tree-shell .ws-tree-pane { flex: 1; border-right: none; width: auto; }
.ws-splitter { width: 5px; flex: none; cursor: col-resize; background: transparent; }
.ws-splitter:hover { background: var(--accent); opacity: .5; }
.ws-void-pane { flex: 1; min-width: 0; background: var(--bg); }
.ws-center-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: PASS (deselection-on-removal is covered in Task 12).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/pages/WorkspacesPage.tsx packages/frontend/dsh-balbes-admin/src/styles.css packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx
git commit -m "feat(admin): three-pane workspaces layout with selection state"
```

---

### Task 11: Create/delete modal flows in `WorkspacesPage`

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/pages/WorkspacesPage.tsx`, `src/styles.css`
- Test: `packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx` (extend)

**Interfaces:**
- Consumes: `Modal` (Task 7).
- Produces (user-visible flows, Russian copy verbatim from Global Constraints):
  - «+» opens the create modal (`workspace-create-open`), title «Создать проект», input `workspace-name-input` (placeholder `имя проекта (a-z, 0-9, . _ -)`), submit `workspace-create-submit` («Создать») disabled while busy or when the trimmed name is empty; on success close the modal, refresh, and select the new project.
  - «⋮» → «Удалить» opens the delete modal for that project: title «Удалить проект», body shows the name (code) and path, warning «Каталог будет удалён безвозвратно.», buttons «Удалить» (`workspace-delete-<name>`, danger) and «Отмена» (`workspace-delete-cancel`); confirm → `api.deleteWorkspace`, deselect if it was selected, refresh, close.

- [ ] **Step 1: Write the failing tests (extend WorkspacesPage.test.tsx)**

```tsx
describe("WorkspacesPage create/delete flows", () => {
  it("creates a project via the modal and selects it", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("workspace-create-open"));
    expect(screen.getByText("Создать проект")).toBeTruthy();
    fireEvent.change(screen.getByTestId("workspace-name-input"), { target: { value: "beta" } });
    fireEvent.click(screen.getByTestId("workspace-create-submit"));
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledWith("beta"));
    await waitFor(() => expect(api.listWorkspaces).toHaveBeenCalledTimes(2));
    // the new project gets selected: its tree loads
    await waitFor(() => expect(api.readWorkspaceDir).toHaveBeenCalledWith("project", "beta", ""));
  });

  it("deletes a project through the menu and confirm modal, deselecting it", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("ws-row-project:alpha"));
    expect(await screen.findByText("src")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ws-menu-project:alpha"));
    fireEvent.click(screen.getByTestId("ws-delete-alpha"));
    expect(screen.getByText("Удалить проект")).toBeTruthy();
    expect(screen.getByText(/безвозвратно/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("workspace-delete-alpha"));
    await waitFor(() => expect(api.deleteWorkspace).toHaveBeenCalledWith("alpha"));
    await waitFor(() => expect(api.listWorkspaces).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Выберите воркспейс")).toBeTruthy();
  });

  it("cancel keeps the project and performs no deletion", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    fireEvent.click(screen.getByTestId("ws-menu-project:alpha"));
    fireEvent.click(screen.getByTestId("ws-delete-alpha"));
    fireEvent.click(screen.getByTestId("workspace-delete-cancel"));
    expect(api.deleteWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByText("Удалить проект")).toBeNull();
  });
});
```

Adjust `makeApi` fixtures so the default `readWorkspaceDir` returns `{ entries: [] }` — the create test above asserts the call, not the entries; make sure `alpha`'s tree shows *something* only where earlier tests need it (keep the earlier layout tests' overrides intact).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL — create/delete modal behaviors missing.

- [ ] **Step 3: Implement the flows in `WorkspacesPage.tsx`**

Add state and handlers (replacing the Task 10 `onCreate` no-op and extending `handleDelete`):

```tsx
  const [modal, setModal] = useState<null | { type: "create" } | { type: "delete"; project: WorkspaceProject }>(null);
  const [name, setName] = useState("");
```

```tsx
  async function handleCreate(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createWorkspace(trimmed);
      setName("");
      setModal(null);
      const fresh = await refresh();
      const created = fresh.projects.find((p) => p.name === res.project.name);
      if (created !== undefined) select({ scope: "project", name: created.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (modal === null || modal.type !== "delete" || busy) return;
    setBusy(true);
    setError(null);
    const project = modal.project;
    try {
      await api.deleteWorkspace(project.name);
      setModal(null);
      if (selected !== null && selected.scope === "project" && selected.name === project.name) {
        setSelected(null);
        localStorage.removeItem(SELECTED_KEY);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }
```

Replace the `WorkspaceList` `onCreate`/`onDelete` props and render the modals (inside the returned root):

```tsx
      <WorkspaceList
        homePath={data.home.path}
        projects={data.projects}
        selected={selected}
        busy={busy}
        onSelect={select}
        onCreate={() => setModal({ type: "create" })}
        onDelete={(p) => setModal({ type: "delete", project: p })}
      />
```

```tsx
      {modal !== null && modal.type === "create" && (
        <Modal title="Создать проект" onClose={() => setModal(null)}>
          <form
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
              autoFocus
            />
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)} data-testid="workspace-create-cancel">
                Отмена
              </button>
              <button type="submit" className="btn" disabled={busy || name.trim() === ""} data-testid="workspace-create-submit">
                {busy ? "Создаётся…" : "Создать"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal !== null && modal.type === "delete" && (
        <Modal title="Удалить проект" onClose={() => setModal(null)}>
          <p className="ws-modal-text">
            Удалить проект <code>{modal.project.name}</code>? Каталог {modal.project.path} будет удалён безвозвратно.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setModal(null)} data-testid="workspace-delete-cancel">
              Отмена
            </button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => void confirmDelete()} data-testid={`workspace-delete-${modal.project.name}`}>
              {busy ? "Удаляется…" : "Удалить"}
            </button>
          </div>
        </Modal>
      )}
```

Append CSS:

```css
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.ws-modal-text { margin: 0; font-size: 13.5px; color: var(--text); }
.ws-modal-text code { font-family: var(--mono); color: var(--text); }
.modal form { display: flex; flex-direction: column; gap: 12px; }
```

Note: with the modal flow, remove any leftover `handleDelete`-as-direct-confirm path from Task 10 (the old `handleDelete(project)` that deleted immediately must go — `onDelete` now only opens the modal).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter dsh-balbes-admin test && pnpm --filter dsh-balbes-admin typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/pages/WorkspacesPage.tsx packages/frontend/dsh-balbes-admin/src/styles.css packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx
git commit -m "feat(admin): create and delete project modal flows"
```

---

### Task 12: Live events wiring in `WorkspacesPage`

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/pages/WorkspacesPage.tsx`
- Test: `packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx` (extend; make the Task 10 provisional deselection test real)

**Interfaces:**
- Consumes: `AdminApi.subscribeWorkspaceEvents` (Task 6).
- Produces: while the page is mounted it subscribes once and unsubscribes on unmount; handling:
  - `{ kind: "list" }` → `refresh()` (and the existing deselection effect cleans a vanished selection);
  - `{ kind: "fs", scope, name, path }` matching the selected workspace → debounced (~300 ms) `refreshKey` bump so FileTree reloads expanded dirs; non-matching fs events are ignored.
  - A server restart / reconnect is handled implicitly: the client reconnects, and the next events keep the tree fresh.

- [ ] **Step 1: Write the failing test (extend WorkspacesPage.test.tsx)**

```tsx
describe("WorkspacesPage live events", () => {
  it("refreshes the tree on an fs event for the selected workspace", async () => {
    const read = vi.fn(async () => ({ entries: [{ name: "src", kind: "dir" }] }));
    const api = makeApi({ readWorkspaceDir: read });
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("ws-row-project:alpha"));
    expect(await screen.findByText("src")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(1);
    const subscribe = api.subscribeWorkspaceEvents as ReturnType<typeof vi.fn>;
    const cbs = subscribe.mock.calls;
    const cb = cbs[cbs.length - 1]?.[0] as (e: unknown) => void;
    expect(cb).toBeTypeOf("function");
    cb({ kind: "fs", scope: "project", name: "alpha", path: "" });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("deselects a project that a list event removed", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(listBody)
      .mockResolvedValueOnce({ home: { path: "/h/agent" }, projects: [] });
    const api = makeApi({ listWorkspaces: list });
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("ws-row-project:alpha"));
    await screen.findByText("src");
    const subscribe = api.subscribeWorkspaceEvents as ReturnType<typeof vi.fn>;
    const cbs = subscribe.mock.calls;
    const cb = cbs[cbs.length - 1]?.[0] as (e: unknown) => void;
    cb({ kind: "list" });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Выберите воркспейс")).toBeTruthy();
  });

  it("unsubscribes on unmount", async () => {
    const unsub = vi.fn();
    const api = makeApi({ subscribeWorkspaceEvents: vi.fn(() => unsub) });
    const { unmount } = render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL — no subscription yet.

- [ ] **Step 3: Wire the subscription**

In `WorkspacesPage.tsx` add an effect (after the selection-validity effect):

```tsx
  useEffect(() => {
    const flushTimer = { current: null as ReturnType<typeof setTimeout> | null };
    const unsubscribe = api.subscribeWorkspaceEvents((event) => {
      if (event.kind === "list") {
        void refresh();
        return;
      }
      const matches =
        selected !== null &&
        event.scope === selected.scope &&
        (selected.scope === "home" || event.name === selected.name);
      if (!matches) return;
      if (flushTimer.current === null) {
        flushTimer.current = setTimeout(() => {
          flushTimer.current = null;
          setRefreshKey((k) => k + 1);
        }, 300);
      }
    });
    return () => {
      unsubscribe();
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    };
  }, [api, refresh, selected]);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter dsh-balbes-admin test && pnpm --filter dsh-balbes-admin typecheck`
Expected: PASS (including the formerly provisional deselection case, now driven by a real list event).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/pages/WorkspacesPage.tsx packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx
git commit -m "feat(admin): live tree refresh from workspace events"
```

---

### Task 13: Runbook smoke update, API registry sync (canon-write), full checks

**Files:**
- Modify: `docs/runbooks/stage2-vps.md` (same commit as the feature code, per AGENTS.md)
- Modify: `docs/canon/API_CONTRACTS.md` — ONLY via the canon-write skill, never a raw edit

**Interfaces:**
- Consumes: everything above; `dsh` + the deployed profile for the smoke steps.
- Produces: runbook + registry reflect the new surface; repo-wide checks green.

- [ ] **Step 1: Update the runbook smoke section**

Read `docs/runbooks/stage2-vps.md`, find the workspaces API smoke block (endpoints `list|create|delete`, around lines 190–200) and:
1. Extend the endpoint summary line near the top (it currently lists `/api/workspaces/list|create|delete`) with `/api/workspaces/tree` and `/api/workspaces/events`.
2. Add smoke curl steps after the existing delete curl, with expected outputs:
   - `POST /api/workspaces/tree` `{scope:"project",name:"alpha",path:""}` → 200 `{entries:[...]}`; traversal `{path:"../.."}` → 400 `invalid-path`; unknown dir → 404 `not-found`; without token → 401.
   - `POST /api/workspaces/events` without token → 401 (a full stream smoke belongs to the REAL test; note that opening the stream with `curl -N -X POST` and then touching a file under the project yields a `data:` frame — expected output `data: {"kind":"fs",...}`).
3. In the UI smoke paragraph (page «Проекты»), replace the old description with the new layout smoke: list pane with pinned «Дом агента» and «⋮» on projects, tree appears after selecting a project, «Каталог пуст» for an empty project, and that creating a file on the server (e.g. `touch $DSH_HOME/projects/<name>/x.txt`) appears in the tree without a page reload.
4. Keep expected-output style consistent with the surrounding blocks.

- [ ] **Step 2: Register the endpoints in canon (canon-write)**

Load the canon-write skill and follow it (scout → expand → write → `doc-canon validate --json` → `doc-canon index`): add two entries to `docs/canon/API_CONTRACTS.md` under `Current state`, in the registry's template (`### <id> — <название>` + method/path/auth/request/response/errors/notes):
- `workspaces.tree` — POST `/api/workspaces/tree`, bearer; request `{scope: "home"|"project", name?: string, path: string}`; response `{entries: [{name, kind: "dir"|"file"|"link"}]}`; errors 400 `invalid-name`/`invalid-path`, 404 `not-found`, 401; notes: lazy per-directory read, entries from `Dirent` only (symlinks = `kind:"link"`, never followed), dot-entries included, dirs first; scoped containment (lexical + realpath), никогда не выходит за корень воркспейса; дерево дома — `$DSH_HOME/agent/`.
- `workspaces.events` — POST `/api/workspaces/events`, bearer; request `{}`; response 200 `text/event-stream` (не закрывается); frames `data: {json}` where the payload is `WorkspaceFsEvent` (`kind:"fs", scope, name?, path` — каталог, чей список изменился) or `WorkspaceListEvent` (`kind:"list"` — состав проектов изменился); heartbeat `: ping` каждые 25 с; notes: push-канал изменений каталогов для дерева (внешние правки владельца/агента), соединение закрывается клиентом, 401 при невалидном токене; исключения из R-API-1 нет — запрос остаётся POST, потоковая доставка ответа модели в чат — по-прежнему вне scope.
Also update the Scope line in the same section that enumerates covered endpoints and the «будущие каналы» wording if it now reads stale, keeping prose within `max_line_length`.

- [ ] **Step 3: Full verification**

Run:
```bash
pnpm typecheck && pnpm test && pnpm build
RUN_REAL=1 pnpm --filter dsh-balbes-workspaces test
pnpm --filter dsh-balbes-admin build
```
Expected: all green. (REAL suite requires `dsh` on PATH.)

- [ ] **Step 4: Run canon validation once more**

Run: `doc-canon validate --json`
Expected: exit 0, `"ok": true`, zero error-severity issues.

- [ ] **Step 5: Commit (code + runbook together, then canon separately if needed)**

```bash
git add docs/runbooks/stage2-vps.md
git commit -m "docs(runbook): smoke coverage for tree and events endpoints"
# canon commit follows the canon-write workflow's own guidance (registry same-commit rule is
# satisfied because the canon commit lands in the same feature change set)
```

---

## Self-review notes

- **Spec coverage:** ADMIN_UI three-pane layout → Tasks 8–12; list pane pinned home + ⋮ → Task 8; create/delete modals → Tasks 7/11; empty states & localStorage selection → Tasks 9/10; live tree → Tasks 4/5/6/12; scoped tree read (ARCHITECTURE/OVERVIEW) → Tasks 2/3/5; runbook/registry → Task 13. Right void pane and deferred decisions (hidden-file policy is *show dotfiles*, row content = name+path) are explicit in Tasks 9/8 and the Global Constraints.
- **Wire decisions made here** (plan-level, per the approved approach «экран в каноне, wire-контракты с кодом»): tree request/response and event payload shapes above are the contracts to implement; they land in `API_CONTRACTS.md` in Task 13 and in `dsh-balbes-contracts` in Task 1. Transport: POST + SSE framing over the existing router (R-API-1 preserved, no deps, bearer header works with `fetch`). Transport was intentionally left out of the canon write; if implementation proves it wrong, update ARCHITECTURE/API_CONTRACTS canon **before** changing the code (canon-first ratchet).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-08-workspaces-layout.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach? (Before task 1, the canon commit for the three canon files must exist — that is an owner action or an explicit first commit.)
