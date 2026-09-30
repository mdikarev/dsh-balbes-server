import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { MemoryError } from "./errors.js";
import { detectSecret } from "./secrets.js";
import { normalizeDraft, normalizeFilter, normalizePatch } from "./validate.js";
import {
  LIMITS,
  type BalbesMemoryService,
  type MemoryFilter,
  type MemoryRecord,
  type MemoryType,
  type MemoryOrigin,
  type SearchHit
} from "./types.js";

type Row = Record<string, unknown>;

function asText(value: unknown, message: string): string {
  if (typeof value !== "string") throw new MemoryError("invalid-record", message);
  return value;
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MemoryError("invalid-record", "corrupt record: expected text column");
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function toScope(kind: unknown, name: unknown): MemoryRecord["scope"] {
  if (kind === "global") return { kind: "global" };
  if (kind === "project") return { kind: "project", name: asText(name, "corrupt record: project scope without a name") };
  throw new MemoryError("invalid-record", "corrupt record: unknown scope kind");
}

function toRecord(row: Row, tags: string[]): MemoryRecord {
  return {
    id: asText(row.id, "corrupt record: missing id"),
    scope: toScope(row.scope_kind, row.scope_name),
    type: asText(row.type, "corrupt record: missing type") as MemoryType,
    text: asText(row.text, "corrupt record: missing text"),
    tags,
    pinned: Number(row.pinned) === 1,
    origin: asText(row.origin, "corrupt record: missing origin") as MemoryOrigin,
    originRef: asNullableText(row.origin_ref),
    createdAt: asText(row.created_at, "corrupt record: missing created_at"),
    updatedAt: asText(row.updated_at, "corrupt record: missing updated_at")
  };
}

export function createMemoryService(db: DatabaseSync): BalbesMemoryService {
  const selectById = db.prepare("SELECT * FROM memories WHERE id = ?");
  const selectTags = db.prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag");
  const insertMemory = db.prepare(
    "INSERT INTO memories (id, scope_kind, scope_name, type, text, pinned, origin, origin_ref, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertTag = db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)");
  const deleteTags = db.prepare("DELETE FROM memory_tags WHERE memory_id = ?");
  const deleteMemoryStatement = db.prepare("DELETE FROM memories WHERE id = ?");
  const updateMemory = db.prepare(
    "UPDATE memories SET type = ?, text = ?, pinned = ?, origin_ref = ?, updated_at = ? WHERE id = ?"
  );

  function tagsOf(id: string): string[] {
    return selectTags.all(id).map((row) => asText(row.tag, "corrupt tag"));
  }

  function load(id: string): MemoryRecord | undefined {
    const row = selectById.get(id);
    if (row === undefined) return undefined;
    return toRecord(row, tagsOf(id));
  }

  function attachTags(rows: Row[]): MemoryRecord[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => asText(row.id, "corrupt record: missing id"));
    const placeholders = ids.map(() => "?").join(", ");
    const tagRows = db
      .prepare("SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (" + placeholders + ") ORDER BY tag")
      .all(...ids);
    const byId = new Map<string, string[]>();
    for (const row of tagRows) {
      const id = asText(row.memory_id, "corrupt tag row");
      const list = byId.get(id);
      if (list === undefined) byId.set(id, [asText(row.tag, "corrupt tag")]);
      else list.push(asText(row.tag, "corrupt tag"));
    }
    return rows.map((row) => {
      const id = asText(row.id, "corrupt record: missing id");
      return toRecord(row, byId.get(id) ?? []);
    });
  }

  function buildClauses(filter: MemoryFilter): { clauses: string[]; params: SQLInputValue[] } {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.scope !== undefined) {
      if (filter.scope.kind === "global") clauses.push("m.scope_kind = 'global'");
      else {
        clauses.push("m.scope_kind = 'project' AND m.scope_name = ?");
        params.push(filter.scope.name);
      }
    }
    if (filter.scopes !== undefined) {
      if (filter.scopes.length === 0) clauses.push("0 = 1");
      else {
        const ors: string[] = [];
        for (const scope of filter.scopes) {
          if (scope.kind === "global") ors.push("m.scope_kind = 'global'");
          else {
            ors.push("(m.scope_kind = 'project' AND m.scope_name = ?)");
            params.push(scope.name);
          }
        }
        clauses.push("(" + ors.join(" OR ") + ")");
      }
    }
    if (filter.type !== undefined) {
      clauses.push("m.type = ?");
      params.push(filter.type);
    }
    if (filter.pinned !== undefined) {
      clauses.push("m.pinned = ?");
      params.push(filter.pinned ? 1 : 0);
    }
    if (filter.tag !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM memory_tags t WHERE t.memory_id = m.id AND t.tag = ?)");
      params.push(filter.tag);
    }
    return { clauses, params };
  }

  function whereOf(clauses: string[]): string {
    return clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
  }

  async function save(draft: Parameters<BalbesMemoryService["save"]>[0]): Promise<MemoryRecord> {
    const normalized = normalizeDraft(draft);
    const secret = detectSecret(normalized.text);
    if (secret !== null) {
      throw new MemoryError("secret-detected", 'text matches secret rule "' + secret.rule + '"');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const scopeName = normalized.scope.kind === "project" ? normalized.scope.name : null;
    db.exec("BEGIN");
    try {
      insertMemory.run(
        id,
        normalized.scope.kind,
        scopeName,
        normalized.type,
        normalized.text,
        normalized.pinned ? 1 : 0,
        normalized.origin,
        normalized.originRef,
        now,
        now
      );
      for (const tag of normalized.tags) insertTag.run(id, tag);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const record = load(id);
    if (record === undefined) throw new MemoryError("not-found", "memory vanished after insert: " + id);
    return record;
  }

  async function get(id: string): Promise<MemoryRecord | undefined> {
    return load(id);
  }

  async function update(id: string, patch: Parameters<BalbesMemoryService["update"]>[1]): Promise<MemoryRecord> {
    const existing = load(id);
    if (existing === undefined) throw new MemoryError("not-found", "memory not found: " + id);
    const normalized = normalizePatch(patch);
    if (normalized.text !== undefined) {
      const secret = detectSecret(normalized.text);
      if (secret !== null) {
        throw new MemoryError("secret-detected", 'text matches secret rule "' + secret.rule + '"');
      }
    }
    const now = new Date().toISOString();
    const nextPinned = normalized.pinned ?? existing.pinned;
    const nextOriginRef = normalized.originRef !== undefined ? normalized.originRef : existing.originRef;
    db.exec("BEGIN");
    try {
      updateMemory.run(
        normalized.type ?? existing.type,
        normalized.text ?? existing.text,
        nextPinned ? 1 : 0,
        nextOriginRef,
        now,
        id
      );
      if (normalized.tags !== undefined) {
        deleteTags.run(id);
        for (const tag of normalized.tags) insertTag.run(id, tag);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const updated = load(id);
    if (updated === undefined) throw new MemoryError("not-found", "memory vanished during update: " + id);
    return updated;
  }

  async function remove(id: string): Promise<boolean> {
    const result = deleteMemoryStatement.run(id);
    return Number(result.changes) > 0;
  }

  async function list(rawFilter?: MemoryFilter): Promise<MemoryRecord[]> {
    const filter = normalizeFilter(rawFilter);
    const { clauses, params } = buildClauses(filter);
    const limit = clamp(filter.limit ?? LIMITS.defaultListLimit, 1, LIMITS.maxListLimit);
    const offset = filter.offset ?? 0;
    const rows = db
      .prepare(
        "SELECT m.* FROM memories m " +
          whereOf(clauses) +
          " ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ? OFFSET ?"
      )
      .all(...params, limit, offset);
    return attachTags(rows);
  }

  async function search(request: Parameters<BalbesMemoryService["search"]>[0]): Promise<SearchHit[]> {
    if (typeof request !== "object" || request === null) {
      throw new MemoryError("invalid-query", "request must be an object");
    }
    const query = typeof request.query === "string" ? request.query.trim() : "";
    if (query === "") throw new MemoryError("invalid-query", "query must not be empty");
    const filter = normalizeFilter(request.filter);
    const limit = clamp(request.limit ?? filter.limit ?? LIMITS.defaultSearchLimit, 1, LIMITS.maxSearchLimit);
    const { clauses, params } = buildClauses(filter);
    let rows: Row[];
    try {
      rows = db
        .prepare(
          "SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts " +
            "JOIN memories m ON m.rowid = memory_fts.rowid " +
            whereOf(["memory_fts MATCH ?", ...clauses]) +
            " ORDER BY m.pinned DESC, rank ASC LIMIT ?"
        )
        .all(query, ...params, limit);
    } catch (error) {
      throw new MemoryError(
        "invalid-query",
        "invalid search query: " + (error instanceof Error ? error.message : String(error))
      );
    }
    const records = attachTags(rows);
    return rows.map((row, index) => {
      const record = records[index];
      if (record === undefined) throw new MemoryError("invalid-record", "row mapping mismatch");
      return { record, rank: Number(row.rank) };
    });
  }

  async function count(rawFilter?: MemoryFilter): Promise<number> {
    const filter = normalizeFilter(rawFilter);
    const { clauses, params } = buildClauses(filter);
    const row = db.prepare("SELECT COUNT(*) AS n FROM memories m " + whereOf(clauses)).get(...params);
    return Number(row?.n ?? 0);
  }

  return { save, get, update, delete: remove, list, search, count };
}
