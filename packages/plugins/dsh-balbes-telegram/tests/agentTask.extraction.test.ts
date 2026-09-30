import { describe, expect, it, vi } from "vitest";
import { createAgentTaskRunner, type AgentTaskDeps, type WorkspaceRef } from "../src/agentTask.js";

const REF: WorkspaceRef = { scope: "project", name: "alpha" };

function messageText(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}

interface FakeHandle {
  events: Array<{ type: string; data: unknown }>;
  calls: string[];
  disposed: boolean;
  agent: {
    session: { readonly seq: number; eventAt(seq: number): unknown };
    whenIdle(): Promise<void>;
    followup(message: unknown): void;
    cancel(...args: unknown[]): void;
    status: string;
  };
  dispose(): Promise<void>;
}

function fakeHandle(options: {
  toolCall?: boolean;
  errorOnCall?: number;
  failOnCall?: number;
  abortOnCall?: number;
  onCall?: (index: number) => void;
}): FakeHandle {
  const events: Array<{ type: string; data: unknown }> = [];
  const calls: string[] = [];
  const handle: FakeHandle = {
    events,
    calls,
    disposed: false,
    agent: {
      session: {
        get seq(): number {
          return events.length;
        },
        eventAt(seq: number) {
          return events[seq];
        }
      },
      whenIdle: async () => {},
      followup: (message: unknown) => {
        const index = calls.length + 1;
        calls.push(messageText(message));
        options.onCall?.(index);
        if (options.failOnCall === index) throw new Error("driver blew up");
        events.push({ type: "turn/start", data: {} });
        if (options.toolCall === true && index === 1) {
          events.push({
            type: "tool/call",
            data: { callId: "c1", name: "read", arguments: '{"file_path":"notes.txt"}' }
          });
        }
        events.push({
          type: "assistant/message",
          data: { message: { content: [{ type: "text", text: "answer " + index }] } }
        });
        events.push({
          type: "turn/end",
          data: {
            reason:
              options.errorOnCall === index
                ? { kind: "error", error: { code: "agent-error", message: "boom" } }
                : options.abortOnCall === index
                  ? { kind: "aborted" }
                  : { kind: "completed" }
          }
        });
      },
      cancel: () => {},
      status: "idle"
    },
    dispose: async () => {
      handle.disposed = true;
    }
  };
  return handle;
}

interface SeatCalls {
  qualifies: Array<{ ok: boolean; toolCalls: number }>;
  begin: number;
  end: number;
  messages: string[];
}

function extractionSeat(options: { allow?: boolean; beginError?: Error } = {}) {
  const calls: SeatCalls = { qualifies: [], begin: 0, end: 0, messages: [] };
  const handle = {
    qualifies(facts: { ok: boolean; toolCalls: number }): boolean {
      calls.qualifies.push(facts);
      return (options.allow ?? true) && facts.ok && facts.toolCalls > 0;
    },
    begin(): { message: string } {
      if (options.beginError !== undefined) throw options.beginError;
      calls.begin += 1;
      const message = "служебная директива: propose_memory";
      calls.messages.push(message);
      return { message };
    },
    end(): void {
      calls.end += 1;
    }
  };
  return { handle, calls };
}

/**
 * The design settles the owner's answer BEFORE the service turn (spec
 * «Служебный ход» step 2: the owner must not wait for bookkeeping), so the
 * await of `run()` resumes while the service turn is still in flight. A test
 * that asserts the service turn's effects therefore awaits the turn's own
 * completion first — the mandated `end === 1` assertion, polled until it
 * holds (never merely assumed from the await above).
 */
async function waitForServiceTurn(seat: { calls: SeatCalls }): Promise<void> {
  await vi.waitFor(() => {
    expect(seat.calls.end).toBe(1);
  });
}

