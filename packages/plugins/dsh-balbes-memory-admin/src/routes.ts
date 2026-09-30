import type { MemoryProposal, MemoryProposalStatus, MemoryRecord, MemoryScope, MemoryType } from "dsh-balbes-contracts";
import { MEMORY_AUTONOMY_POLICY } from "./policy.js";

/** The registration seat slice of the balbesHttp service. */
export interface HttpSeatLike {
  post(
    path: string,
    auth: "public" | "bearer",
    handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void
  ): void;
}

/** The response seat slice these routes write through. */
export interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** Structural slice of the balbesMemory service the routes consume. */
export interface MemoryFilterLike {
  scope?: MemoryScope;
  type?: MemoryType;
  tag?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryDraftLike {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  pinned?: boolean;
  origin: "owner";
  originRef?: string | null;
}

export interface MemoryPatchLike {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
  originRef?: string | null;
}

/** Structural slice of a staged proposal draft the routes produce. */
export interface MemoryProposalDraftLike {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  originRef?: string;
}

/** Structural slice of the review-queue filter the routes forward. */
export interface MemoryProposalFilterLike {
  scope?: MemoryScope;
  type?: MemoryType;
  tag?: string;
  status?: MemoryProposalStatus[];
  limit?: number;
  offset?: number;
}

/** Structural slice of the owner's approval patch. */
export interface MemoryDecisionPatchLike {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
}

export interface MemoryServiceLike {
  save(draft: MemoryDraftLike): Promise<MemoryRecord>;
  update(id: string, patch: MemoryPatchLike): Promise<MemoryRecord>;
  delete(id: string): Promise<boolean>;
  list(filter?: MemoryFilterLike): Promise<MemoryRecord[]>;
  search(request: { query: string; filter?: MemoryFilterLike; limit?: number }): Promise<Array<{ record: MemoryRecord; rank: number }>>;
  propose(draft: MemoryProposalDraftLike): Promise<MemoryProposal>;
  getProposal(id: string): Promise<MemoryProposal | undefined>;
  listProposals(filter?: MemoryProposalFilterLike): Promise<MemoryProposal[]>;
  approve(id: string, patch?: MemoryDecisionPatchLike): Promise<{ proposal: MemoryProposal; record: MemoryRecord }>;
  reject(id: string): Promise<MemoryProposal>;
}

function send(res: ResLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
  res.end(payload);
}

function sendError(res: ResLike, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

const SERVICE_ERROR_STATUS: Record<string, number> = {
  "invalid-record": 400,
  "invalid-scope": 400,
  "invalid-filter": 400,
  "invalid-query": 400,
  "secret-detected": 400,
  "invalid-status": 400,
  "not-found": 404
};

function serviceErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isObject(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function sendServiceError(res: ResLike, error: unknown): void {
  const code = serviceErrorCode(error);
  const message = errorMessage(error);
  const status = code === undefined ? undefined : SERVICE_ERROR_STATUS[code];
  if (code !== undefined && status !== undefined) {
    sendError(res, status, code, message);
    return;
  }
  sendError(res, 500, "internal", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScope(value: unknown): { ok: true; scope: MemoryScope } | { ok: false; message: string } {
  if (!isObject(value)) return { ok: false, message: "scope must be a JSON object" };
  if (value.kind === "global") {
    if (value.name !== undefined) return { ok: false, message: "scope.name is not allowed for a global scope" };
    return { ok: true, scope: { kind: "global" } };
  }
  if (value.kind === "project") {
    if (typeof value.name !== "string" || value.name === "") {
      return { ok: false, message: "scope.name is required for a project scope" };
    }
    return { ok: true, scope: { kind: "project", name: value.name } };
  }
  return { ok: false, message: "scope.kind must be global or project" };
}

type ParsedList = { ok: true; filter?: MemoryFilterLike; query?: string } | { ok: false; message: string };

function parseList(body: unknown): ParsedList {
  if (!isObject(body)) return { ok: false, message: "request body must be a JSON object" };
  const filter: MemoryFilterLike = {};
  if (body.scope !== undefined) {
    const parsed = parseScope(body.scope);
    if (!parsed.ok) return parsed;
    filter.scope = parsed.scope;
  }
  if (body.type !== undefined) {
    if (typeof body.type !== "string") return { ok: false, message: "type must be a string" };
    filter.type = body.type as MemoryType;
  }
  if (body.tag !== undefined) {
    if (typeof body.tag !== "string") return { ok: false, message: "tag must be a string" };
    filter.tag = body.tag;
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean") return { ok: false, message: "pinned must be a boolean" };
    filter.pinned = body.pinned;
  }
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number") return { ok: false, message: "limit must be a number" };
    filter.limit = body.limit;
  }
  if (body.offset !== undefined) {
    if (typeof body.offset !== "number") return { ok: false, message: "offset must be a number" };
    filter.offset = body.offset;
  }
  if (body.query !== undefined && typeof body.query !== "string") {
    return { ok: false, message: "query must be a string" };
  }
  return { ok: true, ...(Object.keys(filter).length === 0 ? {} : { filter }), ...(typeof body.query === "string" ? { query: body.query } : {}) };
}

type ParsedSave =
  | { ok: true; mode: "create"; scope: MemoryScope; type: MemoryType; text: string; tags?: string[]; pinned?: boolean }
  | { ok: true; mode: "update"; id: string; type: MemoryType; text: string; tags?: string[]; pinned?: boolean }
  | { ok: false; message: string };

function parseSave(body: unknown): ParsedSave {
  if (!isObject(body)) return { ok: false, message: "request body must be a JSON object" };
  if (typeof body.type !== "string" || body.type === "") return { ok: false, message: "type is required" };
  if (typeof body.text !== "string") return { ok: false, message: "text is required" };
  if (body.tags !== undefined && !(Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === "string"))) {
    return { ok: false, message: "tags must be an array of strings" };
  }
  if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
    return { ok: false, message: "pinned must be a boolean" };
  }
  const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined;
  const pinned = typeof body.pinned === "boolean" ? body.pinned : undefined;
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || body.id === "") return { ok: false, message: "id must be a non-empty string" };
    if (body.scope !== undefined) return { ok: false, message: "scope is immutable and not allowed on update" };
    return {
      ok: true,
      mode: "update",
      id: body.id,
      type: body.type as MemoryType,
      text: body.text,
      ...(tags === undefined ? {} : { tags }),
      ...(pinned === undefined ? {} : { pinned })
    };
  }
  if (body.scope === undefined) return { ok: false, message: "scope is required when creating a memory" };
  const parsedScope = parseScope(body.scope);
  if (!parsedScope.ok) return parsedScope;
  return {
    ok: true,
    mode: "create",
    scope: parsedScope.scope,
    type: body.type as MemoryType,
    text: body.text,
    ...(tags === undefined ? {} : { tags }),
    ...(pinned === undefined ? {} : { pinned })
  };
}

