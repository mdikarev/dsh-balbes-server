import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryError } from "../src/errors.js";
import {
  LATEST_VERSION,
  MIGRATIONS,
  migrate,
  openMemoryDatabase,
  readUserVersion,
  type Migration
} from "../src/schema.js";

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "balbes-memory-schema-"));
  dirs.push(dir);
  return dir;
}

/** Read a PRAGMA through a read-only handle so it cannot itself write. */
function readPragma(path: string, name: "user_version" | "journal_mode"): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("PRAGMA " + name).get()?.[name];
  } finally {
    db.close();
  }
}

/** The DDL of every table/index/trigger, ordered for a stable comparison. */
function readSchemaObjects(db: DatabaseSync): Array<{ type: string; name: string; sql: string }> {
  return db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type, name")
    .all()
    .map((row) => ({ type: String(row.type), name: String(row.name), sql: String(row.sql) }));
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe("openMemoryDatabase", () => {
  it("creates schema v3 and is idempotent", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const { db, changes } = await openMemoryDatabase(path);
    expect(readUserVersion(db)).toBe(3);
    expect(LATEST_VERSION).toBe(3);
    expect(changes).toBe(0);
    db.close();
    const { db: reopened, changes: reopenedChanges } = await openMemoryDatabase(path);
    expect(readUserVersion(reopened)).toBe(3);
    expect(reopenedChanges).toBe(0);
    reopened.close();
  });

  it("migration v3 drops legacy rejected proposals and keeps the rest", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    // Genuine on-disk v2 state: v1 and v2 ran, v3 has not. Built directly so the
    // fixture really is a legacy database, not one this build already cleaned.
    const db = new DatabaseSync(path);
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 2)
    );
    // The accepted proposal points at its promoted memory, so the FK holds.
    db.prepare(
      "INSERT INTO memories (id, scope_kind, scope_name, type, text, pinned, origin, origin_ref, created_at, updated_at) " +
        "VALUES ('m-1', 'global', NULL, 'note', 'promoted truth', 0, 'agent', NULL, ?, ?)"
    ).run("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    db.exec(
      "INSERT INTO memory_proposals (id, scope_kind, scope_name, type, text, tags, origin, origin_ref, status, proposed_at, decided_at, decided_by, decided_edit, memory_id) VALUES " +
        "('legacy-rejected','global',NULL,'note','old reject','[]','agent',NULL,'rejected','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z','owner',0,NULL)," +
        "('legacy-accepted','global',NULL,'note','kept','[]','agent',NULL,'accepted','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z','owner',0,'m-1')," +
        "('live','global',NULL,'note','pending','[]','agent',NULL,'proposed','2026-09-01T00:00:00.000Z',NULL,NULL,0,NULL)"
    );
    expect(readUserVersion(db)).toBe(2);

    const applied = migrate(db);
    expect(applied).toEqual({ version: 3, changes: 1 });

    expect(readUserVersion(db)).toBe(3);
    const rows = db.prepare("SELECT id, status FROM memory_proposals ORDER BY id").all();
    expect(rows).toEqual([
      { id: "legacy-accepted", status: "accepted" },
      { id: "live", status: "proposed" }
    ]);
    // Idempotence for real: at v3 migrate() would early-return, so rewind the
    // pragma to make it run v3's DELETE again and prove the statement finds
    // nothing left to remove.
    db.exec("PRAGMA user_version = 2");
    expect(migrate(db)).toEqual({ version: 3, changes: 0 });
    expect(readUserVersion(db)).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_proposals").get()).toEqual({ n: 2 });
    db.close();
  });

  it("upgrades a real v2 file through openMemoryDatabase, purging and backing up", async () => {
    const dir = await tempDir();
    const path = join(dir, "memory.sqlite");
    // A genuine on-disk v2 file built with a raw handle, then closed: only
    // openMemoryDatabase exercises the backup and the post-migration validation.
    const legacy = new DatabaseSync(path);
    migrate(
      legacy,
      MIGRATIONS.filter((migration) => migration.version <= 2)
    );
    legacy.prepare(
      "INSERT INTO memories (id, scope_kind, scope_name, type, text, pinned, origin, origin_ref, created_at, updated_at) " +
        "VALUES ('m-1', 'global', NULL, 'note', 'promoted truth', 0, 'agent', NULL, ?, ?)"
    ).run("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    legacy.exec(
      "INSERT INTO memory_proposals (id, scope_kind, scope_name, type, text, tags, origin, origin_ref, status, proposed_at, decided_at, decided_by, decided_edit, memory_id) VALUES " +
        "('legacy-rejected','global',NULL,'note','old reject','[]','agent',NULL,'rejected','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z','owner',0,NULL)," +
        "('legacy-accepted','global',NULL,'note','kept','[]','agent',NULL,'accepted','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z','owner',0,'m-1')," +
        "('live','global',NULL,'note','pending','[]','agent',NULL,'proposed','2026-09-01T00:00:00.000Z',NULL,NULL,0,NULL)"
    );
    expect(readUserVersion(legacy)).toBe(2);
    legacy.close();

    const { db: upgraded, changes } = await openMemoryDatabase(path);

    expect(changes).toBe(1);
    expect(readUserVersion(upgraded)).toBe(3);
    expect(upgraded.prepare("SELECT id FROM memory_proposals WHERE status = 'rejected'").all()).toEqual([]);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM memory_proposals").get()).toEqual({ n: 2 });
    upgraded.close();

    const backup = await stat(path + ".bak-v2");
    expect(backup.isFile()).toBe(true);
  });

  it("refuses a proposal whose status disagrees with decided_at", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const { db } = await openMemoryDatabase(path);
    const insert =
      "INSERT INTO memory_proposals (id, scope_kind, scope_name, type, text, tags, origin, origin_ref, status, proposed_at, decided_at) " +
      "VALUES (?, 'global', NULL, 'fact', 'constraint probe', '[]', 'agent', NULL, ?, ?, ?)";
    // A pending proposal must not carry a decision time...
    expect(() =>
      db.prepare(insert).run("p-pending-decided", "proposed", "2026-09-30T00:00:00.000Z", "2026-09-30T01:00:00.000Z")
    ).toThrowError(/CHECK constraint failed/);
    // ...and a decided one must carry it.
    expect(() =>
      db.prepare(insert).run("p-decided-pending", "accepted", "2026-09-30T00:00:00.000Z", null)
    ).toThrowError(/CHECK constraint failed/);
    db.close();
  });

  it("refuses proposal tags that are not valid JSON", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const { db } = await openMemoryDatabase(path);
    expect(() =>
      db
        .prepare(
          "INSERT INTO memory_proposals (id, scope_kind, scope_name, type, text, tags, origin, status, proposed_at) " +
            "VALUES ('p-bad-tags', 'global', NULL, 'fact', 'constraint probe', 'not json', 'agent', 'proposed', '2026-09-30T00:00:00.000Z')"
        )
        .run()
    ).toThrowError(/CHECK constraint failed/);
    db.close();
  });

  it("refuses a newer schema version without writing to the file", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    // A non-WAL database at a newer version: opening it for writing used to
    // switch journal_mode to WAL and change the bytes.
    const created = new DatabaseSync(path);
    created.exec("CREATE TABLE memories (id TEXT)");
    created.exec("PRAGMA user_version = 99");
    created.close();
    expect(readPragma(path, "journal_mode")).toBe("delete");
    const before = await readFile(path);

    await expect(openMemoryDatabase(path)).rejects.toThrowError(MemoryError);

    const after = await readFile(path);
    expect(after.equals(before)).toBe(true);
    expect(readPragma(path, "journal_mode")).toBe("delete");
    expect(readPragma(path, "user_version")).toBe(99);
  });

  it("refuses a v1 database with a foreign schema", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    // user_version=1 claims the schema, but there is no memories table.
    const created = new DatabaseSync(path);
    created.exec("PRAGMA user_version = 1");
    created.close();

    await expect(openMemoryDatabase(path)).rejects.toThrowError(MemoryError);
  });

  it("backs up before a pending migration and applies it", async () => {
    const dir = await tempDir();
    const path = join(dir, "memory.sqlite");
    const { db } = await openMemoryDatabase(path);
    db.close();
    const v4: Migration = {
      version: 4,
      up: (target) => target.exec("ALTER TABLE memories ADD COLUMN note TEXT")
    };
    const { db: migrated, changes } = await openMemoryDatabase(path, { migrations: [...MIGRATIONS, v4] });
    expect(readUserVersion(migrated)).toBe(4);
    expect(changes).toBe(0);
    migrated.close();
    const backup = await stat(path + ".bak-v3");
    expect(backup.isFile()).toBe(true);
  });

  it("rolls back a failing migration and stays at v3", async () => {
    const dir = await tempDir();
    const path = join(dir, "memory.sqlite");
    const { db } = await openMemoryDatabase(path);
    db.close();
    const broken: Migration = {
      version: 4,
      up: (target) => {
        target.exec("ALTER TABLE memories ADD COLUMN note TEXT");
        throw new Error("boom");
      }
    };
    await expect(openMemoryDatabase(path, { migrations: [...MIGRATIONS, broken] })).rejects.toThrowError("boom");
    const reopened = new DatabaseSync(path);
    expect(readUserVersion(reopened)).toBe(3);
    reopened.close();
  });

  it("migrate reports the current version and no changes when nothing is pending", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const { db } = await openMemoryDatabase(path);
    expect(migrate(db)).toEqual({ version: 3, changes: 0 });
    db.close();
  });

  it("upgrades a v1 database, keeping its records and backing it up", async () => {
    const dir = await tempDir();
    const path = join(dir, "memory.sqlite");
    // A genuine on-disk v1 database. It cannot be built through
    // openMemoryDatabase({ migrations: [v1] }) any more: that path validates the
    // migrated database against REQUIRED_SCHEMA_OBJECTS, which is now the v3 list.
    const v1 = new DatabaseSync(path);
    migrate(v1, [MIGRATIONS[0]!]);
    v1.prepare(
      "INSERT INTO memories (id, scope_kind, scope_name, type, text, pinned, origin, origin_ref, created_at, updated_at) " +
        "VALUES (?, 'global', NULL, 'fact', ?, 0, 'owner', NULL, ?, ?)"
    ).run("m-legacy", "kept across the upgrade", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    v1.close();

    const { db: upgraded } = await openMemoryDatabase(path);
    expect(readUserVersion(upgraded)).toBe(3);
    const row = upgraded.prepare("SELECT text FROM memories WHERE id = ?").get("m-legacy");
    expect(row?.text).toBe("kept across the upgrade");
    const tables = upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((entry) => String(entry.name));
    expect(tables).toContain("memory_proposals");
    upgraded.close();

    const backup = await stat(path + ".bak-v1");
    expect(backup.isFile()).toBe(true);
  });

  it("creates the same schema fresh as it does by migrating v1", async () => {
    // Additive-only DDL (v3 is data-only) is the reason a fresh and an upgraded
    // v1 database must not drift; this pins it against migrations that rewrite
    // v1 objects.
    const freshPath = join(await tempDir(), "memory.sqlite");
    const { db: fresh } = await openMemoryDatabase(freshPath);
    const freshSchema = readSchemaObjects(fresh);
    fresh.close();

    const upgradedPath = join(await tempDir(), "memory.sqlite");
    const v1 = new DatabaseSync(upgradedPath);
    migrate(v1, [MIGRATIONS[0]!]);
    v1.close();
    const { db: upgraded } = await openMemoryDatabase(upgradedPath);

    expect(readSchemaObjects(upgraded)).toEqual(freshSchema);
    upgraded.close();
  });

  it("refuses a v2 database without the proposals table", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    // A genuine v1 schema: memories, memory_tags, memory_fts and the FTS triggers
    // are all present, so memory_proposals is the ONLY required object missing.
    // An empty database would also lack `memories` and pass for the wrong reason.
    const v1 = new DatabaseSync(path);
    migrate(v1, [MIGRATIONS[0]!]);
    v1.close();

    // Claim v2 without ever creating memory_proposals. The v3 DELETE must not run
    // (it would surface a raw SQLite "no such table" error); the post-migration
    // validateMemorySchema still raises the MemoryError this gate owns.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 2");
    raw.close();

    await expect(openMemoryDatabase(path)).rejects.toThrowError(MemoryError);
  });
});
