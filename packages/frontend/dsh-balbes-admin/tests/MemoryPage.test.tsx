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

  it("shows the secret-detected error inline and keeps the editor open", async () => {
    const api = makeApi([], {
      saveMemory: vi.fn(async () => { throw new ApiError(400, "secret-detected", 'text matches secret rule "ghp_"'); })
    });
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-add"));
    fireEvent.change(screen.getByTestId("memory-form-text"), { target: { value: "ghp_secret" } });
    fireEvent.click(screen.getByTestId("memory-form-save"));
    expect(await screen.findByTestId("memory-form-error")).toBeTruthy();
    expect(screen.getByTestId("memory-form-error").textContent).toContain("secret-detected");
  });

  it("deletes through the confirmation modal", async () => {
    const api = makeApi([record()]);
    render(<MemoryPage api={api} />);
    fireEvent.click(await screen.findByTestId("memory-delete:m-1"));
    fireEvent.click(screen.getByTestId("memory-delete-confirm"));
    await waitFor(() => expect(api.deleteMemory).toHaveBeenCalledWith("m-1"));
    expect(await screen.findByTestId("memory-empty")).toBeTruthy();
  });
});
