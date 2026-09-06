import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url)); // tests/ dir
const pkgRoot = join(here, ".."); // dsh-balbes-workspaces package root
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const fixtureProfile = join(here, "fixtures", "balbes-workspaces-profile");

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

/** Compile src -> lib for both our plugin and the host bundle (tsc straight from the store). */
async function buildPackages(): Promise<void> {
  // host has a single tsconfig.json (build = tsc -p tsconfig.json); the plugin
  // uses tsconfig.build.json so its tsconfig.json can typecheck src + tests.
  const configs: Array<[string, string]> = [
    [pkgRoot, "tsconfig.build.json"],
    [hostPkgRoot, "tsconfig.json"]
  ];
  for (const [root, cfg] of configs) {
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    await execFileP(process.execPath, [tsc, "-p", join(root, cfg)], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024
    });
  }
}

async function postJson(url: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
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
    if (child.exitCode !== null) {
      throw new Error(`dsh exited early (code ${child.exitCode}) before serving health`);
    }
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

describe.skipIf(!realEnabled)("REAL composition (workspaces API)", () => {
  let home: string | undefined;
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    await buildPackages();
    port = await freePort();
    home = await mkdtemp(join(tmpdir(), "balbes-ws-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, "balbes-ws-test"), { recursive: true });
    const nm = join(profiles, "balbes-ws-test", "node_modules");
    await mkdir(nm, { recursive: true });
    // copy built host bundle
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    // copy built plugin
    await cp(join(pkgRoot, "lib"), join(nm, "dsh-balbes-workspaces", "lib"), { recursive: true });
    await cp(join(pkgRoot, "package.json"), join(nm, "dsh-balbes-workspaces", "package.json"));
    // credentials
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(home, creds);
  }, 240_000);

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
      DSH_TELEMETRY_DISABLED: "1"
    };
    child = spawn("dsh", ["--profile", "balbes-ws-test"], { env, cwd: home, stdio: "ignore" });
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

  it("dump-config composes balbes-workspaces", async () => {
    if (home === undefined) throw new Error("home not initialized");
    const { stdout } = await execFileP("dsh", ["--profile", "balbes-ws-test", "--dump-config"], {
      env: { ...process.env, DSH_HOME: home },
      maxBuffer: 16 * 1024 * 1024
    });
    expect(stdout).toContain("balbes-workspaces");
  }, 120_000);

  it("workspaces API: auth, list/create/delete, error codes and disk effects", async () => {
    if (home === undefined) throw new Error("home not initialized");
    const base = `http://127.0.0.1:${port}`;
    try {
      const token = await bootServer();

      // 401 without a token on every workspaces route
      const anon = await postJson(`${base}/api/workspaces/list`, {});
      expect(anon.status).toBe(401);
      const anonCreate = await postJson(`${base}/api/workspaces/create`, { name: "alpha" });
      expect(anonCreate.status).toBe(401);
      const anonDelete = await postJson(`${base}/api/workspaces/delete`, { name: "alpha" });
      expect(anonDelete.status).toBe(401);

      // list on a fresh home: home + empty projects, and $DSH_HOME/agent exists
      const empty = await postJson(`${base}/api/workspaces/list`, {}, token);
      expect(empty.status, JSON.stringify(empty.json)).toBe(200);
      const emptyBody = empty.json as { home?: { path?: string }; projects?: unknown[] };
      expect(emptyBody.home?.path).toBe(join(home, "agent"));
      expect(emptyBody.projects).toEqual([]);
      expect(existsSync(join(home, "agent"))).toBe(true);

      // create
      const created = await postJson(`${base}/api/workspaces/create`, { name: "alpha" }, token);
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      expect((created.json as { project?: { name?: string; path?: string } }).project?.name).toBe("alpha");
      expect(existsSync(join(home, "projects", "alpha"))).toBe(true);

      // duplicate create -> 409 name-exists
      const dup = await postJson(`${base}/api/workspaces/create`, { name: "alpha" }, token);
      expect(dup.status).toBe(409);
      expect((dup.json as { error?: { code?: string } }).error?.code).toBe("name-exists");

      // invalid name -> 400 invalid-name
      const bad = await postJson(`${base}/api/workspaces/create`, { name: "a/b" }, token);
      expect(bad.status).toBe(400);
      expect((bad.json as { error?: { code?: string } }).error?.code).toBe("invalid-name");

      // list now contains alpha with createdAt
      const afterCreate = await postJson(`${base}/api/workspaces/list`, {}, token);
      const projects = (afterCreate.json as { projects?: Array<{ name?: string; createdAt?: string }> }).projects ?? [];
      expect(projects.map((p) => p.name)).toEqual(["alpha"]);
      expect(projects[0]?.createdAt).toBeTruthy();

      // delete
      const deleted = await postJson(`${base}/api/workspaces/delete`, { name: "alpha" }, token);
      expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
      expect(existsSync(join(home, "projects", "alpha"))).toBe(false);

      // delete of a missing project -> 404 not-found
      const missing = await postJson(`${base}/api/workspaces/delete`, { name: "alpha" }, token);
      expect(missing.status).toBe(404);
      expect((missing.json as { error?: { code?: string } }).error?.code).toBe("not-found");

      // traversal names are refused
      const traversal = await postJson(`${base}/api/workspaces/delete`, { name: ".." }, token);
      expect(traversal.status).toBe(400);
    } finally {
      await stopServer();
    }
  }, 240_000);
});
