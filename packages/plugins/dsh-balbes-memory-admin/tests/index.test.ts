import { describe, expect, it } from "vitest";
import { apply, Config, inject, name } from "../src/index.js";
import { registerMemoryRoutes } from "../src/routes.js";
import type {
  MemoryDecisionPatchLike,
  MemoryDraftLike,
  MemoryFilterLike,
  MemoryMetricsSnapshotLike,
  MemoryPatchLike,
  MemoryProposalDraftLike,
  MemoryProposalFilterLike,
  MemoryServiceLike,
  MetricsLike,
  ResLike
} from "../src/routes.js";
import type { MemoryAutonomyPolicy, MemoryProposal, MemoryRecord } from "dsh-balbes-contracts";

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

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: "p-1",
    scope: { kind: "global" },
    type: "fact",
    text: "staged fact",
    tags: [],
    origin: "agent",
    originRef: "pipeline:test",
    status: "proposed",
    proposedAt: "2026-09-30T00:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    decidedEdit: false,
    memoryId: null,
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
  listed: MemoryFilterLike[];
  proposed: MemoryProposalDraftLike[];
  reviewed: MemoryProposalFilterLike[];
  approved: Array<{ id: string; patch?: MemoryDecisionPatchLike }>;
  rejected: string[];
}

function fakeService(overrides: Partial<MemoryServiceLike> = {}): FakeService {
  const saved: MemoryDraftLike[] = [];
  const updated: Array<{ id: string; patch: MemoryPatchLike }> = [];
  const deleted: string[] = [];
  const searched: Array<{ query: string; filter?: MemoryFilterLike }> = [];
  const listed: MemoryFilterLike[] = [];
  const proposed: MemoryProposalDraftLike[] = [];
  const reviewed: MemoryProposalFilterLike[] = [];
  const approved: Array<{ id: string; patch?: MemoryDecisionPatchLike }> = [];
  const rejected: string[] = [];
  const base: MemoryServiceLike = {
    async save(draft) { saved.push(draft); return record({ scope: draft.scope, type: draft.type, text: draft.text, origin: draft.origin }); },
    async update(id, patch) { updated.push({ id, patch }); return record({ id, text: patch.text ?? "updated" }); },
    async delete(id) { deleted.push(id); return true; },
    async list(filter) { if (filter !== undefined) listed.push(filter); return [record()]; },
    async search(request) { searched.push({ query: request.query, ...(request.filter === undefined ? {} : { filter: request.filter }) }); return [{ record: record({ text: "hit" }), rank: 1 }]; },
    async propose(draft) {
      proposed.push(draft);
      return proposal({ scope: draft.scope, type: draft.type, text: draft.text, tags: draft.tags ?? [], originRef: draft.originRef ?? null });
    },
    async getProposal() { return undefined; },
    async listProposals(filter) { if (filter !== undefined) reviewed.push(filter); return [proposal()]; },
    async approve(id, patch) {
      approved.push({ id, ...(patch === undefined ? {} : { patch }) });
      return { proposal: proposal({ id, status: "accepted", decidedAt: "2026-09-30T01:00:00.000Z", decidedBy: "owner", memoryId: "m-1" }), record: record({ id: "m-1" }) };
    },
    async reject(id) {
      rejected.push(id);
      return proposal({ id, status: "rejected", decidedAt: "2026-09-30T01:00:00.000Z", decidedBy: "owner" });
    }
  };
  return Object.assign(base, overrides, { saved, updated, deleted, searched, listed, proposed, reviewed, approved, rejected });
}

interface HarnessOptions { service?: MemoryServiceLike | undefined; metrics?: MetricsLike | undefined; omitHttp?: boolean; }

/**
 * Direct seat builder for the route table: calls `registerMemoryRoutes` without
 * going through `apply`, so a test can supply a metrics service and no
 * balbesHttp/logger. `call` drives the registered handler with a real response seat.
 */
