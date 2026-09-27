# Доставка памяти в контекст (p10c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать долговременную память видимой модели: agent-scoped секция ядра (pinned) и карты, push top-K по тексту задачи и инструмент `recall` — строго на чтение, без изменения цикла dsh.

**Architecture:** Новый пакет `dsh-balbes-memory-context` предоставляет сервис `balbesMemoryContext` с `attach(agentCtx, scope)`. `attach` регистрирует в scope агента секцию `balbes:memory`, runtime-контекст `balbes:memory-push` и scoped-инструмент `recall`. Dispatch (`runner.ts` для `/api/prompt`, `agentTask.ts` для Telegram) зовёт `attach` в agent-scoped `setup` и `await prepare(taskText)` перед `followup`.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Cordis-плагины dsh, defineTool из @deepseek-ai/dsh-tools, сервис balbesMemory (p10a) через структурный срез, vitest, REAL-композиция через настоящий CLI dsh с локальным SSE-стабом LLM.

**Spec:** `docs/superpowers/specs/2026-09-27-memory-context-design.md`

## Global Constraints

- `docs/canon/**` НЕ редактируется вручную — только через `canon-write` / `canon-future-plan`. Порядок canon-first: канон → go-ahead владельца → код.
- Установленные `@deepseek-ai/*` — зависимость, не форк: не редактировать и не патчить.
- Плагины: named-export `name`/`inject`/`Config`/`apply`, без default-export.
- Строгий TS, ESM only, локальные относительные импорты с расширением `.js`; тесты в `tests/` (vitest).
- Бюджеты (символы): ядро `4096`, карта `4096`, push `2048` и максимум `5` записей; preview карты `100`.
- Scope-фильтр всех чтений: `[{ kind: "global" }, { kind: "project", name }]`; дом — только `global`.
- Слой только читает память: `save/update/delete` не вызываются.
- REAL-тесты гейтятся `RUN_REAL=1` + `dsh` в PATH; подменяется только внешняя LLM-граница (локальный SSE-стаб).
- Локальные проверки: `pnpm typecheck` и тесты; скрипта `lint` в репозитории нет.
- После каждого шага — коммит; после каждой задачи тесты зелёные.

---

## File Structure

**Новый пакет `packages/plugins/dsh-balbes-memory-context/`**
- `package.json`, `tsconfig.json`, `tsconfig.build.json` — каркас пакета (по образцу `dsh-balbes-memory`).
- `src/types.ts` — scope/attachment/service + read-only структурный срез `balbesMemory`.
- `src/query.ts` — безопасный FTS-запрос из свободного текста.
- `src/render.ts` — рендер ядра, карты, push + экранирование `{{`.
- `src/recall.ts` — `defineTool` `recall`.
- `src/context.ts` — `createMemoryContext`: `attach`/`prepare`.
- `src/index.ts` — функциональный плагин, `ctx.provide("balbesMemoryContext", ...)`.
- `tests/query.test.ts`, `tests/render.test.ts`, `tests/context.test.ts`, `tests/recall.test.ts`, `tests/index.test.ts`.
- `tests/fixtures/balbes-memory-context-profile/{cordis.patch.yml,package.json}`, `tests/helpers/stub-llm.mjs`, `tests/integration.test.ts`.

**Изменения**
- `packages/bundles/dsh-balbes-host/src/runner.ts` — attach/prepare для `/api/prompt` (global).
- `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` — опциональная `memory?`-зависимость, хранение attachment в `KeyedEntry`, `prepare` перед `followup`.
- `packages/plugins/dsh-balbes-telegram/src/index.ts` — прокинуть `ctx.get("balbesMemoryContext")` в раннер.
- `profiles/balbes/cordis.patch.yml`, `scripts/install.sh`, `docs/runbooks/stage2-vps.md` — композиция, копирование, smoke.
- Канон — через `canon-write` (Task 1), не вручную.

---

### Task 1: Canon-first — живой канон и gate

**Files:**
- Modify (только через skill `canon-write`): `docs/canon/ARCHITECTURE.md`, `docs/canon/GLOSSARY.md`, `docs/canon/OVERVIEW.md`
- Modify (через skill `canon-future-plan`): `docs/canon/future_plans/p10c-memory-context.md`, `docs/canon/future_plans/INDEX.md`

**Interfaces:**
- Consumes: утверждённую спеку `docs/superpowers/specs/2026-09-27-memory-context-design.md`.
- Produces: обновлённый живой канон, на который ссылается код; gate на go-ahead владельца.

- [ ] **Step 1: Обновить живой канон через `canon-write`**

Загрузи skill `canon-write` и внеси в `docs/canon/ARCHITECTURE.md` раздел `## Memory layer`:

1. Замени в вводном абзаце утверждение «Слой невидим модели: он не подмешивается в контекст (p10c), не имеет инструментов и секций системного промпта» на факт доставки: память подмешивается в контекст agent-scoped слоем доставки; инструмент `recall` и секции/контекст существуют; автонаполнения по-прежнему нет (p10d).
2. Добавь подраздел после `### Поверхность управления (p10b)`:

```markdown
### Доставка в контекст (p10c)

- Отдельный пакет `packages/plugins/dsh-balbes-memory-context` — функциональный
  плагин `name = "balbes-memory-context"`, `Config = z.object({})`, без `inject`;
  `apply` делает ровно `ctx.provide("balbesMemoryContext", service)`. Сервис
  читает `balbesMemory`/`systemPrompt`/`tools` лениво в scope агента при
  `attach(agentCtx, scope)` и при отсутствии любого из них деградирует в no-op.
- `attach` регистрирует в scope агента: секцию `balbes:memory` (order 120) —
  ядро закреплённых записей и карту; runtime-контекст `balbes:memory-push`
  (order 200) — релевантный push; scoped-инструмент `recall`. Все регистрации
  снимаются вместе с agent-scoped эффектами.
- Режим — гибрид. **Ядро**: только `pinned` дома и текущего проекта, полный
  текст, жёсткий бюджет 4096 символов; не влезшие записи опускаются со счётчиком.
  **Карта**: по строке на запись `[type · origin · scope] #tags preview…`,
  preview ≈ 100 символов, бюджет 4096, остаток — счётчик `… ещё N`.
  **Push**: FTS-bm25 по тексту задачи, scope дом + текущий проект, до 5 записей
  / 2048 символов; записи, уже показанные в ядре, пропускаются.
- Поисковый запрос строит слой: токены `[\p{L}\p{N}_]+` в нижнем регистре,
  длина ≥ 2, дедуп, максимум 24, каждый в кавычках, соединение ` OR `. Сырой
  текст в FTS5 `MATCH` не попадает (p10a передаёт строку verbatim); фраз,
  префиксов и `NEAR` в v1 нет.
- `recall` — scoped `defineTool`, только чтение: параметры `query`
  (required), `type`, `tag`, `pinned`, `limit` (дефолт 10, максимум 20);
  параметра `scope` нет. Вывод — записи с провенансом (`id`, `origin`,
  `originRef`, время, теги). Все чтения фильтруют
  `scopes: [global, currentProject]`, поэтому память чужого проекта недостижима
  структурно.
- Текст памяти экранируется `{{` → `{ {` (строгая интерполяция промпта).
  Ошибки хранилища/форматирования ловятся: снапшот пустой, ход агента не
  ломается. `prepare` пишет одну `logger.info`-строку со счётчиками (без
  текста памяти).
- Проводка: host `runner.ts` (`/api/prompt`, scope `global`) и Telegram
  `agentTask.ts` (scope из workspace ref) зовут `attach` в agent-scoped
  `setup` и `await prepare(taskText)` перед `followup`.
- Границы: модельный write/`remember`, автоизвлечение, дедуп, TTL, конфликты,
  ревью и метрики пользы — p10d. HTTP-ручек и UI у доставки нет.
```

3. В `### Границы и успех` убери «подмешивание в контекст и инструменты (p10c)» из списка «Не входят» и добавь в «Успех»: память доставляется — pinned-записи видны в системном промпте, push-записи и `recall` доступны агенту, чужой проект не возвращается, при недоступном хранилище доставка деградирует в no-op.

4. В `docs/canon/GLOSSARY.md` добавь термины в конец тематического блока памяти:

