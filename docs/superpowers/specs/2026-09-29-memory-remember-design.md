# Явная запись памяти: инструмент `remember` (p10e) — дизайн

- Status: approved design
- Date: 2026-09-29
- Базируется на: `docs/canon/future_plans/p10e-memory-remember.md`,
  `p10-memory-system.md`, `p10a-memory-store.md`, `p10c-memory-context.md`,
  спеках `2026-09-26-memory-store-design.md`,
  `2026-09-27-memory-context-design.md`, `docs/canon/ARCHITECTURE.md`,
  `docs/canon/GLOSSARY.md`

## Цель

p10c научил агента читать память (`recall`), но писать — нет. Слой добавляет
scoped-инструмент `remember`: агент по ходу задачи явно сохраняет знание с
провенансом, а уровень (дом или текущий проект) выбирает слой, не модель. Это
первый сквозной write-путь памяти и предпосылка ревью (p10f) и автоизвлечения
(p10g). Инструмент работает поверх сервиса p10a, поэтому секретный барьер и
валидация записи не обходятся. Агентский цикл dsh не меняется: используются
штатные швы (`tools.register`, `ctx.llm`).

## Решения и границы

Согласовано с владельцем:

| Вопрос | Решение |
|---|---|
| Политика записи | Пишем сразу, `origin=agent`; очередь ревью и автономия — p10f |
| Уровень | Выбирает слой: в доме всегда global, в проекте — global или этот проект |
| Классификация уровня | Отдельный LLM-запрос слоем (не аргумент модели) |
| Модель классификатора | Текущая модель агента (`selection` из dispatch) |
| Пиннинг | Агент не может; `pinned=false` всегда, закрепить может владелец |
| Провенанс | `origin=agent`, `originRef="<channel> session:<sessionId>"` |
| Носитель инструмента | Тот же плагин `dsh-balbes-memory-context` (подход A) |
| Тип записи | `type` необязателен, дефолт `note` |
| Видимость | Запись попадает в доставку со следующего `prepare`; сейчас — tool result |
| HTTP/UI | Новых ручек и UI нет; `API_CONTRACTS.md`/`ADMIN_UI.md` не меняются |

Границы:

- Модельный write ровно один — `remember`; `save/update/delete` остаются у
  админки (p10b). Автоизвлечение, дедуп, TTL/затухание, конфликты, очередь
  ревью и метрики — p10d/p10f/p10g/p10h.
- Агент не может писать в другой проект: scope зафиксирован в замыкании,
  инструмент не принимает scope, а классификатор выбирает только между global и
  текущим проектом.
- Установленные `@deepseek-ai/*` не редактируются; новых сервисов ядра и новых
  пакетов не требуется.
- Сессионная память диалога — движка dsh, не переизобретается.

## Архитектура

### Компоненты пакета

Всё — в `packages/plugins/dsh-balbes-memory-context`; новых пакетов нет.

- `src/types.ts` — аддитивно:
  - `MemoryWriteContext { channel: string; sessionId: string; selection?: { provider: string; model: string } }`;
  - `MemoryWriteSlice` — структурный срез `save` сервиса `balbesMemory`
    (`scope, type, text, tags?, pinned?, origin: "agent", originRef?`);
  - `BalbesMemoryContextService.attach(agentCtx, scope, write?)`.
- `src/classify.ts` (новый) — классификация скоупа: чистые
  `classifyUserMessage`, `parseScopeAnswer`, константы промпта/лимитов и
  `createLlmClassifier(...)`, инкапсулирующий один вспомогательный LLM-вызов.
- `src/remember.ts` (новый) — `resolveWriteScope(...)` и `buildRememberTool(...)`.
- `src/context.ts` — при `attach` лениво резолвит `llm` и регистрирует
  `remember` рядом с `recall`.

Плагин читает `@deepseek-ai/dsh-llm` (`BlockAssembler`, `createUserMessage`) —
как сейчас читает `@deepseek-ai/dsh-tools`; модуль резолвится из зеркала
`$DSH_HOME/profiles/node_modules`, отдельной зависимости в `package.json` не
требуется.

