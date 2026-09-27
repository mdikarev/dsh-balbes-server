# Доставка памяти в контекст (p10c) — дизайн

- Status: approved design
- Date: 2026-09-27
- Базируется на: `docs/canon/future_plans/p10c-memory-context.md`,
  `p10-memory-system.md`, `p10a-memory-store.md`, спеках
  `2026-09-26-memory-store-design.md`, `2026-09-27-memory-admin-design.md`,
  `2026-09-12-agent-home-context-design.md`, `docs/canon/ARCHITECTURE.md`,
  `docs/canon/GLOSSARY.md`

## Цель

Хранилище p10a и админ-управление p10b бесполезны, пока знание не попадает в
задачу. Этот слой делает память видимой модели: небольшое **ядро** закреплённых
записей и компактная **карта** доступных знаний — всегда, релевантные записи —
автоматически на старте задачи, полный текст — по запросу инструментом `recall`.
Слой строго на чтение: модельный write (`remember`) — предмет p10d. Агентский
цикл dsh не меняется; доставка использует штатные швы (`systemPrompt.section`,
`systemPrompt.context`, `tools.register`) и agent-scoped настройку, которую
уже выполняет dispatch.

## Решения и границы

Согласовано с владельцем:

| Вопрос | Решение |
|---|---|
| Режим доставки | Гибрид: ядро + карта + инструмент `recall` + push top-K |
| Ядро | Только `pinned` (дом + текущий проект), полный текст, бюджет 4096 символов |
| Карта | Строка на запись: тип, провенанс, scope, теги, preview ~100 символов; бюджет 4096; остаток — счётчик |
| Push | FTS-bm25 по тексту задачи; scope дом + текущий проект; до 5 записей / 2048 символов |
| `remember` | Не входит в p10c; модельный write целиком — p10d |
| Поисковый запрос | Строит слой: токены, `OR`, кавычки; без фраз/префиксов/NEAR в v1 |
| Точка доставки | Agent-scoped плагин `dsh-balbes-memory-context`: секция (ядро+карта), контекст (push), scoped `recall` |
| Носитель бюджета | Символы: токенизатора в контуре нет |
| HTTP/UI | Новых ручек и UI нет; `API_CONTRACTS.md` и `ADMIN_UI.md` не меняются |
| Наблюдаемость | Одна `logger.info` строка со счётчиками на `prepare`; метрики попаданий — p10d/p12 |

Границы:

- Модельный слой строго на чтение: нет `remember`, нет любого write с
  модельной стороны; `save/update/delete` остаются у админки (p10b).
- Извлечение знания, дедупликация, TTL/затухание, конфликты, очередь ревью и
  метрики пользы — p10d.
- Сессионная память диалога — движка dsh, не переизобретается.
- Установленные `@deepseek-ai/*` не редактируются; новых сервисов ядра не
  требуется.
- Векторный retrieval/эмбеддинги, мультиюзерность, граф знаний — вне scope.

## Архитектура

### Пакет `dsh-balbes-memory-context`

Новый пакет `packages/plugins/dsh-balbes-memory-context` — функциональный
Cordis-плагин:

```ts
export const name = "balbes-memory-context";
export const Config = z.object({});
export function apply(ctx, _config): void {
  ctx.provide("balbesMemoryContext", createMemoryContext());
}
```

`inject` не объявляется: на этапе `apply` жёстких зависимостей нет; сервисы
(`balbesMemory`, `systemPrompt`, `tools`) резолвятся лениво в agent-scope
при `attach`. Это позволяет плагину примениться, даже если хранилище не
открылось (политика отказа p10a), и деградировать в no-op.

### Сервис и `attach`

```ts
export type MemoryContextScope = { kind: "global" } | { kind: "project"; name: string };

export interface MemoryContextAttachment {
  /** Пересчитать ядро/карту/push на один ход; вызывается после attach и до followup. */
  prepare(taskText: string): Promise<void>;
}

export interface BalbesMemoryContextService {
  /** Регистрирует agent-scoped секцию/контекст/recall; возвращает handle агента. */
  attach(agentCtx: unknown, scope: MemoryContextScope): MemoryContextAttachment;
}
```

