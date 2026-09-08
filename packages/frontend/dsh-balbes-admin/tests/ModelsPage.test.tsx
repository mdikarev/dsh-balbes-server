import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import ModelsPage from "../src/pages/ModelsPage";
import { ApiError, type AdminApi } from "../src/api/client";
import type { ModelConnection, ModelsListResponse, ModelsSaveRequest } from "dsh-balbes-contracts";

const DEEPSEEK: ModelConnection = {
  routeId: "deepseek-official",
  kind: "deepseek",
  displayName: "DeepSeek (официальный)",
  hasKey: false,
  models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  isDefault: true
};

const GATEWAY: ModelConnection = {
  routeId: "gw",
  kind: "custom",
  displayName: "Gateway",
  baseURL: "https://gw.example/v1",
  hasKey: true,
  models: ["gw-1"],
  isDefault: false
};

const DEEPSEEK_DEFAULT = { provider: "deepseek-official", model: "deepseek-v4-flash" };

/** Mirrors the server plugin's routeIdFromName (displayName -> lower-hyphen). */
function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Stateful fake registry, mirroring the models plugin's observable behavior:
 * saveModel upserts a connection (custom: routeId taken from the request when
 * editing, else generated from displayName; key semantics — absent = keep,
 * non-empty string = set, null = clear), deleteModel removes it, and
 * setDefaultModel switches the global selection; every listModels call reports
 * the current registry so post-action refreshes show new state. Tests may seed
 * extra connections and a non-default selection.
 */
