import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readdir, symlink } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStubLlm } from "./helpers/stub-llm.mjs";

const execFileP = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);
const here = fileURLToPath(new URL(".", import.meta.url)); // tests/ dir
const pkgRoot = join(here, ".."); // dsh-balbes-host package root
const PROBE_GLOBAL_KEY = "__balbesRunProbeCtx__";
const CANNED_TEXT = "ok from stub";
// Relative path the first seam turn reads through the real `read` tool.
const WS_NOTES = "notes.txt";
const WS_NOTES_CONTENT = "notes content inside ws\n";
const OUTSIDE_CONTENT = "OUTSIDE-CONTENT\n";
const FAKE_AUTH_CONTENT = "FAKE-AUTH-CONTENT\n";

async function hasDsh(): Promise<boolean> {
  try {
    await execFileP("dsh", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Structural slices of the dsh core services this suite drives. Same
 * best-effort-against-public-d.ts posture as src/runner.ts: everything below
 * is read through these narrow surfaces, never through @deepseek-ai internals.
 */
interface SeamCtx {
  get(key: string): unknown;
}
interface AgentsService {
  create(opts: {
    sessionId: string;
    meta: { cwd: string };
    agentOptions: { provider: string; model: string };
    setup: (agentCtx: unknown) => void;
  }): Promise<HandleLike>;
  resume(opts: {
    resumeSessionId: string;
    agentOptions: { provider: string; model: string };
    setup: (agentCtx: unknown) => void;
  }): Promise<HandleLike>;
  list(): AgentLike[];
  get(id: string): AgentLike | undefined;
}
interface HandleLike {
  agent: AgentLike;
  dispose(): Promise<void>;
}
interface AgentLike {
  readonly id: string;
  readonly status: "idle" | "running";
  readonly session: SessionLike;
  cancel(cause: { kind: "user" | "parent" | "disposed" } | { kind: "hook"; reason: string }): void;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
}
interface SessionLike {
  readonly seq: number;
  eventAt(seq: unknown): { type: string; data: unknown } | undefined;
}
interface SessionsService {
  flush(session: SessionLike): Promise<void>;
}
interface DefaultModelService {
  currentSelection(): { provider: string; model: string };
}
interface ToolRuntimeLike {
  get(name: string, scope?: unknown): { name: string; parameters?: unknown } | undefined;
  schemas(scope?: unknown): Array<{ name: string }>;
}
interface FiberLike {
  dispose(): Promise<unknown>;
}

/** Poll a predicate until it holds or the deadline passes. */
async function waitFor(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/**
 * A stub call slice: one recorded POST with its parsed JSON body. The
 * DeepSeek adapter posts OpenAI-format chat-completions to <baseURL>/
 * chat/completions; `messages` carries the conversation each request derives
 * from the durable session.
 */
interface StubCall {
  path: string;
  body: {
    messages?: Array<{
      role?: string;
      content?: string | unknown[] | unknown;
      tool_calls?: unknown;
      tool_call_id?: unknown;
    }>;
  };
}

/** Every record of the stub is a POST /chat/completions. */
function isAgentRequest(call: StubCall): boolean {
  return call.path === "/chat/completions";
}

/** Turn summary aggregated from the owned event interval (mirror runner.ts). */
function summarize(
  session: SessionLike,
  firstSeq: number
): { text: string; reason?: { kind?: string } } {
  let text = "";
  let reason: { kind?: string } | undefined;
  let started = false;
  const length = session.seq;
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const content = (event.data as { message?: { content?: Array<{ type?: string; text?: string }> } })
        .message?.content;
      const joined = (content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") {
      reason = (event.data as { reason?: { kind?: string } }).reason;
    }
  }
  const outcome: { text: string; reason?: { kind?: string } } = { text };
  if (reason !== undefined) outcome.reason = reason;
  return outcome;
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

/** Search the whole resumed log for a literal — history-presence evidence. */
function logContains(session: SessionLike, needle: string): boolean {
  const length = session.seq;
  for (let seq = 0; seq < length; seq++) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (JSON.stringify(event).includes(needle)) return true;
  }
  return false;
}

/**
 * Boot the dsh base tree in-process (integration.test.ts recipe): base
 * patches over an empty profile cordis.yml + the runprobe probe plugin +
 * session telemetry disabled. Two extra base rows are disabled for probe
 * determinism: session-title-llm would otherwise fire an extra model request
 * (title of the first user message) that shifts the scripted stub sequence.
 * Settings (agent-default-model + llm-deepseek baseURL → the stub) are
 * written BEFORE boot, exactly like integration.test.ts.
 */
async function bootSeams(home: string, stubPort: number): Promise<{ fiber: FiberLike; ctx: SeamCtx }> {
  const { boot, healProfilesModuleFallback, loadOverlayPatches } = await import("@deepseek-ai/dsh-app-boot");
  const baseDir = dirname(requireFromHere.resolve("@deepseek-ai/dsh-base/package.json"));
  const basePatches = loadOverlayPatches("dsh", join(baseDir, "cordis.patch.yml"));
  if (!existsSync(join(home, "profiles", "node_modules", "@deepseek-ai"))) {
    // Mirror dsh's own heal of $DSH_HOME/profiles/node_modules so the
    // in-process include can resolve @deepseek-ai/* from the temp home.
    const dshPkgDir = dirname(realpathSync(requireFromHere.resolve("@deepseek-ai/dsh/package.json")));
    await healProfilesModuleFallback({ installAnchor: join(dshPkgDir, "package.json"), home });
  }
  await writeFile(
    join(home, "settings.yaml"),
    `agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nllm-deepseek:\n  baseURL: http://127.0.0.1:${stubPort}\n`
  );
  process.env.DSH_HOME = home;
  process.env.DEEPSEEK_API_KEY = "test-key";
  const booted = await boot("dsh", join(home, "profiles", "balbes-min", "cordis.yml"), [
    ...basePatches,
    { insert: [{ id: "balbes-runprobe", name: join(here, "helpers", "runprobe.mjs") }] },
    { id: "session-telemetry-otel", disabled: true },
    { id: "session-title-llm", disabled: true }
  ]);
  const probeCtx = globalThis[PROBE_GLOBAL_KEY as keyof typeof globalThis] as SeamCtx | undefined;
  if (probeCtx === undefined) throw new Error("runprobe plugin did not publish its context");
  return { fiber: booted.fiber as FiberLike, ctx: probeCtx };
}

/** Prepare one fresh temp $DSH_HOME with an empty base profile. */
async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "balbes-seams-"));
  const minDir = join(home, "profiles", "balbes-min");
  await mkdir(minDir, { recursive: true });
  await mkdir(join(home, "profiles", "node_modules"), { recursive: true });
  await writeFile(join(minDir, "cordis.yml"), "# in-process REAL seams probe root\n[]\n");
  return home;
}

