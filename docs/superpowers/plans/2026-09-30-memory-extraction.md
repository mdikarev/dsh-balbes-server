# Автоизвлечение знания из успешных задач (p10g) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** после успешной Telegram-задачи, в ходе которой агент вызывал инструменты, слой сам запускает служебный ход извлечения, и агент предлагает долговременное знание инструментом `propose_memory` — предложениями в очередь ревью, а не истиной.

**Architecture:** write-поверхность памяти агента (`remember` в задаче, `propose_memory` в извлечении) принадлежит пакету `dsh-balbes-memory-context`; канал Telegram владеет ходом (агент, очередь, отмена), поэтому шов — `attach(...).extraction` с `qualifies/begin/end`. Задача резолвится владельцу до служебного хода; `busy` держится до его конца, поэтому следующая задача ждёт в очереди.

**Tech Stack:** TypeScript (strict, ESM), Cordis-плагины dsh, `@deepseek-ai/dsh-tools` (`defineTool`, `tools.register`), vitest, pnpm workspaces; новых зависимостей нет.

**Spec:** `docs/superpowers/specs/2026-09-30-memory-extraction-design.md`
**Canon (уже поглощён, код обязан совпасть):** `docs/canon/ARCHITECTURE.md` → «Memory layer» → «Автоизвлечение знания (p10g)»; `docs/canon/GLOSSARY.md` → «Извлечение знания», «Служебный ход извлечения», `propose_memory`.

## Global Constraints

- Гейт (без вызовов модели): `ok === true` И в ходе задачи ≥ 1 вызов инструмента (`summarizeProgress(session, firstSeq).steps.length > 0`). Cooldown, расписания и явной команды нет.
- Потолок: не больше **3** предложений за служебный ход; следующий вызов инструмента отвечает ошибкой.
- Дедуп на входе: нормализованный точный текст (`trim().toLowerCase()` + схлопывание пробельных серий) против записей памяти (дом + текущий проект, лимит **500**) и ожидающих предложений тех же уровней; сбой чтения индекса — `warn` и продолжение без дедупа (fail-open).
- Уровень выбирает слой по scope задачи (`home` → `global`, проект → текущий проект). Классификатор уровня (p10e) в служебном ходе **не** вызывается.
- Инвариант политики: во время служебного хода `remember` снят, `propose_memory` зарегистрирован, `recall` остаётся. Восстановление поверхности — в `finally`, переживает сбой, отмену и сброс.
- Провенанс: `originRef = "<channel> session:<sessionId>"`; запись идёт только через `balbesMemory.propose`; `pinned` и `scope` — не параметры инструмента.
- Ответ владельцу выдаётся **до** извлечения; `busy` держится до конца служебного хода; глубина очереди (`QUEUE_MAX_WAITING = 3`) не меняется.
- Любая ошибка извлечения не меняет результат задачи: максимум `warn`. Срыв драйвера (`whenIdle` отверг) трактуется как испорченный агент: dispose + сброс привязки сессии, как в пути задачи.
- Никаких новых HTTP-ручек, миграций `memory.sqlite`, экранов, пунктов сайдбара и изменений `dsh-balbes-contracts`. Извлекает только Telegram; `POST /api/prompt` шов не вызывает.
- В журнал не попадают текст памяти, текст задачи и ответ: только канал, уровень и счётчики (`proposed/duplicate/secret/limit`).
- Тесты: unit — под `tests/` (vitest), REAL — за гейтом `RUN_REAL=1` **и** `dsh` в `PATH`; mock только LLM-провайдер, сеть, часы. Каждая задача заканчивается зелёными тестами и коммитом.
- Фокусированный прогон: `pnpm --filter <пакет> exec vitest run <фильтр>` — под pnpm 10 форма `pnpm --filter <пакет> test -- <фильтр>` передаёт `--` в vitest и запускает весь набор целиком.
- Runbook `docs/runbooks/stage2-vps.md` обновляется в том же коммите, что и функциональное изменение (Task 5).

---

## File Structure

| Файл | Ответственность |
|---|---|
| `packages/plugins/dsh-balbes-memory-context/src/propose.ts` (create) | Инструмент `propose_memory`, нормализация текста, индекс входного дедупа, счётчики, фиксированная директива |
| `packages/plugins/dsh-balbes-memory-context/src/types.ts` (modify) | Структурные срезы `propose`/`listProposals`, `MemoryExtractionHandle`, `extraction` на attachment |
| `packages/plugins/dsh-balbes-memory-context/src/context.ts` (modify) | Сборка extraction-места: гейт, `begin`/`end`, переключение поверхности, лог счётчиков |
| `packages/plugins/dsh-balbes-memory-context/tests/propose.test.ts` (create) | Юниты инструмента и дедупа |
| `packages/plugins/dsh-balbes-memory-context/tests/extraction.test.ts` (create) | Юниты места: гейт, переключение поверхности, идемпотентность, лог |
| `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` (modify) | Резолв задачи до извлечения, гейт, служебный ход, политика сбоя |
| `packages/plugins/dsh-balbes-telegram/tests/agentTask.extraction.test.ts` (create) | Юниты канала: гейт, порядок, изоляция сбоя, отмена |
| `packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-extraction-profile/` (create) | Отдельный REAL-профиль: telegram-набор + memory-ряды |
| `packages/plugins/dsh-balbes-telegram/tests/extraction.real.test.ts` (create) | REAL-сценарий извлечения (изолирован от набора апрувов) |
| `docs/runbooks/stage2-vps.md` (modify) | Smoke извлечения на сервере |

Ничего не меняется в `dsh-balbes-memory`, `dsh-balbes-memory-admin`, `dsh-balbes-host`, `dsh-balbes-contracts`, `profiles/balbes/cordis.patch.yml` и установщике (новый пакет не появляется).

---

### Task 1: инструмент `propose_memory` и входной дедуп

**Files:**
- Create: `packages/plugins/dsh-balbes-memory-context/src/propose.ts`
- Modify: `packages/plugins/dsh-balbes-memory-context/src/types.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/propose.test.ts`

**Interfaces:**
- Consumes: `resolveWriteScope(scope, classified)` из `./remember.js`; типы `MemoryProposal`, `MemoryRecord`, `MemoryScope` из `dsh-balbes-contracts`.
- Produces (для Task 2 и Task 3):
  - `EXTRACTION_MAX_PROPOSALS = 3`, `DEDUP_LIST_LIMIT = 500`, `EXTRACTION_NOTICE_SUMMARY = "memory extraction"`, `EXTRACTION_DIRECTIVE: string`
  - `normalizeProposalText(text: string): string`
  - `interface ExtractionCounters { proposed: number; duplicate: number; secret: number; limit: number }`, `createExtractionCounters(): ExtractionCounters`
  - `interface ProposalIndex { has(normalized: string): boolean; add(normalized: string): void }`, `createProposalIndex(seed?: Iterable<string>): ProposalIndex`
  - `loadProposalIndex(memory: MemoryExtractionSlice, scopes: MemoryScope[], logger: { warn(m: string): void }): Promise<ProposalIndex>`
  - `buildProposeTool(memory: MemoryProposalSlice, scope: MemoryContextScope, write: MemoryWriteContext, counters: ExtractionCounters, loadIndex: () => Promise<ProposalIndex>)`
  - типы `MemoryProposalDraft`, `MemoryProposalSlice`, `MemoryExtractionSlice` в `types.ts`

- [ ] **Step 1: Написать падающие тесты**

