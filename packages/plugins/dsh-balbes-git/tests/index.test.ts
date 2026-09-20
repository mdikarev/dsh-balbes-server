import { describe, expect, it, beforeEach } from "vitest";
import { apply, name, inject } from "../src/index.js";
import { BALBES_GITHUB_TOKEN } from "../src/credentials.js";

interface Seat { path: string; auth: string; handler(req: unknown, res: unknown, body: unknown): Promise<void> | void }

let seats: Seat[];
let refs: Map<string, string>;
let provided: Map<string, unknown>;

beforeEach(() => {
  seats = [];
  refs = new Map();
  provided = new Map();
});

function boot(): void {
  const http = { post(path: string, auth: string, handler: Seat["handler"]) { seats.push({ path, auth, handler }); } };
  const credentials = {
    describe: async (ref: string) => ({ configured: refs.has(ref), writable: true }),
    set: async (ref: string, value: string) => void refs.set(ref, value),
    unset: async (ref: string) => void refs.delete(ref),
    resolve: async (ref: string) => (refs.has(ref) ? { value: refs.get(ref)! } : undefined)
  };
  const ctx = {
    get: (key: string) => (key === "balbesHttp" ? http : key === "credentials" ? credentials : undefined),
    provide: (key: string, value: unknown) => void provided.set(key, value),
    logger: { warn: (_m: string) => {} }
  };
  apply(ctx, undefined);
}

function call(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const seat = seats.find((s) => s.path === path);
  if (seat === undefined) throw new Error("route not registered: " + path);
  return new Promise((resolve, reject) => {
    let status = 0;
    const res = {
      writeHead(code: number): void { status = code; },
      end(payload?: string): void {
        try { resolve({ status, json: payload === undefined ? undefined : JSON.parse(payload) }); }
        catch (error) { reject(error); }
      }
    };
    void Promise.resolve(seat.handler({}, res, body)).catch(reject);
  });
}

describe("balbes-git plugin", () => {
  it("exposes the plugin contract and provides balbesGit", () => {
    boot();
    expect(name).toBe("balbes-git");
    expect(inject).toEqual(["balbesHttp", "credentials"]);
    expect(seats.map((s) => s.path).sort()).toEqual([
      "/api/git/clear-token",
      "/api/git/save",
      "/api/git/status"
    ]);
    expect(provided.has("balbesGit")).toBe(true);
  });

  it("saves, reports and clears the token without echoing it", async () => {
    boot();
    expect(await call("/api/git/status", {})).toEqual({ status: 200, json: { git: { tokenConfigured: false } } });
    expect((await call("/api/git/save", { token: "  ghp_x  " })).json).toEqual({ git: { tokenConfigured: true } });
    expect(refs.get(BALBES_GITHUB_TOKEN)).toBe("ghp_x");
    expect(JSON.stringify(await call("/api/git/status", {}))).not.toContain("ghp_x");
    expect((await call("/api/git/clear-token", {})).json).toEqual({ git: { tokenConfigured: false } });
  });

  it("rejects an empty token with 400 invalid-token", async () => {
    boot();
    const res = await call("/api/git/save", { token: "   " });
    expect(res.status).toBe(400);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe("invalid-token");
  });
});
