import { describe, expect, it, beforeEach, vi } from "vitest";
import { apply, name, inject } from "../src/index.js";

interface Seat { path: string; auth: string; handler(req: unknown, res: unknown, body: unknown): Promise<void> | void; }

class FakeSettings {
  sections: Record<string, unknown> = {};
  get(ns: string): unknown { return this.sections[ns]; }
  async update(ns: string, patch: object): Promise<void> {
    const cur = (this.sections[ns] ?? {}) as { providers?: Record<string, unknown> };
    const p = patch as { providers?: Record<string, unknown> };
    this.sections[ns] = { ...cur, providers: { ...(cur.providers ?? {}), ...(p.providers ?? {}) } };
  }
  async replace(ns: string, section: object): Promise<void> { this.sections[ns] = section; }
}
class FakeCredentials {
  refs = new Map<string, string>();
  async describe(ref: string) { return { configured: this.refs.has(ref), writable: true }; }
  async set(ref: string, value: string) { this.refs.set(ref, value); }
  async unset(ref: string) { this.refs.delete(ref); }
}
class FakeDefaultModel {
  current = { provider: "deepseek-official", model: "deepseek-v4-flash" };
  currentSelection() { return this.current; }
  async saveSelection(next: { provider: string; model: string }) { this.current = next; }
}

let seats: Seat[];
let settings: FakeSettings;
let credentials: FakeCredentials;
let agentDefaultModel: FakeDefaultModel;
const http = { post(path: string, auth: string, handler: Seat["handler"]) { seats.push({ path, auth, handler }); } };

const ctx = {
  get(key: string): unknown {
    return key === "balbesHttp" ? http
      : key === "settings" ? settings
      : key === "credentials" ? credentials
      : key === "agentDefaultModel" ? agentDefaultModel
      : undefined;
  },
  logger: { warn(_m: string) {} }
};

async function call(route: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const seat = seats.find((s) => s.path === route);
  if (!seat) throw new Error("no seat " + route);
  const res = { status: 0, payload: "" };
  await seat.handler({}, {
    writeHead(status: number) { res.status = status; },
    end(body?: string) { res.payload = String(body ?? ""); },
    write() { return true; }, on() {}, destroyed: false, writableEnded: false
  }, body);
  return { status: res.status, json: JSON.parse(res.payload) };
}

describe("balbes-models plugin", () => {
  beforeEach(() => {
    seats = [];
    settings = new FakeSettings();
    credentials = new FakeCredentials();
    agentDefaultModel = new FakeDefaultModel();
  });

  it("exposes name/inject/apply contract and registers four bearer routes", () => {
    expect(name).toBe("balbes-models");
    expect(inject).toEqual(["balbesHttp", "settings", "credentials", "agentDefaultModel"]);
    apply(ctx as never, {});
    expect(seats.map((s) => s.path).sort()).toEqual([
      "/api/models/default", "/api/models/delete", "/api/models/list", "/api/models/save"
    ]);
    for (const s of seats) expect(s.auth).toBe("bearer");
  });

  it("list returns the pinned deepseek connection as default without a key", async () => {
    apply(ctx as never, {});
    const { status, json } = await call("/api/models/list", {});
    expect(status).toBe(200);
    const body = json as { connections: Array<{ routeId: string; kind: string; hasKey: boolean; models: string[]; isDefault: boolean }> };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({ routeId: "deepseek-official", kind: "deepseek", hasKey: false, isDefault: true });
    expect(body.connections[0]!.models).toContain("deepseek-v4-flash");
  });

  it("save custom writes the pi-ai route and the key ref", async () => {
    apply(ctx as never, {});
    const saved = await call("/api/models/save", {
      kind: "custom", displayName: "My Gateway", baseURL: "https://gw.example/v1", key: "sk-abc", models: ["m-1", "m-2"]
    });
    expect(saved.status).toBe(200);
    const section = settings.get("llm-pi-ai") as { providers: Record<string, any> };
    const route = section.providers["my-gateway"] as any;
    expect(route).toMatchObject({ displayName: "My Gateway", baseURL: "https://gw.example/v1", apiKeyEnv: "BALBES_MY_GATEWAY_API_KEY" });
    expect(route.models).toEqual([{ id: "m-1" }, { id: "m-2" }]);
    expect(credentials.refs.get("BALBES_MY_GATEWAY_API_KEY")).toBe("sk-abc");
  });

  it("save with a taken route id -> 409 route-exists", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://x", models: ["m"] });
    const dup = await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://y", models: ["m"] });
    expect(dup.status).toBe(409);
  });

  it("deepseek save only edits the official key ref", async () => {
    apply(ctx as never, {});
    const res = await call("/api/models/save", { kind: "deepseek", key: "sk-new" });
    expect(res.status).toBe(200);
    expect(credentials.refs.get("DEEPSEEK_API_KEY")).toBe("sk-new");
  });

  it("custom save with key null unsets the key ref and keeps route config", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://x", key: "k", models: ["m"] });
    const res = await call("/api/models/save", { kind: "custom", routeId: "my-gateway", displayName: "My Gateway", baseURL: "https://x", key: null, models: ["m"] });
    expect(res.status).toBe(200);
    expect(credentials.refs.has("BALBES_MY_GATEWAY_API_KEY")).toBe(false);
    const section = settings.get("llm-pi-ai") as { providers: Record<string, any> };
    expect(section.providers["my-gateway"]).toMatchObject({ displayName: "My Gateway", baseURL: "https://x", apiKeyEnv: "BALBES_MY_GATEWAY_API_KEY", models: [{ id: "m" }] });
    const listed = await call("/api/models/list", {});
    const gw = (listed.json as { connections: Array<{ routeId: string; hasKey: boolean }> }).connections.find((c) => c.routeId === "my-gateway");
    expect(gw?.hasKey).toBe(false);
  });

  it("deepseek save with a null key -> 400 invalid-key", async () => {
    apply(ctx as never, {});
    const res = await call("/api/models/save", { kind: "deepseek", key: null });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("invalid-key");
  });

  it("delete custom removes route + ref; delete deepseek -> 400 reserved", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://x", key: "k", models: ["m"] });
    const gone = await call("/api/models/delete", { routeId: "my-gateway" });
    expect(gone.status).toBe(200);
    expect((settings.get("llm-pi-ai") as { providers: Record<string, unknown> }).providers["my-gateway"]).toBeUndefined();
    expect(credentials.refs.has("BALBES_MY_GATEWAY_API_KEY")).toBe(false);
    const reserved = await call("/api/models/delete", { routeId: "deepseek-official" });
    expect(reserved.status).toBe(400);
    expect((reserved.json as { error: { code: string } }).error.code).toBe("reserved");
  });

  it("default model can be switched to a custom connection model and back", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://x", models: ["m-1"] });
    const setDefault = await call("/api/models/default", { provider: "my-gateway", model: "m-1" });
    expect(setDefault.status).toBe(200);
    expect(agentDefaultModel.current).toEqual({ provider: "my-gateway", model: "m-1" });
    const bad = await call("/api/models/default", { provider: "my-gateway", model: "nope" });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: { code: string } }).error.code).toBe("invalid-model");
  });
});
