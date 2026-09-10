import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, inject } from "../src/index.js";

interface Seat {
  path: string;
  auth: string;
  handler(req: unknown, res: unknown, body: unknown): Promise<void> | void;
}

let home: string;
let seats: Seat[];
let http: { post(path: string, auth: string, handler: Seat["handler"]): void };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ws-plugin-"));
  seats = [];
  http = {
    post(path, auth, handler) {
      seats.push({ path, auth, handler });
    }
  };
});

afterEach(async () => {
  // apply() calls ensureHome() fire-and-forget, so its mkdir/writeFile calls can
  // land between rm's passes and make it fail with ENOTEMPTY/EBUSY — retry
  // briefly (<= 550ms) until that apply-time work has settled.
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

describe("balbes-workspaces plugin", () => {
  it("exposes name/inject/apply contract", () => {
    expect(name).toBe("balbes-workspaces");
    expect(inject).toEqual(["balbesHttp"]);
    expect(typeof apply).toBe("function");
  });

  it("registers the five bearer routes, ensures the home and provides balbesWorkspaces", async () => {
    const provided = new Map<string, unknown>();
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
    expect(seats.map((s) => s.path).sort()).toEqual([
      "/api/workspaces/create",
      "/api/workspaces/delete",
      "/api/workspaces/events",
      "/api/workspaces/list",
      "/api/workspaces/tree"
    ]);
    for (const seat of seats) expect(seat.auth).toBe("bearer");
    const service = provided.get("balbesWorkspaces");
    expect(service).toBeDefined();
    expect(typeof (service as { list?: unknown }).list).toBe("function");
    expect(typeof (service as { readFile?: unknown }).readFile).toBe("function");
  });
});