/**
 * Create one agent (fresh session, meta.cwd = workspace) and drive exactly
 * one scripted turn through the real agent loop: followup → whenIdle →
 * sessions.flush, then dispose the owned handle. Returns the turn summary,
 * the calls the stub recorded for THIS turn, and the agent seq at turn start
 * (callers asserting resume-history semantics compare against it).
 */
async function runTurn(
  ctx: SeamCtx,
  stub: { calls: StubCall[]; setScript(entries: unknown[] | undefined): void },
  opts: {
    sessionId: string;
    metaCwd: string;
    script: Array<{ text?: string; toolCall?: { name: string; arguments: string } }>;
    prompt?: string;
    selection?: { provider: string; model: string };
  }
): Promise<{ text: string; reason?: { kind?: string }; calls: StubCall[]; startSeq: number }> {
  const agents = ctx.get("agents") as AgentsService | undefined;
  const sessions = ctx.get("sessions") as SessionsService | undefined;
  const defaultModel = ctx.get("agentDefaultModel") as DefaultModelService | undefined;
  if (agents === undefined || sessions === undefined || defaultModel === undefined) {
    throw new Error("agent core services missing on probe context");
  }
  const { brandString } = await import("@deepseek-ai/dsh-brand");
  const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
  const selection = opts.selection ?? defaultModel.currentSelection();
  const callsBefore = stub.calls.length;
  stub.setScript(opts.script);
  const handle = await agents.create({
    sessionId: brandString(opts.sessionId),
    meta: { cwd: opts.metaCwd },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: () => {}
  });
  try {
    const agent = handle.agent;
    await agent.whenIdle();
    const startSeq = agent.session.seq;
    agent.followup(
      createUserMessage({
        content: [{ type: "text", text: opts.prompt ?? "please do it" }],
        source: { kind: "user" }
      }) as never
    );
    await agent.whenIdle();
    await sessions.flush(agent.session);
    const summary = summarize(agent.session, startSeq);
    return { ...summary, calls: stub.calls.slice(callsBefore), startSeq };
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

// Gate: this suite exercises a real dsh base boot with real agent loops and
// real tool execution against a stub endpoint. It runs only when the plan's
// RUN_REAL=1 switch is set AND a dsh executable is available (otherwise skip).
const runReal = (process.env.RUN_REAL ?? "").trim() !== "";
const realEnabled = runReal ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL seams probe: session cwd, fs tool containment, tool surface", () => {
  let stub: { port: number; calls: StubCall[]; setScript(entries: unknown[] | undefined): void; close(): void } | undefined;
  let home: string | undefined;
  let ws: string;
  let booted: { fiber: FiberLike; ctx: SeamCtx } | undefined;
  let previousHome: string | undefined;
  let previousKey: string | undefined;

  beforeAll(async () => {
    previousHome = process.env.DSH_HOME;
    previousKey = process.env.DEEPSEEK_API_KEY;
    home = await makeHome();
    ws = join(home, "ws");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, WS_NOTES), WS_NOTES_CONTENT);
    await writeFile(join(home, "outside.txt"), OUTSIDE_CONTENT);
    // A stand-in for the real credential document (admin-auth.json): the
    // probe writes its own FAKE content — never a real secret — and checks
    // whether the model-facing read tool can reach it by absolute path.
    await writeFile(join(home, "admin-auth.json"), FAKE_AUTH_CONTENT);
    // Symlink escapes: one absolute target (/etc/hosts — present on macOS
    // and Linux) and one relative ../ target back out of ws.
    await symlink("/etc/hosts", join(ws, "link.txt"));
    await symlink(join(home, "outside.txt"), join(ws, "link2.txt"));
    stub = await startStubLlm({ text: CANNED_TEXT });
    booted = await bootSeams(home, stub.port);
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

  it("registry agent exposes the fs read/write/edit and bash tools", async () => {
    const agents = booted!.ctx.get("agents") as AgentsService;
    const tools = booted!.ctx.get("tools") as ToolRuntimeLike;
    const defaultModel = booted!.ctx.get("agentDefaultModel") as DefaultModelService;
    const { brandString } = await import("@deepseek-ai/dsh-brand");
    const selection = defaultModel.currentSelection();
    const handle = await agents.create({
      sessionId: brandString("session-seam-tool-dump"),
      meta: { cwd: ws },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: () => {}
    });
    try {
      const agent = handle.agent;
      // dsh 0.1.2-rc.1 seam fact: a registry-created agent inherits the whole
      // base-tool registry (registrations live on the root scope; no preset
      // layer narrows them in the headless boot). Observed agent-visible
      // surface: job_output, job_list, job_kill, glob, grep, skill,
      // web_search, web_fetch, exit_plan_mode, todo_write, send_message,
      // interrupt_agent, list_agents, get_goal, create_goal, update_goal,
      // bash, read, write, edit, str_replace_editor, workflow, ralph,
      // subagent, subagent_fork, read_image.
      const names = tools.schemas(agent).map((schema) => schema.name);
      expect(names).toContain("read");
      expect(names).toContain("write");
      expect(names).toContain("edit");
      expect(names).toContain("bash");
      for (const wanted of ["read", "write", "edit", "bash"]) {
        const def = tools.get(wanted, agent);
        expect(def, `tools.get(${wanted}, agent) resolved`).toBeDefined();
      }
      // The fs read tool's model-facing argument is file_path (the
      // @deepseek-ai/dsh-tool-fs schema), resolved by the filesystem backend.
      const readDef = tools.get("read", agent);
      const readArgs = (readDef?.parameters ?? {}) as { properties?: Record<string, unknown> };
      expect(Object.keys(readArgs.properties ?? {})).toContain("file_path");
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }, 120_000);

  it("session cwd: a relative read resolves under meta.cwd and the tool result reaches the model", async () => {
    const result = await runTurn(booted!.ctx, stub!, {
      sessionId: "session-seam-read-ok",
      metaCwd: ws,
      script: [
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: WS_NOTES }) } },
        { text: "read ok" }
      ]
    });
    // dsh 0.1.2-rc.1 seam fact: agents.create({ meta: { cwd } }) seeds the
    // session header cwd; the fs tools resolve relative paths against it
    // (@deepseek-ai/dsh-tool-fs/session-cwd reads exec.agent.session.header.cwd).
    expect(result.reason?.kind).toBe("completed");
    expect(result.text).toBe("read ok");
    // The script drove TWO model requests; the second one carries the real
    // tool result back as an OpenAI role "tool" message — proof the tool
    // executed inside the agent, not in the stub.
    expect(result.calls.length).toBeGreaterThanOrEqual(2);
    const results = toolResults(result.calls);
    expect(results.length).toBeGreaterThan(0);
    expect(results.join("\n")).toContain(WS_NOTES_CONTENT.trim());
  }, 120_000);

  it("containment: fs read ../ traversal escapes the session workspace", async () => {
    const result = await runTurn(booted!.ctx, stub!, {
      sessionId: "session-seam-dotdot",
      metaCwd: ws,
      script: [
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: "../outside.txt" }) } },
        { text: "dotdot result" }
      ]
    });
    // dsh 0.1.2-rc.1 seam fact: the read tool resolves ../ against the SESSION
    // cwd and follows it — reading <home>/outside.txt (outside ws) succeeds.
    // meta.cwd seeds path resolution, NOT read containment: the fs sandbox
    // fences only the mutating tools (see the absolute-write probe below),
    // reads pass through in every mode.
    expect(result.reason?.kind).toBe("completed");
    const results = toolResults(result.calls);
    expect(results.join("\n")).toContain(OUTSIDE_CONTENT.trim());
  }, 120_000);

  it("containment: fs read of an absolute system path is not denied", async () => {
    const result = await runTurn(booted!.ctx, stub!, {
      sessionId: "session-seam-abs",
      metaCwd: ws,
      script: [
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: "/etc/hosts" }) } },
        { text: "abs result" }
      ]
    });
    // dsh 0.1.2-rc.1 seam fact: absolute reads are NOT fenced — /etc/hosts
    // (any host-readable path) is returned verbatim. fs-sandbox's per-call
    // policy fence covers the two mutations only ("every mode permits
    // reading"). Any workspace-root read policy must be layered on in the
    // agent setup (Task 7 composeAgentSetup guard), never assumed from dsh.
    expect(result.reason?.kind).toBe("completed");
    const results = toolResults(result.calls);
    expect(results.join("\n")).toContain("localhost");
  }, 120_000);

  it("containment: fs read reaches $DSH_HOME/admin-auth.json by absolute path", async () => {
    const result = await runTurn(booted!.ctx, stub!, {
      sessionId: "session-seam-auth",
      metaCwd: ws,
      script: [
        {
          toolCall: {
            name: "read",
            arguments: JSON.stringify({ file_path: join(home!, "admin-auth.json") })
          }
        },
        { text: "auth result" }
      ]
    });
    // dsh 0.1.2-rc.1 seam fact: absolute-path reads reach secret-adjacent
    // files under $DSH_HOME (here a FAKE admin-auth.json stand-in). Contained
    // only by OS read permissions of the server process — the session
    // workspace provides no read boundary.
    expect(result.reason?.kind).toBe("completed");
    const results = toolResults(result.calls);
    expect(results.join("\n")).toContain(FAKE_AUTH_CONTENT.trim());
  }, 120_000);

  it("containment: fs read follows symlinks out of the workspace", async () => {
    // link.txt -> /etc/hosts (absolute target)
    const absLink = await runTurn(booted!.ctx, stub!, {
      sessionId: "session-seam-symlink",
      metaCwd: ws,
      script: [
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: "link.txt" }) } },
        { text: "symlink result" }
      ]
    });
    // link2.txt -> <home>/outside.txt (relative target out of ws)
    const relLink = await runTurn(booted!.ctx, stub!, {
      sessionId: "session-seam-symlink2",
      metaCwd: ws,
      script: [
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: "link2.txt" }) } },
        { text: "symlink2 result" }
      ]
    });
    // dsh 0.1.2-rc.1 seam fact: read does not pin symlinks inside the
    // workspace — an in-ws symlink whose target is /etc/hosts (or ../outside)
    // is followed and its content returned. The model sees the content; the
    // path envelope still renders the requested in-ws spelling.
    expect(absLink.reason?.kind).toBe("completed");
    expect(relLink.reason?.kind).toBe("completed");
    const absResults = toolResults(absLink.calls);
    expect(absResults.join("\n")).toContain("localhost");
    const relResults = toolResults(relLink.calls);
    expect(relResults.join("\n")).toContain(OUTSIDE_CONTENT.trim());
  }, 120_000);

  it("containment: bash containment is platform-dependent — confined-but-read-anywhere, or fail closed", async () => {
    const result = await runTurn(booted!.ctx, stub!, {
      sessionId: "session-seam-bash",
      metaCwd: ws,
      script: [
        {
          toolCall: {
            name: "bash",
            arguments: JSON.stringify({ command: "cat /etc/hosts; cd .. && pwd", description: "probe" })
          }
        },
        { text: "bash result" }
      ]
    });
    // dsh 0.1.2-rc.1 seam fact: the SHELL has no workspace-root read boundary,
    // and whether the command runs at all depends on the HOST, not on this
    // deployment. The tool is policy-rooted, never session-cwd-rooted:
    // - On a host without a usable sandbox backend (this macOS dev host: the
    //   Seatbelt sandbox-exec backend cannot start inside an already-sandboxed
    //   vitest process) the tool REFUSES to run — "no sandbox backend is
    //   usable on this host" — and no host content reaches the model.
    // - On a host WITH a usable backend (the Linux VPS: Landlock/bwrap mounted
    //   with `readOnly: ["/"]`) the command runs, writes are fenced to the
    //   writable roots, and READS ANYWHERE PASS — so `cat /etc/hosts` returns
    //   its content and `cd ..` renders a directory outside the session
    //   workspace. That is not escapable by configuration.
    // Both outcomes are asserted below and exactly one must hold, so the suite
    // stays honest on either platform instead of pinning this host's accident
    // (a Linux-only branch cannot be exercised from macOS; no platform skip).
    // This is precisely why the Telegram channel does not rely on the shell
    // policy at all: it REMOVES `bash` (and every other read-capable channel)
    // from the agent's tool surface in composeAgentSetup, which is the only
    // boundary that holds on both kinds of host.
    expect(result.reason?.kind).toBe("completed");
    const joined = toolResults(result.calls).join("\n");
    const failedClosed = joined.includes("no sandbox backend is usable");
    const ranConfined = joined.includes("localhost");
    expect(
      failedClosed || ranConfined,
      `bash neither failed closed nor ran: ${joined.slice(0, 500)}`
    ).toBe(true);
    expect(failedClosed && ranConfined, "the two bash outcomes are mutually exclusive").toBe(false);
    if (failedClosed) {
      // Never a leak on this host: the shell produced no host content at all.
      expect(joined).not.toContain("localhost");
    } else {
      // Reads pass under the sandbox policy: the host's /etc/hosts came back and
      // the shell reached the parent directory of the session workspace.
      expect(joined).toContain("localhost");
      expect(joined).toContain(basename(home!));
    }
  }, 120_000);

  it("containment: writes are fenced to the session cwd + platform temp areas", async () => {
    // Inside ws: allowed.
    const inside = await runTurn(booted!.ctx, stub!, {
      sessionId: "session-seam-write-in",
      metaCwd: ws,
      script: [
        {
          toolCall: {
            name: "write",
            arguments: JSON.stringify({ file_path: "inside.txt", content: "inside" })
          }
        },
        { text: "write-in result" }
      ]
    });
    expect(inside.reason?.kind).toBe("completed");
    expect(existsSync(join(ws, "inside.txt"))).toBe(true);

    // ../ out of ws but into <home> — home lives under os.tmpdir() and the
    // platform temp area is a writable root, so this write SUCCEEDS even
    // though it escapes the session workspace.
    const relOut = await runTurn(booted!.ctx, stub!, {
      sessionId: "session-seam-write-out",
      metaCwd: ws,
      script: [
        {
          toolCall: {
            name: "write",
            arguments: JSON.stringify({ file_path: "../pwned.txt", content: "pwned" })
          }
        },
        { text: "write-out result" }
      ]
    });
    expect(relOut.reason?.kind).toBe("completed");
    expect(existsSync(join(home!, "pwned.txt"))).toBe(true);

    // Absolute write outside ws AND outside the temp area: denied with the
    // shared [sandbox: ...] marker; the file must not exist afterwards.
    const { randomUUID } = await import("node:crypto");
    const target = join(pkgRoot, `.seams-write-target-${randomUUID()}.txt`);
    const absOut = await runTurn(booted!.ctx, stub!, {
      sessionId: "session-seam-write-abs",
      metaCwd: ws,
      script: [
        {
          toolCall: {
            name: "write",
            arguments: JSON.stringify({ file_path: target, content: "abs" })
          }
        },
        { text: "write-abs result" }
      ]
    });
    expect(absOut.reason?.kind).toBe("completed");
    const results = toolResults(absOut.calls);
    expect(results.join("\n")).toContain("[sandbox: file access denied under workspace-write mode]");
    expect(existsSync(target)).toBe(false);
    // dsh 0.1.2-rc.1 seam fact: the mutating tools carry a per-session policy
    // whose workspace root is the calling session's cwd (meta.cwd) plus the
    // platform temp writable roots — writes outside both are denied and offer
    // the sandbox_permissions escalation. Reads have no such fence.
    await rm(join(home!, "pwned.txt"), { force: true }).catch(() => undefined);
  }, 180_000);

  it("graceful cancellation: Agent.cancel(cause) converges whenIdle and keeps the agent", async () => {
    const agents = booted!.ctx.get("agents") as AgentsService;
    const defaultModel = booted!.ctx.get("agentDefaultModel") as DefaultModelService;
    const { brandString } = await import("@deepseek-ai/dsh-brand");
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    const selection = defaultModel.currentSelection();
    // A slow stub response keeps the agent mid-request so the cancel path is
    // exercised while the loop is genuinely busy.
    stub!.setDelay(800);
    stub!.setScript([{ text: CANNED_TEXT }]);
    const handle = await agents.create({
      sessionId: brandString("session-seam-cancel-1"),
      meta: { cwd: ws },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: () => {}
    });
    try {
      const agent = handle.agent;
      await agent.whenIdle();
      const callsBefore = stub!.calls.length;
      agent.followup(
        createUserMessage({ content: [{ type: "text", text: "slow turn" }], source: { kind: "user" } }) as never
      );
      await waitFor(() => stub!.calls.length > callsBefore);
      expect(agent.status).toBe("running");
      const started = Date.now();
      // dsh 0.1.2-rc.1 seam fact: Agent.cancel({ kind: "user" }) aborts the
      // active turn's in-flight request; whenIdle() converges without waiting
      // for the (delayed) provider response, and the agent STAYS registered —
      // cancel is a turn-level abort, not teardown.
      agent.cancel({ kind: "user" });
      await agent.whenIdle();
      expect(Date.now() - started).toBeLessThan(500);
      expect(agent.status).toBe("idle");
      expect(agents.get(agent.id)).toBe(agent);
      // The same agent takes a follow-up turn afterwards.
      stub!.setScript([{ text: "after cancel" }]);
      agent.followup(
        createUserMessage({ content: [{ type: "text", text: "next turn" }], source: { kind: "user" } }) as never
      );
      await agent.whenIdle();
      expect(agents.get(agent.id)).toBe(agent);
    } finally {
      stub!.setDelay(0);
      // Let any still-pending delayed response settle so its late write does
      // not race the next turn (the stub cursor is reset per runTurn anyway).
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await handle.dispose().catch(() => undefined);
    }
  }, 120_000);

  it("dispose on a busy agent stops the loop and unregisters immediately", async () => {
    const agents = booted!.ctx.get("agents") as AgentsService;
    const defaultModel = booted!.ctx.get("agentDefaultModel") as DefaultModelService;
    const { brandString } = await import("@deepseek-ai/dsh-brand");
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    const selection = defaultModel.currentSelection();
    stub!.setDelay(2000);
    stub!.setScript([{ text: CANNED_TEXT }]);
    const handle = await agents.create({
      sessionId: brandString("session-seam-dispose-busy"),
      meta: { cwd: ws },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: () => {}
    });
    try {
      const agent = handle.agent;
      await agent.whenIdle();
      const callsBefore = stub!.calls.length;
      agent.followup(
        createUserMessage({ content: [{ type: "text", text: "busy turn" }], source: { kind: "user" } }) as never
      );
      await waitFor(() => stub!.calls.length > callsBefore);
      expect(agent.status).toBe("running");
      const started = Date.now();
      // dsh 0.1.2-rc.1 seam fact: handle.dispose() on a busy agent stops the
      // driver loop (aborting the in-flight request), unregisters the agent
      // and removes its session — it does NOT wait out the delayed provider
      // response. This is the teardown a "reset context" needs.
      await handle.dispose();
      expect(Date.now() - started).toBeLessThan(500);
      expect(agents.get(agent.id)).toBeUndefined();
      expect(agents.list().map((entry) => entry.id)).not.toContain(agent.id);
    } finally {
      stub!.setDelay(0);
      await new Promise((resolve) => setTimeout(resolve, 2200));
    }
  }, 120_000);
});

