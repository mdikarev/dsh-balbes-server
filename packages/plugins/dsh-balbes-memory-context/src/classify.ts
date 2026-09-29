import { BlockAssembler, createUserMessage, type StreamChunk } from "@deepseek-ai/dsh-llm";

export type ClassifiedScope = "global" | "project";
export type ClassifyScope = (text: string, projectName: string) => Promise<ClassifiedScope | undefined>;

export const CLASSIFY_MAX_TOKENS = 16;
export const CLASSIFY_TIMEOUT_MS = 5000;

export const CLASSIFY_SYSTEM_PROMPT =
  "You classify exactly one memory candidate for a long-term memory store. " +
  "Answer with exactly one word: global or project. " +
  "Answer global when the fact is about the owner or the system as a whole and applies to every project. " +
  "Answer project when the fact is specific to the named project. " +
  "Do not explain, do not add punctuation, do not answer anything else.";

export function classifyUserMessage(projectName: string, text: string): string {
  return "Project: " + projectName + "\nFact: " + text;
}

export function parseScopeAnswer(raw: string): ClassifiedScope | undefined {
  const matches = raw.toLowerCase().match(/\b(global|project)\b/g);
  if (matches === null || matches.length === 0) return undefined;
  const unique = new Set(matches);
  if (unique.size !== 1) return undefined;
  return unique.has("global") ? "global" : "project";
}

export interface LlmClassifierSeat {
  stream(options: {
    provider: string;
    model: string;
    system?: string;
    messages: unknown[];
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<StreamChunk>;
}

export function createLlmClassifier(
  llm: LlmClassifierSeat,
  selection: { provider: string; model: string },
  logger?: { warn(message: string): void },
  timeoutMs: number = CLASSIFY_TIMEOUT_MS
): ClassifyScope {
  return async (text: string, projectName: string): Promise<ClassifiedScope | undefined> => {
    try {
      const assembler = new BlockAssembler();
      const options = {
        provider: selection.provider,
        model: selection.model,
        system: CLASSIFY_SYSTEM_PROMPT,
        messages: [
          createUserMessage({
            content: [{ type: "text", text: classifyUserMessage(projectName, text) }],
            source: { kind: "user" }
          })
        ],
        maxTokens: CLASSIFY_MAX_TOKENS,
        signal: AbortSignal.timeout(timeoutMs)
      };
      for await (const chunk of llm.stream(options)) assembler.push(chunk);
      const answer = assembler
        .blocks()
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join(" ");
      return parseScopeAnswer(answer);
    } catch (error) {
      logger?.warn(
        "balbes-memory-context: scope classification failed: " +
          (error instanceof Error ? error.message : String(error))
      );
      return undefined;
    }
  };
}