function makeDeps(options: {
  extraction?: ReturnType<typeof extractionSeat>["handle"];
  toolCall?: boolean;
  errorOnCall?: number;
  failOnCall?: number;
  abortOnCall?: number;
  onCall?: (index: number) => void;
}) {
  const handle = fakeHandle(options);
  const warnings: string[] = [];
  const prepares: string[] = [];
  const flushes: number[] = [];
  let creates = 0;
  const deps = {
    workspaces: {
      list: async () => ({}),
      root: async () => "/home",
      readDir: async () => [],
      readFile: async () => ({})
    },
    agents: {
      create: async (o: { setup: (agentCtx: unknown) => void }) => {
        creates += 1;
        o.setup({ on: () => () => {} });
        return handle;
      },
      resume: async () => {
        throw new Error("no session to resume");
      }
    },
    sessions: {
      flush: async () => {
        flushes.push(handle.events.length);
      }
    },
    defaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
    logger: { warn: (message: string) => warnings.push(message) },
    memory: {
      attach: () => ({
        prepare: async (text: string) => {
          prepares.push(text);
        },
        ...(options.extraction === undefined ? {} : { extraction: options.extraction })
      })
    }
  } as unknown as AgentTaskDeps;
  return { deps, handle, warnings, prepares, flushes, creates: () => creates };
}

