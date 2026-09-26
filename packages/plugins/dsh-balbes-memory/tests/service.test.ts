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
  dir = await mkdtemp(join(tmpdir(), "balbes-memory-service-"));
  db = await openMemoryDatabase(join(dir, "memory.sqlite"));
  service = createMemoryService(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const globalDraft = {
  scope: { kind: "global" } as const,
  type: "fact" as const,
  text: "Deployment runs under systemd",
  origin: "owner" as const
};

describe("balbesMemory service", () => {
  it("saves and reads a record with tags", async () => {
    const saved = await service.save({ ...globalDraft, tags: ["Ops", "deploy"], pinned: true });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.tags).toEqual(["deploy", "ops"]);
    expect(saved.pinned).toBe(true);
    expect(saved.originRef).toBeNull();
    expect(await service.get(saved.id)).toEqual(saved);
  });

  it("rejects secret-looking text without writing anything", async () => {
    await expect(service.save({ ...globalDraft, text: "token = abc123" })).rejects.toMatchObject({
      code: "secret-detected"
    });
    expect(await service.count()).toBe(0);
  });

  it("rejects a secret on update and keeps the old text", async () => {
    const saved = await service.save(globalDraft);
    await expect(service.update(saved.id, { text: "api_key: xyz" })).rejects.toMatchObject({
      code: "secret-detected"
    });
    expect((await service.get(saved.id))?.text).toBe(globalDraft.text);
  });

  it("lists by scope, type, tag and pinned", async () => {
    await service.save({ ...globalDraft, tags: ["ops"] });
    await service.save({
      scope: { kind: "project", name: "alpha" },
      type: "decision",
      text: "alpha uses pnpm",
      origin: "agent",
      tags: ["build"],
      pinned: true
    });
    await service.save({
      scope: { kind: "project", name: "beta" },
      type: "preference",
      text: "beta is quiet",
      origin: "owner"
    });

    expect((await service.list({ scope: { kind: "global" } })).length).toBe(1);
    expect((await service.list({ scope: { kind: "project", name: "alpha" } })).length).toBe(1);
    expect((await service.list({ type: "preference" })).length).toBe(1);
    expect((await service.list({ tag: "BUILD" })).length).toBe(1);
    expect((await service.list({ pinned: true })).length).toBe(1);
    expect(
      (await service.list({ scopes: [{ kind: "global" }, { kind: "project", name: "alpha" }] })).length
    ).toBe(2);
    expect(await service.count()).toBe(3);
  });

  it("updates fields and replaces tags", async () => {
    const saved = await service.save({ ...globalDraft, tags: ["old"] });
    const updated = await service.update(saved.id, {
      text: "Deployment runs under systemd on the VPS",
      tags: ["new", "ops"],
      pinned: true
    });
    expect(updated.text).toContain("VPS");
    expect(updated.tags).toEqual(["new", "ops"]);
    expect(updated.pinned).toBe(true);
    expect(updated.createdAt).toBe(saved.createdAt);
  });

  it("reports not-found on update of a missing record", async () => {
    await expect(service.update("nope", { pinned: true })).rejects.toMatchObject({ code: "not-found" });
  });

  it("deletes records and reports misses", async () => {
    const saved = await service.save(globalDraft);
    await expect(service.delete(saved.id)).resolves.toBe(true);
    await expect(service.delete(saved.id)).resolves.toBe(false);
    await expect(service.get(saved.id)).resolves.toBeUndefined();
  });

  it("persists across a close and reopen", async () => {
    const saved = await service.save({ ...globalDraft, tags: ["durable"] });
    db.close();
    db = await openMemoryDatabase(join(dir, "memory.sqlite"));
    service = createMemoryService(db);
    expect((await service.get(saved.id))?.tags).toEqual(["durable"]);
  });
});