```markdown
### Ядро памяти (memory core)
Всегда подмешиваемый слой: закреплённые (`pinned`) записи дома и текущего
проекта, полным текстом, с жёстким бюджетом; не влезшие записи доступны через
карту и `recall`.

### Карта памяти (memory map)
Компактный индекс доступных записей: по строке на запись — тип, провенанс,
scope, теги и короткий preview; обрезается бюджетом со счётчиком остатка.

### Доставка памяти (memory delivery)
Agent-scoped слой, делающий память видимой модели: секция ядра и карты,
runtime-контекст релевантного push и инструмент `recall`. Только чтение;
модельный write — p10d.
```

5. В `docs/canon/OVERVIEW.md` добавь в перечень этапов/сигналов успеха, что долговременная память доставляется в контекст агента (p10c), оставаясь под контролем владельца.

- [ ] **Step 2: Обновить статус инициативы через `canon-future-plan`**

Загрузи skill `canon-future-plan`: у `docs/canon/future_plans/p10c-memory-context.md` поставь `Status: implementing`, добавь `Design: docs/superpowers/specs/2026-09-27-memory-context-design.md` и закрой открытые вопросы (режим — гибрид; ядро — pinned/budget; карта — построчная; провенанс — в recall; `remember` — p10d). Синхронизируй строку 10c в `docs/canon/future_plans/INDEX.md`.

- [ ] **Step 3: Проверить канон скаутом**

Run: `doc-canon scout "доставка памяти ядро карта recall remember"`
Expected: verdict `sufficient`; `p10c-memory-context.md` и `ARCHITECTURE.md` в топе; упоминаний «память невидима модели» больше нет.

- [ ] **Step 4: Commit**

```bash
git add docs/canon
git commit -m "docs(canon): deliver long-term memory into agent context (p10c)"
```

- [ ] **Step 5: GATE — запросить go-ahead владельца**

Остановись и явно спроси владельца, начинать ли код. Задачи 2–11 выполняются ТОЛЬКО после ответа «да».

---

### Task 2: Каркас пакета и контракт плагина

**Files:**
- Create: `packages/plugins/dsh-balbes-memory-context/package.json`
- Create: `packages/plugins/dsh-balbes-memory-context/tsconfig.json`
- Create: `packages/plugins/dsh-balbes-memory-context/tsconfig.build.json`
- Create: `packages/plugins/dsh-balbes-memory-context/src/types.ts`
- Create: `packages/plugins/dsh-balbes-memory-context/src/index.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/index.test.ts`

**Interfaces:**
- Consumes: ничего из предыдущих задач (Task 1 — канон).
- Produces: `name = "balbes-memory-context"`, `Config`, `apply(ctx, config)`, сервис `balbesMemoryContext` типа `BalbesMemoryContextService`.

- [ ] **Step 1: Создать каркас пакета**

`packages/plugins/dsh-balbes-memory-context/package.json`:

```json
{
  "name": "dsh-balbes-memory-context",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "dsh-balbes-contracts": "workspace:*",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "lib",
    "rootDir": "src",
    "declarationDir": "lib/types"
  },
  "include": ["src"]
}
```

Run: `pnpm install --frozen-lockfile=false`
Expected: пакет слинкован в workspace (`packages/plugins/dsh-balbes-memory-context/node_modules` содержит `dsh-balbes-contracts` и `vitest`).

- [ ] **Step 2: Написать `src/types.ts`**

```ts
import type { MemoryRecord, MemoryScope } from "dsh-balbes-contracts";

export type { MemoryRecord, MemoryScope } from "dsh-balbes-contracts";

/** Уровень, для которого включается доставка: дом (global) или один проект. */
export type MemoryContextScope = { kind: "global" } | { kind: "project"; name: string };

/** Read-only срез фильтра сервиса balbesMemory, нужный этому слою. */
export interface MemoryReadFilter {
  scopes?: MemoryScope[];
  type?: MemoryRecord["type"];
  tag?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemorySearchHit {
  record: MemoryRecord;
  rank: number;
}

/** Read-only структурный срез p10a: слой никогда не пишет. */
export interface BalbesMemoryReadSlice {
  list(filter?: MemoryReadFilter): Promise<MemoryRecord[]>;
  search(request: { query: string; filter?: MemoryReadFilter; limit?: number }): Promise<MemorySearchHit[]>;
  count(filter?: MemoryReadFilter): Promise<number>;
}

/** Per-agent handle; prepare() рендерит блоки одного хода. */
export interface MemoryContextAttachment {
  prepare(taskText: string): Promise<void>;
}

export interface BalbesMemoryContextService {
  attach(agentCtx: unknown, scope: MemoryContextScope): MemoryContextAttachment;
}
```

- [ ] **Step 3: Написать падающий тест `tests/index.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { apply, name, Config } from "../src/index.js";

describe("balbes-memory-context plugin", () => {
  it("exposes the functional plugin contract", () => {
    expect(name).toBe("balbes-memory-context");
    expect(Config).toBeDefined();
    expect(Config({})).toEqual({});
  });

  it("provides balbesMemoryContext on apply", () => {
    const provided = new Map<string, unknown>();
    apply(
      {
        provide(key, value) {
          provided.set(key, value);
        },
        logger: { warn() {}, info() {} }
      },
      {}
    );
    const service = provided.get("balbesMemoryContext") as { attach?: unknown } | undefined;
    expect(typeof service?.attach).toBe("function");
  });
});
```

- [ ] **Step 4: Запустить тест — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-memory-context test`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 5: Написать `src/index.ts`**

```ts
import z from "@deepseek-ai/schemastery";
import { createMemoryContext, type MemoryContextLogger } from "./context.js";
import type { BalbesMemoryContextService } from "./types.js";

export const name = "balbes-memory-context";
export const Config = z.object({});

interface CtxLike {
  provide(key: string, value: unknown): void;
  logger: MemoryContextLogger;
}

export function apply(ctx: CtxLike, _config: unknown): void {
  const service: BalbesMemoryContextService = createMemoryContext(ctx.logger);
  ctx.provide("balbesMemoryContext", service);
}
```

- [ ] **Step 6: Реализовать заглушку `src/context.ts`**

Пока достаточно временного модуля, чтобы тест Task 2 прошёл; полностью он заменяется в Task 5:

```ts
import type { BalbesMemoryContextService } from "./types.js";

export interface MemoryContextLogger {
  warn(message: string): void;
  info?(message: string): void;
}

export function createMemoryContext(_logger: MemoryContextLogger): BalbesMemoryContextService {
  return { attach: () => ({ prepare: async () => {} }) };
}
```

- [ ] **Step 7: Запустить тест — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-memory-context test`
Expected: PASS (2 теста).

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: без ошибок.

- [ ] **Step 9: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context
git commit -m "feat(memory-context): scaffold the memory delivery plugin"
```

---

### Task 3: Безопасный FTS-запрос

**Files:**
- Create: `packages/plugins/dsh-balbes-memory-context/src/query.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/query.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `buildFtsQuery(text: string): string`, `tokenizeQuery(text: string): string[]`, `MAX_QUERY_TOKENS`, `MIN_TOKEN_LENGTH`.

- [ ] **Step 1: Написать падающий тест `tests/query.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { buildFtsQuery, tokenizeQuery, MAX_QUERY_TOKENS } from "../src/query.js";

describe("buildFtsQuery", () => {
  it("lower-cases, de-duplicates and quotes terms joined by OR", () => {
    expect(buildFtsQuery("Deploy the Deploy command!")).toBe('"deploy" OR "the" OR "command"');
  });

  it("drops one-character terms", () => {
    expect(buildFtsQuery("a go to x y")).toBe('"go" OR "to"');
  });

  it("returns an empty string when no usable term remains", () => {
    expect(buildFtsQuery(" !!! ,, a ")).toBe("");
    expect(tokenizeQuery("!!!")).toEqual([]);
  });

  it("caps the number of terms", () => {
    const words = Array.from({ length: 40 }, (_, index) => "term" + index).join(" ");
    expect(tokenizeQuery(words).length).toBe(MAX_QUERY_TOKENS);
  });

  it("never emits a bare FTS operator from raw task text", () => {
    expect(buildFtsQuery('deploy AND "prod" OR *')).toBe('"deploy" OR "and" OR "prod" OR "or"');
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-memory-context test -- query.test.ts`
Expected: FAIL — модуль `../src/query.js` не найден.

