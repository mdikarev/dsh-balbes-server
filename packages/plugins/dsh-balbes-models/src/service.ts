import {
  DEEPSEEK_API_KEY_REF,
  DEEPSEEK_OFFICIAL_ROUTE,
  catalogKeyForRoute,
  isPresetProviderId,
  type ModelCatalogReader,
  type ModelConnection
} from "./models.js";

/** Settings section holding the pi-ai provider routes. Shared with index.ts:
 *  this module owns the read side of the section, index.ts the write side. */
export const LLM_PI_AI_NS = "llm-pi-ai";

/** The engine services the connection reader needs. Declared structurally so a
 *  unit test can pass plain fakes instead of real engine instances. */
export interface ModelsSettingsLike {
  get(ns: string): unknown;
  replace(ns: string, section: object): Promise<void>;
}
export interface ModelsCredentialsLike {
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}
export interface ModelsDefaultLike {
  currentSelection(): { provider: string; model: string };
  saveSelection(next: { provider: string; model: string }): Promise<void>;
}

export type ModelsServiceErrorCode = "invalid-route" | "invalid-model";

/** Invalid model selection, mapped by the HTTP layer onto a 400 + code. */
export class ModelsServiceError extends Error {
  constructor(
    readonly code: ModelsServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ModelsServiceError";
  }
}

/** Facade over the model connections for in-process consumers (the Telegram
 *  channel): the same reading and the same validation as the HTTP routes, so
 *  the admin UI and the chat cannot disagree. */
export interface BalbesModelsService {
  list(): Promise<ModelConnection[]>;
  current(): { provider: string; model: string };
  saveDefault(provider: string, model: string): Promise<{ provider: string; model: string }>;
}

export function routeProviders(settings: ModelsSettingsLike): Record<string, unknown> {
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

export async function readConnections(
  credentials: ModelsCredentialsLike,
  settings: ModelsSettingsLike,
  defaultModel: ModelsDefaultLike,
  reader: ModelCatalogReader
): Promise<ModelConnection[]> {
  const selection = defaultModel.currentSelection();
  const providers = routeProviders(settings);
  // The deepseek connection's models come from the runtime engine catalog
  // (primary): the union of the native dsh-llm-deepseek catalog and the pi-ai
  // builtin catalog, with the pinned DEEPSEEK_OFFICIAL_MODELS list as the
  // fallback for either unavailable side.
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

export function createModelsService(deps: {
  settings: ModelsSettingsLike;
  credentials: ModelsCredentialsLike;
  defaultModel: ModelsDefaultLike;
  reader: ModelCatalogReader;
}): BalbesModelsService {
  return {
    list: () => readConnections(deps.credentials, deps.settings, deps.defaultModel, deps.reader),
    current: () => deps.defaultModel.currentSelection(),
    async saveDefault(provider, model) {
      const connection = (await readConnections(deps.credentials, deps.settings, deps.defaultModel, deps.reader)).find(
        (c) => c.routeId === provider
      );
      if (connection === undefined) {
        throw new ModelsServiceError("invalid-route", "no such provider connection");
      }
      if (!connection.models.includes(model)) {
        throw new ModelsServiceError("invalid-model", `model ${model} is not offered by ${provider}`);
      }
      await deps.defaultModel.saveSelection({ provider, model });
      return { provider, model };
    }
  };
}
