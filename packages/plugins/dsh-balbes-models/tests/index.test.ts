import { describe, expect, it, beforeEach, vi } from "vitest";
import { apply, name, inject, registerModelsCatalogRoute } from "../src/index.js";
import type { ModelCatalogReader } from "../src/models.js";
import type { HttpSeatLike, ResLike } from "../src/index.js";

interface Seat { path: string; auth: string; handler(req: unknown, res: unknown, body: unknown): Promise<void> | void; }

/** Deep merge matching the engine's mergeLayers: objects merge recursively,
 *  arrays/scalars replace, and keys already present are NEVER removed. */
function mergeDeep(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base === "object" && base !== null && typeof patch === "object" && patch !== null) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      out[key] = mergeDeep(out[key], value);
    }
    return out;
  }
  return patch;
}

class FakeSettings {
  sections: Record<string, unknown> = {};
  get(ns: string): unknown { return this.sections[ns]; }
  // Mirrors the engine: settings.update is a NON-DELETING deep merge, so dropping
  // a stored key (e.g. a removed baseURL override) requires a settings.replace.
  async update(ns: string, patch: object): Promise<void> {
    this.sections[ns] = mergeDeep(this.sections[ns] ?? {}, patch) as Record<string, unknown>;
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
  provided: {} as Record<string, unknown>,
  provide(key: string, value: unknown): void {
    this.provided[key] = value;
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

/** Invoke the pure /api/models/catalog registration with an injected reader. */
async function callCatalog(reader: ModelCatalogReader, body: unknown): Promise<{ status: number; json: unknown }> {
  const registered: Seat[] = [];
  const localHttp: HttpSeatLike = {
    post(path: string, auth: string, handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void) {
      registered.push({ path, auth, handler: handler as Seat["handler"] });
    }
  };
  registerModelsCatalogRoute(localHttp, reader);
  const seat = registered.find((s) => s.path === "/api/models/catalog");
  if (!seat) throw new Error("no catalog seat");
  const res = { status: 0, payload: "" };
  await seat.handler({}, {
    writeHead(status: number) { res.status = status; },
    end(body?: string) { res.payload = String(body ?? ""); },
    write() { return true; }, on() {}, destroyed: false, writableEnded: false
  }, body);
  return { status: res.status, json: JSON.parse(res.payload) };
}

function fakeCatalogReader(models: Record<string, Array<{ id: string; name?: string }>>): ModelCatalogReader {
  return { list: (key: string) => models[key] ?? [] };
}

describe("balbes-models plugin", () => {
  beforeEach(() => {
    seats = [];
    settings = new FakeSettings();
    credentials = new FakeCredentials();
    agentDefaultModel = new FakeDefaultModel();
    ctx.provided = {};
  });

  it("exposes name/inject/apply contract and registers five bearer routes", () => {
    expect(name).toBe("balbes-models");
    expect(inject).toEqual(["balbesHttp", "settings", "credentials", "agentDefaultModel"]);
    apply(ctx as never, {});
    expect(seats.map((s) => s.path).sort()).toEqual([
      "/api/models/catalog", "/api/models/default", "/api/models/delete", "/api/models/list", "/api/models/save"
    ]);
    for (const s of seats) expect(s.auth).toBe("bearer");
  });

  it("provides the balbesModels service for in-process consumers", () => {
    apply(ctx as never, {});
    expect(typeof (ctx.provided["balbesModels"] as { list?: unknown }).list).toBe("function");
    expect((ctx.provided["balbesModels"] as { current(): unknown }).current()).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash"
    });
  });

  it("list returns the deepseek connection as default without a key", async () => {
    apply(ctx as never, {});
    const { status, json } = await call("/api/models/list", {});
    expect(status).toBe(200);
    const body = json as { connections: Array<{ routeId: string; kind: string; hasKey: boolean; models: string[]; isDefault: boolean }> };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({ routeId: "deepseek-official", kind: "deepseek", hasKey: false, isDefault: true });
  });

  it("deepseek connection in models.list carries the runtime catalog (3 models incl vision-exp)", async () => {
    apply(ctx as never, {});
    const { json } = await call("/api/models/list", {});
    const models = (json as { connections: Array<{ routeId: string; models: string[] }> }).connections.find((c) => c.routeId === "deepseek-official")!.models;
    expect(models).toEqual(["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]);
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
    const unknownRoute = await call("/api/models/default", { provider: "nope", model: "m-1" });
    expect(unknownRoute.status).toBe(400);
    expect((unknownRoute.json as { error: { code: string } }).error.code).toBe("invalid-route");
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

  it("preset edit without baseURL removes a stored override and replaces the models list", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", {
      kind: "preset", provider: "openai", baseURL: "https://custom.example/v1", key: "sk-o", models: ["gpt-4o-mini", "gpt-4o"]
    });
    const edit = await call("/api/models/save", { kind: "preset", provider: "openai", routeId: "openai", models: ["gpt-4o"] });
    expect(edit.status).toBe(200);
    const section = settings.get("llm-pi-ai") as { providers: Record<string, any> };
    const route = section.providers["openai"] as Record<string, unknown>;
    expect(route).not.toHaveProperty("baseURL");
    expect(route).toMatchObject({ displayName: "OpenAI", apiKeyEnv: "BALBES_OPENAI_API_KEY", models: [{ id: "gpt-4o" }] });
    expect(route).not.toHaveProperty("api");
    const listed = await call("/api/models/list", {});
    const conn = (listed.json as { connections: Array<Record<string, unknown>> }).connections.find((c) => c.routeId === "openai");
    expect(conn?.baseURL).toBeUndefined();
    expect((conn as { models: string[] }).models).toEqual(["gpt-4o"]);
    expect(credentials.refs.get("BALBES_OPENAI_API_KEY")).toBe("sk-o");
  });

  it("custom edit without baseURL removes a stored override and replaces the models list", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", {
      kind: "custom", displayName: "My Gateway", baseURL: "https://x.example/v1", key: "k", models: ["m-1", "m-2"]
    });
    const edit = await call("/api/models/save", {
      kind: "custom", routeId: "my-gateway", displayName: "My Gateway", key: "k2", models: ["m-2"]
    });
    expect(edit.status).toBe(200);
    const section = settings.get("llm-pi-ai") as { providers: Record<string, any> };
    const route = section.providers["my-gateway"] as Record<string, unknown>;
    expect(route).not.toHaveProperty("baseURL");
    expect(route).toMatchObject({ displayName: "My Gateway", api: "openai-completions", apiKeyEnv: "BALBES_MY_GATEWAY_API_KEY", models: [{ id: "m-2" }] });
    const listed = await call("/api/models/list", {});
    const conn = (listed.json as { connections: Array<Record<string, unknown>> }).connections.find((c) => c.routeId === "my-gateway");
    expect(conn?.baseURL).toBeUndefined();
    expect((conn as { models: string[] }).models).toEqual(["m-2"]);
  });
});

