import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MemoryPage from "../src/pages/MemoryPage";
import { ApiError, type AdminApi } from "../src/api/client";
import type { MemoryRecord, MemorySaveRequest } from "dsh-balbes-contracts";

afterEach(cleanup);

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

function makeApi(records: MemoryRecord[], overrides: Partial<AdminApi> = {}): AdminApi {
  const store = [...records];
  return {
    listWorkspaces: vi.fn(async () => ({ home: { path: "/h/agent" }, projects: [] })),
    listMemory: vi.fn(async () => ({ records: [...store] })),
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
});
