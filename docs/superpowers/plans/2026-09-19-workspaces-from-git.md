# Workspaces from GitHub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner create a project workspace by cloning a public or private GitHub repository into `$DSH_HOME/projects/<name>/`, using one server-stored GitHub token.

**Architecture:** A new function-plugin `dsh-balbes-git` owns the GitHub token (engine `credentials`, ref `BALBES_GITHUB_TOKEN`) and the `git` process, exposing the `balbesGit` service and `/api/git/*` routes. `dsh-balbes-workspaces` owns project lifecycle: a new `create-from-git` route validates the name, calls `balbesGit` to clone into a hidden temp dir, then renames it into place and writes the registry row with a `source`. The React SPA gets a «Git-доступ» block and a two-mode create modal.

**Tech Stack:** TypeScript (strict ESM, NodeNext), Cordis function plugins over dsh, Vitest, React 18 + Vite, bash installer, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-19-workspaces-from-git-design.md`

## Global Constraints

- All `/api/*` requests are POST; JSON bodies/responses; errors `{error:{code,message}}` (R-API-1).
- Code and comments in English; UI copy in Russian.
- Only `https://github.com/<owner>/<repo>` is accepted (no userinfo/query/fragment, no other host, no http).
- The GitHub token never appears in argv, `.git/config`, logs, or API responses; only `tokenConfigured` is reported.
- Clone is a full-history clone of the default branch, timeout 120000 ms, serialized (concurrency 1); submodules/LFS are not fetched.
- Registry `projects.json` stays version 1; `source` is optional and backward compatible.
- Plugins are function plugins: named exports `name`/`inject`/`Config`/`apply`, no default export; registrations are effects.
- `docs/canon/**` is already updated (commit `35df4e0`); do not edit canon in this plan.

---

### Task 1: Shared API contracts and name suggestion

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/tests/contracts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WorkspaceGitSource`, `WorkspaceProject.source?`, `WorkspaceCreateFromGitRequest/Response`, `GitStatusRequest/Response`, `GitSaveRequest/Response`, `GitClearTokenRequest/Response`, `suggestProjectNameFromGitUrl(url): string | null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/tests/contracts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { suggestProjectNameFromGitUrl } from "../src/index.js";

describe("suggestProjectNameFromGitUrl", () => {
  it("returns the repository slug for a plain GitHub URL", () => {
    expect(suggestProjectNameFromGitUrl("https://github.com/acme/api.git")).toBe("api");
    expect(suggestProjectNameFromGitUrl("https://github.com/acme/my.repo")).toBe("my.repo");
  });
  it("returns null for non-GitHub, non-https, or malformed URLs", () => {
    expect(suggestProjectNameFromGitUrl("https://gitlab.com/acme/api.git")).toBeNull();
    expect(suggestProjectNameFromGitUrl("http://github.com/acme/api.git")).toBeNull();
    expect(suggestProjectNameFromGitUrl("https://github.com/acme")).toBeNull();
    expect(suggestProjectNameFromGitUrl("not a url")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-contracts test`
Expected: FAIL — `suggestProjectNameFromGitUrl` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/contracts/src/index.ts`, add after `WorkspaceProject` (and add `source?` to `WorkspaceProject`):

```ts
/** GitHub source of a project created from a repository. */
export interface WorkspaceGitSource {
  provider: "github";
  /** Clean https URL without a token. */
  url: string;
  /** Default branch name. */
  branch: string;
  /** Resolved commit sha. */
  ref: string;
}

export interface WorkspaceProject {
  name: string;
  path: string;
  createdAt?: string; // ISO 8601; absent for hand-made dirs without a registry row
  /** Present only when the project was cloned from a git repository. */
  source?: WorkspaceGitSource;
}

export interface WorkspaceCreateFromGitRequest {
  url: string;
  name: string;
}
export interface WorkspaceCreateFromGitResponse {
  project: WorkspaceProject;
}

export interface GitStatusRequest {}
export interface GitStatusResponse {
  git: { tokenConfigured: boolean };
}
export interface GitSaveRequest {
  token: string;
}
export interface GitSaveResponse {
  git: { tokenConfigured: boolean };
}
export interface GitClearTokenRequest {}
export interface GitClearTokenResponse {
  git: { tokenConfigured: boolean };
}

/**
 * Suggested project slug from a GitHub https URL (UI prefill only; the server
 * validates whatever name is actually submitted). Null when the URL is not a
 * valid `https://github.com/<owner>/<repo>` URL.
 */
export function suggestProjectNameFromGitUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
  const segments = parsed.pathname.split("/").filter((s) => s !== "");
  if (segments.length !== 2) return null;
  const repo = segments[1]!.endsWith(".git") ? segments[1]!.slice(0, -4) : segments[1]!;
  return repo === "" ? null : repo;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-contracts test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/tests/contracts.test.ts
