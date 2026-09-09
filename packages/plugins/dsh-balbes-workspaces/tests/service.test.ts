import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspacesService, type BalbesWorkspacesService } from "../src/service.js";
import { createProject, ensureHome, homeDir, projectsRoot } from "../src/workspaces.js";

let home: string;
let service: BalbesWorkspacesService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ws-svc-"));
  await ensureHome(home);
  service = createWorkspacesService(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("balbesWorkspaces service", () => {
  it("list() returns the agent home plus created projects", async () => {
    await createProject(home, "alpha");
    await createProject(home, "beta");
    const res = await service.list();
    expect(res.home.path).toBe(homeDir(home));
    expect(res.projects.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(res.projects[0]?.path).toBe(join(projectsRoot(home), "alpha"));
    expect(res.projects[0]?.createdAt).toBeTruthy();
  });

  it("root() resolves the home and project roots like the domain workspaceBase", async () => {
    await createProject(home, "alpha");
    await expect(service.root("home", undefined)).resolves.toBe(homeDir(home));
    await expect(service.root("project", "alpha")).resolves.toBe(join(projectsRoot(home), "alpha"));
    // invalid names still surface the domain error codes
    await expect(service.root("project", "a/b")).rejects.toMatchObject({ code: "invalid-name" });
  });

  it("readDir() proxies into the domain directory listing", async () => {
    await createProject(home, "alpha");
    await mkdir(join(projectsRoot(home), "alpha", "src"), { recursive: true });
    await writeFile(join(projectsRoot(home), "alpha", "src", "main.ts"), "x", "utf8");
    const entries = await service.readDir("project", "alpha", "src");
    expect(entries).toEqual([{ name: "main.ts", kind: "file" }]);
    // containment violations keep their codes through the facade
    await expect(service.readDir("project", "alpha", "../..")).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("readFile() proxies into the domain file reader (text end-to-end)", async () => {
    await createProject(home, "alpha");
    await writeFile(join(projectsRoot(home), "alpha", "notes.txt"), "hello world", "utf8");
    await expect(service.readFile("project", "alpha", "notes.txt")).resolves.toEqual({
      kind: "text",
      content: "hello world",
      truncated: false
    });
    await expect(service.readFile("project", "alpha", "nope.txt")).rejects.toMatchObject({ code: "not-found" });
    // home scope reads the agent home directory
    await writeFile(join(homeDir(home), "self.md"), "# about", "utf8");
    await expect(service.readFile("home", undefined, "self.md")).resolves.toMatchObject({
      kind: "text",
      content: "# about"
    });
  });
});
