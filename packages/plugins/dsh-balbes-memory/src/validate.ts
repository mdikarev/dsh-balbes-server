import { MemoryError } from "./errors.js";
import {
  LIMITS,
  MEMORY_ORIGINS,
  MEMORY_TYPES,
  type MemoryDraft,
  type MemoryFilter,
  type MemoryOrigin,
  type MemoryPatch,
  type MemoryScope,
  type MemoryType
} from "./types.js";

const SCOPE_NAME = /^[A-Za-z0-9._-]+$/;
const TAG = /^[a-z0-9._-]+$/;

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

function isMemoryOrigin(value: unknown): value is MemoryOrigin {
  return typeof value === "string" && (MEMORY_ORIGINS as readonly string[]).includes(value);
}

export function assertScope(scope: unknown): MemoryScope {
  if (typeof scope !== "object" || scope === null) {
    throw new MemoryError("invalid-scope", "scope must be an object");
  }
  const candidate = scope as { kind?: unknown; name?: unknown };
  if (candidate.kind === "global") {
    if (candidate.name !== undefined) {
      throw new MemoryError("invalid-scope", "global scope must not carry a name");
    }
    return { kind: "global" };
  }
  if (candidate.kind === "project") {
    const name = candidate.name;
    if (typeof name !== "string" || name === "") {
      throw new MemoryError("invalid-scope", "project scope requires a name");
    }
    if (
      name.length > LIMITS.maxScopeNameLength ||
      !SCOPE_NAME.test(name) ||
      name.startsWith(".") ||
      name.endsWith(".")
    ) {
      throw new MemoryError("invalid-scope", "invalid project name: " + name);
    }
    return { kind: "project", name };
  }
  throw new MemoryError("invalid-scope", 'scope.kind must be "global" or "project"');
}

export function normalizeTag(tag: string): string {
  const normalized = tag.trim().toLowerCase();
  if (normalized === "" || normalized.length > LIMITS.maxTagLength || !TAG.test(normalized)) {
    throw new MemoryError("invalid-record", "invalid tag: " + tag);
  }
  return normalized;
}

export function normalizeTags(tags: unknown): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) throw new MemoryError("invalid-record", "tags must be an array");
  if (tags.length > LIMITS.maxTags) throw new MemoryError("invalid-record", "too many tags");
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") throw new MemoryError("invalid-record", "tags must be strings");
    const normalized = normalizeTag(tag);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export function normalizeText(text: unknown): string {
  if (typeof text !== "string") throw new MemoryError("invalid-record", "text must be a string");
  const trimmed = text.trim();
  if (trimmed === "") throw new MemoryError("invalid-record", "text must not be empty");
  if (Buffer.byteLength(trimmed, "utf8") > LIMITS.maxTextBytes) {
    throw new MemoryError("invalid-record", "text exceeds the size limit");
  }
  return trimmed;
}

export function normalizeOriginRef(ref: unknown): string | null {
  if (ref === undefined || ref === null) return null;
  if (typeof ref !== "string") throw new MemoryError("invalid-record", "originRef must be a string or null");
  if (ref.length > LIMITS.maxOriginRefLength) throw new MemoryError("invalid-record", "originRef is too long");
  return ref;
}

export interface NormalizedDraft {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags: string[];
  pinned: boolean;
  origin: MemoryOrigin;
  originRef: string | null;
}

export function normalizeDraft(draft: unknown): NormalizedDraft {
  if (typeof draft !== "object" || draft === null) {
    throw new MemoryError("invalid-record", "draft must be an object");
  }
  const d = draft as Record<string, unknown>;
  if (!isMemoryType(d.type)) throw new MemoryError("invalid-record", "invalid type");
  if (!isMemoryOrigin(d.origin)) throw new MemoryError("invalid-record", "invalid origin");
  if (d.pinned !== undefined && typeof d.pinned !== "boolean") {
    throw new MemoryError("invalid-record", "pinned must be a boolean");
  }
  return {
    scope: assertScope(d.scope),
    type: d.type,
    text: normalizeText(d.text),
    tags: normalizeTags(d.tags),
    pinned: d.pinned === true,
    origin: d.origin,
    originRef: normalizeOriginRef(d.originRef)
  };
}

export interface NormalizedPatch {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
  originRef?: string | null;
}

export function normalizePatch(patch: unknown): NormalizedPatch {
  if (typeof patch !== "object" || patch === null) {
    throw new MemoryError("invalid-record", "patch must be an object");
  }
  const p = patch as Record<string, unknown>;
  const out: NormalizedPatch = {};
  if (p.type !== undefined) {
    if (!isMemoryType(p.type)) throw new MemoryError("invalid-record", "invalid type");
    out.type = p.type;
  }
  if (p.text !== undefined) out.text = normalizeText(p.text);
  if (p.tags !== undefined) out.tags = normalizeTags(p.tags);
  if (p.pinned !== undefined) {
    if (typeof p.pinned !== "boolean") throw new MemoryError("invalid-record", "pinned must be a boolean");
    out.pinned = p.pinned;
  }
  if (p.originRef !== undefined) out.originRef = normalizeOriginRef(p.originRef);
  return out;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MemoryError("invalid-filter", field + " must be a non-negative integer");
  }
  return value;
}

export function normalizeFilter(filter: unknown): MemoryFilter {
  if (filter === undefined) return {};
  if (typeof filter !== "object" || filter === null) {
    throw new MemoryError("invalid-filter", "filter must be an object");
  }
  const f = filter as Record<string, unknown>;
  const out: MemoryFilter = {};
  if (f.scope !== undefined) out.scope = assertScope(f.scope);
  if (f.scopes !== undefined) {
    if (!Array.isArray(f.scopes)) throw new MemoryError("invalid-filter", "scopes must be an array");
    out.scopes = f.scopes.map((scope) => assertScope(scope));
  }
  if (f.type !== undefined) {
    if (!isMemoryType(f.type)) throw new MemoryError("invalid-filter", "invalid type");
    out.type = f.type;
  }
  if (f.tag !== undefined) {
    if (typeof f.tag !== "string") throw new MemoryError("invalid-filter", "tag must be a string");
    out.tag = normalizeTag(f.tag);
  }
  if (f.pinned !== undefined) {
    if (typeof f.pinned !== "boolean") throw new MemoryError("invalid-filter", "pinned must be a boolean");
    out.pinned = f.pinned;
  }
  if (f.limit !== undefined) out.limit = assertNonNegativeInteger(f.limit, "limit");
  if (f.offset !== undefined) out.offset = assertNonNegativeInteger(f.offset, "offset");
  return out;
}