git commit -m "feat(contracts): git workspace creation types and name suggestion"
```

---

### Task 2: `dsh-balbes-git` package + GitHub URL parsing

**Files:**
- Create: `packages/plugins/dsh-balbes-git/package.json`
- Create: `packages/plugins/dsh-balbes-git/tsconfig.json`
- Create: `packages/plugins/dsh-balbes-git/tsconfig.build.json`
- Create: `packages/plugins/dsh-balbes-git/src/git.ts`
- Test: `packages/plugins/dsh-balbes-git/tests/git.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GITHUB_HOST`, `DEFAULT_GIT_TIMEOUT_MS`, `REDACTED`, `GitError`, `GitErrorCode`, `GithubSource`, `parseGitHubUrl(raw): GithubSource`.

- [ ] **Step 1: Create the package scaffold**

`packages/plugins/dsh-balbes-git/package.json`:

```json
{
  "name": "dsh-balbes-git",
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

`packages/plugins/dsh-balbes-git/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests"]
}
```

`packages/plugins/dsh-balbes-git/tsconfig.build.json`:

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

`packages/plugins/dsh-balbes-git/tests/git.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseGitHubUrl, GitError } from "../src/git.js";

describe("parseGitHubUrl", () => {
  it("accepts a plain https GitHub URL and normalizes it", () => {
    expect(parseGitHubUrl("https://github.com/acme/api")).toEqual({
      provider: "github",
      host: "github.com",
      owner: "acme",
      repo: "api",
      url: "https://github.com/acme/api.git"
    });
    expect(parseGitHubUrl("https://github.com/acme/api.git").repo).toBe("api");
  });

  it("rejects non-GitHub hosts, http, userinfo, query and fragment", () => {
    for (const bad of [
      "https://gitlab.com/acme/api.git",
      "http://github.com/acme/api.git",
      "https://user:pass@github.com/acme/api.git",
      "https://github.com/acme/api.git?x=1",
      "https://github.com/acme/api.git#main",
      "https://github.com/acme",
      "https://github.com/acme/api/extra",
      "not a url"
    ]) {
      expect(() => parseGitHubUrl(bad), bad).toThrow(GitError);
    }
  });

  it("rejects traversal-ish owner/repo names", () => {
    expect(() => parseGitHubUrl("https://github.com/a..b/api.git")).toThrow(GitError);
    expect(() => parseGitHubUrl("https://github.com/acme/..")).toThrow(GitError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-git test`
Expected: FAIL — module `../src/git.js` does not exist / build not present. (Run `pnpm install` first so the workspace links the new package.)

- [ ] **Step 4: Write minimal implementation**

`packages/plugins/dsh-balbes-git/src/git.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const GITHUB_HOST = "github.com";
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
export const REDACTED = "***";

export type GitErrorCode =
  | "invalid-url"
  | "auth-required"
  | "clone-timeout"
  | "clone-failed";

export class GitError extends Error {
  constructor(readonly code: GitErrorCode, message: string) {
    super(message);
    this.name = "GitError";
  }
}
export function gitError(code: GitErrorCode, message: string): GitError {
  return new GitError(code, message);
}

export interface GithubSource {
  provider: "github";
  host: "github.com";
  owner: string;
  repo: string;
  /** Clean https URL (no token), pointable at by `git clone`. */
  url: string;
}

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** Parse and validate a GitHub https URL into a token-free source. */
export function parseGitHubUrl(raw: string): GithubSource {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw gitError("invalid-url", "repository URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") throw gitError("invalid-url", "only https GitHub URLs are supported");
  if (parsed.hostname !== GITHUB_HOST) throw gitError("invalid-url", "only github.com repositories are supported");
  if (parsed.username !== "" || parsed.password !== "") throw gitError("invalid-url", "credentials in the URL are not allowed");
  if (parsed.search !== "" || parsed.hash !== "") throw gitError("invalid-url", "query and fragment are not allowed");
  const segments = parsed.pathname.split("/").filter((s) => s !== "");
  if (segments.length !== 2) throw gitError("invalid-url", "expected https://github.com/<owner>/<repo>");
  const owner = segments[0]!;
  const repo = segments[1]!.endsWith(".git") ? segments[1]!.slice(0, -4) : segments[1]!;
  if (!SLUG_RE.test(owner) || !SLUG_RE.test(repo) || owner.includes("..") || repo.includes("..")) {
    throw gitError("invalid-url", "invalid owner or repository name");
  }
  return { provider: "github", host: GITHUB_HOST, owner, repo, url: `https://${GITHUB_HOST}/${owner}/${repo}.git` };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm install && pnpm --filter dsh-balbes-git test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/dsh-balbes-git pnpm-lock.yaml
git commit -m "feat(git): scaffold dsh-balbes-git plugin and GitHub URL parsing"
```

---

### Task 3: Git runner — clone argv, token env, failure mapping

**Files:**
- Modify: `packages/plugins/dsh-balbes-git/src/git.ts`
- Test: `packages/plugins/dsh-balbes-git/tests/git.test.ts` (append), `packages/plugins/dsh-balbes-git/tests/real-git.test.ts` (new)

**Interfaces:**
- Consumes: `GithubSource`, `GitError`, `parseGitHubUrl` from Task 2.
- Produces: `cloneArgs(source, hasToken): string[]`, `runClone(source, destDir, token, timeoutMs?): Promise<{branch, ref}>`, `redact(text, token)`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/plugins/dsh-balbes-git/tests/git.test.ts`:

```ts
import { cloneArgs, parseGitHubUrl, redact } from "../src/git.js";

describe("cloneArgs", () => {
  it("never puts the token value in argv", () => {
    const source = parseGitHubUrl("https://github.com/acme/api.git");
    const withToken = cloneArgs(source, true);
    const without = cloneArgs(source, false);
    expect(withToken.join(" ")).not.toContain("secret-value");
    expect(withToken.some((a) => a.includes("BALBES_GIT_TOKEN"))).toBe(true);
    expect(without.some((a) => a.includes("credential.helper"))).toBe(true); // clearing helper is fine
    expect(without.some((a) => a.includes("BALBES_GIT_TOKEN"))).toBe(false);
    expect(withToken[withToken.length - 2]).toBe("--");
    expect(withToken[withToken.length - 1]).toBe(source.url);
  });
});

describe("redact", () => {
  it("replaces every occurrence of the token", () => {
    expect(redact("boom ghp_secret and ghp_secret again", "ghp_secret")).toBe("boom *** and *** again");
    expect(redact("plain", undefined)).toBe("plain");
  });
});
```

`packages/plugins/dsh-balbes-git/tests/real-git.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runClone, type GithubSource } from "../src/git.js";

const execFileP = promisify(execFile);

describe("runClone (real git, local file:// repo)", () => {
  let work: string;
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "balbes-git-real-"));
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("clones a local repository and reports branch + ref", async () => {
    const origin = join(work, "origin");
    await mkdir(origin, { recursive: true });
    const git = (args: string[]) => execFileP("git", args, { cwd: origin });
    await git(["init", "-q", "-b", "main"]);
    await writeFile(join(origin, "README.md"), "hello\n", "utf8");
    await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "README.md"]);
    await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);

    const dest = join(work, "dest");
    const source: GithubSource = {
      provider: "github",
      host: "github.com",
      owner: "local",
      repo: "origin",
      url: pathToFileURL(origin).href
    };
    const result = await runClone(source, dest, undefined, 30_000);
    expect(result.branch).toBe("main");
    expect(result.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(dest, "README.md"), "utf8")).toBe("hello\n");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter dsh-balbes-git test`
Expected: FAIL — `cloneArgs` / `runClone` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/plugins/dsh-balbes-git/src/git.ts`:

```ts
export interface CloneResult {
  branch: string;
  ref: string;
}

/** Args for a clone. The token is supplied via env, never as an arg value. */
export function cloneArgs(source: GithubSource, hasToken: boolean): string[] {
  const args = ["-c", "credential.helper="];
  if (hasToken) {
    args.push("-c", 'credential.helper=!f(){ echo username=x-access-token; echo "password=$BALBES_GIT_TOKEN"; }; f');
  }
  args.push("clone", "--", source.url);
  return args;
}

/** Replace every occurrence of the token in an arbitrary string. */
export function redact(value: string, token: string | undefined): string {
  if (token === undefined || token === "") return value;
  return value.split(token).join(REDACTED);
}

function gitEnv(token: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1"
  };
  if (token !== undefined) env.BALBES_GIT_TOKEN = token;
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() ?? "unknown error";
}

function mapGitFailure(error: unknown, token: string | undefined): GitError {
  const e = error as { killed?: boolean; signal?: string; stderr?: string; message?: string; code?: number };
  const raw = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  const safe = redact(raw, token);
  if (e?.killed === true || e?.signal === "SIGKILL") return gitError("clone-timeout", "git clone timed out");
  if (
    token === undefined &&
    /could not read Username|Authentication failed|repository not found|Invalid username or password/i.test(safe)
  ) {
    return gitError("auth-required", "repository is not accessible: it may be private; set a GitHub token");
  }
  return gitError("clone-failed", `git clone failed: ${firstLine(safe)}`);
}

