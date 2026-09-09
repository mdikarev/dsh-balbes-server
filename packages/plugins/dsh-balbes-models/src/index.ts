import z from "@deepseek-ai/schemastery";
import {
  ModelConnection, DEEPSEEK_OFFICIAL_ROUTE, DEEPSEEK_API_KEY_REF,
  routeIdFromName, refNameForRoute, validateCustomPayload,
  PROVIDER_PRESETS, isPresetProviderId, validatePresetPayload,
  ModelCatalogReader, createEngineCatalogReader, catalogKeyForRoute, isCatalogProvider
} from "./models.js";

export const name = "balbes-models";
export const inject = ["balbesHttp", "settings", "credentials", "agentDefaultModel"];
export const Config = z.object({});

export interface HttpSeatLike {
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
export interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
  write(chunk: string): boolean;
  on(event: string, listener: () => void): unknown;
  destroyed: boolean;
  writableEnded: boolean;
}

const LLM_PI_AI_NS = "llm-pi-ai";
const CUSTOM_WIRE_API = "openai-completions"; // pi-ai wire protocol for OpenAI-compatible routes

/** Engine catalog reader shared by every route (one per plugin instance). */
const engineCatalogReader = createEngineCatalogReader();

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
/** settings.update is a NON-DELETING deep merge (dsh mergeLayers never removes
 *  keys), so a route save must fully replace the stored route entry — dropping
 *  a removed baseURL override and replacing the models list. Write the whole
 *  llm-pi-ai section via settings.replace like the delete handler does. */