function makeApi(
  overrides: Partial<AdminApi> = {},
  seed: ModelConnection[] = [],
  initialDefault: { provider: string; model: string } = DEEPSEEK_DEFAULT
): AdminApi {
  const connections: ModelConnection[] = [DEEPSEEK, ...seed].map((c) => ({ ...c }));
  let def = { ...initialDefault };

  const listModels = vi.fn(async (): Promise<ModelsListResponse> => ({
    connections: connections.map((c) => ({ ...c, isDefault: c.routeId === def.provider })),
    default: { ...def }
  }));

  const saveModel = vi.fn(async (req: ModelsSaveRequest) => {
    if (req.kind === "deepseek") {
      const ds = connections.find((c) => c.routeId === DEEPSEEK.routeId);
      if (ds !== undefined) ds.hasKey = typeof req.key === "string" && req.key.trim() !== "";
      return { connection: { ...(ds ?? DEEPSEEK) } };
    }
    const name = (req.displayName ?? "").trim();
    const routeId = req.routeId ?? slug(name);
    const existing = connections.find((c) => c.routeId === routeId);
    const next: ModelConnection = {
      routeId,
      kind: "custom",
      displayName: name !== "" ? name : existing?.displayName ?? routeId,
      hasKey:
        req.key === null
          ? false
          : typeof req.key === "string" && req.key.trim() !== ""
            ? true
            : existing?.hasKey ?? false,
      models: req.models !== undefined && req.models.length > 0 ? [...req.models] : existing?.models ?? [],
      isDefault: def.provider === routeId
    };
    const base = req.baseURL !== undefined && req.baseURL !== "" ? req.baseURL : existing?.baseURL;
    if (base !== undefined) next.baseURL = base;
    if (existing === undefined) connections.push(next);
    else Object.assign(existing, next);
    return { connection: { ...next } };
  });

  const deleteModel = vi.fn(async (routeId: string) => {
    const idx = connections.findIndex((c) => c.routeId === routeId);
    if (idx !== -1) connections.splice(idx, 1);
    return {};
  });

  const setDefaultModel = vi.fn(async (provider: string, model: string) => {
    def = { provider, model };
    return { default: { provider, model } };
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
    onUnauthorized: vi.fn(),
    subscribeWorkspaceEvents: vi.fn(() => () => {}),
    listModels,
    saveModel,
    deleteModel,
    setDefaultModel,
    ...overrides
  } as AdminApi;
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("ModelsPage deepseek card and empty state", () => {
  it("pins the deepseek card (change-key only, no delete) and shows the empty hint without custom connections", async () => {
    render(<ModelsPage api={makeApi()} />);
    const card = await screen.findByTestId("model-connection:deepseek-official");
    expect(within(card).getByText("DeepSeek (официальный)")).toBeTruthy();
    expect(within(card).getByText("не задан")).toBeTruthy(); // no key stored yet
    expect(within(card).getByRole("button", { name: "Изменить ключ" })).toBeTruthy();
    // the pinned connection offers no delete and no ⋮ menu at all
    expect(within(card).queryByText("Удалить")).toBeNull();
    expect(screen.queryByTestId("model-menu-deepseek-official")).toBeNull();
    // no custom connections -> empty state hint
    expect(screen.getByText("Добавьте провайдера с ключом")).toBeTruthy();
  });

  it("lists the deepseek catalog models in the default select with the current default selected", async () => {
    render(<ModelsPage api={makeApi()} />);
    await screen.findByTestId("model-connection:deepseek-official");
    const select = screen.getByTestId("default-model-select") as HTMLSelectElement;
    expect(screen.getByRole("option", { name: "deepseek-v4-flash" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "deepseek-v4-pro" })).toBeTruthy();
    expect(select.value).toBe("deepseek-official|deepseek-v4-flash");
  });
});

describe("ModelsPage add/edit modal", () => {
  it("adds a custom connection: the modal saves the right request and the card appears", async () => {
    const api = makeApi();
    render(<ModelsPage api={api} />);
    fireEvent.click(await screen.findByTestId("models-add"));
    expect(screen.getByText("Добавить подключение")).toBeTruthy();

    // submit is gated on displayName/baseURL/models
    const submit = screen.getByTestId("model-form-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("model-name-input"), { target: { value: "My Gateway" } });
    fireEvent.change(screen.getByTestId("model-url-input"), { target: { value: "https://gw.example/v1" } });
    fireEvent.change(screen.getByTestId("key-input"), { target: { value: "sk-abc" } });
    fireEvent.change(screen.getByTestId("model-models-input"), { target: { value: "gw-1" } });
    fireEvent.click(screen.getByTestId("model-models-add"));
    expect(within(screen.getByTestId("model-form")).getByText("gw-1")).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId("model-form-submit") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(submit);
    await waitFor(() =>
      expect(vi.mocked(api.saveModel)).toHaveBeenCalledWith({
        kind: "custom",
        displayName: "My Gateway",
        baseURL: "https://gw.example/v1",
        key: "sk-abc",
        models: ["gw-1"]
      })
    );
    // the post-save refresh renders the new connection card; empty hint is gone
    expect(await screen.findByTestId("model-connection:my-gateway")).toBeTruthy();
    expect(screen.queryByText("Добавьте провайдера с ключом")).toBeNull();
    // its model is now offered by the default select
    expect(screen.getByRole("option", { name: "gw-1" })).toBeTruthy();
    expect(vi.mocked(api.listModels)).toHaveBeenCalledTimes(2);
  });

  it("shows a server save error in connection-errors and keeps the modal open for a retry", async () => {
    const api = makeApi();
    vi.mocked(api.saveModel).mockRejectedValueOnce(new Error("route already exists"));
    render(<ModelsPage api={api} />);
    fireEvent.click(await screen.findByTestId("models-add"));
    fireEvent.change(screen.getByTestId("model-name-input"), { target: { value: "My Gateway" } });
    fireEvent.change(screen.getByTestId("model-url-input"), { target: { value: "https://gw.example/v1" } });
    fireEvent.change(screen.getByTestId("model-models-input"), { target: { value: "gw-1" } });
    fireEvent.click(screen.getByTestId("model-models-add"));
    fireEvent.click(screen.getByTestId("model-form-submit"));

    const errors = await screen.findByTestId("connection-errors");
    expect(errors.textContent).toContain("route already exists");
    // modal stays open, no card was added, busy reset lets the user submit again
    expect(screen.getByText("Добавить подключение")).toBeTruthy();
    expect(screen.queryByTestId("model-connection:my-gateway")).toBeNull();
    await waitFor(() => expect((screen.getByTestId("model-form-submit") as HTMLButtonElement).disabled).toBe(false));

    // a clean retry succeeds: error clears with the modal, the card appears
    fireEvent.click(screen.getByTestId("model-form-submit"));
    expect(await screen.findByTestId("model-connection:my-gateway")).toBeTruthy();
    expect(screen.queryByTestId("connection-errors")).toBeNull();
    expect(vi.mocked(api.saveModel)).toHaveBeenCalledTimes(2);
  });

  it("editing a custom connection prefills the form; an empty key field keeps the stored key", async () => {
    const api = makeApi({}, [GATEWAY]);
    render(<ModelsPage api={api} />);
    await screen.findByTestId("model-connection:gw");
    fireEvent.click(screen.getByTestId("model-menu-gw"));
    fireEvent.click(screen.getByTestId("model-menu-edit-gw"));

    expect(screen.getByText("Изменить подключение")).toBeTruthy();
    expect((screen.getByTestId("model-name-input") as HTMLInputElement).value).toBe("Gateway");
    expect((screen.getByTestId("model-url-input") as HTMLInputElement).value).toBe("https://gw.example/v1");
    expect((screen.getByTestId("key-input") as HTMLInputElement).value).toBe("");
    // pre-filled model chips
    expect(within(screen.getByTestId("model-form")).getByText("gw-1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("model-form-submit"));
    await waitFor(() =>
      expect(vi.mocked(api.saveModel)).toHaveBeenCalledWith({
        routeId: "gw",
        kind: "custom",
        displayName: "Gateway",
        baseURL: "https://gw.example/v1",
        models: ["gw-1"]
      })
    );
    // key untouched: the card still reports a masked stored key
    await waitFor(() => expect(screen.queryByTestId("model-form-submit")).toBeNull());
    expect(within(screen.getByTestId("model-connection:gw")).getByText("••••")).toBeTruthy();
  });

  it("explicitly clearing the stored key sends key: null and the card reports the key as unset", async () => {
    const api = makeApi({}, [GATEWAY]);
    render(<ModelsPage api={api} />);
    await screen.findByTestId("model-connection:gw");
    fireEvent.click(screen.getByTestId("model-menu-gw"));
    fireEvent.click(screen.getByTestId("model-menu-edit-gw"));
    fireEvent.click(screen.getByTestId("model-clear-key"));

    fireEvent.click(screen.getByTestId("model-form-submit"));
    await waitFor(() =>
      expect(vi.mocked(api.saveModel)).toHaveBeenCalledWith({
        routeId: "gw",
        kind: "custom",
        displayName: "Gateway",
        baseURL: "https://gw.example/v1",
        models: ["gw-1"],
        key: null
      })
    );
    await waitFor(() => expect(screen.queryByTestId("model-form-submit")).toBeNull());
    expect(within(screen.getByTestId("model-connection:gw")).getByText("не задан")).toBeTruthy();
  });

  it("changes the deepseek key through «Изменить ключ»: only the key is saved", async () => {
    const api = makeApi();
    render(<ModelsPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Изменить ключ" }));
    const keyInput = screen.getByTestId("key-input");
    fireEvent.change(keyInput, { target: { value: "sk-new" } });
    fireEvent.click(screen.getByTestId("model-form-submit"));
    await waitFor(() => expect(vi.mocked(api.saveModel)).toHaveBeenCalledWith({ kind: "deepseek", key: "sk-new" }));
    // modal closed after the post-save refresh; the card now masks a stored key
    await waitFor(() => expect(screen.queryByTestId("model-form-submit")).toBeNull());
    expect(within(screen.getByTestId("model-connection:deepseek-official")).getByText("••••")).toBeTruthy();
    expect(vi.mocked(api.listModels)).toHaveBeenCalledTimes(2);
  });
});

describe("ModelsPage default model select", () => {
  it("choosing a custom model calls setDefaultModel and updates the select", async () => {
    const api = makeApi({}, [GATEWAY]);
    render(<ModelsPage api={api} />);
    await screen.findByTestId("model-connection:gw");
    const select = screen.getByTestId("default-model-select") as HTMLSelectElement;
    expect(select.value).toBe("deepseek-official|deepseek-v4-flash");

    fireEvent.change(select, { target: { value: "gw|gw-1" } });
    await waitFor(() => expect(vi.mocked(api.setDefaultModel)).toHaveBeenCalledWith("gw", "gw-1"));
    // refreshed list carries the new default into the select
    await waitFor(() => expect((screen.getByTestId("default-model-select") as HTMLSelectElement).value).toBe("gw|gw-1"));
    expect(vi.mocked(api.listModels)).toHaveBeenCalledTimes(2);
  });

  it("keeps the selection and surfaces the error when setDefaultModel fails", async () => {
    const api = makeApi();
    vi.mocked(api.setDefaultModel).mockRejectedValueOnce(new Error("no such model"));
    render(<ModelsPage api={api} />);
    await screen.findByTestId("model-connection:deepseek-official");
    const select = screen.getByTestId("default-model-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "deepseek-official|deepseek-v4-pro" } });
    const banner = await screen.findByTestId("models-action-error");
    expect(banner.textContent).toContain("no such model");
    expect((screen.getByTestId("default-model-select") as HTMLSelectElement).value).toBe("deepseek-official|deepseek-v4-flash");
  });
});

describe("ModelsPage delete flow", () => {
  it("deletes a custom connection through ⋮ → confirmation, and offers no delete on the deepseek card", async () => {
    const api = makeApi({}, [GATEWAY]);
    render(<ModelsPage api={api} />);
    await screen.findByTestId("model-connection:gw");
    const deepseekCard = screen.getByTestId("model-connection:deepseek-official");
    expect(within(deepseekCard).queryByTestId("model-menu-deepseek-official")).toBeNull();
    expect(within(deepseekCard).queryByText("Удалить")).toBeNull();

    fireEvent.click(screen.getByTestId("model-menu-gw"));
    fireEvent.click(screen.getByTestId("model-menu-delete-gw"));
    // confirmation names the connection (display name + route id)
    const confirm = screen.getByTestId("model-delete-confirm");
    expect(within(confirm).getByText("Gateway")).toBeTruthy();
    expect(within(confirm).getByText("gw")).toBeTruthy();
    expect(vi.mocked(api.deleteModel)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("model-delete-gw"));
    await waitFor(() => expect(vi.mocked(api.deleteModel)).toHaveBeenCalledWith("gw"));
    await waitFor(() => expect(screen.queryByTestId("model-connection:gw")).toBeNull());
    expect(screen.queryByTestId("model-delete-confirm")).toBeNull();
    expect(vi.mocked(api.listModels)).toHaveBeenCalledTimes(2);
    // the empty hint is back when the last custom connection is gone
    expect(screen.getByText("Добавьте провайдера с ключом")).toBeTruthy();
  });

  it("cancel in the confirmation keeps the connection", async () => {
    const api = makeApi({}, [GATEWAY]);
    render(<ModelsPage api={api} />);
    await screen.findByTestId("model-connection:gw");
    fireEvent.click(screen.getByTestId("model-menu-gw"));
    fireEvent.click(screen.getByTestId("model-menu-delete-gw"));
    fireEvent.click(screen.getByTestId("model-delete-cancel"));
    expect(vi.mocked(api.deleteModel)).not.toHaveBeenCalled();
    expect(screen.queryByTestId("model-delete-confirm")).toBeNull();
    expect(screen.getByTestId("model-connection:gw")).toBeTruthy();
  });

  it("a failed delete (default in use) keeps the connection and shows the server message in the modal", async () => {
    // gw is the default provider, so the server refuses to delete it (409)
    const api = makeApi({}, [GATEWAY], { provider: "gw", model: "gw-1" });
    vi.mocked(api.deleteModel).mockRejectedValueOnce(
      new ApiError(409, "default-in-use", "change the default model first")
    );
    render(<ModelsPage api={api} />);
    await screen.findByTestId("model-connection:gw");
    fireEvent.click(screen.getByTestId("model-menu-gw"));
    fireEvent.click(screen.getByTestId("model-menu-delete-gw"));
    fireEvent.click(screen.getByTestId("model-delete-gw"));

    const errors = await screen.findByTestId("connection-errors");
    expect(errors.textContent).toContain("change the default model first");
    // no optimistic removal, modal still open, list not refetched
    expect(screen.getByTestId("model-delete-confirm")).toBeTruthy();
    expect(screen.getByTestId("model-connection:gw")).toBeTruthy();
    expect(vi.mocked(api.deleteModel)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.listModels)).toHaveBeenCalledTimes(1);
  });
});

describe("ModelsPage initial load", () => {
  it("shows the load error with a retry that recovers", async () => {
    const api = makeApi();
    vi.mocked(api.listModels).mockRejectedValueOnce(new Error("registry down"));
    render(<ModelsPage api={api} />);
    const error = await screen.findByTestId("models-load-error");
    expect(error.textContent).toContain("registry down");
    fireEvent.click(screen.getByTestId("models-retry"));
    expect(await screen.findByTestId("model-connection:deepseek-official")).toBeTruthy();
    expect(vi.mocked(api.listModels)).toHaveBeenCalledTimes(2);
  });
});
