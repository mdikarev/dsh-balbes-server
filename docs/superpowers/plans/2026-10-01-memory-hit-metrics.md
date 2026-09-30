# Метрики попаданий и пользы памяти (p10h) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** слой доставки памяти агрегирует в процессе, какие записи и сколькими путями попадают в контекст, как часто вызывается `recall` и где он пуст, какие записи доставлены, но ни разу не запрошены; агрегаты отдаются bearer-ручкой `POST /api/memory/metrics` и снимком в журнал, без текста памяти.

**Architecture:** чистый агрегатор `metrics.ts` в пакете доставки `dsh-balbes-memory-context` (события → иммутабельный снимок, без I/O); `context.ts` пишет событие доставки из `prepare` и событие `recall` из инструмента; `index.ts` собирает сервис `balbesMemoryMetrics`, держит `unref`-интервал снимка и пишет финальный снимок на сброс; `dsh-balbes-memory-admin` добавляет ручку, читая сервис лениво через структурный срез.

**Tech Stack:** TypeScript (strict, ESM), Cordis-плагины dsh, `@deepseek-ai/dsh-tools` (`defineTool`, `tools.register`), `@deepseek-ai/schemastery` (`Config`), vitest, pnpm workspaces; новых зависимостей нет.

**Spec:** `docs/superpowers/specs/2026-10-01-memory-hit-metrics-design.md`
**Canon (обновляется Task 1 до кода, код обязан совпасть):** `docs/canon/ARCHITECTURE.md` → «Доставка памяти в контекст (p10c)» + новый подраздел «Метрики попаданий и пользы (p10h)»; `docs/canon/API_CONTRACTS.md` → `memory.metrics`; `docs/canon/GLOSSARY.md` → «попадание памяти», «польза памяти», «промах памяти», «снимок метрик памяти»; `docs/canon/ADMIN_UI.md` → фиксация «метрик в UI нет»; `docs/canon/OVERVIEW.md` → сигналы успеха; `docs/canon/future_plans/p10h-memory-hit-metrics.md`, `p10i-memory-metrics-ui.md`, `future_plans/INDEX.md`.

## Global Constraints

- Никаких новых пакетов, зависимостей и строк в `profiles/balbes/cordis.patch.yml`: агрегатор живёт в `dsh-balbes-memory-context`, ручка — в `dsh-balbes-memory-admin`.
- `MemoryRecord`, схема SQLite, `dsh-balbes-contracts` и миграции не меняются. Персистентности нет: агрегаты только в процессе (персистентность — p12).
- Алгоритм доставки не меняется: `renderCore`/`renderMap`/`renderPush`, бюджеты `4096/4096/2048`, `PUSH_SEARCH_LIMIT = 5`, FTS-запрос — как в p10c.
- Приватность: в метрики, снимок и лог попадают только id записи, её тип, тег scope, канал, время, счётчики, размеры блоков в символах и латентность. Текст записи, `originRef`, теги памяти, промпт, ответ модели и аргумент `recall` не логируются и не возвращаются. Тест-инвариант — в Task 4.
- Два сигнала промаха, без вердикта «не помогла»: `recall.empty` (пустой `recall`) и `unqueriedDelivered` (доставлена в контекст и ни разу не запрошена за окно). `recall.failed` — деградация хранилища, не промах.
- Одна запись может попасть в ход несколькими путями: `inCore`/`inMap`/`inPush` считаются независимо, `deliveries` — сумма вхождений.
- Потолок уникальных id в окне `MAX_TRACKED_RECORDS = 512`; сверх потолка новые id не отслеживаются, `dropped` растёт, счётчики отслеживаемых продолжают расти. Окно закрывается заменой структуры, не удалением ключей.
- `recordDelivery`/`recordRecall` тотальны: не бросают, не влияют на ход агента; ошибка агрегатора ловится вызывающим, пишется `warn` без текста памяти.
- Интервал снимка: `Config.intervalMs` → `BALBES_MEMORY_METRICS_INTERVAL_MS` → дефолт `900_000`; неположительное/нечисловое значение = интервал выключен. Таймер только `unref()`, плюс финальный снимок на сброс.
- Существующая `logger.info`-строка `prepare` понижается до `logger.debug`; снимок окна пишется `logger.info`.
- Тесты: unit — под `tests/` (vitest); REAL — за гейтом `RUN_REAL=1` **и** `dsh` в `PATH`; mock только LLM-провайдер, сеть, часы. Каждая задача заканчивается зелёными тестами и коммитом.
- Фокусированный прогон: `pnpm --filter <пакет> exec vitest run <фильтр>` — под pnpm 10 форма `pnpm --filter <пакет> test -- <фильтр>` передаёт `--` в vitest и запускает весь набор целиком.
- `docs/runbooks/stage2-vps.md` обновляется в том же коммите, что и функциональное изменение (Task 7).
- Canon-first: Task 1 (`canon-write` + `canon-future-plan`) идёт **до** кода, и после него — пауза на явный go-ahead владельца перед Task 2.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `docs/canon/ARCHITECTURE.md`, `API_CONTRACTS.md`, `GLOSSARY.md`, `ADMIN_UI.md`, `OVERVIEW.md` (modify, через `canon-write`) | Канон p10h: контракт снимка, ручка, термины, граница с p12 |
| `docs/canon/future_plans/p10h-memory-hit-metrics.md` (modify), `p10i-memory-metrics-ui.md` (create), `future_plans/INDEX.md` (modify), через `canon-future-plan` | Статус p10h, новая инициатива UI метрик |
| `packages/plugins/dsh-balbes-memory-context/src/metrics.ts` (create) | Чистый агрегатор: события доставки/`recall`, окно, потолок id, снимок, `startMemoryMetrics` с интервалом и сбросом |
| `packages/plugins/dsh-balbes-memory-context/src/types.ts` (modify) | `MemoryMetricsSnapshot`, `MemoryMetricsSink`, `MemoryMetricsService`, `MemoryDeliveryEvent`, `MemoryRecallEvent` |
| `packages/plugins/dsh-balbes-memory-context/src/context.ts` (modify) | Съём доставки в `prepare`, тег scope и канал в `attach`, `sink` в `recall`, `info` → `debug` |
| `packages/plugins/dsh-balbes-memory-context/src/recall.ts` (modify) | Замер латентности и `outcome` (`ok`/`empty`/`failed`) для события `recall` |
| `packages/plugins/dsh-balbes-memory-context/src/index.ts` (modify) | `Config.intervalMs`, сборка метрик, `provide("balbesMemoryMetrics")`, сброс на dispose |
| `packages/plugins/dsh-balbes-memory-context/tests/metrics.test.ts` (create) | Юниты агрегатора: инкременты, окно, потолок, `unqueriedDelivered`, топ, приватность |
| `packages/plugins/dsh-balbes-memory-context/tests/context.test.ts` (modify) | Юниты съёма: событие доставки, отсутствие события при сбое, снимок |
| `packages/plugins/dsh-balbes-memory-context/tests/recall.test.ts` (modify) | Юниты `ok`/`empty`/`failed` и латентности |
| `packages/plugins/dsh-balbes-memory-context/tests/index.test.ts` (modify) | `apply` предоставляет оба сервиса, сброс закрывает окно, снимок в лог |
| `packages/plugins/dsh-balbes-memory-admin/src/routes.ts` (modify) | `MetricsLike`, `parseMetrics`, ручка `POST /api/memory/metrics` |
| `packages/plugins/dsh-balbes-memory-admin/src/index.ts` (modify) | Ленивый `ctx.get("balbesMemoryMetrics")` на запрос |
| `packages/plugins/dsh-balbes-memory-admin/tests/index.test.ts` (modify) | Юниты ручки: срез, парсинг, `reset`, 400/503 |
| `packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts` (modify) | REAL-сценарий метрик + инвариант приватности |
| `docs/runbooks/stage2-vps.md` (modify) | Smoke метрик на сервере |

---

### Task 1: канон p10h и инициатива p10i

**Files:**
- Modify (через `canon-write`): `docs/canon/ARCHITECTURE.md`, `docs/canon/API_CONTRACTS.md`, `docs/canon/GLOSSARY.md`, `docs/canon/ADMIN_UI.md`, `docs/canon/OVERVIEW.md`
- Modify (через `canon-future-plan`): `docs/canon/future_plans/p10h-memory-hit-metrics.md`, `docs/canon/future_plans/INDEX.md`
- Create (через `canon-future-plan`): `docs/canon/future_plans/p10i-memory-metrics-ui.md`

**Interfaces:**
- Consumes: спеку `docs/superpowers/specs/2026-10-01-memory-hit-metrics-design.md` (таблица решений, раздел «Поверхность», `MemoryMetricsSnapshot`).
- Produces (для Tasks 2–7): зафиксированные каноном имена и значения — сервис `balbesMemoryMetrics`, ручка `memory.metrics` (`POST /api/memory/metrics`, bearer, `{reset?, top?}` → `{metrics: MemoryMetricsSnapshot}`), термины «попадание памяти», «польза памяти», «промах памяти», «снимок метрик памяти», потолок `512`, интервал `15 минут`, граница «персистентность — p12».

- [ ] **Step 1: Обновить канон через скилл `canon-write`**

Вызвать скилл `canon-write` (не редактировать `docs/canon/**` вручную) с задачей: внести в живой канон наблюдаемость доставки памяти по спеке. Требуемые правки:

1. `ARCHITECTURE.md`, раздел доставки памяти (сейчас заканчивается пунктом «Границы: автоизвлечение (p10g), метрики пользы (p10h), дедуп, TTL и конфликты (p10d)…») — снять «метрики пользы (p10h)» из границ и добавить подраздел:

