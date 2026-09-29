import { defineTool } from "@deepseek-ai/dsh-tools";
import type { MemoryRecord, MemoryScope } from "dsh-balbes-contracts";
import type { ClassifiedScope, ClassifyScope } from "./classify.js";
import type { MemoryContextScope, MemoryWriteContext, MemoryWriteSlice } from "./types.js";

export function resolveWriteScope(
  scope: MemoryContextScope,
  classified: ClassifiedScope | undefined
): MemoryScope {
  if (scope.kind === "global") return { kind: "global" };
  return classified === "global" ? { kind: "global" } : { kind: "project", name: scope.name };
}

export const REMEMBER_DEFAULT_TYPE = "note";
const TYPES = ["fact", "preference", "decision", "note"] as const;

const DESCRIPTION =
  "Save one durable fact to the owner's long-term memory. Use it when knowledge worth keeping " +
  "across sessions or projects appears during the task. The layer chooses where it is stored. " +
  "Do not save secrets, credentials, or one-off task details.";

export function buildRememberTool(
  memory: MemoryWriteSlice,
  scope: MemoryContextScope,
  write: MemoryWriteContext,
  classify: ClassifyScope | undefined,
  logger?: { warn(message: string): void; info?(message: string): void }
) {
  const originRef = write.channel + " session:" + write.sessionId;
  return defineTool({
    name: "remember",
    description: DESCRIPTION,
    parameters: {
      text: { type: "string", required: true, description: "The knowledge to save as one self-contained statement." },
      type: {
        type: "string",
        enum: [...TYPES],
        description: "Optional knowledge type; defaults to note."
      },
      tags: { type: "array", items: { type: "string" }, description: "Optional short tags." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          record: {
            type: "object",
            required: true,
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
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: { kind: { type: "string", required: true } }
                  },
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
      },
      render: (_args, value) => {
        const record = value.record as unknown as MemoryRecord;
        const target = record.scope.kind === "global" ? "global" : "project " + record.scope.name;
        return [
          {
            type: "text",
            text:
              "Saved to " + target + " as " + record.type + " (id: " + record.id +
              ", origin: agent · " + (record.originRef ?? "") + ")."
          }
        ];
      }
    },
    execute: async (args) => {
      const type = args.type ?? REMEMBER_DEFAULT_TYPE;
      let classified: "global" | "project" | undefined;
      if (scope.kind === "project" && classify !== undefined) {
        try {
          classified = await classify(args.text, scope.name);
        } catch (error) {
          // Only a bounded identifier: a provider error can echo its request,
          // and the classifier request embeds the memory text.
          logger?.warn(
            "balbes-memory-context: scope classification failed: " +
              (error instanceof Error ? error.name : typeof error)
          );
          classified = undefined;
        }
      }
      const target = resolveWriteScope(scope, classified);
      try {
        const record = await memory.save({
          scope: target,
          type,
          text: args.text,
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          pinned: false,
          origin: "agent",
          originRef
        });
        logger?.info?.(
          "balbes-memory-context: remember channel=" + write.channel +
            " scope=" + (target.kind === "global" ? "global" : target.name) +
            " classified=" + (classified !== undefined)
        );
        return { record };
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (code === "secret-detected") throw new Error("remember rejected: text looks like a secret");
        throw new Error("remember failed: " + (error instanceof Error ? error.message : String(error)));
      }
    }
  });
}
