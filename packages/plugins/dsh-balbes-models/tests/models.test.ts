import { describe, expect, it } from "vitest";
import {
  routeIdFromName, refNameForRoute, validateBaseUrl, parseModelIds,
  validateCustomPayload, DEEPSEEK_OFFICIAL_MODELS, DEEPSEEK_OFFICIAL_ROUTE,
  PROVIDER_PRESETS, isPresetProviderId, validatePresetPayload,
  createEngineCatalogReader, catalogKeyForRoute, isCatalogProvider
} from "../src/models.js";

describe("models domain", () => {
  it("generates lower-hyphen route ids from display names", () => {
    expect(routeIdFromName("My Gateway")).toBe("my-gateway");
    expect(routeIdFromName("OpenAI Compatible!")).toBe("openai-compatible");
    expect(routeIdFromName("мышь")).toBeNull();
    expect(routeIdFromName("")).toBeNull();
    expect(routeIdFromName("x".repeat(64))).toBeNull();
    expect(routeIdFromName("a b")).toBe("a-b");
    expect(routeIdFromName("_lead")).toBeNull();
  });

  it("maps a route to a POSIX-safe env ref name", () => {
    expect(refNameForRoute("my-gateway")).toBe("BALBES_MY_GATEWAY_API_KEY");
    expect(refNameForRoute("deepseek-official")).toBe("BALBES_DEEPSEEK_OFFICIAL_API_KEY");
  });

  it("validates base URLs as http(s)", () => {
    expect(validateBaseUrl("https://api.example.com/v1")).toBe(true);
    expect(validateBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(validateBaseUrl("ftp://x")).toBe(false);
    expect(validateBaseUrl("not a url")).toBe(false);
  });

  it("parses model id lists: >=1, unique, no spaces", () => {
    expect(parseModelIds(["gpt-4o-mini", "gpt-4o"])).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(parseModelIds([])).toBeNull();
    expect(parseModelIds(["a b"])).toBeNull();
    expect(parseModelIds(["a", "a"])).toBeNull();
  });

  it("validates the custom connection payload", () => {
    const ok = validateCustomPayload({ displayName: "My GW", baseURL: "https://x.example/v1", key: "sk-1", models: ["m1"] });
    expect(ok).toEqual({ displayName: "My GW", baseURL: "https://x.example/v1", key: "sk-1", models: ["m1"] });
    expect(validateCustomPayload({ displayName: "", baseURL: "https://x", models: ["m1"] })).toEqual({ error: "invalid-display-name" });
    expect(validateCustomPayload({ displayName: "X", baseURL: "nope", models: ["m1"] })).toEqual({ error: "invalid-url" });
    expect(validateCustomPayload({ displayName: "X", baseURL: "https://x", models: [] })).toEqual({ error: "invalid-models" });
  });

  it("preserves an explicit null key as a clear signal", () => {
    const cleared = validateCustomPayload({ displayName: "X", baseURL: "https://x", key: null, models: ["m1"] });
    expect(cleared).toEqual({ displayName: "X", baseURL: "https://x", key: null, models: ["m1"] });
  });

  it("pins the 3-model official DeepSeek fallback catalog (mirror of dsh-llm-deepseek)", () => {
    expect(DEEPSEEK_OFFICIAL_MODELS.map((m) => m.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp"
    ]);
    expect(DEEPSEEK_OFFICIAL_MODELS.find((m) => m.id === "deepseek-v4-flash-vision-exp")?.name).toBe("DeepSeek-V4-Flash-Vision-Exp");
  });

  it("mirrors the 11 engine-catalog preset providers from contracts MODEL_PROVIDER_PRESETS", () => {
    expect(PROVIDER_PRESETS).toEqual([
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
    ]);
  });

  it("isPresetProviderId accepts only allowlisted catalog ids", () => {
    expect(isPresetProviderId("openai")).toBe(true);
    expect(isPresetProviderId("opencode")).toBe(true);
    expect(isPresetProviderId("nope")).toBe(false);
    expect(isPresetProviderId("deepseek-official")).toBe(false);
  });

  it("validates a preset payload: provider required + allowlisted, optional displayName/baseURL, custom key rules", () => {
    const ok = validatePresetPayload({ provider: "openai", key: "sk-o", models: ["gpt-4o-mini"] });
    expect(ok).toEqual({ providerId: "openai", key: "sk-o", models: ["gpt-4o-mini"] });
    const withName = validatePresetPayload({
      provider: "openai", displayName: "  OpenAI  ", baseURL: "https://custom.example/v1", key: "sk-o", models: ["gpt-4o-mini"]
    });
    expect(withName).toEqual({
      providerId: "openai", displayName: "OpenAI", baseURL: "https://custom.example/v1", key: "sk-o", models: ["gpt-4o-mini"]
    });
    // An explicit null key is a clear signal (same semantics as the custom payload).
    const cleared = validatePresetPayload({ provider: "openai", key: null, models: ["gpt-4o-mini"] });
    expect(cleared).toEqual({ providerId: "openai", key: null, models: ["gpt-4o-mini"] });
  });

  it("rejects bad preset payloads with typed errors", () => {
    expect(validatePresetPayload({ provider: "nope", models: ["m"] })).toEqual({ error: "invalid-provider" });
    expect(validatePresetPayload({ models: ["m"] })).toEqual({ error: "invalid-provider" });
    expect(validatePresetPayload({ provider: "openai", displayName: "", models: ["m"] })).toEqual({ error: "invalid-display-name" });
    expect(validatePresetPayload({ provider: "openai", displayName: 7, models: ["m"] })).toEqual({ error: "invalid-display-name" });
    expect(validatePresetPayload({ provider: "openai", baseURL: "ftp://x", models: ["m"] })).toEqual({ error: "invalid-url" });
    expect(validatePresetPayload({ provider: "openai", key: 42, models: ["m"] })).toEqual({ error: "invalid-key" });
    expect(validatePresetPayload({ provider: "openai", models: [] })).toEqual({ error: "invalid-models" });
  });
});

describe("engine catalog reader", () => {
  // Fake mirror of @earendil-works/pi-ai/providers/all: getBuiltinModels(key)
  // returns entries {id, name?} and [] for an unknown key.
  const fakeCatalogModule = {
    getBuiltinModels(key: string): Array<{ id: string; name?: string }> {
      if (key === "deepseek") {
        return [
          { id: "deepseek-v4-flash" },
          { id: "deepseek-v4-pro" },
          { id: "deepseek-v4-flash-vision-exp", name: "Vision Exp" }
        ];
      }
      if (key === "openai") return [{ id: "gpt-4o-mini" }, { id: "gpt-4o", name: "GPT-4o" }];
      return [];
    }
  };

  it("lazily requires the engine catalog module and reads getBuiltinModels(provider)", async () => {
    const seen: string[] = [];
    const reader = createEngineCatalogReader((id) => { seen.push(id); return fakeCatalogModule; });
    const models = await reader.list("deepseek");
    expect(seen).toEqual(["@earendil-works/pi-ai/providers/all"]);
    expect(models).toEqual([
      { id: "deepseek-v4-flash" },
      { id: "deepseek-v4-pro" },
      { id: "deepseek-v4-flash-vision-exp", name: "Vision Exp" }
    ]);
  });

  it("reads a non-empty catalog for an allowlisted preset (openai)", async () => {
    const reader = createEngineCatalogReader(() => fakeCatalogModule);
    const models = await reader.list("openai");
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(models[1]?.name).toBe("GPT-4o");
  });

  it("returns [] for an unknown provider key (engine empty result has no fallback)", async () => {
    const reader = createEngineCatalogReader(() => fakeCatalogModule);
    expect(await reader.list("totally-unknown")).toEqual([]);
    expect(await reader.list("deepseek-official")).toEqual([]);
  });

  it("falls back to the pinned DeepSeek catalog (3 incl vision-exp) when require fails for deepseek", async () => {
    const reader = createEngineCatalogReader(() => { throw new Error("module not found"); });
    const models = await reader.list("deepseek");
    expect(models.map((m) => m.id)).toEqual([
      "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"
    ]);
  });

  it("returns [] for a non-deepseek key when require fails", async () => {
    const reader = createEngineCatalogReader(() => { throw new Error("module not found"); });
    expect(await reader.list("openai")).toEqual([]);
  });
});

describe("catalog route mapping", () => {
  it("maps the deepseek-official route to the engine deepseek catalog key", () => {
    expect(catalogKeyForRoute(DEEPSEEK_OFFICIAL_ROUTE)).toBe("deepseek");
  });

  it("keeps preset provider ids as their own catalog key", () => {
    expect(catalogKeyForRoute("openai")).toBe("openai");
    expect(catalogKeyForRoute("opencode")).toBe("opencode");
  });

  it("passes unknown/custom route ids through to the reader (which returns [])", () => {
    expect(catalogKeyForRoute("my-gateway")).toBe("my-gateway");
    expect(catalogKeyForRoute("totally-unknown")).toBe("totally-unknown");
  });

  it("allowlists deepseek-official and the preset providers as catalog providers", () => {
    expect(isCatalogProvider(DEEPSEEK_OFFICIAL_ROUTE)).toBe(true);
    expect(isCatalogProvider("openai")).toBe(true);
    expect(isCatalogProvider("opencode")).toBe(true);
    expect(isCatalogProvider("my-gateway")).toBe(false);
    expect(isCatalogProvider("totally-unknown")).toBe(false);
  });
});
