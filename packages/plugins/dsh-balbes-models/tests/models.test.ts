import { describe, expect, it } from "vitest";
import {
  routeIdFromName, refNameForRoute, validateBaseUrl, parseModelIds,
  validateCustomPayload, DEEPSEEK_OFFICIAL_MODELS, DEEPSEEK_OFFICIAL_ROUTE,
  PI_AI_DEEPSEEK_MODELS, DEEPSEEK_NATIVE_MODELS, mergeModelCatalogs,
  PROVIDER_PRESETS, isPresetProviderId, validatePresetPayload,
  createEngineCatalogReader, catalogKeyForRoute, isCatalogProvider,
  type EngineCatalogLoader
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

  it("pins the 4-model official DeepSeek fallback catalog (native union pi-ai, native order)", () => {
    expect(DEEPSEEK_OFFICIAL_MODELS.map((m) => m.id)).toEqual([
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp"
    ]);
    expect(DEEPSEEK_OFFICIAL_MODELS.find((m) => m.id === "deepseek-flash")?.name).toBe("DeepSeek-V41-Flash");
    expect(DEEPSEEK_OFFICIAL_MODELS.find((m) => m.id === "deepseek-v4-flash-vision-exp")?.name).toBe("DeepSeek-V4-Flash-Vision-Exp");
  });

  it("pins both source catalogs the official fallback unions", () => {
    // pi-ai builtin deepseek catalog (3 ids), as returned by the installed
    // pi-ai 0.85.1: order flash, vision-exp, pro; names are space-separated.
    expect(PI_AI_DEEPSEEK_MODELS).toEqual([
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }
    ]);
    // native @deepseek-ai/dsh-llm-deepseek DEFAULT_MODELS (4 ids), the catalog
    // of the reserved route itself
    expect(DEEPSEEK_NATIVE_MODELS.map((m) => m.id)).toEqual([
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp"
    ]);
  });

  it("the pinned official catalog contains the dsh 0.1.5 fresh-profile engine default deepseek-flash", () => {
    // Regression guard for the models.list / models.default desync: the engine
    // default must always be resolvable inside its own connection's catalog.
    expect(DEEPSEEK_OFFICIAL_MODELS.map((m) => m.id)).toContain("deepseek-flash");
  });

  it("mergeModelCatalogs keeps a defined order and deduplicates by id (first occurrence wins)", () => {
    const first = [{ id: "x", name: "X-first" }, { id: "y" }];
    const second = [{ id: "y", name: "Y-second" }, { id: "z", name: "Z-second" }];
    expect(mergeModelCatalogs(first, second)).toEqual([
      { id: "x", name: "X-first" },
      { id: "y" },
      { id: "z", name: "Z-second" }
    ]);
    expect(mergeModelCatalogs([], second)).toEqual([{ id: "y", name: "Y-second" }, { id: "z", name: "Z-second" }]);
    expect(mergeModelCatalogs(first, [])).toEqual([{ id: "x", name: "X-first" }, { id: "y" }]);
    expect(mergeModelCatalogs()).toEqual([]);
    // entries are copies, not aliases of the input catalogs
    const merged = mergeModelCatalogs(first);
    merged[0]!.name = "mutated";
    expect(first[0]!.name).toBe("X-first");
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
  const ENGINE_MODULE = "@earendil-works/pi-ai/providers/all";
  const NATIVE_MODULE = "@deepseek-ai/dsh-llm-deepseek";

  // Fake mirror of @earendil-works/pi-ai/providers/all: getBuiltinModels(key)
  // returns entries {id, name?} and [] for an unknown key. The deepseek entry
  // mirrors the installed pi-ai 0.85.1 builtin catalog (order flash,
  // vision-exp, pro; space-separated names).
  const fakePiAi = {
    getBuiltinModels(key: string): Array<{ id: string; name?: string }> {
      if (key === "deepseek") {
        return [
          { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
          { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp" },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }
        ];
      }
      if (key === "openai") return [{ id: "gpt-4o-mini" }, { id: "gpt-4o", name: "GPT-4o" }];
      return [];
    }
  };

  // Fake mirror of @deepseek-ai/dsh-llm-deepseek: its public
  // resolveAdapterOptions seam returns the native 4-model DEFAULT_MODELS.
  const fakeNative = {
    resolveAdapterOptions(): { models: Array<{ id: string; name?: string }> } {
      return {
        models: [
          { id: "deepseek-flash", name: "DeepSeek-V41-Flash" },
          { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
          { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
          { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek-V4-Flash-Vision-Exp" }
        ]
      };
    }
  };

  /** Loader serving both fakes and recording every specifier it is asked for. */
  function loaderFor(seen: string[], native: unknown = fakeNative): EngineCatalogLoader {
    return (specifier: string) => {
      seen.push(specifier);
      return specifier === NATIVE_MODULE ? native : fakePiAi;
    };
  }

  it("unions the native and pi-ai catalogs for deepseek (native entries first, deduplicated)", async () => {
    const seen: string[] = [];
    const reader = createEngineCatalogReader(loaderFor(seen));
    const models = await reader.list("deepseek");
    expect(seen).toEqual([NATIVE_MODULE, ENGINE_MODULE]);
    expect(models).toEqual([
      { id: "deepseek-flash", name: "DeepSeek-V41-Flash" },
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
      { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek-V4-Flash-Vision-Exp" }
    ]);
  });

  it("appends a pi-ai-only deepseek id after the native entries, in pi-ai order", async () => {
    const native = {
      resolveAdapterOptions: () => ({
        models: [{ id: "deepseek-flash", name: "N-Flash" }, { id: "deepseek-v4-pro", name: "N-Pro" }]
      })
    };
    const reader = createEngineCatalogReader(loaderFor([], native));
    expect((await reader.list("deepseek")).map((m) => m.id)).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp"
    ]);
    // the appended pi-ai-only entry keeps the pi-ai name
    expect((await reader.list("deepseek")).find((m) => m.id === "deepseek-v4-flash")?.name).toBe("DeepSeek V4 Flash");
    expect((await reader.list("deepseek")).find((m) => m.id === "deepseek-v4-flash-vision-exp")?.name).toBe("DeepSeek V4 Flash Vision Exp");
  });

  it("keeps deepseek-flash (pinned native fallback) when the native catalog read throws", async () => {
    const reader = createEngineCatalogReader((specifier: string) => {
      if (specifier === NATIVE_MODULE) throw new Error("module not found");
      return fakePiAi;
    });
    expect((await reader.list("deepseek")).map((m) => m.id)).toEqual([
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp"
    ]);
  });

  it("falls back to the pinned native catalog when the native module has no usable seam", async () => {
    const reader = createEngineCatalogReader(loaderFor([], {}));
    expect(await reader.list("deepseek")).toEqual(DEEPSEEK_OFFICIAL_MODELS);
  });

  it("returns the pinned union catalog when both runtime reads fail", async () => {
    const reader = createEngineCatalogReader(() => { throw new Error("module not found"); });
    expect(await reader.list("deepseek")).toEqual(DEEPSEEK_OFFICIAL_MODELS);
  });

  it("reads a non-deepseek preset from pi-ai only and never loads the native module", async () => {
    const seen: string[] = [];
    const reader = createEngineCatalogReader(loaderFor(seen));
    const models = await reader.list("openai");
    expect(seen).toEqual([ENGINE_MODULE]);
    expect(models.map((m) => m.id)).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(models[1]?.name).toBe("GPT-4o");
  });

  it("returns [] for an unknown provider key (engine empty result has no fallback)", async () => {
    const reader = createEngineCatalogReader(loaderFor([]));
    expect(await reader.list("totally-unknown")).toEqual([]);
    expect(await reader.list("deepseek-official")).toEqual([]);
  });

  it("returns [] for a non-deepseek key when the pi-ai read fails", async () => {
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
