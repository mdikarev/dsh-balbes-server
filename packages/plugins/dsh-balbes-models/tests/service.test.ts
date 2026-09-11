import { describe, expect, it } from "vitest";
import { createModelsService, ModelsServiceError } from "../src/service.js";
import { DEEPSEEK_OFFICIAL_MODELS } from "../src/models.js";

const LLM_PI_AI_NS = "llm-pi-ai";

function makeSettings(providers: Record<string, unknown>) {
  const sections: Record<string, unknown> = { [LLM_PI_AI_NS]: { providers } };
  return {
    sections,
    get: (ns: string): unknown => sections[ns],
    async replace(ns: string, section: object): Promise<void> {
      sections[ns] = section;
    }
  };
}

function makeCredentials(configured: string[] = []) {
  return {
    async describe(ref: string) {
      return { configured: configured.includes(ref), writable: true };
    },
    async set(): Promise<void> {},
    async unset(): Promise<void> {}
  };
}

function makeDefault(provider: string, model: string) {
  let current = { provider, model };
  return {
    currentSelection: () => current,
    async saveSelection(next: { provider: string; model: string }): Promise<void> {
      current = next;
    }
  };
}

describe("balbesModels service", () => {
  it("lists the official route plus configured connections and marks the default", async () => {
    const service = createModelsService({
      settings: makeSettings({ openai: { displayName: "OpenAI", apiKeyEnv: "BALBES_OPENAI_API_KEY", models: [{ id: "gpt-4o" }] } }),
      credentials: makeCredentials(["DEEPSEEK_API_KEY", "BALBES_OPENAI_API_KEY"]),
      defaultModel: makeDefault("deepseek-official", "deepseek-v4-flash"),
      reader: { list: () => [{ id: "deepseek-v4-pro" }] }
    });

    const connections = await service.list();

    expect(connections[0]).toMatchObject({ routeId: "deepseek-official", kind: "deepseek", hasKey: true, isDefault: true });
    expect(connections[0]!.models).toEqual(["deepseek-v4-pro"]);
    expect(connections[1]).toMatchObject({ routeId: "openai", kind: "preset", hasKey: true, isDefault: false, models: ["gpt-4o"] });
    expect(service.current()).toEqual({ provider: "deepseek-official", model: "deepseek-v4-flash" });
  });

  it("saves a model that the connection offers", async () => {
    const defaultModel = makeDefault("deepseek-official", "deepseek-v4-flash");
    const service = createModelsService({
      settings: makeSettings({ openai: { displayName: "OpenAI", apiKeyEnv: "BALBES_OPENAI_API_KEY", models: [{ id: "gpt-4o" }] } }),
      credentials: makeCredentials(["BALBES_OPENAI_API_KEY"]),
      defaultModel,
      reader: { list: () => [] }
    });

    await expect(service.saveDefault("openai", "gpt-4o")).resolves.toEqual({ provider: "openai", model: "gpt-4o" });
    expect(defaultModel.currentSelection()).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("refuses an unknown connection and a model the connection does not offer", async () => {
    const service = createModelsService({
      settings: makeSettings({ openai: { displayName: "OpenAI", apiKeyEnv: "BALBES_OPENAI_API_KEY", models: [{ id: "gpt-4o" }] } }),
      credentials: makeCredentials(),
      defaultModel: makeDefault("deepseek-official", "deepseek-v4-flash"),
      reader: { list: () => [] }
    });

    const unknown = await service.saveDefault("nope", "m").then(() => null, (e: unknown) => e as ModelsServiceError);
    expect(unknown?.code).toBe("invalid-route");
    const badModel = await service.saveDefault("openai", "nope").then(() => null, (e: unknown) => e as ModelsServiceError);
    expect(badModel?.code).toBe("invalid-model");
  });

  it("keeps the engine's own default model inside its connection's catalog and re-savable", async () => {
    // Anti-desync invariant (dsh 0.1.5 default is deepseek-flash): models.list
    // must expose the engine default inside its own connection, and saving that
    // same default must not fail with invalid-model.
    const defaultModel = makeDefault("deepseek-official", "deepseek-flash");
    const service = createModelsService({
      settings: makeSettings({}),
      credentials: makeCredentials(),
      defaultModel,
      reader: { list: () => DEEPSEEK_OFFICIAL_MODELS }
    });

    const connections = await service.list();
    const deepseek = connections.find((c) => c.routeId === "deepseek-official");
    expect(deepseek?.models).toContain(defaultModel.currentSelection().model);
    await expect(service.saveDefault("deepseek-official", "deepseek-flash")).resolves.toEqual({
      provider: "deepseek-official",
      model: "deepseek-flash"
    });
  });
});
