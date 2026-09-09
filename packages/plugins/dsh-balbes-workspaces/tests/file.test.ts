import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceFile } from "../src/file.js";
import { createProject, ensureHome, homeDir } from "../src/workspaces.js";

let home: string;
let p1: string;
let outside: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ws-file-"));
  await ensureHome(home);
  p1 = (await createProject(home, "p1")).path;
  outside = undefined;
});

afterEach(async () => {
  if (outside !== undefined) await rm(outside, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("readWorkspaceFile", () => {
  it("reads a text file at the project root (project scope)", async () => {
    await writeFile(join(p1, "notes.txt"), "hello world", "utf8");
    await expect(readWorkspaceFile(home, "project", "p1", "notes.txt")).resolves.toEqual({
      kind: "text",
      content: "hello world",
      truncated: false
    });
  });

  it("reads a nested text file", async () => {
    await mkdir(join(p1, "src", "a"), { recursive: true });
    await writeFile(join(p1, "src", "a", "b.txt"), "nested", "utf8");
    await expect(readWorkspaceFile(home, "project", "p1", "src/a/b.txt")).resolves.toEqual({
      kind: "text",
      content: "nested",
      truncated: false
    });
  });

  it("reports missing files with not-found", async () => {
    await expect(readWorkspaceFile(home, "project", "p1", "nope.txt")).rejects.toMatchObject({
      code: "not-found"
    });
  });

  it("rejects traversal, absolute and backslash paths with invalid-path", async () => {
    for (const bad of ["../x.txt", "/etc/hostname", "..\\x", "a/../b"]) {
      await expect(readWorkspaceFile(home, "project", "p1", bad), `relPath=${bad}`).rejects.toMatchObject({
        code: "invalid-path"
      });
    }
  });

  it("rejects a lexical escape towards a sibling project with invalid-path", async () => {
    await createProject(home, "p2");
    await expect(readWorkspaceFile(home, "project", "p1", "../p2/x.txt")).rejects.toMatchObject({
      code: "invalid-path"
    });
  });

  it("refuses a file reached through a symlink directory pointing at a sibling project", async () => {
    const p2 = (await createProject(home, "p2")).path;
    await writeFile(join(p2, "x.txt"), "secret", "utf8");
    await symlink(p2, join(p1, "p2link"));
    await expect(readWorkspaceFile(home, "project", "p1", "p2link/x.txt")).rejects.toMatchObject({
      code: "not-found",
      message: expect.stringContaining("outside")
    });
  });

  it("refuses a file reached through a symlink directory pointing outside the home", async () => {
    outside = await mkdtemp(join(tmpdir(), "ws-file-outside-"));
    await writeFile(join(outside, "x.txt"), "secret", "utf8");
    await symlink(outside, join(p1, "out"));
    await expect(readWorkspaceFile(home, "project", "p1", "out/x.txt")).rejects.toMatchObject({
      code: "not-found",
      message: expect.stringContaining("outside")
    });
  });

  it("reports a final-component symlink as link without reading its target", async () => {
    await symlink("/etc/hostname", join(p1, "evil.txt"));
    await expect(readWorkspaceFile(home, "project", "p1", "evil.txt")).resolves.toEqual({ kind: "link" });
  });

  it("sniffs NUL bytes and reports binary files without decoding them", async () => {
    await writeFile(join(p1, "bin.dat"), Buffer.from([0x00, 0x01]));
    await expect(readWorkspaceFile(home, "project", "p1", "bin.dat")).resolves.toEqual({
      kind: "binary",
      size: 2
    });
  });

  it("truncates oversized text reads to maxBytes and flags truncated", async () => {
    await writeFile(join(p1, "big.txt"), "a".repeat(300), "utf8");
    const res = await readWorkspaceFile(home, "project", "p1", "big.txt", { maxBytes: 100 });
    expect(res).toMatchObject({ kind: "text", truncated: true });
    if (res.kind === "text") expect(res.content).toHaveLength(100);
  });

  it("reads the agent home root with scope home", async () => {
    await writeFile(join(homeDir(home), "notes.txt"), "hello world", "utf8");
    await expect(readWorkspaceFile(home, "home", undefined, "notes.txt")).resolves.toEqual({
      kind: "text",
      content: "hello world",
      truncated: false
    });
  });

  it("fails with not-found when the referenced project does not exist", async () => {
    await expect(readWorkspaceFile(home, "project", "ghost", "x.txt")).rejects.toMatchObject({
      code: "not-found"
    });
  });
});
