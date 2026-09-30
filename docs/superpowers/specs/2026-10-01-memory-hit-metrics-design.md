# Метрики попаданий и пользы памяти (p10h) — дизайн

- Status: approved design
- Date: 2026-10-01
- Базируется на: `docs/canon/future_plans/p10h-memory-hit-metrics.md`,
  `p10-memory-system.md`, `p10d-memory-lifecycle.md`, `p12-observability.md`,
  спеках `2026-09-27-memory-context-design.md`,
  `2026-09-30-memory-extraction-design.md`, `docs/canon/ARCHITECTURE.md`,
  `docs/canon/API_CONTRACTS.md`, `docs/canon/ADMIN_UI.md`

## Цель

Владелец должен понимать, почему агент «вспомнил» именно это и приносит ли
память пользу. Слой доставки p10c уже решает, что попадёт в контекст, и логирует
одну строку счётчиков на `prepare`; `recall` не наблюдаем вовсе, а «польза» нигде
не фиксируется. p10h добавляет наблюдаемость поверх доставки: агрегирует, какие
записи и сколькими путями попадают в контекст, как часто вызывается `recall` и где
он даёт пустой результат, какие записи доставлены, но ни разу не запрошены. Слой
ничего не меняет в отборе и доставке и не управляет жизненным циклом: он
поставляет сигнал для p10d (затухание по попаданиям) и p12 (общий слой
наблюдаемости, персистентность).

## Решения и границы

Согласовано с владельцем:

| Вопрос | Решение |
|---|---|
| Объём | Агрегаты в процессе + структурированный снимок; без БД и без UI |
| Носитель | In-memory агрегатор в пакете доставки; персистентность, общий слой и алертинг — p12 |
| Состав | Объёмные счётчики по ходам/каналам/scope + per-record попадания (окно) |
| Промах (R1) | Два честных сигнала: пустой `recall` и «доставлена, но ни разу не запрошена»; вердикта «не помогла» нет |
| Поверхность | Bearer-ручка `POST /api/memory/metrics` + снимок в лог по интервалу и на shutdown |
| Окно | In-memory; интервал снимка 15 минут (`Config.intervalMs` / `BALBES_MEMORY_METRICS_INTERVAL_MS`), потолок уникальных id в окне 512 |
| UI | Отдельная инициатива p10i (UI метрик памяти); в этой итерации UI нет |
| Место кода | Существующий пакет `dsh-balbes-memory-context`; ручка — в `dsh-balbes-memory-admin` |
| Приватность | В метриках только id, тип, scope, счётчики, канал и время; текста памяти, `originRef`, промптов и секретов нет |

Границы:

- Алгоритм отбора и доставки не меняется: `renderCore`/`renderMap`/`renderPush`,
  бюджеты, FTS-запрос, scope-изоляция — как в p10c.
- Жизненный цикл, дедуп, TTL, конфликты — p10d; очередь ревью и автономия — p10f;
  извлечение — p10g. p10h только считает.
- «Польза» не выводится из текста ответа модели: эвристика по цитатам/id в ответе
  сознательно вне scope (шумная и трогает текст ответа).
- Персистентность, расширение health, метрики задач, ротация логов и алертинг —
  p12. p10h отдаёт p12 контракт снимка, не реализацию.
- Схема SQLite и `MemoryRecord` не меняются; миграций нет.
- Установленные `@deepseek-ai/*` не редактируются; `inject` у плагина не
  объявляется.

## Архитектура

### Точка съёма сигнала

Сигнал живёт там, где уже известен результат отбора — в пакете
`dsh-balbes-memory-context`:

- `context.ts` в `prepare` знает id и объём блоков ядра, карты и push, а также
  сколько записей опущено бюджетом. Это точка съёма «доставлено в контекст».
- `recall.ts` знает факт вызова, фильтр, число выданных записей и латентность
  поиска. Это точка съёма «запрошено явно» и «пустой результат».
- `remember`/`propose_memory` метрик не дают: это запись, а не доставка.

Отдельный пакет-плагин не заводится: он дал бы две точки правды о доставке и
лишнюю строку в compose профиля.

### Компоненты

```
packages/plugins/dsh-balbes-memory-context/src/
  metrics.ts        # чистый агрегатор + сервис balbesMemoryMetrics (без I/O)
  metrics.test.ts   # unit
  context.ts        # prepare и инструменты пишут в sink
  index.ts          # createMemoryContext(logger, metrics), provide, shutdown-сброс
  types.ts          # MemoryMetricsSink / MemoryMetricsService / MemoryMetricsSnapshot

packages/plugins/dsh-balbes-memory-admin/src/
  routes.ts         # POST /api/memory/metrics (структурный срез сервиса)
  index.ts          # ленивый ctx.get("balbesMemoryMetrics") на запрос
```

