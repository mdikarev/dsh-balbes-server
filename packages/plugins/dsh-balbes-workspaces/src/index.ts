import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { ensureHome, listWorkspaces, createProject, deleteProject, WorkspaceError } from "./workspaces.js";
import { readWorkspaceDir, type WorkspaceScope } from "./tree.js";
import { createWorkspacesService } from "./service.js";
import { createChangeHub } from "./events.js";

export const name = "balbes-workspaces";
export const inject = ["balbesHttp"];
export const Config = z.object({ dshHome: z.string() });

interface HttpSeatLike {
  post(path: string, auth: "public" | "bearer", handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void): void;
}
interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
  write(chunk: string): boolean;
  on(event: "close", listener: () => void): unknown;
  destroyed: boolean;
  writableEnded: boolean;
}

function send(res: ResLike, status: number, body: unknown): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload))
  });
  res.end(payload);
}

export function apply(ctx: {
  get(key: string): unknown;
  provide(key: string, value: unknown): void;
  logger: { warn(m: string): void };
}, config: { dshHome?: string }): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-workspaces: balbesHttp service missing; routes not registered");
    return;
  }
  // resolve the data home the same way auth/static do (config wins, env falls back)
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");

  // The home must exist from boot onward; a failure is logged, never fatal.
  ensureHome(dshHome).catch((error: unknown) => {
    ctx.logger.warn(`balbes-workspaces: ensureHome failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  // Facade for later stages (telegram chat, admin, agentTask): list/root/read
  // workspaces without an HTTP loopback. Independent of the route seats below.
  ctx.provide("balbesWorkspaces", createWorkspacesService(dshHome));

  http.post("/api/workspaces/list", "bearer", async (_req, res) => {
    try {
      const result = await listWorkspaces(dshHome);
      send(res, 200, result);
    } catch (error) {
      send(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  http.post("/api/workspaces/create", "bearer", async (_req, res, body) => {
    const b = body as { name?: unknown };
    const rawName = typeof b?.name === "string" ? b.name : "";
    try {
      const project = await createProject(dshHome, rawName);
      send(res, 200, { project });
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const status = error.code === "invalid-name" ? 400 : error.code === "name-exists" ? 409 : 500;
        send(res, status, { error: { code: error.code, message: error.message } });
        return;
      }
      send(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  http.post("/api/workspaces/delete", "bearer", async (_req, res, body) => {
    const b = body as { name?: unknown };
    const rawName = typeof b?.name === "string" ? b.name : "";
    try {
      await deleteProject(dshHome, rawName);
      send(res, 200, {});
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const status = error.code === "invalid-name" ? 400 : error.code === "not-found" ? 404 : 500;
        send(res, status, { error: { code: error.code, message: error.message } });
        return;
      }
      send(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  http.post("/api/workspaces/tree", "bearer", async (_req, res, body) => {
    const b = body as { scope?: unknown; name?: unknown; path?: unknown };
    const scope = (typeof b?.scope === "string" ? b.scope : "") as WorkspaceScope;
    const name = typeof b?.name === "string" ? b.name : undefined;
    const path = typeof b?.path === "string" ? b.path : "";
    try {
      const entries = await readWorkspaceDir(dshHome, scope, name, path);
      send(res, 200, { entries });
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const status = error.code === "invalid-name" || error.code === "invalid-path" ? 400 : error.code === "not-found" ? 404 : 500;
        send(res, status, { error: { code: error.code, message: error.message } });
        return;
      }
      send(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  const changeHub = createChangeHub(dshHome);
  http.post("/api/workspaces/events", "bearer", async (_req, res, body) => {
    void body; // events request body is {} (R-API-1)
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    const sendEvent = (e: unknown): void => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = changeHub.subscribe(sendEvent);
    const heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      res.write(": ping\n\n");
    }, 25_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on("close", cleanup);
    // The stream lives until the client disconnects; dispatch must not end it.
  });
}
