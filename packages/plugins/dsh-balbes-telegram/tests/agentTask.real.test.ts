import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject } from "../../dsh-balbes-workspaces/src/workspaces.js";
import { createWorkspacesService } from "../../dsh-balbes-workspaces/src/service.js";
import { createAgentTaskRunner, type AgentTaskDeps, type TaskResult, type WorkspaceRef } from "../src/agentTask.js";

/**
 * REAL tool-surface parity + persistence proof for the workspace-aware task runner.
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
const WRITE_PROOF_CONTENT = "written through the parity surface\n";

/**
 * The cancel case: a turn the agent must remember, a long turn the stub HOLDS
 * (the hold is the determinism — the cancel lands while the model request is
 * genuinely in flight, and nothing here sleeps to make that true), and the
 * follow-up that proves the session and its transcript survived the stop.
 */
const CANCEL_MEMORY_PROMPT = "Запомни: кодовое число 41.";
const CANCEL_LONG_PROMPT = "Считай от 1 до 1000 по одному числу в строке, не останавливайся.";
const CANCEL_FOLLOW_UP_PROMPT = "Какое кодовое число ты запомнил? Ответь только числом.";
/** Longer than the cancel round trip below, short enough to drain afterwards. */
const CANCEL_HOLD_MS = 3000;

/**
 * The tool registry of the dsh 0.1.5-rc.2 base composition this suite boots:
 * the base patches + the runprobe row, on a POSIX host (`bash` is mounted,
 * `pwsh` is not). Pinned against the live registry instead of described in
 * prose, because this is the parity target: the agent surface must equal what
 * the engine really mounts, so a diff here is what a reviewer sees when a
 * release adds or drops a tool.
 *
 * `str_replace_editor` is absent since 0.1.5: the
 * `dsh-tool-str-replace-editor` package still ships, but the base composition
 * no longer mounts a row for it (0.1.2-rc.1 did).
 */
const DEPLOYMENT_TOOLS = [
  "bash",
  "create_goal",
  "edit",
  "exit_plan_mode",
  "get_goal",
  "glob",
  "grep",
  "interrupt_agent",
  "job_kill",
  "job_list",
  "job_output",
  "list_agents",
  "ralph",
  "read",
  "read_image",
  "send_message",
  "skill",
  "subagent",
  "subagent_fork",
  "todo_write",
  "update_goal",
  "web_fetch",
  "web_search",
  "workflow",
  "write"
];

interface SeamCtx {
  get(key: string): unknown;
}
interface FiberLike {
  dispose(): Promise<unknown>;
}
/**
 * The Task 1 probe mechanism: dsh-tools' own registry view for one agent. The
 * agent object IS the scope key, so `schemas(agent)` is exactly the surface the
 * model is offered, and `get(name, agent)` the definition it may execute.
 */
interface ToolRuntimeLike {
  schemas(scope?: unknown): Array<{ name: string }>;
  get(name: string, scope?: unknown): { parameters?: unknown } | undefined;
}
interface CapturedHandle {
  agent: unknown;
  dispose(): Promise<void>;
}
type AgentHandle = Awaited<ReturnType<AgentTaskDeps["agents"]["create"]>>;
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

/** Poll `check` until it returns a value, or fail with `description`. */
async function waitFor(check: () => boolean, description: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
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

/**
 * Tool results THIS run added that the transcript did not already carry. The
 * runner keeps one persistent session per workspace, so every request replays
 * the whole history: a negative assertion ("this turn did not leak X") has to
 * look at what this run added, never at the accumulated transcript.
 */
function addedToolResults(priorCalls: StubCall[], calls: StubCall[]): string[] {
  if (calls.length === 0) return [];
  const prior = new Set(toolResults(priorCalls));
  const added: string[] = [];
  // Each request replays the transcript, so one result shows up in every later
  // request of the run: keep the distinct additions.
  for (const result of toolResults(calls)) {
    if (prior.has(result) || added.includes(result)) continue;
    added.push(result);
  }
  return added;
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "balbes-agenttask-"));
  const minDir = join(home, "profiles", "balbes-min");
  await mkdir(minDir, { recursive: true });
  await mkdir(join(home, "profiles", "node_modules"), { recursive: true });
  await writeFile(join(minDir, "cordis.yml"), "# REAL agentTask parity probe root\n[]\n");
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

