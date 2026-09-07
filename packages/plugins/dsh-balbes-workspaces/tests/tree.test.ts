import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDir, projectsRoot } from "../src/workspaces.js";
import { isValidRelPath, readWorkspaceDir, relDirOf, type WorkspaceScope } from "../src/tree.js";

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
    await expect(readWorkspaceDir(home, "bogus" as WorkspaceScope, undefined, "")).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("reads the agent home root", async () => {
    const home = await tempHome();
    await writeFile(join(homeDir(home), "self.md"), "# agent");
    const entries = await readWorkspaceDir(home, "home", undefined, "");
    expect(entries).toEqual([{ name: "self.md", kind: "file" }]);
  });
});
