import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  MemoryProposal,
  MemoryProposalStatus,
  MemoryOrigin,
  MemoryRecord,
  MemoryType
} from "dsh-balbes-contracts";
import { MemoryError } from "./errors.js";
import { detectSecret } from "./secrets.js";
import { normalizeDecisionPatch, normalizeProposalDraft, normalizeProposalFilter } from "./validate.js";
import {
  LIMITS,
  type MemoryDecisionPatch,
  type MemoryProposalDraft,
  type MemoryProposalFilter
} from "./types.js";

type Row = Record<string, unknown>;

/** The shared truth-table writer, owned by the service so promotion is not a bypass. */
export interface ProposalWriterDeps {
  /** Insert a memory row and its tags under the given id, inside the caller's open transaction. */
  insertMemoryRecord(
    id: string,
    input: {
      scope: MemoryRecord["scope"];
      type: MemoryType;
      text: string;
      tags: string[];
      pinned: boolean;
      origin: MemoryOrigin;
      originRef: string | null;
    }
  ): void;
  loadRecord(id: string): MemoryRecord | undefined;
}

export interface ProposalStore {
  propose(draft: MemoryProposalDraft): Promise<MemoryProposal>;
  getProposal(id: string): Promise<MemoryProposal | undefined>;
  listProposals(filter?: MemoryProposalFilter): Promise<MemoryProposal[]>;
  approve(id: string, patch?: MemoryDecisionPatch): Promise<{ proposal: MemoryProposal; record: MemoryRecord }>;
  reject(id: string): Promise<MemoryProposal>;
}

function asText(value: unknown, message: string): string {
  if (typeof value !== "string") throw new MemoryError("invalid-record", message);
  return value;
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MemoryError("invalid-record", "corrupt proposal: expected text column");
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function toScope(kind: unknown, name: unknown): MemoryRecord["scope"] {
  if (kind === "global") return { kind: "global" };
  if (kind === "project") {
    return { kind: "project", name: asText(name, "corrupt proposal: project scope without a name") };
  }
  throw new MemoryError("invalid-record", "corrupt proposal: unknown scope kind");
}

/** Tags are a JSON array column; a decode failure is corruption, not a client error. */
function decodeTags(raw: unknown): string[] {
  const text = asText(raw, "corrupt proposal: missing tags");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MemoryError("invalid-record", "corrupt proposal: tags is not JSON");
  }
  if (!Array.isArray(parsed) || !parsed.every((tag) => typeof tag === "string")) {
    throw new MemoryError("invalid-record", "corrupt proposal: tags is not a string array");
  }
  return parsed;
}

function toProposal(row: Row): MemoryProposal {
  return {
    id: asText(row.id, "corrupt proposal: missing id"),
    scope: toScope(row.scope_kind, row.scope_name),
    type: asText(row.type, "corrupt proposal: missing type") as MemoryType,
    text: asText(row.text, "corrupt proposal: missing text"),
    tags: decodeTags(row.tags),
    origin: asText(row.origin, "corrupt proposal: missing origin") as MemoryOrigin,
    originRef: asNullableText(row.origin_ref),
    status: asText(row.status, "corrupt proposal: missing status") as MemoryProposalStatus,
    proposedAt: asText(row.proposed_at, "corrupt proposal: missing proposed_at"),
    decidedAt: asNullableText(row.decided_at),
    decidedBy: asNullableText(row.decided_by),
    decidedEdit: Number(row.decided_edit) === 1,
    memoryId: asNullableText(row.memory_id)
  };
}

