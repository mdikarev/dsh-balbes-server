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

  it("editing a custom connection to drop its default model -> 409 default-in-use, nothing written", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://gw.example/v1", key: "k1", models: ["m-1", "m-2"] });
    await call("/api/models/default", { provider: "my-gateway", model: "m-1" });
    const res = await call("/api/models/save", { kind: "custom", routeId: "my-gateway", displayName: "My Gateway", baseURL: "https://gw.example/v2", key: "k2", models: ["m-2"] });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("default-in-use");
    const section = settings.get("llm-pi-ai") as { providers: Record<string, any> };
    expect(section.providers["my-gateway"]).toMatchObject({ displayName: "My Gateway", baseURL: "https://gw.example/v1", apiKeyEnv: "BALBES_MY_GATEWAY_API_KEY", models: [{ id: "m-1" }, { id: "m-2" }] });
    expect(credentials.refs.get("BALBES_MY_GATEWAY_API_KEY")).toBe("k1");
  });

  it("editing the same connection while keeping its default model -> 200", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://x", key: "k", models: ["m-1"] });
    await call("/api/models/default", { provider: "my-gateway", model: "m-1" });
    const res = await call("/api/models/save", { kind: "custom", routeId: "my-gateway", displayName: "My Gateway", baseURL: "https://y", key: "k2", models: ["m-1", "m-2"] });
    expect(res.status).toBe(200);
    const section = settings.get("llm-pi-ai") as { providers: Record<string, any> };
    expect(section.providers["my-gateway"]).toMatchObject({ displayName: "My Gateway", baseURL: "https://y", apiKeyEnv: "BALBES_MY_GATEWAY_API_KEY", models: [{ id: "m-1" }, { id: "m-2" }] });
    expect((res.json as { connection: unknown }).connection).toBeDefined();
  });

  it("preset save writes the catalog route without api/baseURL, the ref, and lists it as preset", async () => {
    apply(ctx as never, {});
    const saved = await call("/api/models/save", { kind: "preset", provider: "openai", key: "sk-o", models: ["gpt-4o-mini"] });
    expect(saved.status).toBe(200);
    const section = settings.get("llm-pi-ai") as { providers: Record<string, any> };
    const route = section.providers["openai"] as Record<string, unknown>;
    expect(route).toEqual({ displayName: "OpenAI", apiKeyEnv: "BALBES_OPENAI_API_KEY", models: [{ id: "gpt-4o-mini" }] });
    expect(route).not.toHaveProperty("api");
    expect(route).not.toHaveProperty("baseURL");
    expect(credentials.refs.get("BALBES_OPENAI_API_KEY")).toBe("sk-o");
    const listed = await call("/api/models/list", {});
    const conn = (listed.json as { connections: Array<Record<string, unknown>> }).connections.find((c) => c.routeId === "openai");
    expect(conn).toMatchObject({ routeId: "openai", kind: "preset", providerId: "openai", displayName: "OpenAI", hasKey: true, models: ["gpt-4o-mini"] });
    expect(conn?.baseURL).toBeUndefined();
  });

  it("preset save with a baseURL override stores baseURL and still no api field", async () => {
    apply(ctx as never, {});
    const saved = await call("/api/models/save", {
      kind: "preset", provider: "openai", baseURL: "https://custom.example/v1", key: "sk-o", models: ["gpt-4o-mini"]
    });
    expect(saved.status).toBe(200);
    const section = settings.get("llm-pi-ai") as { providers: Record<string, any> };
    const route = section.providers["openai"] as Record<string, unknown>;
    expect(route).toMatchObject({ displayName: "OpenAI", baseURL: "https://custom.example/v1", apiKeyEnv: "BALBES_OPENAI_API_KEY", models: [{ id: "gpt-4o-mini" }] });
    expect(route).not.toHaveProperty("api");
    const listed = await call("/api/models/list", {});
    const conn = (listed.json as { connections: Array<Record<string, unknown>> }).connections.find((c) => c.routeId === "openai");
    expect(conn).toMatchObject({ kind: "preset", providerId: "openai", baseURL: "https://custom.example/v1" });
  });

  it("preset save with an unknown provider -> 400 invalid-provider before any write", async () => {
    apply(ctx as never, {});
    const res = await call("/api/models/save", { kind: "preset", provider: "nope", key: "sk", models: ["m"] });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("invalid-provider");
    expect(settings.get("llm-pi-ai")).toBeUndefined();
    expect(credentials.refs.size).toBe(0);
  });

  it("re-saving the same preset route without routeId -> 409 route-exists; explicit routeId == provider edits", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", { kind: "preset", provider: "openai", key: "sk-o", models: ["gpt-4o-mini"] });
    const dup = await call("/api/models/save", { kind: "preset", provider: "openai", key: "sk-2", models: ["gpt-4o-mini", "gpt-4o"] });
    expect(dup.status).toBe(409);
    expect((dup.json as { error: { code: string } }).error.code).toBe("route-exists");
    const edit = await call("/api/models/save", { kind: "preset", provider: "openai", routeId: "openai", models: ["gpt-4o"] });
    expect(edit.status).toBe(200);
    const section = settings.get("llm-pi-ai") as { providers: Record<string, any> };
    expect(section.providers["openai"]).toMatchObject({ displayName: "OpenAI", apiKeyEnv: "BALBES_OPENAI_API_KEY", models: [{ id: "gpt-4o" }] });
    expect(section.providers["openai"]).not.toHaveProperty("api");
    // an absent key on an edit leaves the stored credential untouched
    expect(credentials.refs.get("BALBES_OPENAI_API_KEY")).toBe("sk-o");
  });

  it("list classifies seeded settings routes: api field -> custom, allowlisted id without api -> preset", async () => {
    apply(ctx as never, {});
    settings.sections["llm-pi-ai"] = {
      providers: {
        opencode: { displayName: "OpenCode", apiKeyEnv: "BALBES_OPENCODE_API_KEY", models: [{ id: "opencode-1" }] },
        openai: {
          displayName: "OpenAI Compatible", api: "openai-completions", apiKeyEnv: "BALBES_OPENAI_API_KEY",
          baseURL: "https://gateway.example/v1", models: [{ id: "gpt-4o-mini" }]
        }
      }
    };
    const { json } = await call("/api/models/list", {});
    const connections = (json as { connections: Array<Record<string, unknown>> }).connections;
    const oc = connections.find((c) => c.routeId === "opencode");
    const oa = connections.find((c) => c.routeId === "openai");
    expect(oc).toMatchObject({ routeId: "opencode", kind: "preset", providerId: "opencode", displayName: "OpenCode" });
    expect(oa).toMatchObject({ routeId: "openai", kind: "custom", displayName: "OpenAI Compatible", baseURL: "https://gateway.example/v1" });
    expect(oa).not.toHaveProperty("providerId");
  });
});
