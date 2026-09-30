import { defineTool } from "@deepseek-ai/dsh-tools";
import type { MemoryRecord, MemoryScope } from "dsh-balbes-contracts";
import type { BalbesMemoryReadSlice, MemoryRecallEvent } from "./types.js";
import { buildFtsQuery } from "./query.js";
import { originLabel, scopeLabel } from "./render.js";

export const RECALL_DEFAULT_LIMIT = 10;
export const RECALL_MAX_LIMIT = 20;

const TYPES = ["fact", "preference", "decision", "note"] as const;

const DESCRIPTION =
  "Search the owner's long-term memory and return the matching records with provenance. " +
  "Use it when the task may depend on knowledge remembered from earlier sessions or projects. " +
  "The search covers the agent home and the current project only.";

export function clampRecallLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return RECALL_DEFAULT_LIMIT;
  return Math.min(RECALL_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function renderRecord(record: MemoryRecord, index: number): string {
  const tags = record.tags.length === 0 ? "" : " · теги: " + record.tags.join(", ");
  const originRef = record.originRef === null ? "" : " · originRef: " + record.originRef;
  return (
    "[" + (index + 1) + "] " + record.type + " · " + originLabel(record) + " · " + scopeLabel(record.scope) +
    " · обновлено " + record.updatedAt + tags + "\n" + record.text + "\nid: " + record.id + originRef
  );
}

/** Структурный срез агрегатора метрик: инструмент пишет только события recall. */
export interface MemoryRecallSink {
  recordRecall(event: MemoryRecallEvent): void;
}

export function buildRecallTool(
  memory: BalbesMemoryReadSlice,
  scopes: MemoryScope[],
  metrics?: MemoryRecallSink,
  tag?: { channel: string; scope: string }
) {
  return defineTool({
    name: "recall",
    description: DESCRIPTION,
    parameters: {
      query: { type: "string", required: true, description: "What to look for, in natural language." },
      type: { type: "string", enum: [...TYPES], description: "Optional knowledge type filter." },
      tag: { type: "string", description: "Optional exact tag filter." },
      pinned: { type: "boolean", description: "Optional filter for pinned records only." },
      limit: {
        type: "integer",
        description: "Maximum records to return (default " + RECALL_DEFAULT_LIMIT + ", max " + RECALL_MAX_LIMIT + ")."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          records: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                type: { type: "string", required: true },
                text: { type: "string", required: true },
                tags: { type: "array", required: true, items: { type: "string" } },
                pinned: { type: "boolean", required: true },
                origin: { type: "string", required: true },
                originRef: { oneOf: [{ type: "string" }, { type: "null" }] },
                createdAt: { type: "string", required: true },
                updatedAt: { type: "string", required: true },
                scope: {
                  oneOf: [
                    { type: "object", additionalProperties: false, properties: { kind: { type: "string", required: true } } },
                    {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        kind: { type: "string", required: true },
                        name: { type: "string", required: true }
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const records = value.records as unknown as MemoryRecord[];
        return [
          {
            type: "text",
            text:
              records.length === 0
                ? "No memory records match."
                : records.map((record, index) => renderRecord(record, index)).join("\n\n")
          }
        ];
      }
    },
    execute: async (args) => {
      const channel = tag?.channel ?? "unknown";
      const scopeTag = tag?.scope ?? "unknown";
      const query = buildFtsQuery(args.query);
      if (query === "") {
        metrics?.recordRecall({ channel, scope: scopeTag, outcome: "empty", latencyMs: 0 });
        return { records: [] };
      }
      const filter: { scopes: MemoryScope[]; type?: MemoryRecord["type"]; tag?: string; pinned?: boolean } = {
        scopes
      };
      if (args.type !== undefined) filter.type = args.type;
      if (args.tag !== undefined) filter.tag = args.tag;
      if (args.pinned !== undefined) filter.pinned = args.pinned;
      const startedAt = performance.now();
      try {
        const hits = await memory.search({ query, filter, limit: clampRecallLimit(args.limit) });
        const latencyMs = performance.now() - startedAt;
        const records = hits.map((hit) => hit.record);
        metrics?.recordRecall({
          channel,
          scope: scopeTag,
          outcome: records.length === 0 ? "empty" : "ok",
          latencyMs,
          delivered: records.map((record) => record.id),
          records: Object.fromEntries(records.map((record) => [record.id, { type: record.type, scope: scopeTag }]))
        });
        return { records };
      } catch {
        metrics?.recordRecall({ channel, scope: scopeTag, outcome: "failed", latencyMs: performance.now() - startedAt });
        throw new Error("recall failed: memory search is unavailable");
      }
    }
  });
}
