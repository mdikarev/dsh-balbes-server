import { describe, expect, it } from "vitest";
import { cloneArgs, parseGitHubUrl, redact, GitError } from "../src/git.js";

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

describe("cloneArgs", () => {
  it("never puts the token value in argv", () => {
    const source = parseGitHubUrl("https://github.com/acme/api.git");
    const withToken = cloneArgs(source, true);
    const without = cloneArgs(source, false);
    expect(withToken.join(" ")).not.toContain("secret-value");
    expect(withToken.some((a) => a.includes("BALBES_GIT_TOKEN"))).toBe(true);
    expect(without.some((a) => a.includes("credential.helper"))).toBe(true);
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