describe.skipIf(!realEnabled)("REAL agentTask: tool-surface parity + persistent session reuse", () => {
  let stub: StubLike | undefined;
  let home: string | undefined;
  let alphaPath: string | undefined;
  let booted: { fiber: FiberLike; ctx: SeamCtx } | undefined;
  let previousHome: string | undefined;
  let previousKey: string | undefined;
  let runner: ReturnType<typeof createAgentTaskRunner> | undefined;
  let tools: ToolRuntimeLike | undefined;
  /** Every handle the REAL registry handed the runner, in creation order. */
  const captured: CapturedHandle[] = [];
  const alphaRef: WorkspaceRef = { scope: "project", name: "alpha" };

  beforeAll(async () => {
    previousHome = process.env.DSH_HOME;
    previousKey = process.env.DEEPSEEK_API_KEY;
    home = await makeHome();
    // Real projects through the Task 4 domain: alpha is the task workspace,
    // bravo is the sibling project an alpha agent reaches under parity.
    const alpha = await createProject(home, "alpha");
    const bravo = await createProject(home, "bravo");
    alphaPath = alpha.path;
    await writeFile(join(alpha.path, "notes.txt"), WS_NOTES_CONTENT);
    await writeFile(join(bravo.path, "secret.txt"), SIBLING_SECRET_CONTENT);
    // A stand-in for the real credential document under $DSH_HOME: FAKE
    // content only, never a real secret.
    await writeFile(join(home, "admin-auth.json"), FAKE_AUTH_CONTENT);
    const started = await startStubLlm({ text: "ok from stub" });
    stub = started;
    booted = await bootSeams(home, started.port);
    const ctx = booted.ctx;
    tools = ctx.get("tools") as ToolRuntimeLike;
    const realAgents = ctx.get("agents") as unknown as AgentTaskDeps["agents"];
    // The runner is driven through the PRODUCTION composition: the real
    // registry calls the setup callback composeAgentSetup installs, so the
    // surface below is the one a Telegram task session really gets. The wrapper
    // only remembers the handles so the probe can ask dsh-tools what each agent
    // sees.
    const agents: AgentTaskDeps["agents"] = {
      create: async (options: unknown): Promise<AgentHandle> => {
        const handle = await realAgents.create(options);
        captured.push(handle as unknown as CapturedHandle);
        return handle;
      },
      resume: async (options: unknown): Promise<AgentHandle> => {
        const handle = await realAgents.resume(options as never);
        captured.push(handle as unknown as CapturedHandle);
        return handle;
      }
    };
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
  }): Promise<{ result: TaskResult; results: string[]; turnResults: string[] }> {
    const callsBefore = stub!.calls.length;
    const priorCalls = stub!.calls.slice(0, callsBefore);
    stub!.setScript(opts.script);
    const result = await runner!.run(opts.ref, opts.prompt);
    const calls = stub!.calls.slice(callsBefore);
    return { result, results: toolResults(calls), turnResults: addedToolResults(priorCalls, calls) };
  }

  it("in-workspace relative read returns the real content to the model", async () => {
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
    // The real read tool executed inside the agent and its content reached
    // the model as a role:"tool" message.
    expect(results.join("\n")).toContain(WS_NOTES_CONTENT.trim());
  }, 120_000);

  it("a sibling project and $DSH_HOME are readable (parity); the session is reused across runs", async () => {
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
    // Under parity the read is not contained: the bytes reach the model.
    expect(siblingResults).toContain(SIBLING_SECRET_CONTENT.trim());

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
    expect(absResults).toContain(FAKE_AUTH_CONTENT.trim());

    // Run 3: in-workspace reads keep working.
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

  /**
   * The parity acceptance: a Telegram-launched agent is offered exactly the
   * deployment tool surface, and every one of those tools is reachable through
   * `tools.get(name, agent)`. Host-independent: it reads dsh-tools' own
   * registry view for the live agent instead of relying on this macOS host's
   * fail-closed bash.
   */
  it("the tool surface of a telegram-launched agent is the whole deployment surface", async () => {
    const handle = captured[0];
    expect(handle, "a handle created through the runner").toBeDefined();
    const agent = handle!.agent;
    const names = tools!.schemas(agent).map((schema) => schema.name);
    const deploymentNames = tools!.schemas().map((schema) => schema.name);

    expect([...deploymentNames].sort()).toEqual([...DEPLOYMENT_TOOLS].sort());
    expect([...names].sort()).toEqual([...DEPLOYMENT_TOOLS].sort());
    for (const name of DEPLOYMENT_TOOLS) {
      expect(tools!.get(name, agent), `tools.get(${name}, agent)`).toBeDefined();
    }
  }, 120_000);

  /**
   * The parity surface still WORKS: an in-workspace write goes through the
   * real fs tool (the file lands on disk), so parity did not cost the task
   * flow its file work.
   */
  it("an in-workspace write still reaches the disk", async () => {
    const target = join(alphaPath!, "written.txt");
    const { result, results, turnResults } = await runScripted({
      ref: alphaRef,
      prompt: "write a file",
      script: [
        {
          toolCall: {
            name: "write",
            arguments: JSON.stringify({ file_path: "written.txt", content: WRITE_PROOF_CONTENT })
          }
        },
        { text: "write ok" }
      ],
      finalText: "write ok"
    });
    expect(result.ok).toBe(true);
    // This turn's own tool result is a success, not a refusal.
    expect(turnResults.join("\n")).not.toContain("unknown tool");
    expect(turnResults.join("\n")).not.toContain("denied");
    expect(results.join("\n")).toContain("written.txt");
    // The real write executed: the bytes are on disk inside the workspace.
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(WRITE_PROOF_CONTENT);
  }, 120_000);

  /**
   * The soft stop at AGENT level: `runner.cancel` aborts the turn in flight and
   * settles it as `cancelled`, but the handle, the session and the transcript
   * survive — the next task continues the SAME session and the model is handed
   * the pre-cancel turn. The counterpart of the Telegram `/stop` case: there the
   * proof is the chat's session mapping and its receipt, here it is the runner's
   * own session id and the request the engine really sends.
   */
  it("REAL: a cancelled turn keeps the session and its context", async () => {
    const first = await runScripted({
      ref: alphaRef,
      prompt: CANCEL_MEMORY_PROMPT,
      script: [{ text: "запомнил" }],
      finalText: "запомнил"
    });
    expect(first.result.ok).toBe(true);
    const firstOk = first.result as Extract<typeof first.result, { ok: true }>;
    expect(firstOk.sessionId).toBeTruthy();
    const firstTurn = stub!.calls.at(-1);
    expect(JSON.stringify(firstTurn?.body ?? {})).toContain(CANCEL_MEMORY_PROMPT);

    // The long task: the stub HOLDS its reply, so the turn is parked on the
    // model request (the wait below is on that request landing, never a sleep).
    const callsBefore = stub!.calls.length;
    const heldAt = Date.now();
    stub!.setDelay(CANCEL_HOLD_MS);
    const long = runner!.run(alphaRef, CANCEL_LONG_PROMPT);
    try {
      await waitFor(() => stub!.calls.length > callsBefore, "the held turn to reach the stub");
      const outcome = await runner!.cancel(alphaRef);
      expect(outcome.cancelled).toBe(true);
      expect(outcome.dropped).toBe(0);
      await expect(long).resolves.toMatchObject({ ok: false, code: "cancelled" });
    } finally {
      stub!.setDelay(0);
    }
    // Release the hold and let the parked response settle before the follow-up
    // (the stub keeps its own timer; mirrors the host seams cancel case).
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, CANCEL_HOLD_MS - (Date.now() - heldAt))));

    // The follow-up: same workspace, therefore the same session. Its ANSWER is
    // scripted (the stub generates nothing), so the memory is proven where it
    // really lives — in what the engine asks: the request still carries the turn
    // that preceded the cancel, and the transcript grew instead of restarting.
    const follow = await runScripted({
      ref: alphaRef,
      prompt: CANCEL_FOLLOW_UP_PROMPT,
      script: [{ text: "41" }],
      finalText: "41"
    });
    expect(follow.result.ok).toBe(true);
    const followOk = follow.result as Extract<typeof follow.result, { ok: true }>;
    expect(followOk.text).toBe("41");
    expect(followOk.sessionId).toBe(firstOk.sessionId);
    expect(runner!.sessionIdOf(alphaRef)).toBe(firstOk.sessionId);
    const followTurn = stub!.calls.at(-1);
    const followBody = JSON.stringify(followTurn?.body ?? {});
    expect(followBody, followBody.slice(0, 2000)).toContain(CANCEL_MEMORY_PROMPT);
    expect(followTurn?.body.messages?.length ?? 0).toBeGreaterThan(firstTurn?.body.messages?.length ?? 0);
  }, 240_000);
});
