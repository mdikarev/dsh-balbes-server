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
  | {
      ok: false;
      code: "workspace-gone" | "agent-error" | "queue-full" | "busy" | "cancelled";
      message: string;
    };

/** One tool invocation of the turn a progress read describes. */
export interface TaskProgressStep {
  name: string;
  /**
   * At most one short argument, and only for a whitelisted tool (see {@link
   * PROGRESS_TARGET_ARG}); absent for everything else. Never file content.
   */
  target?: string;
  status: "running" | "ok" | "failed";
}

/** One entry of the agent's todo list of the turn a progress read describes. */
export interface TaskProgressTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/**
 * A read-only snapshot of one workspace's running turn, for the progress card.
 *
 * It is deliberately small and content-free: the step names plus one whitelisted
 * short argument each, the agent's own todo list, the step number, the start
 * time and the queue depth. Tool RESULTS are never read and the assistant's text
 * never appears — this is a sign of life, not a stream of the answer.
 */
export interface TaskProgress {
  /** The workspace's own turn: a task waiting in the queue has no phase. */
  phase: "idle" | "running";
  taskText?: string;
  startedAt?: number;
  step?: number;
  steps: TaskProgressStep[];
  todos?: TaskProgressTodo[];
  queued: number;
}

export interface AgentTaskRunner {
  run(ref: WorkspaceRef, text: string, opts?: { sessionId?: string }): Promise<TaskResult>;
  reset(ref: WorkspaceRef): Promise<void>;
  /**
   * The soft stop: abort the active turn and drop every waiting task of one
   * workspace, but KEEP the agent handle and its session — the owner's next
   * task continues the same conversation. Contrast {@link reset}, which is the
   * hard stop that disposes the session. Returns whether a turn was actually
   * stopped and how many waiting tasks were dropped.
   */
  cancel(ref: WorkspaceRef): Promise<{ cancelled: boolean; dropped: number }>;
  /**
   * The summarised progress of this workspace's RUNNING turn, or an `idle`
   * snapshot with the queue depth when nothing of its own is running. Read-only
   * and cheap by construction: no I/O, no locks, no agent call — it reads the
   * live session log the runner already holds and never starts, waits for or
   * touches a turn.
   */
  progress(ref: WorkspaceRef): TaskProgress;
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

/**
 * How many tasks may wait (not run) per workspace. Exported because the chat
 * copy of the `queue-full` reply has to state the same depth (Task 16 review
 * minor: the number was hardcoded in chat.ts).
 */
export const QUEUE_MAX_WAITING = 3;
const BUSY_MESSAGE = "a task for this workspace is already running";
const QUEUE_FULL_MESSAGE = `the workspace task queue is full (${QUEUE_MAX_WAITING} waiting tasks max)`;
const AGENT_ERROR_MESSAGE = "agent task failed";
/**
 * The two phrases a run interrupted by the owner's own «Сбросить контекст»
 * settles with: the turn that was in flight ("aborted") and a task that was
 * still waiting in the queue ("dropped"). A reset is not a stop — the session
 * is destroyed, and the chat answers with its own reset copy — but the runner
 * has no `reset` result code, so the reset path genuinely reports itself BY
 * MESSAGE.
 *
 * They are exported for exactly one reason: the chat matches them, and a
 * matcher that restated the literals could drift out of sync with the raiser
 * and start reporting an intentional reset as an agent crash. ONE source, two
 * readers — never a copy (the drift this file's own review flagged).
 */
export const RESET_DROP_MESSAGE = "task dropped because the workspace context was reset";
export const RESET_ABORT_MESSAGE = "task aborted because the workspace context was reset";
/**
 * The `cancelled` code and this message are what a deliberate owner stop
 * reports. It is deliberately NOT shaped like the reset phrases (chat.ts maps
 * those to the reset copy by exact string) and is never matched by string
 * anywhere in the runner: the outcome of a stop is decided by the turn's own
 * `aborted` reason, so a real agent failure can never be mistaken for a stop.
 */
export const CANCELLED_MESSAGE = "task cancelled by the owner";

interface SessionEventLike {
  type: string;
  data: {
    message?: {
      content?: Array<{ type: string; text?: string; toolCallId?: string; isError?: boolean }>;
      /**
       * The message source. A tool result carries its `callId` here
       * (`{ kind: "tool", callId }`) — the event itself has none.
       */
      source?: { kind?: string; callId?: string };
    };
    reason?: unknown;
    step?: number;
    callId?: string;
    name?: string;
    /** The raw argument JSON string of a `tool/call`, exactly as the model wrote it. */
    arguments?: string;
    /** The harness failure identity of a `tool/result` (`{ name, code }`), when it has one. */
    error?: unknown;
    /** The whole-list snapshot of a `todo/write`; the latest write wins. */
    todos?: TaskProgressTodo[];
  };
}

/** Structural slice of the Agent returned by the agents registry (see runner.ts). */
interface AgentLike {
  whenIdle(): Promise<void>;
  followup(message: unknown): void;
  /**
   * The stock dsh seam for stopping work: it aborts the ACTIVE turn (or the
   * between-turn task) and clears queued/steering work unless `keepInbox` is
   * set, and is a no-op when the agent has no activity. It never tears the
   * session down — only `dispose()` does (Task 4 facts). `keepInbox: true` is
   * what makes the stop soft: work already sitting in the agent's own inbox (a
   * message the next task queued) survives, so the conversation continues.
   */
  cancel(cause: { kind: "user" }, options?: { keepInbox?: boolean }): void;
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
  /**
   * Set synchronously by reset() before the entry leaves the map. An
   * in-flight executeTurn checks it after every engine await so a reset that
   * lands mid-turn settles the run instead of driving a disposed agent
   * (hang risk) or disposing the same handle twice.
   */
  retired: boolean;
  /**
   * Set by cancel() for the current turn; cleared when that turn settles. A
   * SEPARATE flag from `retired` on purpose: a cancel keeps the entry, the
   * handle and the session alive, so the checkpoints answer "cancelled" where
   * the retired ones answer "reset aborted and the handle was disposed".
   */
  cancelled: boolean;
  /**
   * The session sequence the RUNNING turn starts at, and when it started. Both
   * are set for the moment the turn is submitted and cleared the moment it
   * settles, so a progress read can neither summarize a turn that is only being
   * set up nor one that is already over.
   */
  firstSeq: number | undefined;
  startedAt: number | undefined;
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
 * Arguments worth showing in the progress card, by tool. Everything else is
 * omitted: `write`/`edit` arguments carry whole file bodies, and a card that
 * rendered them would push workspace content into the chat. The whitelist is
 * consulted FIRST, so no tool outside it can contribute an argument at all.
 *
 * A `Map` and not an object literal: `PROGRESS_TARGET_ARG["constructor"]` on a
 * plain object answers with an inherited member, so a tool the model named
 * after a prototype member would slip PAST the "whitelist first" rule and could
 * contribute an argument the card must never render. A Map has no prototype
 * chain to inherit from.
 */
const PROGRESS_TARGET_ARG = new Map<string, string>([
  ["read", "file_path"],
  ["read_image", "file_path"],
  ["write", "file_path"],
  ["edit", "file_path"],
  ["glob", "path"],
  ["grep", "path"],
  ["web_search", "query"]
]);
/** Longest target the card may show, before the ellipsis. */
const PROGRESS_TARGET_MAX = 80;
/** How many of the turn's newest steps a progress read returns. */
const PROGRESS_STEP_MAX = 5;

/**
 * The one argument of `tool` the card may show, or nothing.
 *
 * Every failure to answer is `undefined` — a tool outside the whitelist, a
 * malformed argument string (never re-parsed leniently), a missing or non-string
 * or blank value. The result is whitespace-collapsed and capped, because a path
 * may be long, multi-line or contain the model's own newlines.
 */
function progressTarget(tool: string, rawArguments: string): string | undefined {
  const argName = PROGRESS_TARGET_ARG.get(tool);
  if (argName === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return undefined;
  }
  const value = (parsed as Record<string, unknown> | undefined)?.[argName];
  if (typeof value !== "string" || value === "") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed === "") return undefined;
  return collapsed.length > PROGRESS_TARGET_MAX ? `${collapsed.slice(0, PROGRESS_TARGET_MAX)}…` : collapsed;
}

/**
 * The call identity of a `tool/result`. The engine puts it on the model-facing
 * result message, not on the event: `message.source.callId` is the required tool
 * source of that message and the `tool-result` block repeats it as
 * `toolCallId` (@deepseek-ai/dsh-llm `createToolResultMessage`, appended by
 * dsh-agent-loop's `appendToolResult`). A result whose identity cannot be read
 * is left unpaired — a step keeps reporting "running" rather than being
 * credited to the wrong call.
 */
function resultCallId(message: SessionEventLike["data"]["message"]): string | undefined {
  const source = message?.source;
  if (source?.kind === "tool" && typeof source.callId === "string") return source.callId;
  const block = message?.content?.[0];
  return block?.type === "tool-result" && typeof block.toolCallId === "string" ? block.toolCallId : undefined;
}

/**
 * A `tool/result` reports a failed call when the tool itself said so (the
 * model-facing result block is an error) or when the harness attached a failure
 * identity. Both matter: a path-guard denial — the containment this deployment
 * relies on — is an `isError` result with NO identity, so reading only the
 * identity would render a denied read as a success.
 */
function resultFailed(event: SessionEventLike): boolean {
  return event.data.message?.content?.[0]?.isError === true || event.data.error !== undefined;
}

/**
 * Steps, todo list and step number of one turn's event slice: the pure half of
 * {@link AgentTaskRunner.progress}. `firstSeq` is the session sequence the turn
 * started at, so the slice is exactly the turn's own events (the leading
 * `turn/start` is the gate the rest of the file uses too).
 *
 * Only tool NAMES, one whitelisted argument per call, todo text and step numbers
 * are read: no tool result, no assistant text, no event the slice does not own.
 * Steps are returned oldest first, capped to the newest `limit` of them.
 */
export function summarizeProgress(
  session: AgentLike["session"],
  firstSeq: number,
  limit = PROGRESS_STEP_MAX
): { steps: TaskProgressStep[]; todos?: TaskProgressTodo[]; step?: number } {
  const byCallId = new Map<string, TaskProgressStep>();
  const steps: TaskProgressStep[] = [];
  let todos: TaskProgressTodo[] | undefined;
  let step: number | undefined;
  let started = false;
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    if (event.type === "turn/start") started = true;
    if (!started) continue;
    const data = event.data;
    if (event.type === "step/start" && typeof data.step === "number") step = data.step;
    if (event.type === "todo/write" && Array.isArray(data.todos)) {
      todos = data.todos.map((todo) => ({ content: todo.content, status: todo.status }));
    }
    if (event.type === "tool/call" && typeof data.callId === "string" && typeof data.name === "string") {
      const line: TaskProgressStep = { name: data.name, status: "running" };
      const target = progressTarget(data.name, data.arguments ?? "");
      if (target !== undefined) line.target = target;
      byCallId.set(data.callId, line);
      steps.push(line);
    }
    if (event.type === "tool/result") {
      const callId = resultCallId(data.message);
      const line = callId === undefined ? undefined : byCallId.get(callId);
      if (line !== undefined) line.status = resultFailed(event) ? "failed" : "ok";
    }
  }
  const out: { steps: TaskProgressStep[]; todos?: TaskProgressTodo[]; step?: number } = {
    steps: steps.slice(Math.max(0, steps.length - limit))
  };
  if (todos !== undefined) out.todos = todos;
  if (step !== undefined) out.step = step;
  return out;
}

