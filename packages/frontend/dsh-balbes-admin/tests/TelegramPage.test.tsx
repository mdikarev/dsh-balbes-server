import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import TelegramPage from "../src/pages/TelegramPage";
import { ApiError, type AdminApi } from "../src/api/client";
import type { TelegramSaveRequest, TelegramSettingsStatus, TelegramState } from "dsh-balbes-contracts";

const NOT_CONFIGURED: TelegramSettingsStatus = { state: "not-configured", tokenConfigured: false, enabled: false };

const CONNECTED: TelegramSettingsStatus = {
  state: "connected",
  tokenConfigured: true,
  enabled: true,
  allowedUserId: 7,
  botUsername: "balbes_bot",
  lastPollAt: "2026-09-10T10:00:00.000Z"
};

const DISABLED: TelegramSettingsStatus = {
  state: "disabled",
  tokenConfigured: true,
  enabled: false,
  allowedUserId: 7
};

const FAILED: TelegramSettingsStatus = {
  state: "error",
  tokenConfigured: true,
  enabled: true,
  allowedUserId: 7,
  error: { code: "not-running", message: "polling is not running" }
};

/** Label the page must show for each wire state. */
const STATE_LABELS: Record<TelegramState, string> = {
  "not-configured": "не настроено",
  disabled: "выключено",
  connected: "подключено",
  error: "ошибка"
};

/**
 * Stateful fake of the telegram admin surface, mirroring the plugin's observable
 * behavior: save applies only the fields present in the request (an absent token
 * keeps the stored one, an absent allowedUserId keeps the stored one — the field
 * is never sent as null, T11-5), disable switches the bot off, clear-token drops
 * the credential and the enabled flag. Every status read reports the current
 * state, so post-action refetches show what the mutation actually did.
 */
