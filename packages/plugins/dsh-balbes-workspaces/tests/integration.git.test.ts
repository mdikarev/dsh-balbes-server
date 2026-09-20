import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const gitPkgRoot = join(pkgRoot, "..", "dsh-balbes-git");
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const fixtureProfile = join(here, "fixtures", "balbes-ws-git-profile");

const FAKE_GIT = "#!/usr/bin/env node\n" +
  'const { mkdirSync, writeFileSync } = require("node:fs");\n' +
  'const { join } = require("node:path");\n' +
  "const args = process.argv.slice(2);\n" +
  'const cmd = args.find((a) => a === "clone" || a === "symbolic-ref" || a === "rev-parse");\n' +
  'if (cmd === "clone") {\n' +
  "  const dest = args[args.length - 1];\n" +
  "  mkdirSync(dest, { recursive: true });\n" +
  '  writeFileSync(join(dest, "README.md"), "cloned\\n");\n' +
  "  process.exit(0);\n" +
  "}\n" +
  'if (cmd === "symbolic-ref") { console.log("main"); process.exit(0); }\n' +
  'if (cmd === "rev-parse") { console.log("b".repeat(40)); process.exit(0); }\n' +
  "process.exit(1);\n";

async function hasDsh(): Promise<boolean> {
  try {
    await execFileP("dsh", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function buildPackages(): Promise<void> {
  const configs: Array<[string, string]> = [
    [pkgRoot, "tsconfig.build.json"],
    [gitPkgRoot, "tsconfig.build.json"],
    [hostPkgRoot, "tsconfig.json"]
  ];
  for (const [root, cfg] of configs) {
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    await execFileP(process.execPath, [tsc, "-p", join(root, cfg)], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  }
}

async function postJson(url: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function waitForHealth(port: number, child: ReturnType<typeof spawn>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh exited early (code ${child.exitCode}) before serving health`);
    try {
      const { status, json } = await postJson(`http://127.0.0.1:${port}/api/health`, {});
      if (status === 200 && (json as { ok?: boolean }).ok === true) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

const runReal = (process.env.RUN_REAL ?? "").trim() !== "";
const realEnabled = runReal ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (create-from-git end to end)", () => {
  let home: string | undefined;
  let fakeGitDir = "";
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    await buildPackages();
    port = await freePort();
    home = await mkdtemp(join(tmpdir(), "balbes-ws-git-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, "balbes-ws-git-test"), { recursive: true });
    const nm = join(profiles, "balbes-ws-git-test", "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    await cp(join(pkgRoot, "lib"), join(nm, "dsh-balbes-workspaces", "lib"), { recursive: true });
    await cp(join(pkgRoot, "package.json"), join(nm, "dsh-balbes-workspaces", "package.json"));
    await cp(join(gitPkgRoot, "lib"), join(nm, "dsh-balbes-git", "lib"), { recursive: true });
    await cp(join(gitPkgRoot, "package.json"), join(nm, "dsh-balbes-git", "package.json"));
    fakeGitDir = join(home, "fake-bin");
    await mkdir(fakeGitDir, { recursive: true });
    await writeFile(join(fakeGitDir, "git"), FAKE_GIT, { mode: 0o755 });
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(home, creds);
  }, 300_000);

  afterAll(async () => {
    if (child !== null && child.exitCode === null) child.kill("SIGKILL");
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  }, 60_000);

  async function bootServer(): Promise<string> {
    if (home === undefined) throw new Error("home not initialized");
    const env = {
      ...process.env,
      DSH_HOME: home,
      BALBES_PORT: String(port),
      DSH_TELEMETRY_DISABLED: "1",
      PATH: `${fakeGitDir}:${process.env.PATH ?? ""}`
    };
    child = spawn("dsh", ["--profile", "balbes-ws-git-test"], { env, cwd: home, stdio: "ignore" });
    await waitForHealth(port, child);
    const loginRes = await postJson(`http://127.0.0.1:${port}/api/auth/login`, { login, password });
    expect(loginRes.status, JSON.stringify(loginRes.json)).toBe(200);
    return (loginRes.json as { token: string }).token;
  }

  async function stopServer(): Promise<void> {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child?.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      ]);
    }
    child = null;
  }

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
  }, 300_000);
});