/**
 * Compose the agent-scoped setup every task session receives (create and
 * resume): the model-selection wiring (mirrors runner.ts), the restricted
 * tool surface, and the read-containment guard.
 *
 * WHAT IS CONTAINED
 *
 * 1. The tool surface. dsh 0.1.5-rc.2 still exposes no workspace-root read
 *    boundary of its own (the 0.1.2-rc.1 facts 3/4/5 hold against the 0.1.5
 *    code: `SandboxedFileSystem` fences only MUTATIONS — "reads pass through
 *    untouched" — and `read` resolves against the session cwd, so `read`
 *    traversal, absolute paths and symlink escapes all reach the model), and
 *    the shell tools share the host process. On the macOS dev host `bash`
 *    happens to fail closed ("no sandbox backend is usable"), but that is an
 *    accident of the host — on the Linux
 *    VPS dsh mounts a usable backend (Landlock/bwrap with `readOnly: ["/"]`),
 *    so `bash cat $DSH_HOME/.credentials.yaml` RUNS and returns bytes. A
 *    path-argument guard can never cover that, nor `str_replace_editor`'s
 *    `view` command (the package still ships; 0.1.5 mounts no row for it), nor
 *    the delegation/network/job/channel tools. The only
 *    boundary that holds on every host is the surface itself: this setup
 *    narrows the agent to {@link KEPT_TOOL_NAMES} (workspace file work,
 *    internet search plus benign bookkeeping) through the agent-scope
 *    `tools.restrict({ allow })` seam. Everything else the deployment
 *    registers — `bash`, `pwsh`, `subagent`,
 *    `subagent_fork`, `workflow`, `ralph`, `web_fetch`, `skill`, the `job_*`
 *    tools, `send_message`, `interrupt_agent`, `list_agents`,
 *    `exit_plan_mode` — is invisible to the model, and it is an allow filter
 *    (not a deny list) on purpose: a tool a future dsh registers is excluded
 *    by default instead of leaking in unnamed.
 *
 *    Internet SEARCH is on that surface; arbitrary URL FETCHING is not. A
 *    task may call `web_search`, which is provider-mediated: the query goes
 *    to the configured search provider and no bytes can be posted to an
 *    address the model chooses. `web_fetch` stays excluded because it IS
 *    such an egress channel — fetching an arbitrary URL is exactly what an
 *    indirect prompt injection needs to send workspace content out to an
 *    attacker's server; a search cannot address that server, a fetch can.
 * 2. Read paths inside that surface. The per-agent `tools.guard` denies fs
 *    reads whose resolved path leaves the workspace root, so `read`,
 *    `read_image`, `glob` and `grep` cannot walk out of the workspace by `../`,
 *    absolute path or symlink. In-workspace work (Task 12's task flow reads
 *    notes.txt inside the project) stays intact.
 *
 * WHAT IS NOT CONTAINED (deliberately, and stated so nobody re-derives it)
 *
 * - A tool a plugin registers into the AGENT's own scope is exempt from
 *   restrictions by dsh design ("a restriction filters what a scope inherits,
 *   and never what its OWN layer registers"). The Telegram deployment
 *   registers none; a preset that adds one to this scope is outside this
 *   boundary.
 * - The reserved `run_code` PTC transport cannot be named in a restriction
 *   (`tools.restrict` rejects it); it carries no tool of its own, and this
 *   deployment runs the default native presentation mode.
 * - The host process. This is a model-facing surface boundary — the agent can
 *   no longer ASK for anything outside the workspace — not an OS sandbox: the
 *   dsh process itself still holds the server's file permissions.
 * - {@link restrictToolSurface}'s fallback path (see there): when a
 *   composition registers none of the kept tools, the filter degrades to a
 *   deny list of the tools it knows it must remove. That path is deliberately
 *   conservative and is intentionally left as it was when `web_search` moved
 *   to the kept side: it removes a subset of what the allow path removes — a
 *   weaker guarantee, never a stronger one (any name it does not list stays
 *   reachable, which is exactly why this is filed as not-contained). The REAL
 *   suite asserts the allow path.
 */
