import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url)); // tests/ dir
const pkgRoot = join(here, ".."); // dsh-balbes-models package root
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const fixtureProfile = join(here, "fixtures", "balbes-models-profile");

interface ModelConnection {
  routeId: string;
  kind: "deepseek" | "custom";
  displayName: string;
  baseURL?: string;
  hasKey: boolean;
  models: string[];
  isDefault: boolean;
}
interface ModelsListBody {
  connections: ModelConnection[];
  default: { provider: string; model: string };
}

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

/** Read a file that may legitimately be absent (e.g. credentials after unset of the last ref). */
async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

const runReal = (process.env.RUN_REAL ?? "").trim() !== "";
const realEnabled = runReal ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (models API)", () => {
  let home: string | undefined;
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    await buildPackages();
    port = await freePort();
    home = await mkdtemp(join(tmpdir(), "balbes-models-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, "balbes-models-test"), { recursive: true });
    const nm = join(profiles, "balbes-models-test", "node_modules");
    await mkdir(nm, { recursive: true });
    // copy built host bundle
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    // copy built plugin
    await cp(join(pkgRoot, "lib"), join(nm, "dsh-balbes-models", "lib"), { recursive: true });
    await cp(join(pkgRoot, "package.json"), join(nm, "dsh-balbes-models", "package.json"));
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
    child = spawn("dsh", ["--profile", "balbes-models-test"], { env, cwd: home, stdio: "ignore" });
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

  it("models API: auth, custom route save + key ref, engine state on disk, key clear, default, delete error codes", async () => {
    if (home === undefined) throw new Error("home not initialized");
    const base = `http://127.0.0.1:${port}`;
    try {
      const token = await bootServer();

      // 401 without a token on every models route
      expect((await postJson(`${base}/api/models/list`, {})).status).toBe(401);
      expect((await postJson(`${base}/api/models/save`, { kind: "custom", displayName: "X" })).status).toBe(401);
      expect((await postJson(`${base}/api/models/delete`, { routeId: "x" })).status).toBe(401);
      expect((await postJson(`${base}/api/models/default`, { provider: "deepseek-official", model: "deepseek-v4-flash" })).status).toBe(401);

      // fresh home: pinned deepseek route is the default, no key stored
      const empty = await postJson(`${base}/api/models/list`, {}, token);
      expect(empty.status, JSON.stringify(empty.json)).toBe(200);
      const body = empty.json as ModelsListBody;
      expect(body.default).toEqual({ provider: "deepseek-official", model: "deepseek-v4-flash" });
      const ds = body.connections.find((c) => c.routeId === "deepseek-official");
      expect(ds?.kind).toBe("deepseek");
      expect(ds?.hasKey).toBe(false);
      expect(ds?.models).toContain("deepseek-v4-flash");
      expect(ds?.isDefault).toBe(true);

      // save a keyed custom route: engine must accept the route config shape
      const saved = await postJson(`${base}/api/models/save`, {
        kind: "custom", displayName: "My Gateway", baseURL: "https://gw.example/v1", key: "sk-abc", models: ["m-1", "m-2"]
      }, token);
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);

      // disk: route in $DSH_HOME/settings.yaml (llm-pi-ai) and the key ref value in .credentials.yaml
      const settingsYaml = await readFile(join(home, "settings.yaml"), "utf8");
      expect(settingsYaml).toContain("my-gateway");
      expect(settingsYaml).toContain("apiKeyEnv: BALBES_MY_GATEWAY_API_KEY");
      const credsYaml = await readFile(join(home, ".credentials.yaml"), "utf8");
      expect(credsYaml).toContain("BALBES_MY_GATEWAY_API_KEY: sk-abc");

      // list reflects the new connection
      const listed = await postJson(`${base}/api/models/list`, {}, token);
      const gw = (listed.json as ModelsListBody).connections.find((c) => c.routeId === "my-gateway");
      expect(gw?.hasKey).toBe(true);
      expect(gw?.models).toEqual(["m-1", "m-2"]);

      // save with an explicit routeId on a NONEXISTENT route creates it (edit-branch upsert)
      const upsert = await postJson(`${base}/api/models/save`, {
        routeId: "edit-created", kind: "custom", displayName: "Edit Created", baseURL: "https://edit.example/v1",
        key: "sk-abc", models: ["e-1"]
      }, token);
      expect(upsert.status, JSON.stringify(upsert.json)).toBe(200);
      const afterUpsert = (await postJson(`${base}/api/models/list`, {}, token)).json as ModelsListBody;
      expect(afterUpsert.connections.some((c) => c.routeId === "edit-created")).toBe(true);

      // key: null on a custom save UNSETS the ref; the route config stays
      const cleared = await postJson(`${base}/api/models/save`, {
        routeId: "my-gateway", kind: "custom", displayName: "My Gateway", baseURL: "https://gw.example/v1",
        key: null, models: ["m-1", "m-2"]
      }, token);
      expect(cleared.status, JSON.stringify(cleared.json)).toBe(200);
      const credsAfterClear = await readIfPresent(join(home, ".credentials.yaml"));
      expect(credsAfterClear).not.toContain("BALBES_MY_GATEWAY_API_KEY");
      expect(credsAfterClear).toContain("BALBES_EDIT_CREATED_API_KEY: sk-abc");
      const settingsAfterClear = await readIfPresent(join(home, "settings.yaml"));
      expect(settingsAfterClear).toContain("my-gateway");
      expect(settingsAfterClear).toContain("apiKeyEnv: BALBES_MY_GATEWAY_API_KEY");
      const afterClear = (await postJson(`${base}/api/models/list`, {}, token)).json as ModelsListBody;
      expect(afterClear.connections.find((c) => c.routeId === "my-gateway")?.hasKey).toBe(false);

      // default model save -> agent-default-model section on disk + list reflects it
      const setDefault = await postJson(`${base}/api/models/default`, { provider: "my-gateway", model: "m-1" }, token);
      expect(setDefault.status, JSON.stringify(setDefault.json)).toBe(200);
      const settingsAfterDefault = await readIfPresent(join(home, "settings.yaml"));
      expect(settingsAfterDefault).toContain("agent-default-model");
      expect(settingsAfterDefault).toContain("provider: my-gateway");
      const afterDefault = (await postJson(`${base}/api/models/list`, {}, token)).json as ModelsListBody;
      expect(afterDefault.default).toEqual({ provider: "my-gateway", model: "m-1" });
      expect(afterDefault.connections.find((c) => c.routeId === "my-gateway")?.isDefault).toBe(true);

      // delete of the route hosting the current default -> 409 default-in-use
      const blocked = await postJson(`${base}/api/models/delete`, { routeId: "my-gateway" }, token);
      expect(blocked.status).toBe(409);
      expect((blocked.json as { error: { code: string } }).error.code).toBe("default-in-use");

      // delete of an unknown route -> 404 not-found
      const missing = await postJson(`${base}/api/models/delete`, { routeId: "no-such-route" }, token);
      expect(missing.status).toBe(404);
      expect((missing.json as { error: { code: string } }).error.code).toBe("not-found");

      // move the default back, then delete succeeds and removes the route from settings.yaml
      const resetDefault = await postJson(`${base}/api/models/default`, { provider: "deepseek-official", model: "deepseek-v4-flash" }, token);
      expect(resetDefault.status, JSON.stringify(resetDefault.json)).toBe(200);
      const deleted = await postJson(`${base}/api/models/delete`, { routeId: "my-gateway" }, token);
      expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
      const settingsAfterDelete = await readIfPresent(join(home, "settings.yaml"));
      expect(settingsAfterDelete).not.toContain("my-gateway");
      expect(settingsAfterDelete).toContain("edit-created");

      // delete of the pinned deepseek route -> 400 reserved
      const reserved = await postJson(`${base}/api/models/delete`, { routeId: "deepseek-official" }, token);
      expect(reserved.status).toBe(400);
      expect((reserved.json as { error: { code: string } }).error.code).toBe("reserved");

      // cleanup: deleting the remaining custom route also removes its credential ref
      const cleanup = await postJson(`${base}/api/models/delete`, { routeId: "edit-created" }, token);
      expect(cleanup.status, JSON.stringify(cleanup.json)).toBe(200);
      const credsFinal = await readIfPresent(join(home, ".credentials.yaml"));
      expect(credsFinal).not.toContain("BALBES_EDIT_CREATED_API_KEY");
    } finally {
      await stopServer();
    }
  }, 240_000);
});
