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
