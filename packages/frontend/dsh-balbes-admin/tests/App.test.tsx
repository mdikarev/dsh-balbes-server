import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import App from "../src/App";
import { createApiClient } from "../src/api/client";

interface Reply {
  status: number;
  body: unknown;
}

const NOT_FOUND: Reply = { status: 404, body: { error: { code: "x", message: "no more" } } };
const UNAUTHORIZED: Reply = { status: 401, body: { error: { code: "unauthorized", message: "no" } } };
const LOGIN_OK: Reply = { status: 200, body: { token: "t", expiresAt: "2026-09-27T00:00:00.000Z" } };
const ME_OK: Reply = { status: 200, body: { login: "balbes-x" } };
const WORKSPACES_OK: Reply = { status: 200, body: { home: { path: "/h/agent" }, projects: [] } };
/** The workspaces page loads the git status alongside the workspace list. */
const GIT_STATUS_OK: Reply = { status: 200, body: { git: { tokenConfigured: false } } };
/** The live-events stream; the tests never read its body. */
const EVENTS_OK: Reply = { status: 200, body: {} };
const MODELS_OK: Reply = {
  status: 200,
  body: {
    connections: [
      {
        routeId: "deepseek-official",
        kind: "deepseek",
        displayName: "DeepSeek (официальный)",
        hasKey: false,
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        isDefault: true
      }
    ],
    default: { provider: "deepseek-official", model: "deepseek-v4-flash" }
  }
};
const TELEGRAM_OK: Reply = {
  status: 200,
  body: {
    status: {
      state: "connected",
      tokenConfigured: true,
      enabled: true,
      streamAnswers: true,
      allowedUserId: 7,
      botUsername: "balbes_bot",
      lastPollAt: "2026-09-10T10:00:00.000Z"
    }
  }
};
const MEMORY_OK: Reply = { status: 200, body: { records: [] } };

/**
 * URL-routed fetch stub: the shell and the mounted page fire their requests
 * concurrently (a page mount issues several, e.g. the workspace list, the git
 * status and the live-events stream), so routing by URL keeps the stub
 * independent of request ordering.
 */
function stubFetch(routes: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: unknown) => {
    const next = routes[String(url)] ?? NOT_FOUND;
    return { ok: next.status < 300, status: next.status, statusText: String(next.status), json: async () => next.body };
  }));
}

