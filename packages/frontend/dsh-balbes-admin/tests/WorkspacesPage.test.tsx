import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
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
    listSessions: vi.fn(async () => ({ sessions: [] })),
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
    expect(await screen.findByTestId("tree-prompt")).toBeTruthy();
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
    expect(screen.getByTestId("tree-prompt")).toBeTruthy();
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

  it("create failure shows an action banner, keeps the modal open, and a retry clears it", async () => {
    // local registry: the first create rejects, the retry must succeed and the
    // created project must appear in the post-create refresh list
    const projects: WorkspaceProject[] = listBody.projects.map((p) => ({ ...p }));
    const api = makeApi({
      listWorkspaces: vi.fn(async () => ({ home: listBody.home, projects: [...projects] })),
      createWorkspace: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockImplementation(async (name: string) => {
          const project: WorkspaceProject = { name, path: `/h/projects/${name}`, createdAt: NOW };
          projects.push(project);
          return { project };
        })
    });
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("workspace-create-open"));
    fireEvent.change(screen.getByTestId("workspace-name-input"), { target: { value: "beta" } });
    fireEvent.click(screen.getByTestId("workspace-create-submit"));

    // the failure is visible in the loaded layout: banner with the message
    const banner = await screen.findByTestId("workspace-action-error");
    expect(banner.textContent).toContain("Не удалось: disk full");
    // the modal stays open and busy reset lets the user retry
    expect(screen.getByText("Создать проект")).toBeTruthy();
    const submit = screen.getByTestId("workspace-create-submit") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    expect(submit.textContent).toBe("Создать");

    // a clean retry hides the banner and completes the create
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByTestId("workspace-action-error")).toBeNull());
    await waitFor(() => expect(api.readWorkspaceDir).toHaveBeenCalledWith("project", "beta", ""));
    expect(api.createWorkspace).toHaveBeenCalledTimes(2);
    expect(api.listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("delete failure shows an action banner, keeps the row, and a retry clears it", async () => {
    // local registry: the first delete rejects, the retry succeeds and removes
    // alpha so the refreshed list drops the row
    const projects: WorkspaceProject[] = listBody.projects.map((p) => ({ ...p }));
    const api = makeApi({
      listWorkspaces: vi.fn(async () => ({ home: listBody.home, projects: [...projects] })),
      deleteWorkspace: vi
        .fn()
        .mockRejectedValueOnce(new Error("catalog busy"))
        .mockImplementation(async (name: string) => {
          const idx = projects.findIndex((p) => p.name === name);
          if (idx !== -1) projects.splice(idx, 1);
          return {};
        })
    });
    render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    fireEvent.click(screen.getByTestId("ws-menu-project:alpha"));
    fireEvent.click(screen.getByTestId("ws-delete-alpha"));
    fireEvent.click(screen.getByTestId("workspace-delete-alpha"));

    // the failure is visible: banner with the message, modal open, row still listed
    const banner = await screen.findByTestId("workspace-action-error");
    expect(banner.textContent).toContain("Не удалось: catalog busy");
    expect(screen.getByText("Удалить проект")).toBeTruthy();
    expect(screen.getByTestId("ws-row-project:alpha")).toBeTruthy();
    const confirm = screen.getByTestId("workspace-delete-alpha") as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(confirm.textContent).toBe("Удалить");

    // a clean retry hides the banner and completes the delete
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByTestId("workspace-action-error")).toBeNull());
    await waitFor(() => expect(api.deleteWorkspace).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.listWorkspaces).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Удалить проект")).toBeNull();
    expect(screen.queryByTestId("ws-row-project:alpha")).toBeNull();
  });
});

describe("WorkspacesPage live events", () => {
  it("refreshes the tree on an fs event for the selected workspace", async () => {
    const read = vi.fn(async () => ({ entries: [{ name: "src", kind: "dir" as const }] }));
    const api = makeApi({ readWorkspaceDir: read });
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("ws-row-project:alpha"));
    expect(await screen.findByText("src")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(1);
    const subscribe = api.subscribeWorkspaceEvents as ReturnType<typeof vi.fn>;
    const cbs = subscribe.mock.calls;
    const cb = cbs[cbs.length - 1]?.[0] as (e: unknown) => void;
    expect(cb).toBeTypeOf("function");
    cb({ kind: "fs", scope: "project", name: "alpha", path: "" });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("deselects a project that a list event removed", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(listBody)
      .mockResolvedValueOnce({ home: { path: "/h/agent" }, projects: [] });
    const api = makeApi({ listWorkspaces: list });
    render(<WorkspacesPage api={api} />);
    fireEvent.click(await screen.findByTestId("ws-row-project:alpha"));
    await screen.findByText("src");
    const subscribe = api.subscribeWorkspaceEvents as ReturnType<typeof vi.fn>;
    const cbs = subscribe.mock.calls;
    const cb = cbs[cbs.length - 1]?.[0] as (e: unknown) => void;
    cb({ kind: "list" });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("tree-prompt")).toBeTruthy();
  });

  it("shows the action banner when a list-event refresh fails and a later success clears it", async () => {
    // local registry (like the create/delete failure tests): the initial load
    // succeeds so the loaded layout (and its action banner) is on screen; the
    // first event-driven refresh rejects, the second (a retry) resolves
    const projects: WorkspaceProject[] = listBody.projects.map((p) => ({ ...p }));
    const list = vi
      .fn()
      .mockImplementationOnce(async () => ({ home: listBody.home, projects: [...projects] }))
      .mockRejectedValueOnce(new Error("registry hiccup"))
      .mockImplementation(async () => ({ home: listBody.home, projects: [...projects] }));
    const api = makeApi({ listWorkspaces: list });
    render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    const subscribe = api.subscribeWorkspaceEvents as ReturnType<typeof vi.fn>;
    const latestCallback = (): ((e: unknown) => void) => {
      const cbs = subscribe.mock.calls;
      const cb = cbs[cbs.length - 1]?.[0] as (e: unknown) => void;
      expect(cb).toBeTypeOf("function");
      return cb;
    };

    // failing event-driven refresh surfaces in the in-layout banner (no
    // unhandled rejection: the error is caught by refreshFromEvent)
    act(() => {
      latestCallback()({ kind: "list" });
    });
    const banner = await screen.findByTestId("workspace-action-error");
    expect(banner.textContent).toContain("Не удалось: registry hiccup");

    // a subsequent successful refresh (retry via a second list event) clears it
    act(() => {
      latestCallback()({ kind: "list" });
    });
    await waitFor(() => expect(screen.queryByTestId("workspace-action-error")).toBeNull());
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("unsubscribes on unmount", async () => {
    const unsub = vi.fn();
    const api = makeApi({ subscribeWorkspaceEvents: vi.fn(() => unsub) });
    const { unmount } = render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
