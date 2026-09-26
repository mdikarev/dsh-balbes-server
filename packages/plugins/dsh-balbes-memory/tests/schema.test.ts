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

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe("openMemoryDatabase", () => {
  it("creates schema v1 and is idempotent", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const db = await openMemoryDatabase(path);
    expect(readUserVersion(db)).toBe(1);
    expect(LATEST_VERSION).toBe(1);
    db.close();
    const reopened = await openMemoryDatabase(path);
    expect(readUserVersion(reopened)).toBe(1);
    reopened.close();
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

  it("refuses a target-version database with a foreign schema", async () => {
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
    const db = await openMemoryDatabase(path);
    db.close();
    const v2: Migration = {
      version: 2,
      up: (target) => target.exec("ALTER TABLE memories ADD COLUMN note TEXT")
    };
    const migrated = await openMemoryDatabase(path, { migrations: [...MIGRATIONS, v2] });
    expect(readUserVersion(migrated)).toBe(2);
    migrated.close();
    const backup = await stat(path + ".bak-v1");
    expect(backup.isFile()).toBe(true);
  });

  it("rolls back a failing migration and stays at v1", async () => {
    const dir = await tempDir();
    const path = join(dir, "memory.sqlite");
    const db = await openMemoryDatabase(path);
    db.close();
    const broken: Migration = {
      version: 2,
      up: (target) => {
        target.exec("ALTER TABLE memories ADD COLUMN note TEXT");
        throw new Error("boom");
      }
    };
    await expect(openMemoryDatabase(path, { migrations: [...MIGRATIONS, broken] })).rejects.toThrowError("boom");
    const reopened = new DatabaseSync(path);
    expect(readUserVersion(reopened)).toBe(1);
    reopened.close();
  });

  it("migrate returns the current version when nothing is pending", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const db = await openMemoryDatabase(path);
    expect(migrate(db)).toBe(1);
    db.close();
  });
});
