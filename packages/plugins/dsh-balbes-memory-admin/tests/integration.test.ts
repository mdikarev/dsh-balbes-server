import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";
import type { MemoryAutonomyPolicy, MemoryProposal, MemoryRecord } from "dsh-balbes-contracts";

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const memoryPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory");
const contractsPkgRoot = join(pkgRoot, "..", "..", "contracts");
const fixtureProfile = join(here, "fixtures", "balbes-memory-admin-profile");
const PROFILE = "balbes-memory-admin-test";

async function hasDsh(): Promise<boolean> {
  try { await execFileP("dsh", ["--version"], { timeout: 10_000 }); return true; } catch { return false; }
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
 * The REAL suite copies the BUILT host/memory/memory-admin bundles (lib/,
 * package.json[, cordis.patch.yml]) into a temp profile's node_modules —
 * install.sh in miniature. Always compile src -> lib first so the copy is
 * fresh (a stale lib would silently validate old code). contracts is built
 * first because memory resolves its type-only imports from contracts/lib.
 * tsc runs straight from each package's node_modules through node (no pnpm
 * shell shim on PATH). Mirrors dsh-balbes-host/tests/integration.test.ts
 * (buildHost) and dsh-balbes-sessions/tests/integration.test.ts
 * (buildPackages).
 */