type ParsedPropose = { ok: true; draft: MemoryProposalDraftLike } | { ok: false; message: string };

function parsePropose(body: unknown): ParsedPropose {
  if (!isObject(body)) return { ok: false, message: "request body must be a JSON object" };
  if (typeof body.type !== "string" || body.type === "") return { ok: false, message: "type is required" };
  if (typeof body.text !== "string") return { ok: false, message: "text is required" };
  if (body.scope === undefined) return { ok: false, message: "scope is required" };
  const scope = parseScope(body.scope);
  if (!scope.ok) return scope;
  if (body.tags !== undefined && !(Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === "string"))) {
    return { ok: false, message: "tags must be an array of strings" };
  }
  if (body.originRef !== undefined && typeof body.originRef !== "string") {
    return { ok: false, message: "originRef must be a string" };
  }
  return {
    ok: true,
    draft: {
      scope: scope.scope,
      type: body.type as MemoryType,
      text: body.text,
      ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
      ...(typeof body.originRef === "string" ? { originRef: body.originRef } : {})
    }
  };
}

type ParsedReviewList = { ok: true; filter?: MemoryProposalFilterLike } | { ok: false; message: string };

function parseReviewList(body: unknown): ParsedReviewList {
  if (!isObject(body)) return { ok: false, message: "request body must be a JSON object" };
  const filter: MemoryProposalFilterLike = {};
  if (body.scope !== undefined) {
    const parsed = parseScope(body.scope);
    if (!parsed.ok) return parsed;
    filter.scope = parsed.scope;
  }
  if (body.type !== undefined) {
    if (typeof body.type !== "string") return { ok: false, message: "type must be a string" };
    filter.type = body.type as MemoryType;
  }
  if (body.tag !== undefined) {
    if (typeof body.tag !== "string") return { ok: false, message: "tag must be a string" };
    filter.tag = body.tag;
  }
  if (body.status !== undefined) {
    if (!Array.isArray(body.status) || !body.status.every((status) => typeof status === "string")) {
      return { ok: false, message: "status must be an array of strings" };
    }
    filter.status = body.status as MemoryProposalStatus[];
  }
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number") return { ok: false, message: "limit must be a number" };
    filter.limit = body.limit;
  }
  if (body.offset !== undefined) {
    if (typeof body.offset !== "number") return { ok: false, message: "offset must be a number" };
    filter.offset = body.offset;
  }
  return { ok: true, ...(Object.keys(filter).length === 0 ? {} : { filter }) };
}

