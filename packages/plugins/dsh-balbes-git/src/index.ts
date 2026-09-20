import z from "@deepseek-ai/schemastery";
import { type GitCredentialsLike } from "./credentials.js";
import { createBalbesGitService } from "./service.js";

export const name = "balbes-git";
export const inject = ["balbesHttp", "credentials"];
export const Config = z.object({ gitTimeoutMs: z.number().default(120_000) });

interface HttpSeatLike {
  post(path: string, auth: "public" | "bearer", handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void): void;
}
interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function send(res: ResLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
  res.end(payload);
}
function fail(res: ResLike, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function apply(
  ctx: {
    get(key: string): unknown;
    provide(key: string, value: unknown): void;
    logger: { warn(m: string): void };
  },
  config: { gitTimeoutMs?: number } | undefined
): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-git: balbesHttp service missing; routes not registered");
    return;
  }
  const credentials = ctx.get("credentials") as GitCredentialsLike;
  const service = createBalbesGitService({
    credentials,
    ...(config?.gitTimeoutMs === undefined ? {} : { timeoutMs: config.gitTimeoutMs })
  });
  ctx.provide("balbesGit", service);

  http.post("/api/git/status", "bearer", async (_req, res) => {
    try {
      send(res, 200, { git: await service.status() });
    } catch (error) {
      fail(res, 500, "internal", messageOf(error));
    }
  });

  http.post("/api/git/save", "bearer", async (_req, res, body) => {
    try {
      const token = (body as { token?: unknown } | null | undefined)?.token;
      if (typeof token !== "string" || token.trim() === "") return fail(res, 400, "invalid-token", "token is required");
      await service.setToken(token.trim());
      send(res, 200, { git: await service.status() });
    } catch (error) {
      fail(res, 500, "internal", messageOf(error));
    }
  });

  http.post("/api/git/clear-token", "bearer", async (_req, res) => {
    try {
      await service.clearToken();
      send(res, 200, { git: await service.status() });
    } catch (error) {
      fail(res, 500, "internal", messageOf(error));
    }
  });
}
