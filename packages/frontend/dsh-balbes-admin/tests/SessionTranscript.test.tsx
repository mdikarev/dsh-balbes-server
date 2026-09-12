import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import SessionTranscript from "../src/components/SessionTranscript";
import type { AdminApi } from "../src/api/client";
import type { SessionsReadResponse } from "dsh-balbes-contracts";

const SESSION = { id: "s-1", title: "задача", channel: "telegram", createdAt: "2026-09-12T00:00:00.000Z" };
function response(messages: SessionsReadResponse["messages"]): SessionsReadResponse {
  return { session: SESSION, messages };
}
function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return { readSession: vi.fn(async () => response([])), ...overrides } as unknown as AdminApi;
}

afterEach(() => cleanup());

describe("SessionTranscript", () => {
  it("renders messages and collapses tool/context rows", async () => {
    const api = makeApi({
      readSession: vi.fn(async () =>
        response([
          { seq: 0, time: "2026-09-12T00:00:00.000Z", role: "assistant", kind: "message", text: "ответ модели", inContext: true },
          { seq: 1, time: "2026-09-12T00:00:01.000Z", role: "assistant", kind: "tool-call", text: "", detail: "{}", toolName: "read", inContext: true },
          { seq: 2, time: "2026-09-12T00:00:02.000Z", role: "system", kind: "context", text: "", detail: "промпт", inContext: true },
          { seq: 3, time: "2026-09-12T00:00:03.000Z", role: "user", kind: "message", text: "старое", inContext: false }
        ])
      )
    });
    render(<SessionTranscript api={api} workspace={{ scope: "project", name: "alpha" }} sessionId="s-1" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("session-transcript")).toBeDefined());
    expect(api.readSession).toHaveBeenCalledWith("project", "alpha", "s-1");
    expect(screen.getByText("ответ модели")).toBeDefined();
    expect(screen.getByText("Вызов инструмента: read")).toBeDefined();
    expect(screen.getByText("Системный промпт")).toBeDefined();
    // свёрнутые строки — details без атрибута open
    expect(screen.getByTestId("session-entry-1").querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("не в контексте")).toBeDefined();
  });

  it("shows loading, empty and error with retry", async () => {
    const readSession = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(response([]));
    render(<SessionTranscript api={makeApi({ readSession })} workspace={{ scope: "home" }} sessionId="s-1" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("session-transcript-error")).toBeDefined());
    fireEvent.click(screen.getByTestId("session-transcript-retry"));
    await waitFor(() => expect(screen.getByTestId("session-transcript-empty")).toBeDefined());
  });

  it("makes no request without a workspace", () => {
    const api = makeApi();
    render(<SessionTranscript api={api} workspace={null} sessionId="s-1" reloadKey={0} />);
    expect(api.readSession).not.toHaveBeenCalled();
  });
});
