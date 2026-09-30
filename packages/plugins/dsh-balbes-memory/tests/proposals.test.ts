import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDatabase } from "../src/schema.js";
import { createProposalStore } from "../src/proposals.js";
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
    // Ordering must not depend on the wall clock: the tie-break is a random
    // UUID, so pin `proposed_at` with fake timers instead of sleeping.
    vi.useFakeTimers();
    let first;
    try {
      vi.setSystemTime(new Date("2026-09-30T00:00:00.000Z"));
      first = await service.propose({ ...proposalDraft, text: "first", tags: ["ops"] });
      vi.setSystemTime(new Date("2026-09-30T00:00:05.000Z"));
      await service.propose({ ...proposalDraft, text: "second", type: "note", scope: { kind: "project", name: "alpha" } });
    } finally {
      vi.useRealTimers();
    }

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

  it("does not count a reordered tag list as an edit", async () => {
    const proposal = await service.propose({ ...proposalDraft, tags: ["alpha", "beta"] });
    const { proposal: decided, record } = await service.approve(proposal.id, { tags: ["beta", "alpha"] });

    expect(decided.decidedEdit).toBe(false);
    expect(record.tags).toEqual(["alpha", "beta"]);
    expect(proposal.tags).toEqual(["alpha", "beta"]);
  });

  it("counts a tags-only change as an edit", async () => {
    // Content is type/text/tags: a real tag change must set decidedEdit even when
    // type and text are untouched (the reorder case above stays false).
    const proposal = await service.propose({ ...proposalDraft, tags: ["alpha", "beta"] });
    const { proposal: decided, record } = await service.approve(proposal.id, { tags: ["alpha", "gamma"] });

    expect(decided.decidedEdit).toBe(true);
    expect(record.tags).toEqual(["alpha", "gamma"]);
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

  it("rolls the memory insert back when the promotion fails inside the transaction", async () => {
    // The secret case above throws BEFORE `BEGIN`, so on its own it would stay
    // green even if the whole transaction disappeared. This test fails inside
    // the transaction and pins the guarantee: no memory row, no decision, and
    // the connection is left usable.
    const proposal = await service.propose(proposalDraft);
    const failing = createProposalStore(db, {
      insertMemoryRecord() {
        throw new Error("insert boom");
      },
      loadRecord: () => undefined
    });
    await expect(failing.approve(proposal.id)).rejects.toThrowError("insert boom");

    expect(await service.count()).toBe(0);
    expect((await service.getProposal(proposal.id))?.status).toBe("proposed");

    // A leaked transaction would make the next decision fail.
    const { record } = await service.approve(proposal.id);
    expect(record.text).toBe(proposalDraft.text);
    expect(await service.count()).toBe(1);
  });

  it("rolls a partial memory write back when the truth-table writer fails midway", async () => {
    // Stronger than the test above: this injected writer really writes a row (as
    // `insertRecordRow` does) before throwing, so it only passes if `approve` wraps
    // the promotion in a transaction. Delete the BEGIN/COMMIT/ROLLBACK block and
    // the partial row survives, failing `count()` below.
    const proposal = await service.propose(proposalDraft);
    const failing = createProposalStore(db, {
      insertMemoryRecord(id) {
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO memories (id, scope_kind, scope_name, type, text, pinned, origin, origin_ref, created_at, updated_at) " +
            "VALUES (?, 'global', NULL, 'fact', ?, 0, 'agent', NULL, ?, ?)"
        ).run(id, proposalDraft.text, now, now);
        throw new Error("insert boom after write");
      },
      loadRecord: () => undefined
    });
    await expect(failing.approve(proposal.id)).rejects.toThrowError("insert boom after write");

    expect(await service.count()).toBe(0);
    expect((await service.getProposal(proposal.id))?.status).toBe("proposed");

    const { record } = await service.approve(proposal.id);
    expect(await service.count()).toBe(1);
    expect(record.text).toBe(proposalDraft.text);
  });

  it("deletes the row on rejection and returns the pre-decision snapshot", async () => {
    const proposal = await service.propose(proposalDraft);
    const decided = await service.reject(proposal.id);
    // Снимок описывает строку ДО удаления с дорешёнными полями.
    expect(decided).toMatchObject({
      id: proposal.id,
      scope: proposal.scope,
      type: proposal.type,
      text: proposal.text,
      tags: proposal.tags,
      origin: proposal.origin,
      originRef: proposal.originRef,
      proposedAt: proposal.proposedAt,
      status: "rejected",
      decidedBy: "owner",
      decidedEdit: false,
      memoryId: null
    });
    expect(decided.decidedAt).not.toBeNull();
    // Строки больше нет ни в общем списке, ни по id, ни под фильтром rejected.
    expect(await service.getProposal(proposal.id)).toBeUndefined();
    expect(await service.listProposals({ status: ["rejected"] })).toEqual([]);
    expect((await service.listProposals({})).map((entry) => entry.id)).not.toContain(proposal.id);
    // Истина не тронута: запись не создавалась.
    expect(await service.list()).toEqual([]);
  });

  it("answers not-found on a second rejection and invalid-status on a decided row", async () => {
    const proposal = await service.propose(proposalDraft);
    await service.reject(proposal.id);
    await expect(service.reject(proposal.id)).rejects.toMatchObject({ code: "not-found" });
    const accepted = await service.propose({ ...proposalDraft, text: "keep me", type: "note" });
    await service.approve(accepted.id);
    await expect(service.reject(accepted.id)).rejects.toMatchObject({ code: "invalid-status" });
    await expect(service.reject("nope")).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses a second decision and an unknown id", async () => {
    const proposal = await service.propose(proposalDraft);
    // Решение принимается здесь, а не отказом: отказ удаляет строку, поэтому
    // повторное решение по ней было бы `not-found`, а не `invalid-status`.
    await service.approve(proposal.id);
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
    // Same clock discipline as the FIFO test: the queue order is asserted
    // exactly, so `proposed_at` must not be left to millisecond luck.
    vi.useFakeTimers();
    let pending;
    let second;
    let accepted;
    try {
      vi.setSystemTime(new Date("2026-09-30T01:00:00.000Z"));
      pending = await service.propose({ ...proposalDraft, text: "still pending" });
      vi.setSystemTime(new Date("2026-09-30T01:00:05.000Z"));
      second = await service.propose({ ...proposalDraft, text: "to reject", type: "note" });
      vi.setSystemTime(new Date("2026-09-30T01:00:10.000Z"));
      accepted = await service.propose({ ...proposalDraft, text: "to accept", tags: ["ops"] });
    } finally {
      vi.useRealTimers();
    }
    await service.reject(second.id);
    await service.approve(accepted.id);

    expect((await service.listProposals()).map((entry) => entry.id)).toEqual([pending.id]);
    // Отказ удаляет строку, поэтому под фильтром rejected ничего не остаётся.
    expect(await service.listProposals({ status: ["rejected"] })).toEqual([]);
    expect((await service.listProposals({ status: ["accepted"] })).map((entry) => entry.id)).toEqual([accepted.id]);
    expect((await service.listProposals({ status: ["proposed", "accepted", "rejected"] })).map((entry) => entry.id))
      .toEqual([pending.id, accepted.id]);
    expect((await service.listProposals({ status: ["proposed", "rejected"], tag: "ops" })).length).toBe(0);
  });
});
