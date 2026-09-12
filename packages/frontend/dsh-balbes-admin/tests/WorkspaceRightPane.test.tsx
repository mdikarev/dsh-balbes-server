import { describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import WorkspaceRightPane from "../src/components/WorkspaceRightPane";
import type { AdminApi } from "../src/api/client";

function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
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
    readSession: vi.fn(async () => ({ session: { id: "s", title: null, channel: "telegram", createdAt: "" }, messages: [] })),
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
    subscribeWorkspaceEvents: vi.fn(() => () => undefined),
    ...overrides
  } as unknown as AdminApi;
}

describe("WorkspaceRightPane", () => {
  it("renders one tab and its panel", async () => {
    const listSessions = vi.fn(async () => ({
      sessions: [
        { id: "session-alpha", title: "задача", channel: "telegram", createdAt: "2026-09-11T01:40:00.000Z" }
      ]
    }));
    render(<WorkspaceRightPane api={makeApi({ listSessions })} workspace={{ scope: "project", name: "alpha" }} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Сессии"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel")).toBeDefined();
    // positive half of the "no content without a workspace" check below: with a
    // workspace selected the active tab really renders its populated list, so the
    // sessions-list assertion there is non-vacuous
    await waitFor(() => expect(screen.getByTestId("sessions-list")).toBeDefined());
    expect(screen.getByTestId("sessions-list").textContent).toContain("задача");
    cleanup();
  });

  it("links the active tab and its panel by id and aria attributes", () => {
    render(<WorkspaceRightPane api={makeApi()} workspace={{ scope: "project", name: "alpha" }} />);
    const tab = screen.getByRole("tab");
    const panel = screen.getByRole("tabpanel");
    expect(tab.id).toBe("ws-tab-sessions");
    expect(panel.id).toBe(tab.getAttribute("aria-controls"));
    expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
    cleanup();
  });

  it("shows the placeholder instead of the panel content without a workspace", () => {
    const api = makeApi();
    render(<WorkspaceRightPane api={api} workspace={null} />);
    expect(screen.getByTestId("right-pane-prompt").textContent).toBe("Выберите воркспейс");
    // no SessionsTab content at all while the placeholder shows (sessions-list is
    // proven non-vacuous by the positive assertion above; sessions-loading and
    // sessions-empty are asserted positively in SessionsTab.test.tsx)
    expect(screen.queryByTestId("sessions-loading")).toBeNull();
    expect(screen.queryByTestId("sessions-empty")).toBeNull();
    expect(screen.queryByTestId("sessions-list")).toBeNull();
    expect(api.listSessions).not.toHaveBeenCalled();
    cleanup();
  });

  it("reloads the active tab on refresh and on a tab click", async () => {
    const listSessions = vi.fn(async () => ({ sessions: [] }));
    render(
      <WorkspaceRightPane api={makeApi({ listSessions })} workspace={{ scope: "project", name: "alpha" }} />
    );
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("ws-refresh"));
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId("ws-tab-sessions"));
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(3));
    cleanup();
  });

  it("offers a refresh control", () => {
    render(<WorkspaceRightPane api={makeApi()} workspace={{ scope: "home" }} />);
    expect(screen.getByTestId("ws-refresh")).toBeDefined();
    cleanup();
  });

  it("opens a session tab from the list, focuses it and closes it", async () => {
    const session = { id: "session-alpha", title: "задача", channel: "telegram", createdAt: "2026-09-11T01:40:00.000Z" };
    const api = makeApi({
      listSessions: vi.fn(async () => ({ sessions: [session] })),
      readSession: vi.fn(async () => ({ session, messages: [] }))
    });
    render(<WorkspaceRightPane api={api} workspace={{ scope: "project", name: "alpha" }} />);
    await waitFor(() => expect(screen.getByTestId("session-row-session-alpha")).toBeDefined());

    fireEvent.click(screen.getByTestId("session-row-session-alpha"));
    await waitFor(() => expect(screen.getByTestId("session-transcript-empty")).toBeDefined());
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Сессии", "задача"]);

    // повторное открытие не дублирует таб: список скрыт, поэтому сначала возвращаемся на «Сессии»
    fireEvent.click(screen.getByTestId("ws-tab-sessions"));
    await waitFor(() => expect(screen.getByTestId("session-row-session-alpha")).toBeDefined());
    fireEvent.click(screen.getByTestId("session-row-session-alpha"));
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("ws-tab-close-session:session-alpha"));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "задача" })).toBeNull());
    cleanup();
  });

  it("resets session tabs on a workspace switch", async () => {
    const session = { id: "session-alpha", title: "задача", channel: "telegram", createdAt: "2026-09-11T01:40:00.000Z" };
    const api = makeApi({
      listSessions: vi.fn(async () => ({ sessions: [session] })),
      readSession: vi.fn(async () => ({ session, messages: [] }))
    });
    const { rerender } = render(<WorkspaceRightPane api={api} workspace={{ scope: "project", name: "alpha" }} />);
    await waitFor(() => expect(screen.getByTestId("session-row-session-alpha")).toBeDefined());
    fireEvent.click(screen.getByTestId("session-row-session-alpha"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "задача" })).toBeDefined());

    rerender(<WorkspaceRightPane api={api} workspace={{ scope: "project", name: "beta" }} />);
    await waitFor(() => expect(screen.queryByRole("tab", { name: "задача" })).toBeNull());
    cleanup();
  });
});
