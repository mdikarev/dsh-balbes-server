import { describe, expect, it, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply as applyServer } from "../src/server.js";
import type { BalbesHttp } from "../src/types.js";

interface CtxLike {
  get(key: string): unknown;
  provide(key: string, value: unknown): void;
  on(event: string, listener: (...a: unknown[]) => void): void;
  logger: { warn(m: string): void };
}

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
    let getImpl: (key: string) => unknown = () => undefined;
    let http: BalbesHttp | null = null;
    const ctx: CtxLike = {
      get: (k) => getImpl(k),
      provide: (_k, v) => { http = v as BalbesHttp; },
      on: (ev, fn) => { if (ev === "dispose") onDispose.push(fn as () => void); },
      logger: { warn: () => undefined }
    };
    applyServer(ctx, { host: "127.0.0.1", port }); // the server starts listening inside apply on a free port
    disposers.push(() => { for (const fn of onDispose) fn(); });
    return {
      port,
      http: http as unknown as BalbesHttp,
      setGet: (impl: (k: string) => unknown) => { getImpl = impl; }
    };
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
});
