import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { apply, Config, name } from "../src/index.js";
import { MIGRATIONS, migrate } from "../src/schema.js";
import type { BalbesMemoryService } from "../src/types.js";

interface Harness {
  provided: Map<string, unknown>;
  effects: Array<() => void>;
  warnings: string[];
  infos: string[];
}

function harness(): { ctx: unknown; h: Harness } {
  const h: Harness = { provided: new Map(), effects: [], warnings: [], infos: [] };
  const ctx = {
    provide(key: string, value: unknown): void {
      h.provided.set(key, value);
    },
    effect(callback: () => (() => void) | void): void {
      const disposer = callback();
      if (typeof disposer === "function") h.effects.push(disposer);
    },
    logger: {
      warn(message: string): void {
        h.warnings.push(message);
      },
      info(message: string): void {
        h.infos.push(message);
      }
    }
  };
  return { ctx, h };
}

/** A genuine on-disk v2 database with one legacy rejected proposal. */
function buildLegacyV2(path: string): void {
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
      "('legacy-rejected','global',NULL,'note','legacy rejected text','[]','agent',NULL,'rejected','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z','owner',0,NULL)," +
      "('legacy-accepted','global',NULL,'note','kept accepted text','[]','agent',NULL,'accepted','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z','owner',0,'m-1')," +
      "('live','global',NULL,'note','pending text','[]','agent',NULL,'proposed','2026-09-01T00:00:00.000Z',NULL,NULL,0,NULL)"
  );
  legacy.close();
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "balbes-memory-plugin-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("balbes-memory plugin", () => {
  it("exposes the functional plugin contract", () => {
    expect(name).toBe("balbes-memory");
    expect(Config({})).toEqual({});
    expect(Config({ dshHome: "/x" })).toEqual({ dshHome: "/x" });
  });

  it("provides balbesMemory and registers a disposer", async () => {
    const { ctx, h } = harness();
    await apply(ctx as never, { dshHome: dir });
    const service = h.provided.get("balbesMemory") as BalbesMemoryService;
    expect(service).toBeDefined();
    const saved = await service.save({
      scope: { kind: "global" },
      type: "note",
      text: "hello memory",
      origin: "owner"
    });
    expect((await service.get(saved.id))?.text).toBe("hello memory");
    expect(h.effects.length).toBe(1);
    h.effects[0]?.();
  });

  it("warns and provides nothing when the database cannot be opened", async () => {
    await writeFile(join(dir, "not-a-dir"), "x", "utf8");
    const { ctx, h } = harness();
    await apply(ctx as never, { dshHome: dir, memoryPath: join(dir, "not-a-dir", "memory.sqlite") });
    expect(h.provided.has("balbesMemory")).toBe(false);
    expect(h.warnings.join(" ")).toContain("balbes-memory");
  });

  it("warns and provides nothing on a foreign schema with a valid user_version", async () => {
    const path = join(dir, "memory.sqlite");
    // A real SQLite database that claims v1 but has no memories table. Before
    // the fix this threw out of apply() and leaked the handle.
    const foreign = new DatabaseSync(path);
    foreign.exec("PRAGMA user_version = 1");
    foreign.close();

    const { ctx, h } = harness();
    await expect(
      apply(ctx as never, { dshHome: dir, memoryPath: path })
    ).resolves.toBeUndefined();
    expect(h.provided.has("balbesMemory")).toBe(false);
    expect(h.effects.length).toBe(0);
    expect(h.warnings.join(" ")).toContain("balbes-memory");
  });

  it("logs one info line with the count when the v3 migration purges a rejected proposal", async () => {
    const path = join(dir, "memory.sqlite");
    buildLegacyV2(path);

    const { ctx, h } = harness();
    await apply(ctx as never, { dshHome: dir, memoryPath: path });

    expect(h.warnings).toEqual([]);
    expect(h.infos.length).toBe(1);
    expect(h.infos[0]).toContain("1");
    expect(h.infos[0]).toContain("rejected proposal");
    // The count is the whole message: no proposal text and no id leaks into it.
    const logged = h.infos.join(" ");
    expect(logged).not.toContain("legacy rejected text");
    expect(logged).not.toContain("legacy-rejected");
    h.effects.forEach((dispose) => dispose());
  });

  it("logs no migration line when there is nothing to purge", async () => {
    const { ctx, h } = harness();
    await apply(ctx as never, { dshHome: dir });

    expect(h.infos).toEqual([]);
    expect(h.warnings).toEqual([]);
    h.effects.forEach((dispose) => dispose());
  });
});