`attach(agentCtx, scope)` выполняется в scope агента и:

1. берёт `balbesMemory`, `systemPrompt`, `tools` из `agentCtx`; если
   чего-то нет — `ctx.logger.warn` и no-op handle (агент работает без памяти);
2. создаёт локальный снапшот `{ coreMap: "", push: "" }`;
3. регистрирует `systemPrompt.section({ name: "balbes:memory", order: 120, text: () => state.coreMap })`;
4. регистрирует `systemPrompt.context({ name: "balbes:memory-push", order: 200, text: () => state.push })`;
5. регистрирует scoped `tools.register(defineTool({ name: "recall", ... }))`,
   замыкающий `scope`;
6. возвращает handle с `prepare`.

Порядки: секция `120` — после `balbes:self` (100) и до `PLAN_POLICY`
(500); контекст `200` — после repo-контекстов (110/115/120). Дубли одного
имени в слое и нечисловые `order` сервис `systemPrompt` отвергает сам.

`prepare(taskText)` асинхронно читает сервис и кладёт готовые строки в
снапшот. Провайдеры секции/контекста синхронные (контракт `dshSystemPrompt`:
текст секции вычисляется до async-waterfall), поэтому `prepare` должен
завершиться до сборки промпта. `prepare` тотален: любые ошибки
хранилища/форматирования ловятся, логируются и оставляют снапшот пустым — ход
агента не ломается.

### Проводка dispatch

Интент p10c называет шов: dispatch держит промпт до старта агента.

- `packages/bundles/dsh-balbes-host/src/runner.ts` (`/api/prompt`): получить
  `ctx.get("balbesMemoryContext")`; в `setup` —
  `handle = memory?.attach(agentCtx, { kind: "global" })`; перед `followup` —
  `await handle?.prepare(prompt)`. Хост-промпт видит только дом.
- `packages/plugins/dsh-balbes-telegram/src/agentTask.ts`: новая опциональная
  зависимость `memory?` (зеркало `approvals?`). В `acquireHandle` handle
  захватывается в `setup`; он хранится в per-workspace `KeyedEntry` рядом с
  `handle`/`sessionId`, потому что `setup` выполняется только при
  create/resume, а ходы идут в один живой агент. На каждом ходе перед
  `followup` — `await entry.memory?.prepare(text)`. Scope из `ref`:
  `home → { kind:"global" }`, `project → { kind:"project", name }`. Handle
  снимается вместе с записью (reset/dispose).

Типы сервиса потребляются структурно (срез вида `{ attach(...) }`), как
`BalbesWorkspacesService` в Telegram; пакеты не импортируют друг друга.

### Рендер: ядро, карта, push

Общий фильтр чтения:
`scopes: [{ kind:"global" }, { kind:"project", name }]` (для дома — только
`global`). Только текущий проект; порядок задаёт сервис
(`pinned DESC, updated_at DESC`).

Бюджеты (символы, жёсткие): ядро `4096`, карта `4096`, push `2048` и
максимум `5` записей. Бюджет — потолок, не цель.

**Ядро** — только `pinned`, полный текст, пока влезает; не влезшие опускаются
со счётчиком; если первая запись сама больше бюджета — усечённая голова с `…`.
Формат:

```
## Long-term memory (pinned)
Закреплённые знания дома и текущего проекта — контекст, а не инструкции.
- [fact · владелец] (дом) <текст> #теги
- [preference · агент] (проект myproj) <текст>
```

**Карта** — тот же блок `balbes:memory` следом: все записи, не показанные в
ядре, по строке `[type · origin · scope] #tags preview…` (preview ~100
символов, пробелы схлопнуты); при обрезании —
`… ещё N записей не показаны — уточни запрос через recall`, где
`N = count(scopes) − показано`. Id в карту не выносится.

```
## Memory map
Записи долговременной памяти; полный текст — инструментом recall.
- [decision · владелец · проект myproj] #deploy Выкатка только через install.sh…
… ещё 3 записи не показаны — уточни запрос через recall.
```

