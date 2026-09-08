import z from "@deepseek-ai/schemastery";
import {
  ModelConnection, DEEPSEEK_OFFICIAL_ROUTE, DEEPSEEK_API_KEY_REF,
  DEEPSEEK_OFFICIAL_MODELS, routeIdFromName, refNameForRoute, validateCustomPayload
} from "./models.js";

export const name = "balbes-models";
export const inject = ["balbesHttp"];
export const Config = z.object({});

interface HttpSeatLike {
  post(path: string, auth: "public" | "bearer", handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void): void;
}
interface SettingsLike {
  get(ns: string): unknown;
  update(ns: string, patch: object): Promise<void>;
  replace(ns: string, section: object): Promise<void>;
}
interface CredentialsLike {
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}
interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string };
  saveSelection(next: { provider: string; model: string }): Promise<void>;
}
interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
  write(chunk: string): boolean;
  on(event: string, listener: () => void): unknown;
  destroyed: boolean;
  writableEnded: boolean;
}

const LLM_PI_AI_NS = "llm-pi-ai";
const CUSTOM_WIRE_API = "chat"; // pi-ai wire protocol for OpenAI-compatible routes

function send(res: ResLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload))
  });
  res.end(payload);
}
function fail(res: ResLike, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}
function routeProviders(settings: SettingsLike): Record<string, unknown> {
  const section = settings.get(LLM_PI_AI_NS) as { providers?: Record<string, unknown> } | undefined;
  return section?.providers ?? {};
}
function modelIdsOf(entry: unknown): string[] {
  const models = (entry as { models?: Array<{ id?: string }> })?.models;
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const m of models) if (typeof m?.id === "string") ids.push(m.id);
  return ids;
}
async function readConnections(
  credentials: CredentialsLike,
  settings: SettingsLike,
  defaultModel: AgentDefaultModelLike
): Promise<ModelConnection[]> {
  const selection = defaultModel.currentSelection();
  const providers = routeProviders(settings);
  const out: ModelConnection[] = [{
    routeId: DEEPSEEK_OFFICIAL_ROUTE,
    kind: "deepseek",
    displayName: "DeepSeek (официальный)",
    hasKey: (await credentials.describe(DEEPSEEK_API_KEY_REF)).configured,
    models: DEEPSEEK_OFFICIAL_MODELS.map((m) => m.id),
    isDefault: selection.provider === DEEPSEEK_OFFICIAL_ROUTE
  }];
  for (const [route, entry] of Object.entries(providers)) {
    if (route === DEEPSEEK_OFFICIAL_ROUTE) continue;
    const e = entry as { displayName?: string; baseURL?: string; apiKeyEnv?: string };
    const hasKey = typeof e.apiKeyEnv === "string" && (await credentials.describe(e.apiKeyEnv)).configured;
    const connection: ModelConnection = {
      routeId: route,
      kind: "custom",
      displayName: e.displayName ?? route,
      hasKey,
      models: modelIdsOf(entry),
      isDefault: selection.provider === route
    };
    if (typeof e.baseURL === "string" && e.baseURL !== "") connection.baseURL = e.baseURL;
    out.push(connection);
  }
  return out;
}

