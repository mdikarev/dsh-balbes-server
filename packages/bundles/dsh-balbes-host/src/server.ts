import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import z from "@deepseek-ai/schemastery";
import type { BalbesHttp, HttpHandler, HttpSeat, StaticResult } from "./types.js";

export const name = "balbes-server";
export const Config = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().default(8080)
});
export const inject: string[] = [];

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { "content-type": type, "content-length": body.length });
    res.end(body);
    return;
  }
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function apply(ctx: {
  get(key: string): unknown;
  provide(key: string, value: BalbesHttp): void;
  on(event: string, listener: (...args: never[]) => void): void;
  config: { host: string; port: number };
  logger: { warn(msg: string): void };
}): void {
  const seats: HttpSeat[] = [];
  let staticServe: ((pathname: string) => Promise<StaticResult | null>) | null = null;
  let server: Server | null = null;

  const http: BalbesHttp = {
    post(path, auth, handler) {
      seats.push({ method: "POST", path, auth, handler });
    },
    registerStatic(serve) {
      staticServe = serve;
    }
  };
  ctx.provide("balbesHttp", http);

  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (url.pathname.startsWith("/api/")) {
      const seat = seats.find((s) => s.method === method && s.path === url.pathname);
      if (seat === undefined) {
        send(res, 404, { error: { code: "not-found", message: `no route ${method} ${url.pathname}` } });
        return;
      }
      if (seat.auth === "bearer") {
        const authService = ctx.get("balbesAuth") as { verify(token: string): { login: string } | null } | undefined;
        if (authService === undefined) {
          send(res, 503, { error: { code: "auth-unavailable", message: "auth service not ready" } });
          return;
        }
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
        const payload = token === "" ? null : authService.verify(token);
        if (payload === null) {
          send(res, 401, { error: { code: "unauthorized", message: "missing or invalid bearer token" } });
          return;
        }
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        send(res, 400, { error: { code: "bad-request", message: "invalid or oversized json body" } });
        return;
      }
      try {
        await seat.handler(req, res, body);
      } catch (error) {
        ctx.logger.warn(`balbes-server: handler error: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) send(res, 500, { error: { code: "internal", message: "internal error" } });
      }
      return;
    }
    // Non-/api path: SPA static fallback.
    if (method === "GET" && staticServe !== null) {
      const result = await staticServe(url.pathname);
      if (result !== null) {
        send(res, result.status, result.body, result.type ?? "application/octet-stream");
        return;
      }
    }
    send(res, 404, "not found", "text/plain");
  };

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    void dispatch(req, res);
  };

  server = createServer(listener);
  server.listen(ctx.config.port, ctx.config.host);
  ctx.logger.warn(`balbes-server: listening on ${ctx.config.host}:${ctx.config.port}`);

  ctx.on("dispose", () => {
    server?.close();
    server = null;
  });
}