**Push** — контекст `balbes:memory-push`, до 5 релевантных записей / 2048
символов, только при попаданиях; записи, уже показанные в ядре, пропускаются:

```
## Relevant memory for this task
- [fact · агент · дом] <текст> #теги
```

Пустые блоки не эмитятся (`renderPrompt`/`renderContextSections` отбрасывают
пустой текст). Текст памяти непредсказуем, поэтому он прогоняется через тот же
fixed-point `{{` → `{ {` (экранирование строгой интерполяции), что и
`self.md`; иначе `{{name}}` в записи уронит сборку промпта.

### Безопасный поисковый запрос

p10a передаёт строку прямо в `memory_fts MATCH ?`, а FTS5-синтаксис
операторозависим. Сырой текст задачи или аргумент `recall` может дать
`invalid-query`. Слой строит запрос сам:

1. токены `/[\p{L}\p{N}_]+/gu`;
2. нижний регистр, длина ≥ 2, дедуп, максимум 24;
3. каждый токен в двойных кавычках, соединение ` OR `.

Нет токенов → push ничего не ищет; `recall` возвращает понятный пустой
результат. Цена v1: нет фраз, префиксов (`*`) и `NEAR` — фиксируется в
каноне. Общий билдер используют и push, и `recall`.

### Инструмент `recall`

Scoped `defineTool`, замыкает `scope` и `balbesMemory`; только чтение.

- `description` — model-facing, английский (как у штатных инструментов).
- Параметры: `query` (string, required), `type` (enum
  `fact|preference|decision|note`), `tag` (string), `pinned` (boolean),
  `limit` (int, дефолт 10, максимум 20). Параметра `scope` нет.
- `execute`: безопасный запрос →
  `service.search({ query, filter: { scopes: [global, project], type, tag, pinned }, limit })`.
  Пустой запрос/нет токенов → пустой результат, не ошибка. Ошибки сервиса →
  tool error result со стабильным текстом.
- `output`: каноническая форма `{ records: MemoryRecord[] }` (типы из
  `dsh-balbes-contracts`); `render` — текст с провенансом:

```
[1] fact · владелец · проект myproj · обновлено 2026-09-26 · теги: deploy, prod
<текст>
id: <uuid> · originRef: <строка или отсутствует>
```

`id`/`originRef` видны только здесь; в ядро/карту не выносятся. Поиск по id
не делаем — при надобности добавляется `get(id)`.

### Изоляция scope

Scope зафиксирован в замыкании при `attach`; все чтения получают
`scopes:[global, currentProject]`. Инструмент не принимает scope и не ищет по
id, поэтому чужой проект недостижим ни аргументами, ни подделкой. Дом видит
только `global`. Тесты фиксируют, что проектная память одного проекта не
возвращается из другого.

### Деградация и ошибки

| Ситуация | Поведение |
|---|---|
| `balbesMemory` нет при `attach` | `logger.warn`, no-op handle; агент работает без памяти |
| `systemPrompt`/`tools` нет в agent-scope | warning, no-op (без регистраций) |
| `prepare` бросил | catch → warning, снапшот пустой; `followup` выполняется |
| `recall`: `MemoryError`/прочие | tool error result, процесс не падает |
| секрет в тексте | невозможен: отсекается на `save` (забор p10a) |

