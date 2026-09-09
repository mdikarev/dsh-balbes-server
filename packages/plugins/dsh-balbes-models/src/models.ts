export type ModelKind = "deepseek" | "preset" | "custom";

export interface ModelOption {
  id: string;
  name?: string;
}

export interface ModelConnection {
  routeId: string;
  kind: ModelKind;
  /** Present only for kind "preset"; equals the catalog provider id (== routeId). */
  providerId?: string;
  displayName: string;
  baseURL?: string;
  hasKey: boolean;
  models: string[];
  isDefault: boolean;
}

export const DEEPSEEK_OFFICIAL_ROUTE = "deepseek-official";
export const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";

/** Pinned fallback mirror of the dsh-llm-deepseek catalog (3 models), synced
 *  on engine upgrade. The primary source of the official DeepSeek list is the
 *  runtime engine catalog read through createEngineCatalogReader(); this
 *  constant is only used when that catalog is unavailable. */
export const DEEPSEEK_OFFICIAL_MODELS: ModelOption[] = [
  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
  { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek-V4-Flash-Vision-Exp" }
];

/** Reads the builtin model catalog of one engine provider. The primary source
 *  is the engine runtime catalog; the pinned DEEPSEEK_OFFICIAL_MODELS list is
 *  only the fallback used by createEngineCatalogReader when the runtime
 *  catalog cannot be read. */
export interface ModelCatalogReader {
  list(providerKey: string): Promise<ModelOption[]> | ModelOption[];
}

/** The engine module exposing getBuiltinModels(provider). */
const ENGINE_CATALOG_MODULE = "@earendil-works/pi-ai/providers/all";

interface CatalogModuleLike {
  getBuiltinModels?(providerKey: string): unknown;
}

/** Keeps only {id} / {id, name} entries of an engine catalog result. */
function toModelOptions(raw: unknown): ModelOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ModelOption[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const entry = item as { id?: unknown; name?: unknown };
    if (typeof entry.id !== "string" || entry.id === "") return null;
    const model: ModelOption = { id: entry.id };
    if (typeof entry.name === "string" && entry.name !== "") model.name = entry.name;
    out.push(model);
  }
  return out;
}

/** Loads the engine catalog module (default: a dynamic ESM import). pi-ai
 *  ships an ESM-only export map — "./providers/*" declares only an "import"
 *  condition — and plugin modules run as ESM with no ambient require, so a
 *  CommonJS require (even createRequire(import.meta.url)) throws
 *  ERR_PACKAGE_PATH_NOT_EXPORTED for this specifier. Only a dynamic import()
 *  resolves it: at runtime that resolution walks up to the dsh profile mirror
 *  ($DSH_HOME/profiles/node_modules), where @earendil-works/pi-ai is linked.
 *  Evidence: live dsh probe — typeof require === "undefined" in plugin scope,
 *  createRequire load fails ERR_PACKAGE_PATH_NOT_EXPORTED, import() succeeds
 *  and getBuiltinModels("openai") returns 38 models. */
export type EngineCatalogLoader = (specifier: string) => unknown | Promise<unknown>;

/** Creates an engine catalog reader. The module is loaded lazily on the
 *  first list() call: through load when given (unit tests inject fakes),
 *  otherwise through a dynamic ESM import of the specifier (the ESM-safe path
 *  that resolves under the dsh loader / profile mirror). Any load or shape
 *  failure, plus an empty engine result, falls back to the pinned
 *  DEEPSEEK_OFFICIAL_MODELS for the "deepseek" key and to [] for any other
 *  key. */
export function createEngineCatalogReader(load?: EngineCatalogLoader): ModelCatalogReader {
  const loadModule = load ?? ((specifier: string) => import(specifier));
  return {
    async list(providerKey: string): Promise<ModelOption[]> {
      try {
        const mod = (await loadModule(ENGINE_CATALOG_MODULE)) as CatalogModuleLike | undefined;
        const models = toModelOptions(mod?.getBuiltinModels?.(providerKey));
        if (models !== null && models.length > 0) return models;
      } catch {
        // fall through to the pinned/empty fallback
      }
      return providerKey === "deepseek" ? DEEPSEEK_OFFICIAL_MODELS : [];
    }
  };
}

/** Maps a connection route id to the engine catalog provider key: the reserved
 *  "deepseek-official" route reads the engine "deepseek" catalog (the
 *  dsh-llm-deepseek mirror); a preset connection's route id already equals its
 *  provider id; any other (custom/unknown) route id passes through untouched,
 *  which the reader answers with [] (no engine catalog for it). */
export function catalogKeyForRoute(route: string): string {
  if (route === DEEPSEEK_OFFICIAL_ROUTE) return "deepseek";
  return route;
}

/** True when the route has an engine catalog: the deepseek route or a preset
 *  provider id from PROVIDER_PRESETS. Custom/unknown routes have no catalog. */
export function isCatalogProvider(route: string): boolean {
  return route === DEEPSEEK_OFFICIAL_ROUTE || isPresetProviderId(route);
}

const ROUTE_ID_RE = /^[a-z][a-z0-9-]*$/;