export interface AgentSetupOptions {
  /** The workspace root the session cwd resolves under (meta.cwd seed). */
  root: string;
  /**
   * The LIVE model selection of the session. dsh's `installModelSelection`
   * reads `current` at prompt-assembly time and owns the `assembled` slot, so
   * the runner passes the ref itself (never a snapshot of it).
   */
  selection: ModelSelectionRefLike;
}

/** The mutable selection dsh's installModelSelection reads per step. */
export interface ModelSelectionRefLike {
  current?: { provider: string; model: string } | undefined;
  assembled?: { provider: string; model: string } | undefined;
}

/**
 * The model-facing tools a Telegram task session keeps: workspace file work,
 * internet search, plus harmless bookkeeping. Registered identifiers verified
 * against the installed `@deepseek-ai/dsh-tool-fs` (`read`, `read_image`,
 * `write`, `edit`), `dsh-tool-fs-search` (`glob`, `grep`), `dsh-tool-web`
 * (`web_search`; the same package registers the excluded `web_fetch`),
 * `dsh-tool-todo` (`todo_write`) and `dsh-tool-goal` (`create_goal`,
 * `get_goal`, `update_goal`) packages, and asserted name-by-name by the REAL
 * suite's agent-visible surface dump.
 */
const KEPT_TOOL_NAMES = [
  "read",
  "read_image",
  "write",
  "edit",
  "glob",
  "grep",
  // Internet SEARCH is kept; `web_fetch` is deliberately NOT kept, because it
  // is an egress channel to arbitrary URLs (see the containment notes above).
  "web_search",
  "todo_write",
  "get_goal",
  "create_goal",
  "update_goal"
] as const;

