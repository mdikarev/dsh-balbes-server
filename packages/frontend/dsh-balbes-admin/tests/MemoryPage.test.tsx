import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import MemoryPage from "../src/pages/MemoryPage";
import { ApiError, type AdminApi } from "../src/api/client";
import type {
  MemoryAutonomyPolicy,
  MemoryListRequest,
  MemoryProposal,
  MemoryRecord,
  MemoryReviewApproveRequest,
  MemorySaveRequest,
  WorkspaceListResponse
} from "dsh-balbes-contracts";

afterEach(cleanup);

const WORKSPACES: WorkspaceListResponse = {
  home: { path: "/h/agent" },
  projects: [{ name: "alpha", path: "/p/alpha" }]
};

const REVIEW_POLICY: MemoryAutonomyPolicy = { immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" };

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m-1",
    scope: { kind: "global" },
    type: "note",
    text: "hello memory",
    tags: ["x"],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    ...overrides
  };
}

function queueProposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
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

function makeApi(records: MemoryRecord[], overrides: Partial<AdminApi> = {}): AdminApi {
  const store = [...records];
  return {
    listWorkspaces: vi.fn(async () => ({ home: { path: "/h/agent" }, projects: [] })),
    listMemory: vi.fn(async () => ({ records: [...store] })),
    listMemoryReview: vi.fn(async () => ({ proposals: [], policy: REVIEW_POLICY })),
    saveMemory: vi.fn(async (req: MemorySaveRequest) => {
      const saved = record({ id: "m-new", text: req.text, type: req.type, tags: req.tags ?? [], pinned: req.pinned ?? false });
      store.push(saved);
      return { record: saved };
    }),
    deleteMemory: vi.fn(async (id: string) => {
      const index = store.findIndex((item) => item.id === id);
      if (index >= 0) store.splice(index, 1);
      return { deleted: index >= 0 };
    }),
    ...overrides
  } as unknown as AdminApi;
}

