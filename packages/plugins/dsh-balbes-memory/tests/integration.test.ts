import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

/**
 * REAL composition: a real dsh profile (dsh-base + host bundle + balbes-memory)
 * booted by the real CLI. p10a has no HTTP surface, so the observable proof is
 * the durable artifact: the plugin must create and migrate
 * $DSH_HOME/storages/memory.sqlite without breaking server startup.
 *
 * Gate: RUN_REAL=1 and dsh in PATH (like the neighboring REAL suites).
 */
const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const fixtureProfile = join(here, "fixtures", "balbes-memory-profile");
const PROFILE = "balbes-memory-test";

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

async function waitForHealth(port: number, child: ReturnType<typeof spawn>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("dsh exited early (code " + child.exitCode + ")");
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/api/health", { method: "POST" });
      const json = (await response.json()) as { ok?: boolean };
      if (response.status === 200 && json.ok === true) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server did not become healthy within " + timeoutMs + "ms");
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare("PRAGMA user_version").get();
  db.close();
  return Number(row?.user_version ?? 0);
}

function schemaObjects(path: string): { tables: string[]; triggers: string[] } {
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare("SELECT type, name FROM sqlite_master").all();
    const tables: string[] = [];
    const triggers: string[] = [];
    for (const row of rows) {
      if (row.type === "table") tables.push(String(row.name));
      else if (row.type === "trigger") triggers.push(String(row.name));
    }
    return { tables, triggers };
  } finally {
    db.close();
  }
}

const realEnabled = (process.env.RUN_REAL ?? "").trim() !== "" ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (balbes-memory)", () => {
  let home: string;
  let child: ReturnType<typeof spawn> | null = null;
  let port: number;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "balbes-memory-real-"));
    await mkdir(join(home, "profiles"), { recursive: true });
    await cp(fixtureProfile, join(home, "profiles", PROFILE), { recursive: true });
    const nm = join(home, "profiles", PROFILE, "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    for (const piece of ["lib", "package.json"]) {
      await cp(join(pkgRoot, piece), join(nm, "dsh-balbes-memory", piece), { recursive: true });
    }
    const creds = await createAdminAuth();
    await writeAdminAuth(home, creds);
    port = await freePort();
    child = spawn("dsh", ["--profile", PROFILE], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home, BALBES_PORT: String(port) },
      stdio: "ignore"
    });
    await waitForHealth(port, child);
  }, 120_000);

  afterAll(async () => {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child!.once("exit", resolve));
    }
    await rm(home, { recursive: true, force: true });
  });

  it("creates and migrates the memory database without breaking startup", async () => {
    const dbPath = join(home, "storages", "memory.sqlite");
    const info = await stat(dbPath);
    expect(info.isFile()).toBe(true);
    expect(userVersion(dbPath)).toBe(2);
    const { tables, triggers } = schemaObjects(dbPath);
    // v2 (p10f) adds the staged-proposals table; the truth table, its normalized
    // tags and its FTS triggers must all survive the migration untouched.
    expect(tables).toEqual(
      expect.arrayContaining(["memories", "memory_tags", "memory_fts", "memory_proposals"])
    );
    expect(triggers).toEqual(expect.arrayContaining(["memories_ai", "memories_ad", "memories_au"]));
  });
});
