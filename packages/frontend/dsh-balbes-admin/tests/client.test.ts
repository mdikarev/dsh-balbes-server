import { describe, expect, it, vi, beforeEach } from "vitest";
import { createApiClient, ApiError, TOKEN_KEY } from "../src/api/client";

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
});