/**
 * Tools the surface must never expose, used only by the fallback filter below.
 * Registered identifiers: `dsh-tool-bash` (`bash`), `dsh-tool-pwsh` (`pwsh`),
 * `dsh-tool-str-replace-editor` (`str_replace_editor`, whose `view` command
 * reads; the package still ships, but the 0.1.5 base composition mounts no row
 * for it, so this entry is defensive), `dsh-tool-jobs` (`job_list`,
 * `job_output`, `job_kill` — job output is arbitrary captured text),
 * `dsh-tool-subagent` (`subagent`, `subagent_fork`, configurable `toolName`s),
 * `dsh-tool-workflow` (`workflow`), `dsh-tool-ralph` (`ralph`), `dsh-tool-web`
 * (`web_search`, `web_fetch`), `dsh-tool-skill` (`skill`),
 * `dsh-tool-subagent-control` (`send_message`, `interrupt_agent`,
 * `list_agents`), and `dsh-plan-mode` (`exit_plan_mode`, a session-mode
 * control that prompts for plan review — no I/O, but not part of a workspace
 * task's surface either).
 *
 * Deliberately conservative, and left as it was when `web_search` moved to the
 * kept side: this list removes a subset of what the allow path removes — a
 * weaker guarantee, never a stronger one, because an unlisted name stays
 * reachable here (that residual surface is what {@link KEPT_TOOL_NAMES}'s
 * allow filter closes). A composition that registers `web_search` has a kept
 * tool and therefore takes the allow path above, never this one.
 *
 * The base tree disables `bash` on win32 and `pwsh` on every other platform,
 * so neither list can be assumed present — which is exactly why the filter is
 * probed against the live registry before it is applied.
 */
