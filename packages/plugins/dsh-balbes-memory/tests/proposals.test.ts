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

  it("promotes a proposal on approval and preserves agent provenance", async () => {
    const proposal = await service.propose({ ...proposalDraft, tags: ["ops"] });
    const { proposal: decided, record } = await service.approve(proposal.id, { pinned: true });

    expect(decided.status).toBe("accepted");
    expect(decided.decidedEdit).toBe(false);
    expect(decided.decidedBy).toBe("owner");
    expect(decided.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(decided.memoryId).toBe(record.id);

    expect(record.text).toBe(proposalDraft.text);
    expect(record.origin).toBe("agent");
    expect(record.originRef).toBe(proposalDraft.originRef);
    expect(record.tags).toEqual(["ops"]);
    expect(record.pinned).toBe(true);
    expect(await service.get(record.id)).toEqual(record);
  });

  it("applies an edit at approval and records it as edited", async () => {
    const proposal = await service.propose(proposalDraft);
    const { proposal: decided, record } = await service.approve(proposal.id, {
      text: "deploy runs under systemd (verified)",
      type: "decision",
      tags: ["ops"]
    });
    expect(decided.decidedEdit).toBe(true);
    expect(record.text).toBe("deploy runs under systemd (verified)");
    expect(record.type).toBe("decision");
    expect(record.tags).toEqual(["ops"]);
    expect(record.origin).toBe("agent");
  });

  it("does not count identical or pinned-only patches as an edit", async () => {
    const first = await service.propose(proposalDraft);
    const identical = await service.approve(first.id, { text: proposalDraft.text });
    expect(identical.proposal.decidedEdit).toBe(false);

    const second = await service.propose(proposalDraft);
    const pinned = await service.approve(second.id, { pinned: true });
    expect(pinned.proposal.decidedEdit).toBe(false);
  });

  it("rolls the whole promotion back when the edited text looks like a secret", async () => {
    const proposal = await service.propose(proposalDraft);
    await expect(service.approve(proposal.id, { text: "api_key: xyz" })).rejects.toMatchObject({
      code: "secret-detected"
    });
    const stillPending = await service.getProposal(proposal.id);
    expect(stillPending?.status).toBe("proposed");
    expect(stillPending?.memoryId).toBeNull();
    expect(await service.count()).toBe(0);
  });

  it("keeps the audit row on rejection without creating a record", async () => {
    const proposal = await service.propose(proposalDraft);
    const decided = await service.reject(proposal.id);
    expect(decided.status).toBe("rejected");
    expect(decided.decidedBy).toBe("owner");
    expect(decided.decidedEdit).toBe(false);
    expect(decided.memoryId).toBeNull();
    expect(await service.count()).toBe(0);
    expect((await service.getProposal(proposal.id))?.status).toBe("rejected");
  });

  it("refuses a second decision and an unknown id", async () => {
    const proposal = await service.propose(proposalDraft);
    await service.reject(proposal.id);
    await expect(service.approve(proposal.id)).rejects.toMatchObject({ code: "invalid-status" });
    await expect(service.reject(proposal.id)).rejects.toMatchObject({ code: "invalid-status" });
    await expect(service.approve("nope")).rejects.toMatchObject({ code: "not-found" });
    await expect(service.reject("nope")).rejects.toMatchObject({ code: "not-found" });
  });

  it("clears memoryId when the promoted record is deleted", async () => {
    const proposal = await service.propose(proposalDraft);
    const { record } = await service.approve(proposal.id);
    expect(await service.delete(record.id)).toBe(true);
    const after = await service.getProposal(proposal.id);
    expect(after?.status).toBe("accepted");
    expect(after?.memoryId).toBeNull();
  });

  it("widens the queue to decided proposals only when status is explicit", async () => {
    const pending = await service.propose({ ...proposalDraft, text: "still pending" });
    const second = await service.propose({ ...proposalDraft, text: "to reject", type: "note" });
    await service.reject(second.id);
    const accepted = await service.propose({ ...proposalDraft, text: "to accept", tags: ["ops"] });
    await service.approve(accepted.id);

    expect((await service.listProposals()).map((entry) => entry.id)).toEqual([pending.id]);
    expect((await service.listProposals({ status: ["rejected"] })).map((entry) => entry.id)).toEqual([second.id]);
    expect((await service.listProposals({ status: ["accepted"] })).map((entry) => entry.id)).toEqual([accepted.id]);
    expect((await service.listProposals({ status: ["proposed", "accepted", "rejected"] })).map((entry) => entry.id))
      .toEqual([pending.id, second.id, accepted.id]);
    expect((await service.listProposals({ status: ["proposed", "rejected"], tag: "ops" })).length).toBe(0);
  });
});
