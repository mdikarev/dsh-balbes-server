import { describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import WorkspaceRightPane from "../src/components/WorkspaceRightPane";
import type { AdminApi } from "../src/api/client";

function makeApi(): AdminApi {
  return {
    health: vi.fn(),
    login: vi.fn(),
    me: vi.fn(),
    prompt: vi.fn(),
    onUnauthorized: vi.fn(),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    readWorkspaceDir: vi.fn(),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listModels: vi.fn(),
    saveModel: vi.fn(),
    deleteModel: vi.fn(),
    setDefaultModel: vi.fn(),
    catalogModels: vi.fn(),
    telegramStatus: vi.fn(),
    telegramSave: vi.fn(),
    telegramTest: vi.fn(),
    telegramDisable: vi.fn(),
    telegramClearToken: vi.fn(),
    subscribeWorkspaceEvents: vi.fn(() => () => undefined)
  } as unknown as AdminApi;
}

describe("WorkspaceRightPane", () => {
  it("renders one tab and its panel", () => {
    render(<WorkspaceRightPane api={makeApi()} workspace={{ scope: "project", name: "alpha" }} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Сессии"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel")).toBeDefined();
    cleanup();
  });

  it("shows the placeholder instead of the panel content without a workspace", () => {
    render(<WorkspaceRightPane api={makeApi()} workspace={null} />);
    expect(screen.getByTestId("right-pane-prompt").textContent).toBe("Выберите воркспейс");
    expect(screen.queryByTestId("sessions-empty")).toBeNull();
    cleanup();
  });

  it("offers a refresh control", () => {
    render(<WorkspaceRightPane api={makeApi()} workspace={{ scope: "home" }} />);
    expect(screen.getByTestId("ws-refresh")).toBeDefined();
    cleanup();
  });
});