### Контекст привязки (`attach`)

`attach` получает необязательный третий аргумент — живой контекст задачи. Он
нужен для провенанса и маршрута классификатора:

```ts
attach(agentCtx, scope, write?: MemoryWriteContext): MemoryContextAttachment
```

`attach` дополнительно резолвит `agentCtx.get("llm")`. Все резолвы —
ленивые, как сейчас; отсутствие любого из сервисов деградирует, а не падает.

- `recall` регистрируется всегда (как в p10c).
- `remember` регистрируется, только если у `balbesMemory` есть `save` **и**
  передан `write` (`channel` + `sessionId`). Так провенанс обязателен: без
  источника запись не появляется.
- Классификатор создаётся, только если есть и `llm`, и `write.selection`;
  иначе `remember` пишет в scope контекста.

### Классификатор скоупа

```ts
export type ClassifiedScope = "global" | "project";
export type ClassifyScope = (text: string, projectName: string) => Promise<ClassifiedScope | undefined>;

export const CLASSIFY_SYSTEM_PROMPT: string;
export const CLASSIFY_MAX_TOKENS = 16;
export const CLASSIFY_TIMEOUT_MS = 5000;

export interface LlmClassifierSeat {
  stream(options: {
    provider: string;
    model: string;
    system?: string;
    messages: unknown[];
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<unknown>;
}

export function classifyUserMessage(projectName: string, text: string): string;
export function parseScopeAnswer(raw: string): ClassifiedScope | undefined;
export function createLlmClassifier(
  llm: LlmClassifierSeat,
  selection: { provider: string; model: string },
  logger?: { warn(message: string): void }
): ClassifyScope;
```

Промпт (system) требует ответить ровно одним словом — `global` (факт про
владельца или систему в целом, применим в любом проекте) или `project` (факт
конкретен для названного проекта), без пояснений. Пользовательское сообщение —
имя проекта и текст факта.

`createLlmClassifier` делает **one-shot** вызов `llm.stream({
provider, model, system, messages, maxTokens, signal })` без `sessionId` и
`purpose`: вызов не привязывается к сессии агента и не пачкает её лог.
`purpose` — закрытый union ядра (`compaction | session-title`), новый код не
вводим; `sessionId` опускаем намеренно. Текст собирается `BlockAssembler`,
таймаут — через `AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)`.

`parseScopeAnswer` берёт все вхождения `global|project` (без учёта регистра);
если россыпь неоднозначна (встретились оба слова) или пуста — `undefined`.
`undefined` — не ошибка: это фолбэк на scope контекста.

### Инструмент `remember`

Scoped `defineTool`, замыкает `scope`, `write` и `classify`.

- `description` — model-facing, английский: «Save one durable fact to the
  owner's long-term memory. Use it when knowledge worth keeping across sessions
  or projects appears... The layer chooses where it is stored.»
- Параметры: `text` (string, required), `type` (enum
  `fact|preference|decision|note`, необязателен), `tags` (array of strings,
  необязательно). Параметров `scope` и `pinned` нет.
- `execute`:
  1. `type ?? "note"`;
  2. если `scope.kind === "project"` и есть `classify` —
     `classified = await classify(text, scope.name)`; сбой/таймаут ловятся,
     `classified` остаётся `undefined`;
  3. `target = resolveWriteScope(scope, classified)`;
  4. `record = await memory.save({ scope: target, type, text, tags, pinned: false,
     origin: "agent", originRef: "<channel> session:<sessionId>" })`;
  5. `logger.info` со счётчиками; вернуть `{ record }`.
- `output.render` — компактный текст: `Saved to global` /
  `Saved to project myproj`, тип, `id`, провенанс; помогает модели понять, что
  запись состоялась, и не повторять её.

`resolveWriteScope`:

```ts
function resolveWriteScope(scope: MemoryContextScope, classified?: ClassifiedScope): MemoryScope {
  if (scope.kind === "global") return { kind: "global" };
  return classified === "global" ? { kind: "global" } : { kind: "project", name: scope.name };
}
```

