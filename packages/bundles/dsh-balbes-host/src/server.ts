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
const BODY_TOO_LARGE = "body-too-large";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Reject with a marker and stop reading. The request is NOT destroyed
        // here: destroying the socket would reset the connection and swallow
        // the 400 the client is owed — dispatch tears the connection down
        // only after the response has flushed (closeAfterFlush).
        const error = new Error("body too large") as Error & { code?: string };
        error.code = BODY_TOO_LARGE;
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
        req.pause();
        reject(error);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
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
    };
    const onError = (error: Error): void => {
      reject(error);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  // The client may already be gone (aborted connection): writing into a
  // destroyed response throws or emits stream errors, so never attempt it and
  // contain whatever still surfaces below.
  if (res.destroyed || res.writableEnded) return;
  try {
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, { "content-type": type, "content-length": body.length });
      res.end(body);
      return;
    }
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  } catch {
    // Connection dropped mid-write; the per-request "error" listener (see
    // listener) keeps the stream error contained.
  }
}

/** Close a request whose body was only partially read once the response flushed. */
function closeAfterFlush(req: IncomingMessage, res: ServerResponse): void {
  const close = (): void => {
    if (!req.destroyed) req.destroy();
  };
  res.once("finish", close);
  res.once("close", close);
}

export function apply(ctx: {
  get(key: string): unknown;
  provide(key: string, value: BalbesHttp): void;
  on(event: string, listener: (...args: never[]) => void): void;
  logger: { warn(msg: string): void };
}, config: { host: string; port: number }): void {
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
    // new URL throws for malformed request targets (garbage from the wire);
    // the listener catch turns that into a 500 — the process must never die
    // on it.
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
      } catch (error) {
        send(res, 400, { error: { code: "bad-request", message: "invalid or oversized json body" } });
        if ((error as { code?: string }).code === BODY_TOO_LARGE) closeAfterFlush(req, res);
        return;
      }
      try {
        await seat.handler(req, res, body);
      } catch (error) {
        ctx.logger.warn(`balbes-server: handler error: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent && !res.destroyed) send(res, 500, { error: { code: "internal", message: "internal error" } });
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
    // Stream errors on aborted connections must never become unhandled
    // 'error' emissions that take the whole process down.
    req.on("error", () => { /* client aborted mid-request; nothing to send */ });
    res.on("error", () => { /* client aborted mid-response; nothing left to send */ });
    // dispatch() is fully async: every rejection is caught here so a
    // malformed request or an unexpected handler/static failure yields a 500
    // (when nothing was written yet) instead of an unhandled rejection.
    void dispatch(req, res).catch((error) => {
      ctx.logger.warn(`balbes-server: request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent && !res.destroyed) {
        try {
          send(res, 500, { error: { code: "internal", message: "internal error" } });
        } catch {
          /* client is gone: nothing left to send */
        }
      }
    });
  };

  server = createServer(listener);
  server.listen(config.port, config.host);
  ctx.logger.warn(`balbes-server: listening on ${config.host}:${config.port}`);

  ctx.on("dispose", () => {
    server?.close();
    server = null;
  });
}
