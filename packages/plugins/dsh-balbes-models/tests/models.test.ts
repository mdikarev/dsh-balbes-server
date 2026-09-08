import { describe, expect, it } from "vitest";
import {
  routeIdFromName, refNameForRoute, validateBaseUrl, parseModelIds,
  validateCustomPayload, DEEPSEEK_OFFICIAL_MODELS
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

  it("exposes the pinned official DeepSeek catalog (dsh 0.1.2-rc.1)", () => {
    expect(DEEPSEEK_OFFICIAL_MODELS.map((m) => m.id)).toContain("deepseek-v4-flash");
    expect(DEEPSEEK_OFFICIAL_MODELS.map((m) => m.id)).toContain("deepseek-v4-pro");
  });
});