describe("agentTask memory extraction", () => {
  it("runs one extraction turn after a successful task that used a tool, keeping the task answer", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: true });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");
    await waitForServiceTurn(seat);

    expect(result).toMatchObject({ ok: true, text: "answer 1" });
    expect(seat.calls.qualifies).toEqual([{ ok: true, toolCalls: 1 }]);
    expect(seat.calls.begin).toBe(1);
    expect(seat.calls.end).toBe(1);
    expect(state.handle.calls).toEqual(["сделай работу", seat.calls.messages[0]]);
    expect(state.handle.calls[1]).toContain("propose_memory");
    expect(state.prepares).toEqual(["сделай работу"]);
    // the task turn and the extraction turn are each flushed
    expect(state.flushes).toHaveLength(2);
    expect(state.warnings).toEqual([]);
  });

  it("settles the task answer before the service turn finishes", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: true });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");

    // The caller's await resumed with the service turn already STARTED but not
    // finished: `begin` ran synchronously inside `runExtractionTurn`, while
    // `end` waits on the turn's own awaits. The fake's `whenIdle` yields (an
    // async function returning an already-resolved promise), so the order is
    // deterministic: reversing it in src (awaiting the extraction turn before
    // `task.resolve`) makes `end` 1 here and turns this test red.
    expect(seat.calls.begin).toBe(1);
    expect(seat.calls.end).toBe(0);
    expect(result).toMatchObject({ ok: true, text: "answer 1" });

    await waitForServiceTurn(seat);
    expect(seat.calls.end).toBe(1);
  });

  it("does not extract when the task used no tool", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: false });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "привет");

    expect(result).toMatchObject({ ok: true, text: "answer 1" });
    expect(seat.calls.qualifies).toEqual([{ ok: true, toolCalls: 0 }]);
    expect(seat.calls.begin).toBe(0);
    expect(state.handle.calls).toHaveLength(1);
  });

  it("does not extract when the task failed", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: true, errorOnCall: 1 });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");

    expect(result).toMatchObject({ ok: false, code: "agent-error" });
    expect(seat.calls.qualifies).toEqual([]);
    expect(seat.calls.begin).toBe(0);
    expect(state.handle.calls).toHaveLength(1);
  });

  it("honours the layer veto", async () => {
    const seat = extractionSeat({ allow: false });
    const state = makeDeps({ extraction: seat.handle, toolCall: true });
    const runner = createAgentTaskRunner(state.deps);

    await runner.run(REF, "сделай работу");

    expect(seat.calls.begin).toBe(0);
    expect(state.handle.calls).toHaveLength(1);
  });

  it("contains a failing extraction turn, restores the surface and keeps the task result", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: true, failOnCall: 2 });
    const runner = createAgentTaskRunner(state.deps);

    const first = await runner.run(REF, "сделай работу");
    await waitForServiceTurn(seat);

    expect(first).toMatchObject({ ok: true, text: "answer 1" });
    expect(seat.calls.end).toBe(1);
    expect(state.warnings.join("\n")).toContain("memory extraction turn failed");
    // a driver-level failure wedges the agent: same policy as a failed task
    expect(state.handle.disposed).toBe(true);
    const second = await runner.run(REF, "новая задача");
    expect(second.ok).toBe(true);
    expect(state.creates()).toBe(2);
  });

  it("survives an aborted extraction turn and warns about it", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: true, abortOnCall: 2 });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");
    await waitForServiceTurn(seat);

    expect(result).toMatchObject({ ok: true, text: "answer 1" });
    expect(seat.calls.end).toBe(1);
    expect(state.warnings.join("\n")).toContain("memory extraction turn ended as aborted");
    expect(state.handle.disposed).toBe(false);
  });

  it("skips extraction when it cannot start and reports it", async () => {
    const seat = extractionSeat({ beginError: new Error("no memory") });
    const state = makeDeps({ extraction: seat.handle, toolCall: true });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");

    expect(result).toMatchObject({ ok: true, text: "answer 1" });
    expect(state.handle.calls).toHaveLength(1);
    expect(state.warnings.join("\n")).toContain("memory extraction could not start");
  });

  it("works without an extraction seat at all", async () => {
    const state = makeDeps({ toolCall: true });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");

    expect(result).toMatchObject({ ok: true, text: "answer 1" });
    expect(state.handle.calls).toHaveLength(1);
    expect(state.flushes).toHaveLength(1);
  });

  it("tolerates a cancel landing during the extraction turn and serves the next task", async () => {
    const seat = extractionSeat();
    let runner!: ReturnType<typeof createAgentTaskRunner>;
    const state = makeDeps({
      extraction: seat.handle,
      toolCall: true,
      onCall: (index) => {
        if (index === 2) void runner.cancel(REF);
      }
    });
    runner = createAgentTaskRunner(state.deps);

    const first = await runner.run(REF, "сделай работу");
    await waitForServiceTurn(seat);

    expect(first).toMatchObject({ ok: true, text: "answer 1" });
    expect(seat.calls.end).toBe(1);
    const next = await runner.run(REF, "следующая задача");
    expect(next.ok).toBe(true);
  });

  it("queues the next task while the service turn is still running", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: true });
    const runner = createAgentTaskRunner(state.deps);

    const first = await runner.run(REF, "сделай работу");
    expect(first).toMatchObject({ ok: true, text: "answer 1" });
    // The service turn is in flight: the workspace is still busy, so the next
    // task must queue instead of interleaving as a second turn.
    expect(seat.calls.begin).toBe(1);
    expect(seat.calls.end).toBe(0);

    const secondPromise = runner.run(REF, "следующая задача");
    await waitForServiceTurn(seat);
    const second = await secondPromise;

    expect(second).toMatchObject({ ok: true, text: "answer 3" });
    // Exactly one followup per task and one for the directive, in order: the
    // second task was serialized AFTER the service turn, never inside it.
    expect(state.handle.calls).toEqual(["сделай работу", seat.calls.messages[0], "следующая задача"]);
    expect(seat.calls.begin).toBe(1);
  });

  it("contains a reset landing during the extraction turn and starts a fresh agent", async () => {
    const seat = extractionSeat();
    let runner!: ReturnType<typeof createAgentTaskRunner>;
    const state = makeDeps({
      extraction: seat.handle,
      toolCall: true,
      onCall: (index) => {
        if (index === 2) void runner.reset(REF);
      }
    });
    runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");
    expect(result).toMatchObject({ ok: true, text: "answer 1" });

    await waitForServiceTurn(seat);

    // The retired path still restores the surface (`finally`), and reset alone
    // owns the disposal — the extraction turn must not dispose the handle twice.
    expect(seat.calls.end).toBe(1);
    expect(state.handle.disposed).toBe(true);
    const next = await runner.run(REF, "новая задача");
    expect(next.ok).toBe(true);
    expect(state.creates()).toBe(2);
  });
});
