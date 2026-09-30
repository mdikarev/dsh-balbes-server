import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MemoryReviewQueue from "../src/pages/MemoryReviewQueue";
import { formatTime } from "../src/pages/memoryShared";
import { ApiError, type AdminApi } from "../src/api/client";
import type {
  MemoryAutonomyPolicy,
  MemoryProposal,
  MemoryReviewApproveRequest,
  MemoryReviewListRequest,
  MemoryReviewListResponse,
  MemoryRecord
} from "dsh-balbes-contracts";

afterEach(cleanup);

const POLICY: MemoryAutonomyPolicy = { immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" };

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: "p-1",
    scope: { kind: "global" },
    type: "fact",
    text: "staged fact",
    tags: ["x"],
    origin: "agent",
    originRef: "pipeline:extraction admin session:s1",
    status: "proposed",
    proposedAt: "2026-09-30T00:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    decidedEdit: false,
    memoryId: null,
    ...overrides
  };
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m-1",
    scope: { kind: "global" },
    type: "fact",
    text: "staged fact",
    tags: ["x"],
    pinned: false,
    origin: "agent",
    originRef: "pipeline:extraction admin session:s1",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides
  };
}

function makeApi(list: MemoryReviewListResponse, overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listWorkspaces: vi.fn(async () => ({ home: { path: "/h/agent" }, projects: [{ name: "alpha", path: "/p/alpha" }] })),
    listMemoryReview: vi.fn(async (_req: MemoryReviewListRequest) => list),
    approveMemoryReview: vi.fn(async (req: MemoryReviewApproveRequest) => ({
      proposal: proposal({ id: req.id, status: "accepted", decidedAt: "2026-09-30T01:00:00.000Z", decidedBy: "owner", decidedEdit: req.text !== undefined, memoryId: "m-1" }),
      record: record({ id: "m-1", text: req.text ?? "staged fact" })
    })),
    rejectMemoryReview: vi.fn(async (req: { id: string }) => ({
      proposal: proposal({ id: req.id, status: "rejected", decidedAt: "2026-09-30T01:00:00.000Z", decidedBy: "owner" })
    })),
    ...overrides
  } as unknown as AdminApi;
}

