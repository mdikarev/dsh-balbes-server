import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const fixtureProfile = join(here, "fixtures", "balbes-git-profile");

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

describe.skipIf(!realEnabled)("REAL composition (git API)", () => {
  let home: string | undefined;
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    await buildPackages();
    port = await freePort();
    home = await mkdtemp(join(tmpdir(), "balbes-git-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, "balbes-git-test"), { recursive: true });
    const nm = join(profiles, "balbes-git-test", "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    await cp(join(pkgRoot, "lib"), join(nm, "dsh-balbes-git", "lib"), { recursive: true });
    await cp(join(pkgRoot, "package.json"), join(nm, "dsh-balbes-git", "package.json"));
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
    const env = { ...process.env, DSH_HOME: home, BALBES_PORT: String(port), DSH_TELEMETRY_DISABLED: "1" };
    child = spawn("dsh", ["--profile", "balbes-git-test"], { env, cwd: home, stdio: "ignore" });
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

  it("git API: status/save/clear-token persists the token and never echoes it", async () => {
    if (home === undefined) throw new Error("home not initialized");
    const base = `http://127.0.0.1:${port}`;
    try {
      const token = await bootServer();
      const anon = await postJson(`${base}/api/git/status`, {});
      expect(anon.status).toBe(401);

      expect((await postJson(`${base}/api/git/status`, {}, token)).json).toEqual({ git: { tokenConfigured: false } });
      const saved = await postJson(`${base}/api/git/save`, { token: "ghp_integration" }, token);
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      expect(JSON.stringify(saved.json)).not.toContain("ghp_integration");
      expect(await readFile(join(home, ".credentials.yaml"), "utf8")).toContain("BALBES_GITHUB_TOKEN");

      const cleared = await postJson(`${base}/api/git/clear-token`, {}, token);
      expect(cleared.json).toEqual({ git: { tokenConfigured: false } });
      expect(existsSync(join(home, "projects"))).toBe(false);
    } finally {
      await stopServer();
    }
  }, 240_000);
});
