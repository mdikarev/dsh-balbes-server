import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { WorkspaceSessionsRegistry, type WorkspaceRef } from "./registry.js";
import { createSessionsService, type BalbesSessionsService } from "./service.js";

export const name = "balbes-sessions";
export const inject = ["balbesHttp", "balbesWorkspaces", "sessionQuery"];
export const Config = z.object({ dshHome: z.string() });

interface HttpSeatLike {
  post(path: string, auth: "public" | "bearer", handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void): void;
}

interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** Структурный срез сервиса воркспейсов (как в telegram: без импорта чужого плагина). */
interface WorkspacesSlice {
  list(): Promise<{ home: { path: string }; projects: Array<{ name: string; path: string }> }>;
}

/** Структурный срез движка сессий: только точное чтение заголовков. */
interface SessionQuerySlice {
  readTitleSnapshots(ids: readonly string[]): Promise<TitleObservation[]>;
}

type TitleObservation =
  | {
      sessionId: string;
      status: "fulfilled";
      value: { session: { createdAt: number }; title?: { title: string } };
    }
  | { sessionId: string; status: "rejected"; reason: unknown };

interface SessionRow {
  id: string;
  title: string | null;
  channel: string;
  createdAt: string;
}

function send(res: ResLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload))
  });
  res.end(payload);
}

/** Разбор тела `sessions.list`: отказ называет, что именно не так. */
function parseListRequest(body: unknown): { ok: true; ref: WorkspaceRef } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }
  const b = body as { scope?: unknown; name?: unknown };
  if (b.scope === "home") {
    if (b.name !== undefined) return { ok: false, message: "name is not allowed for the home workspace" };
    return { ok: true, ref: { scope: "home" } };
  }
  if (b.scope === "project") {
    if (typeof b.name !== "string" || b.name === "") {
      return { ok: false, message: "name is required for a project workspace" };
    }
    return { ok: true, ref: { scope: "project", name: b.name } };
  }
  return { ok: false, message: 'scope must be "home" or "project"' };
}

export function apply(ctx: {
  get(key: string): unknown;
  provide(key: string, value: unknown): void;
  logger: { warn(m: string): void };
}, config: { dshHome?: string }): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-sessions: balbesHttp service missing; routes not registered");
    return;
  }
  const workspaces = ctx.get("balbesWorkspaces") as WorkspacesSlice | undefined;
  const query = ctx.get("sessionQuery") as SessionQuerySlice | undefined;
  if (workspaces === undefined || query === undefined) {
    ctx.logger.warn("balbes-sessions: balbesWorkspaces/sessionQuery missing; routes not registered");
    return;
  }
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const store = new WorkspaceSessionsRegistry(WorkspaceSessionsRegistry.defaultFile(dshHome));
  const service: BalbesSessionsService = createSessionsService(store);
  ctx.provide("balbesSessions", service);

  http.post("/api/sessions/list", "bearer", async (_req, res, body) => {
    const parsed = parseListRequest(body);
    if (!parsed.ok) {
      send(res, 400, { error: { code: "bad-request", message: parsed.message } });
      return;
    }
    const ref = parsed.ref;
    try {
      // Опечатка в имени проекта должна давать 404, а не «пустой список».
      const { projects } = await workspaces.list();
      if (ref.scope === "project" && !projects.some((project) => project.name === ref.name)) {
        send(res, 404, { error: { code: "not-found", message: `project not found: ${ref.name}` } });
        return;
      }
      const entries = await service.list(ref);
      const observations = await query.readTitleSnapshots(entries.map((entry) => entry.sessionId));
      const channels = new Map(entries.map((entry) => [entry.sessionId, entry.channel]));
      const sessions: SessionRow[] = observations
        .filter((observation): observation is Extract<TitleObservation, { status: "fulfilled" }> =>
          observation.status === "fulfilled"
        )
        .map((observation) => ({
          id: observation.sessionId,
          title: observation.value.title?.title ?? null,
          channel: channels.get(observation.sessionId) ?? "unknown",
          createdAt: new Date(observation.value.session.createdAt).toISOString()
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      send(res, 200, { sessions });
    } catch (error) {
      send(res, 500, {
        error: { code: "internal", message: error instanceof Error ? error.message : String(error) }
      });
    }
  });
}
