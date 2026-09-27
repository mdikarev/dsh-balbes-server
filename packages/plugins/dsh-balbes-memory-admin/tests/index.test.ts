import { describe, expect, it } from "vitest";
import { apply, Config, inject, name } from "../src/index.js";
import type { MemoryDraftLike, MemoryFilterLike, MemoryPatchLike, MemoryServiceLike, ResLike } from "../src/routes.js";
import type { MemoryRecord } from "dsh-balbes-contracts";

interface Seat {
  path: string;
  auth: string;
  handler(req: unknown, res: ResLike, body: unknown): Promise<void> | void;
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m-1",
    scope: { kind: "global" },
    type: "note",
    text: "hello",
    tags: [],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    ...overrides
  };
}

function makeRes(): { res: ResLike; read(): { status: number; json: unknown; raw: string } } {
  const box = { status: 0, raw: "" };
  return {
    res: {
      writeHead(status: number) { box.status = status; },
      end(body?: string) { box.raw = String(body ?? ""); }
    },
    read: () => ({ status: box.status, raw: box.raw, json: box.raw === "" ? undefined : (JSON.parse(box.raw) as unknown) })
  };
}

interface FakeService extends MemoryServiceLike {
  saved: MemoryDraftLike[];
  updated: Array<{ id: string; patch: MemoryPatchLike }>;
  deleted: string[];
  searched: Array<{ query: string; filter?: MemoryFilterLike }>;
}

function fakeService(overrides: Partial<MemoryServiceLike> = {}): FakeService {
  const saved: MemoryDraftLike[] = [];
  const updated: Array<{ id: string; patch: MemoryPatchLike }> = [];
  const deleted: string[] = [];
  const searched: Array<{ query: string; filter?: MemoryFilterLike }> = [];
  const base: MemoryServiceLike = {
    async save(draft) { saved.push(draft); return record({ scope: draft.scope, type: draft.type, text: draft.text, origin: draft.origin }); },
    async update(id, patch) { updated.push({ id, patch }); return record({ id, text: patch.text ?? "updated" }); },
    async delete(id) { deleted.push(id); return true; },
    async list() { return [record()]; },
    async search(request) { searched.push({ query: request.query, ...(request.filter === undefined ? {} : { filter: request.filter }) }); return [{ record: record({ text: "hit" }), rank: 1 }]; }
  };
  return Object.assign(base, overrides, { saved, updated, deleted, searched });
}

interface HarnessOptions { service?: MemoryServiceLike | undefined; omitHttp?: boolean; }

function harness(options: HarnessOptions = {}) {
  const seats: Seat[] = [];
  const warnings: string[] = [];
  let service = options.service;
  const ctx = {
    get(key: string): unknown {
      if (key === "balbesHttp") {
        return options.omitHttp === true
          ? undefined
          : { post(path: string, auth: string, handler: Seat["handler"]) { seats.push({ path, auth, handler }); } };
      }
      if (key === "balbesMemory") return service;
      return undefined;
    },
    logger: { warn(message: string) { warnings.push(message); } }
  };
  apply(ctx as never, {});
  async function call(path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }> {
    const seat = seats.find((candidate) => candidate.path === path);
    if (seat === undefined) throw new Error("no seat registered for " + path);
    const response = makeRes();
    await seat.handler({}, response.res, body);
    return response.read();
  }
  return { seats, warnings, call, setService(value: MemoryServiceLike | undefined) { service = value; } };
}

describe("balbes-memory-admin plugin", () => {
  it("exposes the functional plugin contract", () => {
    expect(name).toBe("balbes-memory-admin");
    expect(inject).toEqual(["balbesHttp"]);
    expect(Config({})).toEqual({});
  });

  it("registers the three bearer routes", () => {
    const h = harness({ service: fakeService() });
    expect(h.seats.map((seat) => seat.path)).toEqual([
      "/api/memory/list",
      "/api/memory/save",
      "/api/memory/delete"
    ]);
    expect(h.seats.every((seat) => seat.auth === "bearer")).toBe(true);
  });

  it("warns and registers nothing without balbesHttp", () => {
    const h = harness({ service: fakeService(), omitHttp: true });
    expect(h.seats).toEqual([]);
    expect(h.warnings.join(" ")).toContain("balbesHttp");
  });

  it("answers 503 memory-unavailable when the store is absent", async () => {
    const h = harness({ service: undefined });
    const res = await h.call("/api/memory/list", {});
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: { code: "memory-unavailable", message: "memory storage is not available" } });
  });

  it("lists records with the filters it was given", async () => {
    const service = fakeService();
    const h = harness({ service });
    const res = await h.call("/api/memory/list", { scope: { kind: "global" }, type: "note", tag: "x", pinned: true });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ records: [record()] });
    expect(service.searched).toEqual([]);
  });

  it("uses FTS search when query is non-blank", async () => {
    const service = fakeService();
    const h = harness({ service });
    const res = await h.call("/api/memory/list", { query: "  hello  " });
    expect(res.status).toBe(200);
    expect(service.searched).toEqual([{ query: "hello" }]);
    expect((res.json as { records: MemoryRecord[] }).records[0]?.text).toBe("hit");
  });

  it("forces origin owner on create even when the body claims agent", async () => {
    const service = fakeService();
    const h = harness({ service });
    const res = await h.call("/api/memory/save", { scope: { kind: "global" }, type: "note", text: "x", origin: "agent" });
    expect(res.status).toBe(200);
    expect(service.saved[0]?.origin).toBe("owner");
  });

  it("rejects scope on update and never sends it to the service", async () => {
    const service = fakeService();
    const h = harness({ service });
    const bad = await h.call("/api/memory/save", { id: "m-1", scope: { kind: "global" }, type: "note", text: "x" });
    expect(bad.status).toBe(400);
    expect(service.updated).toEqual([]);

    const ok = await h.call("/api/memory/save", { id: "m-1", type: "note", text: "new" });
    expect(ok.status).toBe(200);
    expect(service.updated).toEqual([{ id: "m-1", patch: { type: "note", text: "new" } }]);
  });

  it("reports deletion outcome and validates the id", async () => {
    const service = fakeService();
    const h = harness({ service });
    const ok = await h.call("/api/memory/delete", { id: "m-1" });
    expect(ok.json).toEqual({ deleted: true });
    expect(service.deleted).toEqual(["m-1"]);

    const bad = await h.call("/api/memory/delete", {});
    expect(bad.status).toBe(400);
  });

  it("maps MemoryError codes to HTTP statuses", async () => {
    const secret = fakeService({ save: async () => { throw { code: "secret-detected", message: "text matches secret rule sk" }; } });
    const h = harness({ service: secret });
    const res = await h.call("/api/memory/save", { scope: { kind: "global" }, type: "note", text: "sk-abc123456789012345" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: { code: "secret-detected", message: "text matches secret rule sk" } });

    const missing = fakeService({ update: async () => { throw { code: "not-found", message: "memory not found: nope" }; } });
    const h2 = harness({ service: missing });
    const res2 = await h2.call("/api/memory/save", { id: "nope", type: "note", text: "x" });
    expect(res2.status).toBe(404);

    const broken = fakeService({ list: async () => { throw new Error("boom"); } });
    const h3 = harness({ service: broken });
    const res3 = await h3.call("/api/memory/list", {});
    expect(res3.status).toBe(500);
    expect(res3.json).toEqual({ error: { code: "internal", message: "boom" } });
  });
});
