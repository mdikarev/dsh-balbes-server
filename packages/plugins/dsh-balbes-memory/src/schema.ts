import { mkdirSync } from "node:fs";
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

export interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, up: (db) => db.exec(DDL_V1) }];

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

/** Open the database, back up before any pending migration, then migrate. */
export async function openMemoryDatabase(
  path: string,
  options?: { migrations?: readonly Migration[] }
): Promise<DatabaseSync> {
  const migrations = options?.migrations ?? MIGRATIONS;
  const target = latestVersion(migrations);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
  db.exec("PRAGMA journal_mode=WAL");
  const current = readUserVersion(db);
  if (current > target) {
    db.close();
    throw new MemoryError(
      "invalid-record",
      "database schema v" + current + " is newer than supported v" + target
    );
  }
  if (current > 0 && current < target) {
    await backup(db, path + ".bak-v" + current);
  }
  try {
    migrate(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