```markdown
### Метрики попаданий и пользы (p10h)

- Агрегатор живёт в пакете доставки `dsh-balbes-memory-context` (`metrics.ts`):
  чистый in-memory слой без I/O, которому `prepare` отдаёт событие доставки (id
  ядра/карты/push, число опущенных бюджетом записей, размеры блоков), а
  инструмент `recall` — событие запроса (исход `ok`/`empty`/`failed`,
  латентность, выданные id). Сервис `balbesMemoryMetrics` предоставляется
  плагином рядом с `balbesMemoryContext`.
- Состав снимка: объёмные счётчики по ходам, каналам (`admin`/`telegram`) и
  тегам scope (`global`/`project:<name>`); per-record попадания за окно
  (`inCore`/`inMap`/`inPush`/`recallDelivered`/`recallQueries`); `recall`
  (calls/empty/failed/латентность); `unqueriedDelivered` и `dropped`.
- Промах наблюдаем двумя честными сигналами: пустой `recall` (пробел в памяти) и
  запись, доставленная в контекст и ни разу не запрошенная за окно (балласт).
  Вердикта «запись не помогла» слой не выносит, текст ответа модели не читает:
  польза выводится владельцем и p10d (затухание по попаданиям) из этих сигналов.
- Окно in-memory: накопительные тоталы за процесс не сбрасываются; уникальных id
  в окне не больше 512, сверх потолка растёт `dropped`; окно закрывается заменой
  структуры. Снимок пишется `logger.info` по интервалу (дефолт 15 минут) и на
  сброс сервиса; `prepare` логирует счётчики уровнем `debug`.
- Приватность: id, тип, scope, канал, время и счётчики — и ничего больше. Текст
  памяти, `originRef`, теги, промпт и ответ модели в метрики не попадают.
- Граница с p12: p10h владеет только агрегатами памяти в процессе и их снимком;
  персистентность, расширение health, метрики задач, ротация логов и алертинг —
  p12. UI метрик — отдельная инициатива p10i.
```

2. `API_CONTRACTS.md` — новая ручка в стиле соседних `memory.*`:

```markdown
### memory.metrics — метрики доставки памяти
- method: POST
- path: /api/memory/metrics
- auth: bearer
- request: `{reset?: boolean, top?: integer}` (`top` — размер `topRecords`,
  дефолт 20, максимум 100; `reset: true` закрывает окно и возвращает снимок
  закрытого окна, накопительные тоталы процесса сохраняются)
- response: `{metrics: MemoryMetricsSnapshot}` — `schema`, `process`
  (`startedAt`, `totals`), `window` (`startedAt`, `durationMs`, `turns`,
  `deliveries`), `byChannel`, `byScope`, `recall` (`calls`, `empty`, `failed`,
  `latencyMs`), `unqueriedDelivered`, `dropped`, `topRecords`
  (`id`, `type`, `scope`, `inCore`, `inMap`, `inPush`, `recallDelivered`,
  `recallQueries`)
- errors: 400 `bad-request` (не булев `reset`, `top` не число/вне 1..100),
  401, 503 `metrics-unavailable` (сервис не собран)
- notes: read-only, в хранилище ничего не пишет. Текста памяти в ответе нет ни в
  одном поле — только id, тип, scope и счётчики; `originRef` не возвращается.
  Метрики живут в процессе и теряются при рестарте (персистентность — p12).
  `reset` существует для детерминированного smoke без рестарта сервиса.
```

3. `GLOSSARY.md` — четыре термина (в стиле соседних):

```markdown
### Попадание памяти (memory hit)
Факт того, что запись памяти попала в контекст задачи — в ядро, карту или push —
или была выдана инструментом `recall`. Источник сигнала для метрик p10h и
будущего затухания p10d.

### Польза памяти (memory usefulness)
Связь попадания с результатом задачи. Слой памяти не выносит вердикт сам:
польза выводится из сигналов p10h (частота попаданий, запросы `recall`, пустые
промахи) владельцем или политикой p10d, а не из текста ответа модели.

### Промах памяти (memory miss)
Наблюдаемый признак того, что память не помогла: пустой результат `recall`
(пробел в памяти) либо запись, доставленная в контекст и ни разу не запрошенная
за окно наблюдения (балласт). Ошибка хранилища — деградация, а не промах.

### Снимок метрик памяти (memory metrics snapshot)
Иммутабельная сводка агрегатов p10h за окно: счётчики по ходам, каналам и
уровням, попадания по записям, статистика `recall`, число невостребованных
доставок. Отдаётся ручкой `memory.metrics` и строкой журнала; текста памяти не
содержит.
```

4. `ADMIN_UI.md` — в разделе управления памятью явно зафиксировать:

```markdown
- Метрики попаданий и пользы памяти (p10h) в интерфейсе не отображаются: они
  доступны ручкой `memory.metrics` и строкой журнала. Экран метрик — отдельная
  инициатива p10i; страница «Память» этой итерацией не меняется.
```

5. `OVERVIEW.md` — в сигналах успеха памяти добавить: попадания и промахи
   доставки наблюдаемы (ручка `memory.metrics` + строка журнала), решения о
   затухании и UI опираются на этот сигнал (p10d, p10i).

- [ ] **Step 2: Обновить инициативы через скилл `canon-future-plan`**

Вызвать скилл `canon-future-plan`:

1. `future_plans/p10h-memory-hit-metrics.md` — статус `draft` → `absorbed`
   (инициатива поглощена каноном и реализована), добавить строку
   `- Design: docs/superpowers/specs/2026-10-01-memory-hit-metrics-design.md` и
   `- Plan: docs/superpowers/plans/2026-10-01-memory-hit-metrics.md`, закрыть
   открытые вопросы решениями из спеки (см. таблицу «Решения и границы»):
   польза — из наблюдаемых сигналов, а не разметки; промах — два сигнала;
   носитель — in-memory, персистентность p12; видимость — ручка + лог, UI — p10i;
   читатель сигнала — владелец, p10d и p12.
2. Создать `future_plans/p10i-memory-metrics-ui.md` в шаблоне соседних
   инициатив: заголовок «UI метрик памяти», `Status: draft`,
   `Depends: p10h`, `Focus: где владелец видит попадания и промахи памяти`;
   Intent — экран метрик поверх ручки `memory.metrics`; In scope — вкладка или
   блок на странице «Память» (сводка окна, топ записей, промахи),
   `ADMIN_UI.md`; Out of scope — сбор метрик (p10h), персистентность и
   наблюдаемость сервера (p12), алертинг; Open questions — вкладка против
   отдельного пункта сайдбара, состав сводки, период окна, обновление по кнопке
   против push.
3. `future_plans/INDEX.md` — статус строки 10h и добавить строку 10i в таблицу и
   в связанные заметки.

- [ ] **Step 3: Проверить канон**

Run: `doc-canon validate`
Expected: PASS, без ошибок схемы и структуры.

- [ ] **Step 4: Пауза на go-ahead**

Показать владельцу диф канона и дождаться явного «да» перед Task 2 (canon-first:
после существенных правок канона код не начинается без go-ahead). Вопрос,
который нужно задать: «Канон обновлён и провалидирован — начинать код?»

- [ ] **Step 5: Commit**

```bash
git add docs/canon
git commit -m "docs(canon): describe memory hit metrics (p10h) and the metrics UI initiative (p10i)"
```

---

### Task 2: агрегатор метрик

**Files:**
- Create: `packages/plugins/dsh-balbes-memory-context/src/metrics.ts`
- Modify: `packages/plugins/dsh-balbes-memory-context/src/types.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/metrics.test.ts`

**Interfaces:**
- Consumes: `MemoryRecord["type"]` из `dsh-balbes-contracts` (только как строка в `RecordRefLike`).
- Produces (для Tasks 3–6):
  - `DEFAULT_METRICS_INTERVAL_MS = 900_000`, `MAX_TRACKED_RECORDS = 512`, `DEFAULT_TOP_RECORDS = 20`, `MAX_TOP_RECORDS = 100`, `METRICS_SCHEMA = 1`
  - `type MemoryMetricsScopeTag = string`
  - `interface MemoryRecordRef { type: string; scope: MemoryMetricsScopeTag }`
  - `interface MemoryDeliveryEvent { channel: string; scope: MemoryMetricsScopeTag; core: {delivered: string[]; omitted: number; chars: number}; map: {…}; push: {…}; records?: Record<string, MemoryRecordRef> }`
  - `interface MemoryRecallEvent { channel: string; scope: MemoryMetricsScopeTag; outcome: "ok" | "empty" | "failed"; latencyMs: number; delivered?: string[]; records?: Record<string, MemoryRecordRef> }`
  - `interface MemoryMetricsSink { recordDelivery(event: MemoryDeliveryEvent): void; recordRecall(event: MemoryRecallEvent): void }`
  - `interface MemoryMetricsSnapshot` (типы в `types.ts`, перечислены в Task 2 Step 3)
  - `interface MemoryMetricsService extends MemoryMetricsSink { snapshot(options?: { reset?: boolean; top?: number }): MemoryMetricsSnapshot; dispose(): void }`
  - `interface MemoryMetricsLogger { info?(message: string): void; warn(message: string): void }`
  - `interface MemoryMetricsOptions { intervalMs?: number; now?: () => number; logger?: MemoryMetricsLogger; windowKey?: string }`
  - `createMemoryMetricsLedger(options?: { now?: () => number }): MemoryMetricsService`
  - `startMemoryMetrics(options?: MemoryMetricsOptions): MemoryMetricsService`

- [ ] **Step 1: Написать падающие тесты агрегатора**