Никакой другой проект недостижим: классификатор выдаёт только `global` или
`project`, а `project` всегда разворачивается в имя из замыкания.

### Проводка dispatch

Оба канала уже держат сессию и выбор модели на момент создания агента — это и
есть шов провенанса/классификатора.

- `packages/bundles/dsh-balbes-host/src/runner.ts` (`POST /api/prompt`):
  вынести `sessionId` в локальную константу до `agents.create` и передать
  `memory?.attach(agentCtx, { kind: "global" }, { channel: "admin", sessionId,
  selection: { provider: selection.provider, model: selection.model } })`.
  Дом видит только global, поэтому LLM-классификация тут не зовётся.
- `packages/plugins/dsh-balbes-telegram/src/agentTask.ts`: эффективный
  `sessionId` известен до `setup` (для resume — `opts.sessionId`, для create —
  сгенерированный), передать
  `deps.memory?.attach(agentCtx, scope, { channel: "telegram", sessionId,
  selection: selection.initial })`. `scope` — прежний: `home → global`,
  `project → { kind:"project", name }`.

Структурные срезы `MemoryContextServiceLike` в обоих пакетах получают третий
аргумент; пакеты по-прежнему не импортируют друг друга.

## Поведение

### Выбор scope

| Контекст | LLM-классификация | Итоговый scope |
|---|---|---|
| дом (global) | не зовётся | `global` |
| проект, классификатор сказал global | зовётся | `global` |
| проект, классификатор сказал project | зовётся | текущий проект |
| проект, LLM/selection недоступны | не зовётся | текущий проект |
| проект, классификатор упал/таймаут/мусор | зовётся | текущий проект |

Фолбэк безопасен: при любой неопределённости знание остаётся в текущем проекте,
а не разливается глобально.

### Провенанс, тип, пиннинг

- `origin="agent"`; `originRef = <channel> session:<sessionId>` (например
  `telegram session:uuid`, `admin session:uuid`).
- Текст задачи в `originRef` не попадает: барьер p10a проверяет только `text`,
  поэтому превью задачи в провенанс не кладём.
- `pinned=false`; закрепление — только владелец в админке.
- `type` и `tags` нормализуются p10a; невалидный тег/тип — tool error.

### Видимость в доставке

`remember` не трогает снапшот `coreMap/push`, собранный `prepare` в начале
хода: запись становится видимой доставке со следующего `prepare` (следующий
ход/задача). Немедленная обратная связь агенту — результат самого инструмента
(сохранённая запись с `id`/`scope`/`originRef`). Это исключает
дублирование push и повторную сборку промпта посреди хода.

## Ошибки и деградация

| Ситуация | Поведение |
|---|---|
| `balbesMemory` нет при `attach` | `logger.warn`, no-op handle (как p10c) |
| `systemPrompt`/`tools` нет | warning, no-op (без регистраций) |
| у `balbesMemory` нет `save` | `remember` не регистрируется, `recall` работает |
| `write` не передан | `remember` не регистрируется (провенанс обязателен) |
| `llm`/`selection` нет | без классификации, scope контекста |
| classify упал/таймаут/мусор | scope контекста, warning |
| `secret-detected` на save | tool error «remember rejected: text looks like a secret»; записи нет |
| прочая ошибка `save` | tool error со стабильным текстом; ход не ломается |
| невалидный `type`/`tags` | tool error (`invalid-record` p10a) |

Все регистрации — через эффекты/диспозеры; agent-scoped эффекты снимаются при
`dispose()` handle, утечек между агентами и перезапусками нет.

## Наблюдаемость

`remember` пишет одну `logger.info`-строку: `channel`, `scope` (global или
имя проекта), `classified` (true/false) — без текста памяти. Это
детерминированный след для серверного smoke, не метрики p10h.

## Тестирование

**Unit** (`packages/plugins/dsh-balbes-memory-context/tests/`, fake ctx как в
соседних тестах):

- `classify`: `parseScopeAnswer` — global/project/регистр/оба слова/мусор/пусто;
  `classifyUserMessage` содержит имя проекта и текст;
  `createLlmClassifier` — успех, ошибка `stream`, таймаут/abort, пустой вывод;
