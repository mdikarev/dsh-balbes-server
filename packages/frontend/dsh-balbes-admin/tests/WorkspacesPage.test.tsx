import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    ...overrides
  } as AdminApi;
}

describe("WorkspacesPage", () => {
  let confirmSpy: MockInstance<Window["confirm"]>;
  beforeEach(() => {
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the home section and the project list", async () => {
    render(<WorkspacesPage api={makeApi()} />);
    expect(await screen.findByText("Дом агента")).toBeTruthy();
    expect(screen.getByText("/home/u/.dsh/agent")).toBeTruthy();
    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(screen.getByText("Проекты")).toBeTruthy();
  });

  it("creates a project from the form and refreshes the list", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    fireEvent.change(screen.getByTestId("workspace-name-input"), { target: { value: "beta" } });
    fireEvent.click(screen.getByTestId("workspace-create-submit"));
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledWith("beta"));
    await waitFor(() => expect(api.listWorkspaces).toHaveBeenCalledTimes(2));
  });

  it("deletes a project after confirm and refreshes", async () => {
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    fireEvent.click(screen.getByTestId("workspace-delete-alpha"));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.deleteWorkspace).toHaveBeenCalledWith("alpha"));
    await waitFor(() => expect(api.listWorkspaces).toHaveBeenCalledTimes(2));
  });

  it("does not delete when confirm is cancelled", async () => {
    confirmSpy.mockReturnValue(false);
    const api = makeApi();
    render(<WorkspacesPage api={api} />);
    await screen.findByText("alpha");
    fireEvent.click(screen.getByTestId("workspace-delete-alpha"));
    expect(api.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("renders a dash for a project without createdAt", async () => {
    const noDate: WorkspaceListResponse = {
      home: { path: "/h/agent" },
      projects: [{ name: "hand", path: "/h/projects/hand" }]
    };
    const api = makeApi({ listWorkspaces: vi.fn().mockResolvedValue(noDate) });
    render(<WorkspacesPage api={api} />);
    expect(await screen.findByText("—")).toBeTruthy();
  });
});
