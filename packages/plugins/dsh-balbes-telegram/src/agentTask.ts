import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";

/**
 * Workspace-aware runner of the stock dsh agent loop with one persistent
 * session per workspace (the task surface of the Telegram channel).
 *
 * Per key the runner keeps exactly one live AgentHandle (created on first
 * use, resumed from a caller-supplied sessionId after a restart) and
 * serializes turns FIFO: one active task per workspace, up to {@link
 * QUEUE_MAX_WAITING} waiting tasks, everything else refused. Sessions are
 * flushed after every successful turn so a restart can resume them.
 *
 * The dsh Agent/agents/sessions seams are consumed structurally (same
 * best-effort-against-public-d.ts posture as
 * packages/bundles/dsh-balbes-host/src/runner.ts); nothing from
 * @deepseek-ai/* is patched or imported beyond these entry helpers.
 */

export type WorkspaceRef = { scope: "home" } | { scope: "project"; name: string };

/** The state-mapping key for one workspace ("home" | "project:<name>"). */
export function workspaceRefKey(ref: WorkspaceRef): string {
  return ref.scope === "home" ? "home" : `project:${ref.name}`;
}

export type TaskResult =
  | { ok: true; text: string; sessionId: string }
  | { ok: false; code: "workspace-gone" | "agent-error" | "queue-full" | "busy"; message: string };

export interface AgentTaskRunner {
  run(ref: WorkspaceRef, text: string, opts?: { sessionId?: string }): Promise<TaskResult>;
  reset(ref: WorkspaceRef): Promise<void>;
  sessionIdOf(ref: WorkspaceRef): string | undefined;
  /** Live session mapping, for persisting across restarts (tasks 8/11). */
  snapshot(): Array<{ key: string; sessionId: string }>;
}

export interface AgentTaskDeps {
  loader?: { await(): Promise<void> };
  /** Structural slices of the dsh agent services (see runner.ts + Task 1 facts). */
  agents: {
    create(o: unknown): Promise<AgentHandleLike>;
    resume(o: {
      resumeSessionId: string;
      agentOptions: { provider: string; model: string };
      setup: (c: unknown) => void;
    }): Promise<AgentHandleLike>;
  };
  sessions: { flush(session: unknown): Promise<void> };
  defaultModel?: { currentSelection(): { provider: string; model: string } };
  /** The Task 4 workspaces service slice; only root() is consumed by the runner. */
  workspaces: BalbesWorkspacesService;
  logger?: { warn(m: string): void };
}

/**
 * Structural slice of the Task 4 `BalbesWorkspacesService`
 * (packages/plugins/dsh-balbes-workspaces/src/service.ts). The telegram
 * package never imports the workspace plugin (the profile composes both); the
 * runner needs only root resolution, which throws `WorkspaceError` when the
 * referenced workspace cannot be resolved.
 */
interface BalbesWorkspacesService {
  list(): Promise<unknown>;
  root(scope: "home" | "project", name: string | undefined): Promise<string>;
  readDir(...args: unknown[]): Promise<unknown>;
  readFile(...args: unknown[]): Promise<unknown>;
}

/** How many tasks may wait (not run) per workspace. */
const QUEUE_MAX_WAITING = 3;
const BUSY_MESSAGE = "a task for this workspace is already running";
const QUEUE_FULL_MESSAGE = `the workspace task queue is full (${QUEUE_MAX_WAITING} waiting tasks max)`;
const AGENT_ERROR_MESSAGE = "agent task failed";
const RESET_DROP_MESSAGE = "task dropped because the workspace context was reset";

interface SessionEventLike {
  type: string;
  data: {
    message?: { content?: Array<{ type: string; text?: string }> };
    reason?: unknown;
  };
}

/** Structural slice of the Agent returned by the agents registry (see runner.ts). */
interface AgentLike {
  whenIdle(): Promise<void>;
  followup(message: unknown): void;
  session: {
    seq: number;
    eventAt(seq: unknown): SessionEventLike | undefined;
  };
}

/**
 * The owned handle `agents.create`/`agents.resume` resolve to
 * (`@deepseek-ai/dsh-agent` AgentHandle). `dispose()` stops the agent loop,
 * unregisters the agent and removes its session — the teardown a context
 * reset needs (Task 1 fact 9). Handles live in the per-key cache between
 * turns and are disposed only on reset or when a turn fails at driver level.
 */
