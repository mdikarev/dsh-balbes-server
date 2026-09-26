import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDatabase } from "../src/schema.js";
import { createMemoryService } from "../src/service.js";
import type { BalbesMemoryService } from "../src/types.js";

let dir: string;
let db: DatabaseSync;
let service: BalbesMemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "balbes-memory-search-"));
  db = await openMemoryDatabase(join(dir, "memory.sqlite"));
  service = createMemoryService(db);
  await service.save({ scope: { kind: "global" }, type: "fact", text: "Deployment runs under systemd on the VPS", origin: "owner", tags: ["ops"] });
  await service.save({ scope: { kind: "global" }, type: "preference", text: "Owner prefers concise answers in Russian", origin: "owner", tags: ["style"] });
  await service.save({ scope: { kind: "project", name: "alpha" }, type: "decision", text: "alpha uses pnpm workspaces", origin: "agent", tags: ["build"] });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("search", () => {
  it("ranks full-text matches", async () => {
    const hits = await service.search({ query: "systemd OR deployment" });
    expect(hits.map((hit) => hit.record.text)).toContain("Deployment runs under systemd on the VPS");
    expect(hits[0]?.rank).toBeLessThan(0);
  });

  it("filters by scope and tag", async () => {
    expect((await service.search({ query: "pnpm", filter: { scope: { kind: "project", name: "alpha" } } })).length).toBe(1);
    expect((await service.search({ query: "pnpm", filter: { tag: "build" } })).length).toBe(1);
    expect((await service.search({ query: "pnpm", filter: { scopes: [{ kind: "global" }] } })).length).toBe(0);
  });

  it("rejects an empty query", async () => {
    await expect(service.search({ query: "   " })).rejects.toMatchObject({ code: "invalid-query" });
  });

  it("maps an invalid FTS expression to invalid-query", async () => {
    await expect(service.search({ query: "(" })).rejects.toMatchObject({ code: "invalid-query" });
  });

  it("keeps the index in sync on update and delete", async () => {
    const hits = await service.search({ query: "concise" });
    const target = hits[0]?.record;
    expect(target).toBeDefined();
    await service.update(target!.id, { text: "Owner prefers detailed answers" });
    expect((await service.search({ query: "concise" })).length).toBe(0);
    expect((await service.search({ query: "detailed" })).length).toBe(1);
    await service.delete(target!.id);
    expect((await service.search({ query: "detailed" })).length).toBe(0);
  });
});