describe("App", () => {
  beforeEach(() => localStorage.clear());

  it("показывает логин без токена и открывает «Проекты» после входа", async () => {
    stubFetch({
      "/api/auth/me": UNAUTHORIZED,
      "/api/auth/login": LOGIN_OK,
      "/api/workspaces/list": WORKSPACES_OK,
      "/api/git/status": GIT_STATUS_OK,
      "/api/workspaces/events": EVENTS_OK
    });
    render(<App api={createApiClient()} />);
    expect(await screen.findByTestId("login-form")).toBeTruthy();
    fireEvent.change(screen.getByTestId("login-input"), { target: { value: "balbes-x" } });
    fireEvent.change(screen.getByTestId("password-input"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("login-submit"));
    // the post-login default page is «Проекты»; the old test-prompt page is gone
    expect(await screen.findByTestId("workspaces-page")).toBeTruthy();
    expect(screen.queryByText("Тестовая страница")).toBeNull();
  });

  it("с валидным токеном открывает «Проекты» по умолчанию", async () => {
    stubFetch({
      "/api/auth/me": ME_OK,
      "/api/workspaces/list": WORKSPACES_OK,
      "/api/git/status": GIT_STATUS_OK,
      "/api/workspaces/events": EVENTS_OK
    });
    localStorage.setItem("balbes.authToken", "t");
    render(<App api={createApiClient()} />);
    expect(await screen.findByTestId("workspaces-page")).toBeTruthy();
    expect(screen.getByText("/h/agent")).toBeTruthy();
    // no nav item, no page and no prompt button for the removed test prompt
    expect(screen.queryByText("Тестовая страница")).toBeNull();
    expect(screen.queryByTestId("prompt-button")).toBeNull();
    // the top bar breadcrumb shows the default page title
    const crumb = screen.getByText("balbes /");
    expect(crumb.querySelector("b")?.textContent).toBe("Проекты");
  });

  it("«Выйти» очищает токен и возвращает форму логина", async () => {
    stubFetch({
      "/api/auth/me": ME_OK,
      "/api/workspaces/list": WORKSPACES_OK,
      "/api/git/status": GIT_STATUS_OK,
      "/api/workspaces/events": EVENTS_OK
    });
    localStorage.setItem("balbes.authToken", "t");
    render(<App api={createApiClient()} />);
    // main view is shown after the initial me() succeeds
    expect(await screen.findByTestId("workspaces-page")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(await screen.findByTestId("login-form")).toBeTruthy();
    expect(localStorage.getItem("balbes.authToken")).toBeNull();
  });

  it("переходит на страницу воркспейсов по клику в сайдбаре", async () => {
    stubFetch({
      "/api/auth/me": ME_OK,
      "/api/workspaces/list": WORKSPACES_OK,
      "/api/git/status": GIT_STATUS_OK,
      "/api/workspaces/events": EVENTS_OK,
      "/api/models/list": MODELS_OK
    });
    localStorage.setItem("balbes.authToken", "t");
    render(<App api={createApiClient()} />);
    expect(await screen.findByTestId("workspaces-page")).toBeTruthy();
    // leave the default page, then come back through the sidebar
    fireEvent.click(await screen.findByRole("button", { name: "Модели" }));
    expect(await screen.findByTestId("models-page")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проекты" }));
    expect(await screen.findByTestId("workspaces-page")).toBeTruthy();
    expect(screen.getByText("/h/agent")).toBeTruthy();
  });

  it("переходит на страницу моделей по клику в сайдбаре", async () => {
    stubFetch({
      "/api/auth/me": ME_OK,
      "/api/workspaces/list": WORKSPACES_OK,
      "/api/git/status": GIT_STATUS_OK,
      "/api/workspaces/events": EVENTS_OK,
      "/api/models/list": MODELS_OK
    });
    localStorage.setItem("balbes.authToken", "t");
    render(<App api={createApiClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Модели" }));
    expect(await screen.findByTestId("models-page")).toBeTruthy();
    expect(await screen.findByTestId("model-connection:deepseek-official")).toBeTruthy();
    // the top bar breadcrumb shows the page title
    const crumb = screen.getByText("balbes /");
    expect(crumb.querySelector("b")?.textContent).toBe("Модели");
  });

  it("переходит на страницу Telegram по клику в сайдбаре", async () => {
    stubFetch({
      "/api/auth/me": ME_OK,
      "/api/workspaces/list": WORKSPACES_OK,
      "/api/git/status": GIT_STATUS_OK,
      "/api/workspaces/events": EVENTS_OK,
      "/api/telegram/status": TELEGRAM_OK
    });
    localStorage.setItem("balbes.authToken", "t");
    render(<App api={createApiClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Telegram" }));
    expect(await screen.findByTestId("telegram-page")).toBeTruthy();
    expect((await screen.findByTestId("telegram-state")).textContent).toBe("подключено");
    expect(screen.getByTestId("telegram-bot").textContent).toContain("@balbes_bot");
    // the top bar breadcrumb shows the page title
    const crumb = screen.getByText("balbes /");
    expect(crumb.querySelector("b")?.textContent).toBe("Telegram");
  });

  it("переходит на страницу памяти по клику в сайдбаре", async () => {
    stubFetch({
      "/api/auth/me": ME_OK,
      "/api/workspaces/list": WORKSPACES_OK,
      "/api/git/status": GIT_STATUS_OK,
      "/api/workspaces/events": EVENTS_OK,
      "/api/memory/list": MEMORY_OK
    });
    localStorage.setItem("balbes.authToken", "t");
    render(<App api={createApiClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Память" }));
    expect(await screen.findByTestId("memory-page")).toBeTruthy();
    expect(await screen.findByTestId("memory-empty")).toBeTruthy();
    const crumb = screen.getByText("balbes /");
    expect(crumb.querySelector("b")?.textContent).toBe("Память");
  });
});
