import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeAgentSetup,
  createAgentTaskRunner,
  workspaceRefKey,
  type AgentTaskDeps,
  type TaskResult,
  type WorkspaceRef
} from "../src/agentTask.js";

/**
 * Hermetic unit suite for the workspace-aware agent task runner. Everything
 * below is fake: no real dsh agent, no LLM, no network. The fake `agents`
 * service emulates dsh's AgentHandle seam — `followup` starts a turn (turn/start
 * plus the assistant message) and `whenIdle` resolves (optionally parked so a
 * test can observe the runner mid-turn). A parked turn stays OPEN until its park
 * is released: that is when its `turn/end` lands, so a cancel arriving on the
 * park really does stop a running turn. `cancelAsNoopTurn` models the other
 * shape of a stop: a turn stopped before its first step, which ends as a
 * balanced no-op instead of `aborted` and leaves no answer behind.
 */

const PROJECT_ALPHA: WorkspaceRef = { scope: "project", name: "alpha" };
const PROJECT_BRAVO: WorkspaceRef = { scope: "project", name: "bravo" };
const HOME_REF: WorkspaceRef = { scope: "home" };
const SELECTION = { provider: "deepseek-official", model: "deepseek-v4-flash" };

interface EventLike {
  type: string;
  data: unknown;
}
interface FakeHandleConfig {
  /** Assistant text emitted per followup turn; falls back to a default. */
  answers?: string[];
  /** When true every `whenIdle` parks until the test releases it. */
  holdIdle?: boolean;
  /** When true every `whenIdle` rejects (an agent-loop failure). */
  throwOnIdle?: boolean;
  idleError?: string;
  /**
   * When true, dispose() models the real dsh teardown: it marks the agent's
   * loop dead, resolves any parked `whenIdle` (the abort convergence of Task
   * 1 fact 9), and every later `whenIdle` rejects.
   */
  disposeStopsLoop?: boolean;
  /**
   * Models the stop that lands before the turn's first step. With this on,
   * `followup` opens the turn but withholds its assistant message (nothing has
   * been produced yet), and `cancel` closes such an open, answerless turn with
   * a BALANCED NO-OP reason (`{kind:"completed"}`) instead of `aborted`: dsh
   * documents that exactly this window cannot be told apart from the balanced
   * no-op turns a rejection or an empty claim produces, and that `Agent.cancel`
   * aborts the active turn OR a between-turn task. The withheld answer lands
   * only if the turn completes normally.
   */
  cancelAsNoopTurn?: boolean;
}
interface FakeHandle {
  agent: {
    session: { seq: number; eventAt(seq: unknown): EventLike | undefined };
    whenIdle: ReturnType<typeof vi.fn>;
    followup: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    status: string;
  };
  dispose: ReturnType<typeof vi.fn>;
  releaseParked(): void;
  parkedCount: number;
}

/** One fake dsh AgentHandle whose session events emulate a completed turn. */
function makeHandle(cfg: FakeHandleConfig = {}): FakeHandle {
  const events: EventLike[] = [];
  let parked: Array<() => void> = [];
  let answerAt = 0;
  let loopDead = false;
  /**
   * Whether the current turn still lacks its `turn/end`. A real turn is OPEN
   * from the moment `followup` starts it until it really finishes; the fake
   * therefore keeps it open while the run is parked and closes it only when the
   * park is released (or when `cancel` aborts it). A fake that closed the turn
   * inside `followup` would leave an agent that is genuinely mid-turn with no
   * open turn, so a cancel landing on that park could never produce an honest
   * `aborted` reason.
   */
  let turnOpen = false;
  /** Whether the open turn has produced an assistant message yet. */
  let turnHasMessage = false;
  /** Answer withheld by `cancelAsNoopTurn` until the turn completes. */
  let pendingAnswer: string | undefined;
  const session = {
    get seq(): number {
      return events.length;
    },
    eventAt(seq: unknown): EventLike | undefined {
      return events[Number(seq)];
    }
  };
  /** Append the closing `turn/end` of the open turn; a no-op when none is open. */
  const closeTurn = (reason: unknown) => {
    if (!turnOpen) return;
    turnOpen = false;
    events.push({ type: "turn/end", data: { reason } });
  };
  /** Emit this turn's assistant message (the only thing that gives it text). */
  const emitAnswer = (text: string) => {
    events.push({
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text }] } }
    });
    turnHasMessage = true;
  };
  /** End the open turn normally, emitting a withheld answer first. */
  const finishTurn = () => {
    if (!turnOpen) return;
    if (pendingAnswer !== undefined) {
      emitAnswer(pendingAnswer);
      pendingAnswer = undefined;
    }
    closeTurn({ kind: "completed" });
  };
  // Declared before the agent object: `cancel` (and `dispose` below) resolve the
  // current park, and the abort convergence must be reachable from both.
  const releaseParked = () => {
    // Releasing the park is what ENDS the held turn: while it is held open the
    // owner can still stop it, and only an unaborted release completes it. The
    // close happens before the parked `whenIdle` resolves, so the runner always
    // summarizes a session that already carries this turn's end event.
    finishTurn();
    const pending = parked;
    parked = [];
    for (const resolve of pending) resolve();
  };
  const agent = {
    session,
    status: "idle",
    whenIdle: vi.fn(async () => {
      if (cfg.throwOnIdle) throw new Error(cfg.idleError ?? "idle loop exploded");
      if (cfg.disposeStopsLoop === true && loopDead) throw new Error("agent loop disposed");
      if (cfg.holdIdle) {
        await new Promise<void>((resolve) => {
          parked.push(resolve);
        });
      }
    }),
    followup: vi.fn(() => {
      const text = cfg.answers?.[answerAt] ?? "fake answer";
      answerAt += 1;
      events.push({ type: "turn/start", data: {} });
      turnOpen = true;
      turnHasMessage = false;
      if (cfg.cancelAsNoopTurn === true) {
        // The turn is open, but its first step has produced nothing yet: the
        // message is withheld, so a stop landing here erases an answerless turn
        // exactly as the engine does.
        pendingAnswer = text;
      } else {
        emitAnswer(text);
      }
      // A handle that never parks runs its turn to the end synchronously (the
      // same turn/start + assistant/message + turn/end as before). A held
      // handle leaves the turn OPEN until releaseParked(): that is what makes
      // "parked mid-turn" mean it.
      if (!cfg.holdIdle) finishTurn();
    }),
    cancel: vi.fn((_cause: unknown, _options?: unknown) => {
      // Реальный Agent.cancel прерывает активный turn и разрешает парковку
      // whenIdle; turn/end с причиной "aborted" появляется только если turn
      // действительно был открыт.
      if (cfg.cancelAsNoopTurn === true && turnOpen && !turnHasMessage) {
        // Stopped before the first step: the turn ends as the balanced no-op a
        // rejection or an empty claim would leave, NOT as `aborted` (dsh's turn
        // vocabulary cannot express the difference), and the withheld answer
        // never lands.
        pendingAnswer = undefined;
        closeTurn({ kind: "completed" });
      } else {
        closeTurn({ kind: "aborted", reason: { kind: "user" } });
      }
      releaseParked();
    })
  };
  return {
    agent,
    dispose: vi.fn(async () => {
      if (cfg.disposeStopsLoop === true) {
        loopDead = true;
        releaseParked();
      }
    }),
    releaseParked,
    get parkedCount(): number {
      return parked.length;
    }
  };
}

