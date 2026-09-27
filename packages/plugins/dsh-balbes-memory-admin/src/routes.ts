import type { MemoryRecord, MemoryScope, MemoryType } from "dsh-balbes-contracts";

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

export interface MemoryServiceLike {
  save(draft: MemoryDraftLike): Promise<MemoryRecord>;
  update(id: string, patch: MemoryPatchLike): Promise<MemoryRecord>;
  delete(id: string): Promise<boolean>;
  list(filter?: MemoryFilterLike): Promise<MemoryRecord[]>;
  search(request: { query: string; filter?: MemoryFilterLike; limit?: number }): Promise<Array<{ record: MemoryRecord; rank: number }>>;
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

export function registerMemoryRoutes(
  http: HttpSeatLike,
  getService: () => MemoryServiceLike | undefined
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
}
