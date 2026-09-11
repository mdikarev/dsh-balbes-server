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
  kind: "deepseek" | "preset" | "custom";
  /** Present only for kind "preset"; equals the catalog provider id (== routeId). */
  providerId?: string;
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

/**
 * Indented text of one YAML block whose key starts a line on its own
 * (indent-insensitive), e.g. the openai route under llm-pi-ai providers.
 * Returns "" when no such key exists. The settings store indentation is a
 * serializer detail, so extraction never depends on a specific column.
 */
function yamlBlockForKey(yaml: string, key: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === key + ":");
  if (start === -1) return "";
  const keyIndent = lines[start]!.length - lines[start]!.trimStart().length;
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    if (line.length - line.trimStart().length <= keyIndent) break;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Model ids declared in one YAML provider block, independent of the serializer
 * style: the engine emits either a flow list (`models: [ { id: a } ]`) or a
 * block list (`models:\n  - id: a`). Matching `id:` on its own avoids the
 * prefix trap (`gpt-4o` vs `gpt-4o-mini`).
 */
function yamlModelIds(block: string): string[] {
  const ids: string[] = [];
  const re = /\bid:\s*([A-Za-z0-9._:-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) ids.push(match[1]!);
  return ids;
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

      // fresh home: the engine default selection is
      // {provider: "deepseek-official", model: "deepseek-flash"} (dsh-base
      // cordis.patch.yml `agent-default-model`, engine 0.1.5); the reserved
      // deepseek route is the one marked isDefault, no key stored yet.
      const empty = await postJson(`${base}/api/models/list`, {}, token);
      expect(empty.status, JSON.stringify(empty.json)).toBe(200);
      const body = empty.json as ModelsListBody;
      expect(body.default).toEqual({ provider: "deepseek-official", model: "deepseek-flash" });
      const ds = body.connections.find((c) => c.routeId === "deepseek-official");
      expect(ds?.kind).toBe("deepseek");
      expect(ds?.hasKey).toBe(false);
      expect(ds?.models).toContain("deepseek-v4-flash");
      expect(ds?.models).toContain("deepseek-flash");
      expect(ds?.isDefault).toBe(true);
      // Anti-desync guard: models.list's current default must be offered by its
      // own connection, otherwise the admin select shows a different model and
      // models.default rejects the engine's actual default with 400.
      const defaultConnection = body.connections.find((c) => c.routeId === body.default.provider);
      expect(
        defaultConnection?.models,
        `models.list default ${body.default.provider}/${body.default.model} is missing from its connection's catalog`
      ).toContain(body.default.model);
      // and that same default is re-savable (the pre-fix behavior was 400 invalid-model)
      const resaveDefault = await postJson(`${base}/api/models/default`, { provider: body.default.provider, model: body.default.model }, token);
      expect(resaveDefault.status, JSON.stringify(resaveDefault.json)).toBe(200);

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

  it("models API: catalog preset route (openai) is accepted by the engine without api/baseURL and round-trips save/list/duplicate/unknown/delete", async () => {
    if (home === undefined) throw new Error("home not initialized");
    const base = `http://127.0.0.1:${port}`;
    try {
      const token = await bootServer();

      // 401 on a preset save without a token
      const unauth = await postJson(`${base}/api/models/save`, { kind: "preset", provider: "openai", key: "sk-abc", models: ["gpt-4o-mini"] });
      expect(unauth.status).toBe(401);

      // save an api-less preset route named by the engine catalog provider id.
      // The engine (dsh-llm-pi-ai) validates llm-pi-ai where it is written, so
      // a 200 here is the acceptance proof that the api-less route config shape
      // is serviceable; an engine refusal would surface its exact text below.
      const saved = await postJson(`${base}/api/models/save`, {
        kind: "preset", provider: "openai", key: "sk-abc", models: ["gpt-4o-mini"]
      }, token);
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);

      // disk: llm-pi-ai carries the openai route with apiKeyEnv + models and no
      // api/baseURL keys; the key value lives in the credentials file
      const settingsYaml = await readFile(join(home, "settings.yaml"), "utf8");
      const openaiBlock = yamlBlockForKey(settingsYaml, "openai");
      expect(openaiBlock).not.toBe("");
      expect(openaiBlock).toContain("apiKeyEnv: BALBES_OPENAI_API_KEY");
      expect(openaiBlock).toContain("gpt-4o-mini");
      expect(openaiBlock).not.toContain("api:");
      expect(openaiBlock).not.toContain("baseURL:");
      const credsYaml = await readFile(join(home, ".credentials.yaml"), "utf8");
      expect(credsYaml).toContain("BALBES_OPENAI_API_KEY: sk-abc");

      // list reflects the api-less openai connection as a preset
      const listed = await postJson(`${base}/api/models/list`, {}, token);
      expect(listed.status, JSON.stringify(listed.json)).toBe(200);
      const conn = (listed.json as ModelsListBody).connections.find((c) => c.routeId === "openai");
      expect(conn?.kind).toBe("preset");
      expect(conn?.providerId).toBe("openai");
      expect(conn?.displayName).toBe("OpenAI");
      expect(conn?.hasKey).toBe(true);
      expect(conn?.models).toEqual(["gpt-4o-mini"]);
      expect(conn?.baseURL).toBeUndefined();

      // duplicate preset save without routeId -> 409 route-exists
      const dup = await postJson(`${base}/api/models/save`, { kind: "preset", provider: "openai", key: "sk-2", models: ["gpt-4o-mini"] }, token);
      expect(dup.status, JSON.stringify(dup.json)).toBe(409);
      expect((dup.json as { error: { code: string } }).error.code).toBe("route-exists");

      // unknown provider -> 400 invalid-provider (server-side allowlist; the
      // engine is not consulted, so the catalog drift guard stays local)
      const unknown = await postJson(`${base}/api/models/save`, {
        kind: "preset", provider: "totally-unknown-id", key: "sk-x", models: ["m-1"]
      }, token);
      expect(unknown.status, JSON.stringify(unknown.json)).toBe(400);
      expect((unknown.json as { error: { code: string } }).error.code).toBe("invalid-provider");

      // baseURL override (custom URL): edit-save WITH a custom URL stores it and
      // the list exposes it on the preset connection
      const withBase = await postJson(`${base}/api/models/save`, {
        kind: "preset", provider: "openai", routeId: "openai", baseURL: "https://custom-openai.example/v1", models: ["gpt-4o-mini", "gpt-4o"]
      }, token);
      expect(withBase.status, JSON.stringify(withBase.json)).toBe(200);
      const yamlWithBase = await readIfPresent(join(home, "settings.yaml"));
      const openaiWithBase = yamlBlockForKey(yamlWithBase, "openai");
      expect(openaiWithBase).toContain("baseURL: https://custom-openai.example/v1");
      expect(openaiWithBase).toContain("gpt-4o");
      const listedWithBase = (await postJson(`${base}/api/models/list`, {}, token)).json as ModelsListBody;
      expect(listedWithBase.connections.find((c) => c.routeId === "openai")?.baseURL).toBe("https://custom-openai.example/v1");
      expect(listedWithBase.connections.find((c) => c.routeId === "openai")?.models).toEqual(["gpt-4o-mini", "gpt-4o"]);

      // edit-save WITHOUT baseURL (and a shorter models list): settings.replace
      // must drop the stored override and the removed model — a non-deleting
      // settings.update would silently keep both
      const overrideRemoved = await postJson(`${base}/api/models/save`, {
        kind: "preset", provider: "openai", routeId: "openai", models: ["gpt-4o-mini"]
      }, token);
      expect(overrideRemoved.status, JSON.stringify(overrideRemoved.json)).toBe(200);
      const yamlAfterEdit = await readIfPresent(join(home, "settings.yaml"));
      const openaiAfterEdit = yamlBlockForKey(yamlAfterEdit, "openai");
      expect(openaiAfterEdit).not.toBe("");
      // dsh 0.1.5 serializes the llm-pi-ai section block-style
      // (`models:\n  - id: gpt-4o-mini`) instead of the 0.1.2 inline flow list;
      // the id extraction below is style-independent, so the check tracks the
      // stored fact (which models sit under `openai`) rather than the emitter.
      expect(openaiAfterEdit).toContain("apiKeyEnv: BALBES_OPENAI_API_KEY");
      expect(yamlModelIds(openaiAfterEdit)).toEqual(["gpt-4o-mini"]);
      expect(openaiAfterEdit).not.toContain("baseURL:");
      expect(openaiAfterEdit).not.toContain("custom-openai.example");
      const listedAfterEdit = (await postJson(`${base}/api/models/list`, {}, token)).json as ModelsListBody;
      const connAfterEdit = listedAfterEdit.connections.find((c) => c.routeId === "openai");
      expect(connAfterEdit?.baseURL).toBeUndefined();
      expect(connAfterEdit?.models).toEqual(["gpt-4o-mini"]);
      // an absent key on the edits leaves the stored credential untouched
      expect(connAfterEdit?.hasKey).toBe(true);

      // delete removes the openai route from settings.yaml and its key ref
      const deleted = await postJson(`${base}/api/models/delete`, { routeId: "openai" }, token);
      expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
      const settingsAfter = await readIfPresent(join(home, "settings.yaml"));
      expect(yamlBlockForKey(settingsAfter, "openai")).toBe("");
      const credsAfter = await readIfPresent(join(home, ".credentials.yaml"));
      expect(credsAfter).not.toContain("BALBES_OPENAI_API_KEY");
    } finally {
      await stopServer();
    }
  }, 240_000);

  it("models.catalog serves the engine runtime catalog: 401 unauthenticated; deepseek-official + openai 200 with models; custom route / unknown provider 400 invalid-provider; models.list deepseek models from the runtime catalog", async () => {
    if (home === undefined) throw new Error("home not initialized");
    const base = `http://127.0.0.1:${port}`;
    try {
      const token = await bootServer();

      // 401 without a token on the catalog route
      expect((await postJson(`${base}/api/models/catalog`, { provider: "deepseek-official" })).status).toBe(401);
      expect((await postJson(`${base}/api/models/catalog`, { provider: "openai" })).status).toBe(401);

      // THE discriminating live-engine check: the runtime require/import of
      // @earendil-works/pi-ai/providers/all resolves under the dsh loader
      // (profile mirror) and getBuiltinModels("openai") returns a non-empty
      // catalog. openai has NO pinned fallback, so [] here would mean the
      // runtime read failed.
      const openai = await postJson(`${base}/api/models/catalog`, { provider: "openai" }, token);
      expect(openai.status, JSON.stringify(openai.json)).toBe(200);
      const openaiBody = openai.json as { provider: string; models: Array<{ id: string; name?: string }> };
      expect(openaiBody.provider).toBe("openai");
      expect(openaiBody.models.length, `openai catalog came back empty — runtime engine catalog read failed: ${JSON.stringify(openai.json)}`).toBeGreaterThan(0);

      // deepseek-official -> the union engine catalog: native
      // dsh-llm-deepseek entries first (incl. the 0.1.5 default
      // deepseek-flash), then pi-ai-only ids; deduplicated by id
      const ds = await postJson(`${base}/api/models/catalog`, { provider: "deepseek-official" }, token);
      expect(ds.status, JSON.stringify(ds.json)).toBe(200);
      const dsBody = ds.json as { provider: string; models: Array<{ id: string; name?: string }> };
      expect(dsBody.provider).toBe("deepseek-official");
      expect(dsBody.models.map((m) => m.id)).toEqual([
        "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"
      ]);
      expect(new Set(dsBody.models.map((m) => m.id)).size).toBe(dsBody.models.length);

      // a custom connection's route id has no engine catalog -> 400
      const saved = await postJson(`${base}/api/models/save`, {
        kind: "custom", displayName: "My GW", baseURL: "https://gw.example/v1", key: "sk-abc", models: ["m-1"]
      }, token);
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      const custom = await postJson(`${base}/api/models/catalog`, { provider: "my-gw" }, token);
      expect(custom.status, JSON.stringify(custom.json)).toBe(400);
      expect((custom.json as { error: { code: string } }).error.code).toBe("invalid-provider");
      // a totally unknown provider id -> 400 too
      const unknown = await postJson(`${base}/api/models/catalog`, { provider: "totally-unknown" }, token);
      expect(unknown.status, JSON.stringify(unknown.json)).toBe(400);
      expect((unknown.json as { error: { code: string } }).error.code).toBe("invalid-provider");

      // models.list: the deepseek connection's models come from the runtime
      // union engine catalog -> all four ids, deepseek-flash included
      const listed = await postJson(`${base}/api/models/list`, {}, token);
      expect(listed.status, JSON.stringify(listed.json)).toBe(200);
      const listedBody = listed.json as ModelsListBody;
      const dsConn = listedBody.connections.find((c) => c.routeId === "deepseek-official");
      expect(dsConn?.models).toEqual([
        "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"
      ]);
      // the same anti-desync guard as the first test, now on this boot
      const defaultConn = listedBody.connections.find((c) => c.routeId === listedBody.default.provider);
      expect(
        defaultConn?.models,
        `models.list default ${listedBody.default.provider}/${listedBody.default.model} is missing from its connection's catalog`
      ).toContain(listedBody.default.model);

      // cleanup: remove the custom route so the shared home stays clean
      const deleted = await postJson(`${base}/api/models/delete`, { routeId: "my-gw" }, token);
      expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
    } finally {
      await stopServer();
    }
  }, 240_000);
});