const FALLBACK_DENIED_TOOL_NAMES = [
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
  "web_search",
  "web_fetch",
  "skill",
  "send_message",
  "interrupt_agent",
  "list_agents",
  "exit_plan_mode"
] as const;

/**
 * Model-facing tools whose string path argument must stay inside the root.
 *
 * A `Map`, like {@link PROGRESS_TARGET_ARG}: this one is the containment guard,
 * and an inherited prototype member answering for a tool named e.g.
 * `constructor` would make the guard read a path argument out of a name it was
 * never meant to guard. Only the own entries of this table may ever match.
 */
const READ_PATH_ARG_BY_TOOL = new Map<string, string>([
  ["read", "file_path"],
  ["read_image", "file_path"],
  ["glob", "path"],
  ["grep", "path"]
]);

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

/**
 * The agent-scope slice of dsh-tools' `ToolRuntime` this package consumes
 * structurally (same best-effort-against-public-d.ts posture as the rest of
 * the file). `restrict` / `guard` register in the CALLING agent's scope —
 * dsh binds the receiving context per access, so a registration made through
 * `agentCtx.get("tools")` applies to that agent alone, while `get(name)` reads
 * the deployment-wide view used here only to probe which names exist.
 */
interface ToolsSurface {
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): unknown;
  guard(guard: (exec: GuardExecLike) => string | undefined): unknown;
  /** The deployment-wide definition for a registered name, if any. */
  get(name: string): unknown;
}