type ParsedDecision = { ok: true; id: string; patch?: MemoryDecisionPatchLike } | { ok: false; message: string };

function parseDecision(body: unknown, withPatch: boolean): ParsedDecision {
  if (!isObject(body)) return { ok: false, message: "request body must be a JSON object" };
  if (typeof body.id !== "string" || body.id === "") return { ok: false, message: "id must be a non-empty string" };
  if (!withPatch) return { ok: true, id: body.id };
  const patch: MemoryDecisionPatchLike = {};
  if (body.type !== undefined) {
    if (typeof body.type !== "string") return { ok: false, message: "type must be a string" };
    patch.type = body.type as MemoryType;
  }
  if (body.text !== undefined) {
    if (typeof body.text !== "string") return { ok: false, message: "text must be a string" };
    patch.text = body.text;
  }
  if (body.tags !== undefined) {
    if (!(Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === "string"))) {
      return { ok: false, message: "tags must be an array of strings" };
    }
    patch.tags = body.tags as string[];
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean") return { ok: false, message: "pinned must be a boolean" };
    patch.pinned = body.pinned;
  }
  return { ok: true, id: body.id, ...(Object.keys(patch).length === 0 ? {} : { patch }) };
}

function scopeTag(scope: MemoryScope): string {
  return scope.kind === "global" ? "global" : "project:" + scope.name;
}

/** Optional sink for one-line review audit messages; info may be absent. */
export interface RoutesLogger {
  info?(message: string): void;
}

export function registerMemoryRoutes(
  http: HttpSeatLike,
  getService: () => MemoryServiceLike | undefined,
  logger?: RoutesLogger
): void {
  const unavailable = (res: ResLike): void =>
    sendError(res, 503, "memory-unavailable", "memory storage is not available");

  http.post("/api/memory/list", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parseList(body);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      const records = parsed.query !== undefined && parsed.query.trim() !== ""
        ? (await service.search({ query: parsed.query.trim(), ...(parsed.filter === undefined ? {} : { filter: parsed.filter }) })).map((hit) => hit.record)
        : await service.list(parsed.filter);
      send(res, 200, { records });
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/save", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parseSave(body);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      if (parsed.mode === "create") {
        const draft: MemoryDraftLike = {
          scope: parsed.scope,
          type: parsed.type,
          text: parsed.text,
          origin: "owner",
          ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
          ...(parsed.pinned === undefined ? {} : { pinned: parsed.pinned })
        };
        send(res, 200, { record: await service.save(draft) });
      } else {
        const patch: MemoryPatchLike = {
          type: parsed.type,
          text: parsed.text,
          ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
          ...(parsed.pinned === undefined ? {} : { pinned: parsed.pinned })
        };
        send(res, 200, { record: await service.update(parsed.id, patch) });
      }
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/delete", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    if (!isObject(body) || typeof body.id !== "string" || body.id === "") {
      sendError(res, 400, "bad-request", "id is required");
      return;
    }
    try {
      send(res, 200, { deleted: await service.delete(body.id) });
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/propose", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parsePropose(body);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      const proposal = await service.propose(parsed.draft);
      logger?.info?.("balbes-memory-admin: propose id=" + proposal.id + " scope=" + scopeTag(proposal.scope));
      send(res, 200, { proposal });
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/review/list", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parseReviewList(body);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      const proposals = await service.listProposals(parsed.filter);
      send(res, 200, { proposals, policy: MEMORY_AUTONOMY_POLICY });
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/review/approve", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parseDecision(body, true);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      const result = await service.approve(parsed.id, parsed.patch);
      logger?.info?.("balbes-memory-admin: approve id=" + parsed.id + " edited=" + String(result.proposal.decidedEdit));
      send(res, 200, { proposal: result.proposal, record: result.record });
    } catch (error) {
      sendServiceError(res, error);
    }
  });

  http.post("/api/memory/review/reject", "bearer", async (_req, res, body) => {
    const service = getService();
    if (service === undefined) { unavailable(res); return; }
    const parsed = parseDecision(body, false);
    if (!parsed.ok) { sendError(res, 400, "bad-request", parsed.message); return; }
    try {
      const proposal = await service.reject(parsed.id);
      logger?.info?.("balbes-memory-admin: reject id=" + proposal.id);
      send(res, 200, { proposal });
    } catch (error) {
      sendServiceError(res, error);
    }
  });
}