interface FakeCreateOptions {
  sessionId: string;
  meta: { cwd: string };
  agentOptions: { provider: string; model: string };
  setup: (agentCtx: unknown) => void;
}
interface FakeResumeOptions {
  resumeSessionId: string;
  agentOptions: { provider: string; model: string };
  setup: (agentCtx: unknown) => void;
}

/**
 * Fake `agents` service: records every create/resume call, hands out
 * configurable handles in FIFO order, and can be told to fail resumes.
 */
function makeAgents(): {
  createOpts: FakeCreateOptions[];
  resumeOpts: FakeResumeOptions[];
  created: FakeHandle[];
  cfg(c: FakeHandleConfig): void;
  setResumeError(error: Error | undefined): void;
  create(opts: unknown): Promise<FakeHandle>;
  resume(opts: unknown): Promise<FakeHandle>;
} {
  const createOpts: FakeCreateOptions[] = [];
  const resumeOpts: FakeResumeOptions[] = [];
  const created: FakeHandle[] = [];
  const cfgQueue: FakeHandleConfig[] = [];
  let resumeError: Error | undefined;
  return {
    createOpts,
    resumeOpts,
    created,
    cfg(c: FakeHandleConfig): void {
      cfgQueue.push(c);
    },
    setResumeError(error: Error | undefined): void {
      resumeError = error;
    },
    async create(opts: unknown): Promise<FakeHandle> {
      createOpts.push(opts as FakeCreateOptions);
      const handle = makeHandle(cfgQueue.shift());
      created.push(handle);
      return handle;
    },
    async resume(opts: unknown): Promise<FakeHandle> {
      resumeOpts.push(opts as FakeResumeOptions);
      if (resumeError !== undefined) throw resumeError;
      const handle = makeHandle(cfgQueue.shift());
      created.push(handle);
      return handle;
    }
  };
}

/** Fake Task 4 workspaces service slice: root() resolves under one temp base. */
function makeWorkspaces(base: string, goneName = "gone"): {
  root(scope: WorkspaceRef["scope"], name: string | undefined): Promise<string>;
} {
  return {
    async root(scope, name) {
      if (scope === "project" && name === goneName) {
        throw new Error(`project not found: ${name}`);
      }
      return join(base, scope === "home" ? "home" : `project-${name ?? ""}`);
    }
  };
}

async function makeRunner() {
  const base = await mkdtemp(join(tmpdir(), "agenttask-"));
  const agents = makeAgents();
  const warn = vi.fn();
  const deps: AgentTaskDeps = {
    agents: agents as unknown as AgentTaskDeps["agents"],
    sessions: { flush: vi.fn(async () => {}) },
    defaultModel: { currentSelection: () => SELECTION },
    workspaces: makeWorkspaces(base) as unknown as AgentTaskDeps["workspaces"],
    logger: { warn }
  };
  const runner = createAgentTaskRunner(deps);
  return { base, agents, warn, deps, runner };
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met within the timeout");
}

/** Await `promise`, failing the test loudly if it never settles in time. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function expectOk(result: TaskResult): { text: string; sessionId: string } {
  expect(result.ok).toBe(true);
  const ok = result as Extract<TaskResult, { ok: true }>;
  return { text: ok.text, sessionId: ok.sessionId };
}

/**
 * Drive a held fake agent through `runs` complete turns: whenIdle is called
 * exactly twice per turn, each call parks until releaseParked() resolves it.
 * Deterministic because only one idle is ever parked at a time.
 */
async function runToCompletion(handle: FakeHandle, runs: number): Promise<void> {
  const targetCalls = runs * 2;
  for (let calls = 1; calls <= targetCalls; calls++) {
    await waitFor(() => handle.agent.whenIdle.mock.calls.length >= calls);
    handle.releaseParked();
  }
}