- `remember`: матрица scope из таблицы; `pinned=false`; `originRef` из
  channel/sessionId; отсутствие `scope`-параметра; дефолт `note`; secret →
  tool error и ни одного `save`; ошибка `save` → tool error; работа без
  `classify`; `resolveWriteScope`;
- `attach`: `remember` регистрируется при `save`+write и не регистрируется
  без них; `recall` регистрируется всегда; порядки/имена секций и контекста
  p10c не меняются; `prepare` не бросает.

**REAL-композиция** (гейт `RUN_REAL=1` + `dsh` в PATH; fixture-профиль
`dsh-base + host + balbes-memory + balbes-memory-context + SSE-стаб`):

1. скрипт стаба заставляет агента вызвать `remember` (tool_use), затем закрывает
   ход текстом;
2. через `POST /api/memory/list` доказываем, что запись создана с
   `origin="agent"`, `originRef` начинается с `admin session:`, `pinned=false`,
   ожидаемым типом;
3. отдельно проверяем, что запись, сделанная моделью, доставляется следующим
   промптом (push/карта), т.е. write и read сходятся.

Классификация проектного scope в REAL требует Telegram-канала (в админке scope
global) — покрывается unit/attach-тестом с fake `llm`; тяжёлый Telegram REAL —
опционально, не блокирует p10e.

**Локальные проверки:** `pnpm typecheck`, `pnpm lint`, тесты пакета;
repo-wide — `--workspace-concurrency=1`, как у соседей.

## Канон

По canon-first, после утверждения этой спеки и до кода — `canon-write`:

- `ARCHITECTURE.md` — запись памяти: инструмент `remember`, агентский
  провенанс, классификация уровня, место явной записи в контуре; убрать
  формулировку «слой строго на чтение».
- `GLOSSARY.md` — термин «remember (явная запись памяти)».
- `OVERVIEW.md` — место явной записи в контуре памяти.
- `future_plans/p10e-memory-remember.md` и `future_plans/INDEX.md` — статус и
  закрытые открытые вопросы (через `canon-future-plan`).
- `API_CONTRACTS.md` и `ADMIN_UI.md` — без изменений, зафиксировать явно.
- `docs/runbooks/stage2-vps.md` — smoke записи (ниже).

После существенных правок канона — пауза на go-ahead владельца, затем код.
Закрытие инициативы — `canon-audit`.

## Обновление на сервере

Миграций БД нет, новых пакетов нет. Обновление — прежний повторный
`scripts/install.sh` (`git pull --ff-only` → сборка → `sync_profile` →
`copy_memory_context_into_profile()` → рестарт `dsh-balbes`).

Smoke после старта:

```bash
# 1) плагин загрузился без деградации (нет warning'ов про missing services)
journalctl -u dsh-balbes -n 200 | grep balbes-memory-context

# 2) модель пишет память инструментом remember
TOKEN=... # из POST /api/auth/login
curl -fsS -X POST http://127.0.0.1:8080/api/prompt \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"Сохрани в долговременную память инструментом remember факт: smoke-remember-marker: код запуска Балбеса — dsh-balbes"}'

# 3) запись видна с агентским провенансом
curl -fsS -X POST http://127.0.0.1:8080/api/memory/list \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query":"smoke-remember-marker"}'
  # ожидается: запись с origin "agent", originRef "admin session:...", pinned false
```

Если модель не вызвала инструмент с первого раза, повторить промпт; отсутствие
записи при явной инструкции — дефект (проверить, что `remember` есть в
`tools` запроса к модели).

## Отложено (не в p10e)

- Очередь ревью, статус предложенной записи, политика автономии — p10f.
- Автоизвлечение знания из задач — p10g.
- Дедупликация, затухание, забывание, конфликты, перенос между scope — p10d.
- Метрики попаданий/пользы — p10h.
- Семантический/векторный retrieval и внешние embedding-сервисы.
- Пиннинг агентом, мультиюзерность, роли.
- Обновление записи агентом (`update`/`delete`) — агент только создаёт.
