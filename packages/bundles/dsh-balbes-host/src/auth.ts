import z from "@deepseek-ai/schemastery";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  /** Warm the cached credentials synchronously at startup; false when the file is unreadable or shape-invalid. */
  loadSync(): boolean;
}

const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 30 * 60 * 1000;

export function createGuard(opts: {
  adminAuthFile: string;
  loginTtlSeconds?: number;
  logger?: { warn(m: string): void };
}): AuthGuard {
  let cached: AdminAuth | null = null;
  const logger = opts.logger;

  function parse(raw: string): AdminAuth {
    // The same shape contract as core.loadAdminAuth: a hand-edited file that
    // lacks e.g. jwtSecret fails here with a clear error instead of poisoning
    // the cache and crashing every later bearer verification.
    return parseAdminAuth(raw, opts.adminAuthFile);
  }

  /** Re-read from disk; fail closed (null) on any read/parse failure. */
  async function load(): Promise<AdminAuth | null> {
    let raw: string;
    try {
      raw = await readFile(opts.adminAuthFile, "utf8");
    } catch (error) {
      cached = null;
      logger?.warn(`balbes-auth: cannot read ${opts.adminAuthFile}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    try {
      cached = parse(raw);
      return cached;
    } catch (error) {
      cached = null;
      logger?.warn(`balbes-auth: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  return {
    loadSync() {
      // Startup fast path: a file that appears (or is rotated/fixed) later is
      // picked up by checkLogin's lazy re-read; loadSync never throws.
      try {
        cached = parse(readFileSync(opts.adminAuthFile, "utf8"));
        return true;
      } catch {
        cached = null;
        return false;
      }
    },
    issue(login) {
      const auth = cached;
      if (auth === null) throw new Error("auth: admin file not loaded");
      return issueToken(auth.jwtSecret, login, opts.loginTtlSeconds ?? 86400).token;
    },
    verify(token) {
      if (cached === null) return null;
      try {
        const payload = verifyToken(cached.jwtSecret, token);
        return payload === null ? null : { login: payload.login };
      } catch {
        return null; // fail closed: a corrupt cache must never crash a bearer request
      }
    },
    async checkLogin(login, password) {
      // Lazy reload means a file fixed by hand (or regenerated) is picked up
      // without a restart; a broken file fails closed (false), never throws.
      const auth = await load();
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