async function writeRouteConfig(settings: SettingsLike, route: string, routeConfig: Record<string, unknown>): Promise<void> {
  const section = settings.get(LLM_PI_AI_NS) as Record<string, unknown> | undefined;
  const providers = { ...((section?.providers ?? {}) as Record<string, unknown>) };
  await settings.replace(LLM_PI_AI_NS, { ...(section ?? {}), providers: { ...providers, [route]: routeConfig } });
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
  defaultModel: AgentDefaultModelLike,
  reader: ModelCatalogReader = engineCatalogReader
): Promise<ModelConnection[]> {
  const selection = defaultModel.currentSelection();
  const providers = routeProviders(settings);
  // The deepseek connection's models come from the runtime engine catalog
  // (primary) with the pinned DEEPSEEK_OFFICIAL_MODELS list as its fallback.
  const deepseekModels = (await reader.list(catalogKeyForRoute(DEEPSEEK_OFFICIAL_ROUTE))).map((m) => m.id);
  const out: ModelConnection[] = [{
    routeId: DEEPSEEK_OFFICIAL_ROUTE,
    kind: "deepseek",
    displayName: "DeepSeek (официальный)",
    hasKey: (await credentials.describe(DEEPSEEK_API_KEY_REF)).configured,
    models: deepseekModels,
    isDefault: selection.provider === DEEPSEEK_OFFICIAL_ROUTE
  }];
  for (const [route, entry] of Object.entries(providers)) {
    if (route === DEEPSEEK_OFFICIAL_ROUTE) continue;
    const e = entry as { displayName?: string; baseURL?: string; apiKeyEnv?: string; api?: unknown };
    const hasKey = typeof e.apiKeyEnv === "string" && (await credentials.describe(e.apiKeyEnv)).configured;
    // Kind classification: a route whose config carries an api field was written
    // by the v1 custom writer -> custom. A preset route's config has no api
    // field; when its id is an allowlisted catalog provider -> preset, otherwise
    // an api-less unknown route is still shown as a custom connection.
    const isPreset = e.api === undefined && isPresetProviderId(route);
    const connection: ModelConnection = {
      routeId: route,
      kind: isPreset ? "preset" : "custom",
      ...(isPreset ? { providerId: route } : {}),
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

/** Registers the bearer POST /api/models/catalog route (models.catalog): a
 *  provider catalog query returning {provider, models} for catalog providers
 *  (the deepseek route and preset ids); custom/unknown providers get 400
 *  invalid-provider. Registration is kept pure and separate from apply so unit
 *  tests can inject a fake reader. */
export function registerModelsCatalogRoute(http: HttpSeatLike, reader: ModelCatalogReader): void {
  http.post("/api/models/catalog", "bearer", async (_req, res, body) => {
    try {
      const rawProvider = (body as { provider?: unknown } | null | undefined)?.provider;
      const provider = typeof rawProvider === "string" ? rawProvider : "";
      if (!isCatalogProvider(provider)) return fail(res, 400, "invalid-provider", "provider " + provider + " has no engine catalog");
      const models = await reader.list(catalogKeyForRoute(provider));
      send(res, 200, { provider, models });
    } catch (error) {
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });
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

  registerModelsCatalogRoute(http, engineCatalogReader);

  http.post("/api/models/list", "bearer", async (_req, res) => {
    try {
      send(res, 200, { connections: await readConnections(credentials, settings, defaultModel), default: defaultModel.currentSelection() });
    } catch (error) {
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });

  http.post("/api/models/save", "bearer", async (_req, res, body) => {
    try {
      const b = body as { routeId?: unknown; kind?: unknown; provider?: unknown; key?: unknown; displayName?: unknown; baseURL?: unknown; models?: unknown };
      if (b.kind === "deepseek") {
        if (typeof b.key !== "string" || b.key.trim() === "") return fail(res, 400, "invalid-key", "key is required");
        await credentials.set(DEEPSEEK_API_KEY_REF, b.key.trim());
        send(res, 200, { connection: (await readConnections(credentials, settings, defaultModel)).find((c) => c.routeId === DEEPSEEK_OFFICIAL_ROUTE) });
        return;
      }
      if (b.kind === "preset") {
        const payload = validatePresetPayload({ provider: b.provider, displayName: b.displayName, baseURL: b.baseURL, key: b.key, models: b.models });
        if ("error" in payload) return fail(res, 400, payload.error, "invalid preset payload");
        const route = payload.providerId;
        // A preset's route id IS the catalog provider id; an explicit routeId is
        // accepted only for editing the same provider (routeId == provider).
        const rawRouteId = b.routeId;
        const editing = typeof rawRouteId === "string" && rawRouteId !== "" && rawRouteId !== DEEPSEEK_OFFICIAL_ROUTE;
        if (editing && rawRouteId !== route) return fail(res, 400, "invalid-route", "routeId must match the preset provider");
        const providers = routeProviders(settings);
        if (!editing && providers[route] !== undefined) return fail(res, 409, "route-exists", "route " + route + " already exists");
        const selection = defaultModel.currentSelection();
        if (editing && selection.provider === route && !payload.models.includes(selection.model)) {
          return fail(res, 409, "default-in-use", "the default model " + selection.model + " would no longer be offered by this connection; change the default model first");
        }
        const label = PROVIDER_PRESETS.find((p) => p.providerId === route)?.label ?? route;
        const apiKeyEnv = refNameForRoute(route);
        // Preset route config: no api field (the engine picks the official wire
        // protocol for the catalog provider); baseURL only on explicit override.
        const routeConfig: Record<string, unknown> = {
          displayName: payload.displayName ?? label,
          apiKeyEnv,
          models: payload.models.map((id) => ({ id }))
        };
        if (payload.baseURL !== undefined) routeConfig.baseURL = payload.baseURL;
        await writeRouteConfig(settings, route, routeConfig);
        if (payload.key === null) await credentials.unset(apiKeyEnv);
        else if (typeof payload.key === "string" && payload.key !== "") await credentials.set(apiKeyEnv, payload.key);
        const connection = (await readConnections(credentials, settings, defaultModel)).find((c) => c.routeId === route);
        send(res, 200, { connection });
        return;
      }
      if (b.kind !== "custom") return fail(res, 400, "invalid-route", "kind must be deepseek, preset or custom");
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
      const selection = defaultModel.currentSelection();
      if (editing && selection.provider === route && !payload.models.includes(selection.model)) {
        return fail(res, 409, "default-in-use", "the default model " + selection.model + " would no longer be offered by this connection; change the default model first");
      }
      const apiKeyEnv = refNameForRoute(route);
      const routeConfig: Record<string, unknown> = {
        displayName: payload.displayName,
        api: CUSTOM_WIRE_API,
        apiKeyEnv,
        models: payload.models.map((id) => ({ id }))
      };
      if (payload.baseURL !== undefined) routeConfig.baseURL = payload.baseURL;
      await writeRouteConfig(settings, route, routeConfig);
      if (payload.key === null) await credentials.unset(apiKeyEnv);
      else if (typeof payload.key === "string" && payload.key !== "") await credentials.set(apiKeyEnv, payload.key);
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