describe("MemoryPage", () => {
  it("shows the empty state", async () => {
    render(<MemoryPage api={makeApi([])} />);
    expect(await screen.findByTestId("memory-empty")).toBeTruthy();
  });

  it("renders a record with provenance and time", async () => {
    render(<MemoryPage api={makeApi([record()])} />);
    expect(await screen.findByTestId("memory-row:m-1")).toBeTruthy();
    expect(screen.getByText("hello memory")).toBeTruthy();
    expect(screen.getByText(/владелец ·/)).toBeTruthy();
    expect(screen.getByTestId("memory-row:m-1").textContent).toContain("x");
  });

  it("creates a record through the editor and refreshes the list", async () => {
    const api = makeApi([]);
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-add"));
    fireEvent.change(screen.getByTestId("memory-form-text"), { target: { value: "new note" } });
    fireEvent.click(screen.getByTestId("memory-form-save"));
    await waitFor(() => expect(api.saveMemory).toHaveBeenCalled());
    expect(api.saveMemory).toHaveBeenCalledWith(expect.objectContaining({ text: "new note", type: "note", scope: { kind: "global" } }));
    expect(await screen.findByTestId("memory-row:m-new")).toBeTruthy();
  });

  it("shows the Russian secret-detected copy with the rule and keeps the editor open", async () => {
    const api = makeApi([], {
      saveMemory: vi.fn(async () => { throw new ApiError(400, "secret-detected", 'text matches secret rule "ghp_"'); })
    });
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-add"));
    fireEvent.change(screen.getByTestId("memory-form-text"), { target: { value: "ghp_secret" } });
    fireEvent.click(screen.getByTestId("memory-form-save"));
    expect(await screen.findByTestId("memory-form-error")).toBeTruthy();
    expect(screen.getByTestId("memory-form-error").textContent).toBe("текст похож на секрет (ghp_) — запись отклонена");
    expect(screen.queryByTestId("memory-form-text")).not.toBeNull();
  });

  it("renders the plain server message for an invalid-record error", async () => {
    const api = makeApi([], {
      saveMemory: vi.fn(async () => { throw new ApiError(400, "invalid-record", "text must not be empty"); })
    });
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-add"));
    fireEvent.change(screen.getByTestId("memory-form-text"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("memory-form-save"));
    expect((await screen.findByTestId("memory-form-error")).textContent).toBe("text must not be empty");
  });

  it("falls back to the raw message when the secret error has no quoted rule", async () => {
    const api = makeApi([], {
      saveMemory: vi.fn(async () => { throw new ApiError(400, "secret-detected", "looks secret"); })
    });
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-add"));
    fireEvent.change(screen.getByTestId("memory-form-text"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("memory-form-save"));
    expect((await screen.findByTestId("memory-form-error")).textContent).toBe("текст похож на секрет (looks secret) — запись отклонена");
  });

  it("deletes through the confirmation modal", async () => {
    const api = makeApi([record()]);
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-delete:m-1"));
    fireEvent.click(screen.getByTestId("memory-delete-confirm"));
    await waitFor(() => expect(api.deleteMemory).toHaveBeenCalledWith("m-1"));
    expect(await screen.findByTestId("memory-empty")).toBeTruthy();
  });

  it("shows a failed delete inside the modal and keeps it open", async () => {
    const api = makeApi([record()], {
      deleteMemory: vi.fn(async () => { throw new ApiError(500, "internal", "delete failed"); })
    });
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-delete:m-1"));
    fireEvent.click(screen.getByTestId("memory-delete-confirm"));
    expect((await screen.findByTestId("memory-delete-error")).textContent).toBe("delete failed");
    expect(screen.getByTestId("memory-delete-confirm")).toBeTruthy();
    expect(screen.queryByTestId("memory-action-error")).toBeNull();
    fireEvent.click(screen.getByTestId("memory-delete-cancel"));
    fireEvent.click(screen.getByTestId("memory-delete:m-1"));
    expect(screen.queryByTestId("memory-delete-error")).toBeNull();
  });

  it("shows the no-results state when an active filter matches nothing", async () => {
    render(<MemoryPage api={makeApi([])} />);
    expect(await screen.findByTestId("memory-empty")).toBeTruthy();
    fireEvent.change(screen.getByTestId("memory-search"), { target: { value: "zzz" } });
    expect(await screen.findByTestId("memory-no-results")).toBeTruthy();
    expect(screen.getByTestId("memory-no-results").textContent).toContain("Ничего не найдено");
    expect(screen.queryByTestId("memory-empty")).toBeNull();
  });

  it("closes the editor and refreshes the list when an edit save hits a stale 404", async () => {
    const api = makeApi([record()], {
      saveMemory: vi.fn(async () => { throw new ApiError(404, "not-found", "memory record not found"); })
    });
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-edit:m-1"));
    expect(screen.getByTestId("memory-form-text")).toBeTruthy();
    fireEvent.click(screen.getByTestId("memory-form-save"));
    await waitFor(() => expect(screen.queryByTestId("memory-form-text")).toBeNull());
    expect(screen.queryByTestId("memory-form-error")).toBeNull();
    await waitFor(() => expect(api.listMemory).toHaveBeenCalledTimes(2));
  });

  it("lists every level without a scope filter when «Все» is selected", async () => {
    const listMemory = vi.fn(async (_request: MemoryListRequest) => ({ records: [record()] }));
    const api = makeApi([], { listWorkspaces: vi.fn(async () => WORKSPACES), listMemory });
    render(<MemoryPage api={api} />);
    await screen.findByTestId("memory-row:m-1");
    fireEvent.change(screen.getByTestId("memory-level"), { target: { value: "all" } });
    await waitFor(() => expect(listMemory).toHaveBeenCalledTimes(2));
    const request = listMemory.mock.calls[1]![0]!;
    expect(request).not.toHaveProperty("scope");
  });

  it("still sends the concrete project scope when a project level is selected", async () => {
    const listMemory = vi.fn(async (_request: MemoryListRequest) => ({ records: [record()] }));
    const api = makeApi([], { listWorkspaces: vi.fn(async () => WORKSPACES), listMemory });
    render(<MemoryPage api={api} />);
    await screen.findByRole("option", { name: "alpha" });
    fireEvent.change(screen.getByTestId("memory-level"), { target: { value: "project:alpha" } });
    await waitFor(() => expect(listMemory).toHaveBeenCalledTimes(2));
    expect(listMemory.mock.calls[1]![0]!).toEqual(
      expect.objectContaining({ scope: { kind: "project", name: "alpha" } })
    );
  });

  it("shows the level badge on a record from every level", async () => {
    const api = makeApi([record(), record({ id: "m-p", scope: { kind: "project", name: "alpha" } })]);
    render(<MemoryPage api={api} />);
    const homeRow = await screen.findByTestId("memory-row:m-1");
    const projectRow = screen.getByTestId("memory-row:m-p");
    expect(within(homeRow).getByTestId("memory-row-level").textContent).toBe("Дом");
    expect(within(projectRow).getByTestId("memory-row-level").textContent).toBe("alpha");
  });

  it("creates in the level chosen in the modal when «Все» is selected", async () => {
    const saveMemory = vi.fn(async (_request: MemorySaveRequest) => ({ record: record() }));
    const api = makeApi([], { listWorkspaces: vi.fn(async () => WORKSPACES), saveMemory });
    render(<MemoryPage api={api} />);
    await screen.findByTestId("memory-empty");
    fireEvent.change(screen.getByTestId("memory-level"), { target: { value: "all" } });
    fireEvent.click(screen.getByTestId("memory-add"));
    const levelSelect = screen.getByTestId("memory-form-level") as HTMLSelectElement;
    expect(levelSelect.value).toBe("global");
    fireEvent.change(levelSelect, { target: { value: "project:alpha" } });
    fireEvent.change(screen.getByTestId("memory-form-text"), { target: { value: "from the all-levels view" } });
    fireEvent.click(screen.getByTestId("memory-form-save"));
    await waitFor(() => expect(saveMemory).toHaveBeenCalled());
    expect(saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "project", name: "alpha" } })
    );
  });

  it("creates in the selected concrete level without a level picker", async () => {
    const saveMemory = vi.fn(async (_request: MemorySaveRequest) => ({ record: record() }));
    const api = makeApi([], { listWorkspaces: vi.fn(async () => WORKSPACES), saveMemory });
    render(<MemoryPage api={api} />);
    await screen.findByRole("option", { name: "alpha" });
    fireEvent.change(screen.getByTestId("memory-level"), { target: { value: "project:alpha" } });
    fireEvent.click(screen.getByTestId("memory-add"));
    expect(screen.queryByTestId("memory-form-level")).toBeNull();
    fireEvent.change(screen.getByTestId("memory-form-text"), { target: { value: "concrete level note" } });
    fireEvent.click(screen.getByTestId("memory-form-save"));
    await waitFor(() => expect(saveMemory).toHaveBeenCalled());
    expect(saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "project", name: "alpha" } })
    );
  });

  it("defaults the create modal to «Дом» after leaving a project level for «Все»", async () => {
    const api = makeApi([], { listWorkspaces: vi.fn(async () => WORKSPACES) });
    render(<MemoryPage api={api} />);
    await screen.findByRole("option", { name: "alpha" });
    fireEvent.change(screen.getByTestId("memory-level"), { target: { value: "project:alpha" } });
    fireEvent.change(screen.getByTestId("memory-level"), { target: { value: "all" } });
    fireEvent.click(screen.getByTestId("memory-add"));
    expect((screen.getByTestId("memory-form-level") as HTMLSelectElement).value).toBe("global");
  });

  it("shows the edited record's own level when opened from the «Все» view", async () => {
    const api = makeApi([record({ id: "m-p", scope: { kind: "project", name: "alpha" } })], {
      listWorkspaces: vi.fn(async () => WORKSPACES)
    });
    render(<MemoryPage api={api} />);
    await screen.findByTestId("memory-row:m-p");
    fireEvent.change(screen.getByTestId("memory-level"), { target: { value: "all" } });
    fireEvent.click(screen.getByTestId("memory-edit:m-p"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Уровень: alpha");
    expect(within(dialog).queryByTestId("memory-form-level")).toBeNull();
  });

  it("switches to the review queue and back", async () => {
    const api = makeApi([record()]);
    render(<MemoryPage api={api} />);
    expect(await screen.findByTestId("memory-row:m-1")).toBeTruthy();
    // the queue is not mounted behind the records tab: no prefetch, no hidden render
    expect(screen.queryByTestId("memory-review")).toBeNull();

    fireEvent.click(screen.getByTestId("memory-tab-review"));
    expect(await screen.findByTestId("memory-review-empty")).toBeTruthy();
    expect(api.listMemoryReview).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("memory-tab-records"));
    expect(await screen.findByTestId("memory-row:m-1")).toBeTruthy();
  });

  it("shows the pending counter on the review tab label", async () => {
    // The canon puts a pending counter on the tab label, so the page seeds it
    // once on mount — before the owner ever opens the queue.
    const api = makeApi([record()], {
      listMemoryReview: vi.fn(async () => ({
        proposals: [queueProposal(), queueProposal({ id: "p-2" })],
        policy: { immediate: ["owner", "remember"], review: ["pipeline"], autoApprove: "none" }
      }))
    } as Partial<AdminApi>);
    render(<MemoryPage api={api} />);
    expect(await screen.findByTestId("memory-tab-review-count")).toBeTruthy();
    expect(screen.getByTestId("memory-tab-review-count").textContent).toBe("2");
    // the badge is the total queue, never the queue's own filtered view: unfiltered request
    expect(api.listMemoryReview).toHaveBeenCalledWith({});
  });

  it("refreshes the pending counter after a decision in the queue", async () => {
    let proposals = [queueProposal()];
    const api = makeApi([record()], {
      listMemoryReview: vi.fn(async () => ({ proposals: [...proposals], policy: REVIEW_POLICY })),
      approveMemoryReview: vi.fn(async (_req: MemoryReviewApproveRequest) => {
        proposals = [];
        return { proposal: queueProposal({ status: "accepted", decidedBy: "owner", memoryId: "m-1" }), record: record() };
      })
    });
    render(<MemoryPage api={api} />);
    expect((await screen.findByTestId("memory-tab-review-count")).textContent).toBe("1");

    fireEvent.click(screen.getByTestId("memory-tab-review"));
    fireEvent.click(await screen.findByTestId("memory-review-approve:p-1"));
    fireEvent.click(screen.getByTestId("memory-review-form-approve"));
    await waitFor(() => expect(api.approveMemoryReview).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("memory-tab-review-count")).toBeNull());
  });
});