interface AgentHandleLike {
  agent: AgentLike;
  dispose(): Promise<void>;
}

/** One accepted-but-waiting run for a key. */
interface PendingTask {
  ref: WorkspaceRef;
  text: string;
  opts: { sessionId?: string } | undefined;
  resolve(result: TaskResult): void;
}

interface KeyedEntry {
  handle: AgentHandleLike | undefined;
  sessionId: string | undefined;
  busy: boolean;
  /** The text of the task currently being executed (for dedupe). */
  activeText: string | undefined;
  queue: PendingTask[];
}

function errorMessage(error: unknown, fallback = "unknown error"): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return typeof error === "string" && error !== "" ? error : fallback;
}

/**
 * Aggregate the owned event interval of one turn. Logic copied from
 * packages/bundles/dsh-balbes-host/src/runner.ts (`runPrompt`), which mirrors
 * @deepseek-ai/dsh-headless/lib/index.js minus its stdout/stderr stream and
 * process exit.
 */
interface TurnOutcome {
  text: string;
  reason?: { kind: string; code?: string; message?: string };
}

function summarizeTurn(session: AgentLike["session"], firstSeq: number): TurnOutcome {
  let started = false;
  let text = "";
  let reason: { kind: string; code?: string; message?: string } | undefined;
  const length = session.seq;
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data.message?.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") {
      const r = event.data.reason as
        | { kind: string; error?: { code?: string; message?: string } }
        | undefined;
      if (r?.kind === "error") {
        const detail: { kind: string; code?: string; message?: string } = { kind: "error" };
        if (r.error?.code !== undefined) detail.code = r.error.code;
        if (r.error?.message !== undefined) detail.message = r.error.message;
        reason = detail;
      } else {
        reason = { kind: r?.kind ?? "completed" };
      }
    }
  }
  const outcome: TurnOutcome = { text };
  if (reason !== undefined) outcome.reason = reason;
  return outcome;
}

/**
 * Compose the agent-scoped setup every task session receives (create and
 * resume): the model-selection wiring (mirrors runner.ts) plus the
 * read-containment guard.
 *
 * dsh 0.1.2-rc.1 seam fact (Task 1 facts 3/4/5): a registry-created agent can
 * read OUTSIDE its workspace root — `../` traversal, absolute paths, and
 * symlink escapes all reach the model (fs-sandbox fences only mutations;
 * "every mode permits reading"). composeAgentSetup therefore registers a
 * per-agent `tools.guard` through the agent's own scope context that denies
 * model-facing fs reads whose resolved path leaves the workspace root. The
 * guard keeps the read/write/edit surface intact for in-workspace work (Task
 * 12's task flow still reads notes.txt inside the project) while the model
 * never receives bytes from outside.
 */
export interface AgentSetupOptions {
  /** The workspace root the session cwd resolves under (meta.cwd seed). */
  root: string;
  /** The model selection captured from agentDefaultModel at create/resume. */
  selection: { provider: string; model: string };
}

/** Model-facing tools whose string path argument must stay inside the root. */
const READ_PATH_ARG_BY_TOOL: Record<string, string> = {
  read: "file_path",
  read_image: "file_path",
  glob: "path",
  grep: "path"
};

/** A path-taking tool execution as the registry guard sees it. */
interface GuardExecLike {
  name: string;
  arguments: unknown;
  agent?: { session?: { header?: { cwd?: string } } };
}

/**
 * A per-root containment check that never throws (a guard that throws would
 * break every tool call). Reports whether the requested path leaves the
 * workspace root — lexically (absolute paths, `..` traversal, including
 * not-yet-existing write targets) or by realpath (in-root symlink escapes).
 * A target that cannot be stat'ed is reported as contained: the underlying
 * tool answers "not found", so no bytes leak either way.
 */
