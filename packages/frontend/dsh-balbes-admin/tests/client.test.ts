import { describe, expect, it, vi, beforeEach } from "vitest";
import { createApiClient, ApiError, TOKEN_KEY } from "../src/api/client";
import type { ModelsSaveRequest, TelegramSaveRequest } from "dsh-balbes-contracts";

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body
  });
}

describe("api client", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", mockFetchOnce(200, { ok: true, version: "test" }));
  });

  it("login stores the token", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(200, { token: "jwt-1", expiresAt: new Date().toISOString() }));
    const api = createApiClient();
    await api.login("admin", "pw");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("jwt-1");
  });

  it("prompt sends the Authorization header", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const fetchMock = mockFetchOnce(200, { text: "ok" });
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    await api.prompt("hello");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: "Bearer tok-1" });
  });

  it("401 clears the token and calls onUnauthorized", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-expired");
    vi.stubGlobal("fetch", mockFetchOnce(401, { error: { code: "unauthorized", message: "expired" } }));
    const api = createApiClient();
    const spy = vi.fn();
    api.onUnauthorized(spy);
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it("listWorkspaces POSTs to /api/workspaces/list with the token", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const body = { home: { path: "/h/agent" }, projects: [{ name: "a", path: "/h/projects/a", createdAt: "2026-09-06T00:00:00.000Z" }] };
    const fetchMock = mockFetchOnce(200, body);
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    const res = await api.listWorkspaces();
    expect(res.projects[0]?.name).toBe("a");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/workspaces/list");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok-1" });
  });

  it("createWorkspace and deleteWorkspace send the name", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const created = { project: { name: "a", path: "/h/projects/a", createdAt: "2026-09-06T00:00:00.000Z" } };
    vi.stubGlobal("fetch", mockFetchOnce(200, created));
    const api = createApiClient();
    const res = await api.createWorkspace("a");
    expect(res.project.name).toBe("a");

    vi.stubGlobal("fetch", mockFetchOnce(200, {}));
    await api.deleteWorkspace("a");
  });

  it("readWorkspaceDir posts the tree request", async () => {
    const seen: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ path: String(_url), body });
      return { ok: true, status: 200, json: async () => ({ entries: [{ name: "src", kind: "dir" }] }) };
    }));
    localStorage.setItem("balbes.authToken", "t");
    const api = createApiClient();
    const res = await api.readWorkspaceDir("project", "alpha", "src");
    expect(res.entries).toEqual([{ name: "src", kind: "dir" }]);
    expect(seen[0]?.path).toBe("/api/workspaces/tree");
    expect(seen[0]?.body).toEqual({ scope: "project", name: "alpha", path: "src" });
    vi.unstubAllGlobals();
  });

  it("subscribeWorkspaceEvents parses streamed events and unsubscribes cleanly", async () => {
    const chunks = [
      'data: {"kind":"fs","scope":"project","name":"alpha","path":"src"}\n\n',
      ": ping\n\n",
      'data: {"kind":"list"}\n\n'
    ];
    const reader = {
      getReader: () => {
        let i = 0;
        return {
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: new TextEncoder().encode(chunks[i++]) };
          },
          cancel: async () => undefined,
          releaseLock: () => undefined
        };
      }
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body: reader })));
    localStorage.setItem("balbes.authToken", "t");
    const api = createApiClient();
    const got: unknown[] = [];
    const unsub = api.subscribeWorkspaceEvents((e) => got.push(e));
    await vi.waitFor(() => expect(got.length).toBe(2));
    expect(got[0]).toEqual({ kind: "fs", scope: "project", name: "alpha", path: "src" });
    expect(got[1]).toEqual({ kind: "list" });
    unsub();
    vi.unstubAllGlobals();
  });

  it("retries an events stream on 503 while a listener remains", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }));
      vi.stubGlobal("fetch", fetchMock);
      const api = createApiClient();
      const unsub = api.subscribeWorkspaceEvents(() => {});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0); // let the first failure reach the reconnect scheduler
      await vi.advanceTimersByTimeAsync(1500); // EVENT_RETRY_MS: a second fetch attempt happens
      expect(fetchMock).toHaveBeenCalledTimes(2);
      unsub();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not reconnect an events stream on 404 while a listener remains", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found" }));
      vi.stubGlobal("fetch", fetchMock);
      const api = createApiClient();
      const unsub = api.subscribeWorkspaceEvents(() => {});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000); // well past EVENT_RETRY_MS: still no retry
      expect(fetchMock).toHaveBeenCalledTimes(1);
      unsub();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("a throwing listener does not abort the read loop for other listeners", async () => {
    const chunks = [
      'data: {"kind":"list"}\n\n',
      'data: {"kind":"fs","scope":"project","name":"alpha","path":"src"}\n\n'
    ];
    const reader = {
      getReader: () => {
        let i = 0;
        return {
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: new TextEncoder().encode(chunks[i++]) };
          },
          cancel: async () => undefined,
          releaseLock: () => undefined
        };
      }
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body: reader })));
    localStorage.setItem("balbes.authToken", "t");
    const api = createApiClient();
    const boom = vi.fn(() => {
      throw new Error("listener boom");
    });
    const got: unknown[] = [];
    api.subscribeWorkspaceEvents(boom);
    const unsub = api.subscribeWorkspaceEvents((e) => got.push(e));
    await vi.waitFor(() => expect(got.length).toBe(2));
    expect(boom).toHaveBeenCalledTimes(2);
    unsub();
    vi.unstubAllGlobals();
  });

  it("listModels POSTs to /api/models/list", async () => {
    localStorage.setItem("balbes.authToken", "tok-1");
    const body = { connections: [{ routeId: "deepseek-official", kind: "deepseek", displayName: "D", hasKey: true, models: ["deepseek-v4-flash"], isDefault: true }], default: { provider: "deepseek-official", model: "deepseek-v4-flash" } };
    const fetchMock = mockFetchOnce(200, body);
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    const res = await api.listModels();
    expect(res.connections[0]?.routeId).toBe("deepseek-official");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/models/list");
    expect(init.method).toBe("POST");
  });

  it("catalogModels POSTs {provider} to /api/models/catalog with auth", async () => {
    localStorage.setItem("balbes.authToken", "tok-1");
    const body = { provider: "openai", models: [{ id: "gpt-4o-mini", name: "GPT-4o mini" }, { id: "gpt-4o" }] };
    const fetchMock = mockFetchOnce(200, body);
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    const res = await api.catalogModels("openai");
    expect(res.models[0]?.id).toBe("gpt-4o-mini");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/models/catalog");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok-1" });
    expect(JSON.parse(String(init.body))).toEqual({ provider: "openai" });
  });

  it("saveModel/deleteModel/setDefaultModel post the right bodies", async () => {
    localStorage.setItem("balbes.authToken", "tok-1");
    const seen: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ path: String(_url), body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    const api = createApiClient();
    const req: ModelsSaveRequest = { kind: "custom", displayName: "GW", baseURL: "https://g/v1", key: "sk", models: ["m"] };
    await api.saveModel(req);
    await api.deleteModel("gw");
    await api.setDefaultModel("gw", "m");
    expect(seen).toEqual([
      { path: "/api/models/save", body: req },
      { path: "/api/models/delete", body: { routeId: "gw" } },
      { path: "/api/models/default", body: { provider: "gw", model: "m" } }
    ]);
  });

  it("telegramStatus POSTs to /api/telegram/status with the Bearer header", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const body = {
      status: {
        state: "connected",
        tokenConfigured: true,
        enabled: true,
        allowedUserId: 7,
        botUsername: "balbes_bot",
        lastPollAt: "2026-09-10T10:00:00.000Z"
      }
    };
    const fetchMock = mockFetchOnce(200, body);
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    const res = await api.telegramStatus();
    expect(res.status.state).toBe("connected");
    expect(res.status.botUsername).toBe("balbes_bot");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/telegram/status");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok-1" });
  });

  it("telegramSave POSTs the request body to /api/telegram/save", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const fetchMock = mockFetchOnce(200, { status: { state: "disabled", tokenConfigured: true, enabled: false } });
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    const req: TelegramSaveRequest = { token: "123:abc", allowedUserId: 7, enabled: false };
    const res = await api.telegramSave(req);
    expect(res.status.tokenConfigured).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/telegram/save");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok-1" });
    expect(JSON.parse(String(init.body))).toEqual(req);
  });

  it("telegramTest / telegramDisable / telegramClearToken hit their routes", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const seen: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ path: String(_url), body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 200, json: async () => ({ username: "balbes_bot", status: { state: "not-configured" } }) };
    }));
    const api = createApiClient();
    const tested = await api.telegramTest();
    expect(tested.username).toBe("balbes_bot");
    const disabled = await api.telegramDisable();
    expect(disabled.status.state).toBe("not-configured");
    await api.telegramClearToken();
    expect(seen).toEqual([
      { path: "/api/telegram/test", body: {} },
      { path: "/api/telegram/disable", body: {} },
      { path: "/api/telegram/clear-token", body: {} }
    ]);
  });
});