describe("models.catalog route", () => {
  // Engine builtin-catalog fixture for the injected fake reader: the same
  // shapes getBuiltinModels returns ({id} and {id,name} entries).
  const engineFixture: Record<string, Array<{ id: string; name?: string }>> = {
    deepseek: [
      { id: "deepseek-v4-flash" },
      { id: "deepseek-v4-pro" },
      { id: "deepseek-v4-flash-vision-exp", name: "Vision Exp" }
    ],
    openai: [{ id: "gpt-4o-mini" }, { id: "gpt-4o", name: "GPT-4o" }]
  };

  it("200: deepseek-official returns the engine deepseek catalog (3 ids incl vision-exp)", async () => {
    const { status, json } = await callCatalog(fakeCatalogReader(engineFixture), { provider: "deepseek-official" });
    expect(status).toBe(200);
    expect(json).toEqual({ provider: "deepseek-official", models: engineFixture.deepseek });
  });

  it("200: a preset provider returns its non-empty engine catalog", async () => {
    const { status, json } = await callCatalog(fakeCatalogReader(engineFixture), { provider: "openai" });
    expect(status).toBe(200);
    const body = json as { provider: string; models: Array<{ id: string; name?: string }> };
    expect(body.provider).toBe("openai");
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.map((m) => m.id)).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  it("400 invalid-provider for a custom route id (no engine catalog)", async () => {
    const { status, json } = await callCatalog(fakeCatalogReader(engineFixture), { provider: "my-gateway" });
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe("invalid-provider");
  });

  it("400 invalid-provider for a totally unknown provider", async () => {
    const { status, json } = await callCatalog(fakeCatalogReader(engineFixture), { provider: "totally-unknown" });
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe("invalid-provider");
  });

  it("400 invalid-provider when provider is missing or not a string", async () => {
    expect((await callCatalog(fakeCatalogReader(engineFixture), {})).status).toBe(400);
    expect((await callCatalog(fakeCatalogReader(engineFixture), { provider: 7 })).status).toBe(400);
  });

  it("500 internal when the reader fails", async () => {
    const failing: ModelCatalogReader = { list: () => { throw new Error("catalog module exploded"); } };
    const { status, json } = await callCatalog(failing, { provider: "deepseek-official" });
    expect(status).toBe(500);
    expect((json as { error: { code: string } }).error.code).toBe("internal");
  });
});
