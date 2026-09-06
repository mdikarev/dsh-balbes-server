import z from "@deepseek-ai/schemastery";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BalbesHttp } from "./types.js";
import { issueToken, parseAdminAuth, verifyPassword, verifyToken, type AdminAuth } from "./core.js";

export const name = "balbes-auth";
export const inject = ["balbesHttp"];
export const Config = z.object({
  adminAuthFile: z.string(),
  dshHome: z.string(),
  loginTtlSeconds: z.number().default(86400)
});

export interface AuthGuard {
  issue(login: string): string;
  verify(token: string): { login: string } | null;
  checkLogin(login: string, password: string): Promise<boolean>;
  /** Validate the auth file synchronously at boot; false when the file is unreadable or shape-invalid. */
  loadSync(): boolean;
}

const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 30 * 60 * 1000;

export function createGuard(opts: {
  adminAuthFile: string;
  loginTtlSeconds?: number;
  logger?: { warn(m: string): void };
}): AuthGuard {
  const logger = opts.logger;
  const ttlSeconds = opts.loginTtlSeconds ?? 86400;

  function parse(raw: string): AdminAuth {
    // The same shape contract as core.parseAdminAuth: a hand-edited file that
    // lacks e.g. jwtSecret fails here with a clear error instead of feeding an
    // undefined secret into HMAC and crashing every later bearer verification.
    return parseAdminAuth(raw, opts.adminAuthFile);
  }

  /**
   * Synchronous read-through of the CURRENT admin-auth record. Every issue and
   * verify reads the file fresh (no cached secret, no mtime), so a password
   * reset that rotated jwtSecret takes effect immediately — without a restart
   * and without waiting for a login attempt. Fails closed (null) on any
   * read/parse failure and never throws.
   */
  function readCurrent(): AdminAuth | null {
    let raw: string;
    try {
      raw = readFileSync(opts.adminAuthFile, "utf8");
    } catch (error) {
      logger?.warn(`balbes-auth: cannot read ${opts.adminAuthFile}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    try {
      return parse(raw);
    } catch (error) {
      logger?.warn(`balbes-auth: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  return {
    loadSync() {
      // Boot-time warm check (called by the plugin apply): reports whether the
      // file is usable right now and never throws. Freshness never depends on
      // it — issue/verify read the file on every call, so a file that appears
      // (or is rotated/fixed) later is picked up without a restart.
      return readCurrent() !== null;
    },
    issue(login) {
      const auth = readCurrent();
      if (auth === null) {
        throw new Error(`balbes-auth: cannot issue a token while ${opts.adminAuthFile} is unreadable or shape-invalid`);
      }
      return issueToken(auth.jwtSecret, login, ttlSeconds).token;
    },
    verify(token) {
      // Read-through: a rotated jwtSecret invalidates already-issued tokens on
      // the very next call. Fail closed (null) on any read/parse failure — a
      // broken file must never crash a bearer request.
      const auth = readCurrent();
      if (auth === null) return null;
      try {
        const payload = verifyToken(auth.jwtSecret, token);
        return payload === null ? null : { login: payload.login };
      } catch {
        return null; // fail closed: a corrupt secret must never crash a bearer request
      }
    },
    async checkLogin(login, password) {
      // Per-attempt read: a file fixed by hand (or regenerated/rotated) is
      // picked up without a restart; a broken file fails closed (false), never
      // throws.
      const auth = readCurrent();
      if (auth === null || login !== auth.login) return false;
      return verifyPassword(password, auth.passwordHash);
    }
  };
}

export function apply(ctx: {
  provide(key: string, value: AuthGuard): void;
  get(key: string): BalbesHttp;
  logger: { warn(m: string): void };
}, config: { adminAuthFile?: string; dshHome?: string; loginTtlSeconds?: number }): void {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const adminAuthFile = config.adminAuthFile ?? join(dshHome, "admin-auth.json");
  const loginTtlSeconds = config.loginTtlSeconds ?? 86400;
  const guard = createGuard({ adminAuthFile, loginTtlSeconds, logger: ctx.logger });
  if (!guard.loadSync()) {
    ctx.logger.warn(`balbes-auth: admin auth file ${adminAuthFile} unusable (missing, unreadable, or invalid shape); auth unavailable until the file is valid`);
  }
  ctx.provide("balbesAuth", guard);
  const http = ctx.get("balbesHttp");
  const ipFails = new Map<string, number[]>();

  const blocked = (ip: string): boolean => {
    const now = Date.now();
    const list = (ipFails.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    ipFails.set(ip, list);
    return list.length >= FAIL_LIMIT;
  };
  const recordFail = (ip: string): void => {
    const list = ipFails.get(ip) ?? [];
    list.push(Date.now());
    ipFails.set(ip, list);
  };

  http.post("/api/auth/login", "public", async (req, res, body) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    if (blocked(ip)) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "rate-limited", message: "too many attempts" } }));
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "bad-request", message: "request body must be a JSON object" } }));
      return;
    }
    const b = body as { login?: unknown; password?: unknown };
    if (typeof b.login !== "string" || typeof b.password !== "string") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "bad-request", message: "login and password required" } }));
      return;
    }
    const ok = await guard.checkLogin(b.login, b.password);
    if (!ok) {
      recordFail(ip);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unauthorized", message: "invalid credentials" } }));
      return;
    }
    const token = guard.issue(b.login);
    const expiresAt = new Date(Date.now() + loginTtlSeconds * 1000).toISOString();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token, expiresAt }));
  });

  http.post("/api/auth/me", "bearer", async (_req, res) => {
    // Bearer verification is done by server.dispatch (see Task 4); only
    // authorized requests reach here. Re-read the login from the header via guard.
    const authHeader = _req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const payload = guard.verify(token);
    if (payload === null) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unauthorized", message: "invalid token" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ login: payload.login }));
  });
}
