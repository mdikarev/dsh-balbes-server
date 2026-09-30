import { defineTool } from "@deepseek-ai/dsh-tools";
import type { MemoryProposal, MemoryScope } from "dsh-balbes-contracts";
import { resolveWriteScope } from "./remember.js";
import type {
  MemoryContextScope,
  MemoryExtractionSlice,
  MemoryProposalSlice,
  MemoryWriteContext
} from "./types.js";

export const EXTRACTION_MAX_PROPOSALS = 3;
export const DEDUP_LIST_LIMIT = 500;
export const EXTRACTION_NOTICE_SUMMARY = "memory extraction";
const TYPES = ["fact", "preference", "decision", "note"] as const;

/**
 * Фиксированная директива служебного хода: текст задачи и ответ в неё не
 * подставляются — ход и так несёт всю сессию.
 */
export const EXTRACTION_DIRECTIVE = [
  "Служебный шаг после успешной задачи — извлечение долговременного знания.",
  "Если в этой задаче появилось знание, полезное в будущих сессиях (факт о проекте",
  "или владельце, предпочтение владельца, принятое решение), предложи его",
  "инструментом propose_memory — по одному вызову на единицу знания, не больше",
  "трёх за шаг. Предложения уходят владельцу в очередь ревью; в память сразу",
  "ничего не пишется. Не предлагай секреты, credentials, разовые детали задачи и",
  "то, что уже есть в памяти. Если достойного знания нет — инструмент не вызывай",
  "и ответь одной строкой."
].join(" ");

const DESCRIPTION =
  "Propose one durable piece of knowledge for the owner's review. Use it only during the " +
  "extraction turn, once per unit of knowledge. The owner approves or rejects the proposal " +
  "in the review queue; nothing is written into memory immediately.";

/** Идентичность текста для входного дедупа: регистр и пробелы не значимы. */
export function normalizeProposalText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ExtractionCounters {
  proposed: number;
  duplicate: number;
  secret: number;
  limit: number;
}

export function createExtractionCounters(): ExtractionCounters {
  return { proposed: 0, duplicate: 0, secret: 0, limit: 0 };
}

export interface ProposalIndex {
  has(normalized: string): boolean;
  add(normalized: string): void;
}

export function createProposalIndex(seed: Iterable<string> = []): ProposalIndex {
  const seen = new Set(seed);
  return {
    has: (normalized) => seen.has(normalized),
    add: (normalized) => {
      seen.add(normalized);
    }
  };
}

/**
 * Дедуп — удобство, а не барьер безопасности (секреты и валидацию держит
 * `propose`), поэтому сбой чтения индекса деградирует в «без дедупа» с warn.
 */
export async function loadProposalIndex(
  memory: MemoryExtractionSlice,
  scopes: MemoryScope[],
  logger: { warn(message: string): void }
): Promise<ProposalIndex> {
  const seed: string[] = [];
  try {
    const records = await memory.list({ scopes, limit: DEDUP_LIST_LIMIT });
    for (const record of records) seed.push(normalizeProposalText(record.text));
    for (const scope of scopes) {
      const proposals = await memory.listProposals({ scope, status: ["proposed"], limit: DEDUP_LIST_LIMIT });
      for (const proposal of proposals) seed.push(normalizeProposalText(proposal.text));
    }
  } catch {
    logger.warn("balbes-memory-context: extraction dedup index unavailable; proposing without dedup");
  }
  return createProposalIndex(seed);
}

/** Ровно те свойства предложения, что объявлены в схеме вывода (additionalProperties: false). */
interface ProposalView {
  id: string;
  scope: MemoryScope;
  type: MemoryProposal["type"];
  text: string;
  tags: string[];
  originRef: string | null;
  proposedAt: string;
}

function proposalOutput(proposal: MemoryProposal): ProposalView {
  return {
    id: proposal.id,
    scope: proposal.scope,
    type: proposal.type,
    text: proposal.text,
    tags: proposal.tags,
    originRef: proposal.originRef,
    proposedAt: proposal.proposedAt
  };
}

export function buildProposeTool(
  memory: MemoryProposalSlice,
  scope: MemoryContextScope,
  write: MemoryWriteContext,
  counters: ExtractionCounters,
  loadIndex: () => Promise<ProposalIndex>
) {
  const originRef = write.channel + " session:" + write.sessionId;
  let index: ProposalIndex | undefined;
  return defineTool({
    name: "propose_memory",
    description: DESCRIPTION,
    parameters: {
      text: { type: "string", required: true, description: "The knowledge to propose as one self-contained statement." },
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
          status: { type: "string", required: true },
          proposal: {
            required: true,
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", required: true },
                  type: { type: "string", required: true },
                  text: { type: "string", required: true },
                  tags: { type: "array", required: true, items: { type: "string" } },
                  originRef: { oneOf: [{ type: "string" }, { type: "null" }] },
                  proposedAt: { type: "string", required: true },
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
              },
              { type: "null" }
            ]
          }
        }
      },
      render: (_args, value) => {
        const proposal = value.proposal as unknown as MemoryProposal | null;
        if (proposal === null || proposal === undefined) {
          return [{ type: "text", text: "Уже известно (точное совпадение) — предложение не создано." }];
        }
        const target = proposal.scope.kind === "global" ? "global" : "project " + proposal.scope.name;
        return [
          {
            type: "text",
            text:
              "Предложено на ревью: " + proposal.type + " · " + target + " (id: " + proposal.id +
              ", originRef: " + (proposal.originRef ?? "") +
              "). Запись появится только после одобрения владельцем."
          }
        ];
      }
    },
    execute: async (args) => {
      if (counters.proposed >= EXTRACTION_MAX_PROPOSALS) {
        counters.limit += 1;
        throw new Error(
          "propose_memory: extraction limit reached (" + EXTRACTION_MAX_PROPOSALS + " proposals per turn)"
        );
      }
      if (index === undefined) index = await loadIndex();
      const normalized = normalizeProposalText(args.text);
      if (index.has(normalized)) {
        counters.duplicate += 1;
        return { status: "duplicate", proposal: null };
      }
      const type = args.type ?? "note";
      try {
        const proposal = await memory.propose({
          scope: resolveWriteScope(scope, undefined),
          type,
          text: args.text,
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          originRef
        });
        counters.proposed += 1;
        index.add(normalized);
        return { status: "proposed", proposal: proposalOutput(proposal) };
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (code === "secret-detected") {
          counters.secret += 1;
          throw new Error("propose_memory rejected: text looks like a secret");
        }
        throw new Error("propose_memory failed: " + (error instanceof Error ? error.message : String(error)));
      }
    }
  });
}