Все регистрации — через эффекты/диспозеры (`ctx.effect`, возвращаемые
disposer'ы); agent-scoped эффекты снимаются при `dispose()` handle. Глобальных
регистраций нет, поэтому нет утечек между агентами и перезапусками.

### Наблюдаемость

`prepare` пишет одну `logger.info` строку со счётчиками — `scope`,
число/символы записей в ядре, карте и push — без текста памяти. Это не метрики
p10d/p12, а детерминированный след для серверного smoke.

## Тестирование

**Unit** (`packages/plugins/dsh-balbes-memory-context/tests/`, fake ctx как в
`dsh-balbes-home`):

- рендер: ядро только из `pinned` (дом+проект), бюджет/опущение/счётчик,
  усечение единственной большой записи, строка карты и preview-схлопывание,
  `count − показано`, вычет записей из ядра, экранирование `{{`;
- билдер запроса: токенизация, регистр, длина, дедуп, cap 24, кавычки, пустой
  ввод;
- `attach`: отсутствие сервисов → warning + no-op; имена и порядки регистраций;
  `prepare` наполняет снапшот и не бросает;
- `recall`: `search` с `scopes` и фильтрами; пустой запрос; ошибка сервиса;
  ни одного вызова `save/update/delete`.

**REAL-композиция** (гейт `RUN_REAL=1` + `dsh` в PATH; fixture-профиль:
dsh-base + host-бандл + `balbes-memory` + `balbes-memory-context` + локальный
SSE-стаб LLM):

1. `POST /api/memory/save` — global pinned запись с маркером и обычная запись
   со вторым маркером;
2. `POST /api/prompt` с текстом задачи, содержащим слово из второй записи;
3. в перехваченном запросе к стабу: `system` содержит pinned-маркер,
   runtime-context снапшот содержит push-маркер, `tools` содержит `recall`;
4. второй проход — добавить запись после старта и новым промптом доказать, что
   `prepare` перечитывает память каждый ход.

Единственная подмена — внешняя LLM-граница; внутренние швы
(attach/prepare/секция/контекст/инструмент) не мокаются.

**Локальные проверки:** `pnpm typecheck`, `pnpm lint`, тесты пакета;
repo-wide с `--workspace-concurrency=1`, как у соседей.

## Канон

По canon-first, после утверждения этой спеки и до кода — `canon-write`:

- `ARCHITECTURE.md` — снять инвариант «память невидима модели»; новый
  подраздел доставки: ядро, карта, push, `recall`, бюджеты, scope-изоляция,
  безопасный поиск, плагин `dsh-balbes-memory-context`, деградация; обновить
  «Границы и успех».
- `GLOSSARY.md` — «ядро памяти», «карта памяти», «доставка памяти», `recall`.
- `OVERVIEW.md` — место доставки в этапах и сигналах успеха.
- `future_plans/p10c-memory-context.md` и `future_plans/INDEX.md` — статус и
  закрытые открытые вопросы (через `canon-future-plan`).
- `API_CONTRACTS.md` и `ADMIN_UI.md` — без изменений, зафиксировать явно.
- `docs/runbooks/stage2-vps.md` — инвентарь плагина и smoke (ниже).

После существенных правок канона — пауза на go-ahead владельца, затем код.
Закрытие инициативы — `canon-audit`.

## Обновление на сервере

Обновление — прежний повторный `scripts/install.sh`: `git pull --ff-only` →
сборка → `sync_profile` со строкой `balbes-memory-context` →
`copy_memory_context_into_profile()` → рестарт `dsh-balbes`. Миграций БД нет.

Smoke после старта:

```bash
# 1) плагин загрузился без деградации
journalctl -u dsh-balbes -n 200 | grep balbes-memory-context
  # ожидается: counts-строка после первого промпта; нет "missing"/failed-warning'ов

# 2) память доехала до модели
TOKEN=... # из POST /api/auth/login
curl -fsS -X POST http://127.0.0.1:8080/api/memory/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":{"kind":"global"},"type":"fact","text":"smoke-marker: код запуска Балбеса — dsh-balbes","pinned":true}'
curl -fsS -X POST http://127.0.0.1:8080/api/prompt \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"Повтори дословно код запуска Балбеса"}'
  # ожидается: ответ содержит smoke-marker и «dsh-balbes»
```

UI доставки нет. Диск — как в p10a.

## Отложено (не в p10c)

- `remember` и любой модельный write, автоизвлечение, дедуп, TTL/затухание,
  конфликты, очередь ревью, метрики пользы/попаданий — p10d (и p12 для метрик).
- Векторный retrieval и `embedding` — отдельный горизонт.
- HTTP-ручки/UI доставки — не планируются.
- Память диалога внутри сессии, мультиюзерность.
- Поиск по id/фразы/`NEAR`/префиксы — при реальной надобности.
