import { describe, expect, it } from "vitest";
import { classifyUserMessage, parseScopeAnswer } from "../src/classify.js";

describe("parseScopeAnswer", () => {
  it("accepts a single clear word", () => {
    expect(parseScopeAnswer("global")).toBe("global");
    expect(parseScopeAnswer("project")).toBe("project");
    expect(parseScopeAnswer("  GLOBAL\n")).toBe("global");
  });

  it("accepts a one-word sentence", () => {
    expect(parseScopeAnswer("project.")).toBe("project");
  });

  it("rejects an ambiguous answer that names both scopes", () => {
    expect(parseScopeAnswer("not project-specific but global")).toBeUndefined();
  });

  it("rejects empty or unrelated text", () => {
    expect(parseScopeAnswer("")).toBeUndefined();
    expect(parseScopeAnswer("maybe later")).toBeUndefined();
  });
});

describe("classifyUserMessage", () => {
  it("carries the project name and the fact", () => {
    expect(classifyUserMessage("myproj", "deploy via install.sh")).toBe(
      "Project: myproj\nFact: deploy via install.sh"
    );
  });
});

import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import {
  CLASSIFY_MAX_TOKENS,
  createLlmClassifier,
  type LlmClassifierSeat
} from "../src/classify.js";

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "text-delta", index: 0, text },
    { type: "finish", reason: { kind: "stop" } }
  ];
}

function fakeLlm(
  chunks: StreamChunk[],
  onOptions?: (options: Record<string, unknown>) => void
): LlmClassifierSeat {
  return {
    stream(options: unknown) {
      onOptions?.(options as Record<string, unknown>);
      return (async function* (): AsyncGenerator<StreamChunk> {
        for (const chunk of chunks) yield chunk;
      })();
    }
  };
}

function throwingLlm(error: Error): LlmClassifierSeat {
  return {
    stream() {
      return (async function* (): AsyncGenerator<StreamChunk> {
        throw error;
      })();
    }
  };
}

describe("CLASSIFY_MAX_TOKENS", () => {
  it("leaves room for a reasoning model to spend tokens before the one-word answer", () => {
    // A budget that reasoning tokens can exhaust yields no text block, and the
    // silent fallback would disable global promotion for every project write.
    expect(CLASSIFY_MAX_TOKENS).toBeGreaterThanOrEqual(32);
  });
});

describe("createLlmClassifier", () => {
  it("returns the parsed scope and calls the model as a standalone one-shot", async () => {
    let seen: Record<string, unknown> | undefined;
    const classify = createLlmClassifier(
      fakeLlm(textChunks("global"), (options) => {
        seen = options;
      }),
      { provider: "p", model: "m" }
    );
    await expect(classify("owner prefers Russian", "myproj")).resolves.toBe("global");
    expect(seen).toMatchObject({ provider: "p", model: "m", maxTokens: CLASSIFY_MAX_TOKENS });
    expect(String(seen!.system)).toContain("global or project");
    expect(seen!.sessionId).toBeUndefined();
    expect(seen!.purpose).toBeUndefined();
  });

  it("tells the model that owner-level facts are global", async () => {
    let seen: Record<string, unknown> | undefined;
    const classify = createLlmClassifier(
      fakeLlm(textChunks("global"), (options) => {
        seen = options;
      }),
      { provider: "p", model: "m" }
    );
    await expect(classify("owner language is Russian", "myproj")).resolves.toBe("global");
    const system = String(seen!.system);
    expect(system).toContain("global or project");
    expect(system).toContain("owner");
  });

  it("returns undefined and warns when the stream throws", async () => {
    const warnings: string[] = [];
    const classify = createLlmClassifier(
      throwingLlm(new Error("provider down")),
      { provider: "p", model: "m" },
      { warn: (message) => warnings.push(message) }
    );
    await expect(classify("fact", "myproj")).resolves.toBeUndefined();
    expect(warnings.join("\n")).toContain("classification failed");
  });

  it("returns undefined for an empty or ambiguous answer", async () => {
    const classify = createLlmClassifier(fakeLlm(textChunks("")), { provider: "p", model: "m" });
    await expect(classify("fact", "myproj")).resolves.toBeUndefined();
  });

  it("warns once when the answer text is empty, without leaking the fact", async () => {
    const warnings: string[] = [];
    const fact = "основной язык владельца — русский";
    const classify = createLlmClassifier(
      fakeLlm(textChunks("   \n")),
      { provider: "p", model: "m" },
      { warn: (message) => warnings.push(message) }
    );
    await expect(classify(fact, "myproj")).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no answer text");
    expect(warnings.join("\n")).not.toContain(fact);
  });

  it("warns once with the unusable wording when the answer names no scope", async () => {
    const warnings: string[] = [];
    const answer = "maybe project or global, hard to say";
    const classify = createLlmClassifier(
      fakeLlm(textChunks(answer)),
      { provider: "p", model: "m" },
      { warn: (message) => warnings.push(message) }
    );
    await expect(classify("fact", "myproj")).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unusable");
    expect(warnings.join("\n")).not.toContain(answer);
  });

  it("returns undefined when the call times out", async () => {
    const llm: LlmClassifierSeat = {
      stream(options) {
        return (async function* (): AsyncGenerator<StreamChunk> {
          await new Promise<void>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        })();
      }
    };
    const classify = createLlmClassifier(llm, { provider: "p", model: "m" }, undefined, 5);
    await expect(classify("fact", "myproj")).resolves.toBeUndefined();
  });
});
