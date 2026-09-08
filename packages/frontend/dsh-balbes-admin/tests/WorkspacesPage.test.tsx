import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import WorkspacesPage from "../src/pages/WorkspacesPage";
import type { AdminApi } from "../src/api/client";
import type { WorkspaceListResponse, WorkspaceProject, WorkspaceScope } from "dsh-balbes-contracts";

const listBody: WorkspaceListResponse = {
  home: { path: "/home/u/.dsh/agent" },
  projects: [{ name: "alpha", path: "/home/u/.dsh/projects/alpha", createdAt: "2026-09-06T00:00:00.000Z" }]
};

const NOW = "2026-09-06T00:00:00.000Z";

/**
 * Stateful fake registry: createWorkspace/deleteWorkspace mutate a per-api
 * project list that listWorkspaces reports, so a post-create refresh lists the
 * new project and a post-delete refresh drops the removed one. The default
 * readWorkspaceDir serves `src` under alpha (delete-flow tests select alpha and
 * assert its tree rendered) and an empty root elsewhere.
 */
function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  const projects: WorkspaceProject[] = listBody.projects.map((p) => ({ ...p }));
  return {
    health: vi.fn(),
    login: vi.fn(),
    me: vi.fn(),
    prompt: vi.fn(),
    onUnauthorized: vi.fn(),
    listWorkspaces: vi.fn(async () => ({ home: listBody.home, projects: [...projects] })),
    createWorkspace: vi.fn(async (name: string) => {
      const project: WorkspaceProject = { name, path: `/h/projects/${name}`, createdAt: NOW };
      projects.push(project);
      return { project };
    }),
    deleteWorkspace: vi.fn(async (name: string) => {
      const idx = projects.findIndex((p) => p.name === name);
      if (idx !== -1) projects.splice(idx, 1);
      return {};
    }),
    readWorkspaceDir: vi.fn(async (scope: WorkspaceScope, name: string | undefined) => ({
      entries: scope === "project" && name === "alpha" ? [{ name: "src", kind: "dir" as const }] : []
    })),
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

describe("WorkspacesPage tree pane width", () => {
  it("persists the tree-pane width from a splitter drag across remount", async () => {
    const { unmount } = render(<WorkspacesPage api={makeApi()} />);
    await screen.findByText("alpha");
    // jsdom has no PointerEvent constructor, so fireEvent.pointer* cannot carry
    // clientX; dispatch real MouseEvents (React handles native pointer* names
    // unconditionally, the page listens on window for move/up).
    fireEvent(screen.getByTestId("ws-splitter"), new MouseEvent("pointerdown", { clientX: 100, bubbles: true, cancelable: true }));
    fireEvent(window, new MouseEvent("pointermove", { clientX: 380, bubbles: true }));
    fireEvent(window, new MouseEvent("pointerup", { clientX: 380, bubbles: true }));
    expect(localStorage.getItem("balbes.treePaneWidth")).toBe("220");
    unmount();

    // remount restores the stored width on the tree shell
    render(<WorkspacesPage api={makeApi()} />);
    await screen.findByText("alpha");
    const shell = document.querySelector<HTMLElement>(".ws-tree-shell");
    expect(shell).not.toBeNull();
    expect(shell?.style.getPropertyValue("--tree-w")).toBe("220px");
  });
});

describe("WorkspacesPage create/delete flows", () => {
  it("creates a project via the modal and selects it", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("workspace-create-open"));
    expect(screen.getByText("Создать проект")).toBeTruthy();
    fireEvent.change(screen.getByTestId("workspace-name-input"), { target: { value: "beta" } });
    fireEvent.click(screen.getByTestId("workspace-create-submit"));
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledWith("beta"));
    await waitFor(() => expect(api.listWorkspaces).toHaveBeenCalledTimes(2));
    // the new project gets selected: its tree loads
    await waitFor(() => expect(api.readWorkspaceDir).toHaveBeenCalledWith("project", "beta", ""));
  });

  it("deletes a project through the menu and confirm modal, deselecting it", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("ws-row-project:alpha"));
    expect(await screen.findByText("src")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ws-menu-project:alpha"));
    fireEvent.click(screen.getByTestId("ws-delete-alpha"));
    expect(screen.getByText("Удалить проект")).toBeTruthy();
    expect(screen.getByText(/безвозвратно/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("workspace-delete-alpha"));
    await waitFor(() => expect(api.deleteWorkspace).toHaveBeenCalledWith("alpha"));
    await waitFor(() => expect(api.listWorkspaces).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Выберите воркспейс")).toBeTruthy();
  });

  it("cancel keeps the project and performs no deletion", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    fireEvent.click(screen.getByTestId("ws-menu-project:alpha"));
    fireEvent.click(screen.getByTestId("ws-delete-alpha"));
    fireEvent.click(screen.getByTestId("workspace-delete-cancel"));
    expect(api.deleteWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByText("Удалить проект")).toBeNull();
  });
});