export function routeIdFromName(name: string): string | null {
  const trimmed = name.trim();
  // The slug must keep the name's leading letter: a leading separator (e.g. "_lead")
  // must not be silently dropped into a valid-looking route id.
  if (!/^[a-z]/.test(trimmed.toLowerCase())) return null;
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug === "" || slug.length > 63 || !ROUTE_ID_RE.test(slug)) return null;
  return slug;
}

export function refNameForRoute(route: string): string {
  return "BALBES_" + route.replace(/-/g, "_").toUpperCase() + "_API_KEY";
}

export function validateBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseModelIds(raw: string[]): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const id = item.trim();
    if (id === "" || /[\s,]/.test(id) || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function validateCustomPayload(p: {
  displayName?: unknown; baseURL?: unknown; key?: unknown; models?: unknown;
}): { displayName: string; baseURL?: string; key?: string | null; models: string[] }
  | { error: "invalid-display-name" | "invalid-url" | "invalid-key" | "invalid-models" } {
  if (typeof p.displayName !== "string" || p.displayName.trim() === "") return { error: "invalid-display-name" };
  if (p.baseURL !== undefined && p.baseURL !== null && p.baseURL !== "" && (typeof p.baseURL !== "string" || !validateBaseUrl(p.baseURL))) return { error: "invalid-url" };
  if (p.key !== undefined && p.key !== null && p.key !== "" && typeof p.key !== "string") return { error: "invalid-key" };
  const models = parseModelIds(Array.isArray(p.models) ? p.models : []);
  if (models === null) return { error: "invalid-models" };
  const out: { displayName: string; baseURL?: string; key?: string | null; models: string[] } = {
    displayName: p.displayName.trim(),
    models
  };
  if (typeof p.baseURL === "string" && p.baseURL !== "") out.baseURL = p.baseURL;
  if (typeof p.key === "string" && p.key !== "") out.key = p.key;
  // An explicit null key is a clear signal (route stays, credential ref removed);
  // preserve it so the save handler can unset instead of skipping.
  if (p.key === null) out.key = null;
  return out;
}

/**
 * Preset provider catalog (id + label). Display/validation copy of
 * MODEL_PROVIDER_PRESETS in packages/contracts — keep both lists in sync; the
 * engine pi-ai catalog provider ids (dsh 0.1.2-rc.1) are the ground truth and
 * route ids of preset connections equal these provider ids.
 */
export const PROVIDER_PRESETS: ReadonlyArray<{ providerId: string; label: string }> = [
  { providerId: "openai", label: "OpenAI" },
  { providerId: "anthropic", label: "Anthropic (Claude)" },
  { providerId: "openrouter", label: "OpenRouter" },
  { providerId: "groq", label: "Groq" },
  { providerId: "google", label: "Google (Gemini)" },
  { providerId: "mistral", label: "Mistral" },
  { providerId: "xai", label: "xAI (Grok)" },
  { providerId: "together", label: "Together" },
  { providerId: "cerebras", label: "Cerebras" },
  { providerId: "fireworks", label: "Fireworks" },
  { providerId: "opencode", label: "OpenCode" }
];

/** True when the id is one of the allowlisted catalog preset providers. */
export function isPresetProviderId(id: string): boolean {
  return PROVIDER_PRESETS.some((p) => p.providerId === id);
}

/**
 * Validates a preset save payload. provider is required and must be allowlisted
 * (else invalid-provider); displayName is optional and must be a non-empty
 * string when given (the save handler falls back to the catalog label); baseURL optional
 * http(s); key follows exactly the custom payload semantics (non-empty string
 * sets, null clears, absent keeps); models >= 1 via parseModelIds.
 */
export function validatePresetPayload(p: {
  provider?: unknown; displayName?: unknown; baseURL?: unknown; key?: unknown; models?: unknown;
}): { providerId: string; displayName?: string; baseURL?: string; key?: string | null; models: string[] }
  | { error: "invalid-provider" | "invalid-display-name" | "invalid-url" | "invalid-key" | "invalid-models" } {
  if (typeof p.provider !== "string" || !isPresetProviderId(p.provider)) return { error: "invalid-provider" };
  let displayName: string | undefined;
  if (p.displayName !== undefined) {
    if (typeof p.displayName !== "string" || p.displayName.trim() === "") return { error: "invalid-display-name" };
    displayName = p.displayName.trim();
  }
  // baseURL/key/models reuse the custom payload rules wholesale; the placeholder
  // displayName never triggers invalid-display-name here.
  const rest = validateCustomPayload({ displayName: "_", baseURL: p.baseURL, key: p.key, models: p.models });
  if ("error" in rest) return { error: rest.error };
  const out: { providerId: string; displayName?: string; baseURL?: string; key?: string | null; models: string[] } = {
    providerId: p.provider,
    models: rest.models
  };
  if (displayName !== undefined) out.displayName = displayName;
  if (rest.baseURL !== undefined) out.baseURL = rest.baseURL;
  if (rest.key !== undefined) out.key = rest.key;
  return out;
}
