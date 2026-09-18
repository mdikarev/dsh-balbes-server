import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, inject } from "../src/index.js";
import { createProject } from "../src/workspaces.js";

interface Seat {
  path: string;
  auth: string;
  handler(req: unknown, res: unknown, body: unknown): Promise<void> | void;
}

let home: string;
let seats: Seat[];
let provided: Map<string, unknown>;
let http: { post(path: string, auth: string, handler: Seat["handler"]): void };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ws-plugin-"));
  seats = [];
  provided = new Map();
  http = {
    post(path, auth, handler) {
      seats.push({ path, auth, handler });
    }
  };
});

afterEach(async () => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== "ENOTEMPTY" && code !== "EBUSY")) throw error;
      await delay(10 * attempt);
    }
  }
});

function boot(): void {
  const ctx = {
    get(key: string): unknown {
      return key === "balbesHttp" ? http : undefined;
    },
    provide(key: string, value: unknown): void {
      provided.set(key, value);
    },
    logger: { warn(_m: string): void {} }
  };
  apply(ctx, { dshHome: home });
}

/** Invoke a registered route with a fake response; return status and JSON body. */
function call(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const seat = seats.find((s) => s.path === path);
  if (seat === undefined) throw new Error("route not registered: " + path);
  return new Promise((resolve, reject) => {
    let status = 0;
    const res = {
      writeHead(code: number): void {
        status = code;
      },
      end(payload?: string): void {
        try {
          resolve({ status, json: payload === undefined ? undefined : JSON.parse(payload) });
        } catch (error) {
          reject(error);
        }
      }
    };
    void Promise.resolve(seat.handler({}, res, body)).catch(reject);
  });
}

describe("balbes-workspaces plugin", () => {
  it("exposes name/inject/apply contract", () => {
    expect(name).toBe("balbes-workspaces");
    expect(inject).toEqual(["balbesHttp"]);
    expect(typeof apply).toBe("function");
  });

  it("registers the six bearer routes, ensures the home and provides balbesWorkspaces", async () => {
    boot();
    expect(seats.map((s) => s.path).sort()).toEqual([
      "/api/workspaces/create",
      "/api/workspaces/delete",
      "/api/workspaces/events",
      "/api/workspaces/file",
      "/api/workspaces/list",
      "/api/workspaces/tree"
    ]);
    for (const seat of seats) expect(seat.auth).toBe("bearer");
    const service = provided.get("balbesWorkspaces");
    expect(service).toBeDefined();
    expect(typeof (service as { list?: unknown }).list).toBe("function");
    expect(typeof (service as { readFile?: unknown }).readFile).toBe("function");
  });

  it("serves a workspace file: text, binary, link, not-found and invalid-path", async () => {
    boot();
    const p1 = (await createProject(home, "p1")).path;
    await writeFile(join(p1, "notes.txt"), "hello", "utf8");
    await writeFile(join(p1, "bin.dat"), Buffer.from([0, 1]));
    await symlink("/etc/hostname", join(p1, "evil.txt"));
    await mkdir(join(p1, "sub"));

    const text = await call("/api/workspaces/file", { scope: "project", name: "p1", path: "notes.txt" });
    expect(text.status).toBe(200);
    expect(text.json).toEqual({ file: { kind: "text", content: "hello", truncated: false } });

    const bin = await call("/api/workspaces/file", { scope: "project", name: "p1", path: "bin.dat" });
    expect(bin.json).toEqual({ file: { kind: "binary", size: 2 } });

    const link = await call("/api/workspaces/file", { scope: "project", name: "p1", path: "evil.txt" });
    expect(link.json).toEqual({ file: { kind: "link" } });

    const dir = await call("/api/workspaces/file", { scope: "project", name: "p1", path: "sub" });
    expect(dir.status).toBe(404);
    expect((dir.json as { error?: { code?: string } }).error?.code).toBe("not-found");

    const traversal = await call("/api/workspaces/file", { scope: "project", name: "p1", path: "../x" });
    expect(traversal.status).toBe(400);
    expect((traversal.json as { error?: { code?: string } }).error?.code).toBe("invalid-path");

    const missing = await call("/api/workspaces/file", { scope: "project", name: "p1", path: "nope.txt" });
    expect(missing.status).toBe(404);
    expect((missing.json as { error?: { code?: string } }).error?.code).toBe("not-found");
  });
});