export function apply(ctx: { get(key: string): unknown; logger: { warn(m: string): void } }, _config: unknown): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-models: balbesHttp service missing; routes not registered");
    return;
  }
  const settings = ctx.get("settings") as SettingsLike;
  const credentials = ctx.get("credentials") as CredentialsLike;
  const defaultModel = ctx.get("agentDefaultModel") as AgentDefaultModelLike;

  http.post("/api/models/list", "bearer", async (_req, res) => {
    try {
      send(res, 200, { connections: await readConnections(credentials, settings, defaultModel), default: defaultModel.currentSelection() });
    } catch (error) {
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });

  http.post("/api/models/save", "bearer", async (_req, res, body) => {
    try {
      const b = body as { routeId?: unknown; kind?: unknown; key?: unknown; displayName?: unknown; baseURL?: unknown; models?: unknown };
      if (b.kind === "deepseek") {
        if (typeof b.key !== "string" || b.key.trim() === "") return fail(res, 400, "invalid-key", "key is required");
        await credentials.set(DEEPSEEK_API_KEY_REF, b.key.trim());
        send(res, 200, { connection: (await readConnections(credentials, settings, defaultModel)).find((c) => c.routeId === DEEPSEEK_OFFICIAL_ROUTE) });
        return;
      }
      if (b.kind !== "custom") return fail(res, 400, "invalid-route", "kind must be deepseek or custom");
      const payload = validateCustomPayload({ displayName: b.displayName, baseURL: b.baseURL, key: b.key, models: b.models });
      if ("error" in payload) return fail(res, 400, payload.error, "invalid custom connection payload");
      const rawRouteId = b.routeId;
      const editing = typeof rawRouteId === "string" && rawRouteId !== "" && rawRouteId !== DEEPSEEK_OFFICIAL_ROUTE;
      const route = editing ? rawRouteId : routeIdFromName(payload.displayName);
      if (route === null || route === DEEPSEEK_OFFICIAL_ROUTE || !/^[a-z][a-z0-9-]*$/.test(route)) {
        return fail(res, 400, "invalid-route", "bad route id");
      }
      const providers = routeProviders(settings);
      if (!editing && providers[route] !== undefined) return fail(res, 409, "route-exists", "route " + route + " already exists");
      const apiKeyEnv = refNameForRoute(route);
      const routeConfig: Record<string, unknown> = {
        displayName: payload.displayName,
        api: CUSTOM_WIRE_API,
        apiKeyEnv,
        models: payload.models.map((id) => ({ id }))
      };
      if (payload.baseURL !== undefined) routeConfig.baseURL = payload.baseURL;
      await settings.update(LLM_PI_AI_NS, { providers: { [route]: routeConfig } });
      if (typeof payload.key === "string" && payload.key !== "") await credentials.set(apiKeyEnv, payload.key);
      const connection = (await readConnections(credentials, settings, defaultModel)).find((c) => c.routeId === route);
      send(res, 200, { connection });
    } catch (error) {
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });

  http.post("/api/models/delete", "bearer", async (_req, res, body) => {
    try {
      const route = (body as { routeId?: unknown }).routeId;
      if (typeof route !== "string" || route === "") return fail(res, 400, "invalid-route", "routeId required");
      if (route === DEEPSEEK_OFFICIAL_ROUTE) return fail(res, 400, "reserved", "deepseek-official cannot be deleted");
      const providers = routeProviders(settings);
      if (providers[route] === undefined) return fail(res, 404, "not-found", "route " + route + " not found");
      const selection = defaultModel.currentSelection();
      if (selection.provider === route) return fail(res, 409, "default-in-use", "change the default model first");
      const next: Record<string, unknown> = { ...providers };
      delete next[route];
      const section = settings.get(LLM_PI_AI_NS) as Record<string, unknown> | undefined;
      await settings.replace(LLM_PI_AI_NS, { ...(section ?? {}), providers: next });
      await credentials.unset(refNameForRoute(route));
      send(res, 200, {});
    } catch (error) {
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });

  http.post("/api/models/default", "bearer", async (_req, res, body) => {
    try {
      const b = body as { provider?: unknown; model?: unknown };
      const provider = typeof b.provider === "string" ? b.provider : "";
      const model = typeof b.model === "string" ? b.model : "";
      const connection = (await readConnections(credentials, settings, defaultModel)).find((c) => c.routeId === provider);
      if (connection === undefined) return fail(res, 400, "invalid-route", "no such provider connection");
      if (!connection.models.includes(model)) return fail(res, 400, "invalid-model", "model " + model + " is not offered by " + provider);
      await defaultModel.saveSelection({ provider, model });
      send(res, 200, { default: { provider, model } });
    } catch (error) {
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });
}
