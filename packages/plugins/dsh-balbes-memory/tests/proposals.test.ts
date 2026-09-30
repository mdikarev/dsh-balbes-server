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
  dir = await mkdtemp(join(tmpdir(), "balbes-memory-proposals-"));
  db = await openMemoryDatabase(join(dir, "memory.sqlite"));
  service = createMemoryService(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const proposalDraft = {
  scope: { kind: "global" } as const,
  type: "fact" as const,
  text: "deploy runs under systemd",
  originRef: "pipeline:extraction admin session:s1"
};

describe("balbesMemory proposals", () => {
  it("stages a proposal without creating a memory record", async () => {
    const proposal = await service.propose({ ...proposalDraft, tags: ["Ops"] });
    expect(proposal.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(proposal.status).toBe("proposed");
    expect(proposal.origin).toBe("agent");
    expect(proposal.originRef).toBe("pipeline:extraction admin session:s1");
    expect(proposal.tags).toEqual(["ops"]);
    expect(proposal.decidedAt).toBeNull();
    expect(proposal.decidedBy).toBeNull();
    expect(proposal.decidedEdit).toBe(false);
    expect(proposal.memoryId).toBeNull();
    expect(proposal.proposedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps proposals out of every memory read path", async () => {
    await service.propose({ ...proposalDraft, text: "unapproved knowledge marker" });
    expect(await service.list()).toEqual([]);
    expect(await service.search({ query: "unapproved" })).toEqual([]);
    expect(await service.count()).toBe(0);
  });

  it("rejects a secret-looking proposal and writes nothing", async () => {
    await expect(service.propose({ ...proposalDraft, text: "token = abc123" })).rejects.toMatchObject({
      code: "secret-detected"
    });
    expect(await service.listProposals()).toEqual([]);
  });

  it("rejects an invalid scope, type and originRef", async () => {
    await expect(service.propose({ ...proposalDraft, scope: { kind: "galaxy" } } as never)).rejects.toMatchObject({
      code: "invalid-scope"
    });
    await expect(service.propose({ ...proposalDraft, type: "rumor" } as never)).rejects.toMatchObject({
      code: "invalid-record"
    });
    await expect(service.propose({ ...proposalDraft, originRef: 7 } as never)).rejects.toMatchObject({
      code: "invalid-record"
    });
  });

  it("lists pending proposals FIFO and filters by scope, type, tag and limit", async () => {
    const first = await service.propose({ ...proposalDraft, text: "first", tags: ["ops"] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.propose({ ...proposalDraft, text: "second", type: "note", scope: { kind: "project", name: "alpha" } });

    const pending = await service.listProposals();
    expect(pending.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect((await service.listProposals({ type: "note" })).map((entry) => entry.text)).toEqual(["second"]);
    expect((await service.listProposals({ scope: { kind: "project", name: "alpha" } })).map((entry) => entry.text))
      .toEqual(["second"]);
    expect((await service.listProposals({ tag: "ops" })).map((entry) => entry.text)).toEqual(["first"]);
    expect((await service.listProposals({ limit: 1 })).map((entry) => entry.text)).toEqual(["first"]);
    expect(first.status).toBe("proposed");
  });

  it("returns a proposal by id and undefined for an unknown id", async () => {
    const proposal = await service.propose(proposalDraft);
    expect(await service.getProposal(proposal.id)).toEqual(proposal);
    expect(await service.getProposal("nope")).toBeUndefined();
  });
});
