import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import WorkspacesPage from "../src/pages/WorkspacesPage";
import type { AdminApi } from "../src/api/client";
import type { WorkspaceListResponse } from "dsh-balbes-contracts";

const listBody: WorkspaceListResponse = {
  home: { path: "/home/u/.dsh/agent" },
  projects: [{ name: "alpha", path: "/home/u/.dsh/projects/alpha", createdAt: "2026-09-06T00:00:00.000Z" }]
};

function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    health: vi.fn(),
    login: vi.fn(),
    me: vi.fn(),
    prompt: vi.fn(),
    onUnauthorized: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue(listBody),
    createWorkspace: vi.fn().mockResolvedValue({ project: { name: "beta", path: "/h/projects/beta", createdAt: "2026-09-06T00:00:00.000Z" } }),
    deleteWorkspace: vi.fn().mockResolvedValue({}),
    readWorkspaceDir: vi.fn(async () => ({ entries: [] })),
    subscribeWorkspaceEvents: vi.fn(() => () => {}),
    ...overrides
  } as AdminApi;
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("WorkspacesPage layout", () => {
  it("shows the pinned home and projects in the list pane", async () => {
    render(<WorkspacesPage api={makeApi()} />);
    expect(await screen.findByText("Дом агента")).toBeTruthy();
    expect(screen.getByText("/home/u/.dsh/agent")).toBeTruthy();
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByTestId("workspace-list-pane")).toBeTruthy();
    expect(screen.getByTestId("tree-pane")).toBeTruthy();
  });

  it("starts unselected and prompts to choose a workspace", async () => {
    render(<WorkspacesPage api={makeApi()} />);
    expect(await screen.findByText("Выберите воркспейс")).toBeTruthy();
  });

  it("selecting a project loads its tree; the choice survives remount", async () => {
    const api = makeApi({
      readWorkspaceDir: vi.fn(async (scope, name, path) => {
        expect(path).toBe("");
        return { entries: scope === "project" && name === "alpha" ? [{ name: "src", kind: "dir" as const }] : [] };
      })
    });
    const { unmount } = render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("ws-row-project:alpha"));
    expect(await screen.findByText("src")).toBeTruthy();
    unmount();

    // remount restores the last selection from localStorage
    const api2 = makeApi({
      readWorkspaceDir: vi.fn(async () => ({ entries: [{ name: "src", kind: "dir" as const }] }))
    });
    render(<WorkspacesPage api={api2} />);
    expect(await screen.findByText("src")).toBeTruthy();
    expect(api2.readWorkspaceDir).toHaveBeenCalledWith("project", "alpha", "");
  });

  it("selecting the home loads the agent home tree", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("ws-row-home"));
    await waitFor(() => expect(api.readWorkspaceDir).toHaveBeenCalledWith("home", undefined, ""));
  });

  it("shows an error with retry when the initial list load fails, then recovers", async () => {
    const api = makeApi({
      listWorkspaces: vi.fn().mockRejectedValueOnce(new Error("registry unreadable")).mockResolvedValueOnce(listBody)
    });
    render(<WorkspacesPage api={api} />);
    expect(await screen.findByTestId("workspace-load-error")).toBeTruthy();
    expect(screen.getByText(/Не удалось загрузить воркспейсы/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("workspace-load-retry"));
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(api.listWorkspaces).toHaveBeenCalledTimes(2);
  });
});