Создать `packages/plugins/dsh-balbes-memory-context/tests/metrics.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryMetricsLedger,
  MAX_TRACKED_RECORDS,
  startMemoryMetrics
} from "../src/metrics.js";

describe("createMemoryMetricsLedger", () => {
  it("counts one record delivered by two paths in both paths", () => {
    const ledger = createMemoryMetricsLedger();
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["a"], omitted: 0, chars: 10 },
      map: { delivered: ["a"], omitted: 2, chars: 20 },
      push: { delivered: [], omitted: 0, chars: 0 },
      records: { a: { type: "fact", scope: "global" } }
    });
    const snap = ledger.snapshot();
    expect(snap.window.turns).toBe(1);
    expect(snap.window.deliveries).toBe(2);
    expect(snap.byChannel.admin).toEqual({ turns: 1, deliveries: 2 });
    expect(snap.byScope.global).toEqual({ turns: 1, deliveries: 2 });
    expect(snap.topRecords).toEqual([
      {
        id: "a",
        type: "fact",
        scope: "global",
        inCore: 1,
        inMap: 1,
        inPush: 0,
        recallDelivered: 0,
        recallQueries: 0
      }
    ]);
    expect(snap.unqueriedDelivered).toBe(1);
  });

  it("counts recall queries per call and separates empty from failed", () => {
    const ledger = createMemoryMetricsLedger();
    const base = { channel: "telegram", scope: "project:proj" };
    ledger.recordRecall({ ...base, outcome: "ok", latencyMs: 4, delivered: ["a", "b"] });
    ledger.recordRecall({ ...base, outcome: "ok", latencyMs: 6, delivered: ["a"] });
    ledger.recordRecall({ ...base, outcome: "empty", latencyMs: 2 });
    ledger.recordRecall({ ...base, outcome: "failed", latencyMs: 8 });
    const snap = ledger.snapshot();
    expect(snap.recall).toEqual({ calls: 4, empty: 1, failed: 1, latencyMs: { total: 20, max: 8 } });
    const a = snap.topRecords.find((record) => record.id === "a");
    expect(a?.recallQueries).toBe(2);
    expect(a?.recallDelivered).toBe(2);
  });

  it("keeps a record out of unqueriedDelivered once recall returned it", () => {
    const ledger = createMemoryMetricsLedger();
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["a"], omitted: 0, chars: 1 },
      map: { delivered: [], omitted: 0, chars: 0 },
      push: { delivered: [], omitted: 0, chars: 0 },
      records: { a: { type: "note", scope: "global" } }
    });
    ledger.recordRecall({ channel: "admin", scope: "global", outcome: "ok", latencyMs: 1, delivered: ["a"] });
    expect(ledger.snapshot().unqueriedDelivered).toBe(0);
  });

  it("closes the window on reset while keeping the process totals", () => {
    const ledger = createMemoryMetricsLedger({ now: () => 1_000 });
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["a"], omitted: 0, chars: 1 },
      map: { delivered: [], omitted: 0, chars: 0 },
      push: { delivered: [], omitted: 0, chars: 0 }
    });
    const first = ledger.snapshot({ reset: true });
    expect(first.window.turns).toBe(1);
    expect(first.process.totals.turns).toBe(1);
    const second = ledger.snapshot();
    expect(second.window.turns).toBe(0);
    expect(second.window.deliveries).toBe(0);
    expect(second.topRecords).toEqual([]);
    expect(second.process.totals.turns).toBe(1);
  });

  it("stops tracking new ids beyond the cap and reports dropped", () => {
    const ledger = createMemoryMetricsLedger();
    const ids = Array.from({ length: MAX_TRACKED_RECORDS + 3 }, (_value, index) => "id" + index);
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ids, omitted: 0, chars: 1 },
      map: { delivered: [], omitted: 0, chars: 0 },
      push: { delivered: [], omitted: 0, chars: 0 }
    });
    ledger.recordRecall({ channel: "admin", scope: "global", outcome: "ok", latencyMs: 1, delivered: ids });
    const snap = ledger.snapshot({ top: 1000 });
    expect(snap.dropped).toBe(3);
    expect(snap.topRecords).toHaveLength(MAX_TRACKED_RECORDS);
    expect(snap.window.deliveries).toBe(MAX_TRACKED_RECORDS + 3);
  });

  it("sorts the top by hits and caps it by top", () => {
    const ledger = createMemoryMetricsLedger();
    for (let index = 0; index < 3; index++) {
      ledger.recordDelivery({
        channel: "admin",
        scope: "global",
        core: { delivered: ["hot"], omitted: 0, chars: 1 },
        map: { delivered: ["warm"], omitted: 0, chars: 1 },
        push: { delivered: [], omitted: 0, chars: 0 }
      });
    }
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["cold"], omitted: 0, chars: 1 },
      map: { delivered: [], omitted: 0, chars: 0 },
      push: { delivered: [], omitted: 0, chars: 0 }
    });
    const snap = ledger.snapshot({ top: 2 });
    expect(snap.topRecords.map((record) => record.id)).toEqual(["hot", "warm"]);
  });

  it("never carries memory text or originRef into the snapshot", () => {
    const ledger = createMemoryMetricsLedger();
    const marker = "metrics-secret-marker-7f31";
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["a"], omitted: 0, chars: marker.length },
      map: { delivered: [], omitted: 0, chars: 0 },
      push: { delivered: [], omitted: 0, chars: 0 },
      records: { a: { type: "fact", scope: "global" } }
    });
    const serialized = JSON.stringify(ledger.snapshot());
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("originRef");
  });
});

describe("startMemoryMetrics", () => {
  it("logs a window snapshot on reset with the given key", () => {
    vi.useFakeTimers();
    try {
      const infos: string[] = [];
      const service = startMemoryMetrics({
        intervalMs: 0,
        windowKey: "w1",
        logger: { info: (message) => infos.push(message), warn: () => {} }
      });
      service.recordDelivery({
        channel: "admin",
        scope: "global",
        core: { delivered: ["a"], omitted: 0, chars: 1 },
        map: { delivered: [], omitted: 0, chars: 0 },
        push: { delivered: [], omitted: 0, chars: 0 }
      });
      service.dispose();
      expect(infos.join("\n")).toContain("key=w1");
      expect(infos.join("\n")).toContain("turns=1");
      expect(infos.join("\n")).toContain("deliveries=1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes on the interval without holding the process", () => {
    vi.useFakeTimers();
    try {
      const infos: string[] = [];
      const service = startMemoryMetrics({
        intervalMs: 1_000,
        logger: { info: (message) => infos.push(message), warn: () => {} }
      });
      vi.advanceTimersByTime(1_000);
      expect(infos.length).toBe(1);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not log on dispose twice", () => {
    const infos: string[] = [];
    const service = startMemoryMetrics({
      intervalMs: 0,
      logger: { info: (message) => infos.push(message), warn: () => {} }
    });
    service.dispose();
    service.dispose();
    expect(infos).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Прогнать тест — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run metrics`
Expected: FAIL — `Failed to resolve import "../src/metrics.js"`.

- [ ] **Step 3: Добавить типы метрик в `src/types.ts`**

Добавить в конец `packages/plugins/dsh-balbes-memory-context/src/types.ts`:

```ts
/** Тег уровня записи в метриках: "global" или "project:<name>". */
export type MemoryMetricsScopeTag = string;

/** Минимум о записи для топ-выдачи метрик: текста памяти тут нет by design. */
export interface MemoryRecordRef {
  type: string;
  scope: MemoryMetricsScopeTag;
}

/** Событие доставки одного хода: id по путям, опущенные записи и размеры блоков. */
export interface MemoryDeliveryEvent {
  channel: string;
  scope: MemoryMetricsScopeTag;
  core: { delivered: string[]; omitted: number; chars: number };
  map: { delivered: string[]; omitted: number; chars: number };
  push: { delivered: string[]; omitted: number; chars: number };
  records?: Record<string, MemoryRecordRef>;
}

/** Событие одного вызова `recall`: исход, латентность и выданные записи. */
export interface MemoryRecallEvent {
  channel: string;
  scope: MemoryMetricsScopeTag;
  outcome: "ok" | "empty" | "failed";
  latencyMs: number;
  delivered?: string[];
  records?: Record<string, MemoryRecordRef>;
}

/** Куда доставка пишет сигнал; реализация решает, что с ним делать. */
export interface MemoryMetricsSink {
  recordDelivery(event: MemoryDeliveryEvent): void;
  recordRecall(event: MemoryRecallEvent): void;
}

export interface MemoryMetricsTotals {
  turns: number;
  deliveries: number;
}

export interface MemoryMetricsChannelTotals extends MemoryMetricsTotals {}

export interface MemoryMetricsRecordMetrics {
  id: string;
  type: string;
  scope: MemoryMetricsScopeTag;
  inCore: number;
  inMap: number;
  inPush: number;
  recallDelivered: number;
  recallQueries: number;
}

export interface MemoryMetricsSnapshot {
  schema: 1;
  process: { startedAt: string; totals: MemoryMetricsTotals };
  window: { startedAt: string; durationMs: number; turns: number; deliveries: number };
  byChannel: Record<string, MemoryMetricsChannelTotals>;
  byScope: Record<string, MemoryMetricsChannelTotals>;
  recall: { calls: number; empty: number; failed: number; latencyMs: { total: number; max: number } };
  unqueriedDelivered: number;
  dropped: number;
  topRecords: MemoryMetricsRecordMetrics[];
}

export interface MemoryMetricsLogger {
  info?(message: string): void;
  warn(message: string): void;
}

/** Сервис метрик: приём событий, снимок окна и освобождение таймера. */
export interface MemoryMetricsService extends MemoryMetricsSink {
  snapshot(options?: { reset?: boolean; top?: number }): MemoryMetricsSnapshot;
  dispose(): void;
}
```

- [ ] **Step 4: Написать минимальную реализацию `src/metrics.ts`**

Создать `packages/plugins/dsh-balbes-memory-context/src/metrics.ts`:

```ts
import type {
  MemoryDeliveryEvent,
  MemoryMetricsChannelTotals,
  MemoryMetricsLogger,
  MemoryMetricsRecordMetrics,
  MemoryMetricsService,
  MemoryMetricsSnapshot,
  MemoryMetricsTotals,
  MemoryRecallEvent,
  MemoryRecordRef
} from "./types.js";

export const METRICS_SCHEMA = 1;
export const DEFAULT_METRICS_INTERVAL_MS = 900_000;
export const MAX_TRACKED_RECORDS = 512;
export const DEFAULT_TOP_RECORDS = 20;
export const MAX_TOP_RECORDS = 100;
const LOG_TOP_RECORDS = 5;

interface WindowCounters extends MemoryMetricsTotals {
  startedAt: number;
}

interface WindowRecall {
  calls: number;
  empty: number;
  failed: number;
  latencyTotal: number;
  latencyMax: number;
}

interface TrackedRecord {
  ref: MemoryRecordRef;
  inCore: number;
  inMap: number;
  inPush: number;
  recallDelivered: number;
  recallQueries: number;
}

interface WindowState {
  window: WindowCounters;
  byChannel: Map<string, MemoryMetricsChannelTotals>;
  byScope: Map<string, MemoryMetricsChannelTotals>;
  records: Map<string, TrackedRecord>;
  recall: WindowRecall;
  dropped: number;
  /** id, выданные recall в этом окне: отличает попадание от балласта. */
  recalled: Set<string>;
}

function iso(timestamp: number): string {
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function freshWindow(now: number): WindowState {
  return {
    window: { startedAt: now, turns: 0, deliveries: 0 },
    byChannel: new Map(),
    byScope: new Map(),
    records: new Map(),
    recall: { calls: 0, empty: 0, failed: 0, latencyTotal: 0, latencyMax: 0 },
    dropped: 0,
    recalled: new Set()
  };
}

function bump(map: Map<string, MemoryMetricsChannelTotals>, key: string, deliveries: number): void {
  const current = map.get(key) ?? { turns: 0, deliveries: 0 };
  current.turns += 1;
  current.deliveries += deliveries;
  map.set(key, current);
}

function toRecord(map: Map<string, MemoryMetricsChannelTotals>): Record<string, MemoryMetricsChannelTotals> {
  const out: Record<string, MemoryMetricsChannelTotals> = {};
  for (const [key, value] of map) out[key] = { turns: value.turns, deliveries: value.deliveries };
  return out;
}

function clampCount(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

export function createMemoryMetricsLedger(options: { now?: () => number } = {}): MemoryMetricsService {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const processTotals: MemoryMetricsTotals = { turns: 0, deliveries: 0 };
  let state = freshWindow(startedAt);

  const track = (id: string, ref: MemoryRecordRef | undefined, blank: TrackedRecord): TrackedRecord => {
    const existing = state.records.get(id);
    if (existing !== undefined) {
      if (ref !== undefined && (existing.ref.type === "" || existing.ref.type === "unknown")) existing.ref = ref;
      return existing;
    }
    if (state.records.size >= MAX_TRACKED_RECORDS) {
      state.dropped += 1;
      return blank;
    }
    const seeded: TrackedRecord = ref === undefined ? blank : { ref, ...blank };
    state.records.set(id, seeded);
    return seeded;
  };

  const onDelivered = (id: string, path: "inCore" | "inMap" | "inPush", records: Record<string, MemoryRecordRef> | undefined): void => {
    const tracked = track(id, records?.[id], { ref: { type: "unknown", scope: "unknown" }, inCore: 0, inMap: 0, inPush: 0, recallDelivered: 0, recallQueries: 0 });
    tracked[path] += 1;
  };

  const recordDelivery = (event: MemoryDeliveryEvent): void => {
    const deliveries = event.core.delivered.length + event.map.delivered.length + event.push.delivered.length;
    state.window.turns += 1;
    state.window.deliveries += deliveries;
    processTotals.turns += 1;
    processTotals.deliveries += deliveries;
    bump(state.byChannel, event.channel, deliveries);
    bump(state.byScope, event.scope, deliveries);
    for (const id of event.core.delivered) onDelivered(id, "inCore", event.records);
    for (const id of event.map.delivered) onDelivered(id, "inMap", event.records);
    for (const id of event.push.delivered) onDelivered(id, "inPush", event.records);
  };

  const recordRecall = (event: MemoryRecallEvent): void => {
    state.recall.calls += 1;
    if (event.outcome === "empty") state.recall.empty += 1;
    if (event.outcome === "failed") state.recall.failed += 1;
    if (Number.isFinite(event.latencyMs) && event.latencyMs >= 0) {
      state.recall.latencyTotal += event.latencyMs;
      if (event.latencyMs > state.recall.latencyMax) state.recall.latencyMax = event.latencyMs;
    }
    for (const id of event.delivered ?? []) {
      const tracked = track(id, event.records?.[id], { ref: { type: "unknown", scope: "unknown" }, inCore: 0, inMap: 0, inPush: 0, recallDelivered: 0, recallQueries: 0 });
      tracked.recallDelivered += 1;
      tracked.recallQueries += 1;
      state.recalled.add(id);
    }
  };

  const snapshot = (options?: { reset?: boolean; top?: number }): MemoryMetricsSnapshot => {
    const closed = state;
    const top = clampCount(options?.top, DEFAULT_TOP_RECORDS, MAX_TOP_RECORDS);
    const topRecords = [...closed.records.entries()]
      .map(([id, tracked]) => ({
        id,
        type: tracked.ref.type,
        scope: tracked.ref.scope,
        inCore: tracked.inCore,
        inMap: tracked.inMap,
        inPush: tracked.inPush,
        recallDelivered: tracked.recallDelivered,
        recallQueries: tracked.recallQueries
      }))
      .sort((left, right) => {
        const leftHits = left.inCore + left.inMap + left.inPush;
        const rightHits = right.inCore + right.inMap + right.inPush;
        if (rightHits !== leftHits) return rightHits - leftHits;
        if (right.recallQueries !== left.recallQueries) return right.recallQueries - left.recallQueries;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })
      .slice(0, top);
    let unqueriedDelivered = 0;
    for (const [id, tracked] of closed.records) {
      if (tracked.inCore + tracked.inMap + tracked.inPush > 0 && !closed.recalled.has(id)) unqueriedDelivered += 1;
    }
    const endedAt = now();
    const value: MemoryMetricsSnapshot = {
      schema: METRICS_SCHEMA,
      process: { startedAt: iso(startedAt), totals: { ...processTotals } },
      window: {
        startedAt: iso(closed.window.startedAt),
        durationMs: Math.max(0, endedAt - closed.window.startedAt),
        turns: closed.window.turns,
        deliveries: closed.window.deliveries
      },
      byChannel: toRecord(closed.byChannel),
      byScope: toRecord(closed.byScope),
      recall: {
        calls: closed.recall.calls,
        empty: closed.recall.empty,
        failed: closed.recall.failed,
        latencyMs: { total: closed.recall.latencyTotal, max: closed.recall.latencyMax }
      },
      unqueriedDelivered,
      dropped: closed.dropped,
      topRecords
    };
    if (options?.reset === true) state = freshWindow(endedAt);
    return value;
  };

  return { recordDelivery, recordRecall, snapshot, dispose: () => {} };
}

export interface MemoryMetricsOptions {
  intervalMs?: number;
  now?: () => number;
  logger?: MemoryMetricsLogger;
  /** Пометка источника строки журнала; на сервере — "server". */
  windowKey?: string;
}

function logSnapshot(logger: MemoryMetricsLogger | undefined, snapshot: MemoryMetricsSnapshot, windowKey: string): void {
  if (logger?.info === undefined) return;
  const seconds = Math.round(snapshot.window.durationMs / 1000);
  const top = snapshot.topRecords
    .slice(0, LOG_TOP_RECORDS)
    .map((record) => record.id + ":" + (record.inCore + record.inMap + record.inPush) + "/" + record.recallQueries)
    .join(",");
  logger.info(
    "balbes-memory-context: metrics key=" + windowKey +
      " window=" + seconds + "s" +
      " turns=" + snapshot.window.turns +
      " deliveries=" + snapshot.window.deliveries +
      " recall=" + snapshot.recall.calls + "/" + snapshot.recall.empty + "/" + snapshot.recall.failed +
      " unqueried=" + snapshot.unqueriedDelivered +
      " dropped=" + snapshot.dropped +
      (top === "" ? "" : " top=" + top)
  );
}

/**
 * Сервис метрик с интервальным сбросом окна в журнал. Таймер `unref()`:
 * фоновый снимок не держит процесс при остановке сервера. `dispose()`
 * идемпотентен и всегда пишет финальный снимок последнего окна.
 */
export function startMemoryMetrics(options: MemoryMetricsOptions = {}): MemoryMetricsService {
  const logger = options.logger;
  const ledger = createMemoryMetricsLedger(options.now === undefined ? {} : { now: options.now });
  const windowKey = options.windowKey ?? "server";
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const flush = (): void => {
    logSnapshot(logger, ledger.snapshot({ reset: true }), windowKey);
  };
  const intervalMs = options.intervalMs ?? DEFAULT_METRICS_INTERVAL_MS;
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    timer = setInterval(() => {
      try {
        flush();
      } catch (error) {
        logger?.warn("balbes-memory-context: metrics flush failed: " + (error instanceof Error ? error.message : String(error)));
      }
    }, intervalMs);
    timer.unref?.();
  }
  return {
    recordDelivery: (event) => {
      try {
        ledger.recordDelivery(event);
      } catch (error) {
        logger?.warn("balbes-memory-context: delivery metrics failed: " + (error instanceof Error ? error.message : String(error)));
      }
    },
    recordRecall: (event) => {
      try {
        ledger.recordRecall(event);
      } catch (error) {
        logger?.warn("balbes-memory-context: recall metrics failed: " + (error instanceof Error ? error.message : String(error)));
      }
    },
    snapshot: (snapshotOptions) => ledger.snapshot(snapshotOptions),
    dispose: () => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      try {
        flush();
      } catch (error) {
        logger?.warn("balbes-memory-context: metrics flush failed: " + (error instanceof Error ? error.message : String(error)));
      }
    }
  };
}
```

- [ ] **Step 5: Прогнать тест — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run metrics`
Expected: PASS — все кейсы `createMemoryMetricsLedger` и `startMemoryMetrics`.

- [ ] **Step 6: Проверить типы пакета**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context/src/metrics.ts \
  packages/plugins/dsh-balbes-memory-context/src/types.ts \
  packages/plugins/dsh-balbes-memory-context/tests/metrics.test.ts
git commit -m "feat(memory): add the in-process hit metrics aggregator (p10h)"
```

---

### Task 3: съём доставки и `recall` в слое памяти

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/src/context.ts`
- Modify: `packages/plugins/dsh-balbes-memory-context/src/recall.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/context.test.ts`, `packages/plugins/dsh-balbes-memory-context/tests/recall.test.ts`

**Interfaces:**
- Consumes: `MemoryMetricsService`/`MemoryMetricsSink`, `MemoryDeliveryEvent`, `MemoryRecallEvent`, `MemoryRecordRef`, `MemoryMetricsScopeTag` из `./types.js`; `createMemoryMetricsLedger` из `./metrics.js` (в тестах).
- Produces (для Tasks 4–6):
  - `createMemoryContext(logger: MemoryContextLogger, metrics?: MemoryMetricsSink)` — второй аргумент
  - `export function scopeTag(scope: MemoryContextScope): string` — был приватным, становится экспортом (`"global"` / `"project:<name>"`)
  - `buildRecallTool(memory: BalbesMemoryReadSlice, scopes: MemoryScope[], metrics?: MemoryRecallSink, tag?: { channel: string; scope: string })` с `export interface MemoryRecallSink { recordRecall(event: MemoryRecallEvent): void }`
  - `MemoryContextAttachment.metrics?` не добавляется: снимок берётся из сервиса, а не из handle

- [ ] **Step 1: Дописать падающие тесты съёма**

В `packages/plugins/dsh-balbes-memory-context/tests/context.test.ts` расширить harness вторым аргументом и добавить кейсы. Правки:

1. Импорты:

```ts
import { createMemoryMetricsLedger } from "../src/metrics.js";
import type { MemoryMetricsSnapshot, MemoryMetricsSink } from "../src/types.js";
```

2. В `harness(...)` добавить в сигнатуру `metrics?: MemoryMetricsSink`, создать в тестах явный ledger и передать его:

```ts
  const service = createMemoryContext(
    {
      warn: (message) => warnings.push(message),
      info: (message) => infos.push(message)
    },
    metrics
  );
