import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkspaceList from "../src/components/WorkspaceList";
import type { WorkspaceProject } from "dsh-balbes-contracts";
import type { WorkspaceRef } from "../src/workspaceRef";

const projects: WorkspaceProject[] = [
  { name: "alpha", path: "/h/projects/alpha", createdAt: "2026-09-06T00:00:00.000Z" },
  { name: "beta", path: "/h/projects/beta" }
];
const homePath = "/h/agent";

function setup(overrides: Partial<Parameters<typeof WorkspaceList>[0]> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides
  };
  render(
    <WorkspaceList
      homePath={homePath}
      projects={overrides.projects ?? projects}
      selected={null}
      busy={false}
      onSelect={handlers.onSelect}
      onCreate={handlers.onCreate}
      onDelete={handlers.onDelete}
    />
  );
  return handlers;
}

afterEach(() => cleanup());

describe("WorkspaceList", () => {
  it("renders the pinned home without a reserved chip or action menu", () => {
    setup();
    expect(screen.getByText("Воркспейсы")).toBeTruthy();
    expect(screen.getByText("Дом агента")).toBeTruthy();
    expect(screen.queryByText("зарезервирован")).toBeNull();
    expect(screen.queryByTestId("ws-menu-home")).toBeNull();
  });

  it("selects a project on row click and marks it active", () => {
    const handlers = setup();
    fireEvent.click(screen.getByTestId("ws-row-project:alpha"));
    expect(handlers.onSelect).toHaveBeenCalledWith({ scope: "project", name: "alpha" });
  });

  it("selects the home on click", () => {
    const handlers = setup();
    fireEvent.click(screen.getByTestId("ws-row-home"));
    expect(handlers.onSelect).toHaveBeenCalledWith({ scope: "home" });
  });

  it("opens the ⋮ menu above the list and offers delete", () => {
    const handlers = setup();
    fireEvent.click(screen.getByTestId("ws-menu-project:beta"));
    expect(screen.getByText("Удалить")).toBeTruthy();
    // the menu must float outside the scrollable rows list, not be clipped inside it
    expect(screen.getByTestId("ws-dropdown-project:beta").closest("ul")).toBeNull();
    fireEvent.click(screen.getByText("Удалить"));
    expect(handlers.onDelete).toHaveBeenCalledWith(projects[1]);
  });

  it("closes the ⋮ menu on an outside pointerdown", () => {
    setup();
    fireEvent.click(screen.getByTestId("ws-menu-project:beta"));
    expect(screen.getByText("Удалить")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("ws-dropdown-project:beta")).toBeNull();
  });

  it("shows the empty hint when there are no projects", () => {
    setup({ projects: [] });
    expect(screen.getByText("Проектов нет.")).toBeTruthy();
  });
});
