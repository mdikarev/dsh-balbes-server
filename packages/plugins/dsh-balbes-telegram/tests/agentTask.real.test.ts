import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject } from "../../dsh-balbes-workspaces/src/workspaces.js";
import { createWorkspacesService } from "../../dsh-balbes-workspaces/src/service.js";
import { createAgentTaskRunner, type AgentTaskDeps, type TaskResult, type WorkspaceRef } from "../src/agentTask.js";

/**
 * REAL containment + persistence proof for the workspace-aware task runner.
 *
 * Boots the real dsh base tree in-process (same recipe as the host seams
 * suite: base patches + the runprobe include + session-title-llm disabled for
 * deterministic stub scripts) and drives `createAgentTaskRunner` with the
 * real `agents`/`sessions`/`agentDefaultModel` services and the Task 4
 * workspaces service rooted at the booted $DSH_HOME.
 *
 * Gate: RUN_REAL=1 AND a dsh executable on PATH (mirror seams.test.ts). No
 * unit-suite impact — skipped otherwise.
 */

const execFileP = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);
const here = fileURLToPath(new URL(".", import.meta.url)); // tests/ dir
const PROBE_GLOBAL_KEY = "__balbesRunProbeCtx__";

const WS_NOTES_CONTENT = "notes content inside project alpha\n";
const SIBLING_SECRET_CONTENT = "PROJECT-BRAVO-SECRET-77\n";
const FAKE_AUTH_CONTENT = "FAKE-ADMIN-AUTH-SECRET-42\n";

interface SeamCtx {
  get(key: string): unknown;
}
interface FiberLike {
  dispose(): Promise<unknown>;
}
interface StubCall {
  path: string;
  body: { messages?: Array<{ role?: string; content?: string | unknown[] | unknown }> };
}
interface StubLike {
  port: number;
  calls: StubCall[];
  setScript(entries: unknown[] | undefined): void;
  setDelay(ms: number): void;
  close(): void;
}

/**
 * The stub LLM helper is plain .mjs with no declarations; load it through a
 * computed URL so TypeScript never resolves the module (the REAL host seams
 * suite imports it statically because host tests are not typechecked).
 */
const STUB_LLM_URL = new URL("../../../bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs", import.meta.url).href;
async function startStubLlm(options?: { text?: string }): Promise<StubLike> {
  const mod = (await import(STUB_LLM_URL)) as { startStubLlm(o?: { text?: string }): Promise<StubLike> };
  return mod.startStubLlm(options);
}