`metrics.ts` не знает ни про SQLite, ни про dsh: на вход записи событий, на
выход иммутабельный снимок. Поэтому агрегатор тестируется без композиции, а
ручка не тянет за собой хранилище.

### События и окно

```ts
export type MemoryMetricsChannel = string;          // "admin" | "telegram" | …
export type MemoryMetricsScopeTag = string;         // "global" | "project:<name>"

export interface MemoryDeliveryEvent {
  channel: MemoryMetricsChannel;
  scope: MemoryMetricsScopeTag;
  core: { delivered: string[]; omitted: number; chars: number };
  map: { delivered: string[]; omitted: number; chars: number };
  push: { delivered: string[]; omitted: number; chars: number };
  /** Вид записи для топ-выдачи; текста тут нет by design. */
  records?: Record<string, { type: string; scope: MemoryMetricsScopeTag }>;
}

export interface MemoryRecallEvent {
  channel: MemoryMetricsChannel;
  scope: MemoryMetricsScopeTag;
  /** "ok" | "empty" | "failed" */
  outcome: "ok" | "empty" | "failed";
  latencyMs: number;
  delivered?: string[];
  records?: Record<string, { type: string; scope: MemoryMetricsScopeTag }>;
}
```

Правила агрегации:

- **Объёмные счётчики** — по ходам: `window.turns`, `byChannel[ch].turns`,
  `byScope[tag].turns`; доставленные записи суммируются по путям
  (`core`/`map`/`push`) отдельно, потому что одна запись может попасть в ход
  несколькими путями. Символы блоков суммируются как `chars`.
- **Per-record** — `Map<id, counters>`: `inCore`, `inMap`, `inPush`,
  `recallDelivered`, `recallQueries`. `recallQueries` увеличивается один раз на
  каждый `recall`-вызов, вернувший запись, поэтому «доставлена, но ни разу не
  запрошена» — это `inCore+inMap+inPush > 0 && recallQueries === 0` за окно.
- **Промах** — счётчик `recall.empty` (пробел в памяти) и производное
  `unqueriedDelivered` (балласт). `recall.failed` считается отдельно: это
  деградация хранилища, а не промах. Вердикта «запись не помогла» нет.
- **Окно** — `window.startedAt` фиксируется при старте процесса; `snapshot({reset:true})`
  закрывает окно и начинает новое. Накопительные `process.totals` не сбрасываются
  никогда, поэтому рестарт сервиса не обнуляет картину полностью.
- **Границы памяти:** уникальных id в окне не больше `MAX_TRACKED_RECORDS`
  (512); сверх потолка новые id не заводят запись, счётчик `dropped` этого окна
  инкрементируется, а счётчики уже отслеживаемых продолжают расти. Окно
  закрывается **заменой** Map, а не удалением ключей: удалённая из хранилища
  запись не течёт.
- **Тотальность:** `record*` не бросает и не влияет на ход агента; внутренняя
  ошибка агрегатора ловится в вызывающем коде, логируется `warn` без текста
  памяти и оставляет метрику без изменения.

### Жизненный цикл

- `startMemoryMetrics(options)` в `index.ts` создаёт сервис: sink + снимок +
  `unref`-интервал (дефолт 15 минут, настраивается через `Config`/окружение
  `BALBES_MEMORY_METRICS_INTERVAL_MS`).
- `apply` делает `ctx.provide("balbesMemoryMetrics", service)` рядом с
  `balbesMemoryContext` и `ctx.provide("balbesMemoryContext", createMemoryContext(logger, sink))`.
- Интервал и shutdown-сброс оформляются эффектом, если шов доступен
  (`ctx.effect`); иначе таймер `unref()` и явный `dispose()` в конце `apply`.
  `unref` обязателен: интервал не должен держать процесс при остановке сервера.
- На shutdown — один финальный снимок в лог, чтобы последнее окно не терялось.
- Ручка читает сервис лениво на каждый запрос: если плагин не собрался, ручка
  отвечает `503 metrics-unavailable`, а не 404 (тот же паттерн, что у
  `balbesMemory`).

### Запись сигнала в доставке

- `attach` получает канал из уже имеющегося `write.channel` (`admin` |
  `telegram`); при его отсутствии канал = `"unknown"`. Тег scope считается
  существующим `scopeTag(scope)`.
- `prepare` после успешного рендера вызывает `sink.recordDelivery(...)` с id из
  `core.shown`/`map.shown`/`push.shown`, `omitted` из `renderCore`/`renderMap` и
  длинами текстов блоков. Если `prepare` упал, доставка не состоялась и событие
  не пишется (снимок честно показывает ноль).