/** Clone `source.url` into `destDir` (must not exist), then read branch + commit. */
export async function runClone(
  source: GithubSource,
  destDir: string,
  token: string | undefined,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS
): Promise<CloneResult> {
  const env = gitEnv(token);
  try {
    await execFileP("git", [...cloneArgs(source, token !== undefined), destDir], {
      timeout: timeoutMs,
      env,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (error) {
    throw mapGitFailure(error, token);
  }
  try {
    const branch = (await execFileP("git", ["-C", destDir, "symbolic-ref", "--short", "HEAD"], { env })).stdout.trim();
    const ref = (await execFileP("git", ["-C", destDir, "rev-parse", "HEAD"], { env })).stdout.trim();
    return { branch, ref };
  } catch (error) {
    throw mapGitFailure(error, token);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter dsh-balbes-git test`
Expected: PASS (the real-git suite needs a `git` binary; it runs without network).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-git/src/git.ts packages/plugins/dsh-balbes-git/tests
git commit -m "feat(git): clone runner with token-safe env and local-git coverage"
```

---

### Task 4: Credentials ref and `balbesGit` service

**Files:**
- Create: `packages/plugins/dsh-balbes-git/src/credentials.ts`
- Create: `packages/plugins/dsh-balbes-git/src/service.ts`
- Test: `packages/plugins/dsh-balbes-git/tests/service.test.ts`

**Interfaces:**
- Consumes: `parseGitHubUrl`, `runClone`, `GithubSource` from Tasks 2–3.
- Produces: `BALBES_GITHUB_TOKEN`, `GitCredentialsLike`, `BalbesGitService`, `createBalbesGitService(deps)`.

- [ ] **Step 1: Write the failing test**

`packages/plugins/dsh-balbes-git/tests/service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BALBES_GITHUB_TOKEN, type GitCredentialsLike } from "../src/credentials.js";
import { createBalbesGitService } from "../src/service.js";

function makeCredentials(configured?: string): GitCredentialsLike & { refs: Map<string, string> } {
  const refs = new Map<string, string>();
  if (configured !== undefined) refs.set(BALBES_GITHUB_TOKEN, configured);
  return {
    refs,
    describe: async (ref) => ({ configured: refs.has(ref), writable: true }),
    set: async (ref, value) => void refs.set(ref, value),
    unset: async (ref) => void refs.delete(ref),
    resolve: async (ref) => (refs.has(ref) ? { value: refs.get(ref)! } : undefined)
  };
}

describe("balbesGit service", () => {
  it("reports and mutates token presence through credentials", async () => {
    const credentials = makeCredentials();
    const service = createBalbesGitService({ credentials });
    expect(await service.status()).toEqual({ tokenConfigured: false });
    await service.setToken("ghp_x");
    expect(credentials.refs.get(BALBES_GITHUB_TOKEN)).toBe("ghp_x");
    expect(await service.status()).toEqual({ tokenConfigured: true });
    await service.clearToken();
    expect(await service.status()).toEqual({ tokenConfigured: false });
  });

  it("validates URLs through inspect", () => {
    const service = createBalbesGitService({ credentials: makeCredentials() });
    expect(service.inspect("https://github.com/acme/api.git").repo).toBe("api");
    expect(() => service.inspect("https://gitlab.com/acme/api.git")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-git test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

`packages/plugins/dsh-balbes-git/src/credentials.ts`:

```ts
/** Credentials ref for the single GitHub PAT used by private clones. */
export const BALBES_GITHUB_TOKEN = "BALBES_GITHUB_TOKEN";

/** Structural slice of the engine credentials service (mirrors models/telegram). */
export interface GitCredentialsLike {
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
  resolve(ref: string): Promise<{ value: string } | undefined>;
}
```

`packages/plugins/dsh-balbes-git/src/service.ts`:

```ts
import { BALBES_GITHUB_TOKEN, type GitCredentialsLike } from "./credentials.js";
import { parseGitHubUrl, runClone, DEFAULT_GIT_TIMEOUT_MS, type GithubSource } from "./git.js";

export interface BalbesGitService {
  status(): Promise<{ tokenConfigured: boolean }>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  inspect(url: string): GithubSource;
  clone(source: GithubSource, destDir: string, opts?: { timeoutMs?: number }): Promise<{ branch: string; ref: string }>;
}

export interface BalbesGitDeps {
  credentials: GitCredentialsLike;
  timeoutMs?: number;
}

/** Facade over git access: credentials + URL validation + serialized clone. */
export function createBalbesGitService(deps: BalbesGitDeps): BalbesGitService {
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  return {
    status: async () => ({ tokenConfigured: (await deps.credentials.describe(BALBES_GITHUB_TOKEN)).configured }),
    setToken: (token) => deps.credentials.set(BALBES_GITHUB_TOKEN, token),
    clearToken: () => deps.credentials.unset(BALBES_GITHUB_TOKEN),
    inspect: (url) => parseGitHubUrl(url),
    clone: (source, destDir, opts) =>
      serialize(async () => {
        const resolved = await deps.credentials.resolve(BALBES_GITHUB_TOKEN);
        const timeoutMs = opts?.timeoutMs ?? deps.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
        return runClone(source, destDir, resolved?.value, timeoutMs);
      })
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-git test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-git/src/credentials.ts packages/plugins/dsh-balbes-git/src/service.ts packages/plugins/dsh-balbes-git/tests/service.test.ts
git commit -m "feat(git): balbesGit service over credentials and clone runner"
```

---

### Task 5: `/api/git/*` routes + REAL composition test

**Files:**
- Create: `packages/plugins/dsh-balbes-git/src/index.ts`
- Test: `packages/plugins/dsh-balbes-git/tests/index.test.ts`
- Create: `packages/plugins/dsh-balbes-git/tests/fixtures/balbes-git-profile/package.json`
- Create: `packages/plugins/dsh-balbes-git/tests/fixtures/balbes-git-profile/cordis.patch.yml`
- Create: `packages/plugins/dsh-balbes-git/tests/integration.test.ts`

**Interfaces:**
- Consumes: `createBalbesGitService`, `GitCredentialsLike`, `BALBES_GITHUB_TOKEN`.
- Produces: plugin `name = "balbes-git"`, `inject = ["balbesHttp","credentials"]`, `Config`, `apply`, service `balbesGit`.

- [ ] **Step 1: Write the failing unit test**

`packages/plugins/dsh-balbes-git/tests/index.test.ts` mirrors `packages/plugins/dsh-balbes-workspaces/tests/index.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { apply, name, inject } from "../src/index.js";
import { BALBES_GITHUB_TOKEN } from "../src/credentials.js";

interface Seat { path: string; auth: string; handler(req: unknown, res: unknown, body: unknown): Promise<void> | void }

let seats: Seat[];
let refs: Map<string, string>;
let provided: Map<string, unknown>;

beforeEach(() => {
  seats = [];
  refs = new Map();
  provided = new Map();
});

function boot(): void {
  const http = { post(path: string, auth: string, handler: Seat["handler"]) { seats.push({ path, auth, handler }); } };
  const credentials = {
    describe: async (ref: string) => ({ configured: refs.has(ref), writable: true }),
    set: async (ref: string, value: string) => void refs.set(ref, value),
    unset: async (ref: string) => void refs.delete(ref),
    resolve: async (ref: string) => (refs.has(ref) ? { value: refs.get(ref)! } : undefined)
  };
  const ctx = {
    get: (key: string) => (key === "balbesHttp" ? http : key === "credentials" ? credentials : undefined),
    provide: (key: string, value: unknown) => void provided.set(key, value),
    logger: { warn: (_m: string) => {} }
  };
  apply(ctx, undefined);
}

function call(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const seat = seats.find((s) => s.path === path);
  if (seat === undefined) throw new Error("route not registered: " + path);
  return new Promise((resolve, reject) => {
    let status = 0;
    const res = {
      writeHead(code: number): void { status = code; },
      end(payload?: string): void {
        try { resolve({ status, json: payload === undefined ? undefined : JSON.parse(payload) }); }
        catch (error) { reject(error); }
      }
    };
    void Promise.resolve(seat.handler({}, res, body)).catch(reject);
  });
}

describe("balbes-git plugin", () => {
  it("exposes the plugin contract and provides balbesGit", () => {
    boot();
    expect(name).toBe("balbes-git");
    expect(inject).toEqual(["balbesHttp", "credentials"]);
    expect(seats.map((s) => s.path).sort()).toEqual([
      "/api/git/clear-token",
      "/api/git/save",
      "/api/git/status"
    ]);
    expect(provided.has("balbesGit")).toBe(true);
  });

  it("saves, reports and clears the token without echoing it", async () => {
    boot();
    expect(await call("/api/git/status", {})).toEqual({ status: 200, json: { git: { tokenConfigured: false } } });
    expect((await call("/api/git/save", { token: "  ghp_x  " })).json).toEqual({ git: { tokenConfigured: true } });
    expect(refs.get(BALBES_GITHUB_TOKEN)).toBe("ghp_x");
    expect(JSON.stringify(await call("/api/git/status", {}))).not.toContain("ghp_x");
    expect((await call("/api/git/clear-token", {})).json).toEqual({ git: { tokenConfigured: false } });
  });

  it("rejects an empty token with 400 invalid-token", async () => {
    boot();
    const res = await call("/api/git/save", { token: "   " });
    expect(res.status).toBe(400);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe("invalid-token");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-git test`
Expected: FAIL — `../src/index.js` not found.

- [ ] **Step 3: Write minimal implementation**

`packages/plugins/dsh-balbes-git/src/index.ts`:

```ts
import z from "@deepseek-ai/schemastery";
import { type GitCredentialsLike } from "./credentials.js";
import { createBalbesGitService } from "./service.js";

export const name = "balbes-git";
export const inject = ["balbesHttp", "credentials"];
export const Config = z.object({ gitTimeoutMs: z.number().default(120_000) });

interface HttpSeatLike {
  post(path: string, auth: "public" | "bearer", handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void): void;
}
interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function send(res: ResLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
  res.end(payload);
}
function fail(res: ResLike, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function apply(
  ctx: {
    get(key: string): unknown;
    provide(key: string, value: unknown): void;
    logger: { warn(m: string): void };
  },
  config: { gitTimeoutMs?: number } | undefined
): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-git: balbesHttp service missing; routes not registered");
    return;
  }
  const credentials = ctx.get("credentials") as GitCredentialsLike;
  const service = createBalbesGitService({
    credentials,
    ...(config?.gitTimeoutMs === undefined ? {} : { timeoutMs: config.gitTimeoutMs })
  });
  ctx.provide("balbesGit", service);

  http.post("/api/git/status", "bearer", async (_req, res) => {
    try {
      send(res, 200, { git: await service.status() });
    } catch (error) {
      fail(res, 500, "internal", messageOf(error));
    }
  });

  http.post("/api/git/save", "bearer", async (_req, res, body) => {
    try {
      const token = (body as { token?: unknown } | null | undefined)?.token;
      if (typeof token !== "string" || token.trim() === "") return fail(res, 400, "invalid-token", "token is required");
      await service.setToken(token.trim());
      send(res, 200, { git: await service.status() });
    } catch (error) {
      fail(res, 500, "internal", messageOf(error));
    }
  });

  http.post("/api/git/clear-token", "bearer", async (_req, res) => {
    try {
      await service.clearToken();
      send(res, 200, { git: await service.status() });
    } catch (error) {
      fail(res, 500, "internal", messageOf(error));
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-git test`
Expected: PASS.

- [ ] **Step 5: Add the test profile fixtures**

`packages/plugins/dsh-balbes-git/tests/fixtures/balbes-git-profile/package.json` — copy `packages/plugins/dsh-balbes-workspaces/tests/fixtures/balbes-workspaces-profile/package.json` and rename the profile.

`packages/plugins/dsh-balbes-git/tests/fixtures/balbes-git-profile/cordis.patch.yml`:

```yaml
- insert:
    - id: balbes-git
      name: 'dsh-balbes-git'
```

- [ ] **Step 6: Write the REAL composition test**

`packages/plugins/dsh-balbes-git/tests/integration.test.ts` — copy the boot/harness scaffold from `packages/plugins/dsh-balbes-workspaces/tests/integration.test.ts` (buildPackages, freePort, postJson, waitForHealth, RUN_REAL gate, fixture copy, admin creds, bootServer/stopServer), changing `fixtureProfile` to `fixtures/balbes-git-profile`, profile name `balbes-git-test`, and copying built `dsh-balbes-git/lib` into the test profile `node_modules`. Add `readFile` to the `node:fs/promises` import for the credentials assertion. Then:

```ts
it("git API: status/save/clear-token persists the token and never echoes it", async () => {
  if (home === undefined) throw new Error("home not initialized");
  const base = `http://127.0.0.1:${port}`;
  try {
    const token = await bootServer();
    const anon = await postJson(`${base}/api/git/status`, {});
    expect(anon.status).toBe(401);

    expect((await postJson(`${base}/api/git/status`, {}, token)).json).toEqual({ git: { tokenConfigured: false } });
    const saved = await postJson(`${base}/api/git/save`, { token: "ghp_integration" }, token);
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(JSON.stringify(saved.json)).not.toContain("ghp_integration");
    expect(await readFile(join(home, ".credentials.yaml"), "utf8")).toContain("BALBES_GITHUB_TOKEN");

    const cleared = await postJson(`${base}/api/git/clear-token`, {}, token);
    expect(cleared.json).toEqual({ git: { tokenConfigured: false } });
  } finally {
    await stopServer();
  }
}, 240_000);
```

- [ ] **Step 7: Run the REAL test**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-git test`
Expected: PASS (needs `dsh` on PATH; skips without it).

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/dsh-balbes-git
git commit -m "feat(git): /api/git routes and REAL composition coverage"
```

---

### Task 6: Registry `source` + `createProjectFromGit` domain

**Files:**
- Modify: `packages/plugins/dsh-balbes-workspaces/src/workspaces.ts`
- Test: `packages/plugins/dsh-balbes-workspaces/tests/workspaces.test.ts` (append)

**Interfaces:**
- Consumes: `validateProjectName`, `projectsRoot`, `readRegistry`, `writeRegistry`, `provisionFile`, `SKILLS_README_STARTER` (all existing in `workspaces.ts`).
- Produces: `ProjectSource`, `WorkspaceProject.source?`, `RegistryData` rows with optional `source`, `GitSourceLike`, `BalbesGitLike`, `createProjectFromGit(dshHome, git, url, name)`, `cleanupStaleCloneDirs(dshHome)`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/plugins/dsh-balbes-workspaces/tests/workspaces.test.ts`:

```ts
import { createProjectFromGit, listWorkspaces, type BalbesGitLike } from "../src/workspaces.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeGit(behavior: "ok" | "fail" = "ok"): BalbesGitLike {
  return {
    inspect: (url: string) => ({ provider: "github", url }),
    clone: async (_source, destDir) => {
      if (behavior === "fail") throw new Error("network down");
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, "README.md"), "hi", "utf8");
      return { branch: "main", ref: "a".repeat(40) };
    }
  };
}

describe("createProjectFromGit", () => {
  it("clones into the project path and records source in the registry", async () => {
    const home = await mkdtemp(join(tmpdir(), "ws-git-"));
    const project = await createProjectFromGit(home, fakeGit(), "https://github.com/acme/api.git", "api");
    expect(project.source).toEqual({ provider: "github", url: "https://github.com/acme/api.git", branch: "main", ref: "a".repeat(40) });
    expect(await readFile(join(home, "projects", "api", "README.md"), "utf8")).toBe("hi");
    expect((await listWorkspaces(home)).projects[0]?.source?.branch).toBe("main");
    const reg = JSON.parse(await readFile(join(home, "projects.json"), "utf8")) as { projects: Record<string, unknown> };
    expect(reg.projects.api).toMatchObject({ source: { provider: "github" } });
    await rm(home, { recursive: true, force: true });
  });

  it("rejects a taken name with name-exists and leaves the project untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "ws-git-"));
    await createProjectFromGit(home, fakeGit(), "https://github.com/acme/api.git", "api");
    await expect(createProjectFromGit(home, fakeGit(), "https://github.com/acme/api.git", "api")).rejects.toMatchObject({ code: "name-exists" });
    await rm(home, { recursive: true, force: true });
  });

  it("cleans the temp dir and writes nothing on clone failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "ws-git-"));
    await expect(createProjectFromGit(home, fakeGit("fail"), "https://github.com/acme/api.git", "api")).rejects.toThrow("network down");
    const entries = await readdir(join(home, "projects"));
    expect(entries).toEqual([]);
    await expect(readFile(join(home, "projects.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(home, { recursive: true, force: true });
  });
});
```

Add `readdir` to the existing `node:fs/promises` import in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-workspaces test`
Expected: FAIL — `createProjectFromGit` not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/plugins/dsh-balbes-workspaces/src/workspaces.ts`:

1. Extend the `WorkspaceProject` interface with `source?: ProjectSource` and add:

```ts
export interface ProjectSource {
  provider: "github";
  url: string;
  branch: string;
  ref: string;
}
/** Structural slice of the balbesGit service (no cross-package import). */
export interface GitSourceLike {
  provider: string;
  url: string;
  [key: string]: unknown;
}
export interface BalbesGitLike {
  inspect(url: string): GitSourceLike;
  clone(source: GitSourceLike, destDir: string, opts?: { timeoutMs?: number }): Promise<{ branch: string; ref: string }>;
}
```

2. Change `RegistryData` rows to `Record<string, { createdAt: string; source?: ProjectSource }>`.

3. In `readRegistry`, replace the row loop with:

```ts
const projects: Record<string, { createdAt: string; source?: ProjectSource }> = {};
for (const [name, meta] of Object.entries(record.projects as Record<string, unknown>)) {
  const m = meta as { createdAt?: unknown; source?: unknown };
  if (typeof m?.createdAt !== "string") continue;
  const row: { createdAt: string; source?: ProjectSource } = { createdAt: m.createdAt };
  const source = parseSource(m.source);
  if (source !== undefined) row.source = source;
  projects[name] = row;
}
```

and add the helper:

```ts
function parseSource(value: unknown): ProjectSource | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const s = value as { provider?: unknown; url?: unknown; branch?: unknown; ref?: unknown };
  if (s.provider !== "github" || typeof s.url !== "string" || typeof s.branch !== "string" || typeof s.ref !== "string") return undefined;
  return { provider: "github", url: s.url, branch: s.branch, ref: s.ref };
}
```

4. Replace `withOptionalCreatedAt` with:

```ts
function toProject(name: string, path: string, row?: { createdAt?: string; source?: ProjectSource }): WorkspaceProject {
  const project: WorkspaceProject = { name, path };
  if (row?.createdAt !== undefined) project.createdAt = row.createdAt;
  if (row?.source !== undefined) project.source = row.source;
  return project;
}
```

Update the three call sites in `listWorkspaces`/`createProject` to `toProject(...)`.

5. Add the orchestration + cleanup:

```ts
export async function createProjectFromGit(
  dshHome: string,
  git: BalbesGitLike,
  url: string,
  name: string
): Promise<WorkspaceProject> {
  if (!validateProjectName(name)) throw workspaceError("invalid-name", `invalid project name: ${name}`);
  const root = projectsRoot(dshHome);
  const target = resolve(root, name);
  if (target !== join(root, name) || !target.startsWith(root + sep)) {
    throw workspaceError("invalid-name", `project name escapes the projects root: ${name}`);
  }
  const source = git.inspect(url); // throws GitError on invalid URL
  try {
    await stat(target);
    throw workspaceError("name-exists", `project already exists: ${name}`);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(root, { recursive: true });
  const temp = join(root, `.balbes-clone-${randomUUID()}`);
  let moved = false;
  try {
    const { branch, ref } = await git.clone(source, temp);
    try {
      await rename(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") throw workspaceError("name-exists", `project already exists: ${name}`);
      throw error;
    }
    moved = true;
    const skillsDir = join(target, ".dsh", "skills");
    await mkdir(skillsDir, { recursive: true });
    await provisionFile(join(skillsDir, "README"), SKILLS_README_STARTER);
    const reg = await readRegistry(dshHome);
    const reconciled = await reconcileRegistry(dshHome, reg);
    const createdAt = new Date().toISOString();
    const projectSource: ProjectSource = { provider: "github", url: source.url, branch, ref };
    reconciled.projects[name] = { createdAt, source: projectSource };
    await writeRegistry(dshHome, reconciled);
    return toProject(name, target, { createdAt, source: projectSource });
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    if (moved) await rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Remove stale hidden clone temp dirs left by a crash mid-clone. */
export async function cleanupStaleCloneDirs(dshHome: string): Promise<void> {
  const root = projectsRoot(dshHome);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && e.name.startsWith(".balbes-clone-"))
      .map((e) => rm(join(root, e.name), { recursive: true, force: true }))
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-workspaces test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-workspaces/src/workspaces.ts packages/plugins/dsh-balbes-workspaces/tests/workspaces.test.ts
git commit -m "feat(workspaces): createProjectFromGit with source registry and cleanup"
```

---

### Task 7: `workspaces.create-from-git` route

**Files:**
- Modify: `packages/plugins/dsh-balbes-workspaces/src/index.ts`
- Test: `packages/plugins/dsh-balbes-workspaces/tests/index.test.ts`

**Interfaces:**
- Consumes: `createProjectFromGit`, `cleanupStaleCloneDirs`, `BalbesGitLike`, `WorkspaceError` from Task 6.
- Produces: route `/api/workspaces/create-from-git`; the plugin now registers seven routes.

- [ ] **Step 1: Update the failing test**

In `packages/plugins/dsh-balbes-workspaces/tests/index.test.ts`:

- Add `"/api/workspaces/create-from-git"` to the sorted route list (now seven).
- Change `boot()` to accept an optional fake git service and register it under `balbesGit`:

```ts
function boot(git?: unknown): void {
  const ctx = {
    get(key: string): unknown {
      if (key === "balbesHttp") return http;
      if (key === "balbesGit") return git;
      return undefined;
    },
    provide(key: string, value: unknown): void {
      provided.set(key, value);
    },
    logger: { warn(_m: string): void {} }
  };
  apply(ctx, { dshHome: home });
}
```

- Add tests:

```ts
it("create-from-git returns 503 when the git plugin is absent", async () => {
  boot();
  const res = await call("/api/workspaces/create-from-git", { url: "https://github.com/acme/api.git", name: "api" });
  expect(res.status).toBe(503);
  expect((res.json as { error?: { code?: string } }).error?.code).toBe("git-unavailable");
});

it("create-from-git maps clone errors onto HTTP codes", async () => {
  const git = {
    inspect: (url: string) => ({ provider: "github", url }),
    clone: async () => {
      const error = Object.assign(new Error("private"), { code: "auth-required" });
      throw error;
    }
  };
  boot(git);
  const res = await call("/api/workspaces/create-from-git", { url: "https://github.com/acme/api.git", name: "api" });
  expect(res.status).toBe(401);
  expect((res.json as { error?: { code?: string } }).error?.code).toBe("auth-required");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-workspaces test`
Expected: FAIL — seven routes expected, route not registered.

- [ ] **Step 3: Write minimal implementation**

In `packages/plugins/dsh-balbes-workspaces/src/index.ts`:

- Extend the import from `./workspaces.js` with `createProjectFromGit`, `cleanupStaleCloneDirs`, type `BalbesGitLike`.
- In `apply`, after the `ensureHome(...)` call add:

```ts
cleanupStaleCloneDirs(dshHome).catch((error: unknown) => {
  ctx.logger.warn(`balbes-workspaces: stale clone cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
});
```

- After the `/api/workspaces/create` handler add:

```ts
http.post("/api/workspaces/create-from-git", "bearer", async (_req, res, body) => {
  const git = ctx.get("balbesGit") as BalbesGitLike | undefined;
  if (git === undefined) {
    send(res, 503, { error: { code: "git-unavailable", message: "git support is not available" } });
    return;
  }
  const b = body as { url?: unknown; name?: unknown };
  const url = typeof b?.url === "string" ? b.url : "";
  const name = typeof b?.name === "string" ? b.name : "";
  try {
    const project = await createProjectFromGit(dshHome, git, url, name);
    send(res, 200, { project });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      const status = error.code === "invalid-name" ? 400 : error.code === "name-exists" ? 409 : 500;
      send(res, status, { error: { code: error.code, message: error.message } });
      return;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      const status =
        code === "invalid-url" ? 400 :
        code === "auth-required" ? 401 :
        code === "clone-timeout" ? 504 :
        code === "clone-failed" ? 502 : 500;
      send(res, status, { error: { code, message: error instanceof Error ? error.message : String(error) } });
      return;
    }
    send(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-workspaces test`
Expected: PASS.

- [ ] **Step 5: Add a REAL fail-closed assertion (workspaces-only profile)**

In `packages/plugins/dsh-balbes-workspaces/tests/integration.test.ts`, inside the existing REAL suite, add:

```ts
// the fixture profile has no git plugin: the route must fail closed
const noGit = await postJson(`${base}/api/workspaces/create-from-git`, { url: "https://github.com/acme/api.git", name: "api" }, token);
expect(noGit.status).toBe(503);
expect((noGit.json as { error?: { code?: string } }).error?.code).toBe("git-unavailable");
```

- [ ] **Step 6: Add the REAL end-to-end create-from-git suite (stub git)**

Create `packages/plugins/dsh-balbes-workspaces/tests/fixtures/balbes-ws-git-profile/package.json` (copy of the workspaces fixture profile manifest, profile name `balbes-ws-git-test`) and `cordis.patch.yml`:

```yaml
- insert:
    - id: balbes-workspaces
      name: 'dsh-balbes-workspaces'
    - id: balbes-git
      name: 'dsh-balbes-git'
```

Create `packages/plugins/dsh-balbes-workspaces/tests/integration.git.test.ts` by copying the harness from `tests/integration.test.ts` (buildPackages, freePort, postJson, waitForHealth, RUN_REAL gate, fixture copy, admin creds, bootServer/stopServer). Change:

- `fixtureProfile` → `fixtures/balbes-ws-git-profile`, profile name → `balbes-ws-git-test`;
- in `beforeAll`, also copy built `dsh-balbes-git/lib` + `package.json` into the test profile `node_modules/dsh-balbes-git` (next to the host and workspaces copies);
- create a fake-git bin dir and prepend it to the server `PATH` in `bootServer`:

```ts
let fakeGitDir: string;
const FAKE_GIT = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const cmd = args.find((a) => a === "clone" || a === "symbolic-ref" || a === "rev-parse");
if (cmd === "clone") {
  const dest = args[args.length - 1];
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "README.md"), "cloned\\n");
  process.exit(0);
}
if (cmd === "symbolic-ref") { console.log("main"); process.exit(0); }
if (cmd === "rev-parse") { console.log("b".repeat(40)); process.exit(0); }
process.exit(1);
`;
// in beforeAll:
fakeGitDir = join(home, "fake-bin");
await mkdir(fakeGitDir, { recursive: true });
await writeFile(join(fakeGitDir, "git"), FAKE_GIT, { mode: 0o755 });
// in bootServer env:
PATH: `${fakeGitDir}:${process.env.PATH}`
```

Add the test:

```ts
it("create-from-git clones, records source and rejects a taken name", async () => {
  if (home === undefined) throw new Error("home not initialized");
  const base = `http://127.0.0.1:${port}`;
  try {
    const token = await bootServer();
    const created = await postJson(`${base}/api/workspaces/create-from-git`, { url: "https://github.com/acme/api.git", name: "api" }, token);
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const project = (created.json as { project?: { name?: string; source?: { branch?: string; ref?: string } } }).project;
    expect(project?.name).toBe("api");
    expect(project?.source?.branch).toBe("main");
    expect(project?.source?.ref).toBe("b".repeat(40));
    expect(existsSync(join(home, "projects", "api", "README.md"))).toBe(true);
    const reg = JSON.parse(await readFile(join(home, "projects.json"), "utf8")) as { projects: Record<string, { source?: { provider?: string } }> };
    expect(reg.projects.api?.source?.provider).toBe("github");

    const dup = await postJson(`${base}/api/workspaces/create-from-git`, { url: "https://github.com/acme/api.git", name: "api" }, token);
    expect(dup.status).toBe(409);
    expect((dup.json as { error?: { code?: string } }).error?.code).toBe("name-exists");
  } finally {
    await stopServer();
  }
}, 240_000);
```

Add `readFile` and `writeFile` to the `node:fs/promises` import of the new file.

- [ ] **Step 7: Run the REAL suites**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-workspaces test`
Expected: PASS (workspaces-only profile → 503; both-plugin profile → clone + registry + 409).

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/dsh-balbes-workspaces/src/index.ts packages/plugins/dsh-balbes-workspaces/tests
git commit -m "feat(workspaces): create-from-git route with HTTP error mapping"
```

---

### Task 8: SPA API client methods

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/api/client.ts`
- Test: `packages/frontend/dsh-balbes-admin/tests/client.test.ts` (append)

**Interfaces:**
- Consumes: contracts from Task 1; existing `request`/`guard`.
- Produces on `AdminApi`: `createWorkspaceFromGit(req)`, `gitStatus()`, `gitSave(token)`, `gitClearToken()`.

- [ ] **Step 1: Write the failing test**

Append to `packages/frontend/dsh-balbes-admin/tests/client.test.ts` following its existing fetch-stub pattern:

```ts
it("calls the git endpoints with POST and the right bodies", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ git: { tokenConfigured: true } }), { status: 200 });
  }));
  const api = createApiClient();
  await api.gitStatus();
  await api.gitSave("ghp_x");
  await api.gitClearToken();
  await api.createWorkspaceFromGit({ url: "https://github.com/acme/api.git", name: "api" });
  expect(calls.map((c) => c.url)).toEqual([
    "/api/git/status",
    "/api/git/save",
    "/api/git/clear-token",
    "/api/workspaces/create-from-git"
  ]);
  expect(calls[1]?.body).toBe(JSON.stringify({ token: "ghp_x" }));
  expect(calls[3]?.body).toBe(JSON.stringify({ url: "https://github.com/acme/api.git", name: "api" }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL — `api.gitStatus` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `packages/frontend/dsh-balbes-admin/src/api/client.ts`:

- Extend the contracts import with `WorkspaceCreateFromGitRequest`, `WorkspaceCreateFromGitResponse`, `GitStatusResponse`, `GitSaveResponse`, `GitClearTokenResponse`.
- Add to `AdminApi`:

```ts
  createWorkspaceFromGit(req: WorkspaceCreateFromGitRequest): Promise<WorkspaceCreateFromGitResponse>;
  gitStatus(): Promise<GitStatusResponse>;
  gitSave(token: string): Promise<GitSaveResponse>;
  gitClearToken(): Promise<GitClearTokenResponse>;
```

- Add to the returned object:

```ts
    createWorkspaceFromGit: (req) =>
      guard(request<WorkspaceCreateFromGitResponse>("/api/workspaces/create-from-git", req satisfies WorkspaceCreateFromGitRequest)),
    gitStatus: () => guard(request<GitStatusResponse>("/api/git/status", {})),
    gitSave: (token) => guard(request<GitSaveResponse>("/api/git/save", { token } satisfies GitSaveRequest)),
    gitClearToken: () => guard(request<GitClearTokenResponse>("/api/git/clear-token", {})),
```

(also add `GitSaveRequest` to the imports.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/api/client.ts packages/frontend/dsh-balbes-admin/tests/client.test.ts
git commit -m "feat(admin): api client methods for git access and git creation"
```

---

### Task 9: SPA «Git-доступ» section and two-mode create modal

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/components/WorkspaceList.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/pages/WorkspacesPage.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/styles.css` (a small block; follow existing classes)
- Test: `packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx` (append), `packages/frontend/dsh-balbes-admin/tests/WorkspaceList.test.tsx` (append)

**Interfaces:**
- Consumes: `AdminApi.createWorkspaceFromGit/gitStatus/gitSave/gitClearToken`, `suggestProjectNameFromGitUrl`.
- Produces: `WorkspaceList` props `gitConfigured`, `onOpenGit`; page states for the git form and token modal.

- [ ] **Step 1: Write the failing tests**

In `WorkspacesPage.test.tsx`, extend `makeApi` with the new methods:

```ts
    gitStatus: vi.fn(async () => ({ git: { tokenConfigured: false } })),
    gitSave: vi.fn(async () => ({ git: { tokenConfigured: true } })),
    gitClearToken: vi.fn(async () => ({ git: { tokenConfigured: false } })),
    createWorkspaceFromGit: vi.fn(async (req) => {
      const project: WorkspaceProject = {
        name: req.name,
        path: `/h/projects/${req.name}`,
        createdAt: NOW,
        source: { provider: "github", url: req.url, branch: "main", ref: "a".repeat(40) }
      };
      projects.push(project);
      return { project };
    }),
```

Then add:

```ts
describe("WorkspacesPage git access", () => {
  it("shows the git section, saves a token and flips the status", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    expect(await screen.findByTestId("ws-git-access")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ws-git-open"));
    fireEvent.change(await screen.findByTestId("git-token-input"), { target: { value: "ghp_x" } });
    fireEvent.click(screen.getByTestId("git-token-save"));
    await waitFor(() => expect(api.gitSave).toHaveBeenCalledWith("ghp_x"));
    await waitFor(() => expect(screen.getByTestId("ws-git-status").textContent).toBe("токен задан"));
  });

  it("creates a project from GitHub and selects it", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("workspace-create-open"));
    fireEvent.click(screen.getByTestId("workspace-create-mode-git"));
    fireEvent.change(screen.getByTestId("workspace-git-url"), { target: { value: "https://github.com/acme/api.git" } });
    await waitFor(() => expect((screen.getByTestId("workspace-name-input") as HTMLInputElement).value).toBe("api"));
    fireEvent.click(screen.getByTestId("workspace-create-submit"));
    await waitFor(() => expect(api.createWorkspaceFromGit).toHaveBeenCalledWith({ url: "https://github.com/acme/api.git", name: "api" }));
    expect(await screen.findByText("api")).toBeTruthy();
  });
});
```

> The suite has no `@testing-library/jest-dom` setup (`vite.config.ts` has `setupFiles: []`), so assert text with `.textContent`, never `toHaveTextContent`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: FAIL — no `ws-git-access` / `workspace-create-mode-git`.

- [ ] **Step 3: Implement `WorkspaceList`**

Add props `gitConfigured: boolean | null` and `onOpenGit(): void`, and render after the project `<ul>` (before the empty state):

```tsx
      <div className="ws-git" data-testid="ws-git-access">
        <div className="ws-git-row">
          <span>Git-доступ</span>
          <span className="ws-git-status" data-testid="ws-git-status">
            {gitConfigured === null ? "…" : gitConfigured ? "токен задан" : "не задан"}
          </span>
        </div>
        <button type="button" className="btn-ghost" data-testid="ws-git-open" onClick={onOpenGit} disabled={busy}>
          {gitConfigured === true ? "Заменить токен" : "Задать токен"}
        </button>
      </div>
```

- [ ] **Step 4: Implement the page**

In `WorkspacesPage.tsx`:

- Import `suggestProjectNameFromGitUrl` from `dsh-balbes-contracts`.
- Add state:

```tsx
  const [gitConfigured, setGitConfigured] = useState<boolean | null>(null);
  const [createMode, setCreateMode] = useState<"empty" | "git">("empty");
  const [gitUrl, setGitUrl] = useState("");
  const [tokenInput, setTokenInput] = useState("");
```

- Extend the modal union with `{ type: "git-token" }`.
- In `load`/`refresh`, after the list loads, call `api.gitStatus()` and `setGitConfigured(res.git.tokenConfigured)`; on failure leave it as-is (do not fail the list).
- Replace `handleCreate` with a branch on `createMode`:

```tsx
  async function handleCreate(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res =
        createMode === "git"
          ? await api.createWorkspaceFromGit({ url: gitUrl.trim(), name: trimmed })
          : await api.createWorkspace(trimmed);
      setName("");
      setGitUrl("");
      setCreateMode("empty");
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

  async function saveGitToken(): Promise<void> {
    if (tokenInput.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.gitSave(tokenInput.trim());
      setGitConfigured(res.git.tokenConfigured);
      setTokenInput("");
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "token save failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearGitToken(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.gitClearToken();
      setGitConfigured(res.git.tokenConfigured);
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "token clear failed");
    } finally {
      setBusy(false);
    }
  }
```

- Pass the new props to `WorkspaceList`:

```tsx
          gitConfigured={gitConfigured}
          onOpenGit={() => setModal({ type: "git-token" })}
```

- Replace the create modal body with a mode toggle plus conditional fields. For the git mode, the URL `onChange` sets `gitUrl` and prefills the name when it is empty or still equals the previous suggestion:

```tsx
      {modal !== null && modal.type === "create" && (
        <Modal title="Создать проект" onClose={() => setModal(null)}>
          <form onSubmit={(event) => { event.preventDefault(); void handleCreate(); }}>
            <div className="ws-mode-toggle">
              <button type="button" className={createMode === "empty" ? "btn" : "btn-ghost"} data-testid="workspace-create-mode-empty" onClick={() => setCreateMode("empty")}>Пустой проект</button>
              <button type="button" className={createMode === "git" ? "btn" : "btn-ghost"} data-testid="workspace-create-mode-git" onClick={() => setCreateMode("git")}>Из GitHub</button>
            </div>
            {createMode === "git" && (
              <input
                data-testid="workspace-git-url"
                className="ws-name-input"
                value={gitUrl}
                onChange={(event) => {
                  const next = event.target.value;
                  setGitUrl(next);
                  const suggested = suggestProjectNameFromGitUrl(next);
                  if (suggested !== null) setName(suggested);
                }}
                placeholder="https://github.com/owner/repo"
                aria-label="URL репозитория GitHub"
              />
            )}
            <input
              data-testid="workspace-name-input"
              className="ws-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="имя проекта (a-z, 0-9, . _ -)"
              aria-label="Имя нового проекта"
              autoFocus={createMode === "empty"}
            />
            {createMode === "git" && (
              <p className="ws-hint">
                {gitConfigured === true ? "Токен задан — приватные репозитории доступны." : "Без токена доступны только публичные репозитории."}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)} data-testid="workspace-create-cancel">Отмена</button>
              <button type="submit" className="btn" disabled={busy || name.trim() === "" || (createMode === "git" && gitUrl.trim() === "")} data-testid="workspace-create-submit">
                {busy ? (createMode === "git" ? "Клонирование…" : "Создаётся…") : (createMode === "git" ? "Клонировать" : "Создать")}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal !== null && modal.type === "git-token" && (
        <Modal title="Git-доступ" onClose={() => setModal(null)}>
          <p className="ws-modal-text">GitHub-токен для приватных репозиториев. Значение не показывается после сохранения.</p>
          <input
            data-testid="git-token-input"
            className="ws-name-input"
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="github_pat_… / ghp_…"
            aria-label="GitHub-токен"
          />
          <div className="modal-actions">
            {gitConfigured === true && (
              <button type="button" className="btn-danger" disabled={busy} onClick={() => void clearGitToken()} data-testid="git-token-clear">Забыть токен</button>
            )}
            <button type="button" className="btn-ghost" onClick={() => setModal(null)} data-testid="git-token-cancel">Отмена</button>
            <button type="button" className="btn" disabled={busy || tokenInput.trim() === ""} onClick={() => void saveGitToken()} data-testid="git-token-save">Сохранить</button>
          </div>
        </Modal>
      )}
```

- [ ] **Step 4b: Add the section CSS**

Append to `packages/frontend/dsh-balbes-admin/src/styles.css` (values follow the existing dev-tool palette; adjust to neighbouring rules):

```css
.ws-git {
  border-top: 1px solid var(--border, #2a2f3a);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ws-git-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.ws-git-status {
  color: var(--muted, #8b93a7);
  font-family: var(--mono, monospace);
}
.ws-mode-toggle {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.ws-hint {
  color: var(--muted, #8b93a7);
  font-size: 12px;
  margin: 6px 0 0;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter dsh-balbes-admin test`
Expected: PASS. Fix the new `WorkspaceList` props in `tests/WorkspaceList.test.tsx` (the existing `makeApi`/`render` call sites) by passing `gitConfigured={false}` and `onOpenGit={() => {}}`.

- [ ] **Step 6: Typecheck and build the SPA**

Run: `pnpm --filter dsh-balbes-admin typecheck && pnpm --filter dsh-balbes-admin build`
Expected: PASS; `dist/` regenerated.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/dsh-balbes-admin
git commit -m "feat(admin): git access section and create-from-GitHub modal"
```

---

### Task 10: Profile composition, installer, CI, runbook, final verification

**Files:**
- Modify: `profiles/balbes/cordis.patch.yml`
- Modify: `scripts/install.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/runbooks/stage2-vps.md`

**Interfaces:**
- Consumes: built `dsh-balbes-git` package from Tasks 1–9.
- Produces: the plugin is composed into `balbes`, copied on install/CI, and documented.

- [ ] **Step 1: Compose the plugin into the profile**

In `profiles/balbes/cordis.patch.yml`, add beside `balbes-workspaces`:

```yaml
    - id: balbes-git
      name: 'dsh-balbes-git'
```

- [ ] **Step 2: Installer copy function**

In `scripts/install.sh`, add after `copy_workspaces_into_profile`:

```bash
# copy_git_into_profile — собранный git-плагин реальным каталогом в node_modules
# профиля (тот же рецепт, что и workspaces).
copy_git_into_profile() {
    local profile_dir="$DSH_HOME/profiles/$PROFILE_NAME"
    local src="$REPO_DIR/packages/plugins/dsh-balbes-git"
    local dst="$profile_dir/node_modules/dsh-balbes-git"
    if [[ ! -d "$src/lib" ]]; then
        die "git plugin not built at $src/lib — build step failed"
    fi
    mkdir -p "$profile_dir/node_modules"
    rm -rf "$dst"
    cp -R "$src" "$dst"
    rm -f "$dst/tsconfig.json" "$dst/tsconfig.build.json"
    rm -rf "$dst/tests" "$dst/src" "$dst/lib/types"
    chmod -R u+rwX,go-w "$dst"
    info "Git plugin copied into $dst"
}
```

and add `copy_git_into_profile` to the call block (after `copy_workspaces_into_profile`, line ~784). Also update the header comment (lines 15–18) to list `dsh-balbes-git`.

- [ ] **Step 3: CI copy + REAL job**

In `.github/workflows/ci.yml`, in the profile-sync step add (mirroring the sessions block, lines ~73–78):

```yaml
          cp -R packages/plugins/dsh-balbes-git "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-git"
          rm -f "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-git/tsconfig.json" \
                "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-git/tsconfig.build.json"
          rm -rf "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-git/tests" \
                 "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-git/src" \
                 "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-git/lib/types"
```

In the `real` job, after the workspace-sessions step, add:

```yaml
      - name: REAL suites — git plugin (/api/git + clone flow)
        working-directory: packages/plugins/dsh-balbes-git
        env:
          RUN_REAL: "1"
        run: bash node_modules/.bin/vitest run tests/integration.test.ts
```

- [ ] **Step 4: Runbook**

In `docs/runbooks/stage2-vps.md`: add `dsh-balbes-git` to every plugin enumeration (lines ~17, ~119–120, ~1351), and add a smoke subsection after the workspaces smoke (~line 520):

```markdown
### Git-доступ (создание проекта из GitHub)

Владелец задаёт GitHub-токен в секции «Git-доступ» страницы «Проекты» (для
публичных репозиториев токен не нужен). Проверка через API:

```bash
TOKEN=<JWT из входа>
curl -s -X POST http://127.0.0.1:8080/api/git/status -H "authorization: Bearer $TOKEN" -d '{}'
# => {"git":{"tokenConfigured":false}}
curl -s -X POST http://127.0.0.1:8080/api/git/save -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"token":"ghp_xxx"}'
# => {"git":{"tokenConfigured":true}}  (значение токена не возвращается)
```

Создание проекта из публичного репозитория:

```bash
curl -s -X POST http://127.0.0.1:8080/api/workspaces/create-from-git \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://github.com/owner/repo.git","name":"repo"}'
# => {"project":{...,"source":{"provider":"github","url":...,"branch":...,"ref":...}}}
```

Ожидаемо: каталог `$DSH_HOME/projects/repo/` содержит рабочую копию,
`projects.json` — строку с `source`; занятое имя → 409, приватный репозиторий
без токена → 401 `auth-required`, недоступный GitHub → 502/504.
Полный REAL-smoke: `RUN_REAL=1 pnpm --filter dsh-balbes-git test` (нужен
`dsh` и `git` на PATH).
```
```

- [ ] **Step 5: Full verification**

Run, in order, and paste the results into the handoff:

```bash
pnpm install --frozen-lockfile=false
pnpm -r --if-present run build
pnpm -r --if-present run typecheck
pnpm -r --if-present run test
pnpm --filter dsh-balbes-admin build
bash -n scripts/install.sh
dsh --profile balbes --dump-config | grep -q balbes-git
```

Expected: all green; `balbes-git` appears in the composed profile.

- [ ] **Step 6: Commit**

```bash
git add profiles scripts .github docs/runbooks pnpm-lock.yaml
git commit -m "feat(install): compose and ship dsh-balbes-git; document git access"
```

---

## Post-implementation

- Mark p7 absorbed and sync `future_plans/INDEX.md` with the **canon-future-plan** skill (do not edit `future_plans/**` directly).
- Close with the **canon-audit** skill on the git/workspace topic.
- Do not push to `origin/main` without the owner's go-ahead; hand over the server verification steps from `docs/runbooks/stage2-vps.md` (re-run `scripts/install.sh`, then the `/api/git/*` and `create-from-git` smoke).