async function hasDsh(): Promise<boolean> {
  try {
    await execFileP("dsh", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Concatenate the text content of every `role: "tool"` message across calls. */
function toolResults(calls: StubCall[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    for (const message of call.body.messages ?? []) {
      if (message.role !== "tool") continue;
      const content = message.content;
      if (typeof content === "string") out.push(content);
      else out.push(JSON.stringify(content));
    }
  }
  return out;
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "balbes-agenttask-"));
  const minDir = join(home, "profiles", "balbes-min");
  await mkdir(minDir, { recursive: true });
  await mkdir(join(home, "profiles", "node_modules"), { recursive: true });
  await writeFile(join(minDir, "cordis.yml"), "# REAL agentTask containment probe root\n[]\n");
  return home;
}

async function bootSeams(home: string, stubPort: number): Promise<{ fiber: FiberLike; ctx: SeamCtx }> {
  const { boot, healProfilesModuleFallback, loadOverlayPatches } = await import("@deepseek-ai/dsh-app-boot");
  const baseDir = dirname(requireFromHere.resolve("@deepseek-ai/dsh-base/package.json"));
  const basePatches = loadOverlayPatches("dsh", join(baseDir, "cordis.patch.yml"));
  if (!existsSync(join(home, "profiles", "node_modules", "@deepseek-ai"))) {
    const dshPkgDir = dirname(realpathSync(requireFromHere.resolve("@deepseek-ai/dsh/package.json")));
    await healProfilesModuleFallback({ installAnchor: join(dshPkgDir, "package.json"), home });
  }
  await writeFile(
    join(home, "settings.yaml"),
    `agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nllm-deepseek:\n  baseURL: http://127.0.0.1:${stubPort}\n`
  );
  process.env.DSH_HOME = home;
  process.env.DEEPSEEK_API_KEY = "test-key";
  const probeHelper = join(here, "..", "..", "..", "bundles", "dsh-balbes-host", "tests", "helpers", "runprobe.mjs");
  const booted = await boot("dsh", join(home, "profiles", "balbes-min", "cordis.yml"), [
    ...basePatches,
    { insert: [{ id: "balbes-runprobe", name: probeHelper }] },
    { id: "session-telemetry-otel", disabled: true },
    { id: "session-title-llm", disabled: true }
  ]);
  const probeCtx = globalThis[PROBE_GLOBAL_KEY as keyof typeof globalThis] as SeamCtx | undefined;
  if (probeCtx === undefined) throw new Error("runprobe plugin did not publish its context");
  return { fiber: booted.fiber as FiberLike, ctx: probeCtx };
}

const runReal = (process.env.RUN_REAL ?? "").trim() !== "";
const realEnabled = runReal ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL agentTask: read containment guard + persistent session reuse", () => {
  let stub: StubLike | undefined;
  let home: string | undefined;
  let booted: { fiber: FiberLike; ctx: SeamCtx } | undefined;
  let previousHome: string | undefined;
  let previousKey: string | undefined;
  let runner: ReturnType<typeof createAgentTaskRunner> | undefined;
  const alphaRef: WorkspaceRef = { scope: "project", name: "alpha" };

  beforeAll(async () => {
    previousHome = process.env.DSH_HOME;
    previousKey = process.env.DEEPSEEK_API_KEY;
    home = await makeHome();
    // Real projects through the Task 4 domain: alpha is the task workspace,
    // bravo is the sibling project an alpha agent must not reach.
    const alpha = await createProject(home, "alpha");
    const bravo = await createProject(home, "bravo");
    await writeFile(join(alpha.path, "notes.txt"), WS_NOTES_CONTENT);
    await writeFile(join(bravo.path, "secret.txt"), SIBLING_SECRET_CONTENT);
    // A stand-in for the real credential document under $DSH_HOME: FAKE
    // content only, never a real secret.
    await writeFile(join(home, "admin-auth.json"), FAKE_AUTH_CONTENT);
    const started = await startStubLlm({ text: "ok from stub" });
    stub = started;
    booted = await bootSeams(home, started.port);
    const ctx = booted.ctx;
    const agents = ctx.get("agents") as unknown as AgentTaskDeps["agents"];
    const sessions = ctx.get("sessions") as unknown as AgentTaskDeps["sessions"];
    const maybeDefaultModel = ctx.get("agentDefaultModel");
    const maybeLoader = ctx.get("loader");
    const deps: AgentTaskDeps = {
      agents,
      sessions,
      workspaces: createWorkspacesService(home),
      ...(typeof maybeDefaultModel === "object" && maybeDefaultModel !== null
        ? { defaultModel: maybeDefaultModel as { currentSelection(): { provider: string; model: string } } }
        : {}),
      ...(typeof maybeLoader === "object" && maybeLoader !== null
        ? { loader: maybeLoader as { await(): Promise<void> } }
        : {})
    };
    runner = createAgentTaskRunner(deps);
  }, 240_000);

  afterAll(async () => {
    if (booted !== undefined) await booted.fiber.dispose().catch(() => undefined);
    delete globalThis[PROBE_GLOBAL_KEY as keyof typeof globalThis];
    stub?.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true }).catch(() => undefined);
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }, 60_000);

  async function runScripted(opts: {
    ref: WorkspaceRef;
    prompt: string;
    script: Array<{ text?: string; toolCall?: { name: string; arguments: string } }>;
    finalText: string;
  }): Promise<{ result: TaskResult; results: string[] }> {
    const callsBefore = stub!.calls.length;
    stub!.setScript(opts.script);
    const result = await runner!.run(opts.ref, opts.prompt);
    const calls = stub!.calls.slice(callsBefore);
    return { result, results: toolResults(calls) };
  }

  it("in-workspace relative read returns the real content to the model (guard allows)", async () => {
    const { result, results } = await runScripted({
      ref: alphaRef,
      prompt: "read the notes file",
      script: [
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: "notes.txt" }) } },
        { text: "read ok" }
      ],
      finalText: "read ok"
    });
    expect(result.ok).toBe(true);
    const ok = result as Extract<typeof result, { ok: true }>;
    expect(ok.text).toBe("read ok");
    expect(ok.sessionId).toBeTruthy();
    // The real read tool executed inside the guarded agent and its content
    // reached the model as a role:"tool" message.
    expect(results.join("\n")).toContain(WS_NOTES_CONTENT.trim());
  }, 120_000);

  it("containment: a sibling project and $DSH_HOME are unreadable; the session is reused across runs", async () => {
    // Run 1: ../ traversal toward the sibling project's secret file.
    const sibling = await runScripted({
      ref: alphaRef,
      prompt: "read the sibling secret",
      script: [
        {
          toolCall: {
            name: "read",
            arguments: JSON.stringify({ file_path: "../bravo/secret.txt" })
          }
        },
        { text: "sibling result" }
      ],
      finalText: "sibling result"
    });
    expect(sibling.result.ok).toBe(true);
    const siblingResults = sibling.results.join("\n");
    // The guard denies the read: the model sees a denial/error tool result...
    expect(siblingResults).toContain("denied");
    expect(siblingResults).toContain("outside the workspace root");
    // ...never the bytes of the sibling project.
    expect(siblingResults).not.toContain(SIBLING_SECRET_CONTENT.trim());

    // Run 2: an absolute path into $DSH_HOME (a FAKE admin-auth stand-in).
    const abs = await runScripted({
      ref: alphaRef,
      prompt: "read the admin file",
      script: [
        {
          toolCall: {
            name: "read",
            arguments: JSON.stringify({ file_path: join(home!, "admin-auth.json") })
          }
        },
        { text: "absolute result" }
      ],
      finalText: "absolute result"
    });
    expect(abs.result.ok).toBe(true);
    const absResults = abs.results.join("\n");
    expect(absResults).toContain("denied");
    expect(absResults).toContain("outside the workspace root");
    expect(absResults).not.toContain(FAKE_AUTH_CONTENT.trim());

    // Run 3: in-workspace reads keep working after the denials.
    const insideAgain = await runScripted({
      ref: alphaRef,
      prompt: "read the notes again",
      script: [
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: "notes.txt" }) } },
        { text: "read ok again" }
      ],
      finalText: "read ok again"
    });
    expect(insideAgain.result.ok).toBe(true);
    expect(insideAgain.results.join("\n")).toContain(WS_NOTES_CONTENT.trim());

    // Session reuse: every run on the same ref resolves the SAME sessionId.
    const okRuns = [sibling.result, abs.result, insideAgain.result].filter(
      (r): r is Extract<typeof r, { ok: true }> => r.ok === true
    );
    expect(okRuns).toHaveLength(3);
    const [first, second, third] = okRuns;
    expect(second!.sessionId).toBe(first!.sessionId);
    expect(third!.sessionId).toBe(first!.sessionId);
    expect(runner!.sessionIdOf(alphaRef)).toBe(first!.sessionId);
    expect(runner!.snapshot()).toEqual([{ key: "project:alpha", sessionId: first!.sessionId }]);
  }, 240_000);

  it("each workspace key owns a distinct session", async () => {
    const bravo = await runScripted({
      ref: { scope: "project", name: "bravo" },
      prompt: "read the notes",
      script: [
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: "secret.txt" }) } },
        { text: "bravo ok" }
      ],
      finalText: "bravo ok"
    });
    expect(bravo.result.ok).toBe(true);
    const ok = bravo.result as Extract<typeof bravo.result, { ok: true }>;
    expect(ok.text).toBe("bravo ok");
    const alpha = runner!.sessionIdOf(alphaRef);
    expect(ok.sessionId).not.toBe(alpha);
    expect(runner!.snapshot()).toHaveLength(2);
  }, 120_000);
});