```

3. Новый describe в конце файла:

```ts
describe("createMemoryContext metrics", () => {
  it("records one delivery event with the path ids and the omitted counts", async () => {
    const ledger = createMemoryMetricsLedger();
    const h = harness(
      [
        record({ id: "core", text: "Pinned deploy rule", pinned: true }),
        record({ id: "push", text: "deploy rollback procedure" })
      ],
      {},
      ledger
    ) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "global" }, { channel: "admin", sessionId: "s1" });
    await attachment.prepare("deploy");
    const snap: MemoryMetricsSnapshot = ledger.snapshot();
    expect(snap.window.turns).toBe(1);
    expect(snap.byChannel.admin).toEqual({ turns: 1, deliveries: 2 });
    expect(snap.byScope.global).toEqual({ turns: 1, deliveries: 2 });
    const core = snap.topRecords.find((entry) => entry.id === "core");
    const push = snap.topRecords.find((entry) => entry.id === "push");
    expect(core).toMatchObject({ type: "fact", scope: "global", inCore: 1, inMap: 0, inPush: 0 });
    expect(push).toMatchObject({ inCore: 0, inMap: 1, inPush: 1 });
    expect(snap.unqueriedDelivered).toBe(2);
  });

  it("does not record a delivery when prepare fails", async () => {
    const ledger = createMemoryMetricsLedger();
    const h = harness([], {}, ledger) as HarnessWithAttach;
    const failing = {
      get(key: string): unknown {
        if (key === "balbesMemory") {
          return { list: async () => { throw new Error("db down"); }, count: async () => 0, search: async () => [] };
        }
        return (h.agentCtx as { get(key: string): unknown }).get(key);
      }
    };
    const attachment = h.attach(failing, { kind: "global" }, { channel: "admin", sessionId: "s1" });
    await attachment.prepare("x");
    const snap = ledger.snapshot();
    expect(snap.window.turns).toBe(0);
    expect(snap.topRecords).toEqual([]);
  });

  it("keeps working without a metrics sink", async () => {
    const h = harness([record({ id: "a", text: "deploy note" })]) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "global" }, { channel: "admin", sessionId: "s1" });
    await expect(attachment.prepare("deploy")).resolves.toBeUndefined();
  });

  it("tags an unattributed delivery as project-less and unknown channel", async () => {
    const ledger = createMemoryMetricsLedger();
    const h = harness([record({ id: "a", text: "anything" })], {}, ledger) as HarnessWithAttach;
    const attachment = h.attach(h.agentCtx, { kind: "project", name: "proj" });
    await attachment.prepare("anything");
    const snap = ledger.snapshot();
    expect(snap.byChannel.unknown).toEqual({ turns: 1, deliveries: 1 });
    expect(snap.byScope["project:proj"]).toEqual({ turns: 1, deliveries: 1 });
  });
});
```

Тест «`byChannel.unknown`» опирается на дефолт канала в `attach`: без write-контекста канал равен `"unknown"`.

- [ ] **Step 2: Дописать падающий тест `recall`**

Добавить в `packages/plugins/dsh-balbes-memory-context/tests/recall.test.ts`:

```ts
import { createMemoryMetricsLedger } from "../src/metrics.js";

it("records ok with the delivered ids and the latency", async () => {
  const ledger = createMemoryMetricsLedger();
  const memory: BalbesMemoryReadSlice = {
    list: async () => [],
    count: async () => 0,
    search: async () => [{ record: record("a", "deploy procedure"), rank: -1 }]
  };
  const tool = buildRecallTool(memory, [{ kind: "global" }], ledger, { channel: "telegram", scope: "project:proj" });
  await tool.execute({ query: "deploy" }, {} as never);
  const snap = ledger.snapshot();
  expect(snap.recall.calls).toBe(1);
  expect(snap.recall.empty).toBe(0);
  expect(snap.recall.latencyMs.max).toBeGreaterThanOrEqual(0);
  expect(snap.topRecords.find((entry) => entry.id === "a")).toMatchObject({
    type: "fact",
    scope: "project:proj",
    recallDelivered: 1,
    recallQueries: 1
  });
});

it("records empty for a blank query without touching the store", async () => {
  const ledger = createMemoryMetricsLedger();
  const memory: BalbesMemoryReadSlice = {
    list: async () => [],
    count: async () => 0,
    search: async () => {
      throw new Error("search must not be called");
    }
  };
  const tool = buildRecallTool(memory, [{ kind: "global" }], ledger, { channel: "admin", scope: "global" });
  await tool.execute({ query: "!!!" }, {} as never);
  expect(ledger.snapshot().recall.empty).toBe(1);
});

it("records empty when the search returns nothing", async () => {
  const ledger = createMemoryMetricsLedger();
  const memory: BalbesMemoryReadSlice = { list: async () => [], count: async () => 0, search: async () => [] };
  const tool = buildRecallTool(memory, [{ kind: "global" }], ledger, { channel: "admin", scope: "global" });
  await tool.execute({ query: "deploy" }, {} as never);
  expect(ledger.snapshot().recall.empty).toBe(1);
});

it("records failed and still surfaces the tool error", async () => {
  const ledger = createMemoryMetricsLedger();
  const memory: BalbesMemoryReadSlice = {
    list: async () => [],
    count: async () => 0,
    search: async () => {
      throw new Error("db down");
    }
  };
  const tool = buildRecallTool(memory, [{ kind: "global" }], ledger, { channel: "admin", scope: "global" });
  await expect(tool.execute({ query: "deploy" }, {} as never)).rejects.toThrow(/recall failed/);
  const snap = ledger.snapshot();
  expect(snap.recall.failed).toBe(1);
  expect(snap.recall.empty).toBe(0);
});
```

- [ ] **Step 3: Прогнать тесты — убедиться, что падают**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run "context|recall"`
Expected: FAIL — `createMemoryContext` принимает один аргумент, `buildRecallTool` игнорирует метрику, `byChannel` пуст.

- [ ] **Step 4: Реализовать съём в `src/recall.ts`**

Правки `packages/plugins/dsh-balbes-memory-context/src/recall.ts`:

1. Импорт типа:

```ts
import type { BalbesMemoryReadSlice, MemoryRecallEvent } from "./types.js";
```

2. Рядом с `buildRecallTool` объявить срез:

```ts
/** Структурный срез агрегатора метрик: инструмент пишет только события recall. */
export interface MemoryRecallSink {
  recordRecall(event: MemoryRecallEvent): void;
}
```

3. Заменить сигнатуру и тело `execute`:

```ts
export function buildRecallTool(
  memory: BalbesMemoryReadSlice,
  scopes: MemoryScope[],
  metrics?: MemoryRecallSink,
  tag?: { channel: string; scope: string }
) {
  return defineTool({
    // …описание, parameters и output не меняются…
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
```

- [ ] **Step 5: Реализовать съём в `src/context.ts`**

Правки `packages/plugins/dsh-balbes-memory-context/src/context.ts`:

1. Импорты: добавить `buildMemoryRecordRefs` не нужно — refs строятся на месте; добавить типы:

```ts
import type {
  BalbesMemoryContextService,
  BalbesMemoryReadSlice,
  MemoryContextAttachment,
  MemoryContextScope,
  MemoryExtractionHandle,
  MemoryExtractionSlice,
  MemoryMetricsSink,
  MemoryProposalSlice,
  MemoryRecordRef,
  MemoryWriteContext,
  MemoryWriteSlice
} from "./types.js";
```

2. Экспортировать тег scope вместо приватной функции:

```ts
/** Тег уровня для метрик: "global" либо "project:<name>". */
export function scopeTag(scope: MemoryContextScope): string {
  return scope.kind === "global" ? "global" : "project:" + scope.name;
}
```

3. Новая сигнатура сервиса:

```ts
export function createMemoryContext(
  logger: MemoryContextLogger,
  metrics?: MemoryMetricsSink
): BalbesMemoryContextService {
```

4. Внутри `attach`, после вычисления `scopes`, добавить канал и хелпер refs:

```ts
      const channel = write?.channel ?? "unknown";
      const scopeName = scopeTag(scope);
      const refsOf = (records: readonly MemoryRecord[]): Record<string, MemoryRecordRef> =>
        Object.fromEntries(records.map((record) => [record.id, { type: record.type, scope: scopeName }]));
```

5. `recall` регистрируется с метрикой и тегом:

```ts
      tools.register(buildRecallTool(memory, scopes, metrics, { channel, scope: scopeName }));
```

6. В `prepare` сохранить `core`/`map`/`push` объектами (сейчас `push` уже объект, `core` — `RenderedBlock`), дописать событие после успешного рендера и понизить уровень лога:

```ts
            state.coreMap = escapeInterpolation([core.text, map.text].filter((text) => text !== "").join("\n\n"));
            state.push = escapeInterpolation(push.text);
            metrics?.recordDelivery({
              channel,
              scope: scopeName,
              core: { delivered: core.shown, omitted: Math.max(0, records.filter((record: MemoryRecord) => record.pinned).length - core.shown.length), chars: core.text.length },
              map: { delivered: map.shown, omitted: map.omitted, chars: map.text.length },
              push: { delivered: push.shown, omitted: 0, chars: push.text.length },
              records: refsOf([...records, ...pushRecords])
            });
            logger.debug?.(
              "balbes-memory-context: scope=" + scopeName +
                " core=" + core.shown.length +
                " map=" + map.shown.length +
                " push=" + push.shown.length
            );
```

