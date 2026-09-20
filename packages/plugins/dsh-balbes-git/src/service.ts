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