describe.skipIf(!realEnabled)("REAL seams probe: persisted session, resume after restart, dispose semantics", () => {
  let stub: { port: number; calls: StubCall[]; setScript(entries: unknown[] | undefined): void; close(): void } | undefined;
  let home: string | undefined;
  let ws: string;
  let booted: { fiber: FiberLike; ctx: SeamCtx } | undefined;
  let previousHome: string | undefined;
  let previousKey: string | undefined;
  const sessionIdRaw = "session-seam-resume-1";
  const FIRST_TURN_PROMPT = "Reply with exactly: ok from stub";

  beforeAll(async () => {
    previousHome = process.env.DSH_HOME;
    previousKey = process.env.DEEPSEEK_API_KEY;
    home = await makeHome();
    ws = join(home, "ws");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, WS_NOTES), WS_NOTES_CONTENT);
    stub = await startStubLlm({ text: CANNED_TEXT });
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

  async function coreCtx(): Promise<{
    agents: AgentsService;
    sessions: SessionsService;
    defaultModel: DefaultModelService;
    selection: { provider: string; model: string };
  }> {
    const agents = booted!.ctx.get("agents") as AgentsService;
    const sessions = booted!.ctx.get("sessions") as SessionsService;
    const defaultModel = booted!.ctx.get("agentDefaultModel") as DefaultModelService;
    return { agents, sessions, defaultModel, selection: defaultModel.currentSelection() };
  }

  it("double boot: flush persists under $DSH_HOME/sessions, dispose keeps the file, resume sees the history", async () => {
    const { brandString } = await import("@deepseek-ai/dsh-brand");
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    const sessionId = brandString(sessionIdRaw);

    // ---- boot #1: create the agent, run one turn, flush ----
    booted = await bootSeams(home!, stub!.port);
    const first = await coreCtx();
    stub!.setScript([{ text: CANNED_TEXT }]);
    const handle1 = await first.agents.create({
      sessionId,
      meta: { cwd: ws },
      agentOptions: { provider: first.selection.provider, model: first.selection.model },
      setup: () => {}
    });
    const agent1 = handle1.agent;
    const firstSeq = agent1.session.seq;
    await agent1.whenIdle();
    agent1.followup(
      createUserMessage({ content: [{ type: "text", text: FIRST_TURN_PROMPT }], source: { kind: "user" } }) as never
    );
    await agent1.whenIdle();
    await first.sessions.flush(agent1.session);
    const summary1 = summarize(agent1.session, firstSeq);
    expect(summary1.text).toBe(CANNED_TEXT);
    const seqAfterTurn1 = agent1.session.seq;
    expect(seqAfterTurn1).toBeGreaterThan(firstSeq);

    // ---- persisted file: $DSH_HOME/sessions/<cwd-key>/<session-id>/*.jsonl ----
    // dsh 0.1.2-rc.1 seam fact: session-persistence-jsonl stores one session
    // directory per (cwd, sessionId) under the configured root (base row
    // root = dshHomePath('sessions')) and the directory key is derived from
    // the session's header cwd; the log is zstd-compressed by default
    // (session.jsonl.zstd).
    const sessionsRoot = join(home!, "sessions");
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else files.push(path);
      }
    }
    await walk(sessionsRoot);
    const logFile = files.find((path) => path.includes(sessionId) && /session\.jsonl(\.zstd)?$/.test(path));
    expect(logFile, `persisted log exists for ${sessionId} under ${sessionsRoot}`).toBeDefined();

    // ---- handle.dispose() on the live agent ----
    await handle1.dispose();
    const { agents: liveAgents } = await coreCtx();
    expect(liveAgents.list().map((agent) => agent.id)).not.toContain(sessionId);
    // dsh 0.1.2-rc.1 seam fact: dispose() unregisters the agent and removes
    // its in-memory session but does NOT delete the durable file — the
    // session survives on disk for agents.resume. A context-reset flow must
    // additionally clear its own sessionId mapping; the durable file stays
    // unless a deployment removes it.
    expect(existsSync(logFile!)).toBe(true);

    // ---- full fiber dispose = process restart in miniature ----
    await booted!.fiber.dispose().catch(() => undefined);
    delete globalThis[PROBE_GLOBAL_KEY as keyof typeof globalThis];
    booted = await bootSeams(home!, stub!.port);
    const second = await coreCtx();
    expect(second.agents.list()).toEqual([]);

    // ---- boot #2: agents.resume on the persisted session ----
    stub!.setScript([{ text: CANNED_TEXT }]);
    const handle2 = await second.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: second.selection.provider, model: second.selection.model },
      setup: () => {}
    });
    const agent2 = handle2.agent;
    // dsh 0.1.2-rc.1 seam fact: agents.resume({ resumeSessionId, ... })
    // loads the persisted session and its header cwd; the loaded log already
    // covers the first turn (seq >= seqAfterTurn1) BEFORE any new turn.
    expect(agent2.session.seq).toBeGreaterThanOrEqual(seqAfterTurn1);
    expect(logContains(agent2.session, FIRST_TURN_PROMPT)).toBe(true);
    expect(logContains(agent2.session, CANNED_TEXT)).toBe(true);
    await agent2.whenIdle();
    const beforeTurn2 = agent2.session.seq;
    agent2.followup(
      createUserMessage({ content: [{ type: "text", text: "Second turn after restart" }], source: { kind: "user" } }) as never
    );
    await agent2.whenIdle();
    await second.sessions.flush(agent2.session);
    const summary2 = summarize(agent2.session, beforeTurn2);
    expect(summary2.text).toBe(CANNED_TEXT);
    expect(agent2.session.seq).toBeGreaterThan(beforeTurn2);

    // The resumed session still resolves relative fs reads against the ORIGINAL
    // ws (the durable header cwd, not the process cwd).
    stub!.setScript([
      { toolCall: { name: "read", arguments: JSON.stringify({ file_path: WS_NOTES }) } },
      { text: "read ok" }
    ]);
    const callsBeforeRead = stub!.calls.length;
    agent2.followup(
      createUserMessage({ content: [{ type: "text", text: "read notes again" }], source: { kind: "user" } }) as never
    );
    await agent2.whenIdle();
    const readCalls = stub!.calls.slice(callsBeforeRead);
    const readResults = toolResults(readCalls);
    expect(readResults.join("\n")).toContain(WS_NOTES_CONTENT.trim());

    await handle2.dispose();
    const final = await coreCtx();
    expect(final.agents.list().map((agent) => agent.id)).not.toContain(sessionId);
  }, 400_000);
});