Create `packages/plugins/dsh-balbes-memory-context/tests/propose.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MemoryProposal, MemoryRecord } from "dsh-balbes-contracts";
import {
  buildProposeTool,
  createExtractionCounters,
  createProposalIndex,
  loadProposalIndex,
  normalizeProposalText,
  EXTRACTION_MAX_PROPOSALS
} from "../src/propose.js";
import type {
  MemoryContextScope,
  MemoryExtractionSlice,
  MemoryProposalDraft,
  MemoryProposalSlice
} from "../src/types.js";

function proposal(partial: Partial<MemoryProposal>): MemoryProposal {
  return {
    id: "p1",
    scope: { kind: "global" },
    type: "note",
    text: "fact",
    tags: [],
    origin: "agent",
    originRef: null,
    status: "proposed",
    proposedAt: "2026-09-30T00:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    decidedEdit: false,
    memoryId: null,
    ...partial
  };
}

function record(partial: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    scope: { kind: "global" },
    type: "fact",
    tags: [],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...partial
  };
}

function harness(options: { scope?: MemoryContextScope; seed?: string[]; fail?: Error } = {}) {
  const drafts: MemoryProposalDraft[] = [];
  const memory: MemoryProposalSlice = {
    propose: async (draft) => {
      if (options.fail !== undefined) throw options.fail;
      drafts.push(draft);
      return proposal({ scope: draft.scope, type: draft.type, text: draft.text, originRef: draft.originRef ?? null });
    },
    listProposals: async () => []
  };
  const counters = createExtractionCounters();
  const tool = buildProposeTool(
    memory,
    options.scope ?? { kind: "global" },
    { channel: "telegram", sessionId: "s1" },
    counters,
    async () => createProposalIndex(options.seed ?? [])
  );
  return { tool, drafts, counters };
}

describe("buildProposeTool", () => {
  it("has no scope or pinned parameter", () => {
    const { tool } = harness({});
    const parameters = JSON.stringify(tool.parameters);
    expect(parameters).not.toContain("scope");
    expect(parameters).not.toContain("pinned");
  });

  it("proposes through the review path with the channel provenance", async () => {
    const { tool, drafts, counters } = harness({});
    const value = await tool.execute({ text: "Деплой в пятницу", type: "fact", tags: ["deploy"] }, {} as never);
    expect(drafts).toEqual([
      {
        scope: { kind: "global" },
        type: "fact",
        text: "Деплой в пятницу",
        tags: ["deploy"],
        originRef: "telegram session:s1"
      }
    ]);
    expect(counters.proposed).toBe(1);
    expect(value.status).toBe("proposed");
    expect((value.proposal as unknown as MemoryProposal).id).toBe("p1");
  });

  it("keeps a project fact in the current project scope", async () => {
    const { tool, drafts } = harness({ scope: { kind: "project", name: "myproj" } });
    await tool.execute({ text: "в проекте свой деплой" }, {} as never);
    expect(drafts[0]).toMatchObject({ scope: { kind: "project", name: "myproj" }, type: "note" });
  });

  it("skips a normalized exact duplicate of a known text", async () => {
    const { tool, drafts, counters } = harness({ seed: [normalizeProposalText("Deploy  is  Friday")] });
    const value = await tool.execute({ text: "deploy is friday" }, {} as never);
    expect(value.status).toBe("duplicate");
    expect(value.proposal).toBeNull();
    expect(drafts).toHaveLength(0);
    expect(counters.duplicate).toBe(1);
  });

  it("remembers its own proposal so a repeat in one turn is a duplicate", async () => {
    const { tool, drafts, counters } = harness({});
    await tool.execute({ text: "Одно и то же" }, {} as never);
    const again = await tool.execute({ text: "  одно   и то же " }, {} as never);
    expect(again.status).toBe("duplicate");
    expect(drafts).toHaveLength(1);
    expect(counters).toEqual({ proposed: 1, duplicate: 1, secret: 0, limit: 0 });
  });

  it("caps one turn at three proposals", async () => {
    const { tool, drafts, counters } = harness({});
    for (let index = 0; index < EXTRACTION_MAX_PROPOSALS; index += 1) {
      await tool.execute({ text: "факт " + index }, {} as never);
    }
    await expect(tool.execute({ text: "четвёртый" }, {} as never)).rejects.toThrow(
      "propose_memory: extraction limit reached (3 proposals per turn)"
    );
    expect(drafts).toHaveLength(EXTRACTION_MAX_PROPOSALS);
    expect(counters).toEqual({ proposed: 3, duplicate: 0, secret: 0, limit: 1 });
  });

  it("rejects a secret candidate and keeps counting the turn", async () => {
    const { tool, drafts, counters } = harness({
      fail: Object.assign(new Error("looks like a key"), { code: "secret-detected" })
    });
    await expect(tool.execute({ text: "sk-secret" }, {} as never)).rejects.toThrow(
      "propose_memory rejected: text looks like a secret"
    );
    expect(drafts).toHaveLength(0);
    expect(counters.secret).toBe(1);
    expect(counters.proposed).toBe(0);
  });

  it("surfaces a store failure as a stable tool error", async () => {
    const { tool } = harness({ fail: new Error("db down") });
    await expect(tool.execute({ text: "факт" }, {} as never)).rejects.toThrow("propose_memory failed: db down");
  });
});

describe("loadProposalIndex", () => {
  it("seeds from records and from pending proposals of both scopes", async () => {
    const calls: unknown[] = [];
    const memory: MemoryExtractionSlice = {
      propose: async () => proposal({}),
      list: async (filter) => {
        calls.push(filter);
        return [record({ id: "r1", text: "Из памяти" })];
      },
      listProposals: async (filter) => {
        calls.push(filter);
        return [proposal({ text: "Из очереди" })];
      }
    };
    const warnings: string[] = [];
    const index = await loadProposalIndex(
      memory,
      [{ kind: "global" }, { kind: "project", name: "myproj" }],
      { warn: (message) => warnings.push(message) }
    );
    expect(index.has(normalizeProposalText("из памяти"))).toBe(true);
    expect(index.has(normalizeProposalText("из очереди"))).toBe(true);
    expect(index.has(normalizeProposalText("чего-то другого"))).toBe(false);
    expect(warnings).toEqual([]);
    // one record read and one pending read per scope
    expect(calls).toHaveLength(3);
  });

  it("degrades to no dedup when the store fails", async () => {
    const memory: MemoryExtractionSlice = {
      propose: async () => proposal({}),
      list: async () => {
        throw new Error("db down");
      },
      listProposals: async () => []
    };
    const warnings: string[] = [];
    const index = await loadProposalIndex(memory, [{ kind: "global" }], {
      warn: (message) => warnings.push(message)
    });
    expect(index.has(normalizeProposalText("что угодно"))).toBe(false);
    expect(warnings.join("\n")).toContain("dedup index unavailable");
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run propose`
Expected: FAIL — `Failed to resolve import "../src/propose.js"`.

- [ ] **Step 3: Добавить структурные срезы в `types.ts`**

В `packages/plugins/dsh-balbes-memory-context/src/types.ts` расширить импорт:

```ts
import type { MemoryProposal, MemoryRecord, MemoryScope } from "dsh-balbes-contracts";
```

и добавить после `MemoryWriteSlice`:

```ts
/** Структурный write-срез пути ревью: служебный ход пишет только через него. */
export interface MemoryProposalDraft {
  scope: MemoryScope;
  type: MemoryRecord["type"];
  text: string;
  tags?: string[];
  originRef?: string | null;
}

export interface MemoryProposalSlice {
  propose(draft: MemoryProposalDraft): Promise<MemoryProposal>;
  listProposals(filter?: {
    scope?: MemoryScope;
    status?: MemoryProposal["status"][];
    limit?: number;
  }): Promise<MemoryProposal[]>;
}

/** Срез, нужный входному дедупу: очередь плюс чтение истины. */
export interface MemoryExtractionSlice extends MemoryProposalSlice {
  list(filter?: MemoryReadFilter): Promise<MemoryRecord[]>;
}
```

