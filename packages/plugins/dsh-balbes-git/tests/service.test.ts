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