Требуемые сопутствующие правки:

- `MemoryContextLogger` дополняется необязательным `debug?`:

```ts
export interface MemoryContextLogger {
  warn(message: string): void;
  info?(message: string): void;
  debug?(message: string): void;
}
```

- `map.omitted` берётся из `renderMap`: добавить поле `omitted` в `RenderedBlock` (`render.ts`) и заполнять его в `renderCore`/`renderMap`/`renderPush`:

```ts
export interface RenderedBlock {
  text: string;
  /** Ids записей, реально попавших в текст, в порядке вывода. */
  shown: string[];
  /** Сколько записей не поместилось в бюджет (для ядра — сколько pinned опущено). */
  omitted: number;
}
```

`renderCore` возвращает `{ text: lines.join("\n"), shown, omitted }` (ранние `return { text: "", shown: [] }` → `omitted: 0`), `renderMap` — `omitted` (тот же `omitted`, что идёт в строку «… ещё N …»), `renderPush` — `omitted: 0`.

- `pushRecords` — записи, реально попавшие в push; их надо получить из `renderPush`. Чтобы не менять публичную сигнатуру `renderPush(hits, coreShown)`, расширить `RenderedBlock` полем `records`:

```ts
export interface RenderedBlock {
  text: string;
  shown: string[];
  omitted: number;
  /** Записи, реально попавшие в текст (для метрик и провенанса); пусто там, где рендер идёт строками. */
  records: MemoryRecord[];
}
```

`renderCore(records)` → `records: records.filter((record) => shown.includes(record.id))`, `renderMap` — аналогично по `shown`, `renderPush` — по `shown` из `hits.map((hit) => hit.record)`.

- В `prepare` собирать refs по одному списку:

```ts
            const shownRecords = [
              ...core.records,
              ...map.records,
              ...push.records
            ];
            const refs = Object.fromEntries(shownRecords.map((record) => [record.id, { type: record.type, scope: scopeName }]));
```

и передать `records: refs` в событие; `map.omitted` — из `renderMap`.

- `state` получает `push` как блок, поэтому `push` в `prepare` инициализируется пустым блоком:

```ts
            let push: RenderedBlock = { text: "", shown: [], omitted: 0, records: [] };
            if (query !== "") {
              const hits = await memory.search({ query, filter: { scopes }, limit: PUSH_SEARCH_LIMIT });
              push = renderPush(hits, coreShown);
            }
```

- Ядро считает `omitted` само (см. правку `renderCore`), поэтому в событии `core.omitted` = `core.omitted`, `map.omitted` = `map.omitted`, `push.omitted` = `push.omitted`.

- `MemoryContextAttachment` остаётся без изменений; extraction-ход пишет события `recall` тем же тегом, что и задача (это допустимо: сигнал «запрошено явно» не зависит от вида хода).

- [ ] **Step 6: Прогнать тесты — убедиться, что проходят**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run "context|recall|render"`
Expected: PASS — расширенные `context`/`recall` и существующие `render` (правка `RenderedBlock` не ломает старые ассерты, потому что они читают `text`/`shown`).

- [ ] **Step 7: Проверить типы и линт пакета**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: PASS.

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run`
Expected: PASS — весь unit-набор пакета (`integration` пропущен без `RUN_REAL`).

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context/src/context.ts \
  packages/plugins/dsh-balbes-memory-context/src/recall.ts \
  packages/plugins/dsh-balbes-memory-context/src/render.ts \
  packages/plugins/dsh-balbes-memory-context/tests/context.test.ts \
  packages/plugins/dsh-balbes-memory-context/tests/recall.test.ts
git commit -m "feat(memory): record delivery and recall signals for hit metrics (p10h)"
```

---

### Task 4: сборка сервиса метрик в плагине

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/src/index.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/index.test.ts`

**Interfaces:**
- Consumes: `startMemoryMetrics`, `DEFAULT_METRICS_INTERVAL_MS` из `./metrics.js`; `createMemoryContext`; `MemoryMetricsService`, `MemoryMetricsSink` из `./types.js`.
- Produces (для Tasks 5–7):
  - `Config = z.object({ intervalMs: z.number().required(false) })`
  - `ctx.provide("balbesMemoryMetrics", service)` рядом с `ctx.provide("balbesMemoryContext", …)`
  - Строка журнала на сброс: `balbes-memory-context: metrics key=server window=…s turns=… deliveries=… recall=…/…/… unqueried=… dropped=…`

- [ ] **Step 1: Написать падающий тест плагина**

Заменить `packages/plugins/dsh-balbes-memory-context/tests/index.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { apply, name, Config } from "../src/index.js";

interface Seats {
  provided: Map<string, unknown>;
  infos: string[];
  warnings: string[];
}

function ctx(seats: Seats): unknown {
  return {
    provide(key: string, value: unknown) {
      seats.provided.set(key, value);
    },
    logger: {
      warn: (message: string) => seats.warnings.push(message),
      info: (message: string) => seats.infos.push(message)
    }
  };
}

function seats(): Seats {
  return { provided: new Map(), infos: [], warnings: [] };
}

describe("balbes-memory-context plugin", () => {
  it("exposes the functional plugin contract", () => {
    expect(name).toBe("balbes-memory-context");
    expect(Config).toBeDefined();
    expect(Config({})).toEqual({});
  });

  it("provides balbesMemoryContext and balbesMemoryMetrics on apply", () => {
    const taken = seats();
    apply(ctx(taken) as never, {});
    const context = taken.provided.get("balbesMemoryContext") as { attach?: unknown } | undefined;
    expect(typeof context?.attach).toBe("function");
    const metrics = taken.provided.get("balbesMemoryMetrics") as {
      recordDelivery?: unknown;
      snapshot?: unknown;
      dispose?: unknown;
    } | undefined;
    expect(typeof metrics?.recordDelivery).toBe("function");
    expect(typeof metrics?.snapshot).toBe("function");
    expect(typeof metrics?.dispose).toBe("function");
  });

  it("logs the window snapshot on disposal and closes the timer", () => {
    vi.useFakeTimers();
    try {
      const taken = seats();
      apply(ctx(taken) as never, { intervalMs: 0 });
      const metrics = taken.provided.get("balbesMemoryMetrics") as {
        recordDelivery(event: unknown): void;
        dispose(): void;
      };
      metrics.recordDelivery({
        channel: "admin",
        scope: "global",
        core: { delivered: ["a"], omitted: 0, chars: 1 },
        map: { delivered: [], omitted: 0, chars: 0 },
        push: { delivered: [], omitted: 0, chars: 0 }
      });
      metrics.dispose();
      expect(taken.infos.join("\n")).toContain("balbes-memory-context: metrics key=server");
      expect(taken.infos.join("\n")).toContain("turns=1");
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Прогнать тест — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run index`
Expected: FAIL — `balbesMemoryMetrics` не предоставляется.

- [ ] **Step 3: Собрать сервис в `src/index.ts`**

Заменить `packages/plugins/dsh-balbes-memory-context/src/index.ts`:

```ts
import z from "@deepseek-ai/schemastery";
import { createMemoryContext, type MemoryContextLogger } from "./context.js";
import { DEFAULT_METRICS_INTERVAL_MS, startMemoryMetrics } from "./metrics.js";
import type { BalbesMemoryContextService, MemoryMetricsService } from "./types.js";

export const name = "balbes-memory-context";
export const Config = z.object({ intervalMs: z.number().required(false) });

interface CtxLike {
  provide(key: string, value: unknown): void;
  logger: MemoryContextLogger;
}

/**
 * Метрики — эффект процесса, а не агента: один сервис на сервер, интервал
 * сброса окна в журнал. Нечисловой/неположительный интервал выключает таймер,
 * но снимок на сброс остаётся.
 */
export function apply(ctx: CtxLike, config: { intervalMs?: number }): void {
  const envInterval = Number(process.env.BALBES_MEMORY_METRICS_INTERVAL_MS);
  const intervalMs =
    typeof config.intervalMs === "number"
      ? config.intervalMs
      : Number.isFinite(envInterval) && process.env.BALBES_MEMORY_METRICS_INTERVAL_MS !== undefined
        ? envInterval
        : DEFAULT_METRICS_INTERVAL_MS;
  const metrics: MemoryMetricsService = startMemoryMetrics({ intervalMs, logger: ctx.logger });
  const service: BalbesMemoryContextService = createMemoryContext(ctx.logger, metrics);
  ctx.provide("balbesMemoryContext", service);
  ctx.provide("balbesMemoryMetrics", metrics);
}
```

- [ ] **Step 4: Прогнать тесты — убедиться, что проходят**

Run: `pnpm --filter dsh-balbes-memory-context exec vitest run`
Expected: PASS — весь unit-набор пакета.

- [ ] **Step 5: Проверить типы**

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context/src/index.ts \
  packages/plugins/dsh-balbes-memory-context/tests/index.test.ts
git commit -m "feat(memory): provide the balbesMemoryMetrics service (p10h)"
```

---

### Task 5: ручка `POST /api/memory/metrics`

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-admin/src/routes.ts`
- Modify: `packages/plugins/dsh-balbes-memory-admin/src/index.ts`
- Test: `packages/plugins/dsh-balbes-memory-admin/tests/index.test.ts`

**Interfaces:**
- Consumes: `MemoryMetricsSnapshot` из `dsh-balbes-contracts`; существующие `send`, `sendError`, `isObject`, `HttpSeatLike`, `ResLike`.
- Produces (для Task 6): `registerMemoryRoutes(http, getService, logger?, getMetrics?)` — четвёртый аргумент, `MetricsLike { snapshot(options?: { reset?: boolean; top?: number }): MemoryMetricsSnapshot }`; ручка `POST /api/memory/metrics` → `200 {metrics}` / `400 bad-request` / `503 metrics-unavailable`.

- [ ] **Step 1: Дописать падающие тесты ручки**

В `packages/plugins/dsh-balbes-memory-admin/tests/index.test.ts` используется
существующий harness: `Seat[]` (`http.post` складывает `{path, auth, handler}`),
`makeRes()` (даёт `{status, raw, json}` через `read()`) и `harness({service})`,
который зовёт `apply(ctx, {})`. Метрик в harness сейчас нет, поэтому расширяем
его, не ломая существующие тесты.