- [ ] **Step 4: Написать `propose.ts`**

Create `packages/plugins/dsh-balbes-memory-context/src/propose.ts`:

```ts
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

function proposalOutput(proposal: MemoryProposal): Record<string, unknown> {
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
```

- [ ] **Step 5: Прогнать тесты**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run propose`
Expected: PASS (10 тестов).

- [ ] **Step 6: Типы и коммит**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: exit 0.

```bash
git add packages/plugins/dsh-balbes-memory-context/src/propose.ts \
        packages/plugins/dsh-balbes-memory-context/src/types.ts \
        packages/plugins/dsh-balbes-memory-context/tests/propose.test.ts
git commit -m "feat(memory-context): add the propose_memory tool and input dedup (p10g)"
```

---

### Task 2: extraction-место на attachment (`qualifies` / `begin` / `end`)

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/src/types.ts`
- Modify: `packages/plugins/dsh-balbes-memory-context/src/context.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/extraction.test.ts`

**Interfaces:**
- Consumes: `buildProposeTool`, `loadProposalIndex`, `createExtractionCounters`, `EXTRACTION_DIRECTIVE` (Task 1); `buildRememberTool`, `buildRecallTool`, `scopesFor` (существующие).
- Produces (для Task 3): `attach(...)` возвращает `MemoryContextAttachment` с необязательным полем `extraction?: MemoryExtractionHandle`; `MemoryExtractionHandle.begin(): { message: string }`, `.end(): void`, `.qualifies(facts: { ok: boolean; toolCalls: number }): boolean`.

- [ ] **Step 1: Написать падающие тесты**

Create `packages/plugins/dsh-balbes-memory-context/tests/extraction.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import { createMemoryContext } from "../src/context.js";
import type { MemoryContextScope } from "../src/types.js";

function record(partial: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    scope: { kind: "global" },
    type: "fact",
    tags: [],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...partial
  };
}

/**
 * The tools seat keeps its registrations addressable by name, so the surface
 * switch is asserted the way the model sees it: by tool names, not by calls.
 */
function harness(
  options: { propose?: boolean; failProposeRegistration?: boolean; failRememberRegistration?: boolean } = {}
) {
  const registered = new Map<string, unknown>();
  const proposals: unknown[] = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const memory = {
    list: async () => [record({ id: "r1", text: "known text" })],
    count: async () => 1,
    search: async () => [],
    save: async () => record({ id: "saved", text: "saved" }),
    ...(options.propose === false
      ? {}
      : {
          propose: async (draft: unknown) => {
            proposals.push(draft);
            return {
              id: "p1",
              scope: { kind: "global" },
              type: "note",
              text: "x",
              tags: [],
              origin: "agent",
              originRef: null,
              status: "proposed",
              proposedAt: "2026-09-30T00:00:00.000Z",
              decidedAt: null,
              decidedBy: null,
              decidedEdit: false,
              memoryId: null
            };
          },
          listProposals: async () => []
        })
  };
  let rememberRegistrations = 0;
  const tools = {
    register: (definition: unknown) => {
      const name = (definition as { name: string }).name;
      if (name === "propose_memory" && options.failProposeRegistration === true) {
        throw new Error("reserved tool name");
      }
      if (name === "remember" && options.failRememberRegistration === true) {
        // The first registration is the attach-time one; the second is the
        // re-registration from end(), which a dead agent scope rejects.
        rememberRegistrations += 1;
        if (rememberRegistrations > 1) throw new Error("INACTIVE_EFFECT");
      }
      registered.set(name, definition);
      return () => {
        registered.delete(name);
      };
    }
  };
  const agentCtx = {
    get(key: string): unknown {
      if (key === "balbesMemory") return memory;
      if (key === "systemPrompt") return { section: () => () => {}, context: () => () => {} };
      if (key === "tools") return tools;
      return undefined;
    }
  };
  const service = createMemoryContext({
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message)
  });
  const scope: MemoryContextScope = { kind: "project", name: "alpha" };
  const attachment = service.attach(agentCtx, scope, { channel: "telegram", sessionId: "s1" });
  return { attachment, registered, names: () => [...registered.keys()].sort(), proposals, infos, warnings };
}

describe("extraction seat", () => {
  it("is absent when the store cannot propose", () => {
    const h = harness({ propose: false });
    expect(h.attachment.extraction).toBeUndefined();
    expect(h.names()).toEqual(["recall", "remember"]);
  });

  it("gates on a successful task that did work", () => {
    const h = harness({});
    expect(h.attachment.extraction).toBeDefined();
    expect(h.attachment.extraction!.qualifies({ ok: true, toolCalls: 1 })).toBe(true);
    expect(h.attachment.extraction!.qualifies({ ok: false, toolCalls: 3 })).toBe(false);
    expect(h.attachment.extraction!.qualifies({ ok: true, toolCalls: 0 })).toBe(false);
  });

  it("swaps remember for propose_memory on begin and back on end", () => {
    const h = harness({});
    const begun = h.attachment.extraction!.begin();
    expect(begun.message).toContain("propose_memory");
    expect(h.names()).toEqual(["propose_memory", "recall"]);
    h.attachment.extraction!.end();
    expect(h.names()).toEqual(["recall", "remember"]);
  });

  it("is idempotent and logs the counters once, without memory text", () => {
    const h = harness({});
    h.attachment.extraction!.begin();
    h.attachment.extraction!.end();
    h.attachment.extraction!.end();
    expect(h.names()).toEqual(["recall", "remember"]);
    const logged = h.infos.filter((line) => line.includes("extraction"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("channel=telegram");
    expect(logged[0]).toContain("scope=project:alpha");
    expect(logged[0]).toContain("proposed=0 duplicate=0 secret=0 limit=0");
  });

  it("resets the counters for every service turn", async () => {
    const h = harness({});
    const turn = h.attachment.extraction!;
    turn.begin();
    // The lookup happens AFTER begin(): begin() is what registers the tool.
    const propose = h.registered.get("propose_memory") as {
      execute(args: unknown, exec: unknown): Promise<unknown>;
    };
    await propose.execute({ text: "первый факт" }, {} as never);
    await propose.execute({ text: "первый факт" }, {} as never);
    turn.end();
    turn.begin();
    turn.end();
    const logged = h.infos.filter((line) => line.includes("extraction"));
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("proposed=1 duplicate=1 secret=0 limit=0");
    // An agent handle outlives many turns: without a reset the cap would
    // silently become per-session.
    expect(logged[1]).toContain("proposed=0 duplicate=0 secret=0 limit=0");
  });

  it("keeps remember registered when the propose tool cannot be registered", () => {
    const h = harness({ failProposeRegistration: true });
    expect(() => h.attachment.extraction!.begin()).toThrow("reserved tool name");
    // begin threw before remember was released, and end() is a no-op.
    expect(h.names()).toEqual(["recall", "remember"]);
    expect(() => h.attachment.extraction!.end()).not.toThrow();
    expect(h.names()).toEqual(["recall", "remember"]);
  });

  it("still logs the counters when the agent scope is already gone", () => {
    const h = harness({ failRememberRegistration: true });
    const turn = h.attachment.extraction!;
    turn.begin();
    turn.end();
    // A dead scope must not let end() throw out of the channel's `finally`...
    expect(() => turn.end()).not.toThrow();
    // ...the surface degrades honestly (the registration died with the scope)...
    expect(h.names()).toEqual(["recall"]);
    // ...and the per-turn record survives, because that is the path it documents.
    const logged = h.infos.filter((line) => line.includes("extraction"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("channel=telegram");
    expect(logged[0]).toContain("scope=project:alpha");
    expect(logged[0]).toContain("proposed=0 duplicate=0 secret=0 limit=0");
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run extraction`
Expected: FAIL — `attachment.extraction` is `undefined` (`TypeError: Cannot read properties of undefined`).

