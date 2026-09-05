import z from "@deepseek-ai/schemastery";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BalbesHttp } from "./types.js";
import { issueToken, verifyPassword, verifyToken, type AdminAuth } from "./core.js";

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
}

const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 30 * 60 * 1000;

export function createGuard(opts: { adminAuthFile: string; loginTtlSeconds?: number }): AuthGuard {
  let cached: AdminAuth | null = null;
  const fails = new Map<string, number[]>();

  async function load(): Promise<AdminAuth> {
    if (cached !== null) return cached;
    const raw = await readFile(opts.adminAuthFile, "utf8");
    cached = JSON.parse(raw) as AdminAuth;
    return cached;
  }

  return {
    issue(login) {
      const auth = cached;
      if (auth === null) throw new Error("auth: admin file not loaded");
      return issueToken(auth.jwtSecret, login, opts.loginTtlSeconds ?? 86400).token;
    },
    verify(token) {
      if (cached === null) return null;
      const payload = verifyToken(cached.jwtSecret, token);
      return payload === null ? null : { login: payload.login };
    },
    async checkLogin(login, password) {
      const auth = await load();
      if (login !== auth.login) return false;
      return verifyPassword(password, auth.passwordHash);
    }
  };
}

export function apply(ctx: {
  config: { adminAuthFile?: string; dshHome?: string; loginTtlSeconds?: number };
  provide(key: string, value: AuthGuard): void;
  get(key: string): BalbesHttp;
  logger: { warn(m: string): void };
}): void {
  const dshHome = ctx.config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const adminAuthFile = ctx.config.adminAuthFile ?? join(dshHome, "admin-auth.json");
  const guard = createGuard({ adminAuthFile, loginTtlSeconds: ctx.config.loginTtlSeconds ?? 86400 });
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
    const expiresAt = new Date(Date.now() + (ctx.config.loginTtlSeconds ?? 86400) * 1000).toISOString();
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