function routeSeats(options: { service?: MemoryServiceLike | undefined; metrics?: MetricsLike | undefined } = {}): {
  seats: Seat[];
  call(path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }>;
} {
  const seats: Seat[] = [];
  const http = {
    post(path: string, auth: "public" | "bearer", handler: Seat["handler"]) { seats.push({ path, auth, handler }); }
  };
  registerMemoryRoutes(http, () => options.service, undefined, () => options.metrics);
  async function call(path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }> {
    const seat = seats.find((candidate) => candidate.path === path);
    if (seat === undefined) throw new Error("no seat registered for " + path);
    const response = makeRes();
    await seat.handler({}, response.res, body);
    return response.read();
  }
  return { seats, call };
}

function harness(options: HarnessOptions = {}) {
  const seats: Seat[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  let service = options.service;
  let metrics = options.metrics;
  const ctx = {
    get(key: string): unknown {
      if (key === "balbesHttp") {
        return options.omitHttp === true
          ? undefined
          : { post(path: string, auth: string, handler: Seat["handler"]) { seats.push({ path, auth, handler }); } };
      }
      if (key === "balbesMemory") return service;
      if (key === "balbesMemoryMetrics") return metrics;
      return undefined;
    },
    logger: {
      warn(message: string) { warnings.push(message); },
      info(message: string) { infos.push(message); }
    }
  };
  // intervalMs: 0 keeps the harness free of any live timer the metrics plugin arm may start.
  apply(ctx as never, { intervalMs: 0 });
  async function call(path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }> {
    const seat = seats.find((candidate) => candidate.path === path);
    if (seat === undefined) throw new Error("no seat registered for " + path);
    const response = makeRes();
    await seat.handler({}, response.res, body);
    return response.read();
  }
  return {
    seats,
    warnings,
    infos,
    call,
    setService(value: MemoryServiceLike | undefined) { service = value; },
    setMetrics(value: MetricsLike | undefined) { metrics = value; }
  };
}

describe("balbes-memory-admin plugin", () => {
  it("exposes the functional plugin contract", () => {
    expect(name).toBe("balbes-memory-admin");
    expect(inject).toEqual(["balbesHttp"]);
    expect(Config({})).toEqual({});
  });

  it("registers the eight bearer routes", () => {
    const h = harness({ service: fakeService() });
    expect(h.seats.map((seat) => seat.path)).toEqual([
      "/api/memory/list",
      "/api/memory/save",
      "/api/memory/delete",
      "/api/memory/propose",
      "/api/memory/review/list",
      "/api/memory/review/approve",
      "/api/memory/review/reject",
      "/api/memory/metrics"
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
    expect(service.listed).toEqual([{ scope: { kind: "global" }, type: "note", tag: "x", pinned: true }]);
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

  it("forces agent origin and ignores body status on propose", async () => {
    const service = fakeService();
    const h = harness({ service });
    const res = await h.call("/api/memory/propose", {
      scope: { kind: "global" },
      type: "fact",
      text: "staged",
      tags: ["Ops"],
      originRef: "pipeline:test",
      origin: "owner",
      status: "accepted",
      pinned: true
    });
    expect(res.status).toBe(200);
    expect(service.proposed).toEqual([
      { scope: { kind: "global" }, type: "fact", text: "staged", tags: ["Ops"], originRef: "pipeline:test" }
    ]);
    expect((res.json as { proposal: MemoryProposal }).proposal.status).toBe("proposed");
  });

  it("rejects a propose body without scope or with a bad tags shape", async () => {
    const service = fakeService();
    const h = harness({ service });
    expect((await h.call("/api/memory/propose", { type: "fact", text: "x" })).status).toBe(400);
    expect((await h.call("/api/memory/propose", { scope: { kind: "global" }, type: "fact", text: "x", tags: "ops" })).status).toBe(400);
    expect(service.proposed).toEqual([]);
  });

  it("serves the queue with the autonomy policy", async () => {
    const service = fakeService();
    const h = harness({ service });
    const res = await h.call("/api/memory/review/list", { status: ["proposed", "rejected"], tag: "ops", limit: 5 });
    expect(res.status).toBe(200);
    expect(service.reviewed).toEqual([{ status: ["proposed", "rejected"], tag: "ops", limit: 5 }]);
    const expectedPolicy: MemoryAutonomyPolicy = { immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" };
    expect(res.json).toEqual({ proposals: [proposal()], policy: expectedPolicy });
  });

  it("always serves the policy, even with an empty queue", async () => {
    const service = fakeService({ listProposals: async () => [] });
    const h = harness({ service });
    const res = await h.call("/api/memory/review/list", {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      proposals: [],
      policy: { immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" }
    });
    expect(service.reviewed).toEqual([]);
  });

  it("approves with a patch and rejects by id", async () => {
    const service = fakeService();
    const h = harness({ service });
    const approved = await h.call("/api/memory/review/approve", { id: "p-1", text: "edited", pinned: true });
    expect(approved.status).toBe(200);
    expect(service.approved).toEqual([{ id: "p-1", patch: { text: "edited", pinned: true } }]);
    expect((approved.json as { record: MemoryRecord }).record.id).toBe("m-1");

    const plain = await h.call("/api/memory/review/approve", { id: "p-1" });
    expect(plain.status).toBe(200);
    expect(service.approved[1]).toEqual({ id: "p-1" });

    const rejected = await h.call("/api/memory/review/reject", { id: "p-1" });
    expect(rejected.status).toBe(200);
    expect(service.rejected).toEqual(["p-1"]);
    expect((rejected.json as { proposal: MemoryProposal }).proposal.status).toBe("rejected");
  });

  it("validates decision bodies and maps invalid-status to 400", async () => {
    const h = harness({ service: fakeService() });
    expect((await h.call("/api/memory/review/approve", {})).status).toBe(400);
    expect((await h.call("/api/memory/review/reject", { id: "" })).status).toBe(400);
    expect((await h.call("/api/memory/review/approve", { id: "p-1", pinned: "yes" })).status).toBe(400);
    expect((await h.call("/api/memory/review/reject", "not-an-object")).status).toBe(400);

    const decided = fakeService({ approve: async () => { throw { code: "invalid-status", message: "already accepted" }; } });
    const h2 = harness({ service: decided });
    const res = await h2.call("/api/memory/review/approve", { id: "p-1" });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: { code: "invalid-status", message: "already accepted" } });
  });

  it("answers 503 memory-unavailable on every review route", async () => {
    const h = harness({ service: undefined });
    for (const path of ["/api/memory/propose", "/api/memory/review/list", "/api/memory/review/approve", "/api/memory/review/reject"]) {
      const res = await h.call(path, { id: "p-1", scope: { kind: "global" }, type: "fact", text: "x" });
      expect(res.status, path).toBe(503);
      expect((res.json as { error: { code: string } }).error.code).toBe("memory-unavailable");
    }
  });

  it("logs one line per review mutation and never the memory text", async () => {
    const service = fakeService();
    const h = harness({ service });
    await h.call("/api/memory/propose", {
      scope: { kind: "project", name: "alpha" },
      type: "fact",
      text: "TOP-SECRET-PROPOSAL-TEXT"
    });
    await h.call("/api/memory/review/approve", { id: "p-1" });
    await h.call("/api/memory/review/reject", { id: "p-2" });
    expect(h.infos).toEqual([
      "balbes-memory-admin: propose id=p-1 scope=project:alpha",
      "balbes-memory-admin: approve id=p-1 edited=false",
      "balbes-memory-admin: reject id=p-2"
    ]);
    expect(h.infos.join("\n")).not.toContain("TOP-SECRET-PROPOSAL-TEXT");

    const edited = fakeService({ approve: async (id) => ({ proposal: proposal({ id, status: "accepted", decidedEdit: true }), record: record({ id: "m-1" }) }) });
    const h2 = harness({ service: edited });
    await h2.call("/api/memory/review/approve", { id: "p-9", text: "left in the body but not logged" });
    expect(h2.infos).toEqual(["balbes-memory-admin: approve id=p-9 edited=true"]);
    expect(h2.infos.join("\n")).not.toContain("left in the body");
  });
});

describe("POST /api/memory/metrics", () => {
  function snapshot(): MemoryMetricsSnapshotLike {
    return {
      schema: 1,
      process: { startedAt: "2026-10-01T00:00:00.000Z", totals: { turns: 3, deliveries: 5 } },
      window: { startedAt: "2026-10-01T00:00:00.000Z", durationMs: 10, turns: 3, deliveries: 5 },
      byChannel: { admin: { turns: 3, deliveries: 5 } },
      byScope: { global: { turns: 3, deliveries: 5 } },
      recall: { calls: 1, empty: 0, failed: 0, latencyMs: { total: 2, max: 2 } },
      unqueriedDelivered: 1,
      dropped: 0,
      topRecords: [
        { id: "m-1", type: "fact", scope: "global", inCore: 1, inMap: 0, inPush: 0, recallDelivered: 0, recallQueries: 0 }
      ]
    };
  }

  it("returns the snapshot and forwards reset/top", async () => {
    const calls: Array<{ reset?: boolean; top?: number } | undefined> = [];
    const expected = snapshot();
    const seats = routeSeats({
      metrics: {
        snapshot(options) {
          calls.push(options);
          return expected;
        }
      }
    });
    const response = await seats.call("/api/memory/metrics", { reset: true, top: 50 });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ metrics: expected });
    expect(calls).toEqual([{ reset: true, top: 50 }]);
  });

  it("uses the defaults when the body is empty", async () => {
    const calls: Array<{ reset?: boolean; top?: number } | undefined> = [];
    const seats = routeSeats({ metrics: { snapshot(options) { calls.push(options); return snapshot(); } } });
    const response = await seats.call("/api/memory/metrics", {});
    expect(response.status).toBe(200);
    expect(calls).toEqual([{}]);
  });

  it("answers 503 when the metrics service is missing", async () => {
    const seats = routeSeats({});
    const response = await seats.call("/api/memory/metrics", {});
    expect(response.status).toBe(503);
    expect(response.json).toEqual({
      error: { code: "metrics-unavailable", message: "memory metrics are not available" }
    });
  });

  it("rejects a non-boolean reset and an out-of-range top", async () => {
    const seats = routeSeats({ metrics: { snapshot: () => snapshot() } });
    for (const body of [{ reset: "yes" }, { top: 0 }, { top: 101 }, { top: 1.5 }, { top: "5" }]) {
      const response = await seats.call("/api/memory/metrics", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((response.json as { error: { code: string } }).error.code).toBe("bad-request");
    }
  });

  it("answers 500 without leaking the memory text when the snapshot throws", async () => {
    const seats = routeSeats({ metrics: { snapshot: () => { throw new Error("boom"); } } });
    const response = await seats.call("/api/memory/metrics", {});
    expect(response.status).toBe(500);
    expect(response.json).toEqual({ error: { code: "internal", message: "boom" } });
  });

  it("registers the route through apply with the bearer auth", () => {
    const seats = harness({ metrics: { snapshot: () => snapshot() } });
    const seat = seats.seats.find((candidate) => candidate.path === "/api/memory/metrics");
    expect(seat?.auth).toBe("bearer");
  });

  it("resolves balbesMemoryMetrics lazily on every request", async () => {
    const h = harness({ metrics: undefined });
    const before = await h.call("/api/memory/metrics", {});
    expect(before.status).toBe(503);
    h.setMetrics({ snapshot: () => snapshot() });
    const after = await h.call("/api/memory/metrics", {});
    expect(after.status).toBe(200);
    expect(after.json).toEqual({ metrics: snapshot() });
  });
});
