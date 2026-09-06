import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
  await rm(home, { recursive: true, force: true });
});

describe("balbes-workspaces plugin", () => {
  it("exposes name/inject/apply contract", () => {
    expect(name).toBe("balbes-workspaces");
    expect(inject).toEqual(["balbesHttp"]);
    expect(typeof apply).toBe("function");
  });

  it("registers the three bearer routes and ensures the home at apply time", async () => {
    const ctx = {
      get(key: string): unknown {
        return key === "balbesHttp" ? http : undefined;
      },
      logger: { warn(_m: string): void {} }
    };
    apply(ctx as never, { dshHome: home });
    expect(seats.map((s) => s.path).sort()).toEqual([
      "/api/workspaces/create",
      "/api/workspaces/delete",
      "/api/workspaces/list"
    ]);
    for (const seat of seats) expect(seat.auth).toBe("bearer");
  });
});