/**
 * Narrow the agent's model-facing surface to the workspace tool set.
 *
 * The filter is probed against the live registry first: dsh-tools'
 * `restrict()` rejects any name the composition does not register ("names
 * unknown global tool"), and registration is platform-dependent (the base tree
 * disables `bash` on win32 and `pwsh` elsewhere), so an unprobed allow list
 * would throw on every host that lacks one of its names. Probing turns "which
 * tools exist here" into data instead of a failing agent create.
 *
 * The allow path is the real one and is fail-closed: any tool not named above
 * disappears, including one a future dsh release adds. The deny path is the
 * degraded fallback for a composition that registers none of the kept tools at
 * all — it removes a subset of what the allow filter removes (it can only name
 * the tools it knows, among them `web_search`, which the allow path keeps),
 * i.e. a weaker guarantee, never a stronger one: a name it does not list stays
 * reachable, so this branch degrades the boundary instead of tightening it.
 *
 * A throw from `restrict()` is deliberately NOT swallowed: it would mean this
 * deployment cannot be constrained, and an audible `agent-error` on the task
 * is the fail-closed outcome — silently handing the model the full surface
 * (shells included) is the failure this function exists to prevent.
 */
function restrictToolSurface(tools: ToolsSurface): void {
  const kept = KEPT_TOOL_NAMES.filter((name) => tools.get(name) !== undefined);
  if (kept.length > 0) {
    tools.restrict({ allow: kept });
    return;
  }
  const denied = FALLBACK_DENIED_TOOL_NAMES.filter((name) => tools.get(name) !== undefined);
  if (denied.length > 0) tools.restrict({ deny: denied });
}

/**
 * The live selection of one keyed session: `agentOptions` needs a concrete pair
 * at create/resume time, but every later request must read the CURRENT global
 * default, so a change made from the admin page or the chat reaches a session
 * that is already alive. The `assembled` slot stays owned by dsh.
 */
function liveSelection(defaultModel: AgentTaskDeps["defaultModel"]): {
  ref: ModelSelectionRefLike;
  initial: { provider: string; model: string };
} {
  const initial = defaultModel?.currentSelection() ?? { provider: "", model: "" };
  const ref: ModelSelectionRefLike = {
    get current(): { provider: string; model: string } {
      return defaultModel?.currentSelection() ?? initial;
    },
    assembled: undefined
  };
  return { ref, initial };
}

