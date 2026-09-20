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