export function createProposalStore(db: DatabaseSync, deps: ProposalWriterDeps): ProposalStore {
  const selectById = db.prepare("SELECT * FROM memory_proposals WHERE id = ?");
  const insertProposal = db.prepare(
    "INSERT INTO memory_proposals " +
      "(id, scope_kind, scope_name, type, text, tags, origin, origin_ref, status, proposed_at, decided_at, decided_by, decided_edit, memory_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, NULL, NULL, 0, NULL)"
  );

  function load(id: string): MemoryProposal | undefined {
    const row = selectById.get(id);
    return row === undefined ? undefined : toProposal(row);
  }

  function buildClauses(filter: MemoryProposalFilter): { clauses: string[]; params: SQLInputValue[] } {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    const statuses = filter.status ?? ["proposed"];
    clauses.push("p.status IN (" + statuses.map(() => "?").join(", ") + ")");
    for (const status of statuses) params.push(status);
    if (filter.scope !== undefined) {
      if (filter.scope.kind === "global") clauses.push("p.scope_kind = 'global'");
      else {
        clauses.push("p.scope_kind = 'project' AND p.scope_name = ?");
        params.push(filter.scope.name);
      }
    }
    if (filter.type !== undefined) {
      clauses.push("p.type = ?");
      params.push(filter.type);
    }
    if (filter.tag !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(p.tags) WHERE json_each.value = ?)");
      params.push(filter.tag);
    }
    return { clauses, params };
  }

  async function propose(draft: MemoryProposalDraft): Promise<MemoryProposal> {
    const normalized = normalizeProposalDraft(draft);
    const secret = detectSecret(normalized.text);
    if (secret !== null) {
      throw new MemoryError("secret-detected", 'text matches secret rule "' + secret.rule + '"');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    insertProposal.run(
      id,
      normalized.scope.kind,
      normalized.scope.kind === "project" ? normalized.scope.name : null,
      normalized.type,
      normalized.text,
      JSON.stringify(normalized.tags),
      "agent",
      normalized.originRef,
      now
    );
    const proposal = load(id);
    if (proposal === undefined) throw new MemoryError("not-found", "proposal vanished after insert: " + id);
    return proposal;
  }

  async function listProposals(rawFilter?: MemoryProposalFilter): Promise<MemoryProposal[]> {
    const filter = normalizeProposalFilter(rawFilter);
    const { clauses, params } = buildClauses(filter);
    const limit = clamp(filter.limit ?? LIMITS.defaultListLimit, 1, LIMITS.maxListLimit);
    const offset = filter.offset ?? 0;
    const rows = db
      .prepare(
        "SELECT p.* FROM memory_proposals p WHERE " + clauses.join(" AND ") +
          " ORDER BY p.proposed_at ASC, p.id ASC LIMIT ? OFFSET ?"
      )
      .all(...params, limit, offset);
    return rows.map(toProposal);
  }

  const decideProposal = db.prepare(
    "UPDATE memory_proposals SET status = ?, decided_at = ?, decided_by = ?, decided_edit = ?, memory_id = ? WHERE id = ? AND status = 'proposed'"
  );

  /** Content-only edit detection: pinning is an owner action, not an edit. */
  function isContentEdit(
    proposal: MemoryProposal,
    patch: MemoryDecisionPatch
  ): boolean {
    if (patch.type !== undefined && patch.type !== proposal.type) return true;
    if (patch.text !== undefined && patch.text !== proposal.text) return true;
    if (patch.tags !== undefined) {
      const same =
        patch.tags.length === proposal.tags.length &&
        patch.tags.every((tag, index) => tag === proposal.tags[index]);
      if (!same) return true;
    }
    return false;
  }

  async function approve(
    id: string,
    rawPatch?: MemoryDecisionPatch
  ): Promise<{ proposal: MemoryProposal; record: MemoryRecord }> {
    const proposal = load(id);
    if (proposal === undefined) throw new MemoryError("not-found", "proposal not found: " + id);
    if (proposal.status !== "proposed") {
      throw new MemoryError("invalid-status", "proposal is already " + proposal.status + ": " + id);
    }
    const patch = normalizeDecisionPatch(rawPatch ?? {});
    const text = patch.text ?? proposal.text;
    const secret = detectSecret(text);
    if (secret !== null) {
      throw new MemoryError("secret-detected", 'text matches secret rule "' + secret.rule + '"');
    }
    const edited = isContentEdit(proposal, patch);
    const now = new Date().toISOString();
    // The id is minted here so every post-commit read works on a plain local.
    const memoryId = randomUUID();
    db.exec("BEGIN");
    try {
      deps.insertMemoryRecord(memoryId, {
        scope: proposal.scope,
        type: patch.type ?? proposal.type,
        text,
        tags: patch.tags ?? proposal.tags,
        pinned: patch.pinned ?? false,
        origin: proposal.origin,
        originRef: proposal.originRef
      });
      const result = decideProposal.run("accepted", now, "owner", edited ? 1 : 0, memoryId, id);
      if (Number(result.changes) !== 1) {
        throw new MemoryError("invalid-status", "proposal was decided concurrently: " + id);
      }
      db.exec("COMMIT");
    } catch (error) {
      // Inside the transaction: the promotion and the decision stand or fall together.
      db.exec("ROLLBACK");
      throw error;
    }
    const record = deps.loadRecord(memoryId);
    if (record === undefined) throw new MemoryError("not-found", "memory vanished after promotion: " + memoryId);
    const decided = load(id);
    if (decided === undefined) throw new MemoryError("not-found", "proposal vanished after approval: " + id);
    return { proposal: decided, record };
  }

  async function reject(id: string): Promise<MemoryProposal> {
    const proposal = load(id);
    if (proposal === undefined) throw new MemoryError("not-found", "proposal not found: " + id);
    if (proposal.status !== "proposed") {
      throw new MemoryError("invalid-status", "proposal is already " + proposal.status + ": " + id);
    }
    const result = decideProposal.run("rejected", new Date().toISOString(), "owner", 0, null, id);
    if (Number(result.changes) !== 1) {
      throw new MemoryError("invalid-status", "proposal was decided concurrently: " + id);
    }
    const decided = load(id);
    if (decided === undefined) throw new MemoryError("not-found", "proposal vanished after rejection: " + id);
    return decided;
  }

  return { propose, getProposal: async (id) => load(id), listProposals, approve, reject };
}