describe("agentTask runner (fake deps)", () => {
  it("creates one agent per key and reuses the handle for later runs without a sessionId", async () => {
    const { agents, runner } = await makeRunner();
    agents.cfg({ answers: ["first answer", "second answer"] });
    const first = await runner.run(PROJECT_ALPHA, "first prompt");
    const firstOk = expectOk(first);
    expect(firstOk.text).toBe("first answer");
    expect(agents.createOpts).toHaveLength(1);
    expect(agents.resumeOpts).toHaveLength(0);

    const second = await runner.run(PROJECT_ALPHA, "second prompt");
    const secondOk = expectOk(second);
    expect(secondOk.text).toBe("second answer");
    // Handle reuse: still exactly one create and one followup per run.
    expect(agents.createOpts).toHaveLength(1);
    expect(agents.created).toHaveLength(1);
    expect(agents.created[0]!.agent.followup.mock.calls).toHaveLength(2);
    // Same session across runs; mapping stable.
    expect(secondOk.sessionId).toBe(firstOk.sessionId);
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBe(firstOk.sessionId);
    expect(runner.snapshot()).toEqual([
      { key: workspaceRefKey(PROJECT_ALPHA), sessionId: firstOk.sessionId }
    ]);
  });

  it("extracts the assistant text from session events", async () => {
    const { agents, runner } = await makeRunner();
    agents.cfg({ answers: ["hello agent"] });
    const result = await runner.run(PROJECT_ALPHA, "say hello");
    expect(expectOk(result).text).toBe("hello agent");
  });

  it("calls sessions.flush after each successful run", async () => {
    const { agents, deps, runner } = await makeRunner();
    const flush = deps.sessions.flush as ReturnType<typeof vi.fn>;
    await runner.run(PROJECT_ALPHA, "one");
    await runner.run(PROJECT_ALPHA, "two");
    expect(flush.mock.calls).toHaveLength(2);
    expect(flush.mock.calls[0]![0]).toBe(agents.created[0]!.agent.session);
  });

  it("resumes when a sessionId is passed and reuses the resumed handle afterwards", async () => {
    const { agents, runner } = await makeRunner();
    const result = await runner.run(PROJECT_ALPHA, "continue", { sessionId: "session-known-1" });
    const ok = expectOk(result);
    expect(ok.sessionId).toBe("session-known-1");
    expect(agents.resumeOpts).toHaveLength(1);
    expect(agents.resumeOpts[0]!.resumeSessionId).toBe("session-known-1");
    expect(agents.resumeOpts[0]!.agentOptions).toEqual(SELECTION);
    expect(agents.createOpts).toHaveLength(0);
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBe("session-known-1");

    // A later run without a sessionId reuses the live handle (no second resume).
    await runner.run(PROJECT_ALPHA, "again");
    expect(agents.resumeOpts).toHaveLength(1);
    expect(agents.createOpts).toHaveLength(0);
  });

  it("falls back to a fresh create when resume fails, logs a warning and resets the mapping", async () => {
    const { agents, warn, runner } = await makeRunner();
    agents.setResumeError(new Error("session not found or corrupt"));
    const result = await runner.run(PROJECT_BRAVO, "continue", { sessionId: "session-known-2" });
    const ok = expectOk(result);
    expect(ok.sessionId).not.toBe("session-known-2");
    expect(agents.resumeOpts).toHaveLength(1);
    expect(agents.createOpts).toHaveLength(1);
    expect(agents.createOpts[0]!.meta.cwd).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("session-known-2");
    // Mapping now points at the fresh session so the plugin can persist it.
    expect(runner.sessionIdOf(PROJECT_BRAVO)).toBe(ok.sessionId);
  });

  it("FIFO: a second concurrent run is queued and runs after the first (one create, two turns)", async () => {
    const { agents, runner } = await makeRunner();
    agents.cfg({ holdIdle: true, answers: ["first answer", "second answer"] });
    const p1 = runner.run(PROJECT_ALPHA, "first task");
    await waitFor(() => agents.created.length === 1 && agents.created[0]!.agent.whenIdle.mock.calls.length === 1);
    const h1 = agents.created[0]!;
    // The first run is in flight; the second is accepted into the FIFO queue.
    let p2Settled = false;
    const p2 = runner.run(PROJECT_ALPHA, "second task");
    p2.then(() => {
      p2Settled = true;
    });
    await waitFor(() => p2Settled === false && h1.parkedCount >= 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(p2Settled).toBe(false);
    expect(agents.createOpts).toHaveLength(1);

    // Release the first turn's two idle waits, then the queued turn's two.
    await runToCompletion(h1, 2);
    const first = expectOk(await p1);
    expect(first.text).toBe("first answer");
    const second = expectOk(await p2);
    expect(second.text).toBe("second answer");

    expect(agents.createOpts).toHaveLength(1);
    expect(h1.agent.followup.mock.calls).toHaveLength(2);
    expect(first.sessionId).toBe(second.sessionId);
  });

  it("busy: a run duplicating the active task (or an already queued one) is refused", async () => {
    const { agents, runner } = await makeRunner();
    agents.cfg({ holdIdle: true });
    const p1 = runner.run(PROJECT_ALPHA, "do the thing");
    await waitFor(() => agents.created.length === 1 && agents.created[0]!.agent.whenIdle.mock.calls.length === 1);
    const h1 = agents.created[0]!;

    // Same text as the ACTIVE task: refused as busy, never duplicated.
    const busy = await runner.run(PROJECT_ALPHA, "do the thing");
    expect(busy).toEqual({ ok: false, code: "busy", message: expect.any(String) });

    // A different text queues; repeating the queued text is busy as well.
    const p2 = runner.run(PROJECT_ALPHA, "queued task");
    const busy2 = await runner.run(PROJECT_ALPHA, "queued task");
    expect((busy2 as { code?: string }).code).toBe("busy");
    void p2;

    await runToCompletion(h1, 2);
    expectOk(await p1);
    expectOk(await p2);
  });

  it("queue-full: at most three tasks wait per workspace; the fourth queued run is refused", async () => {
    const { agents, runner } = await makeRunner();
    agents.cfg({ holdIdle: true });
    const p1 = runner.run(PROJECT_ALPHA, "task 1");
    await waitFor(() => agents.created.length === 1 && agents.created[0]!.agent.whenIdle.mock.calls.length === 1);
    const h1 = agents.created[0]!;
    const p2 = runner.run(PROJECT_ALPHA, "task 2");
    const p3 = runner.run(PROJECT_ALPHA, "task 3");
    const p4 = runner.run(PROJECT_ALPHA, "task 4");
    // Three are waiting; the fourth waiting task is refused immediately.
    const full = await runner.run(PROJECT_ALPHA, "task 5");
    expect(full).toEqual({ ok: false, code: "queue-full", message: expect.any(String) });
    expect(agents.createOpts).toHaveLength(1);

    // Release everything: all four accepted tasks complete in FIFO order.
    await runToCompletion(h1, 4);
    const r1 = expectOk(await p1);
    const r2 = expectOk(await p2);
    const r3 = expectOk(await p3);
    const r4 = expectOk(await p4);
    for (const r of [r1, r2, r3, r4]) expect(r.sessionId).toBe(r1.sessionId);
    expect(agents.created[0]!.agent.followup.mock.calls).toHaveLength(4);
    expect(agents.createOpts).toHaveLength(1);
  });

  it("reset removes the handle and the mapping; the next run creates a fresh session", async () => {
    const { agents, runner } = await makeRunner();
    const first = expectOk(await runner.run(PROJECT_ALPHA, "one"));
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBe(first.sessionId);
    const handle = agents.created[0]!;

    await runner.reset(PROJECT_ALPHA);
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBeUndefined();
    expect(runner.snapshot()).toEqual([]);
    expect(handle.dispose).toHaveBeenCalledTimes(1);

    const second = expectOk(await runner.run(PROJECT_ALPHA, "two"));
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(agents.createOpts).toHaveLength(2);
  });

  it("reset on a key with no entry is a no-op", async () => {
    const { agents, runner } = await makeRunner();
    await expect(runner.reset(PROJECT_BRAVO)).resolves.toBeUndefined();
    expect(agents.created).toHaveLength(0);
  });

  it("reset during an in-flight turn settles run() and disposes the handle exactly once", async () => {
    const { agents, runner } = await makeRunner();
    // The fake parks the run mid-turn (the agent loop awaiting its provider);
    // dispose() aborts the loop exactly like the real dsh teardown (Task 1
    // fact 9): the parked whenIdle converges and later whenIdle calls reject,
    // because the agent is gone.
    agents.cfg({ holdIdle: true, disposeStopsLoop: true });
    const p1 = runner.run(PROJECT_ALPHA, "long task");
    await waitFor(() => agents.created.length === 1 && agents.created[0]!.agent.whenIdle.mock.calls.length === 1);
    const h1 = agents.created[0]!;
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBeTruthy();

    // A context reset lands while the turn is in flight.
    const resetP = runner.reset(PROJECT_ALPHA);
    // The in-flight run must SETTLE (a hang would leave the chat caller's
    // promise pending forever) — agent-error from the abort is acceptable.
    const result = await withTimeout(p1, 2000, "run() never settled after a mid-turn reset");
    await resetP;
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("agent-error");
    // Teardown is owned by reset: the in-flight turn must not dispose the
    // same handle a second time through its own error path.
    expect(h1.dispose).toHaveBeenCalledTimes(1);
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBeUndefined();
    expect(runner.snapshot()).toEqual([]);

    // The runner stays usable afterwards with a fresh session.
    agents.cfg({});
    const after = expectOk(await runner.run(PROJECT_ALPHA, "after reset"));
    expect(after.text).toBe("fake answer");
    expect(agents.createOpts).toHaveLength(2);
    expect(after.sessionId).toBeTruthy();
    expect(agents.created[1]!.dispose).not.toHaveBeenCalled();
  });

  /**
   * The reset/create race the whole-branch review found: reset() retires the
   * entry while `agents.create` (or `agents.resume`) is still resolving. The
   * entry it retired owned NO handle yet, so the handle that resolves afterwards
   * would never be disposed — a registered agent leaking until restart. Both
   * halves are asserted: the orphan is disposed exactly once, and run() settles
   * with the reset outcome instead of driving a discarded agent.
   */
  for (const kind of ["create", "resume"] as const) {
    it(`reset landing while ${kind} is still resolving disposes the orphaned handle exactly once`, async () => {
      const base = await mkdtemp(join(tmpdir(), "agenttask-"));
      const warn = vi.fn();
      const orphan = makeHandle({ answers: ["must never be used"] });
      let acquireStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        acquireStarted = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquire = async (): Promise<FakeHandle> => {
        acquireStarted();
        await gate;
        return orphan;
      };
      const deps: AgentTaskDeps = {
        agents: {
          create: acquire,
          resume: acquire
        } as unknown as AgentTaskDeps["agents"],
        sessions: { flush: vi.fn(async () => {}) },
        defaultModel: { currentSelection: () => SELECTION },
        workspaces: makeWorkspaces(base) as unknown as AgentTaskDeps["workspaces"],
        logger: { warn }
      };
      const runner = createAgentTaskRunner(deps);
      const opts = kind === "resume" ? { sessionId: "session-in-flight" } : undefined;
      const pending = runner.run(PROJECT_ALPHA, `task during ${kind}`, opts);
      // The entry exists and is busy, but its handle is still unresolved.
      await started;
      expect(runner.sessionIdOf(PROJECT_ALPHA)).toBeUndefined();

      // The reset lands mid-acquire: there is no handle to dispose yet.
      await runner.reset(PROJECT_ALPHA);
      expect(runner.snapshot()).toEqual([]);

      // The acquire now resolves with a live handle nobody owns any more.
      release();
      const result = await withTimeout(
        pending,
        2000,
        `run() never settled after a reset during ${kind}`
      );
      expect(result).toEqual({
        ok: false,
        code: "agent-error",
        message: "task aborted because the workspace context was reset"
      });
      // Disposed exactly once, by the post-acquire check (reset had nothing to
      // dispose, and the error path skips retired entries), and never driven.
      expect(orphan.dispose).toHaveBeenCalledTimes(1);
      expect(orphan.agent.followup).not.toHaveBeenCalled();
      expect(orphan.agent.whenIdle).not.toHaveBeenCalled();
      expect(runner.sessionIdOf(PROJECT_ALPHA)).toBeUndefined();
      expect(runner.snapshot()).toEqual([]);
      // The runner stays usable, and the next turn acquires a fresh handle.
      expect(warn).not.toHaveBeenCalled();
    });
  }

  it("workspace-gone: a workspaces.root throw maps to a safe result and never creates an agent", async () => {
    const { agents, runner } = await makeRunner();
    const result = await runner.run({ scope: "project", name: "gone" }, "anything");
    expect(result).toEqual({ ok: false, code: "workspace-gone", message: "project not found: gone" });
    expect(agents.createOpts).toHaveLength(0);
    expect(runner.snapshot()).toEqual([]);
  });

  it("agent-error: a whenIdle throw maps to agent-error without a stack, and the wedged handle is dropped", async () => {
    const { agents, runner } = await makeRunner();
    agents.cfg({ throwOnIdle: true, idleError: "loop exploded" });
    const result = await runner.run(PROJECT_ALPHA, "boom");
    expect(result).toEqual({ ok: false, code: "agent-error", message: "loop exploded" });
    const message = (result as Extract<TaskResult, { ok: false }>).message;
    expect(message).not.toMatch(/at |stack/i);
    expect(agents.created[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBeUndefined();

    // The runner self-heals: the next run creates a fresh agent.
    agents.cfg({});
    const after = expectOk(await runner.run(PROJECT_ALPHA, "again"));
    expect(after.text).toBe("fake answer");
    expect(agents.createOpts).toHaveLength(2);
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBe(after.sessionId);
  });

  it("two distinct keys produce two distinct sessions (snapshot shows both)", async () => {
    const { agents, runner } = await makeRunner();
    const alpha = expectOk(await runner.run(PROJECT_ALPHA, "alpha task"));
    const home = expectOk(await runner.run(HOME_REF, "home task"));
    expect(alpha.sessionId).not.toBe(home.sessionId);
    expect(agents.createOpts).toHaveLength(2);
    const snap = runner.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.find((e) => e.key === workspaceRefKey(PROJECT_ALPHA))?.sessionId).toBe(alpha.sessionId);
    expect(snap.find((e) => e.key === workspaceRefKey(HOME_REF))?.sessionId).toBe(home.sessionId);
  });

  it("workspaceRefKey encodes scope and project name", () => {
    expect(workspaceRefKey(HOME_REF)).toBe("home");
    expect(workspaceRefKey(PROJECT_ALPHA)).toBe("project:alpha");
  });
});

/**
 * The soft stop: cancel() aborts the active turn and drops the waiting queue
 * while the handle and its session stay alive — the whole point of having a
 * second stop next to reset(), which disposes the session (losing context).
 */
describe("cancel", () => {
  it("cancels the active turn and clears the queue while keeping the session", async () => {
    const { runner, agents } = await makeRunner();
    agents.cfg({ holdIdle: true });
    const running = runner.run(PROJECT_ALPHA, "долгая");
    await waitFor(() => agents.created.length === 1);
    const handle = agents.created[0]!;
    await waitFor(() => handle.parkedCount === 1);

    const queued = runner.run(PROJECT_ALPHA, "в очереди");
    const outcome = await runner.cancel(PROJECT_ALPHA);

    expect(outcome).toEqual({ cancelled: true, dropped: 1 });
    await expect(queued).resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(running).resolves.toMatchObject({ ok: false, code: "cancelled" });
    // The stop is the stock dsh seam, and `keepInbox` is what makes it soft:
    // work already in the agent's inbox survives, so the session goes on.
    expect(handle.agent.cancel).toHaveBeenCalledWith({ kind: "user" }, { keepInbox: true });
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBeDefined();
  });

  it("settles a turn that was already running as cancelled", async () => {
    const { runner, agents } = await makeRunner();
    agents.cfg({ holdIdle: true });
    const running = runner.run(PROJECT_ALPHA, "долгая");
    await waitFor(() => agents.created.length === 1);
    const handle = agents.created[0]!;
    await waitFor(() => handle.parkedCount === 1);
    handle.releaseParked();                                 // пропускаем followup
    await waitFor(() => handle.agent.followup.mock.calls.length === 1);
    await waitFor(() => handle.parkedCount === 1);          // парковка после followup

    const outcome = await runner.cancel(PROJECT_ALPHA);

    expect(outcome.cancelled).toBe(true);
    await expect(running).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(handle.dispose).not.toHaveBeenCalled();
  });

  /**
   * Plan-mandated: the stop that lands BEFORE the turn's first step. dsh says
   * that turn leaves a `turn/end` shaped exactly like the balanced no-op turns
   * a rejection or an empty claim produces. Reporting `{ ok: true, text: "" }`
   * for it would tell the owner "задача выполнена" about a task they just
   * stopped — the one user-visible lie the whole feature exists to avoid.
   */
  it("reports the stop that erased the turn before its first step as cancelled", async () => {
    const { runner, agents } = await makeRunner();
    agents.cfg({ holdIdle: true, cancelAsNoopTurn: true });
    const running = runner.run(PROJECT_ALPHA, "долгая");
    await waitFor(() => agents.created.length === 1);
    const handle = agents.created[0]!;
    await waitFor(() => handle.parkedCount === 1);
    handle.releaseParked();                                 // пропускаем followup
    await waitFor(() => handle.agent.followup.mock.calls.length === 1);
    await waitFor(() => handle.parkedCount === 1);          // парковка после followup

    const outcome = await runner.cancel(PROJECT_ALPHA);

    expect(outcome.cancelled).toBe(true);
    await expect(running).resolves.toMatchObject({ ok: false, code: "cancelled" });
    // The exact lie this arm removes: an empty success for a stopped task.
    await expect(running).resolves.not.toMatchObject({ ok: true, text: "" });
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBeDefined();
  });

  it("is a no-op when nothing runs", async () => {
    const { runner } = await makeRunner();
    await expect(runner.cancel(PROJECT_ALPHA)).resolves.toEqual({ cancelled: false, dropped: 0 });
  });

  /**
   * The race the reason gate exists for: cancel() lands AFTER the runner's last
   * checkpoint of the turn (here: while the session flush is in flight), so the
   * turn had already completed normally. The flag alone must not rewrite a
   * finished turn into "cancelled" — only an aborted turn may be reported as
   * one. The flush gate makes that window deterministic instead of a timing
   * accident.
   */
  it("does not turn a turn that already completed into cancelled", async () => {
    const base = await mkdtemp(join(tmpdir(), "agenttask-"));
    const agents = makeAgents();
    let flushStarted!: () => void;
    const flushing = new Promise<void>((resolve) => {
      flushStarted = resolve;
    });
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const deps: AgentTaskDeps = {
      agents: agents as unknown as AgentTaskDeps["agents"],
      sessions: {
        flush: vi.fn(async () => {
          flushStarted();
          await flushGate;
        })
      },
      defaultModel: { currentSelection: () => SELECTION },
      workspaces: makeWorkspaces(base) as unknown as AgentTaskDeps["workspaces"],
      logger: { warn: vi.fn() }
    };
    const runner = createAgentTaskRunner(deps);
    agents.cfg({ holdIdle: true, answers: ["готовый ответ"] });
    const running = runner.run(PROJECT_ALPHA, "долгая");
    await waitFor(() => agents.created.length === 1);
    const handle = agents.created[0]!;
    // Through the pre-followup park, then the post-followup park.
    await waitFor(() => handle.parkedCount === 1);
    handle.releaseParked();
    await waitFor(() => handle.agent.followup.mock.calls.length === 1);
    await waitFor(() => handle.parkedCount === 1);
    handle.releaseParked();
    // The turn is complete and the runner is now inside flush: cancel arrives
    // too late to stop anything (the fake's turn is closed, so no aborted
    // reason is ever appended).
    await flushing;
    const outcome = await runner.cancel(PROJECT_ALPHA);
    expect(outcome.cancelled).toBe(true);
    releaseFlush();

    await expect(running).resolves.toMatchObject({ ok: true, text: "готовый ответ" });
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBeDefined();
  });
});

/**
 * `composeAgentSetup` surface restriction, hermetic: a fake tools runtime stands
 * in for dsh-tools' `ToolRuntime` and records what the setup asked for. dsh's
 * own `restrict()` rejects a name the composition does not register (and
 * registration is platform-dependent: `bash` is absent on win32, `pwsh` absent
 * elsewhere), so the probe-before-filter behaviour is asserted here and the
 * real registry view is asserted by the REAL suite.
 */
interface FakeRestriction {
  allow?: readonly string[];
  deny?: readonly string[];
}
function makeTools(registered: string[]): {
  restrictions: FakeRestriction[];
  guards: Array<(exec: { name: string; arguments: unknown }) => string | undefined>;
  restrict(filter: FakeRestriction): () => void;
  guard(guard: (exec: { name: string; arguments: unknown }) => string | undefined): () => void;
  get(name: string): unknown;
} {
  const restrictions: FakeRestriction[] = [];
  const guards: Array<(exec: { name: string; arguments: unknown }) => string | undefined> = [];
  return {
    restrictions,
    guards,
    restrict(filter: FakeRestriction): () => void {
      // dsh-tools' own contract: an unknown global name is a hard error.
      for (const name of [...(filter.allow ?? []), ...(filter.deny ?? [])]) {
        if (!registered.includes(name)) throw new Error(`tools.restrict() names unknown global tool "${name}"`);
      }
      restrictions.push(filter);
      return () => {};
    },
    guard(guard): () => void {
      guards.push(guard);
      return () => {};
    },
    get(name: string): unknown {
      return registered.includes(name) ? { name } : undefined;
    }
  };
}

/** The agent scope context a real `setup` callback receives, reduced to seams. */
function makeAgentCtx(tools: unknown): { on(): () => void; get(key: string): unknown } {
  return {
    on: () => () => {},
    get: (key: string) => (key === "tools" ? tools : undefined)
  };
}

/**
 * The agent-scope context a real `setup` callback receives, recording the two
 * waterfall listeners `installModelSelection` installs so a test can drive one
 * prompt-assembly + request round by hand.
 */
function makeRecordingAgentCtx(): {
  ctx: { on(event: string, listener: never): () => void; get(key: string): unknown };
  appliedModel(): Promise<string | undefined>;
} {
  const listeners = new Map<string, unknown>();
  const tools = makeTools([]);
  return {
    ctx: {
      on(event: string, listener: never): () => void {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
      get: (key: string) => (key === "tools" ? tools : undefined)
    },
    async appliedModel(): Promise<string | undefined> {
      const assemble = listeners.get("system-prompt/assemble") as unknown as (
        assembly: unknown,
        context: unknown,
        next: () => Promise<unknown>
      ) => Promise<unknown>;
      const request = listeners.get("agent/request") as unknown as (
        payload: unknown,
        next: () => Promise<unknown>
      ) => Promise<unknown>;
      await assemble({}, {}, async () => ({ variables: {} }));
      const resolved = (await request({}, async () => ({ provider: "p", model: "m" }))) as { model?: string };
      return resolved.model;
    }
  };
}

/**
 * The allow list `composeAgentSetup` must apply on this deployment, name by
 * name. `web_search` is kept on purpose (internet search); `web_fetch` is NOT:
 * it is an egress channel to an arbitrary URL.
 */
const KEPT_BY_CONTRACT = [
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

describe("composeAgentSetup tool surface", () => {
  it("restricts the agent to the kept workspace tools and keeps the path guard", () => {
    // The deployment surface as the REAL suite observes it (26 tools), plus a
    // hypothetical tool a future dsh release adds.
    const registered = [
      ...KEPT_BY_CONTRACT,
      "bash",
      "str_replace_editor",
      "web_fetch",
      "skill",
      "subagent",
      "subagent_fork",
      "workflow",
      "ralph",
      "job_list",
      "job_output",
      "job_kill",
      "send_message",
      "interrupt_agent",
      "list_agents",
      "exit_plan_mode",
      "some_future_shell"
    ];
    const tools = makeTools(registered);
    composeAgentSetup(makeAgentCtx(tools), { root: "/tmp/ws-root", selection: { current: SELECTION } });

    expect(tools.restrictions).toHaveLength(1);
    // An allow filter, not a deny list: the unlisted future tool is removed by
    // construction. `deny` is never used on the primary path.
    expect(tools.restrictions[0]).toEqual({ allow: KEPT_BY_CONTRACT });
    expect(registered.filter((n) => !KEPT_BY_CONTRACT.includes(n))).toContain("some_future_shell");

    // Defense in depth: the per-agent path guard is still registered beside it.
    expect(tools.guards).toHaveLength(1);
    const guard = tools.guards[0]!;
    expect(guard({ name: "read", arguments: { file_path: "notes.txt" } })).toBeUndefined();
    expect(guard({ name: "read", arguments: { file_path: "../bravo/secret.txt" } })).toContain("outside the workspace root");
  });

  /**
   * Owner decision (containment split): a Telegram task may SEARCH the internet
   * but may not FETCH an arbitrary URL. `web_search` is a provider-mediated
   * search that cannot post data to an attacker's address; `web_fetch` is an
   * egress channel to any URL a prompt injection names (indirect
   * prompt-injection exfiltration). So with BOTH registered the applied
   * restriction keeps the first and never the second.
   */
  it("keeps web_search but never web_fetch when the deployment registers both", () => {
    // Both web tools are registered here (the REAL suite confirms `web_search`
    // and `web_fetch` on the live registry), and only search survives.
    const registered = [...KEPT_BY_CONTRACT, "web_fetch", "bash"];
    const tools = makeTools(registered);
    composeAgentSetup(makeAgentCtx(tools), { root: "/tmp/ws-root", selection: { current: SELECTION } });

    expect(registered).toContain("web_search");
    expect(registered).toContain("web_fetch");
    expect(tools.restrictions).toHaveLength(1);
    const filter = tools.restrictions[0]!;
    expect(filter.allow).toContain("web_search");
    expect(filter.allow).not.toContain("web_fetch");
    // The exact list, so the split cannot drift to "both" or "neither" silently.
    expect(filter).toEqual({ allow: KEPT_BY_CONTRACT });
    // The keep is an allow entry, never a deny of the other name.
    expect(filter.deny).toBeUndefined();
  });

  it("names only registered tools, so a platform-dependent surface cannot throw", () => {
    // A Windows-shaped composition: `bash` is not registered, `pwsh` is, and no
    // goal/todo tools exist. A hardcoded allow list containing `bash` would make
    // dsh reject the whole restriction and fail every task.
    const tools = makeTools(["read", "write", "pwsh", "web_fetch"]);
    expect(() =>
      composeAgentSetup(makeAgentCtx(tools), { root: "/tmp/ws-root", selection: { current: SELECTION } })
    ).not.toThrow();
    expect(tools.restrictions).toEqual([{ allow: ["read", "write"] }]);
  });

  it("degrades to the names it knows must never be exposed when no kept tool is registered", () => {
    const tools = makeTools(["bash", "pwsh", "web_fetch", "skill", "interrupt_agent"]);
    composeAgentSetup(makeAgentCtx(tools), { root: "/tmp/ws-root", selection: { current: SELECTION } });
    // No allow filter is possible (nothing to keep would be an empty surface):
    // the fallback still removes every name it knows the surface must never
    // expose — and only those, which is its weaker guarantee.
    expect(tools.restrictions).toEqual([{ deny: ["bash", "pwsh", "web_fetch", "skill", "interrupt_agent"] }]);
    expect(tools.guards).toHaveLength(1);
  });

  it("asks for no restriction when the deployment registers nothing it knows", () => {
    const tools = makeTools(["totally_unknown_tool"]);
    composeAgentSetup(makeAgentCtx(tools), { root: "/tmp/ws-root", selection: { current: SELECTION } });
    expect(tools.restrictions).toEqual([]);
  });

  it("is a no-op without a tools service", () => {
    expect(() =>
      composeAgentSetup(makeAgentCtx(undefined), { root: "/tmp/ws-root", selection: { current: SELECTION } })
    ).not.toThrow();
  });

  /**
   * The runner hands the SAME setup callback to `agents.create` and
   * `agents.resume`; this drives each one exactly as the registry would and
   * shows the restriction (and the guard) landing in the agent scope either
   * way, so a resumed session cannot come back with the full tool surface.
   */
  it("installs the restriction and the guard in both the create and the resume setup", async () => {
    const registered = [...KEPT_BY_CONTRACT, "bash", "str_replace_editor", "web_fetch"];
    const created = await makeRunner();
    await created.runner.run(PROJECT_ALPHA, "first task");
    expect(created.agents.createOpts).toHaveLength(1);
    const createTools = makeTools(registered);
    created.agents.createOpts[0]!.setup(makeAgentCtx(createTools));
    expect(createTools.restrictions).toEqual([{ allow: KEPT_BY_CONTRACT }]);
    expect(createTools.guards).toHaveLength(1);
    // The setup carries the resolved workspace root of the key.
    expect(createTools.guards[0]!({ name: "read", arguments: { file_path: "../x" } })).toContain(
      "outside the workspace root"
    );

    const resumed = await makeRunner();
    await resumed.runner.run(PROJECT_BRAVO, "resume me", { sessionId: "session-known" });
    expect(resumed.agents.resumeOpts).toHaveLength(1);
    expect(resumed.agents.createOpts).toHaveLength(0);
    const resumeTools = makeTools(registered);
    resumed.agents.resumeOpts[0]!.setup(makeAgentCtx(resumeTools));
    expect(resumeTools.restrictions).toEqual([{ allow: KEPT_BY_CONTRACT }]);
    expect(resumeTools.guards).toHaveLength(1);
  });
});

describe("live model selection", () => {
  it("resolves every request through the current global default", async () => {
    let selection = { provider: "deepseek-official", model: "deepseek-v4-flash" };
    const recorder = makeRecordingAgentCtx();

    composeAgentSetup(recorder.ctx, {
      root: "/tmp/ws-root",
      selection: {
        get current() {
          return selection;
        },
        assembled: undefined
      }
    });

    expect(await recorder.appliedModel()).toBe("deepseek-v4-flash");

    selection = { provider: "deepseek-official", model: "deepseek-v4-pro" };

    expect(await recorder.appliedModel()).toBe("deepseek-v4-pro");
  });

  /**
   * The task's actual deliverable is the RUNNER's own re-read of the global
   * default, not `composeAgentSetup`'s pass-through. The test above builds its
   * own ref and calls `composeAgentSetup` directly, so it stays green if
   * `liveSelection` hands dsh a frozen snapshot instead of a getter. This test
   * closes that hole: it drives the `setup` closure the runner really installed
   * on `agents.create` (`agents.createOpts[0].setup`, the seam dsh calls with
   * the agent scope) and flips the spied global default between two
   * assembly+request rounds against that one installed ref, so the model
   * resolved per request must follow the CURRENT default.
   */
  it("re-reads the current global default through the runner's installed setup", async () => {
    const { agents, deps, runner } = await makeRunner();
    await runner.run(PROJECT_ALPHA, "первая");

    expect(agents.createOpts).toHaveLength(1);
    const recorder = makeRecordingAgentCtx();
    agents.createOpts[0]!.setup(recorder.ctx);

    vi.spyOn(deps.defaultModel!, "currentSelection").mockReturnValue({
      provider: "deepseek-official",
      model: "deepseek-v4-flash"
    });
    expect(await recorder.appliedModel()).toBe("deepseek-v4-flash");

    vi.spyOn(deps.defaultModel!, "currentSelection").mockReturnValue({
      provider: "deepseek-official",
      model: "deepseek-v4-pro"
    });
    expect(await recorder.appliedModel()).toBe("deepseek-v4-pro");
  });

  it("keeps the session id when the default changes between turns", async () => {
    const { runner, deps } = await makeRunner();
    const first = await runner.run(PROJECT_ALPHA, "первая");
    const sessionId = expectOk(first).sessionId;

    vi.spyOn(deps.defaultModel!, "currentSelection").mockReturnValue({
      provider: "deepseek-official",
      model: "deepseek-v4-pro"
    });

    const second = await runner.run(PROJECT_ALPHA, "вторая");

    expect(expectOk(second).sessionId).toBe(sessionId);
  });
});