- `buildRecallTool(memory, scopes, metrics?)` замеряет `performance.now()` вокруг
  `search`, пишет `outcome: "ok" | "empty" | "failed"` и id выданных записей.
  Таймаут/ошибка сервиса пишутся как `failed` и, как и раньше, отдаются агенту
  tool error'ом.
- Существующая `logger.info`-строка `prepare` понижается до `logger.debug`:
  основным следом становится снимок по интервалу, иначе журнал растёт по строке
  на каждый ход. Формат строки снимка: `balbes-memory-context: metrics window=…s
  turns=… deliveries=… recall=…/…/… unqueried=… dropped=…` плюс топ-5 записей
  (`id`, счётчики) — без текста памяти.

## Поверхность: ручка и формат снимка

`POST /api/memory/metrics`

- method: POST (R-API-1); path `/api/memory/metrics`; auth: bearer
- request: `{reset?: boolean, top?: integer}` — без `reset` снимок не мутирует;
  `reset: true` закрывает окно и возвращает снимок закрытого окна (накопительные
  тоталы сохраняются); `top` — размер `topRecords` (дефолт 20, максимум 100)
- response: `{metrics: MemoryMetricsSnapshot}`

```ts
export interface MemoryMetricsSnapshot {
  schema: 1;
  process: {
    startedAt: string;
    totals: { turns: number; deliveries: number };
  };
  window: {
    startedAt: string;
    durationMs: number;
    turns: number;
    deliveries: number;
  };
  byChannel: Record<string, { turns: number; deliveries: number }>;
  byScope: Record<string, { turns: number; deliveries: number }>;
  recall: {
    calls: number;
    empty: number;
    failed: number;
    latencyMs: { total: number; max: number };
  };
  /** Записей в окне, доставленных в контекст и ни разу не запрошенных recall. */
  unqueriedDelivered: number;
  /** Потолок уникальных id исчерпан: часть записей в окне не отслеживается. */
  dropped: number;
  topRecords: Array<{
    id: string;
    type: string;
    scope: MemoryMetricsScopeTag;
    inCore: number;
    inMap: number;
    inPush: number;
    recallDelivered: number;
    recallQueries: number;
  }>;
}
```

- `deliveries` — суммарное число вхождений записей в ядро/карту/push (то есть
  «сколько доставлено»); `turns` — сколько ходов дали доставку.
- `topRecords` сортируется по числу вхождений (затем по `recallQueries`), обрезается
  по `top`.
- errors: 400 `bad-request` (не булев `reset`; `top` не число/вне 1..100);
  401 (нет/битый токен); 503 `metrics-unavailable` (сервис не собран), 500 на
  прочих ошибках — в формате `{error: {code, message}}`, как у соседних ручек.
- notes: read-only; ничего не пишет в хранилище; текста памяти в ответе нет ни в
  одном поле — только id, тип, scope и счётчики. `reset` существует для
  детерминированного smoke без рестарта сервиса.

## Приватность

- В метрики и в лог попадают только: id записи, её тип, тег scope, имя канала,
  время, счётчики, размеры блоков в символах и латентность. Текст записи,
  `originRef`, теги памяти, промпт, ответ модели и аргумент `recall` не
  логируются и не возвращаются.
- Тест-инвариант: сериализованный снимок не содержит текста ни одной
  смоченной записи и не содержит поля `originRef`; снимок после хода с секретом
  в хранилище невозможен, потому что секрет отсекается ещё на `save` (p10a).

## Деградация и ошибки

| Ситуация | Поведение |
|---|---|
| Плагин метрик не собран | Ручка `503 metrics-unavailable`; доставка работает как раньше |
| `prepare` упал | Событие доставки не пишется; ход агента не ломается |
| Агрегатор бросил внутри | Ловится в вызывающем, `warn` без текста памяти; метрика без изменения |
| Потолок уникальных id | Новые id не отслеживаются, `dropped` растёт; снимок остаётся валидным |
| `recall` упал на хранилище | `recall.failed` + прежний tool error агенту |
| Рестарт сервиса | Окно и per-record теряются (in-memory by design); `process.totals` начинаются заново |

## Тестирование

**Unit** (`packages/plugins/dsh-balbes-memory-context/tests/`):

- `metrics.test.ts`: инкременты по путям и каналам/scope; одна запись в двух
  путях считается в обоих; `recallQueries` растёт по вызовам, а не по числу
  записей; `empty` vs `failed`; латентность `total`/`max`; окно закрывается и
  обнуляется при сохранении `process.totals`; потолок уникальных id и `dropped`;
  `unqueriedDelivered` и `topRecords` (сортировка, обрезка по `top`);
  сериализованный снимок не содержит текста памяти.
- `context.test.ts`: `prepare` пишет `recordDelivery` с id ядра/карты/push и
  `omitted`; падение `prepare` не пишет событие; `recall` пишет
  `ok`/`empty`/`failed` и латентность; отсутствие сервиса метрик не ломает
  `attach` (sink опционален).
