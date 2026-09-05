import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "../src/App";
import { createApiClient } from "../src/api/client";

function mockFetchSequence(...responses: Array<{ status: number; body: unknown }>) {
  const queue = [...responses];
  return vi.fn().mockImplementation(async () => {
    const next = queue.shift() ?? { status: 404, body: { error: { code: "x", message: "no more" } } };
    return { ok: next.status < 300, status: next.status, statusText: String(next.status), json: async () => next.body };
  });
}

describe("App", () => {
  beforeEach(() => localStorage.clear());

  it("показывает логин без токена и переходит к кнопке после входа", async () => {
    vi.stubGlobal("fetch", mockFetchSequence(
      { status: 401, body: { error: { code: "unauthorized", message: "no" } } },
      { status: 200, body: { token: "t", expiresAt: new Date().toISOString() } },
      { status: 200, body: { login: "balbes-x" } }
    ));
    render(<App api={createApiClient()} />);
    expect(await screen.findByTestId("login-form")).toBeTruthy();
    fireEvent.change(screen.getByTestId("login-input"), { target: { value: "balbes-x" } });
    fireEvent.change(screen.getByTestId("password-input"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("login-submit"));
    expect(await screen.findByTestId("prompt-button")).toBeTruthy();
  });

  it("кнопка отправляет промпт и показывает ответ над ней", async () => {
    vi.stubGlobal("fetch", mockFetchSequence(
      { status: 200, body: { login: "balbes-x" } },
      { status: 200, body: { text: "ok" } }
    ));
    localStorage.setItem("balbes.authToken", "t");
    render(<App api={createApiClient()} />);
    const button = await screen.findByTestId("prompt-button");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("answer").textContent).toBe("ok"));
    const answer = screen.getByTestId("answer");
    // the answer pre must precede the button in DOM order, i.e. be rendered above it
    expect(button.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0);
  });
});
