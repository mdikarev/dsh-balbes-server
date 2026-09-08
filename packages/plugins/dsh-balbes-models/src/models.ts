export type ModelKind = "deepseek" | "custom";

export interface ModelOption {
  id: string;
  name?: string;
}

export interface ModelConnection {
  routeId: string;
  kind: ModelKind;
  displayName: string;
  baseURL?: string;
  hasKey: boolean;
  models: string[];
  isDefault: boolean;
}

export const DEEPSEEK_OFFICIAL_ROUTE = "deepseek-official";
export const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";

/** Official DeepSeek catalog pinned to dsh 0.1.2-rc.1 (dsh-llm-deepseek).
 *  The engine exposes no in-process list for this fixed route; sync this
 *  constant with the engine catalog on a dsh upgrade. */
export const DEEPSEEK_OFFICIAL_MODELS: ModelOption[] = [
  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" }
];

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