- [ ] **Step 3: Добавить типы шва**

В `packages/plugins/dsh-balbes-memory-context/src/types.ts` заменить блок attachment:

```ts
/** Факты завершённой задачи, по которым решает гейт извлечения; текста задачи тут нет. */
export interface ExtractionTurnFacts {
  ok: boolean;
  toolCalls: number;
}

/**
 * Место извлечения одного агента (p10g): слой владеет write-поверхностью
 * служебного хода, канал — самим ходом (агент, очередь, отмена).
 */
export interface MemoryExtractionHandle {
  /** Дешёвый гейт: успешная задача, в которой агент работал. Без вызова модели. */
  qualifies(facts: ExtractionTurnFacts): boolean;
  /** Снять `remember`, зарегистрировать `propose_memory`, вернуть директиву. */
  begin(): { message: string };
  /** Вернуть поверхность задачи и записать счётчики. Идемпотентен. */
  end(): void;
}

/** Per-agent handle; prepare() рендерит блоки одного хода. */
export interface MemoryContextAttachment {
  prepare(taskText: string): Promise<void>;
  /** Есть только тогда, когда слой может извлекать (write-контекст + save + propose + listProposals). */
  extraction?: MemoryExtractionHandle;
}
```

- [ ] **Step 4: Собрать место в `context.ts`**

В `packages/plugins/dsh-balbes-memory-context/src/context.ts` расширить импорты:

```ts
import {
  buildProposeTool,
  createExtractionCounters,
  loadProposalIndex,
  EXTRACTION_DIRECTIVE
} from "./propose.js";
import type {
  BalbesMemoryContextService,
  BalbesMemoryReadSlice,
  MemoryContextAttachment,
  MemoryContextScope,
  MemoryExtractionHandle,
  MemoryExtractionSlice,
  MemoryProposalSlice,
  MemoryWriteContext,
  MemoryWriteSlice
} from "./types.js";
```

затем заменить в `attach` участок от `tools.register(buildRecallTool(memory, scopes));` до `return { async prepare(...) }` на:

```ts
      tools.register(buildRecallTool(memory, scopes));
      const writable = memory as BalbesMemoryReadSlice & Partial<MemoryWriteSlice> & Partial<MemoryProposalSlice>;
      let extraction: MemoryExtractionHandle | undefined;
      if (typeof writable.save === "function" && write !== undefined) {
        const classify =
          llm !== undefined && write.selection !== undefined
            ? createLlmClassifier(llm, write.selection, logger)
            : undefined;
        const registerRemember = (): (() => void) =>
          tools.register(buildRememberTool(writable as MemoryWriteSlice, scope, write, classify, logger));
        let rememberDispose = registerRemember();
        if (typeof writable.propose === "function" && typeof writable.listProposals === "function") {
          const slice = writable as MemoryExtractionSlice;
          const counters = createExtractionCounters();
          const writeContext = write;
          let proposeDispose: (() => void) | undefined;
          let open = false;
          // The agent scope may already be gone (reset/dispose): the
          // registration died with it, and a second release is a no-op.
          const safeDispose = (dispose: () => void): void => {
            try {
              dispose();
            } catch {
              /* scope already disposed */
            }
          };
          extraction = {
            qualifies: (facts) => facts.ok && facts.toolCalls > 0,
            begin() {
              // Counters are PER SERVICE TURN: one agent handle outlives many
              // turns, and a running total would silently turn the 3-proposal
              // cap into a per-session cap.
              counters.proposed = 0;
              counters.duplicate = 0;
              counters.secret = 0;
              counters.limit = 0;
              // Register first: a failed registration must leave the task-turn
              // surface intact. No turn is in flight between the two calls, so
              // the invariant "no immediate-write tool during extraction" holds.
              proposeDispose = tools.register(
                buildProposeTool(slice, scope, writeContext, counters, () =>
                  loadProposalIndex(slice, scopes, logger)
                )
              );
              safeDispose(rememberDispose);
              open = true;
              return { message: EXTRACTION_DIRECTIVE };
            },
            end() {
              if (!open) return;
              open = false;
              if (proposeDispose !== undefined) {
                safeDispose(proposeDispose);
                proposeDispose = undefined;
              }
              // The agent scope may already be gone (reset/dispose): registering
              // into a dead scope throws INACTIVE_EFFECT, and that must neither
              // escape the turn's `finally` nor swallow the counter line below.
              try {
                rememberDispose = registerRemember();
              } catch {
                /* the registration died with the scope */
              }
              logger.info?.(
                "balbes-memory-context: extraction channel=" + writeContext.channel +
                  " scope=" + scopeTag(scope) +
                  " proposed=" + counters.proposed +
                  " duplicate=" + counters.duplicate +
                  " secret=" + counters.secret +
                  " limit=" + counters.limit
              );
            }
          };
        }
      }
      const attachment: MemoryContextAttachment = {
        async prepare(taskText: string): Promise<void> {
          /* тело не меняется: ядро, карта, push, счётчики и обработка ошибок как в p10c */
        }
      };
      if (extraction !== undefined) attachment.extraction = extraction;
      return attachment;
```

Тело `prepare` остаётся дословно прежним (его видно в текущем `context.ts`); меняется только обёртка возврата.

- [ ] **Step 5: Прогнать тесты пакета**

Run: `pnpm --filter dsh-balbes-memory-context test`
Expected: PASS — новые `propose`/`extraction` и все существующие (`context`, `integration` пропущен без `RUN_REAL`).

- [ ] **Step 6: Типы и коммит**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: exit 0.

```bash
git add packages/plugins/dsh-balbes-memory-context/src/types.ts \
        packages/plugins/dsh-balbes-memory-context/src/context.ts \
        packages/plugins/dsh-balbes-memory-context/tests/extraction.test.ts
git commit -m "feat(memory-context): expose the extraction seat and switch the write surface (p10g)"
```

---

### Task 3: служебный ход извлечения в Telegram-раннере

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` (типы у `MemoryContextAttachmentLike` ~L108; `startTurn` ~L723-754; `run` ~L757-790)
- Test: `packages/plugins/dsh-balbes-telegram/tests/agentTask.extraction.test.ts` (create)

**Interfaces:**
- Consumes: `extraction?: { qualifies; begin; end }` на attachment (Task 2).
- Produces: `AgentTaskRunner.run` резолвится результатом задачи до служебного хода; побочный эффект — `propose_memory`-предложения через `balbesMemory.propose`; новых публичных методов у раннера нет.

- [ ] **Step 1: Написать падающие тесты**

Create `packages/plugins/dsh-balbes-telegram/tests/agentTask.extraction.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createAgentTaskRunner, type AgentTaskDeps, type WorkspaceRef } from "../src/agentTask.js";

const REF: WorkspaceRef = { scope: "project", name: "alpha" };

function messageText(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}