1. Импорты дополнить:

```ts
import { apply, Config, inject, name } from "../src/index.js";
import { registerMemoryRoutes } from "../src/routes.js";
import type {
  MemoryDecisionPatchLike,
  MemoryDraftLike,
  MemoryFilterLike,
  MemoryPatchLike,
  MemoryProposalDraftLike,
  MemoryProposalFilterLike,
  MemoryServiceLike,
  MetricsLike,
  ResLike
} from "../src/routes.js";
import type { MemoryAutonomyPolicy, MemoryMetricsSnapshot, MemoryProposal, MemoryRecord } from "dsh-balbes-contracts";
```

2. Рядом с `harness` добавить функцию сборки сидений, а сам `harness` сделать
   тонкой обёрткой (сигнатура и поведение `harness({service})` сохраняются):

```ts
interface RouteSeats {
  seats: Seat[];
  warnings: string[];
  infos: string[];
  call(path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }>;
}

function routeSeats(options: {
  service?: MemoryServiceLike | undefined;
  metrics?: MetricsLike | undefined;
  omitHttp?: boolean;
} = {}): RouteSeats {
  const seats: Seat[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const http = {
    post(path: string, auth: string, handler: Seat["handler"]) {
      seats.push({ path, auth, handler });
    }
  };
  registerMemoryRoutes(
    options.omitHttp === true ? undefined as never : http,
    () => options.service,
    { warn: (message) => warnings.push(message), info: (message) => infos.push(message) },
    () => options.metrics
  );
  async function call(path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }> {
    const seat = seats.find((candidate) => candidate.path === path);
    if (seat === undefined) throw new Error("no seat registered for " + path);
    const response = makeRes();
    await seat.handler({}, response.res, body);
    return response.read();
  }
  return { seats, warnings, infos, call };
}
```

3. `harness` переписать через `routeSeats`, чтобы `balbesMemoryMetrics` тоже
   резолвился в `ctx.get` (нужно для проверки проводки через `apply`):

```ts
function harness(options: HarnessOptions & { metrics?: MetricsLike } = {}) {
  const seats = routeSeats({ ...options, service: options.service });
  const ctx = {
    get(key: string): unknown {
      if (key === "balbesHttp") {
        return options.omitHttp === true
          ? undefined
          : { post(path: string, auth: string, handler: Seat["handler"]) { seats.seats.push({ path, auth, handler }); } };
      }
      if (key === "balbesMemory") return options.service;
      if (key === "balbesMemoryMetrics") return options.metrics;
      return undefined;
    },
    logger: {
      warn(message: string) { seats.warnings.push(message); },
      info(message: string) { seats.infos.push(message); }
    }
  };
  apply(ctx as never, {});
  return {
    seats: seats.seats,
    warnings: seats.warnings,
    infos: seats.infos,
    call: seats.call,
    setService(value: MemoryServiceLike | undefined) { options.service = value; }
  };
}
```

4. Новый describe в конце файла:

```ts
describe("POST /api/memory/metrics", () => {
  function snapshot(): MemoryMetricsSnapshot {
    return {
      schema: 1,
      process: { startedAt: "2026-10-01T00:00:00.000Z", totals: { turns: 3, deliveries: 5 } },
      window: { startedAt: "2026-10-01T00:00:00.000Z", durationMs: 10, turns: 3, deliveries: 5 },
      byChannel: { admin: { turns: 3, deliveries: 5 } },
      byScope: { global: { turns: 3, deliveries: 5 } },
      recall: { calls: 1, empty: 0, failed: 0, latencyMs: { total: 2, max: 2 } },
      unqueriedDelivered: 1,
      dropped: 0,
      topRecords: [
        { id: "m-1", type: "fact", scope: "global", inCore: 1, inMap: 0, inPush: 0, recallDelivered: 0, recallQueries: 0 }
      ]
    };
  }

  it("returns the snapshot and forwards reset/top", async () => {
    const calls: Array<{ reset?: boolean; top?: number } | undefined> = [];
    const expected = snapshot();
    const seats = routeSeats({
      metrics: {
        snapshot(options) {
          calls.push(options);
          return expected;
        }
      }
    });
    const response = await seats.call("/api/memory/metrics", { reset: true, top: 50 });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ metrics: expected });
    expect(calls).toEqual([{ reset: true, top: 50 }]);
  });

  it("uses the defaults when the body is empty", async () => {
    const calls: Array<{ reset?: boolean; top?: number } | undefined> = [];
    const seats = routeSeats({ metrics: { snapshot(options) { calls.push(options); return snapshot(); } } });
    const response = await seats.call("/api/memory/metrics", {});
    expect(response.status).toBe(200);
    expect(calls).toEqual([{}]);
  });

  it("answers 503 when the metrics service is missing", async () => {
    const seats = routeSeats({});
    const response = await seats.call("/api/memory/metrics", {});
    expect(response.status).toBe(503);
    expect(response.json).toEqual({
      error: { code: "metrics-unavailable", message: "memory metrics are not available" }
    });
  });

  it("rejects a non-boolean reset and an out-of-range top", async () => {
    const seats = routeSeats({ metrics: { snapshot: () => snapshot() } });
    for (const body of [{ reset: "yes" }, { top: 0 }, { top: 101 }, { top: 1.5 }, { top: "5" }]) {
      const response = await seats.call("/api/memory/metrics", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((response.json as { error: { code: string } }).error.code).toBe("bad-request");
    }
  });

  it("registers the route through apply with the bearer auth", () => {
    const seats = harness({ metrics: { snapshot: () => snapshot() } });
    const seat = seats.seats.find((candidate) => candidate.path === "/api/memory/metrics");
    expect(seat?.auth).toBe("bearer");
  });
});
```

- [ ] **Step 2: Прогнать тесты — убедиться, что падают**

Run: `pnpm --filter dsh-balbes-memory-admin exec vitest run index`
Expected: FAIL — `handler not registered: POST /api/memory/metrics`.

- [ ] **Step 3: Реализовать ручку в `src/routes.ts`**

Правки `packages/plugins/dsh-balbes-memory-admin/src/routes.ts`:

1. Импорт типа:

```ts
import type { MemoryMetricsSnapshot, MemoryProposal, MemoryProposalStatus, MemoryRecord, MemoryScope, MemoryType } from "dsh-balbes-contracts";
```

2. Срез сервиса метрик рядом с `MemoryServiceLike`:

```ts
/** Структурный срез сервиса метрик: только снимок, никакого I/O. */
export interface MetricsLike {
  snapshot(options?: { reset?: boolean; top?: number }): MemoryMetricsSnapshot;
}

function parseMetrics(body: unknown): { ok: true; options: { reset?: boolean; top?: number } } | { ok: false; message: string } {
  if (!isObject(body)) return { ok: true, options: {} };
  const options: { reset?: boolean; top?: number } = {};
  if (body.reset !== undefined) {
    if (typeof body.reset !== "boolean") return { ok: false, message: "reset must be a boolean" };
    options.reset = body.reset;
  }
  if (body.top !== undefined) {
    if (typeof body.top !== "number" || !Number.isInteger(body.top) || body.top < 1 || body.top > 100) {
      return { ok: false, message: "top must be an integer between 1 and 100" };
    }
    options.top = body.top;
  }
  return { ok: true, options };
}
```

3. Сигнатура и новая ручка:

```ts
export function registerMemoryRoutes(
  http: HttpSeatLike,
  getService: () => MemoryServiceLike | undefined,
  logger?: RoutesLogger,
  getMetrics?: () => MetricsLike | undefined
): void {
  const unavailable = (res: ResLike): void =>
    sendError(res, 503, "memory-unavailable", "memory storage is not available");
  // …существующие ручки без изменений…
  http.post("/api/memory/metrics", "bearer", async (_req, res, body) => {
    const metrics = getMetrics?.();
    if (metrics === undefined) {
      sendError(res, 503, "metrics-unavailable", "memory metrics are not available");
      return;
    }
    const parsed = parseMetrics(body);
    if (!parsed.ok) {
      sendError(res, 400, "bad-request", parsed.message);
      return;
    }
    try {
      send(res, 200, { metrics: metrics.snapshot(parsed.options) });
    } catch (error) {
      sendServiceError(res, error);
    }
  });
}
```

Разместить ручку после `/api/memory/review/reject`, внутри той же функции.

- [ ] **Step 4: Провести сервис из `src/index.ts`**

Правки `packages/plugins/dsh-balbes-memory-admin/src/index.ts`:

```ts
import { registerMemoryRoutes, type HttpSeatLike, type MemoryServiceLike, type MetricsLike } from "./routes.js";
// …
  registerMemoryRoutes(
    http,
    () => ctx.get("balbesMemory") as MemoryServiceLike | undefined,
    ctx.logger,
    () => ctx.get("balbesMemoryMetrics") as MetricsLike | undefined
  );
```

Обновить комментарий плагина: `balbesMemory` и `balbesMemoryMetrics` читаются лениво на запрос, поэтому порядок загрузки плагинов не важен, а отсутствие сервиса даёт 503, не 404.

- [ ] **Step 5: Прогнать тесты — убедиться, что проходят**

Run: `pnpm --filter dsh-balbes-memory-admin exec vitest run`
Expected: PASS — новые кейсы метрик и все существующие.

- [ ] **Step 6: Проверить типы**

Run: `pnpm --filter dsh-balbes-memory-admin typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-admin/src/routes.ts \
  packages/plugins/dsh-balbes-memory-admin/src/index.ts \
  packages/plugins/dsh-balbes-memory-admin/tests/index.test.ts
git commit -m "feat(memory): expose POST /api/memory/metrics (p10h)"
```

---

