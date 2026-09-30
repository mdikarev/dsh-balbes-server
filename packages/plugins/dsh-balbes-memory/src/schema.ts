import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { MemoryError } from "./errors.js";

export const DDL_V1 = [
  "CREATE TABLE memories (",
  "  id          TEXT PRIMARY KEY,",
  "  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('global','project')),",
  "  scope_name  TEXT,",
  "  type        TEXT NOT NULL CHECK (type IN ('fact','preference','decision','note')),",
  "  text        TEXT NOT NULL,",
  "  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),",
  "  origin      TEXT NOT NULL CHECK (origin IN ('owner','agent')),",
  "  origin_ref  TEXT,",
  "  created_at  TEXT NOT NULL,",
  "  updated_at  TEXT NOT NULL,",
  "  embedding   BLOB,",
  "  CHECK ((scope_kind = 'global'  AND scope_name IS NULL)",
  "      OR (scope_kind = 'project' AND scope_name IS NOT NULL))",
  ");",
  "CREATE INDEX idx_memories_scope ON memories(scope_kind, scope_name);",
  "CREATE INDEX idx_memories_type  ON memories(type);",
  "CREATE TABLE memory_tags (",
  "  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,",
  "  tag       TEXT NOT NULL,",
  "  PRIMARY KEY (memory_id, tag)",
  ");",
  "CREATE INDEX idx_memory_tags_tag ON memory_tags(tag);",
  "CREATE VIRTUAL TABLE memory_fts USING fts5(",
  "  text,",
  "  content='memories', content_rowid='rowid',",
  "  tokenize='unicode61 remove_diacritics 2'",
  ");",
  "CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN",
  "  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);",
  "END;",
  "CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN",
  "  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);",
  "END;",
  "CREATE TRIGGER memories_au AFTER UPDATE OF text ON memories BEGIN",
  "  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);",
  "  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);",
  "END;"
].join("\n");

/**
 * v2 (p10f): staged proposals live in their own table. The truth table
 * `memories`, its normalized tags and its FTS triggers are not touched, which is
 * what makes pending knowledge structurally invisible to delivery.
 */
export const DDL_V2 = [
  "CREATE TABLE memory_proposals (",
  "  id           TEXT PRIMARY KEY,",
  "  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('global','project')),",
  "  scope_name   TEXT,",
  "  type         TEXT NOT NULL CHECK (type IN ('fact','preference','decision','note')),",
  "  text         TEXT NOT NULL,",
  "  tags         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),",
  "  origin       TEXT NOT NULL CHECK (origin IN ('owner','agent')),",
  "  origin_ref   TEXT,",
  "  status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected')),",
  "  proposed_at  TEXT NOT NULL,",
  "  decided_at   TEXT,",
  "  decided_by   TEXT,",
  "  decided_edit INTEGER NOT NULL DEFAULT 0 CHECK (decided_edit IN (0,1)),",
  "  memory_id    TEXT REFERENCES memories(id) ON DELETE SET NULL,",
  "  CHECK ((scope_kind = 'global'  AND scope_name IS NULL)",
  "      OR (scope_kind = 'project' AND scope_name IS NOT NULL)),",
  "  CHECK ((status =  'proposed' AND decided_at IS NULL)",
  "      OR (status <> 'proposed' AND decided_at IS NOT NULL))",
  ");",
  "CREATE INDEX idx_memory_proposals_status ON memory_proposals(status, proposed_at);",
  "CREATE INDEX idx_memory_proposals_scope  ON memory_proposals(scope_kind, scope_name);"
].join("\n");

/**
 * v3 (p10f): rejection no longer leaves a row behind, so rows accumulated by the
 * legacy behaviour are dropped. This is data, not schema: the DDL and indexes of
 * `memory_proposals` do not change, and an idempotent re-run on a clean table
 * finds nothing to delete.
 */
export const DDL_V3 = "DELETE FROM memory_proposals WHERE status = 'rejected'";

export interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: (db) => db.exec(DDL_V1) },
  { version: 2, up: (db) => db.exec(DDL_V2) },
  { version: 3, up: (db) => db.exec(DDL_V3) }
];

export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, migration) => (migration.version > max ? migration.version : max), 0);
}

export const LATEST_VERSION = latestVersion(MIGRATIONS);

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.user_version;
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** Apply pending migrations in one transaction. Idempotent. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  const current = readUserVersion(db);
  const target = latestVersion(migrations);
  if (current > target) {
    throw new MemoryError(
      "invalid-record",
      "database schema v" + current + " is newer than supported v" + target
    );
  }
  if (current === target) return current;
  const pending = migrations
    .filter((migration) => migration.version > current)
    .slice()
    .sort((a, b) => a.version - b.version);
  db.exec("BEGIN");
  try {
    for (const migration of pending) {
      migration.up(db);
      db.exec("PRAGMA user_version = " + migration.version);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return target;
}

const REQUIRED_SCHEMA_OBJECTS: ReadonlyArray<{ type: string; name: string }> = [
  { type: "table", name: "memories" },
  { type: "table", name: "memory_tags" },
  { type: "table", name: "memory_fts" },
  { type: "table", name: "memory_proposals" },
  { type: "trigger", name: "memories_ai" },
  { type: "trigger", name: "memories_ad" },
  { type: "trigger", name: "memories_au" }
];

/**
 * Refuse a database that claims to be at the target version but does not carry
 * the tables/triggers this build requires (foreign or corrupt schema). This is
 * how a file with user_version=1 but no memories table is detected instead of
 * failing later inside createMemoryService.
 */
export function validateMemorySchema(db: DatabaseSync): void {
  const rows = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','trigger')").all();
  const present = new Set(rows.map((row) => String(row.type) + ":" + String(row.name)));
  const missing = REQUIRED_SCHEMA_OBJECTS.filter((object) => !present.has(object.type + ":" + object.name));
  if (missing.length > 0) {
    throw new MemoryError(
      "invalid-record",
      "database is missing required schema objects: " +
        missing.map((object) => object.type + " " + object.name).join(", ")
    );
  }
}

/**
 * Read the stored version through a read-only handle so the newer-schema gate
 * never opens the file for writing. Returns null when the probe cannot read
 * (the caller then gates on the read-write handle, still before any write).
 */
function probeUserVersion(path: string): number | null {
  try {
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      return readUserVersion(probe);
    } finally {
      probe.close();
    }
  } catch {
    return null;
  }
}

/** Open the database, back up before any pending migration, then migrate. */
export async function openMemoryDatabase(
  path: string,
  options?: { migrations?: readonly Migration[] }
): Promise<DatabaseSync> {
  const migrations = options?.migrations ?? MIGRATIONS;
  const target = latestVersion(migrations);
  mkdirSync(dirname(path), { recursive: true });

  // Spec migration step 5: a database newer than this build must be refused
  // before ANY write (WAL pragma, backup, or migration). Probe read-only first
  // so a refused file stays byte-identical and keeps its journal mode.
  if (existsSync(path)) {
    const probed = probeUserVersion(path);
    if (probed !== null && probed > target) {
      throw new MemoryError(
        "invalid-record",
        "database schema v" + probed + " is newer than supported v" + target
      );
    }
  }

  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
  try {
    // Re-read on the live handle (a read, never a write) to cover a failed probe.
    const current = readUserVersion(db);
    if (current > target) {
      throw new MemoryError(
        "invalid-record",
        "database schema v" + current + " is newer than supported v" + target
      );
    }
    if (current === target && target > 0) {
      // Validate before switching journal mode so a foreign schema is not written.
      validateMemorySchema(db);
    }
    db.exec("PRAGMA journal_mode=WAL");
    if (current < target) {
      if (current > 0) {
        await backup(db, path + ".bak-v" + current);
      }
      migrate(db, migrations);
      if (target > 0) validateMemorySchema(db);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