async function buildPackages(): Promise<void> {
  const configs: Array<[string, string]> = [
    [contractsPkgRoot, "tsconfig.build.json"],
    [memoryPkgRoot, "tsconfig.build.json"],
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

async function waitForHealth(port: number, child: ReturnType<typeof spawn>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("dsh exited early (code " + child.exitCode + ")");
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/api/health", { method: "POST" });
      const json = (await response.json()) as { ok?: boolean };
      if (response.status === 200 && json.ok === true) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server did not become healthy within " + timeoutMs + "ms");
}

async function postJson(url: string, body: unknown, token?: string): Promise<{ status: number; json: unknown; raw: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = "Bearer " + token;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  return { status: response.status, json, raw };
}

const realEnabled = (process.env.RUN_REAL ?? "").trim() !== "" ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (memory admin API)", () => {
  let home: string;
  let port: number;
  let login: string;
  let password: string;
  let token: string;
  let child: ReturnType<typeof spawn> | null = null;

  async function prepareHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "balbes-memory-admin-real-"));
    const profiles = join(dir, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, PROFILE), { recursive: true });
    const nm = join(profiles, PROFILE, "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    for (const [root, dirName] of [[memoryPkgRoot, "dsh-balbes-memory"], [pkgRoot, "dsh-balbes-memory-admin"]] as Array<[string, string]>) {
      await cp(join(root, "lib"), join(nm, dirName, "lib"), { recursive: true });
      await cp(join(root, "package.json"), join(nm, dirName, "package.json"));
    }
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(dir, creds);
    return dir;
  }

  async function boot(dir: string): Promise<void> {
    child = spawn("dsh", ["--profile", PROFILE], {
      env: { ...process.env, DSH_HOME: dir, BALBES_PORT: String(port), DSH_TELEMETRY_DISABLED: "1" },
      cwd: dir,
      stdio: "ignore"
    });
    await waitForHealth(port, child);
    const loginRes = await postJson("http://127.0.0.1:" + port + "/api/auth/login", { login, password });
    expect(loginRes.status, loginRes.raw).toBe(200);
    token = (loginRes.json as { token: string }).token;
  }

  async function stop(): Promise<void> {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child!.once("exit", resolve));
    }
    child = null;
  }

  const api = (path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }> =>
    postJson("http://127.0.0.1:" + port + path, body, token);

  beforeAll(async () => {
    await buildPackages();
    home = await prepareHome();
    port = await freePort();
    await boot(home);
  }, 240_000);

  afterAll(async () => {
    await stop();
    await rm(home, { recursive: true, force: true });
  });

  it("requires bearer auth", async () => {
    const res = await postJson("http://127.0.0.1:" + port + "/api/memory/list", {});
    expect(res.status).toBe(401);
  });

  it("creates, lists, updates, rejects secrets and deletes over HTTP", async () => {
    const empty = await api("/api/memory/list", {});
    expect(empty.status, empty.raw).toBe(200);
    expect(empty.json).toEqual({ records: [] });

    const saved = await api("/api/memory/save", {
      scope: { kind: "global" },
      type: "note",
      text: "smoke note",
      tags: ["smoke"]
    });
    expect(saved.status, saved.raw).toBe(200);
    const created = (saved.json as { record: { id: string; origin: string; text: string } }).record;
    expect(created.origin).toBe("owner");
    expect(created.text).toBe("smoke note");

    const listed = await api("/api/memory/list", {});
    expect((listed.json as { records: Array<{ id: string }> }).records.some((r) => r.id === created.id)).toBe(true);

    const projectSaved = await api("/api/memory/save", {
      scope: { kind: "project", name: "alpha" },
      type: "fact",
      text: "project fact"
    });
    expect(projectSaved.status, projectSaved.raw).toBe(200);
    const globalOnly = await api("/api/memory/list", { scope: { kind: "global" } });
    expect((globalOnly.json as { records: Array<{ scope: { kind: string } }> }).records.every((r) => r.scope.kind === "global")).toBe(true);

    const updated = await api("/api/memory/save", { id: created.id, type: "note", text: "edited note" });
    expect((updated.json as { record: { text: string; origin: string } }).record.text).toBe("edited note");
    expect((updated.json as { record: { origin: string } }).record.origin).toBe("owner");

    const rejected = await api("/api/memory/save", {
      scope: { kind: "global" },
      type: "note",
      text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    });
    expect(rejected.status, rejected.raw).toBe(400);
    expect((rejected.json as { error: { code: string } }).error.code).toBe("secret-detected");

    const search = await api("/api/memory/list", { query: "edited" });
    expect((search.json as { records: Array<{ id: string }> }).records.some((r) => r.id === created.id)).toBe(true);

    const removed = await api("/api/memory/delete", { id: created.id });
    expect(removed.json).toEqual({ deleted: true });
    const again = await api("/api/memory/delete", { id: created.id });
    expect(again.json).toEqual({ deleted: false });
  });

  it("keeps records across a server restart", async () => {
    const saved = await api("/api/memory/save", { scope: { kind: "global" }, type: "note", text: "durable" });
    const id = (saved.json as { record: { id: string } }).record.id;
    await stop();
    await boot(home);
    const listed = await api("/api/memory/list", { scope: { kind: "global" } });
    expect((listed.json as { records: Array<{ id: string }> }).records.some((r) => r.id === id)).toBe(true);
  }, 60_000);

  it("proposes, reviews and approves without leaking proposals into memory", async () => {
    // No hyphens: /api/memory/list feeds `query` into FTS5 MATCH verbatim and a
    // bare hyphenated token is parsed as query syntax (the runbook's memory smoke
    // says the same).
    const marker = "p10freviewmarker4c19";

    const proposed = await api("/api/memory/propose", {
      scope: { kind: "global" },
      type: "fact",
      text: "proposed fact " + marker,
      tags: ["Smoke"],
      originRef: "pipeline:real-test",
      // A hostile body must not be able to claim ownership or decide the proposal.
      origin: "owner",
      status: "accepted",
      pinned: true
    });
    expect(proposed.status, proposed.raw).toBe(200);
    const proposal = (proposed.json as { proposal: MemoryProposal }).proposal;
    expect(proposal.status).toBe("proposed");
    expect(proposal.origin).toBe("agent");
    expect(proposal.tags).toEqual(["smoke"]);
    // The proposal contract has no pinning field at all: the pipeline cannot stage one.
    expect((proposal as unknown as Record<string, unknown>).pinned).toBeUndefined();
    expect(proposal.decidedAt).toBeNull();
    expect(proposal.memoryId).toBeNull();

    const hidden = await api("/api/memory/list", { query: marker });
    expect(hidden.status, hidden.raw).toBe(200);
    expect((hidden.json as { records: unknown[] }).records).toEqual([]);

    const queue = await api("/api/memory/review/list", {});
    expect(queue.status, queue.raw).toBe(200);
    const queueJson = queue.json as { proposals: MemoryProposal[]; policy: MemoryAutonomyPolicy };
    expect(queueJson.proposals.some((entry) => entry.id === proposal.id)).toBe(true);
    expect(queueJson.policy).toEqual({ immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" });

    const approved = await api("/api/memory/review/approve", { id: proposal.id, text: "approved fact " + marker });
    expect(approved.status, approved.raw).toBe(200);
    const decided = approved.json as { proposal: MemoryProposal; record: MemoryRecord };
    expect(decided.proposal.status).toBe("accepted");
    expect(decided.proposal.decidedBy).toBe("owner");
    expect(decided.proposal.decidedEdit).toBe(true);
    expect(decided.proposal.memoryId).toBe(decided.record.id);
    expect(decided.record.origin).toBe("agent");
    expect(decided.record.originRef).toBe("pipeline:real-test");
    expect(decided.record.tags).toEqual(["smoke"]);

    const visible = await api("/api/memory/list", { query: marker });
    expect((visible.json as { records: Array<{ id: string }> }).records.some((row) => row.id === decided.record.id)).toBe(true);

    const decidedAgain = await api("/api/memory/review/approve", { id: proposal.id });
    expect(decidedAgain.status).toBe(400);
    expect((decidedAgain.json as { error: { code: string } }).error.code).toBe("invalid-status");

    const cleanup = await api("/api/memory/delete", { id: decided.record.id });
    expect(cleanup.status, cleanup.raw).toBe(200);
    expect(cleanup.json).toEqual({ deleted: true });
  });

  it("rejects a proposal, keeps it out of memory and refuses secrets", async () => {
    const marker = "p10frejectmarker8a02";
    const proposed = await api("/api/memory/propose", { scope: { kind: "global" }, type: "note", text: "rejected fact " + marker });
    const id = (proposed.json as { proposal: { id: string } }).proposal.id;

    const rejected = await api("/api/memory/review/reject", { id });
    expect(rejected.status, rejected.raw).toBe(200);
    expect((rejected.json as { proposal: MemoryProposal }).proposal.status).toBe("rejected");
    const listed = await api("/api/memory/list", { query: marker });
    expect((listed.json as { records: unknown[] }).records).toEqual([]);

    const decided = await api("/api/memory/review/list", { status: ["rejected"] });
    expect((decided.json as { proposals: MemoryProposal[] }).proposals.some((entry) => entry.id === id)).toBe(true);

    const secret = await api("/api/memory/propose", {
      scope: { kind: "global" },
      type: "note",
      text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    });
    expect(secret.status).toBe(400);
    expect((secret.json as { error: { code: string } }).error.code).toBe("secret-detected");
  });
});