function makeApi(initial: TelegramSettingsStatus, overrides: Partial<AdminApi> = {}): AdminApi {
  const state: TelegramSettingsStatus = { ...initial };

  const derive = (): void => {
    const next: TelegramState = !state.tokenConfigured ? "not-configured" : state.enabled ? "connected" : "disabled";
    state.state = next;
    delete state.error; // the fake never reaches the error state, so no stale detail survives
  };

  const telegramStatus = vi.fn(async () => ({ status: { ...state } }));

  const telegramSave = vi.fn(async (req: TelegramSaveRequest) => {
    if (typeof req.token === "string" && req.token !== "") state.tokenConfigured = true;
    if (req.allowedUserId !== undefined) state.allowedUserId = req.allowedUserId;
    if (req.enabled !== undefined) state.enabled = req.enabled;
    derive();
    return { status: { ...state } };
  });

  const telegramTest = vi.fn(async () => ({ username: "balbes_bot" }));

  const telegramDisable = vi.fn(async () => {
    state.enabled = false;
    derive();
    return { status: { ...state } };
  });

  const telegramClearToken = vi.fn(async () => {
    state.tokenConfigured = false;
    state.enabled = false;
    derive();
    return { status: { ...state } };
  });

  return {
    health: vi.fn(),
    login: vi.fn(),
    me: vi.fn(),
    prompt: vi.fn(),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    readWorkspaceDir: vi.fn(),
    listModels: vi.fn(),
    saveModel: vi.fn(),
    deleteModel: vi.fn(),
    setDefaultModel: vi.fn(),
    catalogModels: vi.fn(),
    onUnauthorized: vi.fn(),
    subscribeWorkspaceEvents: vi.fn(() => () => {}),
    telegramStatus,
    telegramSave,
    telegramTest,
    telegramDisable,
    telegramClearToken,
    ...overrides
  } as AdminApi;
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("TelegramPage status card", () => {
  it.each(Object.entries(STATE_LABELS))("renders the %s state badge as «%s»", async (state, label) => {
    render(<TelegramPage api={makeApi({ ...NOT_CONFIGURED, state: state as TelegramState })} />);
    const badge = await screen.findByTestId("telegram-state");
    expect(badge.textContent).toBe(label);
    expect(badge.className).toContain("state-" + state);
  });

  it("shows the bot username, the last successful poll and the stored-token mask", async () => {
    const api = makeApi(CONNECTED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");

    expect(screen.getByTestId("telegram-bot").textContent).toContain("@balbes_bot");
    const poll = screen.getByTestId("telegram-last-poll");
    expect(poll.textContent).toContain("Последний успешный опрос");
    expect(poll.textContent).toContain("2026");
    // token presence is a mask, never the value
    expect(screen.getByTestId("telegram-token-state").textContent).toContain("••••");
    expect((screen.getByTestId("telegram-token-input") as HTMLInputElement).placeholder).toContain("••••");
    expect(vi.mocked(api.telegramStatus)).toHaveBeenCalledTimes(1);
  });

  it("renders «—» for the missing last poll and the bot name, and the safe error message in the error state", async () => {
    render(<TelegramPage api={makeApi({ state: "error", tokenConfigured: true, enabled: false })} />);
    await screen.findByTestId("telegram-state");
    expect(screen.getByTestId("telegram-last-poll").textContent).toBe("Последний успешный опрос: —");
    expect(screen.getByTestId("telegram-bot").textContent).toBe("Бот: —");
    expect(screen.queryByTestId("telegram-status-error")).toBeNull();
  });

  it("surfaces status.error.message for the error state", async () => {
    render(<TelegramPage api={makeApi(FAILED)} />);
    const message = await screen.findByTestId("telegram-status-error");
    expect(message.textContent).toContain("polling is not running");
    // the card message describes a state; it is not an alert region, so only the
    // actionable banner below ever announces itself to assistive tech
    expect(message.getAttribute("role")).toBeNull();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("keeps exactly one role=alert region when the error state and an action failure coexist", async () => {
    const api = makeApi(FAILED);
    vi.mocked(api.telegramTest).mockRejectedValueOnce(new Error("getMe failed"));
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    expect(screen.getByTestId("telegram-status-error").textContent).toContain("polling is not running");

    fireEvent.click(screen.getByTestId("telegram-test"));
    const banner = await screen.findByTestId("telegram-error");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    // both messages stay visible: the persistent card detail and the banner
    expect(screen.getByTestId("telegram-status-error").textContent).toContain("polling is not running");
    expect(banner.textContent).toContain("getMe failed");
  });

  it("shows the load error with a retry that recovers", async () => {
    const api = makeApi(NOT_CONFIGURED);
    vi.mocked(api.telegramStatus).mockRejectedValueOnce(new Error("status down"));
    render(<TelegramPage api={api} />);
    const error = await screen.findByTestId("telegram-load-error");
    expect(error.textContent).toContain("status down");
    fireEvent.click(screen.getByTestId("telegram-retry"));
    expect(await screen.findByTestId("telegram-state")).toBeTruthy();
    expect(vi.mocked(api.telegramStatus)).toHaveBeenCalledTimes(2);
  });
});

describe("TelegramPage save", () => {
  it("sends {token, allowedUserId, enabled} and refetches the status", async () => {
    const api = makeApi(DISABLED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");

    fireEvent.change(screen.getByTestId("telegram-token-input"), { target: { value: "123:abc" } });
    fireEvent.change(screen.getByTestId("telegram-user-id-input"), { target: { value: "42" } });
    fireEvent.click(screen.getByTestId("telegram-enabled-input"));
    fireEvent.click(screen.getByTestId("telegram-save"));

    await waitFor(() =>
      expect(vi.mocked(api.telegramSave)).toHaveBeenCalledWith({ token: "123:abc", allowedUserId: 42, enabled: true })
    );
    // T11-7: the status is re-read instead of trusting the response body
    await waitFor(() => expect(vi.mocked(api.telegramStatus)).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("telegram-state").textContent).toBe("подключено"));
    // the typed token never stays in the DOM after a successful save
    expect((screen.getByTestId("telegram-token-input") as HTMLInputElement).value).toBe("");
  });

  it("omits an empty token and an empty User ID (keep current, never null — T11-5)", async () => {
    const api = makeApi(CONNECTED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");

    // the stored user id stays in the placeholder only; nothing is typed
    expect((screen.getByTestId("telegram-user-id-input") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("telegram-user-id-input") as HTMLInputElement).placeholder).toBe("7");

    fireEvent.click(screen.getByTestId("telegram-save"));
    await waitFor(() => expect(vi.mocked(api.telegramSave)).toHaveBeenCalledTimes(1));
    const req = vi.mocked(api.telegramSave).mock.calls[0]?.[0] as TelegramSaveRequest;
    expect(req).toEqual({ enabled: true });
    expect("token" in req).toBe(false);
    expect("allowedUserId" in req).toBe(false);
  });

  it("blocks enabling the bot without a User ID", async () => {
    const api = makeApi(NOT_CONFIGURED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");

    const save = screen.getByTestId("telegram-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    fireEvent.click(screen.getByTestId("telegram-enabled-input"));
    expect((screen.getByTestId("telegram-save") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("telegram-validation-hint").textContent).toContain("User ID");
    fireEvent.click(screen.getByTestId("telegram-save"));
    expect(vi.mocked(api.telegramSave)).not.toHaveBeenCalled();

    // a positive id unblocks the save
    fireEvent.change(screen.getByTestId("telegram-user-id-input"), { target: { value: "7" } });
    await waitFor(() => expect((screen.getByTestId("telegram-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("telegram-save"));
    await waitFor(() => expect(vi.mocked(api.telegramSave)).toHaveBeenCalledWith({ allowedUserId: 7, enabled: true }));
  });

  it("blocks a non-positive User ID instead of sending it", async () => {
    const api = makeApi(NOT_CONFIGURED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.change(screen.getByTestId("telegram-user-id-input"), { target: { value: "0" } });
    expect((screen.getByTestId("telegram-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("telegram-save"));
    expect(vi.mocked(api.telegramSave)).not.toHaveBeenCalled();
  });

  it("refetches the status after a save whose response body is already stale (T11-7)", async () => {
    const api = makeApi(CONNECTED);
    // the save answers with a state the background transition has not reached yet
    vi.mocked(api.telegramSave).mockResolvedValueOnce({ status: { ...DISABLED } });
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    expect(screen.getByTestId("telegram-state").textContent).toBe("подключено");

    fireEvent.click(screen.getByTestId("telegram-save"));
    await waitFor(() => expect(vi.mocked(api.telegramStatus)).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("telegram-state").textContent).toBe("подключено");
  });

  it("shows a save failure in the role=alert banner and keeps the form", async () => {
    const api = makeApi(NOT_CONFIGURED);
    vi.mocked(api.telegramSave).mockRejectedValueOnce(
      new ApiError(400, "invalid-config", "store a bot token and a positive User ID before enabling the bot")
    );
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.change(screen.getByTestId("telegram-token-input"), { target: { value: "123:abc" } });
    fireEvent.click(screen.getByTestId("telegram-save"));

    const banner = await screen.findByTestId("telegram-error");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("positive User ID");
    expect((screen.getByTestId("telegram-token-input") as HTMLInputElement).value).toBe("123:abc");
    expect(vi.mocked(api.telegramStatus)).toHaveBeenCalledTimes(1);
  });

  it("disables every action button while an operation is in flight", async () => {
    let release: (value: { status: TelegramSettingsStatus }) => void = () => {};
    const api = makeApi(CONNECTED);
    vi.mocked(api.telegramSave).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; })
    );
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.click(screen.getByTestId("telegram-save"));

    await waitFor(() => expect((screen.getByTestId("telegram-save") as HTMLButtonElement).disabled).toBe(true));
    for (const id of ["telegram-test", "telegram-disable", "telegram-clear-token"]) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    release({ status: { ...CONNECTED } });
    await waitFor(() => expect((screen.getByTestId("telegram-save") as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("TelegramPage test connection", () => {
  it("shows the username reported by «Проверить подключение»", async () => {
    const api = makeApi(CONNECTED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.click(screen.getByTestId("telegram-test"));

    const result = await screen.findByTestId("telegram-test-result");
    expect(result.textContent).toContain("@balbes_bot");
    expect(vi.mocked(api.telegramTest)).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("telegram-error")).toBeNull();
  });

  it("shows a no-username result without inventing a handle", async () => {
    const api = makeApi(CONNECTED, { telegramTest: vi.fn(async () => ({ username: "" })) });
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.click(screen.getByTestId("telegram-test"));
    const result = await screen.findByTestId("telegram-test-result");
    expect(result.textContent).not.toContain("@");
  });

  it("shows a failed check as an alert banner", async () => {
    const api = makeApi(CONNECTED);
    vi.mocked(api.telegramTest).mockRejectedValueOnce(
      new ApiError(502, "telegram-error", "getMe failed: Bad Gateway")
    );
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.click(screen.getByTestId("telegram-test"));

    const banner = await screen.findByTestId("telegram-error");
    expect(banner.textContent).toContain("Bad Gateway");
    expect(screen.queryByTestId("telegram-test-result")).toBeNull();
  });

  it("clears a previously shown check result when a later operation runs", async () => {
    const api = makeApi(CONNECTED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.click(screen.getByTestId("telegram-test"));
    expect((await screen.findByTestId("telegram-test-result")).textContent).toContain("@balbes_bot");

    fireEvent.click(screen.getByTestId("telegram-disable"));
    await waitFor(() => expect(screen.getByTestId("telegram-state").textContent).toBe("выключено"));
    // the success line described the state that the operation just invalidated
    expect(screen.queryByTestId("telegram-test-result")).toBeNull();
  });

  it("clears a previously shown check result when the token is removed", async () => {
    const api = makeApi(CONNECTED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.click(screen.getByTestId("telegram-test"));
    expect((await screen.findByTestId("telegram-test-result")).textContent).toContain("@balbes_bot");

    fireEvent.click(screen.getByTestId("telegram-clear-token"));
    fireEvent.click(screen.getByTestId("telegram-clear-submit"));
    await waitFor(() => expect(screen.getByTestId("telegram-state").textContent).toBe("не настроено"));
    expect(screen.queryByTestId("telegram-test-result")).toBeNull();
  });
});

describe("TelegramPage disable and clear token", () => {
  it("«Отключить» calls telegramDisable and refreshes the card", async () => {
    const api = makeApi(CONNECTED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.click(screen.getByTestId("telegram-disable"));

    await waitFor(() => expect(vi.mocked(api.telegramDisable)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("telegram-state").textContent).toBe("выключено"));
    expect(vi.mocked(api.telegramStatus)).toHaveBeenCalledTimes(2);
    expect((screen.getByTestId("telegram-enabled-input") as HTMLInputElement).checked).toBe(false);
  });

  it("«Удалить токен» asks for confirmation through the Modal before calling clearToken", async () => {
    const api = makeApi(CONNECTED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.click(screen.getByTestId("telegram-clear-token"));

    const confirm = screen.getByTestId("telegram-clear-confirm");
    expect(within(confirm).getByText(/Удалить токен бота/)).toBeTruthy();
    expect(vi.mocked(api.telegramClearToken)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("telegram-clear-submit"));
    await waitFor(() => expect(vi.mocked(api.telegramClearToken)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("telegram-clear-confirm")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("telegram-state").textContent).toBe("не настроено"));
    expect(screen.getByTestId("telegram-token-state").textContent).toContain("не задан");
    expect(vi.mocked(api.telegramStatus)).toHaveBeenCalledTimes(2);
  });

  it("cancelling the confirmation keeps the token", async () => {
    const api = makeApi(CONNECTED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.click(screen.getByTestId("telegram-clear-token"));
    fireEvent.click(screen.getByTestId("telegram-clear-cancel"));

    expect(screen.queryByTestId("telegram-clear-confirm")).toBeNull();
    expect(vi.mocked(api.telegramClearToken)).not.toHaveBeenCalled();
    expect(screen.getByTestId("telegram-state").textContent).toBe("подключено");
  });

  it("a failed clear keeps the modal open and reports the error there", async () => {
    const api = makeApi(CONNECTED);
    vi.mocked(api.telegramClearToken).mockRejectedValueOnce(new Error("vault unreachable"));
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    fireEvent.click(screen.getByTestId("telegram-clear-token"));
    fireEvent.click(screen.getByTestId("telegram-clear-submit"));

    const banner = await screen.findByTestId("telegram-error");
    expect(banner.textContent).toContain("vault unreachable");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("telegram-clear-confirm")).toBeTruthy();
    // nothing was refreshed optimistically and the token is still stored
    expect(vi.mocked(api.telegramStatus)).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("telegram-token-state").textContent).toContain("••••");
  });
});

describe("TelegramPage token secrecy", () => {
  it("never renders the token value anywhere", async () => {
    const api = makeApi(DISABLED);
    render(<TelegramPage api={api} />);
    await screen.findByTestId("telegram-state");
    const secret = "123456:SUPER-SECRET-TOKEN";
    const input = screen.getByTestId("telegram-token-input") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: secret } });

    fireEvent.click(screen.getByTestId("telegram-save"));
    await waitFor(() => expect(vi.mocked(api.telegramSave)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByTestId("telegram-token-input") as HTMLInputElement).value).toBe(""));
    expect(document.body.textContent).not.toContain("SUPER-SECRET-TOKEN");
    expect(screen.getByTestId("telegram-page").innerHTML).not.toContain("SUPER-SECRET-TOKEN");
  });
});