interface FakeHandle {
  events: Array<{ type: string; data: unknown }>;
  calls: string[];
  disposed: boolean;
  agent: {
    session: { readonly seq: number; eventAt(seq: number): unknown };
    whenIdle(): Promise<void>;
    followup(message: unknown): void;
    cancel(...args: unknown[]): void;
    status: string;
  };
  dispose(): Promise<void>;
}

function fakeHandle(options: {
  toolCall?: boolean;
  errorOnCall?: number;
  failOnCall?: number;
  abortOnCall?: number;
  onCall?: (index: number) => void;
}): FakeHandle {
  const events: Array<{ type: string; data: unknown }> = [];
  const calls: string[] = [];
  const handle: FakeHandle = {
    events,
    calls,
    disposed: false,
    agent: {
      session: {
        get seq(): number {
          return events.length;
        },
        eventAt(seq: number) {
          return events[seq];
        }
      },
      whenIdle: async () => {},
      followup: (message: unknown) => {
        const index = calls.length + 1;
        calls.push(messageText(message));
        options.onCall?.(index);
        if (options.failOnCall === index) throw new Error("driver blew up");
        events.push({ type: "turn/start", data: {} });
        if (options.toolCall === true && index === 1) {
          events.push({
            type: "tool/call",
            data: { callId: "c1", name: "read", arguments: '{"file_path":"notes.txt"}' }
          });
        }
        events.push({
          type: "assistant/message",
          data: { message: { content: [{ type: "text", text: "answer " + index }] } }
        });
        events.push({
          type: "turn/end",
          data: {
            reason:
              options.errorOnCall === index
                ? { kind: "error", error: { code: "agent-error", message: "boom" } }
                : options.abortOnCall === index
                  ? { kind: "aborted" }
                  : { kind: "completed" }
          }
        });
      },
      cancel: () => {},
      status: "idle"
    },
    dispose: async () => {
      handle.disposed = true;
    }
  };
  return handle;
}

interface SeatCalls {
  qualifies: Array<{ ok: boolean; toolCalls: number }>;
  begin: number;
  end: number;
  messages: string[];
}

function extractionSeat(options: { allow?: boolean; beginError?: Error } = {}) {
  const calls: SeatCalls = { qualifies: [], begin: 0, end: 0, messages: [] };
  const handle = {
    qualifies(facts: { ok: boolean; toolCalls: number }): boolean {
      calls.qualifies.push(facts);
      return (options.allow ?? true) && facts.ok && facts.toolCalls > 0;
    },
    begin(): { message: string } {
      if (options.beginError !== undefined) throw options.beginError;
      calls.begin += 1;
      const message = "служебная директива: propose_memory";
      calls.messages.push(message);
      return { message };
    },
    end(): void {
      calls.end += 1;
    }
  };
  return { handle, calls };
}

/**
 * The design settles the owner's answer BEFORE the service turn (spec
 * «Служебный ход» step 2: the owner must not wait for bookkeeping), so the
 * await of `run()` resumes while the service turn is still in flight. A test
 * that asserts the service turn's effects therefore awaits the turn's own
 * completion first — the mandated `end === 1` assertion, polled until it
 * holds (never merely assumed from the await above).
 */
async function waitForServiceTurn(seat: { calls: SeatCalls }): Promise<void> {
  await vi.waitFor(() => {
    expect(seat.calls.end).toBe(1);
  });
}

function makeDeps(options: {
  extraction?: ReturnType<typeof extractionSeat>["handle"];
  toolCall?: boolean;
  errorOnCall?: number;
  failOnCall?: number;
  abortOnCall?: number;
  onCall?: (index: number) => void;
}) {
  const handle = fakeHandle(options);
  const warnings: string[] = [];
  const prepares: string[] = [];
  const flushes: number[] = [];
  let creates = 0;
  const deps = {
    workspaces: {
      list: async () => ({}),
      root: async () => "/home",
      readDir: async () => [],
      readFile: async () => ({})
    },
    agents: {
      create: async (o: { setup: (agentCtx: unknown) => void }) => {
        creates += 1;
        o.setup({ on: () => () => {} });
        return handle;
      },
      resume: async () => {
        throw new Error("no session to resume");
      }
    },
    sessions: {
      flush: async () => {
        flushes.push(handle.events.length);
      }
    },
    defaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
    logger: { warn: (message: string) => warnings.push(message) },
    memory: {
      attach: () => ({
        prepare: async (text: string) => {
          prepares.push(text);
        },
        ...(options.extraction === undefined ? {} : { extraction: options.extraction })
      })
    }
  } as unknown as AgentTaskDeps;
  return { deps, handle, warnings, prepares, flushes, creates: () => creates };
}