### Task 6: REAL-сценарий метрик

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts`
- Test: `packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts`

**Interfaces:**
- Consumes: фикстур-профиль `tests/fixtures/balbes-memory-context-profile` (уже содержит `dsh-balbes-memory-admin` и `dsh-balbes-memory-context`), `startStubLlm` (`setScript`, `calls`), существующие `prepareHome`/`bootServer`/`postJson`/`buildPackages`.
- Produces: доказательство, что ручка и агрегатор работают в реальной композиции и не отдают текст памяти.

- [ ] **Step 1: Дописать REAL-кейс**

В `packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts`, внутри `describe.skipIf(!realEnabled)`, добавить кейс после существующих (он использует уже поднятый сервер: `base`, `token` — локальные переменные первого кейса, поэтому кейс должен создавать собственные `base`/`token`, либо быть вписан в конец первого кейса; выбран второй вариант — дописать в конец первого `it`, потому что сервер поднимается один раз на файл, а порядок кейсов гарантирован):

```ts
      // p10h: наблюдаемость доставки — снимок без текста памяти.
      const metricsRes = await postJson(base + "/api/memory/metrics", {}, token);
      expect(metricsRes.status, metricsRes.raw).toBe(200);
      const metrics = (metricsRes.json as { metrics: Record<string, unknown> }).metrics;
      const admin = (metrics.byChannel as Record<string, { turns: number; deliveries: number }>).admin;
      expect(admin.turns).toBeGreaterThanOrEqual(1);
      expect(admin.deliveries).toBeGreaterThanOrEqual(1);
      const topRecords = metrics.topRecords as Array<{ id: string; type: string; scope: string; inCore: number }>;
      const pinnedId = (coreSave.json as { record: { id: string } }).record.id;
      const tracked = topRecords.find((entry) => entry.id === pinnedId);
      expect(tracked, JSON.stringify(topRecords)).toBeDefined();
      expect(tracked!.inCore).toBeGreaterThanOrEqual(1);
      expect(tracked!.type).toBe("fact");
      expect(tracked!.scope).toBe("global");
      // Приватность: ни текст памяти, ни originRef в снимок не попадают.
      const serializedMetrics = JSON.stringify(metrics);
      expect(serializedMetrics).not.toContain(coreMarker);
      expect(serializedMetrics).not.toContain(pushMarker);
      expect(serializedMetrics).not.toContain("originRef");

      // recall: вызов с попаданием учитывается, пустой результат — промах.
      stub.setScript([
        { toolCall: { name: "recall", arguments: JSON.stringify({ query: "deploy checks" }) } },
        { text: "recalled" }
      ]);
      const recallRun = await postJson(base + "/api/prompt", { prompt: "recall please" }, token);
      expect(recallRun.status, recallRun.raw).toBe(200);
      stub.setScript([
        { toolCall: { name: "recall", arguments: JSON.stringify({ query: "zzz-nonexistent-subject" }) } },
        { text: "nothing matched" }
      ]);
      const emptyRun = await postJson(base + "/api/prompt", { prompt: "recall the impossible" }, token);
      expect(emptyRun.status, emptyRun.raw).toBe(200);
      const recallRes = await postJson(base + "/api/memory/metrics", { reset: true, top: 5 }, token);
      expect(recallRes.status, recallRes.raw).toBe(200);
      const recallMetrics = (recallRes.json as { metrics: { recall: { calls: number; empty: number; failed: number } } }).metrics;
      expect(recallMetrics.recall.calls).toBeGreaterThanOrEqual(2);
      expect(recallMetrics.recall.empty).toBeGreaterThanOrEqual(1);
      expect(recallMetrics.recall.failed).toBe(0);
      // reset закрыл окно: следующий вызов видит пустое окно и сохранённые тоталы.
      const afterReset = await postJson(base + "/api/memory/metrics", {}, token);
      expect(afterReset.status, afterReset.raw).toBe(200);
      const resetMetrics = (afterReset.json as { metrics: { window: { turns: number }; process: { totals: { turns: number } } } }).metrics;
      expect(resetMetrics.window.turns).toBe(0);
      expect(resetMetrics.process.totals.turns).toBeGreaterThanOrEqual(1);
```

Замечание для исполнителя: `top` в снимке после `reset: true` возвращает топ **закрытого** окна, поэтому `recall`-ассерты читаются из `recallRes`, а не из `afterReset`.

- [ ] **Step 2: Собрать пакеты и прогнать REAL-тест**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-memory-context exec vitest run integration`
Expected: PASS при `dsh` в `PATH`; без `dsh` — набор пропущен (`describe.skipIf`).

- [ ] **Step 3: Проверить весь пакет и типы**

Run: `pnpm --filter dsh-balbes-memory-context test`
Expected: PASS — unit зелёный, `integration` пропущен без `RUN_REAL`.

Run: `pnpm --filter dsh-balbes-memory-context typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts
git commit -m "test(memory): prove hit metrics over the real composition (p10h)"
```

---

### Task 7: runbook, repo-wide проверки и канон-аудит

**Files:**
- Modify: `docs/runbooks/stage2-vps.md`
- Test: repo-wide `pnpm typecheck`, `pnpm lint`, `pnpm test`

**Interfaces:**
- Consumes: ручку `POST /api/memory/metrics` (Task 5), строку журнала `balbes-memory-context: metrics` (Task 4), канон Task 1.
- Produces: серверную инструкцию проверки для владельца и закрытую инициативу p10h.

- [ ] **Step 1: Дописать runbook**

В `docs/runbooks/stage2-vps.md` в разделе проверки памяти добавить блок (рядом с существующим smoke памяти; команды — в стиле файла, с ожидаемым выводом):

```bash
# Метрики попаданий памяти (p10h)
TOKEN=... # из POST /api/auth/login
curl -fsS -X POST http://127.0.0.1:8080/api/memory/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":{"kind":"global"},"type":"fact","text":"metrics-smoke: код запуска Балбеса — dsh-balbes","pinned":true}'
curl -fsS -X POST http://127.0.0.1:8080/api/prompt \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"Повтори дословно код запуска Балбеса"}'
curl -fsS -X POST http://127.0.0.1:8080/api/memory/metrics \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
  # ожидается: {"metrics":{...}} с byChannel.admin.turns >= 1,
  # topRecords содержит id записи с inCore >= 1, текста «metrics-smoke» в ответе нет
curl -fsS -X POST http://127.0.0.1:8080/api/memory/metrics \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"reset":true}'
  # ожидается: снимок закрытого окна; следующий вызов с {} даёт window.turns=0
  # и сохранённые process.totals
journalctl -u dsh-balbes -n 200 | grep 'balbes-memory-context: metrics'
  # ожидается: строка снимка окна (key=server window=…s turns=… deliveries=… recall=…/…/…)
  # без текста памяти
```

Отметить в runbook: метрики живут в процессе и обнуляются при рестарте
`dsh-balbes`; персистентность — отдельная инициатива p12.

- [ ] **Step 2: Repo-wide проверки**

Run: `pnpm typecheck`
Expected: PASS по всем пакетам.

Run: `pnpm lint`
Expected: PASS без новых предупреждений.

Run: `pnpm test --workspace-concurrency=1`
Expected: PASS — unit-наборы всех пакетов; REAL-наборы пропущены без `RUN_REAL`/`dsh`.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/stage2-vps.md
git commit -m "docs(runbook): verify memory hit metrics on the server (p10h)"
```

- [ ] **Step 4: Закрыть инициативу через `canon-audit`**

Вызвать скилл `canon-audit` по теме «метрики попаданий памяти (p10h)»: сверить
канон Task 1 с реализованным кодом (имена сервиса и ручки, состав снимка,
приватность, окно/сброс, граница с p12), устранить расхождения и убедиться, что
`future_plans/p10h-memory-hit-metrics.md` и `INDEX.md` отражают фактическое
состояние, а `p10i` заведена.

- [ ] **Step 5: Commit (если аудит правил канон)**

```bash
git add docs/canon
git commit -m "docs(canon): close the memory hit metrics initiative (p10h)"
```

---

## Self-Review

**1. Покрытие спеки**

| Раздел спеки | Задача |
|---|---|
| Цель, границы, решения | Task 1 (канон) + Global Constraints |
| Точка съёма сигнала, компоненты | Tasks 2–3 |
| События и окно (объёмные, per-record, промах, потолок, тотальность) | Task 2, Task 3 |
| Жизненный цикл (сервис, `provide`, интервал, shutdown, ленивое чтение ручкой) | Task 4, Task 5 |
| Запись сигнала в доставке (`prepare`, `recall`, `info`→`debug`) | Task 3 |
| Поверхность: ручка, формат снимка, errors | Task 5 (+ Task 6 на реальной композиции) |
| Приватность + тест-инвариант | Task 2 (unit), Task 6 (REAL) |
| Деградация и ошибки (нет сервиса → 503, падение `prepare`, ошибка агрегатора, `recall.failed`) | Task 2, Task 3, Task 5 |
| Тестирование (unit + REAL) | Tasks 2–6 |
| Канон (ARCHITECTURE/API_CONTRACTS/GLOSSARY/ADMIN_UI/OVERVIEW, p10h, p10i, INDEX) | Task 1, закрытие — Task 7 |
| Обновление на сервере + smoke | Task 7 |
| Отложено (p10i, p12, p10d, эвристика по ответу) | Task 1 (канон-границы), Task 7 (p10i заведена) |

Гэпов нет.

**2. Скан плейсхолдеров**

TBD/TODO/«допиши по вкусу» нет. Все шаги с кодом содержат код; шаги проверки —
точную команду и ожидаемый результат. Task 1 и Task 7 — документационные задачи
в существующей канон-инфраструктуре, у них вместо unit-теста `doc-canon validate`
и repo-wide проверки.

**3. Согласованность типов и имён**

- `createMemoryMetricsLedger` / `startMemoryMetrics` / `MemoryMetricsService.snapshot({reset, top})` — одинаково в Tasks 2–6.
- `createMemoryContext(logger, metrics)` — Tasks 3–4.
- `scopeTag` (экспорт из `context.ts`) — Tasks 3; в `metrics`/ручке тег приходит строкой, функция не импортируется.
- `buildRecallTool(memory, scopes, metrics?, tag?)` — Task 3; в Task 6 REAL-тест работает через реальный агент, сигнатуру не трогает.
- `registerMemoryRoutes(http, getService, logger?, getMetrics?)` — Task 5; в Task 6 вызывается уже существующей проводкой плагина.
- `RenderedBlock.omitted`/`records` — добавлены в Task 3 и используются только там.
- Ручка: путь `/api/memory/metrics`, коды `bad-request`/`metrics-unavailable` — совпадают в Tasks 5–7 и в каноне Task 1.
- `MemoryMetricsSnapshot.schema: 1` совпадает с `METRICS_SCHEMA = 1`.
