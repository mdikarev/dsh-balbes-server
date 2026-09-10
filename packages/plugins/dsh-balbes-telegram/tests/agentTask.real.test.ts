import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
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
/** The content a shell/editor read of the $DSH_HOME stand-in would leak. */
const CREDENTIALS_PROBE_CONTENT = "FAKE-CREDENTIALS-PROBE-91\n";
const WRITE_PROOF_CONTENT = "written through the restricted surface\n";

/**
 * The agent-visible tools this deployment KEEPS (see KEPT_TOOL_NAMES in
 * src/agentTask.ts): workspace file work, internet SEARCH (`web_search`) plus
 * benign bookkeeping. Search is kept deliberately — it is provider-mediated
 * and cannot post data to an address the model picks. `web_fetch` is the
 * mirror image and is NOT kept (see DENIED_TOOLS): it is an egress channel to
 * an arbitrary URL.
 */
const KEPT_TOOLS = [
  "read",
  "read_image",
  "write",
  "edit",
  "glob",
  "grep",
  "web_search",
  "todo_write",
  "get_goal",
  "create_goal",
  "update_goal"
];

/**
 * Tools the Telegram surface must NEVER expose. `bash` is a concrete escape on
 * a host with a usable sandbox backend (the production Linux VPS): there the
 * shell runs confined by a policy that permits reads anywhere
 * (`readOnly: ["/"]`), so `cat $DSH_HOME/.credentials.yaml` returns bytes —
 * the exact hole a path-argument guard cannot close. `web_fetch` is the
 * containment split's other half: fetching an arbitrary URL is an egress
 * channel an indirect prompt injection can point at an attacker's server, so
 * a Telegram task must never be offered it.
 */
