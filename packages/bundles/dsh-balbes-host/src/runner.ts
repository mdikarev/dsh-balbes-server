import { randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";

export interface PromptOutcome {
  text: string;
  reason?: { kind: string; code?: string; message?: string };
}

/** Structural slice of a Session event this runner reads (types are best-effort vs dsh-core public d.ts). */
interface SessionEventLike {
  type: string;
  data: {
    message?: { content?: Array<{ type: string; text?: string }> };
    reason?: unknown;
  };
}

/** Structural slice of the Agent returned by the agents registry (see dsh-headless). */
interface AgentLike {
  whenIdle(): Promise<void>;
  followup(message: unknown): void;
  session: {
    seq: number;
    eventAt(seq: number): SessionEventLike | undefined;
  };
}

interface AgentsService {
  create(opts: {
    sessionId: string;
    meta: { cwd: string };
    agentOptions: { provider: string; model: string };
    setup: (agentCtx: unknown) => void;
  }): Promise<{ agent: AgentLike; session: unknown }>;
}

interface DefaultModelService {
  currentSelection(): { provider: string; model: string };
}

interface SessionsService {
  flush(session: unknown): Promise<void>;
}

function errorReason(code: string, message: string): NonNullable<PromptOutcome["reason"]> {
  return { kind: "error", code, message };
}

/**
 * Run one prompt through a freshly created agent (the dsh-headless runner
 * seam, see spec 9.2.4). The session gets a new sessionId and is persisted
 * through sessions.flush — the stage-2 boundary: an agent never lives
 * between requests.
 *
 * Mirrors @deepseek-ai/dsh-headless/lib/index.js `run()` minus its stdout,
 * stderr-reasoning stream, and process exit: loader.await() →
 * agentDefaultModel.currentSelection() → agents.create({...}) →
 * followup(createUserMessage(...)) → whenIdle() → sessions.flush() → the
 * final assistant text and turn outcome aggregated from session events.
 */
export async function runPrompt(ctx: { get(key: string): unknown }, prompt: string): Promise<PromptOutcome> {
  const loader = ctx.get("loader") as { await(): Promise<void> } | undefined;
  await loader?.await();
  const agents = ctx.get("agents") as AgentsService | undefined;
  const defaultModel = ctx.get("agentDefaultModel") as DefaultModelService | undefined;
  const sessions = ctx.get("sessions") as SessionsService | undefined;
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    return { text: "", reason: errorReason("core-unavailable", "agent core services missing") };
  }

  const selection = defaultModel.currentSelection();
  const { agent } = await agents.create({
    sessionId: brandString(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx as never, { current: selection, assembled: undefined });
    }
  });
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(
    createUserMessage({
      content: [{ type: "text", text: prompt }],
      source: { kind: "user" }
    }) as never
  );
  await agent.whenIdle();
  await sessions.flush(agent.session);

  let started = false;
  let text = "";
  let reason: NonNullable<PromptOutcome["reason"]> | undefined;
  const length = agent.session.seq;
  for (let seq = firstSeq; seq < length; seq++) {
    const event = agent.session.eventAt(SessionSeq(seq));
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
      const r = event.data.reason as { kind: string; error?: { code?: string; message?: string } } | undefined;
      if (r?.kind === "error") {
        const detail: NonNullable<PromptOutcome["reason"]> = { kind: "error" };
        if (r.error?.code !== undefined) detail.code = r.error.code;
        if (r.error?.message !== undefined) detail.message = r.error.message;
        reason = detail;
      } else {
        reason = { kind: r?.kind ?? "completed" };
      }
    }
  }
  const outcome: PromptOutcome = { text };
  if (reason !== undefined) outcome.reason = reason;
  return outcome;
}