- `index.test.ts`: `apply` предоставляет и `balbesMemoryContext`, и
  `balbesMemoryMetrics`; снимок доступен без обращений к хранилищу.

**REAL-композиция**: расширяем существующий REAL-тест p10c в
`packages/plugins/dsh-balbes-memory-context/tests/integration.test.ts` — фикстур-профиль
(`dsh-base` + host-бандл + `balbes-memory` + `balbes-memory-context` +
`balbes-memory-admin`) и SSE-стаб LLM остаются те же, подменяется только
внешняя LLM-граница:

1. `POST /api/memory/save` — global pinned запись с маркером;
2. `POST /api/prompt` с текстом задачи;
3. `POST /api/memory/metrics` — `byChannel.admin.turns ≥ 1`, среди `topRecords`
   есть id сохранённой записи с `inCore ≥ 1`; ни в одном поле ответа нет текста
   маркера;
4. ход, где модель зовёт `recall` (стаб), учитывается в `recall.calls`;
   `recall` без совпадений даёт `recall.empty = 1`;
5. `reset: true` возвращает непустое окно, а следующий вызов — пустое окно с
   сохранёнными `process.totals`.

Внутренние швы (attach/prepare/секция/контекст/инструменты/агрегатор) не
мокаются.

**Локальные проверки:** `pnpm typecheck`, `pnpm lint`, тесты пакета;
repo-wide — с `--workspace-concurrency=1`, как у соседей.

## Канон

По canon-first, после утверждения этой спеки и до кода — `canon-write`:

- `ARCHITECTURE.md` — новый подраздел «Метрики попаданий и пользы (p10h)»:
  агрегатор в пакете доставки, сервис `balbesMemoryMetrics`, состав снимка,
  in-memory окно и `reset`, per-record попадания, два сигнала промаха,
  приватность, деградация; из границ доставки снять «метрики пользы — p10h».
- `API_CONTRACTS.md` — новая ручка `memory.metrics` в стиле соседних
  `memory.*` (метод, path, auth, request, response, errors, notes).
- `GLOSSARY.md` — «попадание памяти», «польза памяти», «промах памяти»,
  «снимок метрик памяти».
- `ADMIN_UI.md` — явная фиксация: метрики памяти пока не отображаются в
  интерфейсе (UI — p10i); страница «Память» не меняется.
- `OVERVIEW.md` — сигналы успеха памяти: попадания и промахи наблюдаемы.
- `future_plans/p10h-memory-hit-metrics.md` — статус и закрытые открытые
  вопросы (через `canon-future-plan`).
- Новая инициатива `future_plans/p10i-memory-metrics-ui.md` + `future_plans/INDEX.md`
  (через `canon-future-plan`): UI метрик памяти поверх ручки p10h.
- `docs/runbooks/stage2-vps.md` — проверка метрик (ниже).

После существенных правок канона — пауза на go-ahead владельца, затем код.
Закрытие инициативы — `canon-audit`.

## Обновление на сервере

Обновление — прежний повторный `scripts/install.sh`: `git pull --ff-only` →
сборка → `sync_profile` → копирование плагинов в профиль → рестарт
`dsh-balbes`. Миграций БД нет, схема памяти не меняется.

Smoke после рестарта:

```bash
TOKEN=... # из POST /api/auth/login
curl -fsS -X POST http://127.0.0.1:8080/api/memory/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":{"kind":"global"},"type":"fact","text":"metrics-smoke: код запуска Балбеса — dsh-balbes","pinned":true}'
curl -fsS -X POST http://127.0.0.1:8080/api/prompt \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"Повтори дословно код запуска Балбеса"}'
curl -fsS -X POST http://127.0.0.1:8080/api/memory/metrics \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
  # ожидается: byChannel.admin.turns >= 1, topRecords содержит id записи с inCore >= 1,
  # в ответе нет текста «metrics-smoke»

journalctl -u dsh-balbes -n 200 | grep 'balbes-memory-context: metrics'
  # ожидается: строка снимка окна (turns/deliveries/recall) без текста памяти
```

## Отложено (не в p10h)

- UI метрик — p10i.
- Персистентность агрегатов, общий слой наблюдаемости, расширение health,
  ротация логов, алертинг — p12.
- Использование сигнала попаданий для TTL/затухания — p10d.
- Эвристика «польза» по тексту ответа модели (id/цитаты) — сознательно вне scope.
- Метрики записи (`remember`/`propose_memory`), метрики извлечения (p10g) —
  отдельные счётчики уже логируются, в снимок p10h не входят.
- Векторный retrieval, эмбеддинги, мультиюзерная аналитика.
