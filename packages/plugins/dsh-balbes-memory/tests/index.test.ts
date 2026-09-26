import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { apply, Config, name } from "../src/index.js";
import type { BalbesMemoryService } from "../src/types.js";

interface Harness {
  provided: Map<string, unknown>;
  effects: Array<() => void>;
  warnings: string[];
}

function harness(): { ctx: unknown; h: Harness } {
  const h: Harness = { provided: new Map(), effects: [], warnings: [] };
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
      }
    }
  };
  return { ctx, h };
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
});
