import { describe, expect, it, afterEach } from "vitest";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply as applyServer } from "../src/server.js";
import { apply as applyApi } from "../src/api.js";
import { apply as applyAuth, createGuard } from "../src/auth.js";
import { createAdminAuth, writeAdminAuth } from "../src/core.js";
import type { BalbesHttp } from "../src/types.js";

interface CtxLike {
  get(key: string): unknown;
  provide(key: string, value: unknown): void;
  on(event: string, listener: (...a: unknown[]) => void): void;
  logger: { warn(m: string): void };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function post(port: number, path: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Raw request over a plain TCP socket; resolves with the raw response bytes. */
async function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1");
    let buf = "";
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
    });
    sock.on("close", () => resolve(buf));
    // A server tearing the connection down mid-request (oversized body) can
    // surface as a socket error on the client: whatever bytes arrived first
    // are the answer we assert on.
    sock.on("error", () => resolve(buf));
    // Safety net: never leave a hanging socket behind.
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(buf);
    }, 5000);
    timer.unref?.();
  });
}

describe("server", () => {
  const disposers: Array<() => void> = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function boot() {
    const port = await freePort();
    const onDispose: Array<() => void> = [];
    const services = new Map<string, unknown>();
    let fallbackGet: (key: string) => unknown = () => undefined;
    let http: BalbesHttp | null = null;
    const warns: string[] = [];
    const ctx: CtxLike = {
      get: (k) => (services.has(k) ? services.get(k) : fallbackGet(k)),
      provide: (k, v) => {
        services.set(k, v);
        if (k === "balbesHttp") http = v as BalbesHttp;
      },
      on: (ev, fn) => {
        if (ev === "dispose") onDispose.push(fn as () => void);
      },
      logger: { warn: (m: string) => void warns.push(m) }
    };
    applyServer(ctx, { host: "127.0.0.1", port }); // the server starts listening inside apply on a free port
    disposers.push(() => {
      for (const fn of onDispose) fn();
    });
    return {
      port,
      http: http as unknown as BalbesHttp,
      ctx,
      services,
      warns,
      setGet: (impl: (k: string) => unknown) => {
        fallbackGet = impl;
      }
    };
  }

  /** Register a JSON echo seat, handy for liveness checks after crashes. */
  function registerEcho(b: Awaited<ReturnType<typeof boot>>): void {
    b.http.post("/api/echo", "public", async (_req, res, body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ got: body }));
    });
  }

  it("public route: POST /api/echo returns the body", async () => {
    const b = await boot();
    b.http.post("/api/echo", "public", async (_req, res, body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ got: body }));
    });
    const { status, json } = await post(b.port, "/api/echo", { hello: 1 });
    expect(status).toBe(200);
    expect(json).toEqual({ got: { hello: 1 } });
  });

  it("bearer route: no token gives 401, valid token gives 200", async () => {
    const b = await boot();
    b.setGet((key) => (key === "balbesAuth" ? { verify: (t: string) => (t === "good" ? { login: "admin" } : null) } : undefined));
    let reached = false;
    b.http.post("/api/protected", "bearer", async (_req, res) => {
      reached = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    expect((await post(b.port, "/api/protected", {})).status).toBe(401);
    expect((await post(b.port, "/api/protected", {}, "bad")).status).toBe(401);
    expect((await post(b.port, "/api/protected", {}, "good")).status).toBe(200);
    expect(reached).toBe(true);
  });

  it("unknown /api/* gives 404", async () => {
    const b = await boot();
    expect((await post(b.port, "/api/nope", {})).status).toBe(404);
  });

  it("static: / serves index.html from the ui dir", async () => {
    const b = await boot();
    const dir = await mkdtemp(join(tmpdir(), "balbes-ui-"));
    dirs.push(dir);
    await writeFile(join(dir, "index.html"), "<h1>admin</h1>");
    b.http.registerStatic(async (pathname) => {
      if (pathname === "/") {
        const { readFile } = await import("node:fs/promises");
        return { status: 200, body: await readFile(join(dir, "index.html")), type: "text/html; charset=utf-8" };
      }
      return null;
    });
    const res = await fetch(`http://127.0.0.1:${b.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("admin");
  });

  it("a malformed request target yields 500 and does not crash the server", async () => {
    const b = await boot();
    registerEcho(b);
    // Absolute-form target with an unterminated IPv6 host: new URL throws.
    const res = await rawRequest(b.port, "POST http://[::1 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    expect(res.split("\r\n")[0]).toMatch(/ 500 /);
    expect((await post(b.port, "/api/echo", { hello: 1 })).status).toBe(200);
  });

  it("a request line the HTTP parser itself rejects does not crash the server", async () => {
    const b = await boot();
    registerEcho(b);
    // Space inside the request target is rejected at parse level; whatever
    // Node answers (400 or a reset), the process must stay alive.
    await rawRequest(b.port, "GET http://exa mple.com/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").catch(() => undefined);
    expect((await post(b.port, "/api/echo", { hello: 1 })).status).toBe(200);
  });

  it("an oversized body gets a 400 (not a connection reset) and the server survives", async () => {
    const b = await boot();
    registerEcho(b);
    // Send enough of the oversized body to trip the 1 MiB limit, then stop
    // writing and read: a client that keeps uploading into a connection the
    // server is closing would only observe the reset, not the 400.
    const body = "x".repeat(1024 * 1024 + 64 * 1024);
    const raw = await rawRequest(
      b.port,
      `POST /api/echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${2 * 1024 * 1024}\r\nConnection: close\r\n\r\n${body}`
    );
    expect(raw.split("\r\n")[0]).toMatch(/ 400 /);
    expect((await post(b.port, "/api/echo", { hello: 1 })).status).toBe(200);
  });

  it("clients aborting mid-request and mid-response do not crash later requests", async () => {
    const b = await boot();
    registerEcho(b);
    b.http.post("/api/slow", "public", async (_req, res) => {
      await sleep(400);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("late");
    });

    // Abort mid-request-body: the client resets the connection before the
    // declared Content-Length arrived.
    await new Promise<void>((resolve) => {
      const sock = connect(b.port, "127.0.0.1");
      sock.on("error", () => { /* expected on reset */ });
      sock.on("connect", () => {
        sock.write("POST /api/echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{\"partial\":");
        setTimeout(() => {
          sock.resetAndDestroy();
          resolve();
        }, 50);
      });
    });
    await sleep(150); // let the server observe the reset
    expect((await post(b.port, "/api/echo", { hello: 1 })).status).toBe(200);

    // Abort mid-response: the handler writes after the client is gone.
    await new Promise<void>((resolve) => {
      const sock = connect(b.port, "127.0.0.1");
      sock.on("error", () => { /* expected on reset */ });
      sock.on("connect", () => {
        sock.write("POST /api/slow HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
        setTimeout(() => {
          sock.resetAndDestroy();
          resolve();
        }, 100);
      });
    });
    await sleep(600); // the handler's write lands on the dead connection
    expect((await post(b.port, "/api/echo", { hello: 1 })).status).toBe(200);
  });

  it("bearer auth fails closed on a shape-invalid admin-auth.json and recovers once the file is fixed", async () => {
    const b = await boot();
    const dir = await mkdtemp(join(tmpdir(), "balbes-srv-shape-"));
    dirs.push(dir);
    const file = join(dir, "admin-auth.json");
    // Hand-edited file missing jwtSecret (the daemon-crash scenario).
    await writeFile(file, JSON.stringify({ login: "admin", passwordHash: "x" }), "utf8");
    const guard = createGuard({ adminAuthFile: file });
    b.services.set("balbesAuth", guard);
    registerEcho(b);
    b.http.post("/api/protected", "bearer", async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    b.http.post("/api/login-x", "public", async (_req, res, body) => {
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "bad-request", message: "request body must be a JSON object" } }));
        return;
      }
      const cred = body as { login?: unknown; password?: unknown };
      if (typeof cred.login !== "string" || typeof cred.password !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "bad-request", message: "login and password required" } }));
        return;
      }
      if (!(await guard.checkLogin(cred.login, cred.password))) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unauthorized", message: "invalid credentials" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: guard.issue(cred.login) }));
    });

    // A bearer request against the broken file must fail closed (401), and
    // login must not crash the process either.
    expect((await post(b.port, "/api/protected", {}, "stale-token")).status).toBe(401);
    expect((await post(b.port, "/api/login-x", { login: "admin", password: "x" })).status).toBe(401);
    expect((await post(b.port, "/api/echo", { alive: true })).status).toBe(200);

    // Fix the file (full rewrite with fresh credentials): checkLogin's lazy
    // reload picks it up without a restart.
    const creds = await createAdminAuth();
    await writeAdminAuth(dir, creds);
    const loginRes = await post(b.port, "/api/login-x", { login: creds.login, password: creds.plaintextPassword });
    expect(loginRes.status).toBe(200);
    const token = (loginRes.json as { token?: string }).token;
    expect(typeof token).toBe("string");
    expect((await post(b.port, "/api/protected", {}, token as string)).status).toBe(200);
  });

  it("login (auth plugin): null and array bodies get a 400, not a 500", async () => {
    const b = await boot();
    const dir = await mkdtemp(join(tmpdir(), "balbes-srv-login-"));
    dirs.push(dir);
    applyAuth(b.ctx as never, { adminAuthFile: join(dir, "admin-auth.json") });
    for (const body of [null, [1, 2]]) {
      const { status, json } = await post(b.port, "/api/auth/login", body);
      expect(status).toBe(400);
      expect((json as { error?: { code?: string } }).error?.code).toBe("bad-request");
    }
  });

  it("prompt (api plugin): null and array bodies get a 400, not a 500", async () => {
    const b = await boot();
    b.services.set("balbesAuth", { verify: (t: string) => (t === "good" ? { login: "admin" } : null) });
    applyApi(b.ctx as never, { version: "0-test" });
    for (const body of [null, ["not-an-object"]]) {
      const { status, json } = await post(b.port, "/api/prompt", body, "good");
      expect(status).toBe(400);
      expect((json as { error?: { code?: string } }).error?.code).toBe("bad-request");
    }
  });
});
