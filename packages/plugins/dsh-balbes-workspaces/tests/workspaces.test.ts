import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir, stat, readFile } from "node:fs/promises";
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
  WorkspaceError,
  RegistryData
} from "../src/workspaces.js";

let home: string;

// Exact text the pre-Task-2 ensureHome wrote to `skills/README.md`. The
// migration must recognise this byte-for-byte; anything else is an owner edit.
const OLD_SKILLS_README_CONTENT = [
  "# skills/",
  "",
  "Directory for agent skills (later stages). Format and wiring to be defined.",
  ""
].join("\n");

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
    for (const bad of ["", ".", "..", ".alpha", "alpha.", "a..b", "a/b", "a b", "-x", "x-", "_x", "«альфа»", "a".repeat(65)]) {
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

  it("provisions starter files into a fresh home", async () => {
    await ensureHome(home);
    const agents = await readFile(join(homeDir(home), "AGENTS.md"), "utf8");
    expect(agents).toContain("# Agent home rules");
    const self = await readFile(join(homeDir(home), "self.md"), "utf8");
    expect(self).toContain("# About");
    const skillsReadme = await readFile(join(homeDir(home), "skills", "README"), "utf8");
    expect(skillsReadme).toContain("# skills/");
    // the starter documents the skill shapes, frontmatter, and layers
    expect(skillsReadme).toContain("<name>/SKILL.md");
    expect(skillsReadme).toContain("<name>.md");
    expect(skillsReadme).toContain("frontmatter");
    expect(skillsReadme).toContain("$DSH_HOME/agent/skills");
    expect(skillsReadme).toContain("<project>/.dsh/skills");
    // no .md file: the skill provider must not parse the starter as a skill
    await expect(stat(join(homeDir(home), "skills", "README.md"))).rejects.toThrow();
    const entries = await readdir(homeDir(home));
    expect(entries).toEqual(expect.arrayContaining(["AGENTS.md", "self.md", "skills"]));
  });

  it("never overwrites owner edits to starter files", async () => {
    await ensureHome(home);
    const agents = join(homeDir(home), "AGENTS.md");
    await writeFile(agents, "# custom rules by the owner\n", "utf8");
    // later runs (boot, every list) must leave the owner's content alone
    await ensureHome(home);
    await ensureHome(home);
    expect(await readFile(agents, "utf8")).toBe("# custom rules by the owner\n");
  });
});

describe("skills README migration", () => {
  it("removes skills/README.md only when it is byte-equal to the old starter", async () => {
    const skillsDir = join(homeDir(home), "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, "README.md"), OLD_SKILLS_README_CONTENT, "utf8");

    await ensureHome(home);
    await ensureHome(home);

    await expect(stat(join(skillsDir, "README.md"))).rejects.toThrow();
    const current = await readFile(join(skillsDir, "README"), "utf8");
    expect(current).toContain("<name>/SKILL.md");
  });

  it("leaves an owner-edited skills/README.md untouched", async () => {
    const skillsDir = join(homeDir(home), "skills");
    await mkdir(skillsDir, { recursive: true });
    const edited = "# my own skills notes\n";
    await writeFile(join(skillsDir, "README.md"), edited, "utf8");

    await ensureHome(home);

    expect(await readFile(join(skillsDir, "README.md"), "utf8")).toBe(edited);
    // the canonical README (without .md) is still provisioned alongside
    await expect(stat(join(skillsDir, "README"))).resolves.toBeTruthy();
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
    // atomic: no tmp leftovers in the registry file's parent directory
    const entries = await readdir(home);
    expect(entries.filter((name) => /\.tmp\./.test(name))).toEqual([]);
  });

  it("writeRegistry stores the registry file with mode 0o600", async () => {
    await writeRegistry(home, { version: 1, projects: { alpha: { createdAt: "2026-09-06T00:00:00.000Z" } } });
    const st = await stat(registryFile(home));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("two interleaved writes commit on distinct tmp files (no ENOENT, no tmp leftovers)", async () => {
    const withAlpha: RegistryData = { version: 1, projects: { alpha: { createdAt: "2026-09-06T00:00:00.000Z" } } };
    const withBeta: RegistryData = { version: 1, projects: { beta: { createdAt: "2026-09-06T00:01:00.000Z" } } };
    // Each call is a whole-snapshot commit (create/delete/list-prune all write
    // full snapshots). With a pid-only tmp name the two chains share one tmp
    // path: whichever renames first moves it away and the other chain dies with
    // ENOENT. A unique tmp per write keeps both chains atomic — both must land.
    await expect(Promise.all([writeRegistry(home, withAlpha), writeRegistry(home, withBeta)])).resolves.toEqual([undefined, undefined]);
    // Atomic whole-file replace is last-write-wins: the file ends as one
    // complete committed snapshot (never a torn mix), and no tmp survives.
    const reg = await readRegistry(home);
    expect(reg.version).toBe(1);
    const rows = Object.keys(reg.projects);
    expect(rows).toHaveLength(1);
    expect(["alpha", "beta"]).toContain(rows[0]);
    const leftovers = (await readdir(home)).filter((name) => /\.tmp\./.test(name));
    expect(leftovers).toEqual([]);
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

  it("provisions the project skills dir with the shared starter", async () => {
    const created = await createProject(home, "alpha");
    const readme = await readFile(join(created.path, ".dsh", "skills", "README"), "utf8");
    expect(readme).toContain("# skills/");
    expect(readme).toContain("<name>/SKILL.md");
    expect(readme).toContain("<name>.md");
    expect(readme).toContain("frontmatter");
    expect(readme).toContain("$DSH_HOME/agent/skills");
    expect(readme).toContain("<project>/.dsh/skills");
    // the starter must not be a parseable skill file
    await expect(stat(join(created.path, ".dsh", "skills", "README.md"))).rejects.toThrow();
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