export function composeAgentSetup(agentCtx: unknown, options: AgentSetupOptions): void {
  installModelSelection(agentCtx as never, options.selection as never);
  const tools = (agentCtx as { get(key: string): unknown }).get("tools") as ToolsSurface | undefined;
  if (tools === undefined) return;
  restrictToolSurface(tools);
  const escapes = rootEscapes(options.root);
  tools.guard((exec) => {
    const argName = READ_PATH_ARG_BY_TOOL.get(exec.name);
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
    const selection = liveSelection(deps.defaultModel);
    const setup = (agentCtx: unknown): void => {
      composeAgentSetup(agentCtx, { root, selection: selection.ref });
    };
    if (opts?.sessionId !== undefined) {
      try {
        const handle = await deps.agents.resume({
          resumeSessionId: opts.sessionId,
          agentOptions: selection.initial,
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
      agentOptions: selection.initial,
      setup
    });
    return { handle, sessionId };
  }

  /**
   * Dispose one owned handle, never letting a teardown failure escape: the
   * caller has already decided the handle is doomed, and a throwing dispose
   * must not replace the run's real outcome with its own error.
   */
  async function disposeQuietly(handle: AgentHandleLike, what: string): Promise<void> {
    try {
      await handle.dispose();
    } catch (error) {
      deps.logger?.warn(`dsh-balbes-telegram: ${what}: ${errorMessage(error)}`);
    }
  }

  /** One serialized turn: root check, handle acquisition, followup, flush. */
  async function executeTurn(
    key: string,
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
        // reset() may have landed while create/resume was still resolving. The
        // entry it retired had no handle yet, so nobody else can dispose this
        // one — settle the run AND dispose it here, or a registered agent leaks
        // until restart. Never reached twice: the return below skips the
        // error-path disposal, and that path also checks `entry.retired`.
        if (entry.retired) {
          await disposeQuietly(acquired.handle, "disposing the agent orphaned by a mid-create reset failed");
          return { ok: false, code: "agent-error", message: RESET_ABORT_MESSAGE };
        }
        entry.handle = handle;
        entry.sessionId = sessionId;
        // A cancel may have landed while create/resume was still resolving:
        // there was no handle to abort yet, only the entry flag. Keep the handle
        // (unlike the retired path above) so the session survives the stop.
        if (entry.cancelled) {
          entry.cancelled = false;
          return { ok: false, code: "cancelled", message: CANCELLED_MESSAGE };
        }
      } else {
        handle = entry.handle;
        sessionId = entry.sessionId;
      }
      const agent = handle.agent;
      await agent.whenIdle();
      // A reset may have retired the entry while the loop was starting (its
      // dispose aborts the parked agent — Task 1 fact 9). Stop here instead
      // of sending a followup into a dying agent: the teardown is owned by
      // reset, so the run settles as an abort, never hangs, and never double-
      // disposes.
      if (entry.retired) {
        return { ok: false, code: "agent-error", message: RESET_ABORT_MESSAGE };
      }
      // Checked AFTER the retired branch on purpose: when a reset and a cancel
      // race, the reset owns the outcome (its abort phrase, its disposal).
      if (entry.cancelled) {
        entry.cancelled = false;
        return { ok: false, code: "cancelled", message: CANCELLED_MESSAGE };
      }
      const firstSeq = agent.session.seq;
      // The progress read of THIS turn starts here (progress() reads the pair
      // back); `agent.followup` below is what puts its first event into the log.
      entry.firstSeq = firstSeq;
      entry.startedAt = Date.now();
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" }
        }) as never
      );
      await agent.whenIdle();
      if (entry.retired) {
        return { ok: false, code: "agent-error", message: RESET_ABORT_MESSAGE };
      }
      // No flag-only checkpoint here on purpose. Unlike the two checkpoints
      // above (where no turn exists yet, so the flag is the only evidence of a
      // stop), this point is reached with a turn that has an outcome of its
      // own: an owner stop that released this park aborted the turn, so the
      // turn carries the `aborted` reason and the reason gate below classifies
      // it — and when the stop erased the turn before its first step (no
      // `aborted` reason, no answer) that gate classifies it by its emptiness.
      // Deciding "cancelled" from the flag alone would let a cancel landing as
      // the turn was finishing discard a completed answer.
      await deps.sessions.flush(agent.session);

      const outcome = summarizeTurn(agent.session, firstSeq);
      // Отмена подтверждается ПРИЧИНОЙ turn'а, а не только флагом: cancel,
      // пришедший в момент, когда turn уже завершался, не должен превращать
      // успешный результат в «остановлено».
      //
      // The reason alone is not enough. A turn that stops before its first step
      // leaves a `turn/end` shaped exactly like the balanced no-op turns a
      // rejection or an empty claim produces — dsh's turn vocabulary cannot
      // express that case — so an owner stop landing in that window arrives here
      // with a non-`aborted` reason AND no answer. Answering `{ ok: true, text:
      // "" }` for it would report the task the owner deliberately stopped as a
      // completed empty one, which is the one user-visible lie this feature
      // exists to avoid. An empty turn the owner cancelled is therefore a stop,
      // while a turn that really answered keeps its result.
      if (entry.cancelled && (outcome.reason?.kind === "aborted" || outcome.text === "")) {
        return { ok: false, code: "cancelled", message: CANCELLED_MESSAGE };
      }
      if (entry.cancelled) entry.cancelled = false;
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
      // next run starts clean instead of failing forever. When the entry was
      // retired by reset() the disposal already happened there — never dispose
      // the same handle twice.
      if (!entry.retired && entry.handle !== undefined) {
        const doomed = entry.handle;
        entry.handle = undefined;
        entry.sessionId = undefined;
        await disposeQuietly(doomed, "disposing the wedged task agent failed");
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
      return await executeTurn(key, entry, ref, text, opts);
    } finally {
      entry.busy = false;
      entry.activeText = undefined;
      // The progress read is scoped to the turn that just settled: clearing it
      // BEFORE the next queued task is set up is what keeps a later read from
      // summarizing a turn that is over (the next task's own window has no
      // events yet, so it must report no phase at all).
      entry.firstSeq = undefined;
      entry.startedAt = undefined;
      // The stop flag is scoped to the turn it stopped: a cancel that landed as
      // this turn was settling must not misreport the NEXT queued task.
      entry.cancelled = false;
      const next = entry.queue.shift();
      if (next !== undefined && !entry.retired && cache.get(key) === entry) {
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
        entry = {
          handle: undefined,
          sessionId: undefined,
          busy: false,
          activeText: undefined,
          queue: [],
          retired: false,
          cancelled: false,
          firstSeq: undefined,
          startedAt: undefined
        };
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
      // Retire FIRST (synchronously): an in-flight turn parked on the engine
      // checks entry.retired at its next checkpoint and settles as an abort
      // instead of driving the disposed agent or disposing it a second time.
      entry.retired = true;
      // Drop every waiting task so its caller never hangs, then dispose the
      // handle (stops the loop, unregisters the agent — Task 1 fact 9) and
      // forget the mapping; the next run starts a clean session.
      while (entry.queue.length > 0) {
        const pending = entry.queue.shift()!;
        pending.resolve({ ok: false, code: "agent-error", message: RESET_DROP_MESSAGE });
      }
      cache.delete(key);
      if (entry.handle !== undefined) {
        await disposeQuietly(entry.handle, "reset dispose failed");
      }
    },

    /**
     * The soft stop, the counterpart of reset(): abort the active turn of this
     * workspace and settle every waiting task as `cancelled`, but keep the
     * handle, the session and the transcript — the owner loses the task, never
     * the context. A cancel with nothing running (or nothing cached) is a no-op
     * that still drains the queue, so a caller can always await it safely.
     */
    async cancel(ref: WorkspaceRef): Promise<{ cancelled: boolean; dropped: number }> {
      // The same readiness gate run() waits on, and the reason it matters here:
      // a task accepted a moment ago is registered on that same tick, so the
      // drain below sees it and settles it as cancelled instead of letting it
      // start as the follow-up turn of a stop the owner already asked for.
      await deps.loader?.await();
      const key = workspaceRefKey(ref);
      const entry = cache.get(key);
      if (entry === undefined) return { cancelled: false, dropped: 0 };
      let dropped = 0;
      while (entry.queue.length > 0) {
        entry.queue.shift()!.resolve({ ok: false, code: "cancelled", message: CANCELLED_MESSAGE });
        dropped += 1;
      }
      if (!entry.busy) return { cancelled: false, dropped };
      // Мягкая отмена: сессия и хэндл остаются живыми, инбокс задач не чистится
      // (keepInbox), поэтому следующая задача продолжает ту же сессию.
      entry.cancelled = true;
      entry.handle?.agent.cancel({ kind: "user" }, { keepInbox: true });
      return { cancelled: true, dropped };
    },

    /**
     * The progress of the workspace's own running turn. Deliberately free of
     * side effects — no loader gate, no lock, no agent call — because a chat
     * poll may read it while a turn is mid-flight. The turn is summarized from
     * the live session log the runner already owns, from the sequence the turn
     * started at; a task that is merely WAITING is reported as queue depth, and
     * a task still being set up (no turn of its own yet) has no phase at all.
     */
    progress(ref: WorkspaceRef): TaskProgress {
      const entry = cache.get(workspaceRefKey(ref));
      if (entry === undefined) return { phase: "idle", steps: [], queued: 0 };
      const queued = entry.queue.length;
      if (!entry.busy || entry.handle === undefined || entry.firstSeq === undefined) {
        return { phase: "idle", steps: [], queued };
      }
      const summary = summarizeProgress(entry.handle.agent.session, entry.firstSeq);
      const out: TaskProgress = {
        phase: "running",
        steps: summary.steps,
        queued,
        startedAt: entry.startedAt ?? Date.now()
      };
      if (entry.activeText !== undefined) out.taskText = entry.activeText;
      if (summary.step !== undefined) out.step = summary.step;
      if (summary.todos !== undefined) out.todos = summary.todos;
      return out;
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
