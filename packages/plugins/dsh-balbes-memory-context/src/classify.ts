import { BlockAssembler, createUserMessage, type StreamChunk } from "@deepseek-ai/dsh-llm";

export type ClassifiedScope = "global" | "project";
export type ClassifyScope = (text: string, projectName: string) => Promise<ClassifiedScope | undefined>;

// The budget must survive a reasoning model spending tokens before it emits the
// single word: a truncated answer yields no text block, and the silent fallback
// to the current project would disable global promotion for every write.
export const CLASSIFY_MAX_TOKENS = 64;
export const CLASSIFY_TIMEOUT_MS = 5000;

export const CLASSIFY_SYSTEM_PROMPT =
  "You classify exactly one memory candidate for a long-term memory store. " +
  "Answer with exactly one word: global or project. " +
  "Answer global when the fact is about the owner or the system as a whole and applies to every project. " +
  "Answer project when the fact is specific to the named project. " +
  "Facts about the owner themselves, such as their language, preferences, general rules or environment, " +
  "are global. " +
  "Facts about the named project's code, deployment, data or conventions are project. " +
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
      const parsed = parseScopeAnswer(answer);
      if (parsed === undefined) {
        // Surface every unusable answer: the daemon only shows warn, and a silent
        // fallback to the current project hides a disabled global promotion.
        // Neither the fact text nor the raw answer may be logged.
        logger?.warn(
          answer.trim() === ""
            ? "balbes-memory-context: scope classification produced no answer text; " +
                "falling back to the current project"
            : "balbes-memory-context: scope classification answer was unusable (" +
                answer.length +
                " chars); falling back to the current project"
        );
      }
      return parsed;
    } catch (error) {
      // Only a bounded identifier: provider error messages can echo the request,
      // and the request embeds the memory text.
      logger?.warn(
        "balbes-memory-context: scope classification failed: " +
          (error instanceof Error ? error.name : typeof error)
      );
      return undefined;
    }
  };
}