- [ ] **Step 3: Написать `src/query.ts`**

```ts
/** Максимум поисковых термов, взятых из одной строки задачи/запроса. */
export const MAX_QUERY_TOKENS = 24;
/** Минимальная длина терма, который стоит искать. */
export const MIN_TOKEN_LENGTH = 2;

const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;

/** Термы свободного текста: нижний регистр, дедуп, фильтр по длине, cap. */
export function tokenizeQuery(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of text.toLowerCase().matchAll(TOKEN_PATTERN)) {
    const token = match[0] ?? "";
    if (token.length < MIN_TOKEN_LENGTH || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= MAX_QUERY_TOKENS) break;
  }
  return tokens;
}

/**
 * Собрать FTS5-запрос, безопасный для memory_fts MATCH ?: термы в кавычках,
 * соединение OR. p10a передаёт строку в MATCH verbatim, поэтому сырой текст
 * задачи (с операторами FTS) как запрос не используется.
 * @returns запрос или "" когда в тексте нет пригодного терма.
 */
export function buildFtsQuery(text: string): string {
  return tokenizeQuery(text)
    .map((token) => '"' + token.replace(/"/g, '""') + '"')
    .join(" OR ");
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-memory-context test -- query.test.ts`
Expected: PASS (5 тестов).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context/src/query.ts packages/plugins/dsh-balbes-memory-context/tests/query.test.ts
git commit -m "feat(memory-context): build FTS queries safely from free text"
```

---

### Task 4: Рендер ядра, карты и push

**Files:**
- Create: `packages/plugins/dsh-balbes-memory-context/src/render.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/render.test.ts`

**Interfaces:**
- Consumes: `MemoryRecord`, `MemorySearchHit` из `./types.js`.
- Produces: `CORE_BUDGET`, `MAP_BUDGET`, `PUSH_BUDGET`, `PUSH_LIMIT`, `MAP_PREVIEW_LENGTH`, `escapeInterpolation`, `renderCore`, `renderMap`, `renderPush`, `scopeLabel`, `originLabel`; тип `RenderedBlock { text: string; shown: string[] }`.

- [ ] **Step 1: Написать падающий тест `tests/render.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import {
  CORE_BUDGET,
  escapeInterpolation,
  renderCore,
  renderMap,
  renderPush
} from "../src/render.js";

function record(partial: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    scope: { kind: "global" },
    type: "fact",
    tags: [],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    ...partial
  };
}

describe("renderCore", () => {
  it("renders only the records it is given, with provenance", () => {
    const result = renderCore([
      record({ id: "a", text: "Deploy via install.sh", pinned: true, tags: ["deploy"] }),
      record({ id: "b", text: "Prefer pnpm", type: "preference", origin: "agent", scope: { kind: "project", name: "proj" }, pinned: true })
    ]);
    expect(result.shown).toEqual(["a", "b"]);
    expect(result.text).toContain("## Long-term memory (pinned)");
    expect(result.text).toContain("- [fact · владелец] (дом) Deploy via install.sh #deploy");
    expect(result.text).toContain("- [preference · агент] (проект proj) Prefer pnpm");
  });

  it("is empty for no records", () => {
    expect(renderCore([])).toEqual({ text: "", shown: [] });
  });

  it("omits records that do not fit and counts them", () => {
    const big = record({ id: "big", text: "x".repeat(CORE_BUDGET), pinned: true });
    const result = renderCore([record({ id: "small", text: "fits", pinned: true }), big]);
    expect(result.shown).toEqual(["small"]);
    expect(result.text).toContain("ещё 1 закреплённых записей не поместились");
  });

  it("truncates the first oversized record and renders no later record", () => {
    const result = renderCore([
      record({ id: "huge", text: "y".repeat(CORE_BUDGET * 2), pinned: true }),
      record({ id: "next", text: "must not appear", pinned: true })
    ]);
    expect(result.shown).toEqual(["huge"]);
    expect(result.text).not.toContain("must not appear");
    expect(result.text).toContain("…");
  });
});

describe("renderMap", () => {
  it("skips core-shown records and counts the remainder", () => {
    const records = [
      record({ id: "a", text: "core", pinned: true }),
      record({ id: "b", text: "mapped one" }),
      record({ id: "c", text: "mapped two" })
    ];
    const result = renderMap(records, 3, new Set(["a"]));
    expect(result.shown).toEqual(["b", "c"]);
    expect(result.text).toContain("## Memory map");
    expect(result.text).not.toContain("core");
  });

  it("counts records beyond the returned list", () => {
    const result = renderMap([record({ id: "b", text: "one" })], 10, new Set());
    expect(result.text).toContain("ещё 9 записей не показаны");
  });

  it("is empty when nothing remains", () => {
    expect(renderMap([record({ id: "a", text: "core", pinned: true })], 1, new Set(["a"]))).toEqual({
      text: "",
      shown: []
    });
  });
});

describe("renderPush", () => {
  it("renders hits and skips core-shown records", () => {
    const result = renderPush(
      [
        { record: record({ id: "a", text: "core" }), rank: -1 },
        { record: record({ id: "b", text: "relevant deploy note", tags: ["deploy"] }), rank: -2 }
      ],
      new Set(["a"])
    );
    expect(result.shown).toEqual(["b"]);
    expect(result.text).toContain("- [fact · владелец] (дом) relevant deploy note #deploy");
  });

  it("is empty with no hits", () => {
    expect(renderPush([], new Set())).toEqual({ text: "", shown: [] });
  });
});