function rootEscapes(root: string): (requested: string) => boolean {
  const lexicalRoot = resolve(root);
  const lexicalPrefix = lexicalRoot === sep ? sep : lexicalRoot + sep;
  let realRoot: string;
  let realPrefix: string;
  try {
    realRoot = realpathSync(lexicalRoot);
    realPrefix = realRoot === sep ? sep : realRoot + sep;
  } catch {
    // Root does not exist (deleted workspace): degrade to the lexical root,
    // which still rejects any read that escapes the workspace path shape.
    realRoot = lexicalRoot;
    realPrefix = lexicalPrefix;
  }
  return (requested) => {
    const target = resolve(lexicalRoot, requested);
    if (target !== lexicalRoot && !target.startsWith(lexicalPrefix)) return true;
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      return false;
    }
    return !(real === realRoot || real.startsWith(realPrefix));
  };
}

export function composeAgentSetup(agentCtx: unknown, options: AgentSetupOptions): void {
  installModelSelection(agentCtx as never, { current: options.selection, assembled: undefined });
  const tools = (agentCtx as { get(key: string): unknown }).get("tools") as
    | { guard(guard: (exec: GuardExecLike) => string | undefined): unknown }
    | undefined;
  if (tools === undefined) return;
  const escapes = rootEscapes(options.root);
  tools.guard((exec) => {
    const argName = READ_PATH_ARG_BY_TOOL[exec.name];
    if (argName === undefined) return undefined;
    const raw = (exec.arguments as Record<string, unknown> | undefined)?.[argName];
    if (typeof raw !== "string" || raw === "") return undefined;
    // A rejected call surfaces to the model as "Error: <reason>": a denial,
    // never the file bytes. The message names the tool and the requested path
    // only — no absolute host path, no stack.
    if (!escapes(raw)) return undefined;
    return `${exec.name} denied: path ${JSON.stringify(raw)} is outside the workspace root of this session`;
  });
}

