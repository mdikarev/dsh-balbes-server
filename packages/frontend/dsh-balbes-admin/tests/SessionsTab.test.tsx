import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import SessionsTab from "../src/components/SessionsTab";
import type { AdminApi } from "../src/api/client";

const SESSIONS = [
  { id: "session-new", title: "новая задача", channel: "telegram", createdAt: "2026-09-11T01:40:00.000Z" },
  { id: "session-old", title: null, channel: "telegram", createdAt: "2026-09-10T10:00:00.000Z" }
];

function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listSessions: vi.fn(async () => ({ sessions: SESSIONS })),
    ...overrides
  } as unknown as AdminApi;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("SessionsTab", () => {
  it("renders rows with title, channel and time", async () => {
    render(<SessionsTab api={makeApi()} workspace={{ scope: "project", name: "alpha" }} reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("session-row-session-new")).toBeDefined());
    expect(screen.getByTestId("session-row-session-new").textContent).toContain("новая задача");
    expect(screen.getByTestId("session-row-session-new").textContent).toContain("telegram");
    // время показано локальным ru-RU, а не сырым ISO (формат как в TelegramPage)
    expect(screen.getByTestId("session-row-session-new").textContent).toContain(
      new Date("2026-09-11T01:40:00.000Z").toLocaleString("ru-RU")
    );
    // сессия без заголовка получает явную заглушку, а не пустую строку
    expect(screen.getByTestId("session-row-session-old").textContent).toContain("Без заголовка");
  });

  it("falls back for an empty title and an empty time", async () => {
    const api = makeApi({
      listSessions: vi.fn(async () => ({
        sessions: [
          { id: "session-empty-title", title: "", channel: "telegram", createdAt: "2026-09-11T01:40:00.000Z" },
          { id: "session-blank-title", title: "   ", channel: "telegram", createdAt: "2026-09-11T01:40:00.000Z" },
          { id: "session-empty-time", title: "есть заголовок", channel: "telegram", createdAt: "" },
          { id: "session-bad-time", title: "битая дата", channel: "telegram", createdAt: "не дата" }
        ]
      }))
    });
    render(<SessionsTab api={api} workspace={{ scope: "home" }} reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("sessions-list")).toBeDefined());
    // пустой и пробельный заголовок — то же отсутствие заголовка, что и null
    expect(screen.getByTestId("session-row-session-empty-title").textContent).toContain("Без заголовка");
    expect(screen.getByTestId("session-row-session-blank-title").textContent).toContain("Без заголовка");
    // пустое время получает заглушку, а не пустое место
    expect(screen.getByTestId("session-row-session-empty-time").textContent).toContain("—");
    // невалидная непустая строка по-прежнему показывается как есть (честный fallback)
    expect(screen.getByTestId("session-row-session-bad-time").textContent).toContain("не дата");
  });

  it("shows the empty state", async () => {
    const api = makeApi({ listSessions: vi.fn(async () => ({ sessions: [] })) });
    render(<SessionsTab api={api} workspace={{ scope: "home" }} reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("sessions-empty")).toBeDefined());
  });

  it("shows an error with a retry that reloads", async () => {
    const listSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ sessions: SESSIONS });
    render(<SessionsTab api={makeApi({ listSessions })} workspace={{ scope: "home" }} reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("sessions-error")).toBeDefined());
    fireEvent.click(screen.getByTestId("sessions-retry"));
    await waitFor(() => expect(screen.getByTestId("session-row-session-new")).toBeDefined());
  });

  it("makes no request without a workspace", () => {
    const listSessions = vi.fn();
    render(<SessionsTab api={makeApi({ listSessions })} workspace={null} reloadKey={0} />);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("does not keep rows of the previous workspace after a switch", async () => {
    const listSessions = vi.fn(async (scope: string, name?: string) =>
      name === "alpha"
        ? { sessions: SESSIONS }
        : { sessions: [{ id: "session-beta", title: "бета", channel: "telegram", createdAt: "2026-09-11T02:00:00.000Z" }] }
    );
    const api = makeApi({ listSessions });
    const { rerender } = render(
      <SessionsTab api={api} workspace={{ scope: "project", name: "alpha" }} reloadKey={0} />
    );
    await waitFor(() => expect(screen.getByTestId("session-row-session-new")).toBeDefined());

    rerender(<SessionsTab api={api} workspace={{ scope: "project", name: "beta" }} reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("session-row-session-beta")).toBeDefined());
    expect(screen.queryByTestId("session-row-session-new")).toBeNull();
  });

  it("reloads when reloadKey changes", async () => {
    const listSessions = vi.fn(async () => ({ sessions: SESSIONS }));
    const api = makeApi({ listSessions });
    const { rerender } = render(<SessionsTab api={api} workspace={{ scope: "home" }} reloadKey={0} />);
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    rerender(<SessionsTab api={api} workspace={{ scope: "home" }} reloadKey={1} />);
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
  });

  // Addition beyond the brief, for the dispatch's self-review item (a): the
  // previous test switches workspaces after alpha already answered, so it cannot
  // fail if the stale guard is missing. Here the switch happens while alpha is
  // still in flight and the late answer must be dropped.
  it("ignores a late response of the previous workspace", async () => {
    const pending = new Map<string, (value: { sessions: typeof SESSIONS }) => void>();
    const listSessions = vi.fn(
      (_scope: string, name?: string) =>
        new Promise<{ sessions: typeof SESSIONS }>((resolve) => {
          pending.set(name ?? "home", resolve);
        })
    );
    const api = makeApi({ listSessions });
    const { rerender } = render(
      <SessionsTab api={api} workspace={{ scope: "project", name: "alpha" }} reloadKey={0} />
    );
    expect(screen.getByTestId("sessions-loading")).toBeDefined();

    // switch to beta while alpha's request is still outstanding
    rerender(<SessionsTab api={api} workspace={{ scope: "project", name: "beta" }} reloadKey={0} />);
    await act(async () => {
      pending.get("beta")?.({
        sessions: [{ id: "session-beta", title: "бета", channel: "telegram", createdAt: "2026-09-11T02:00:00.000Z" }]
      });
    });
    expect(screen.getByTestId("session-row-session-beta")).toBeDefined();

    // the late answer of the previous workspace must not be applied on top of beta
    await act(async () => {
      pending.get("alpha")?.({ sessions: SESSIONS });
    });
    expect(screen.queryByTestId("session-row-session-new")).toBeNull();
    expect(screen.getByTestId("session-row-session-beta")).toBeDefined();
  });
});