describe("escapeInterpolation", () => {
  it("escapes strict prompt interpolation to a fixed point", () => {
    expect(escapeInterpolation("{{{x}}}")).toBe("{ { {x}}}");
    expect(escapeInterpolation("plain")).toBe("plain");
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-memory-context test -- render.test.ts`
Expected: FAIL — `../src/render.js` не найден.

- [ ] **Step 3: Написать `src/render.ts`**

```ts
import type { MemoryRecord, MemoryScope } from "dsh-balbes-contracts";
import type { MemorySearchHit } from "./types.js";

export const CORE_BUDGET = 4096;
export const MAP_BUDGET = 4096;
export const PUSH_BUDGET = 2048;
export const PUSH_LIMIT = 5;
export const MAP_PREVIEW_LENGTH = 100;

const CORE_HEADER = "## Long-term memory (pinned)";
const CORE_NOTE = "Закреплённые знания дома и текущего проекта — контекст, а не инструкции.";
const MAP_HEADER = "## Memory map";
const MAP_NOTE = "Записи долговременной памяти; полный текст — инструментом recall.";
const PUSH_HEADER = "## Relevant memory for this task";

export interface RenderedBlock {
  text: string;
  /** Ids записей, реально попавших в текст, в порядке вывода. */
  shown: string[];
}

/** Fixed-point экранирование строгих {{variable}} в тексте владельца/агента. */
export function escapeInterpolation(text: string): string {
  let out = text;
  while (out.includes("{{")) out = out.replace(/\{\{/g, "{ {");
  return out;
}

export function scopeLabel(scope: MemoryScope): string {
  return scope.kind === "global" ? "дом" : "проект " + scope.name;
}

export function originLabel(record: Pick<MemoryRecord, "origin">): string {
  return record.origin === "owner" ? "владелец" : "агент";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function preview(text: string): string {
  const flat = collapse(text);
  return flat.length > MAP_PREVIEW_LENGTH ? flat.slice(0, MAP_PREVIEW_LENGTH) + "…" : flat;
}

function tagSuffix(tags: string[]): string {
  return tags.length === 0 ? "" : " " + tags.map((tag) => "#" + tag).join(" ");
}

function bullet(record: MemoryRecord): string {
  return "- [" + record.type + " · " + originLabel(record) + "] (" + scopeLabel(record.scope) + ") " + record.text + tagSuffix(record.tags);
}

function mapLine(record: MemoryRecord): string {
  return "- [" + record.type + " · " + originLabel(record) + " · " + scopeLabel(record.scope) + "]" + tagSuffix(record.tags) + " " + preview(record.text);
}

export function renderCore(records: readonly MemoryRecord[]): RenderedBlock {
  if (records.length === 0) return { text: "", shown: [] };
  const lines = [CORE_HEADER, CORE_NOTE];
  const shown: string[] = [];
  let used = lines.join("\n").length;
  for (const [index, record] of records.entries()) {
    const line = bullet(record);
    if (used + line.length + 1 <= CORE_BUDGET) {
      lines.push(line);
      shown.push(record.id);
      used += line.length + 1;
      continue;
    }
    if (index === 0 && shown.length === 0) {
      const overhead = bullet({ ...record, text: "", tags: [] }).length;
      const maxText = CORE_BUDGET - used - overhead - 1;
      if (maxText > 20) {
        const truncated = bullet({ ...record, text: collapse(record.text).slice(0, maxText - 1) + "…", tags: [] });
        lines.push(truncated);
        shown.push(record.id);
        used += truncated.length + 1;
      }
    }
  }
  const omitted = records.length - shown.length;
  if (omitted > 0) lines.push("… ещё " + omitted + " закреплённых записей не поместились — ищи через recall.");
  return { text: lines.join("\n"), shown };
}

export function renderMap(records: readonly MemoryRecord[], total: number, coreShown: ReadonlySet<string>): RenderedBlock {
  const lines = [MAP_HEADER, MAP_NOTE];
  const shown: string[] = [];
  let used = lines.join("\n").length;
  for (const record of records) {
    if (coreShown.has(record.id)) continue;
    const line = mapLine(record);
    if (used + line.length + 1 > MAP_BUDGET) break;
    lines.push(line);
    shown.push(record.id);
    used += line.length + 1;
  }
  const omitted = Math.max(0, total - coreShown.size - shown.length);
  if (omitted > 0) lines.push("… ещё " + omitted + " записей не показаны — уточни запрос через recall.");
  if (shown.length === 0 && omitted === 0) return { text: "", shown: [] };
  return { text: lines.join("\n"), shown };
}

export function renderPush(hits: readonly MemorySearchHit[], coreShown: ReadonlySet<string>): RenderedBlock {
  const lines = [PUSH_HEADER];
  const shown: string[] = [];
  let used = PUSH_HEADER.length;
  for (const hit of hits) {
    if (coreShown.has(hit.record.id)) continue;
    const line = bullet(hit.record);
    if (used + line.length + 1 > PUSH_BUDGET) break;
    lines.push(line);
    shown.push(hit.record.id);
    used += line.length + 1;
  }
  if (shown.length === 0) return { text: "", shown: [] };
  return { text: lines.join("\n"), shown };
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-memory-context test -- render.test.ts`
Expected: PASS (все тесты render).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context/src/render.ts packages/plugins/dsh-balbes-memory-context/tests/render.test.ts
git commit -m "feat(memory-context): render memory core, map and push blocks"
```

---

### Task 5: Сервис context — `attach` и `prepare`

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/src/context.ts` (полная замена заглушки Task 2)
- Test: `packages/plugins/dsh-balbes-memory-context/tests/context.test.ts`

**Interfaces:**
- Consumes: `buildFtsQuery` (Task 3), `renderCore`/`renderMap`/`renderPush`/`escapeInterpolation` (Task 4), типы `BalbesMemoryReadSlice`/`MemoryContextScope` (Task 2).
- Produces: `createMemoryContext(logger): BalbesMemoryContextService`, `MEMORY_SECTION_NAME`, `MEMORY_SECTION_ORDER = 120`, `MEMORY_CONTEXT_NAME`, `MEMORY_CONTEXT_ORDER = 200`, `scopesFor`.

- [ ] **Step 1: Написать падающий тест `tests/context.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import {
  createMemoryContext,
  MEMORY_CONTEXT_NAME,
  MEMORY_CONTEXT_ORDER,
  MEMORY_SECTION_NAME,
  MEMORY_SECTION_ORDER
} from "../src/context.js";
import type { BalbesMemoryReadSlice, MemoryReadFilter } from "../src/types.js";

function record(partial: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    scope: { kind: "global" },
    type: "fact",
    tags: [],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    ...partial
  };
}

interface SectionSpec {
  name: string;
  order: number;
  text: () => string;
}
interface Harness {
  agentCtx: unknown;
  sections: SectionSpec[];
  contexts: SectionSpec[];
  tools: unknown[];
  warnings: string[];
  infos: string[];
}

function harness(records: MemoryRecord[], options: { withoutTools?: boolean } = {}): Harness {
  const sections: SectionSpec[] = [];
  const contexts: SectionSpec[] = [];
  const tools: unknown[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const memory: BalbesMemoryReadSlice = {
    list: async (_filter?: MemoryReadFilter) => records,
    count: async (_filter?: MemoryReadFilter) => records.length,
    search: async () =>
      records.filter((r) => r.text.includes("deploy")).map((r) => ({ record: r, rank: -1 }))
  };
  const agentCtx = {
    get(key: string): unknown {
      if (key === "balbesMemory") return memory;
      if (key === "systemPrompt") {
        return {
          section: (spec: SectionSpec) => {
            sections.push(spec);
            return () => {};
          },
          context: (spec: SectionSpec) => {
            contexts.push(spec);
            return () => {};
          }
        };
      }
      if (key === "tools" && options.withoutTools !== true) {
        return {
          register: (definition: unknown) => {
            tools.push(definition);
            return () => {};
          }
        };
      }
      return undefined;
    }
  };
  const service = createMemoryContext({
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message)
  });
  const harnessValue: Harness = { agentCtx, sections, contexts, tools, warnings, infos };
  Object.defineProperty(harnessValue, "attach", {
    value: service.attach.bind(service),
    enumerable: false
  });
  return harnessValue;
}

type HarnessWithAttach = Harness & {
  attach(agentCtx: unknown, scope: { kind: "global" } | { kind: "project"; name: string }): {
    prepare(taskText: string): Promise<void>;
  };
};

describe("createMemoryContext", () => {
  it("registers the section and the push context", () => {
    const h = harness([record({ id: "a", text: "hello" })]) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "global" });
    expect(h.sections.map((s) => [s.name, s.order])).toEqual([[MEMORY_SECTION_NAME, MEMORY_SECTION_ORDER]]);
    expect(h.contexts.map((c) => [c.name, c.order])).toEqual([[MEMORY_CONTEXT_NAME, MEMORY_CONTEXT_ORDER]]);
    expect(typeof attachment.prepare).toBe("function");
  });

  it("renders core+map into the section and push into the context", async () => {
    const h = harness([
      record({ id: "core", text: "Pinned deploy rule", pinned: true }),
      record({ id: "push", text: "deploy rollback procedure" })
    ]) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "global" });
    await attachment.prepare("deploy");
    expect(h.sections[0]!.text()).toContain("Pinned deploy rule");
    expect(h.sections[0]!.text()).toContain("## Memory map");
    expect(h.contexts[0]!.text()).toContain("deploy rollback procedure");
    expect(h.infos.join("\n")).toContain("scope=global");
  });

  it("escapes {{ in memory text", async () => {
    const h = harness([record({ id: "a", text: "literal {{name}}", pinned: true })]) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "global" });
    await attachment.prepare("anything");
    expect(h.sections[0]!.text()).toContain("{ {name}}");
  });

  it("is a no-op without tools", () => {
    const h = harness([], { withoutTools: true }) as HarnessWithAttach;
    h.attach(h.agentCtx, { kind: "global" });
    expect(h.sections).toHaveLength(0);
    expect(h.warnings[0]).toMatch(/missing/);
  });

  it("never throws from prepare when the store fails", async () => {
    const h = harness([]) as HarnessWithAttach;
    const failing = {
      get(key: string): unknown {
        if (key === "balbesMemory") {
          return { list: async () => { throw new Error("db down"); }, count: async () => 0, search: async () => [] };
        }
        return (h.agentCtx as { get(key: string): unknown }).get(key);
      }
    };
    const attachment = h.attach(failing, { kind: "global" });
    await expect(attachment.prepare("x")).resolves.toBeUndefined();
    expect(h.warnings.join("\n")).toContain("prepare failed");
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-memory-context test -- context.test.ts`
Expected: FAIL — нет экспортов `MEMORY_SECTION_NAME` и т.д.

- [ ] **Step 3: Полностью заменить `src/context.ts`**

```ts
import type { MemoryRecord, MemoryScope } from "dsh-balbes-contracts";
import { buildFtsQuery } from "./query.js";
import { escapeInterpolation, renderCore, renderMap, renderPush } from "./render.js";
import type {
  BalbesMemoryContextService,
  BalbesMemoryReadSlice,
  MemoryContextScope
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
    attach(agentCtx: unknown, scope: MemoryContextScope) {
      const ctx = agentCtx as AgentCtxLike;
      const memory = ctx.get("balbesMemory") as BalbesMemoryReadSlice | undefined;
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
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `pnpm --filter dsh-balbes-memory-context test`
Expected: PASS (index + context + query + render).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context/src/context.ts packages/plugins/dsh-balbes-memory-context/tests/context.test.ts
git commit -m "feat(memory-context): attach core/map/push to the agent scope"
```

---

### Task 6: Инструмент `recall`

**Files:**
- Create: `packages/plugins/dsh-balbes-memory-context/src/recall.ts`
- Modify: `packages/plugins/dsh-balbes-memory-context/src/context.ts` (зарегистрировать инструмент)
- Test: `packages/plugins/dsh-balbes-memory-context/tests/recall.test.ts`

**Interfaces:**
- Consumes: `buildFtsQuery` (Task 3), `originLabel`/`scopeLabel` (Task 4), `BalbesMemoryReadSlice` (Task 2).
- Produces: `buildRecallTool(memory, scopes)` → `ToolDefinition`; в `attach` регистрируется через `tools.register(...)`.

- [ ] **Step 1: Написать падающий тест `tests/recall.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "dsh-balbes-contracts";
import { buildRecallTool, clampRecallLimit, RECALL_DEFAULT_LIMIT, RECALL_MAX_LIMIT } from "../src/recall.js";
import type { BalbesMemoryReadSlice } from "../src/types.js";

function record(id: string, text: string): MemoryRecord {
  return {
    id,
    scope: { kind: "global" },
    type: "fact",
    text,
    tags: ["deploy"],
    pinned: false,
    origin: "owner",
    originRef: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z"
  };
}

describe("buildRecallTool", () => {
  it("searches within the fixed scopes and returns the records", async () => {
    const calls: unknown[] = [];
    const memory: BalbesMemoryReadSlice = {
      list: async () => [],
      count: async () => 0,
      search: async (request) => {
        calls.push(request);
        return [{ record: record("a", "deploy procedure"), rank: -1 }];
      }
    };
    const tool = buildRecallTool(memory, [{ kind: "global" }, { kind: "project", name: "proj" }]);
    const value = (await tool.execute({ query: "deploy rollback", limit: 5 }, {} as never)) as {
      records: MemoryRecord[];
    };
    expect(value.records.map((r) => r.id)).toEqual(["a"]);
    expect(calls).toEqual([
      {
        query: '"deploy" OR "rollback"',
        filter: { scopes: [{ kind: "global" }, { kind: "project", name: "proj" }] },
        limit: 5
      }
    ]);
  });

  it("returns nothing for a query with no usable terms", async () => {
    const memory: BalbesMemoryReadSlice = {
      list: async () => [],
      count: async () => 0,
      search: async () => {
        throw new Error("search must not be called");
      }
    };
    const tool = buildRecallTool(memory, [{ kind: "global" }]);
    const value = (await tool.execute({ query: "!!!" }, {} as never)) as { records: MemoryRecord[] };
    expect(value.records).toEqual([]);
  });

  it("passes type/tag/pinned filters through", async () => {
    let seen: unknown;
    const memory: BalbesMemoryReadSlice = {
      list: async () => [],
      count: async () => 0,
      search: async (request) => {
        seen = request;
        return [];
      }
    };
    const tool = buildRecallTool(memory, [{ kind: "global" }]);
    await tool.execute({ query: "deploy", type: "decision", tag: "prod", pinned: true }, {} as never);
    expect(seen).toEqual({
      query: '"deploy"',
      filter: { scopes: [{ kind: "global" }], type: "decision", tag: "prod", pinned: true },
      limit: RECALL_DEFAULT_LIMIT
    });
  });

  it("renders provenance in the model-facing text", () => {
    const tool = buildRecallTool({ list: async () => [], count: async () => 0, search: async () => [] }, [
      { kind: "global" }
    ]);
    const value = { records: [record("a", "deploy procedure")] };
    const blocks = tool.output.render({ query: "deploy" } as never, value as never);
    const text = blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(text).toContain("deploy procedure");
    expect(text).toContain("id: a");
    expect(text).toContain("владелец");
  });
});

describe("clampRecallLimit", () => {
  it("defaults, floors and caps", () => {
    expect(clampRecallLimit(undefined)).toBe(RECALL_DEFAULT_LIMIT);
    expect(clampRecallLimit(0)).toBe(1);
    expect(clampRecallLimit(999)).toBe(RECALL_MAX_LIMIT);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-memory-context test -- recall.test.ts`
Expected: FAIL — `../src/recall.js` не найден.

- [ ] **Step 3: Написать `src/recall.ts`**

```ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { MemoryRecord, MemoryScope } from "dsh-balbes-contracts";
import type { BalbesMemoryReadSlice } from "./types.js";
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

export function buildRecallTool(memory: BalbesMemoryReadSlice, scopes: MemoryScope[]) {
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
      const query = buildFtsQuery(args.query);
      if (query === "") return { records: [] };
      const filter: { scopes: MemoryScope[]; type?: MemoryRecord["type"]; tag?: string; pinned?: boolean } = {
        scopes
      };
      if (args.type !== undefined) filter.type = args.type;
      if (args.tag !== undefined) filter.tag = args.tag;
      if (args.pinned !== undefined) filter.pinned = args.pinned;
      const hits = await memory.search({ query, filter, limit: clampRecallLimit(args.limit) });
      return { records: hits.map((hit) => hit.record) };
    }
  });
}
```

- [ ] **Step 4: Зарегистрировать инструмент в `src/context.ts`**

Добавь импорт рядом с остальными:

```ts
import { buildRecallTool } from "./recall.js";
```

И добавь регистрацию после строки регистрации контекста:

```ts
      systemPrompt.context({ name: MEMORY_CONTEXT_NAME, order: MEMORY_CONTEXT_ORDER, text: () => state.push });
      tools.register(buildRecallTool(memory, scopes));
```

Затем верни в `tests/context.test.ts` проверку инструмента: переименуй первый тест в «registers the section, the push context and the recall tool» и добавь строку `expect(h.tools).toHaveLength(1);` после проверки контекста.

- [ ] **Step 5: Запустить тесты — убедиться, что проходят**

Run: `pnpm --filter dsh-balbes-memory-context test`
Expected: PASS (все наборы).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: без ошибок.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context/src/recall.ts packages/plugins/dsh-balbes-memory-context/src/context.ts packages/plugins/dsh-balbes-memory-context/tests/recall.test.ts
git commit -m "feat(memory-context): add the read-only recall tool"
```

---

### Task 7: Проводка host `/api/prompt`

**Files:**
- Modify: `packages/bundles/dsh-balbes-host/src/runner.ts`
- Test: `packages/bundles/dsh-balbes-host/tests/runner.memory.test.ts`

**Interfaces:**
- Consumes: сервис `balbesMemoryContext` через `ctx.get`.
- Produces: host-промпт получает `attach(agentCtx, { kind: "global" })` и `await prepare(prompt)`.

- [ ] **Step 1: Написать падающий тест `tests/runner.memory.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { runPrompt } from "../src/runner.js";

function fakeAgent() {
  const events: Array<{ type: string; data: unknown }> = [];
  return {
    session: {
      get seq(): number {
        return events.length;
      },
      eventAt(seq: number) {
        return events[seq];
      }
    },
    whenIdle: async () => {},
    followup: () => {
      events.push({ type: "turn/start", data: {} });
      events.push({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "ok" }] } } });
      events.push({ type: "turn/end", data: { reason: { kind: "completed" } } });
    }
  };
}

describe("runPrompt memory delivery wiring", () => {
  it("attaches memory for the global scope and prepares the prompt", async () => {
    const scopes: unknown[] = [];
    const prepared: string[] = [];
    let seenAgentCtx: unknown;
    const ctx = {
      get(key: string): unknown {
        switch (key) {
          case "loader":
            return { await: async () => {} };
          case "agents":
            return {
              create: async (options: { setup: (agentCtx: unknown) => void }) => {
                seenAgentCtx = { on: () => () => {}, marker: "agent-ctx" };
                options.setup(seenAgentCtx);
                return { agent: fakeAgent(), dispose: async () => {} };
              }
            };
          case "agentDefaultModel":
            return { currentSelection: () => ({ provider: "p", model: "m" }) };
          case "sessions":
            return { flush: async () => {} };
          case "balbesMemoryContext":
            return {
              attach: (agentCtx: unknown, scope: unknown) => {
                expect(agentCtx).toBe(seenAgentCtx);
                scopes.push(scope);
                return { prepare: async (text: string) => void prepared.push(text) };
              }
            };
          default:
            return undefined;
        }
      }
    };
    const outcome = await runPrompt(ctx, "hello memory");
    expect(scopes).toEqual([{ kind: "global" }]);
    expect(prepared).toEqual(["hello memory"]);
    expect(outcome.text).toBe("ok");
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-host test -- runner.memory.test.ts`
Expected: FAIL — `scopes` пуст (проводки нет).

- [ ] **Step 3: Внести проводку в `src/runner.ts`**

Добавь структурный интерфейс рядом с `AgentsService`:

```ts
interface MemoryContextServiceLike {
  attach(agentCtx: unknown, scope: { kind: "global" }): { prepare(taskText: string): Promise<void> };
}
```

В `runPrompt` после получения `sessions` добавь:

```ts
  const memory = ctx.get("balbesMemoryContext") as MemoryContextServiceLike | undefined;
```

Объяви переменную рядом с `handle`:

```ts
  let memoryAttachment: { prepare(taskText: string): Promise<void> } | undefined;
```

Дополни `setup` и вставь `prepare` перед `followup`:

```ts
      setup: (agentCtx) => {
        installModelSelection(agentCtx as never, { current: selection, assembled: undefined });
        memoryAttachment = memory?.attach(agentCtx, { kind: "global" });
      }
    });
    const agent = handle.agent;
    await agent.whenIdle();
    await memoryAttachment?.prepare(prompt);
    const firstSeq = agent.session.seq;
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-host test -- runner.memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck пакета**

Run: `pnpm --filter dsh-balbes-host typecheck`
Expected: без ошибок.

- [ ] **Step 6: Commit**

```bash
git add packages/bundles/dsh-balbes-host/src/runner.ts packages/bundles/dsh-balbes-host/tests/runner.memory.test.ts
git commit -m "feat(host): deliver global memory into /api/prompt"
```

---

### Task 8: Проводка Telegram

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/agentTask.ts`
- Modify: `packages/plugins/dsh-balbes-telegram/src/index.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/agentTask.memory.test.ts`

**Interfaces:**
- Consumes: сервис `balbesMemoryContext` (структурный срез).
- Produces: agent-scoped `attach` при create/resume и `await entry.memory?.prepare(text)` перед каждым `followup`; scope из `WorkspaceRef`.

- [ ] **Step 1: Написать падающий тест `tests/agentTask.memory.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { createAgentTaskRunner, type AgentTaskDeps } from "../src/agentTask.js";

function fakeHandle() {
  const events: Array<{ type: string; data: unknown }> = [];
  return {
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
      followup: () => {
        events.push({ type: "turn/start", data: {} });
        events.push({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "ok" }] } } });
        events.push({ type: "turn/end", data: { reason: { kind: "completed" } } });
      },
      cancel: () => {},
      status: "idle"
    },
    dispose: async () => {}
  };
}

describe("agentTask memory delivery wiring", () => {
  it("attaches once per workspace and prepares every task text", async () => {
    const scopes: unknown[] = [];
    const prepared: string[] = [];
    const deps = {
      workspaces: {
        list: async () => ({ home: { path: "/home" }, projects: [] }),
        root: async () => "/home",
        readDir: async () => [],
        readFile: async () => ({ content: "", truncated: false })
      },
      agents: {
        create: async (options: { setup: (agentCtx: unknown) => void }) => {
          options.setup({ on: () => () => {} });
          return fakeHandle();
        },
        resume: async (options: { setup: (agentCtx: unknown) => void }) => {
          options.setup({ on: () => () => {} });
          return fakeHandle();
        }
      },
      sessions: { flush: async () => {} },
      defaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
      memory: {
        attach: (_agentCtx: unknown, scope: unknown) => {
          scopes.push(scope);
          return { prepare: async (text: string) => void prepared.push(text) };
        }
      }
    } as unknown as AgentTaskDeps;
    const runner = createAgentTaskRunner(deps);
    await runner.run({ scope: "project", name: "alpha" }, "first task");
    await runner.run({ scope: "project", name: "alpha" }, "second task");
    await runner.run({ scope: "home" }, "home task");
    expect(scopes).toEqual([{ kind: "project", name: "alpha" }, { kind: "global" }]);
    expect(prepared).toEqual(["first task", "second task", "home task"]);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram test -- agentTask.memory.test.ts`
Expected: FAIL — `scopes` пуст.

- [ ] **Step 3: Добавить зависимость `memory?` и интерфейсы в `src/agentTask.ts`**

Рядом с `ApprovalAttachment`:

```ts
export interface MemoryContextAttachmentLike {
  prepare(taskText: string): Promise<void>;
}
export interface MemoryContextServiceLike {
  attach(agentCtx: unknown, scope: { kind: "global" } | { kind: "project"; name: string }): MemoryContextAttachmentLike;
}
```

В `AgentTaskDeps` после `approvals?`:

```ts
  /**
   * Доставка долговременной памяти (p10c). Прикрепляется к агенту в общем
   * setup; prepare выполняется перед каждым followup. Отсутствует, когда
   * профиль не композирует плагин memory-context.
   */
  memory?: MemoryContextServiceLike;
```

- [ ] **Step 4: Хранить attachment в `KeyedEntry`**

Добавь поле в `interface KeyedEntry`:

```ts
  memory: MemoryContextAttachmentLike | undefined;
```

В создании записи (в `run()`, где перечислены `handle/sessionId/...`) добавь:

```ts
          memory: undefined,
```

- [ ] **Step 5: Захватить attachment в `acquireHandle`**

Измени сигнатуру и тело:

```ts
  async function acquireHandle(
    root: string,
    ref: WorkspaceRef,
    opts: { sessionId?: string } | undefined
  ): Promise<{ handle: AgentHandleLike; sessionId: string; memory: MemoryContextAttachmentLike | undefined }> {
    const selection = liveSelection(deps.defaultModel);
    let memory: MemoryContextAttachmentLike | undefined;
    const setup = (agentCtx: unknown): void => {
      composeAgentSetup(agentCtx, { selection: selection.ref });
      deps.approvals?.attach(agentCtx, ref);
      memory = deps.memory?.attach(
        agentCtx,
        ref.scope === "home" ? { kind: "global" } : { kind: "project", name: ref.name }
      );
    };
    if (opts?.sessionId !== undefined) {
      try {
        const handle = await deps.agents.resume({
          resumeSessionId: opts.sessionId,
          agentOptions: selection.initial,
          setup
        });
        return { handle, sessionId: opts.sessionId, memory };
      } catch (error) {
        deps.logger?.warn("dsh-balbes-telegram: resuming session \"" + opts.sessionId + "\" failed; creating a fresh session: " + errorMessage(error));
      }
    }
    const sessionId = brandString("session-" + randomUUID());
    const handle = await deps.agents.create({
      sessionId,
      meta: { cwd: root },
      agentOptions: selection.initial,
      setup
    });
    return { handle, sessionId, memory };
  }
```

- [ ] **Step 6: Пробросить attachment и звать `prepare`**

В `executeTurn` после `entry.sessionId = sessionId;` добавь:

```ts
        entry.memory = acquired.memory;
```

Перед `const firstSeq = agent.session.seq;` (после проверок retired/cancelled) добавь:

```ts
      await entry.memory?.prepare(text);
```

В catch-пути, где сбрасываются `entry.handle/entry.sessionId`, добавь сброс:

```ts
        entry.memory = undefined;
```

- [ ] **Step 7: Прокинуть сервис из `src/index.ts`**

Перед `const runner = createAgentTaskRunner({` добавь:

```ts
  const memoryContext = ctx.get("balbesMemoryContext") as AgentTaskDeps["memory"];
```

В объект аргументов добавь строку (рядом с `approvals`):

```ts
    ...(memoryContext !== undefined ? { memory: memoryContext } : {}),
```

- [ ] **Step 8: Запустить тесты — убедиться, что проходят**

Run: `pnpm --filter dsh-balbes-telegram test -- agentTask.memory.test.ts agentTask.test.ts`
Expected: PASS; существующий `agentTask.test.ts` не сломан (memory опционален).

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter dsh-balbes-telegram typecheck`
Expected: без ошибок.

- [ ] **Step 10: Commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/agentTask.ts packages/plugins/dsh-balbes-telegram/src/index.ts packages/plugins/dsh-balbes-telegram/tests/agentTask.memory.test.ts
git commit -m "feat(telegram): deliver workspace-scoped memory into tasks"
```

---

### Task 9: Композиция, установщик и runbook

**Files:**
- Modify: `profiles/balbes/cordis.patch.yml`
- Modify: `scripts/install.sh`
- Modify: `docs/runbooks/stage2-vps.md`

**Interfaces:**
- Consumes: собранный пакет `dsh-balbes-memory-context`.
- Produces: профиль `balbes` композирует `balbes-memory-context`; установщик копирует его lib в профиль; runbook описывает проверку.

- [ ] **Step 1: Добавить строку в профиль**

В `profiles/balbes/cordis.patch.yml` после `balbes-memory` добавь:

```yaml
    - id: balbes-memory-context
      name: 'dsh-balbes-memory-context'
```

- [ ] **Step 2: Добавить функцию копирования в `scripts/install.sh`**

После `copy_memory_into_profile` добавь:

```bash
# copy_memory_context_into_profile — зеркало copy_memory_into_profile: собранный
# плагин доставки памяти копируется в node_modules профиля.
copy_memory_context_into_profile() {
    local profile_dir="$DSH_HOME/profiles/$PROFILE_NAME"
    local src="$REPO_DIR/packages/plugins/dsh-balbes-memory-context"
    local dst="$profile_dir/node_modules/dsh-balbes-memory-context"
    if [[ ! -d "$src/lib" ]]; then
        die "memory context plugin not built at $src/lib — build step failed"
    fi
    mkdir -p "$profile_dir/node_modules"
    rm -rf "$dst"
    cp -R "$src" "$dst"
    rm -f "$dst/tsconfig.json" "$dst/tsconfig.build.json"
    rm -rf "$dst/tests" "$dst/src" "$dst/lib/types"
    chmod -R u+rwX,go-w "$dst"
    info "Memory context plugin copied into $dst"
}
```

В `main()` после `copy_memory_into_profile` добавь `copy_memory_context_into_profile`. Обнови шапку-комментарий: в список собираемых пакетов и в список копируемых плагинов добавь `dsh-balbes-memory-context`. В `build_workspace` обнови текст `info` (список пакетов).

- [ ] **Step 3: Проверить синтаксис установщика**

Run: `bash -n scripts/install.sh`
Expected: без вывода, exit 0.

- [ ] **Step 4: Добавить smoke в `docs/runbooks/stage2-vps.md`**

В раздел обновления добавь абзац: обновление — повторный `install.sh`; миграций БД нет; доставка памяти включается строкой `balbes-memory-context`. В smoke добавь:

```bash
# плагин доставки загрузился; после первого промпта — counts-строка
journalctl -u dsh-balbes -n 200 | grep balbes-memory-context
# ожидается: строка вида "balbes-memory-context: scope=global core=... map=... push=...";
# "missing" и "prepare failed" означают деградацию — см. «Устранение неполадок».

# память доезжает до модели
TOKEN=... # из POST /api/auth/login
curl -fsS -X POST http://127.0.0.1:8080/api/memory/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":{"kind":"global"},"type":"fact","text":"smoke-marker: код запуска Балбеса — dsh-balbes","pinned":true}'
curl -fsS -X POST http://127.0.0.1:8080/api/prompt \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"Повтори дословно код запуска Балбеса"}'
# ожидается: ответ содержит smoke-marker и «dsh-balbes»
```

В «Устранение неполадок» добавь: если в журнале `balbes-memory-context: ... missing`, проверить композицию (`dsh --profile balbes --dump-config`) и наличие `balbes-memory`; `prepare failed` — проверить `$DSH_HOME/storages/memory.sqlite` и права.

- [ ] **Step 5: Commit**

```bash
git add profiles/balbes/cordis.patch.yml scripts/install.sh docs/runbooks/stage2-vps.md
git commit -m "feat(profile): compose memory delivery and document its smoke"
```

---

### Task 10: REAL-композиция

**Files:**
- Create: `packages/plugins/dsh-balbes-memory-context/tests/fixtures/balbes-memory-context-profile/cordis.patch.yml`
- Create: `packages/plugins/dsh-balbes-memory-context/tests/fixtures/balbes-memory-context-profile/package.json`
- Create: `packages/plugins/dsh-balbes-memory-context/tests/helpers/stub-llm.mjs` (скопировать байт-в-байт из `packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs`)
- Test: `packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts`

**Interfaces:**
- Consumes: host bundle, memory store, memory admin, plugin under test.
- Produces: доказательство, что pinned-запись попадает в `system`, push-запись — в тело запроса, `recall` — в `tools`, и что память перечитывается каждый ход.

- [ ] **Step 1: Создать fixture**

`tests/fixtures/balbes-memory-context-profile/cordis.patch.yml`:

```yaml
# Test composition for the memory-context plugin: dsh-base + the balbes host
# bundle + the memory store + the memory admin routes + the plugin under test.
- insert:
    - id: balbes-memory
      name: 'dsh-balbes-memory'

    - id: balbes-memory-context
      name: 'dsh-balbes-memory-context'

    - id: balbes-memory-admin
      name: 'dsh-balbes-memory-admin'
```

`tests/fixtures/balbes-memory-context-profile/package.json`:

```json
{
  "name": "dsh-profile-balbes-memory-context-test",
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

Run: `mkdir -p packages/plugins/dsh-balbes-memory-context/tests/helpers packages/plugins/dsh-balbes-memory-context/tests/fixtures/balbes-memory-context-profile`
Run: `cp packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs packages/plugins/dsh-balbes-memory-context/tests/helpers/stub-llm.mjs`

- [ ] **Step 2: Написать падающий тест `tests/integration.test.ts`**

```ts
import { afterAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const memoryPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory");
const memoryAdminPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory-admin");
const contractsPkgRoot = join(pkgRoot, "..", "..", "contracts");
const fixtureProfile = join(here, "fixtures", "balbes-memory-context-profile");
const PROFILE = "balbes-memory-context-test";

async function hasDsh(): Promise<boolean> {
  try {
    await execFileP("dsh", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function buildPackages(): Promise<void> {
  const configs: Array<[string, string]> = [
    [contractsPkgRoot, "tsconfig.build.json"],
    [memoryPkgRoot, "tsconfig.build.json"],
    [memoryAdminPkgRoot, "tsconfig.build.json"],
    [pkgRoot, "tsconfig.build.json"],
    [hostPkgRoot, "tsconfig.json"]
  ];
  for (const [root, cfg] of configs) {
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    await execFileP(process.execPath, [tsc, "-p", join(root, cfg)], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024
    });
  }
}

async function postJson(url: string, body: unknown, token?: string): Promise<{ status: number; json: unknown; raw: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = "Bearer " + token;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* not json */
  }
  return { status: response.status, json, raw };
}

async function waitForHealth(port: number, child: ReturnType<typeof spawn>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("dsh exited early (code " + child.exitCode + ")");
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/api/health", { method: "POST" });
      const json = (await response.json()) as { ok?: boolean };
      if (response.status === 200 && json.ok === true) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server did not become healthy within " + timeoutMs + "ms");
}

const realEnabled = (process.env.RUN_REAL ?? "").trim() !== "" ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (memory delivery)", () => {
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;

  async function prepareHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "balbes-memory-context-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, PROFILE), { recursive: true });
    const nm = join(profiles, PROFILE, "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    const plugins: Array<[string, string]> = [
      [memoryPkgRoot, "dsh-balbes-memory"],
      [memoryAdminPkgRoot, "dsh-balbes-memory-admin"],
      [pkgRoot, "dsh-balbes-memory-context"]
    ];
    for (const [root, dirName] of plugins) {
      await cp(join(root, "lib"), join(nm, dirName, "lib"), { recursive: true });
      await cp(join(root, "package.json"), join(nm, dirName, "package.json"));
    }
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(home, creds);
    return home;
  }

  async function bootServer(home: string): Promise<string> {
    child = spawn("dsh", ["--profile", PROFILE], {
      env: { ...process.env, DSH_HOME: home, BALBES_PORT: String(port), DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "test-key" },
      cwd: home,
      stdio: "ignore"
    });
    await waitForHealth(port, child);
    const loginRes = await postJson("http://127.0.0.1:" + port + "/api/auth/login", { login, password });
    expect(loginRes.status, loginRes.raw).toBe(200);
    return (loginRes.json as { token: string }).token;
  }

  async function stopServer(): Promise<void> {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child?.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      ]);
    }
    child = null;
  }

  afterAll(async () => {
    await stopServer();
  }, 60_000);

  it("delivers the pinned core, the task-relevant push and the recall tool", async () => {
    const stubUrl = new URL("./helpers/stub-llm.mjs", import.meta.url).href;
    const { startStubLlm } = (await import(stubUrl)) as {
      startStubLlm(options?: { text?: string }): Promise<{
        port: number;
        calls: Array<{ path: string; body: { system?: unknown; tools?: unknown; messages?: unknown } }>;
        close(): Promise<void>;
      }>;
    };
    await buildPackages();
    port = await freePort();
    const coreMarker = "p10c-core-marker-4b8e";
    const pushMarker = "p10c-push-marker-9d17";
    const livenessMarker = "p10c-liveness-marker-5c02";
    const stub = await startStubLlm({ text: "ok from stub" });
    const home = await prepareHome();
    try {
      await writeFile(
        join(home, "settings.yaml"),
        "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nllm-deepseek:\n  baseURL: http://127.0.0.1:" + stub.port + "\n"
      );
      const base = "http://127.0.0.1:" + port;
      const token = await bootServer(home);

      const coreSave = await postJson(
        base + "/api/memory/save",
        { scope: { kind: "global" }, type: "fact", text: "Pinned core " + coreMarker + " always visible", pinned: true, tags: ["p10c"] },
        token
      );
      expect(coreSave.status, coreSave.raw).toBe(200);
      const pushSave = await postJson(
        base + "/api/memory/save",
        { scope: { kind: "global" }, type: "decision", text: "deploy " + pushMarker + " rollback procedure", pinned: false },
        token
      );
      expect(pushSave.status, pushSave.raw).toBe(200);

      const before = stub.calls.length;
      const first = await postJson(base + "/api/prompt", { prompt: "deploy checks" }, token);
      expect(first.status, first.raw).toBe(200);
      const calls = stub.calls.slice(before);
      expect(calls.length).toBeGreaterThan(0);
      const systems = calls.map((call) => (typeof call.body.system === "string" ? call.body.system : "")).join("\n");
      expect(systems, systems.slice(0, 4000)).toContain(coreMarker);
      const serialized = JSON.stringify(calls.map((call) => call.body));
      expect(serialized, serialized.slice(0, 4000)).toContain(pushMarker);
      expect(JSON.stringify(calls.map((call) => call.body.tools))).toContain("recall");

      const livenessSave = await postJson(
        base + "/api/memory/save",
        { scope: { kind: "global" }, type: "fact", text: "Pinned later " + livenessMarker, pinned: true },
        token
      );
      expect(livenessSave.status, livenessSave.raw).toBe(200);
      const boundary = stub.calls.length;
      const second = await postJson(base + "/api/prompt", { prompt: "anything else" }, token);
      expect(second.status, second.raw).toBe(200);
      const secondSystems = stub.calls
        .slice(boundary)
        .map((call) => (typeof call.body.system === "string" ? call.body.system : ""))
        .join("\n");
      expect(secondSystems, secondSystems.slice(0, 4000)).toContain(livenessMarker);
    } finally {
      await stopServer();
      await rm(home, { recursive: true, force: true });
      await stub.close();
    }
  }, 300_000);
});
```

- [ ] **Step 3: Запустить REAL-набор**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-memory-context test -- integration.test.ts`
Expected на Linux-VPS с `dsh` в PATH: PASS; на dev-хосте гейт пропускает набор (`skipped`). Если падает push-ассерт — проверить, что push-запись не совпала с core и что `buildFtsQuery("deploy checks")` даёт `\"deploy\" OR \"checks\"`.

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context/tests
git commit -m "test(memory-context): REAL composition proves delivery to the model"
```

---

### Task 11: Финальная верификация, canon-audit и handoff

**Files:**
- Modify (через skill `canon-audit`): `docs/canon/DISCREPANCIES.md` (только если divergence найдено)
- Modify (через `canon-future-plan`): `docs/canon/future_plans/p10c-memory-context.md`, `docs/canon/future_plans/INDEX.md`

**Interfaces:**
- Consumes: все предыдущие задачи.
- Produces: зелёные typecheck/тесты, закрытая инициатива p10c в каноне, инструкции серверной проверки.

- [ ] **Step 1: Полный typecheck**

Run: `pnpm typecheck`
Expected: без ошибок во всех пакетах.

- [ ] **Step 2: Полные тесты (без REAL)**

Run: `pnpm test`
Expected: зелёные unit/интеграционные наборы; REAL-наборы помечены skipped.

- [ ] **Step 3: Закрыть инициативу каноном**

Загрузи skill `canon-audit` для темы «доставка памяти в контекст»; при расхождениях зафиксируй их в `DISCREPANCIES.md`. Затем через `canon-future-plan` поставь `docs/canon/future_plans/p10c-memory-context.md` `Status: absorbed` и синхронизируй `INDEX.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/canon
git commit -m "docs(canon): absorb the p10c memory delivery initiative"
```

- [ ] **Step 5: Handoff — серверная проверка**

Сообщи владельцу инструкции по runbook `docs/runbooks/stage2-vps.md`: на сервере выполнить повторный `scripts/install.sh`; проверить `journalctl -u dsh-balbes | grep balbes-memory-context` и smoke `/api/memory/save` + `/api/prompt` (см. Task 9). Не пушить без go-ahead владельца.

---

## Self-Review

**Spec coverage:**
- Режим гибрид: ядро/карта — Tasks 4–5; push — Tasks 4–5; `recall` — Task 6.
- Бюджеты и форматы — Task 4 (константы и тесты).
- Безопасный FTS — Task 3.
- Точка доставки/проводка — Tasks 7–8.
- Изоляция scope — Task 5 (`scopesFor`) и Task 6 (filter в `search`).
- Деградация/ошибки — Task 5 (no-op, prepare total).
- Наблюдаемость (info-строка) — Task 5.
- Канон — Task 1 и Task 11.
- Композиция/установщик/runbook — Task 9.
- REAL-композиция — Task 10.
- Границы (нет write, нет HTTP/UI) — соблюдены: в Tasks 2–8 нет `save/update/delete` и новых ручек.

**Type consistency:**
- `BalbesMemoryContextService.attach` → `MemoryContextAttachment.prepare` — совпадает в `types.ts` (Task 2), `context.ts` (Task 5), `runner.ts` (Task 7, структурный срез) и `agentTask.ts` (Task 8, `MemoryContextServiceLike`).
- `createMemoryContext(logger)` вызывается из `index.ts` (Task 2) с `ctx.logger`.
- `renderCore/renderMap/renderPush` возвращают `RenderedBlock {text, shown}` и используются в `context.ts` (Task 5).
- `buildFtsQuery` используется в `context.ts` и `recall.ts`.
- Имена/порядки (`balbes:memory`/120, `balbes:memory-push`/200) совпадают в Task 1 (канон) и Task 5.

**Placeholder scan:** в коде шагов нет TBD/TODO; каждый шаг с кодом содержит полный модуль или точную замену. Инструкции `cp` и `pnpm install` даны дословно.