export function createAgentTaskRunner(deps: AgentTaskDeps): AgentTaskRunner {
  const cache = new Map<string, KeyedEntry>();

  async function acquireHandle(
    root: string,
    opts: { sessionId?: string } | undefined
  ): Promise<{ handle: AgentHandleLike; sessionId: string }> {
    const selection = deps.defaultModel?.currentSelection() ?? { provider: "", model: "" };
    const setup = (agentCtx: unknown): void => {
      composeAgentSetup(agentCtx, { root, selection });
    };
    if (opts?.sessionId !== undefined) {
      try {
        const handle = await deps.agents.resume({
          resumeSessionId: opts.sessionId,
          agentOptions: selection,
          setup
        });
        return { handle, sessionId: opts.sessionId };
      } catch (error) {
        // Session missing/corrupt on disk: warn and fall back to a fresh
        // session; the mapping is reset so the plugin repersists the new id.
        deps.logger?.warn(
          `dsh-balbes-telegram: resuming session "${opts.sessionId}" failed; creating a fresh session: ${errorMessage(error)}`
        );
      }
    }
    const sessionId = brandString(`session-${randomUUID()}`);
    const handle = await deps.agents.create({
      sessionId,
      meta: { cwd: root },
      agentOptions: selection,
      setup
    });
    return { handle, sessionId };
  }

  /** One serialized turn: root check, handle acquisition, followup, flush. */
  async function executeTurn(
    entry: KeyedEntry,
    ref: WorkspaceRef,
    text: string,
    opts: { sessionId?: string } | undefined
  ): Promise<TaskResult> {
    let root: string;
    try {
      root = await deps.workspaces.root(
        ref.scope === "home" ? "home" : "project",
        ref.scope === "project" ? ref.name : undefined
      );
    } catch (error) {
      return { ok: false, code: "workspace-gone", message: errorMessage(error, "workspace is unavailable") };
    }
    let handle: AgentHandleLike;
    let sessionId: string | undefined;
    try {
      if (entry.handle === undefined) {
        const acquired = await acquireHandle(root, opts);
        handle = acquired.handle;
        sessionId = acquired.sessionId;
        entry.handle = handle;
        entry.sessionId = sessionId;
      } else {
        handle = entry.handle;
        sessionId = entry.sessionId;
      }
      const agent = handle.agent;
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" }
        }) as never
      );
      await agent.whenIdle();
      await deps.sessions.flush(agent.session);

      const outcome = summarizeTurn(agent.session, firstSeq);
      if (outcome.reason?.kind === "error") {
        return {
          ok: false,
          code: "agent-error",
          message: outcome.reason.message ?? outcome.reason.code ?? AGENT_ERROR_MESSAGE
        };
      }
      if (sessionId === undefined) {
        return { ok: false, code: "agent-error", message: AGENT_ERROR_MESSAGE };
      }
      return { ok: true, text: outcome.text, sessionId };
    } catch (error) {
      // A driver-level failure (whenIdle rejected, flush threw, ...) may have
      // wedged the agent loop: dispose it and drop the session mapping so the
      // next run starts clean instead of failing forever.
      if (entry.handle !== undefined) {
        const doomed = entry.handle;
        entry.handle = undefined;
        entry.sessionId = undefined;
        try {
          await doomed.dispose();
        } catch (disposeError) {
          deps.logger?.warn(
            `dsh-balbes-telegram: disposing the wedged task agent failed: ${errorMessage(disposeError)}`
          );
        }
      }
      return { ok: false, code: "agent-error", message: errorMessage(error, AGENT_ERROR_MESSAGE) };
    }
  }

  /** Run one task and, once it settles, start the next queued task (FIFO). */
  async function startTurn(
    key: string,
    entry: KeyedEntry,
    ref: WorkspaceRef,
    text: string,
    opts: { sessionId?: string } | undefined
  ): Promise<TaskResult> {
    entry.busy = true;
    entry.activeText = text;
    try {
      return await executeTurn(entry, ref, text, opts);
    } finally {
      entry.busy = false;
      entry.activeText = undefined;
      const next = entry.queue.shift();
      if (next !== undefined && cache.get(key) === entry) {
        void startTurn(key, entry, next.ref, next.text, next.opts).then(next.resolve, (error) => {
          next.resolve({ ok: false, code: "agent-error", message: errorMessage(error, AGENT_ERROR_MESSAGE) });
        });
      }
    }
  }

  return {
    async run(ref: WorkspaceRef, text: string, opts?: { sessionId?: string }): Promise<TaskResult> {
      await deps.loader?.await();
      const key = workspaceRefKey(ref);
      let entry = cache.get(key);
      if (entry === undefined) {
        entry = { handle: undefined, sessionId: undefined, busy: false, activeText: undefined, queue: [] };
        cache.set(key, entry);
      }
      if (entry.busy) {
        // The active task is never duplicated (a re-delivered message returns
        // busy instead of running the same text twice).
        if (text === entry.activeText || entry.queue.some((pending) => pending.text === text)) {
          return { ok: false, code: "busy", message: BUSY_MESSAGE };
        }
        if (entry.queue.length >= QUEUE_MAX_WAITING) {
          return { ok: false, code: "queue-full", message: QUEUE_FULL_MESSAGE };
        }
        return new Promise<TaskResult>((resolve) => {
          entry!.queue.push({ ref, text, opts, resolve });
        });
      }
      return startTurn(key, entry, ref, text, opts);
    },

    async reset(ref: WorkspaceRef): Promise<void> {
      const key = workspaceRefKey(ref);
      const entry = cache.get(key);
      if (entry === undefined) return;
      // Drop every waiting task so its caller never hangs, then dispose the
      // handle (stops the loop, unregisters the agent — Task 1 fact 9) and
      // forget the mapping; the next run starts a clean session.
      while (entry.queue.length > 0) {
        const pending = entry.queue.shift()!;
        pending.resolve({ ok: false, code: "agent-error", message: RESET_DROP_MESSAGE });
      }
      cache.delete(key);
      if (entry.handle !== undefined) {
        try {
          await entry.handle.dispose();
        } catch (error) {
          deps.logger?.warn(`dsh-balbes-telegram: reset dispose failed: ${errorMessage(error)}`);
        }
      }
    },

    sessionIdOf(ref: WorkspaceRef): string | undefined {
      return cache.get(workspaceRefKey(ref))?.sessionId;
    },

    snapshot(): Array<{ key: string; sessionId: string }> {
      const out: Array<{ key: string; sessionId: string }> = [];
      for (const [key, entry] of cache) {
        if (entry.sessionId !== undefined) out.push({ key, sessionId: entry.sessionId });
      }
      return out;
    }
  };
}
