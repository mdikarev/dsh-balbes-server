import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MemoryReviewQueue from "../src/pages/MemoryReviewQueue";
import type { AdminApi } from "../src/api/client";
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
    const api = makeApi({ proposals: [proposal()], policy: POLICY });
    render(<MemoryReviewQueue api={api} />);
    fireEvent.click(await screen.findByTestId("memory-review-reject:p-1"));
    fireEvent.click(await screen.findByTestId("memory-review-reject-confirm"));
    await waitFor(() => expect(api.rejectMemoryReview).toHaveBeenCalledWith({ id: "p-1" }));
    expect(api.listMemoryReview).toHaveBeenCalledTimes(2);
  });

  it("shows decided proposals with their verdict when the toggle is on", async () => {
    const decided = proposal({ id: "p-2", status: "rejected", decidedAt: "2026-09-30T02:00:00.000Z", decidedBy: "owner" });
    const api = makeApi({ proposals: [decided], policy: POLICY });
    render(<MemoryReviewQueue api={api} />);
    fireEvent.click(await screen.findByTestId("memory-review-decided-toggle"));
    await waitFor(() =>
      expect(api.listMemoryReview).toHaveBeenCalledWith(expect.objectContaining({ status: ["accepted", "rejected"] }))
    );
    expect(await screen.findByTestId("memory-review-status:p-2")).toBeTruthy();
  });
});
