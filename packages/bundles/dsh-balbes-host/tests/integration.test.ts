import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, writeFile, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStubLlm } from "./helpers/stub-llm.mjs";
import { createAdminAuth, writeAdminAuth } from "../src/core.js";
import { runPrompt } from "../src/runner.js";

const execFileP = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);
const here = fileURLToPath(new URL(".", import.meta.url)); // tests/ dir
const pkgRoot = join(here, ".."); // dsh-balbes-host package root
const fixtureProfile = join(here, "fixtures", "balbes-test-profile");
const CANNED_TEXT = "ok from stub";
const PROBE_GLOBAL_KEY = "__balbesRunProbeCtx__";

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

/**
 * The REAL suite copies the BUILT host bundle (lib/, package.json,
 * cordis.patch.yml) into a temp profile's node_modules — install.sh in
 * miniature. Always compile src -> lib first so the copy is fresh. tsc runs
 * straight from the store through node (no pnpm shell shim on PATH).
 */
async function buildHost(): Promise<void> {
  const tsc = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
  await execFileP(process.execPath, [tsc, "-p", join(pkgRoot, "tsconfig.json")], {
    cwd: pkgRoot,
    maxBuffer: 16 * 1024 * 1024
  });
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

/** Wait until the spawned profile answers /api/health or the deadline passes. */
async function waitForHealth(port: number, child: ReturnType<typeof spawn>, log: () => string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dsh exited early (code ${child.exitCode}) before serving health:\n${log()}`);
    }
    try {
      const { status, json } = await postJson(`http://127.0.0.1:${port}/api/health`, {});
      if (status === 200) {
        const body = json as { ok?: boolean };
        if (body.ok === true) return;
      }
      last = json;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms (last: ${String(last)}):\n${log()}`);
}

// Gate: this suite exercises a real dsh CLI composition with a real model
// round-trip into a stub endpoint. It runs only when the plan's RUN_REAL=1
// switch is set AND a dsh executable is available (otherwise: skip).
// The dsh probe runs only when RUN_REAL is on, so the plain unit gate stays
// hermetic.
const runReal = (process.env.RUN_REAL ?? "").trim() !== "";
const realEnabled = runReal ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (dsh CLI + LLM stub)", () => {
  let stub: { port: number; calls: Array<{ path: string; body: unknown }>; close: () => void } | undefined;
  let home: string | undefined;
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;
  let childOut = "";
  let childErr = "";

  const childLog = (): string => `--- dsh stdout ---\n${childOut}\n--- dsh stderr ---\n${childErr}`;

  beforeAll(async () => {
    await buildHost();
    stub = await startStubLlm({ text: CANNED_TEXT });
    port = await freePort();
    home = await mkdtemp(join(tmpdir(), "balbes-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, "balbes-test"), { recursive: true });
    // install.sh recipe in miniature: the built bundle lands in the profile's
    // node_modules; @deepseek-ai/* resolves up to $DSH_HOME/profiles/node_modules,
    // which dsh heals from its own install on first boot.
    const nm = join(profiles, "balbes-test", "node_modules");
    await mkdir(nm, { recursive: true });
    await cp(join(pkgRoot, "lib"), join(nm, "dsh-balbes-host", "lib"), { recursive: true });
    await cp(join(pkgRoot, "package.json"), join(nm, "dsh-balbes-host", "package.json"));
    await cp(join(pkgRoot, "cordis.patch.yml"), join(nm, "dsh-balbes-host", "cordis.patch.yml"));
    // Auth file: never store the plaintext password, print it only to log in.
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(home, creds);
    // Point the default model at the deepseek route (llm-deepseek registers
    // provider "deepseek-official") and that adapter at the stub endpoint.
    await writeFile(
      join(home, "settings.yaml"),
      `agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nllm-deepseek:\n  baseURL: http://127.0.0.1:${stub.port}\n`
    );
  }, 240_000);

  afterAll(async () => {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    stub?.close();
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  it("dsh --profile balbes-test composes our host bundle", async () => {
    if (home === undefined) throw new Error("beforeAll did not initialize home");
    const { stdout } = await execFileP(
      "dsh",
      ["--profile", "balbes-test", "--dump-config"],
      { env: { ...process.env, DSH_HOME: home }, maxBuffer: 16 * 1024 * 1024 }
    );
    expect(stdout).toContain("balbes-api");
    expect(stdout).toContain("balbes-auth");
    expect(stdout).toContain("balbes-server");
  }, 120_000);

  it("full HTTP cycle: login -> /api/prompt hits the stub and returns its canned text", async () => {
    if (home === undefined || stub === undefined) throw new Error("beforeAll did not initialize home/stub");
    const env = {
      ...process.env,
      DSH_HOME: home,
      BALBES_PORT: String(port),
      DEEPSEEK_API_KEY: "test-key",
      DSH_TELEMETRY_DISABLED: "1"
    };
    child = spawn("dsh", ["--profile", "balbes-test"], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
    childOut = "";
    childErr = "";
    child.stdout?.on("data", (chunk: Buffer) => (childOut += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (childErr += chunk.toString()));
    const current = child;

    try {
      await waitForHealth(port, current, childLog);
      const loginRes = await postJson(`http://127.0.0.1:${port}/api/auth/login`, { login, password });
      expect(loginRes.status, JSON.stringify(loginRes.json)).toBe(200);
      const token = (loginRes.json as { token?: string }).token;
      expect(typeof token).toBe("string");

      const callsBefore = stub.calls.length;
      const promptRes = await postJson(
        `http://127.0.0.1:${port}/api/prompt`,
        { prompt: "Reply with exactly: ok from stub" },
        token
      );
      expect(promptRes.status, JSON.stringify(promptRes.json)).toBe(200);
      const body = promptRes.json as { text?: string; reason?: { kind?: string } };
      expect(body.text).toBe(CANNED_TEXT);
      expect(body.reason?.kind).toBe("completed");
      expect(stub.calls.length).toBeGreaterThan(callsBefore);
      // The stub, not a real provider, must have received the agent request.
      expect(stub.calls.length).toBeGreaterThan(0);
    } finally {
      if (current.exitCode === null) {
        current.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => current.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 10_000))
        ]);
        if (current.exitCode === null) current.kill("SIGKILL");
      }
      child = null;
    }
  }, 240_000);

  it("in-process: each runPrompt disposes its agent (registry never accumulates)", async () => {
    if (home === undefined || stub === undefined) throw new Error("beforeAll did not initialize home/stub");
    // Boot dsh-base (no host rows needed: runPrompt consumes only core
    // services) inside this vitest process through the same Loader boot the
    // CLI performs, with one extra probe row that captures a plugin context
    // able to resolve the core services (same mechanism as headless-runner).
    const { boot, healProfilesModuleFallback, loadOverlayPatches } = await import("@deepseek-ai/dsh-app-boot");
    const baseDir = dirname(requireFromHere.resolve("@deepseek-ai/dsh-base/package.json"));
    const basePatches = loadOverlayPatches("dsh", join(baseDir, "cordis.patch.yml"));
    if (!existsSync(join(home, "profiles", "node_modules", "@deepseek-ai"))) {
      // dsh heals $DSH_HOME/profiles/node_modules from its own install at
      // profile boot; mirror that here so the in-process include can resolve
      // @deepseek-ai/* from the temp home. The anchor is the running dsh
      // CLI's own package.json (workspace @deepseek-ai links resolve to it).
      const dshPkgDir = dirname(realpathSync(requireFromHere.resolve("@deepseek-ai/dsh")));
      await healProfilesModuleFallback({
        installAnchor: join(dshPkgDir, "package.json"),
        home
      });
    }
    const minDir = join(home, "profiles", "balbes-test-min");
    await mkdir(minDir, { recursive: true });
    await writeFile(join(minDir, "cordis.yml"), "# in-process REAL test root\n[]\n");

    const previousHome = process.env.DSH_HOME;
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DSH_HOME = home;
    process.env.DEEPSEEK_API_KEY = "test-key";
    let bootCtx: { fiber: { dispose(): Promise<unknown> } } | undefined;
    try {
      bootCtx = await boot("dsh", join(minDir, "cordis.yml"), [
        ...basePatches,
        { insert: [{ id: "balbes-runprobe", name: join(here, "helpers", "runprobe.mjs") }] },
        { id: "session-telemetry-otel", disabled: true }
      ]);
      const probeCtx = globalThis[PROBE_GLOBAL_KEY as keyof typeof globalThis] as { get(key: string): unknown } | undefined;
      expect(probeCtx).toBeDefined();
      const agents = probeCtx?.get("agents") as { list(): unknown[] } | undefined;
      expect(agents).toBeDefined();

      // Baseline: a freshly booted base tree registers no agents of its own.
      expect(agents?.list()).toEqual([]);

      const first = await runPrompt(probeCtx as { get(key: string): unknown }, "Reply with exactly: ok from stub");
      expect(first.text).toBe(CANNED_TEXT);
      // The agent that served the prompt must be gone after the run.
      expect(agents?.list()).toEqual([]);

      const callsBefore = stub.calls.length;
      const second = await runPrompt(probeCtx as { get(key: string): unknown }, "Reply with exactly: ok from stub");
      expect(second.text).toBe(CANNED_TEXT);
      expect(stub.calls.length).toBeGreaterThan(callsBefore);
      // Two sequential runs leave no accumulation in the registry.
      expect(agents?.list()).toEqual([]);
    } finally {
      if (bootCtx !== undefined) {
        await bootCtx.fiber.dispose().catch(() => undefined);
      }
      delete globalThis[PROBE_GLOBAL_KEY as keyof typeof globalThis];
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  }, 240_000);
});
