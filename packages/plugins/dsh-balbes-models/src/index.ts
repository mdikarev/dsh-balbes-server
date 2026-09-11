import z from "@deepseek-ai/schemastery";
import {
  DEEPSEEK_OFFICIAL_ROUTE, DEEPSEEK_API_KEY_REF,
  routeIdFromName, refNameForRoute, validateCustomPayload,
  PROVIDER_PRESETS, validatePresetPayload,
  ModelCatalogReader, createEngineCatalogReader, catalogKeyForRoute, isCatalogProvider
} from "./models.js";
import {
  LLM_PI_AI_NS, ModelsServiceError, createModelsService, readConnections, routeProviders,
  type ModelsCredentialsLike, type ModelsDefaultLike, type ModelsSettingsLike
} from "./service.js";

export const name = "balbes-models";
export const inject = ["balbesHttp", "settings", "credentials", "agentDefaultModel"];
export const Config = z.object({});

export interface HttpSeatLike {
  post(path: string, auth: "public" | "bearer", handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void): void;
}
export interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
  write(chunk: string): boolean;
  on(event: string, listener: () => void): unknown;
  destroyed: boolean;
  writableEnded: boolean;
}

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
/** settings.update is a NON-DELETING deep merge (dsh mergeLayers never removes
 *  keys), so a route save must fully replace the stored route entry — dropping
 *  a removed baseURL override and replacing the models list. Write the whole
 *  llm-pi-ai section via settings.replace like the delete handler does. */
async function writeRouteConfig(settings: ModelsSettingsLike, route: string, routeConfig: Record<string, unknown>): Promise<void> {
  const section = settings.get(LLM_PI_AI_NS) as Record<string, unknown> | undefined;
  const providers = { ...((section?.providers ?? {}) as Record<string, unknown>) };
  await settings.replace(LLM_PI_AI_NS, { ...(section ?? {}), providers: { ...providers, [route]: routeConfig } });
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

export function apply(ctx: {
  get(key: string): unknown;
  provide(key: string, value: unknown): void;
  logger: { warn(m: string): void };
}, _config: unknown): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-models: balbesHttp service missing; routes not registered");
    return;
  }
  const settings = ctx.get("settings") as ModelsSettingsLike;
  const credentials = ctx.get("credentials") as ModelsCredentialsLike;
  const defaultModel = ctx.get("agentDefaultModel") as ModelsDefaultLike;

  // In-process facade for the Telegram channel: the same reading and the same
  // validation as the /api/models/* routes below.
  const modelsService = createModelsService({
    settings,
    credentials,
    defaultModel,
    reader: engineCatalogReader
  });
  ctx.provide("balbesModels", modelsService);

  registerModelsCatalogRoute(http, engineCatalogReader);

  http.post("/api/models/list", "bearer", async (_req, res) => {
    try {
      send(res, 200, { connections: await modelsService.list(), default: modelsService.current() });
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
        send(res, 200, { connection: (await readConnections(credentials, settings, defaultModel, engineCatalogReader)).find((c) => c.routeId === DEEPSEEK_OFFICIAL_ROUTE) });
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
        const connection = (await readConnections(credentials, settings, defaultModel, engineCatalogReader)).find((c) => c.routeId === route);
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
      const connection = (await readConnections(credentials, settings, defaultModel, engineCatalogReader)).find((c) => c.routeId === route);
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
      send(res, 200, { default: await modelsService.saveDefault(provider, model) });
    } catch (error) {
      if (error instanceof ModelsServiceError) return fail(res, 400, error.code, error.message);
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });
}
