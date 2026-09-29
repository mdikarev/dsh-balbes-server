import type { MemoryRecord, MemoryScope } from "dsh-balbes-contracts";
import { createLlmClassifier, type LlmClassifierSeat } from "./classify.js";
import { buildFtsQuery } from "./query.js";
import { buildRememberTool } from "./remember.js";
import { escapeInterpolation, renderCore, renderMap, renderPush } from "./render.js";
import { buildRecallTool } from "./recall.js";
import type {
  BalbesMemoryContextService,
  BalbesMemoryReadSlice,
  MemoryContextScope,
  MemoryWriteContext,
  MemoryWriteSlice
} from "./types.js";

export const MEMORY_SECTION_NAME = "balbes:memory";
export const MEMORY_SECTION_ORDER = 120;
export const MEMORY_CONTEXT_NAME = "balbes:memory-push";
export const MEMORY_CONTEXT_ORDER = 200;
const LIST_LIMIT = 500;
const PUSH_SEARCH_LIMIT = 5;

interface SystemPromptSeatLike {
  section(section: { name: string; order: number; text: () => string }): () => void;
  context(context: { name: string; order: number; text: () => string }): () => void;
}
interface ToolSeatLike {
  register(definition: unknown): () => void;
}
interface AgentCtxLike {
  get(key: string): unknown;
}
export interface MemoryContextLogger {
  warn(message: string): void;
  info?(message: string): void;
}

/** Scope-фильтр чтений: дом всегда, проект — только текущий. */
export function scopesFor(scope: MemoryContextScope): MemoryScope[] {
  return scope.kind === "global" ? [{ kind: "global" }] : [{ kind: "global" }, { kind: "project", name: scope.name }];
}

function scopeTag(scope: MemoryContextScope): string {
  return scope.kind === "global" ? "global" : "project:" + scope.name;
}

export function createMemoryContext(logger: MemoryContextLogger): BalbesMemoryContextService {
  return {
    attach(agentCtx: unknown, scope: MemoryContextScope, write?: MemoryWriteContext) {
      const ctx = agentCtx as AgentCtxLike;
      const memory = ctx.get("balbesMemory") as BalbesMemoryReadSlice | undefined;
      const llm = ctx.get("llm") as LlmClassifierSeat | undefined;
      const systemPrompt = ctx.get("systemPrompt") as SystemPromptSeatLike | undefined;
      const tools = ctx.get("tools") as ToolSeatLike | undefined;
      if (memory === undefined || systemPrompt === undefined || tools === undefined) {
        logger.warn("balbes-memory-context: balbesMemory/systemPrompt/tools missing; memory delivery disabled");
        return { prepare: async (): Promise<void> => {} };
      }
      const scopes = scopesFor(scope);
      const state = { coreMap: "", push: "" };
      systemPrompt.section({ name: MEMORY_SECTION_NAME, order: MEMORY_SECTION_ORDER, text: () => state.coreMap });
      systemPrompt.context({ name: MEMORY_CONTEXT_NAME, order: MEMORY_CONTEXT_ORDER, text: () => state.push });
      tools.register(buildRecallTool(memory, scopes));
      const writable = memory as BalbesMemoryReadSlice & Partial<MemoryWriteSlice>;
      if (typeof writable.save === "function" && write !== undefined) {
        const classify =
          llm !== undefined && write.selection !== undefined
            ? createLlmClassifier(llm, write.selection, logger)
            : undefined;
        tools.register(buildRememberTool(writable as MemoryWriteSlice, scope, write, classify, logger));
      }
      return {
        async prepare(taskText: string): Promise<void> {
          try {
            const [records, total] = await Promise.all([
              memory.list({ scopes, limit: LIST_LIMIT }),
              memory.count({ scopes })
            ]);
            const core = renderCore(records.filter((record: MemoryRecord) => record.pinned));
            const coreShown = new Set(core.shown);
            const map = renderMap(records, total, coreShown);
            const query = buildFtsQuery(taskText);
            let push: { text: string; shown: string[] } = { text: "", shown: [] };
            if (query !== "") {
              const hits = await memory.search({ query, filter: { scopes }, limit: PUSH_SEARCH_LIMIT });
              push = renderPush(hits, coreShown);
            }
            state.coreMap = escapeInterpolation([core.text, map.text].filter((text) => text !== "").join("\n\n"));
            state.push = escapeInterpolation(push.text);
            logger.info?.(
              "balbes-memory-context: scope=" + scopeTag(scope) +
                " core=" + core.shown.length +
                " map=" + map.shown.length +
                " push=" + push.shown.length
            );
          } catch (error) {
            logger.warn("balbes-memory-context: prepare failed: " + (error instanceof Error ? error.message : String(error)));
            state.coreMap = "";
            state.push = "";
          }
        }
      };
    }
  };
}