describe("agentTask memory extraction", () => {
  it("runs one extraction turn after a successful task that used a tool, keeping the task answer", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: true });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");
    await waitForServiceTurn(seat);

    expect(result).toMatchObject({ ok: true, text: "answer 1" });
    expect(seat.calls.qualifies).toEqual([{ ok: true, toolCalls: 1 }]);
    expect(seat.calls.begin).toBe(1);
    expect(seat.calls.end).toBe(1);
    expect(state.handle.calls).toEqual(["сделай работу", seat.calls.messages[0]]);
    expect(state.handle.calls[1]).toContain("propose_memory");
    expect(state.prepares).toEqual(["сделай работу"]);
    // the task turn and the extraction turn are each flushed
    expect(state.flushes).toHaveLength(2);
    expect(state.warnings).toEqual([]);
  });

  it("does not extract when the task used no tool", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: false });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "привет");

    expect(result).toMatchObject({ ok: true, text: "answer 1" });
    expect(seat.calls.qualifies).toEqual([{ ok: true, toolCalls: 0 }]);
    expect(seat.calls.begin).toBe(0);
    expect(state.handle.calls).toHaveLength(1);
  });

  it("does not extract when the task failed", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: true, errorOnCall: 1 });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");

    expect(result).toMatchObject({ ok: false, code: "agent-error" });
    expect(seat.calls.qualifies).toEqual([]);
    expect(seat.calls.begin).toBe(0);
    expect(state.handle.calls).toHaveLength(1);
  });

  it("honours the layer veto", async () => {
    const seat = extractionSeat({ allow: false });
    const state = makeDeps({ extraction: seat.handle, toolCall: true });
    const runner = createAgentTaskRunner(state.deps);

    await runner.run(REF, "сделай работу");

    expect(seat.calls.begin).toBe(0);
    expect(state.handle.calls).toHaveLength(1);
  });

  it("contains a failing extraction turn, restores the surface and keeps the task result", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: true, failOnCall: 2 });
    const runner = createAgentTaskRunner(state.deps);

    const first = await runner.run(REF, "сделай работу");
    await waitForServiceTurn(seat);

    expect(first).toMatchObject({ ok: true, text: "answer 1" });
    expect(seat.calls.end).toBe(1);
    expect(state.warnings.join("\n")).toContain("memory extraction turn failed");
    // a driver-level failure wedges the agent: same policy as a failed task
    expect(state.handle.disposed).toBe(true);
    const second = await runner.run(REF, "новая задача");
    expect(second.ok).toBe(true);
    expect(state.creates()).toBe(2);
  });

  it("survives an aborted extraction turn and warns about it", async () => {
    const seat = extractionSeat();
    const state = makeDeps({ extraction: seat.handle, toolCall: true, abortOnCall: 2 });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");
    await waitForServiceTurn(seat);

    expect(result).toMatchObject({ ok: true, text: "answer 1" });
    expect(seat.calls.end).toBe(1);
    expect(state.warnings.join("\n")).toContain("memory extraction turn ended as aborted");
    expect(state.handle.disposed).toBe(false);
  });

  it("skips extraction when it cannot start and reports it", async () => {
    const seat = extractionSeat({ beginError: new Error("no memory") });
    const state = makeDeps({ extraction: seat.handle, toolCall: true });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");

    expect(result).toMatchObject({ ok: true, text: "answer 1" });
    expect(state.handle.calls).toHaveLength(1);
    expect(state.warnings.join("\n")).toContain("memory extraction could not start");
  });

  it("works without an extraction seat at all", async () => {
    const state = makeDeps({ toolCall: true });
    const runner = createAgentTaskRunner(state.deps);

    const result = await runner.run(REF, "сделай работу");

    expect(result).toMatchObject({ ok: true, text: "answer 1" });
    expect(state.handle.calls).toHaveLength(1);
    expect(state.flushes).toHaveLength(1);
  });

  it("tolerates a cancel landing during the extraction turn and serves the next task", async () => {
    const seat = extractionSeat();
    let runner!: ReturnType<typeof createAgentTaskRunner>;
    const state = makeDeps({
      extraction: seat.handle,
      toolCall: true,
      onCall: (index) => {
        if (index === 2) void runner.cancel(REF);
      }
    });
    runner = createAgentTaskRunner(state.deps);

    const first = await runner.run(REF, "сделай работу");
    await waitForServiceTurn(seat);

    expect(first).toMatchObject({ ok: true, text: "answer 1" });
    expect(seat.calls.end).toBe(1);
    const next = await runner.run(REF, "следующая задача");
    expect(next.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run agentTask.extraction`
Expected: FAIL — служебный ход не запускается: `expected [...] to equal ['сделай работу', ...]` / `seat.calls.begin` = 0.

- [ ] **Step 3: Расширить структурные типы канала**

В `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` заменить `MemoryContextAttachmentLike` (около L108) на:

```ts
/** Место извлечения (p10g): слой владеет поверхностью, канал — ходом. */
export interface MemoryExtractionHandleLike {
  qualifies(facts: { ok: boolean; toolCalls: number }): boolean;
  begin(): { message: string };
  end(): void;
}

export interface MemoryContextAttachmentLike {
  prepare(taskText: string): Promise<void>;
  extraction?: MemoryExtractionHandleLike;
}
```

и добавить рядом константу:

```ts
/** Summary служебного сообщения извлечения; форма `notice` требует её. */
const EXTRACTION_NOTICE_SUMMARY = "memory extraction";
```

Плюс объявить производительский kind служебного сообщения модульным расширением
(`MessageSourceMap` в dsh merge-extensible; каст на `source` не подходит — он
проверяется, потому что `as never` стоит на результате вызова):

```ts
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "balbes-memory-extraction": {
      readonly kind: "balbes-memory-extraction";
      readonly form: "notice";
      readonly summary: string;
    };
  }
}
```

- [ ] **Step 4: Резолвить задачу до извлечения и добавить служебный ход**

В `createAgentTaskRunner` заменить `startTurn` (L723-754) и `return startTurn(...)` в `run` (L789) на:

```ts
  /**
   * The p10g service turn: after a successful task that did work, run ONE
   * extraction turn in the SAME session, so the agent proposes durable
   * knowledge through `propose_memory` (review queue, never truth). It never
   * changes the task's result: every failure is contained to a warning, and a
   * driver-level failure gets the same "wedged agent" policy the task path
   * uses. The workspace stays busy for its duration.
   */
  async function runExtractionTurn(entry: KeyedEntry, result: TaskResult): Promise<void> {
    const extraction = entry.memory?.extraction;
    if (!result.ok || extraction === undefined) return;
    if (entry.retired || entry.cancelled) return;
    const handle = entry.handle;
    const taskSeq = entry.firstSeq;
    if (handle === undefined || taskSeq === undefined) return;
    // The gate reads the TOOL CALLS of the task turn from the same window the
    // progress card uses: no model call is spent on the decision.
    const toolCalls = summarizeProgress(handle.agent.session, taskSeq).steps.length;
    if (!extraction.qualifies({ ok: true, toolCalls })) return;
    let directive: string;
    try {
      directive = extraction.begin().message;
    } catch (error) {
      deps.logger?.warn(
        `dsh-balbes-telegram: memory extraction could not start: ${errorMessage(error)}`
      );
      return;
    }
    // The progress read now describes THIS turn: the task's window is over and
    // its result was already computed.
    const extractionSeq = handle.agent.session.seq;
    entry.firstSeq = extractionSeq;
    entry.startedAt = Date.now();
    try {
      handle.agent.followup(
        createUserMessage({
          content: [{ type: "text", text: directive }],
          // A producer-declared kind (MessageSourceMap is merge-extensible):
          // the session view renders the directive as context, never as an
          // owner prompt.
          source: {
            kind: "balbes-memory-extraction",
            form: "notice",
            summary: EXTRACTION_NOTICE_SUMMARY
          }
        }) as never
      );
      await handle.agent.whenIdle();
      await deps.sessions.flush(handle.agent.session);
      const outcome = summarizeTurn(handle.agent.session, extractionSeq);
      if (outcome.reason?.kind === "error" || outcome.reason?.kind === "aborted") {
        deps.logger?.warn(
          "dsh-balbes-telegram: memory extraction turn ended as " + outcome.reason.kind
        );
      }
    } catch (error) {
      // Driver-level failure: the agent loop is wedged, exactly as a failed
      // task turn leaves it. reset() owns the disposal when it retired the entry.
      if (!entry.retired && entry.handle === handle) {
        entry.handle = undefined;
        entry.sessionId = undefined;
        entry.memory = undefined;
        await disposeQuietly(handle, "disposing the agent wedged by a failed memory extraction turn failed");
      }
      deps.logger?.warn(`dsh-balbes-telegram: memory extraction turn failed: ${errorMessage(error)}`);
    } finally {
      extraction.end();
    }
  }

  /** Run one task, settle its promise, then start the next queued task (FIFO). */
  async function startTurn(key: string, entry: KeyedEntry, task: PendingTask): Promise<void> {
    entry.busy = true;
    entry.activeText = task.text;
    try {
      const result = await executeTurn(key, entry, task.ref, task.text, task.opts);
      // The owner's answer settles BEFORE the service turn: the result is
      // already computed and the caller must not wait for bookkeeping.
      task.resolve(result);
      await runExtractionTurn(entry, result);
    } catch (error) {
      task.resolve({ ok: false, code: "agent-error", message: errorMessage(error, AGENT_ERROR_MESSAGE) });
    } finally {
      entry.busy = false;
      entry.activeText = undefined;
      // The progress read is scoped to the turn that just settled: clearing it
      // BEFORE the next queued task is set up is what keeps a later read from
      // summarizing a turn that is over (the next task's own window has no
      // events yet, so it must report no phase at all).
      entry.firstSeq = undefined;
      entry.startedAt = undefined;
      // The stop flag is scoped to the turn it stopped: a cancel that landed as
      // this turn was settling must not misreport the NEXT queued task.
      entry.cancelled = false;
      const next = entry.queue.shift();
      if (next !== undefined && !entry.retired && cache.get(key) === entry) {
        void startTurn(key, entry, next);
      }
    }
  }
```

и в объекте раннера:

```ts
      // A fresh task owns a deferred so its promise can settle before the
      // extraction turn that follows it.
      return new Promise<TaskResult>((resolve) => {
        void startTurn(key, entry, { ref, text, opts, resolve });
      });
```

`executeTurn` не меняется; `runExtractionTurn` вызывается только после успешного `executeTurn`, поэтому результат задачи уже вычислен.

- [ ] **Step 5: Прогнать тесты пакета**

Run: `pnpm --filter dsh-balbes-telegram test`
Expected: PASS — новые `agentTask.extraction` и все существующие (`agentTask`, `agentTask.memory`, `chat`, `polls`, `cards`).

- [ ] **Step 6: Типы и коммит**

Run: `pnpm --filter dsh-balbes-telegram typecheck`
Expected: exit 0.

```bash
git add packages/plugins/dsh-balbes-telegram/src/agentTask.ts \
        packages/plugins/dsh-balbes-telegram/tests/agentTask.extraction.test.ts
git commit -m "feat(telegram): run the memory extraction turn after a working task (p10g)"
```

---

### Task 4: REAL-доказательство в композиции Telegram (отдельный профиль)

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-extraction-profile/cordis.patch.yml`
- Create: `packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-extraction-profile/package.json`
- Create: `packages/plugins/dsh-balbes-telegram/tests/extraction.real.test.ts`

**Interfaces:**
- Consumes: `balbesMemory.propose` через инструмент `propose_memory` (Task 1/2) и служебный ход раннера (Task 3).
- Produces: доказательство, что динамическая регистрация инструмента после `setup` работает в настоящем dsh, и что разговорный ход извлечения не порождает.

Почему отдельный профиль и отдельный файл, а не правка существующего
`integration.test.ts`: его сценарии апрувов выполняют задачи с вызовом
инструмента (`write`), и с memory-рядами в общем профиле каждый такой успешный
ход начал бы тратить ещё один запрос модели на служебный ход — это сломало бы
скрипты стаба у чужих сценариев. Изоляция p10g-проверки в своём профиле
оставляет существующий REAL-набор нетронутым.

- [ ] **Step 1: Создать fixture-профиль извлечения**

Скопировать `packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-profile/`
в `.../fixtures/balbes-telegram-extraction-profile/` и изменить:

`package.json` — имя профиля:

```json
{
  "name": "dsh-profile-balbes-telegram-extraction-test",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-balbes-host"],
      "patchReload": "startup"
    }
  }
}
```

`cordis.patch.yml` — дописать в `insert` три memory-ряда (комментарий шапки
дополнить: memory-ряды нужны сценарию извлечения, `balbes-memory-admin` даёт
ручку `memory.review/list`, которой сценарий проверяет очередь):

```yaml
    - id: balbes-memory
      name: 'dsh-balbes-memory'
    - id: balbes-memory-context
      name: 'dsh-balbes-memory-context'
    - id: balbes-memory-admin
      name: 'dsh-balbes-memory-admin'
```

- [ ] **Step 2: Собрать новый REAL-файл из существующего каркаса**

Скопировать `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts` в
`packages/plugins/dsh-balbes-telegram/tests/extraction.real.test.ts` и сделать
ровно следующее:

1. удалить все блоки `it(...)` (каркас нужен целиком, сценарии — нет);
2. удалить константы чужих сценариев (`PROMPT_ONE/TWO`, `MEMORY_*`, `LONG_PROMPT`,
   `FOLLOW_UP_*`, `SESSION_B_*`, `HOLD_MS`, `APPROVAL_*`) и их комментарии —
   кроме `BOT_TOKEN`, `OWNER_USER_ID`, `FOREIGN_USER_ID`, `GROUP_CHAT_ID`,
   `BOT_USERNAME`, `NON_DELIVERY_METHODS`;
3. заменить профиль и его каталог:

```ts
const fixtureProfile = join(here, "fixtures", "balbes-telegram-extraction-profile");
const PROFILE = "balbes-telegram-extraction-test";
```

4. рядом с `modelsPkgRoot` добавить корни memory-пакетов:

```ts
const memoryPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory");
const memoryContextPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory-context");
const memoryAdminPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory-admin");
```

5. в `buildPackages()` добавить их сборку (иначе профиль загрузит отсутствующий
   `lib/`):

```ts
    [memoryPkgRoot, "tsconfig.build.json"],
    [memoryContextPkgRoot, "tsconfig.build.json"],
    [memoryAdminPkgRoot, "tsconfig.build.json"],
```

6. в списке копирования `prepareHome` (массив `[pkg, dirName]`) добавить:

```ts
      [memoryPkgRoot, "dsh-balbes-memory"],
      [memoryContextPkgRoot, "dsh-balbes-memory-context"],
      [memoryAdminPkgRoot, "dsh-balbes-memory-admin"],
```

7. обновить шапку файла: это REAL-набор извлечения (p10g); каркас скопирован из
   `integration.test.ts`, профиль — `balbes-telegram-extraction-profile`.

- [ ] **Step 3: Написать REAL-сценарий**

В конце `describe.skipIf(!realEnabled)(...)` нового файла — константы и один
сценарий:

```ts
const EXTRACTION_TASK_PROMPT = "Прочитай extraction-smoke.txt и ответь одной строкой";
const EXTRACTION_TASK_REPLY = "прочитал";
const EXTRACTION_PROPOSAL_TEXT = "Балбес: smoke-задача p10g доходит до очереди ревью";
const EXTRACTION_DONE_REPLY = "предложил";
const EXTRACTION_CHAT_REPLY = "привет";
```

```ts
  /**
   * p10g end to end: a task that does real tool work triggers the service
   * extraction turn, whose `propose_memory` call lands a proposal in the review
   * queue with the channel provenance and NOT in memory; a chat-only task
   * spends exactly one model request, so no extraction turn happened.
   */
  it("extraction proposes after tool work, and a chat-only task proposes nothing", async () => {
    if (home === undefined) throw new Error("beforeAll did not initialize home");
    const server = requireApi();
    const llm = requireStub();
    const token = await bootServer();
    try {
      // (a) the agent home is the active workspace for this scenario
      const from = server.outbound.length;
      const menu = await openMenu(from);
      const menuId = sentMessageId(menu);
      pressButton(menuId, "ws");
      const list = await waitForOutbound(
        (entry) => entry.method === "editMessageText" && String(entry.body.text ?? "").startsWith("Выберите воркспейс"),
        "the workspace list",
        from
      );
      expect(buttonsOf(list).map((button) => button.callback_data)).toContain("ws:pick:0");
      pressButton(menuId, "ws:pick:0");
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === "Выбран: Дом агента",
        "the agent home confirmation",
        from
      );

      // (b) a real tool read, then an answer; the service turn follows and
      // proposes once, then answers
      await mkdir(join(home, "agent"), { recursive: true });
      await writeFile(join(home, "agent", "extraction-smoke.txt"), "smoke\n");
      llm.setScript([
        { toolCall: { name: "read", arguments: JSON.stringify({ file_path: "extraction-smoke.txt" }) } },
        { text: EXTRACTION_TASK_REPLY },
        { toolCall: { name: "propose_memory", arguments: JSON.stringify({ text: EXTRACTION_PROPOSAL_TEXT, type: "fact", tags: ["p10g"] }) } },
        { text: EXTRACTION_DONE_REPLY }
      ]);
      server.enqueueMessage({ fromId: OWNER_USER_ID, text: EXTRACTION_TASK_PROMPT });
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === EXTRACTION_TASK_REPLY,
        "the task answer",
        from,
        180_000
      );

      // (c) the proposal is staged for review with the channel provenance
      const staged = await waitFor(
        async () => {
          const response = await post(`${baseUrl()}/api/memory/review/list`, { status: ["proposed"] }, token);
          const proposals =
            (response.json as { proposals?: Array<{ text: string; originRef: string | null }> }).proposals ?? [];
          return proposals.find((candidate) => candidate.text === EXTRACTION_PROPOSAL_TEXT);
        },
        "the extraction proposal in the review queue"
      );
      expect(staged.originRef).toMatch(/^telegram session:/);

      // (d) staged means staged: the record list does not carry it
      const records = await post(`${baseUrl()}/api/memory/list`, { query: "smoke" }, token);
      expect(records.text).not.toContain(EXTRACTION_PROPOSAL_TEXT);

      // (e) a chat-only task spends exactly ONE model request (an extraction
      // turn would spend another) and stages nothing
      const pendingBefore = (
        (await post(`${baseUrl()}/api/memory/review/list`, { status: ["proposed"] }, token)).json as {
          proposals: unknown[];
        }
      ).proposals.length;
      const callsBefore = llm.calls.length;
      llm.setScript([{ text: EXTRACTION_CHAT_REPLY }]);
      server.enqueueMessage({ fromId: OWNER_USER_ID, text: "привет" });
      await waitForOutbound(
        (entry) => entry.method === "sendMessage" && entry.body.text === EXTRACTION_CHAT_REPLY,
        "the chat answer",
        from,
        180_000
      );
      expect(llm.calls.length - callsBefore).toBe(1);
      const pendingAfter = (
        (await post(`${baseUrl()}/api/memory/review/list`, { status: ["proposed"] }, token)).json as {
          proposals: unknown[];
        }
      ).proposals.length;
      expect(pendingAfter).toBe(pendingBefore);
    } finally {
      await stopServer();
    }
  }, 300_000);
```

- [ ] **Step 4: Прогнать REAL-сценарий**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-telegram exec vitest run extraction.real`
Expected: PASS нового сценария; без `RUN_REAL=1` — `skipped`.

Затем регресс существующего REAL-набора: `RUN_REAL=1 pnpm --filter dsh-balbes-telegram exec vitest run integration`
Expected: PASS без правок (общий профиль не менялся).

Если шаг (b) падает на отсутствии `propose_memory` в запросе служебного хода, значит динамическая регистрация инструмента после `setup` в этой версии dsh не работает: остановиться и вернуться к пользователю с запасным вариантом из спеки (регистрация обоих инструментов в `setup`), не «дожимая» тест.

- [ ] **Step 5: Коммит**

```bash
git add packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-extraction-profile \
        packages/plugins/dsh-balbes-telegram/tests/extraction.real.test.ts
git commit -m "test(telegram): prove extraction end to end over the real composition (p10g)"
```

---

### Task 5: runbook и закрывающая проверка

**Files:**
- Modify: `docs/runbooks/stage2-vps.md` (после блока smoke ревью, перед «Артефакт БД»)

**Interfaces:**
- Consumes: всё вышеперечисленное.
- Produces: серверная процедура проверки извлечения; подтверждённые локальные проверки.

- [ ] **Step 1: Добавить в runbook smoke извлечения**

Вставить в `docs/runbooks/stage2-vps.md` после закрывающего ` ``` ` блока p10f-ревью:

````markdown
Автоизвлечение из Telegram-задачи (p10g):

```bash
# 1) дать боту задачу, которая требует работы инструментом (не «привет»),
#    например: «прочитай README.md в проекте и перескажи одной строкой»
# ожидается: обычный ответ агента в чате; ответ приходит ДО извлечения

# 2) предложение извлечения ждёт решения владельца
curl -fsS -X POST http://127.0.0.1:8080/api/memory/review/list \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"status":["proposed"]}'
# ожидается: среди proposals новое с "status":"proposed",
#   "originRef":"telegram session:<id>" и текстом из задачи; в /api/memory/list
#   того же текста нет — извлечённое не стало истиной

# 3) негативная проверка: задача без работы инструментов не извлекается
#    («привет» в Telegram), затем повторить шаг 2
# ожидается: число ожидающих предложений не изменилось

# 4) след извлечения в журнале — без текста памяти
journalctl -u dsh-balbes -n 200 | grep 'balbes-memory-context: extraction'
# ожидается (при уровне info): «... extraction channel=telegram scope=...
#   proposed=1 duplicate=0 secret=0 limit=0»; отсутствие строки — норма при
#   журналировании только warn/error, warn появляется при сбое извлечения

# 5) одобрение промоутит предложение в запись (тот же smoke, что у p10f)
curl -fsS -X POST http://127.0.0.1:8080/api/memory/review/approve \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"id":"<proposal-id>"}'
# ожидается: {"proposal":{...,"status":"accepted",...},"record":{...,"origin":"agent",
#   "originRef":"telegram session:<id>",...}}
```
````

- [ ] **Step 2: Полная локальная проверка**

Run: `pnpm typecheck && pnpm test`
Expected: exit 0 на каждой команде; REAL-наборы пропущены (нет `RUN_REAL=1`).

Run (там, где есть `dsh` в `PATH`): `RUN_REAL=1 pnpm --filter dsh-balbes-memory-context test && RUN_REAL=1 pnpm --filter dsh-balbes-telegram test`
Expected: PASS, включая p10c/p10f REAL-наборы без правок.

- [ ] **Step 3: Коммит**

```bash
git add docs/runbooks/stage2-vps.md
git commit -m "docs(runbook): verify memory extraction on the server (p10g)"
```

- [ ] **Step 4: Закрыть инициативу каноном**

Запустить `canon-audit` по теме памяти: сверить код с подсекцией «Автоизвлечение знания (p10g)» и терминами глоссария; после подтверждённого аудита — `canon-future-plan` для перевода p10g в `absorbed` и синка `future_plans/INDEX.md` (аудит и статус — вне коммитов кода).

---

## Self-Review

**Покрытие спеки:** триггер и гейт — Task 3 Step 4 (`runExtractionTurn`) + Task 2 (`qualifies`); служебный ход и его порядок — Task 3 Step 4 (резолв до хода, `busy` до конца); переключение поверхности — Task 2 Step 4 (`begin`/`end`) + REAL-проверка в Task 4; `propose_memory` (параметры, потолок, провенанс, путь `propose`) — Task 1; входной дедуп и fail-open — Task 1 (`loadProposalIndex`, `ProposalIndex`); бюджет (гейт, ≤3, без классификатора) — Task 1/2/3; приватность (секреты через `propose`, счётчики без текста) — Task 1 Step 4 и Task 2 Step 4; деградация (сбой хода, срыв драйвера, отсутствие шва) — Task 3 тесты; каналы (только Telegram, host-шов не вызывается) — отсутствие правок `runner.ts`; канон — уже поглощён, runbook — Task 5.

**Изоляция REAL-проверки:** сценарий p10g живёт в своём профиле и своём файле, потому что существующий `integration.test.ts` содержит задачи с вызовами инструментов (апрувы), которым memory-ряды в общем профиле добавили бы лишний запрос модели; общий набор остаётся нетронутым и служит регрессом.

**Плейсхолдеры:** нет; в Task 2 Step 4 тело `prepare` помечено как «не меняется» с указанием, где его взять (текущий `context.ts`), потому что это дословно существующий код.

**Согласованность имён:** `MemoryExtractionHandle` (пакет) ↔ `MemoryExtractionHandleLike` (канал, структурный срез) — намеренно разные имена, поля совпадают (`qualifies`/`begin`/`end`); `ExtractionCounters` создаётся один раз на attachment, поэтому счётчики накапливают только текущий служебный ход; `proposed` — единственный счётчик, который тратит потолок; `EXTRACTION_NOTICE_SUMMARY` дублируется в канале как локальная константа, потому что канал не импортирует пакет (структурный шов).