describe("MemoryReviewQueue", () => {
  it("renders the policy line, provenance and the empty state", async () => {
    render(<MemoryReviewQueue api={makeApi({ proposals: [], policy: POLICY })} />);
    expect(await screen.findByTestId("memory-review-empty")).toBeTruthy();
    expect(screen.getByTestId("memory-review-policy").textContent).toContain("remember");
  });

  it("approves a proposal as-is", async () => {
    const api = makeApi({ proposals: [proposal()], policy: POLICY });
    render(<MemoryReviewQueue api={api} />);
    fireEvent.click(await screen.findByTestId("memory-review-approve:p-1"));
    fireEvent.click(await screen.findByTestId("memory-review-form-approve"));
    await waitFor(() => expect(api.approveMemoryReview).toHaveBeenCalledWith({ id: "p-1" }));
  });

  it("sends only the changed fields when the owner edits before approving", async () => {
    const api = makeApi({ proposals: [proposal()], policy: POLICY });
    render(<MemoryReviewQueue api={api} />);
    fireEvent.click(await screen.findByTestId("memory-review-approve:p-1"));
    fireEvent.change(screen.getByTestId("memory-review-form-text"), { target: { value: "edited fact" } });
    fireEvent.click(screen.getByTestId("memory-review-form-approve"));
    await waitFor(() => expect(api.approveMemoryReview).toHaveBeenCalledWith({ id: "p-1", text: "edited fact" }));
  });

  it("rejects after confirmation and refreshes the queue", async () => {
    // A rejection deletes the proposal row server-side, so the refreshed queue no
    // longer contains it.
    let listed = 0;
    const api = makeApi({ proposals: [proposal()], policy: POLICY }, {
      listMemoryReview: vi.fn(async () => {
        listed += 1;
        return listed === 1 ? { proposals: [proposal()], policy: POLICY } : { proposals: [], policy: POLICY };
      })
    });
    render(<MemoryReviewQueue api={api} />);
    fireEvent.click(await screen.findByTestId("memory-review-reject:p-1"));
    fireEvent.click(await screen.findByTestId("memory-review-reject-confirm"));
    await waitFor(() => expect(api.rejectMemoryReview).toHaveBeenCalledWith({ id: "p-1" }));
    await waitFor(() => expect(screen.queryByTestId("memory-review-row:p-1")).toBeNull());
    expect(api.listMemoryReview).toHaveBeenCalledTimes(2);
  });

  it("shows only accepted decisions when the toggle is on", async () => {
    const decided = proposal({
      id: "p-2",
      status: "accepted",
      text: "kept knowledge",
      decidedAt: "2026-09-30T02:00:00.000Z",
      decidedBy: "owner"
    });
    const rejected = proposal({
      id: "p-3",
      status: "rejected",
      text: "dropped knowledge",
      decidedAt: "2026-09-30T02:00:00.000Z",
      decidedBy: "owner"
    });
    const api = makeApi({ proposals: [], policy: POLICY }, {
      // Сервер отдаёт отклонённую строку, только если её явно попросили: так
      // проверка ниже падает, если страница снова начнёт спрашивать rejected.
      listMemoryReview: vi.fn(async (req: MemoryReviewListRequest) =>
        req.status === undefined
          ? { proposals: [], policy: POLICY }
          : { proposals: req.status.includes("rejected") ? [decided, rejected] : [decided], policy: POLICY }
      )
    });
    render(<MemoryReviewQueue api={api} />);
    fireEvent.click(await screen.findByTestId("memory-review-decided-toggle"));
    expect(await screen.findByText("kept knowledge")).toBeTruthy();
    const row = await screen.findByTestId("memory-review-row:p-2");
    expect(row.textContent).toContain("принято");
    expect(api.listMemoryReview).toHaveBeenCalledWith(expect.objectContaining({ status: ["accepted"] }));
    // Rejected rows do not exist: a rejection deletes the proposal.
    expect(screen.queryByText("отклонено")).toBeNull();
    expect(screen.queryByTestId("memory-review-row:p-3")).toBeNull();
  });

  it("reports a decision once after a successful approve", async () => {
    const onDecided = vi.fn();
    const api = makeApi({ proposals: [proposal()], policy: POLICY });
    render(<MemoryReviewQueue api={api} onDecided={onDecided} />);
    fireEvent.click(await screen.findByTestId("memory-review-approve:p-1"));
    fireEvent.click(screen.getByTestId("memory-review-form-approve"));
    // the modal closes only after the decision and the queue reload
    await waitFor(() => expect(screen.queryByTestId("memory-review-form-approve")).toBeNull());
    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(api.listMemoryReview).toHaveBeenCalledTimes(2);
  });

  it("does not report a decision when the approve hits invalid-status", async () => {
    const onDecided = vi.fn();
    const api = makeApi({ proposals: [proposal()], policy: POLICY }, {
      approveMemoryReview: vi.fn(async () => { throw new ApiError(400, "invalid-status", "proposal already decided"); })
    });
    render(<MemoryReviewQueue api={api} onDecided={onDecided} />);
    fireEvent.click(await screen.findByTestId("memory-review-approve:p-1"));
    fireEvent.click(screen.getByTestId("memory-review-form-approve"));
    // the recovery path closes the modal and reloads, but no owner decision happened
    await waitFor(() => expect(api.listMemoryReview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("memory-review-form-approve")).toBeNull());
    expect(onDecided).not.toHaveBeenCalled();
    // ...and the owner is told the proposal was decided elsewhere (canon wording)
    expect((await screen.findByTestId("memory-review-notice")).textContent)
      .toBe("Предложение уже решено — очередь обновлена");
  });

  it("reports a decision once after a successful reject", async () => {
    const onDecided = vi.fn();
    const api = makeApi({ proposals: [proposal()], policy: POLICY });
    render(<MemoryReviewQueue api={api} onDecided={onDecided} />);
    fireEvent.click(await screen.findByTestId("memory-review-reject:p-1"));
    fireEvent.click(screen.getByTestId("memory-review-reject-confirm"));
    await waitFor(() => expect(screen.queryByTestId("memory-review-reject-confirm")).toBeNull());
    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(api.listMemoryReview).toHaveBeenCalledTimes(2);
  });

  it("does not report a decision when a reject hits not-found", async () => {
    const onDecided = vi.fn();
    const api = makeApi({ proposals: [proposal()], policy: POLICY }, {
      rejectMemoryReview: vi.fn(async () => { throw new ApiError(404, "not-found", "memory proposal not found"); })
    });
    render(<MemoryReviewQueue api={api} onDecided={onDecided} />);
    fireEvent.click(await screen.findByTestId("memory-review-reject:p-1"));
    fireEvent.click(screen.getByTestId("memory-review-reject-confirm"));
    await waitFor(() => expect(api.listMemoryReview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("memory-review-reject-confirm")).toBeNull());
    expect(onDecided).not.toHaveBeenCalled();
    // 404 recovery is a silent reload: no invalid-status wording.
    expect(screen.queryByTestId("memory-review-notice")).toBeNull();
  });

  it("shows the proposal time for pending rows and both times for decided rows", async () => {
    const pending = proposal({ id: "p-pending" });
    const decided = proposal({
      id: "p-decided",
      status: "accepted",
      decidedAt: "2026-09-30T02:00:00.000Z",
      decidedBy: "owner"
    });
    const api = makeApi({ proposals: [pending, decided], policy: POLICY });
    render(<MemoryReviewQueue api={api} />);
    const pendingRow = await screen.findByTestId("memory-review-row:p-pending");
    const decidedRow = screen.getByTestId("memory-review-row:p-decided");
    expect(pendingRow.textContent).toContain(formatTime(pending.proposedAt));
    expect(pendingRow.textContent).not.toContain("решено");
    expect(decidedRow.textContent).toContain(formatTime(decided.proposedAt));
    expect(decidedRow.textContent).toContain("решено " + formatTime(decided.decidedAt!));
  });
});
