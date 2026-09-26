import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

  it("refuses a newer schema version", async () => {
    const path = join(await tempDir(), "memory.sqlite");
    const db = await openMemoryDatabase(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
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