const DENIED_TOOLS = [
  "bash",
  "pwsh",
  "str_replace_editor",
  "job_list",
  "job_output",
  "job_kill",
  "subagent",
  "subagent_fork",
  "workflow",
  "ralph",
  "web_fetch",
  "skill",
  "send_message",
  "interrupt_agent",
  "list_agents"
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

const EGRESS_BAIT_CONTENT = "EGRESS-BAIT-BODY-31\n";

/**
 * A loopback HTTP listener used as egress bait: the scripted `web_fetch` probe
 * points at it, so if the restricted surface ever offered the fetch tool the
 * request would land here. Zero recorded requests is the host-independent
 * proof that no fetch was performed — no reliance on this host's sandbox.
 */
async function startEgressBait(): Promise<{
  url: string;
  requests: string[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(EGRESS_BAIT_CONTENT);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/egress-probe`,
    requests,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
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

describe.skipIf(!realEnabled)("REAL agentTask: restricted tool surface + read containment + persistent session reuse", () => {
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
    // bravo is the sibling project an alpha agent must not reach.
    const alpha = await createProject(home, "alpha");
    const bravo = await createProject(home, "bravo");
    alphaPath = alpha.path;
    await writeFile(join(alpha.path, "notes.txt"), WS_NOTES_CONTENT);
    await writeFile(join(bravo.path, "secret.txt"), SIBLING_SECRET_CONTENT);
    // Stand-ins for the real credential document and a secret-adjacent file
    // under $DSH_HOME: FAKE content only, never a real secret.
    await writeFile(join(home, "admin-auth.json"), FAKE_AUTH_CONTENT);
    await writeFile(join(home, "credentials-probe.txt"), CREDENTIALS_PROBE_CONTENT);
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

  /**
   * The acceptance the whole-branch review demanded for the Critical finding:
   * the DENIED tools are absent from the surface a Telegram-launched agent is
   * offered AND cannot execute, the KEPT tools are present, and the removal is
   * per-agent (the deployment itself still registers them). Host-independent:
   * it reads dsh-tools' own registry view for the live agent instead of
   * relying on this macOS host's fail-closed bash.
   */
  it("the tool surface of a telegram-launched agent is restricted to workspace file work", async () => {
    // Reuses alpha's live handle (created by the first test); the probe needs
    // an agent that went through composeAgentSetup.
    const handle = captured[0];
    expect(handle, "a handle created through the runner").toBeDefined();
    const agent = handle!.agent;
    const names = tools!.schemas(agent).map((schema) => schema.name);

    // The deployment-wide view is the control: the tools exist, so their
    // absence below is this agent's restriction, not a missing plugin. The
    // kept search tool is in this list too — its appearance on the agent
    // surface must not be an accident of the deployment lacking it.
    const deploymentNames = tools!.schemas().map((schema) => schema.name);
    for (const name of ["bash", "read", "write", "edit", "str_replace_editor", "web_search", "web_fetch"]) {
      expect(deploymentNames, `deployment registers ${name}`).toContain(name);
    }

    for (const name of KEPT_TOOLS) {
      expect(names, `agent-visible surface keeps ${name}`).toContain(name);
      expect(tools!.get(name, agent), `tools.get(${name}, agent)`).toBeDefined();
    }
    for (const name of DENIED_TOOLS) {
      expect(names, `agent-visible surface hides ${name}`).not.toContain(name);
      // Hidden is not enough: the definition must be unreachable for the agent
      // that the tool is removed for, which is what makes a call fail.
      expect(tools!.get(name, agent), `tools.get(${name}, agent)`).toBeUndefined();
    }
    // Not a blanket narrowing of the deployment: the global view still has them
    // — including the excluded fetch tool, whose sibling search IS kept.
    expect(tools!.get("bash")).toBeDefined();
    expect(tools!.get("web_search")).toBeDefined();
    expect(tools!.get("web_fetch")).toBeDefined();
    // The model-facing catalog matches the surface exactly.
    expect(names.filter((name) => name === "run_code")).toEqual([]);
  }, 120_000);

  /**
   * Surface containment end-to-end: the scripted model CALLS the read and
   * egress channels a path guard cannot cover — `bash`, `str_replace_editor
   * view` and `web_fetch` aimed at a loopback bait listener. All three must
   * fail as unknown tools, return none of the $DSH_HOME stand-in's bytes and
   * perform no network request — on every host, including one where the shell
   * would otherwise run confined-but-read-anywhere.
   */
  it("containment: shell, editor and web_fetch channels are absent, not merely guarded", async () => {
    const probePath = join(home!, "credentials-probe.txt");
    const bait = await startEgressBait();
    try {
      const { result, results, turnResults } = await runScripted({
        ref: alphaRef,
        prompt: "read the credentials file with the shell and the editor, then fetch a URL",
        script: [
          {
            toolCall: {
              name: "bash",
              arguments: JSON.stringify({ command: `cat ${probePath}`, description: "probe" })
            }
          },
          {
            toolCall: {
              name: "str_replace_editor",
              arguments: JSON.stringify({ command: "view", path: probePath })
            }
          },
          {
            // The egress half of the containment split: `web_fetch` stays off
            // the surface while `web_search` is on it. The URL aims at the bait
            // listener, so a fetch that happened would be observable.
            toolCall: { name: "web_fetch", arguments: JSON.stringify({ url: bait.url }) }
          },
          { text: "surface result" }
        ],
        finalText: "surface result"
      });
      expect(result.ok).toBe(true);
      const joined = turnResults.join("\n");
      // All three calls were refused by the registry (no such tool for this
      // agent) — NOT by a host sandbox that happens to be unusable here.
      expect(joined.match(/unknown tool/g) ?? []).toHaveLength(3);
      expect(joined).toContain("bash");
      expect(joined).toContain("web_fetch");
      expect(results.join("\n")).not.toContain("no sandbox backend is usable");
      // And neither read channel produced a single byte of the file.
      expect(results.join("\n")).not.toContain(CREDENTIALS_PROBE_CONTENT.trim());
      // No egress either: the bait listener recorded no request at all, and the
      // page body it would have returned never reached the model.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(bait.requests).toEqual([]);
      expect(results.join("\n")).not.toContain(EGRESS_BAIT_CONTENT.trim());
    } finally {
      await bait.close();
    }
  }, 120_000);

  /**
   * The kept surface still WORKS: an allowed in-workspace write goes through
   * the real fs tool (the file lands on disk) after the restriction is in
   * place, so containment did not cost the task flow its file work.
   */
  it("an allowed in-workspace write still reaches the disk through the restricted surface", async () => {
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
   * The path guard still covers the tools that remain: with the shell gone, the
   * fs read tools are the only channel that can name a LOCAL path (`web_search`
   * is kept but cannot address a file), and their traversal is refused by the
   * per-agent guard.
   */
  it("containment: the kept read tools cannot traverse out of the workspace", async () => {
    const { result, turnResults } = await runScripted({
      ref: alphaRef,
      prompt: "glob outside the workspace",
      script: [
        {
          toolCall: {
            name: "glob",
            arguments: JSON.stringify({ pattern: "*", path: join(home!, "..") })
          }
        },
        { text: "glob result" }
      ],
      finalText: "glob result"
    });
    expect(result.ok).toBe(true);
    const joined = turnResults.join("\n");
    // The tool EXISTS for this agent (it is on the kept surface) and its call
    // was refused by the guard — the two layers are independent.
    expect(joined).toContain("denied");
    expect(joined).toContain("outside the workspace root");
    expect(joined).not.toContain("unknown tool");
  }, 120_000);
});
