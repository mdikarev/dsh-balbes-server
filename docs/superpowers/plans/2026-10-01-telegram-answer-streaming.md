# Потоковая доставка ответа модели в Telegram (p11) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telegram-канал показывает текст ответа модели по мере генерации в отдельном растущем сообщении, которое в финале становится первым чанком точного ответа; живая карточка прогресса остаётся индикатором хода, поток включается переключателем «Потоковый ответ» в админке.

**Architecture:** чистый буфер `answerStream.ts` в пакете `dsh-balbes-telegram` копит `text-delta` кадры штатного события движка `agent/assistant-stream`, которое канал слушает в scope своего агента (тем же приёмом, что approval-answerer); окно открывает только ход задачи, поэтому служебный ход извлечения памяти в поток не попадает. Текст отдаётся новым read-методом раннера `answer(ref)` (рядом с `progress()`, который остаётся content-free), а `chat.ts` растит сообщение своим тикером по образцу карточки прогресса. Финальный текст по-прежнему берётся из durable `assistant/message` и доставляется существующим путём — поток только предпросмотр.

**Tech Stack:** TypeScript (strict, ESM), Cordis-плагины dsh, `@deepseek-ai/schemastery` (`Config`), `dsh-balbes-contracts` (TS-типы), React + Vite (страница «Telegram»), vitest (+ `@testing-library/react`), pnpm workspaces; новых зависимостей нет.

**Spec:** `docs/superpowers/specs/2026-10-01-telegram-answer-streaming-design.md`
**Canon (обновляется Task 1 до кода, код обязан совпасть):** `docs/canon/ARCHITECTURE.md` → секция Telegram-канала + Boundaries; `docs/canon/API_CONTRACTS.md` → `telegram.status`/`telegram.save` + scope-исключения; `docs/canon/ADMIN_UI.md` → страница «Telegram»; `docs/canon/GLOSSARY.md` → термин «поток ответа модели»; `docs/canon/OVERVIEW.md` → out-of-scope и сигналы успеха; `docs/canon/future_plans/p11-answer-streaming.md` + `future_plans/INDEX.md`.

## Global Constraints

- Работаем только в трёх пакетах: `packages/plugins/dsh-balbes-telegram`, `packages/contracts`, `packages/frontend/dsh-balbes-admin`. Поток в SPA и SSE/WS-канал `workspaces.events` не трогаем.
- Установленные `@deepseek-ai/*` не редактируются. Единственный шов движка — событие `agent/assistant-stream` (`@deepseek-ai/dsh-agent`), подписка через agent-scoped `agentCtx.on(...)` в `setup` (прецедент — `agentCtx.on("approval/request", …)` в `approvals.ts`).
- Никаких новых HTTP-ручек: только новые поля `streamAnswers` у существующих `telegram.status` / `telegram.save` (R-API-1 не ломается).
- `TaskProgress` не расширяется текстом модели: его инвариант «content-free … the assistant's text never appears» остаётся в силе, живой текст живёт в отдельном read `answer(ref)`.
- Константы потока: `LIVE_ANSWER_LIMIT = 8 * 1024` (буфер держит хвост), `ANSWER_VIEW_LIMIT = 3500` (витрина сообщения).
- Интервал потока: `ChatDeps.streamIntervalMs`, по умолчанию `progressIntervalMs` (в бою `DEFAULT_PROGRESS_INTERVAL_MS = 3500`); клампится тем же `clampInt`, нечисловое/неположительное значение падает на дефолт.
- Настройка: `streamAnswers` в `Config` плагина и в `telegramSettingsSchema`, дефолт `true`; отсутствующий ключ в разрешённой секции настроек читается как `true`; выключенная настройка = ровно сегодняшнее поведение канала.
- Флаги/интервалы фиксируются на задачу: `runTask` читает геттер один раз при старте, переключение посреди генерации не отрывает растущее сообщение.
- Принимаются только кадры `type === "chunk"` с `chunk.type === "text-delta"`; `reasoning-delta`, `tool-call-delta`, `block-start`, `block-end`, `usage`, `finish` игнорируются.
- Финальный текст — источник истины: `summarizeTurn()` + `splitMessage(sanitizeReply(...))`. Поток не влияет на доставку ответа; обрыв потока или падение правки не теряет ответ.
- Кнопок у сообщения потока нет: `liveCards`, роутинг колбэков, «⬅ Меню» и «⏹ Стоп» не меняются.
- Тесты: unit — под `tests/` (vitest); REAL — за гейтом `RUN_REAL=1` **и** `dsh` в `PATH`; mock только LLM-провайдер, Bot API, часы.
- Фокусированный прогон: `pnpm --filter dsh-balbes-telegram exec vitest run tests/<file>` (под pnpm 10 форма `pnpm --filter <пакет> test -- <фильтр>` запускает весь набор).
- Каждая задача заканчивается зелёными тестами и коммитом; `docs/runbooks/stage2-vps.md` обновляется в Task 8 (в том же изменении, до выката).
- Canon-first: Task 1 (`canon-write` + `canon-future-plan`) идёт **до** кода, после него — пауза на явный go-ahead владельца перед Task 2.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `docs/canon/ARCHITECTURE.md`, `API_CONTRACTS.md`, `ADMIN_UI.md`, `GLOSSARY.md`, `OVERVIEW.md` (modify, через `canon-write`) | Канон p11: шов `agent/assistant-stream`, форма потока, поля `streamAnswers`, термины, снятие из out-of-scope |
| `docs/canon/future_plans/p11-answer-streaming.md`, `future_plans/INDEX.md` (modify, через `canon-future-plan`) | Telegram-часть поглощена; админская остаётся будущим этапом |
| `packages/plugins/dsh-balbes-telegram/src/answerStream.ts` (create) | Чистый буфер живого ответа: приём `text-delta`, окно хода, хвост `LIVE_ANSWER_LIMIT`, `answerView` |
| `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` (modify) | Agent-scoped подписка в `setup`, окно хода, read `answer(ref)`, тип `LiveAnswerSnapshot` |
| `packages/plugins/dsh-balbes-telegram/src/chat.ts` (modify) | `startAnswerStream`, ленивое сообщение, финализация первым чанком, отмена/ошибка, `streamIntervalMs`, геттер `streamAnswers` |
| `packages/plugins/dsh-balbes-telegram/src/admin.ts` (modify) | `streamAnswers` в секции настроек, статусе и `telegram.save` (`invalid-stream-answers`) |
| `packages/plugins/dsh-balbes-telegram/src/index.ts` (modify) | `Config.streamAnswers` (+ volatile), `telegramSettingsSchema`, `settingsScope.get()`, проводка геттера в `ChatDeps` |
| `packages/plugins/dsh-balbes-telegram/tests/answerStream.test.ts` (create) | Юниты буфера и хвостового окна |
| `packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts` (modify) | Юниты `answer(ref)`: окно, фильтрация кадров, осевший ход |
| `packages/plugins/dsh-balbes-telegram/tests/chat.test.ts` (modify) | Юниты сообщения потока, финализации, отмены/ошибки, выключенной настройки |
| `packages/plugins/dsh-balbes-telegram/tests/admin.test.ts` (modify) | Юниты настройки: статус по умолчанию, save, 400 на не-boolean |
| `packages/plugins/dsh-balbes-telegram/tests/index.test.ts` (modify) | Проводка `streamAnswers` в `ChatDeps` из секции настроек |
| `packages/contracts/src/index.ts` (modify) | `TelegramSettingsStatus.streamAnswers`, `TelegramSaveRequest.streamAnswers` |
| `packages/contracts/tests/contracts.test.ts` (modify) | Компиляторная фиксация новых полей |
| `packages/frontend/dsh-balbes-admin/src/pages/TelegramPage.tsx` (modify) | Чекбокс «Потоковый ответ» в форме и в запросе сохранения |
| `packages/frontend/dsh-balbes-admin/tests/TelegramPage.test.tsx` (modify) | UI-тест переключателя |
| `packages/plugins/dsh-balbes-telegram/tests/helpers/stub-llm.mjs` + `packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs` (modify) | Дрип текста несколькими `text_delta` (две синхронные копии) |
| `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts` (modify) | REAL-сценарий потока на реальном профиле |
| `docs/runbooks/stage2-vps.md` (modify) | Переключатель и smoke «поток ответа» |

---

### Task 1: канон p11 и статус инициативы

**Files:**
- Modify (через `canon-write`): `docs/canon/ARCHITECTURE.md`, `docs/canon/API_CONTRACTS.md`, `docs/canon/ADMIN_UI.md`, `docs/canon/GLOSSARY.md`, `docs/canon/OVERVIEW.md`
- Modify (через `canon-future-plan`): `docs/canon/future_plans/p11-answer-streaming.md`, `docs/canon/future_plans/INDEX.md`

**Interfaces:**
- Consumes: спеку `docs/superpowers/specs/2026-10-01-telegram-answer-streaming-design.md` (таблица решений, §Архитектура, §Поверхность).
- Produces (для Tasks 2–8): зафиксированные каноном имена и значения — событие `agent/assistant-stream`, только `text-delta`; буфер 8 КиБ и витрина 3500; окно хода задачи; read `answer(ref)`; настройка `streamAnswers` (дефолт `true`); граница «поток в админку и SSE/WS — будущий этап».

- [ ] **Step 1: Обновить канон через скилл `canon-write`**

Вызвать скилл `canon-write` (не редактировать `docs/canon/**` вручную) с задачей: зафиксировать в живом каноне потоковую доставку ответа в Telegram-канале по спеке. Требуемые правки:

1. `ARCHITECTURE.md`, в секцию Telegram-канала (сразу после абзаца про живую карточку прогресса, который заканчивается словами «карточка информирует о ходе выполнения и не является потоковой доставкой ответа (та остаётся отдельным этапом)») — заменить хвост этого абзаца и добавить подраздел:

```markdown
  В карточку попадают имена инструментов и короткие цели из белого списка полей
  плюс todo-список агента; результаты инструментов и текст ответа модели в неё
  не попадают — карточка информирует о ходе выполнения. Текст ответа доставляется
  отдельно и потоково (см. «Поток ответа модели в канал»).
```

```markdown
### Поток ответа модели в канал

- Источник — штатное событие движка `agent/assistant-stream` (`@deepseek-ai/dsh-agent`):
  кадры `start`/`chunk`/`end`, где чанк несёт `StreamChunk`. Канал слушает его
  **в scope своего агента** (в `setup`, тем же приёмом, что approval-answerer),
  поэтому чужие агенты и субагенты в поток не попадают, а слушатель снимается
  вместе со scope. Принимаются только `text-delta`: рассуждения модели
  (`reasoning-delta`) не показываются, `tool-call-delta` уже покрыт карточкой.
- Окно потока открывает **только ход задачи**: служебный ход извлечения памяти
  (p10g) идёт в той же сессии и тем же агентом, но в буфер не пишет. Осевший ход
  живого текста не оставляет — та же дисциплина, что у окна прогресса.
- Сообщение потока — отдельное сообщение чата, которое растёт правками
  `editMessageText`; оно создаётся лениво, на первой непустой дельте, кнопок не
  имеет и в карточку прогресса не превращается. Витрина показывает хвост
  (последние ~3500 символов), буфер держит 8 КиБ: длинный ответ не раздувает
  память, а сообщение остаётся живым.
- Финал остаётся за durable `assistant/message`: точный текст собирает раннер, и
  сообщение потока становится его первым чанком (≤4096), остальные чанки уходят
  новыми сообщениями. Источник истины не двоится: поток — предпросмотр, обрыв
  потока или отказ правки не теряет ответ (чанки уходят штатным путём).
- Отмена и ошибка фрагмент не удаляют и не помечают: исход несут квитанция
  карточки и существующие сообщения об ошибке. Кнопок и своей семантики
  остановки у сообщения потока нет.
- Включение: настройка `streamAnswers` (`Config` плагина, дефолт включено),
  которой управляет страница «Telegram»; выключенная настройка возвращает канал
  ровно к доставке финальным сообщением. Значение фиксируется на задачу.
- Граница: поток в админку (SPA) и SSE/WS-транспорт — по-прежнему отдельный
  этап; живая карточка прогресса остаётся индикатором хода, а не потоком ответа.
```

2. `ARCHITECTURE.md`, раздел Boundaries («Не входит (следующие этапы)») — убрать из перечня «потоковая доставка ответов модели (SSE/WS; живая карточка прогресса — индикатор хода задачи, а не она)» и заменить на формулировку про админку:

```markdown
  потоковая доставка ответов модели в админку (SPA, SSE/WS);
  в канале Telegram поток ответа реализован — см. «Поток ответа модели в канал»,
```

3. `API_CONTRACTS.md`, `telegram.status` — в `response` добавить `streamAnswers: boolean`, в `notes` строку:

```markdown
  `streamAnswers` — настройка потоковой доставки ответа в чат (дефолт `true`;
  отсутствующий в документе настроек ключ читается как `true`).
```

4. `API_CONTRACTS.md`, `telegram.save` — в `request` добавить `streamAnswers?: boolean`, в `errors` добавить `400 invalid-stream-answers`:

```markdown
- request: `{token?: string, allowedUserId?: number, enabled?: boolean, streamAnswers?: boolean}` — отсутствующее поле не меняет прежнее значение
- errors: 400 `invalid-user-id` (user ID не положительное целое), 400 `invalid-config` (enabled без сохранённого token или положительного user ID), 400 `invalid-stream-answers` (не boolean), 401
```

5. `API_CONTRACTS.md`, scope-исключения (пункт «Вне scope», строки про streaming) — заменить на:

```markdown
  streaming-доставка ответов модели в админку/SPA (SSE/WS остаются отдельным
  этапом); в канале Telegram поток ответа реализован без SSE/WS — см.
  `telegram.status`,
```

6. `API_CONTRACTS.md`, `notes` ручки `workspaces.events` — заменить хвост «потоковая доставка ответов модели в чат — по-прежнему вне scope» на:

```markdown
  потоковая доставка ответов модели в чат идёт отдельным механизмом канала
  Telegram (без SSE/WS) и эту ручку не использует.
```

7. `ADMIN_UI.md`, описание страницы «Telegram» — добавить поле в перечень формы и поведения:

```markdown
- Страница «Telegram»: ... чекбокс **«Включить бота»** и чекбокс **«Потоковый
  ответ»** — настройка потоковой доставки текста ответа в чат (включена по
  умолчанию; выключенная возвращает доставку одним финальным сообщением).
  Переключатель уходит тем же сохранением, что остальные поля формы.
```

8. `GLOSSARY.md` — термин рядом с «живой карточкой прогресса» (сейчас там сказано «Это НЕ streaming ответа модели»):

```markdown
### `поток ответа модели` (streaming)

Текст ответа модели, доставляемый владельцу по мере генерации: в Telegram —
отдельное сообщение, которое растёт правками и в финале становится первым
чанком точного ответа. Источник — штатное событие движка
`agent/assistant-stream` (только `text-delta`), окно — ход задачи. Это НЕ живая
карточка прогресса: карточка показывает ход выполнения (инструменты, todo) и
текста ответа не содержит. Поток — предпросмотр: источник истины финального
текста остаётся durable `assistant/message`. Поток в админку (SPA, SSE/WS) —
отдельный будущий этап.
```

9. `OVERVIEW.md` — снять streaming из out-of-scope (строка «потоковая доставка ответов модели (SSE/WS)» — переформулировать как «потоковая доставка ответов модели в админку (SSE/WS)») и добавить в сигналы успеха пункт:

```markdown
- Владелец видит ответ модели в Telegram по мере генерации: отдельное растущее
  сообщение, которое в финале становится началом точного ответа; живая карточка
  прогресса остаётся индикатором хода задачи.
```

- [ ] **Step 2: Обновить инициативу через скилл `canon-future-plan`**

Вызвать скилл `canon-future-plan` с задачей: отразить, что Telegram-часть p11 реализуется этим изменением, а админская — остаётся будущим этапом. Требуемые правки в `docs/canon/future_plans/p11-answer-streaming.md`:

- `Status: draft` → `Status: partial (Telegram absorbed; admin stage remains)`;
- в «In scope» пометить Telegram-пункт как реализуемый, а пункты про SPA-транскрипт и `dsh-balbes-contracts`/SSE-канал — как остающийся этап (этой итерацией новых ручек/каналов нет: поток живёт внутри канала);
- в «Absorbs into» убрать `ADMIN_UI.md` из этого захода (админка получает только переключатель канала, поток в SPA не входит), оставив `ADMIN_UI.md` в админском этапе;
- отметить в «Open questions» закрытые решения: транспорт до чата — опрос read-шва раннера (без SSE/WS), гранулярность — только `text-delta` (плюс durable-события уже несёт карточка), Telegram — одно растущее сообщение с хвостовым окном, включение — настройка `streamAnswers`;
- синхронизировать `future_plans/INDEX.md`.

- [ ] **Step 3: Проверить канон**

Run: `doc-canon index && doc-canon scout "поток ответа модели в Telegram"`
Expected: scout находит обновлённые `ARCHITECTURE.md`, `API_CONTRACTS.md`, `GLOSSARY.md`, `ADMIN_UI.md`, `OVERVIEW.md`, `future_plans/p11-answer-streaming.md`; verdict без ошибок индекса.

- [ ] **Step 4: Коммит**

```bash
git add docs/canon
git commit -m "docs(canon): Telegram answer streaming and the streamAnswers setting (p11)"
```

- [ ] **Step 5: Пауза на go-ahead владельца**

Канон существенно меняет поведение канала: **остановиться** и получить явное «да» владельца перед Task 2 (требование canon-first из `CLAUDE.md`). Дальше не идти без ответа.

---

### Task 2: чистый буфер живого ответа

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/src/answerStream.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/answerStream.test.ts`

**Interfaces:**
- Consumes: ничего (чистый модуль).
- Produces (для Tasks 3–4): `LIVE_ANSWER_LIMIT: number = 8192`, `ANSWER_VIEW_LIMIT: number = 3500`, `interface AssistantFrameLike { type: string; chunk?: { type: string; text?: string } }`, `interface LiveAnswer { startTurn(): void; endTurn(): void; accept(frame: AssistantFrameLike): void; text(): string }`, `createLiveAnswer(): LiveAnswer`, `answerView(text: string, limit?: number): string`.

- [ ] **Step 1: Написать падающий тест**

Создать `packages/plugins/dsh-balbes-telegram/tests/answerStream.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ANSWER_VIEW_LIMIT,
  LIVE_ANSWER_LIMIT,
  answerView,
  createLiveAnswer
} from "../src/answerStream.js";

/** Кадр-дельта текста, как его публикует движок. */
function textDelta(text: string): { type: string; chunk: { type: string; text: string } } {
  return { type: "chunk", chunk: { type: "text-delta", text } };
}

describe("live answer buffer", () => {
  it("accumulates text deltas of an open turn only", () => {
    const live = createLiveAnswer();
    // До открытия окна кадры не принимаются: живой текст принадлежит ходу.
    live.accept(textDelta("мусор"));
    expect(live.text()).toBe("");

    live.startTurn();
    live.accept(textDelta("пол"));
    live.accept(textDelta("ный ответ"));
    expect(live.text()).toBe("полный ответ");
  });

  it("ignores every frame that is not a text delta", () => {
    const live = createLiveAnswer();
    live.startTurn();
    live.accept({ type: "start" });
    live.accept({ type: "end" });
    live.accept({ type: "chunk", chunk: { type: "reasoning-delta", text: "рассуждение" } });
    live.accept({ type: "chunk", chunk: { type: "tool-call-delta", text: "аргументы" } });
    live.accept({ type: "chunk", chunk: { type: "block-start" } });
    live.accept({ type: "chunk", chunk: { type: "block-end", text: "блок" } });
    live.accept({ type: "chunk", chunk: { type: "usage", text: "1" } });
    live.accept({ type: "chunk", chunk: { type: "finish", text: "stop" } });
    live.accept({ type: "chunk" });
    live.accept(textDelta("только это"));
    expect(live.text()).toBe("только это");
  });

  it("clears the text when a turn opens and when it closes", () => {
    const live = createLiveAnswer();
    live.startTurn();
    live.accept(textDelta("первый ход"));
    live.endTurn();
    expect(live.text()).toBe("");
    // Закрытое окно молчит, даже если кадр придёт позже (осевший ход).
    live.accept(textDelta("поздно"));
    expect(live.text()).toBe("");

    live.startTurn();
    expect(live.text()).toBe("");
    live.accept(textDelta("второй ход"));
    expect(live.text()).toBe("второй ход");
  });

  it("keeps only the tail of a long answer", () => {
    const live = createLiveAnswer();
    live.startTurn();
    live.accept(textDelta("a".repeat(LIVE_ANSWER_LIMIT)));
    live.accept(textDelta("b".repeat(1000)));
    const text = live.text();
    expect(text).toHaveLength(LIVE_ANSWER_LIMIT);
    expect(text.endsWith("b".repeat(1000))).toBe(true);
    expect(text.startsWith("a")).toBe(true);
  });
});

describe("answer view", () => {
  it("returns short text whole and cuts long text to its tail", () => {
    expect(answerView("короткий ответ")).toBe("короткий ответ");
    const head = "H".repeat(4000);
    const tail = "T".repeat(ANSWER_VIEW_LIMIT);
    const view = answerView(head + tail);
    expect(view).toHaveLength(ANSWER_VIEW_LIMIT);
    expect(view).toBe(tail);
  });

  it("honours an explicit limit and never returns a negative slice", () => {
    expect(answerView("abcdef", 2)).toBe("ef");
    expect(answerView("abcdef", 0)).toBe("");
    expect(answerView("abcdef", -5)).toBe("");
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/answerStream.test.ts`
Expected: FAIL — `Failed to resolve import "../src/answerStream.js"`.

- [ ] **Step 3: Написать модуль**

Создать `packages/plugins/dsh-balbes-telegram/src/answerStream.ts`:

```ts
/**
 * Живой текст хода задачи: буфер потока ответа модели для Telegram-канала.
 *
 * Единственный источник кадров — штатное событие движка
 * `agent/assistant-stream` (`@deepseek-ai/dsh-agent`): кадры `start`/`chunk`/
 * `end`, где чанк несёт `StreamChunk` (`@deepseek-ai/dsh-llm`). Поток здесь —
 * ПРЕДПРОСМОТР: канонический текст ответа остаётся durable `assistant/message`,
 * который суммирует раннер. Поэтому модуль чистый: ни I/O, ни бота, ни движка.
 */

/** Сколько символов держит буфер: длинный ответ не раздувает память. */
export const LIVE_ANSWER_LIMIT = 8 * 1024;

/** Сколько символов показывает витрина (сообщение в чате). */
export const ANSWER_VIEW_LIMIT = 3500;

/**
 * Минимальный срез кадра `agent/assistant-stream`. Пакет не импортирует типы
 * движка (как и остальные плагины): структурная форма зафиксирована движком, а
 * не этим пакетом.
 */
export interface AssistantFrameLike {
  type: string;
  chunk?: { type: string; text?: string };
}

export interface LiveAnswer {
  /** Открыть окно хода задачи: очистить текст и начать приём дельт. */
  startTurn(): void;
  /** Закрыть окно: приём выключен, текст очищен (осевший ход не читается). */
  endTurn(): void;
  /** Принять кадр: учитывается только `text-delta` открытого окна. */
  accept(frame: AssistantFrameLike): void;
  /** Накопленный хвост, не длиннее {@link LIVE_ANSWER_LIMIT}. */
  text(): string;
}

export function createLiveAnswer(): LiveAnswer {
  let open = false;
  let text = "";
  return {
    startTurn(): void {
      open = true;
      text = "";
    },
    endTurn(): void {
      open = false;
      text = "";
    },
    accept(frame: AssistantFrameLike): void {
      if (!open) return;
      if (frame.type !== "chunk") return;
      const chunk = frame.chunk;
      if (chunk === undefined || chunk.type !== "text-delta") return;
      const delta = chunk.text ?? "";
      if (delta === "") return;
      text += delta;
      if (text.length > LIVE_ANSWER_LIMIT) text = text.slice(text.length - LIVE_ANSWER_LIMIT);
    },
    text(): string {
      return text;
    }
  };
}

/** Хвостовое окно показа: последние `limit` символов текста. */
export function answerView(text: string, limit: number = ANSWER_VIEW_LIMIT): string {
  const size = Math.max(0, limit);
  return text.length <= size ? text : text.slice(text.length - size);
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/answerStream.test.ts`
Expected: PASS (6 тестов).

- [ ] **Step 5: Коммит**

```bash
git add packages/plugins/dsh-balbes-telegram/src/answerStream.ts packages/plugins/dsh-balbes-telegram/tests/answerStream.test.ts
git commit -m "feat(telegram): live answer buffer for the stream preview (p11)"
```

---

### Task 3: подписка на шов движка, окно хода и read `answer(ref)`

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` (типы у `TaskProgress`/`AgentTaskRunner`, `KeyedEntry`, `acquireHandle`, `executeTurn`, `startTurn`, `run`, `answer`)
- Test: `packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts`

**Interfaces:**
- Consumes: `createLiveAnswer`, `LiveAnswer`, `AssistantFrameLike` из `./answerStream.js` (Task 2).
- Produces (для Task 4): `export interface LiveAnswerSnapshot { phase: "idle" | "running"; taskText?: string; text?: string }` и метод `answer(ref: WorkspaceRef): LiveAnswerSnapshot` в `AgentTaskRunner`.

- [ ] **Step 1: Написать падающий тест**

Добавить в `packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts` (в конец файла; `makeRunner`, `makeAgents`, `waitFor` уже определены в этом файле):

```ts
describe("live answer stream", () => {
  /**
   * Фейковый agent-scope: запоминает слушателя `agent/assistant-stream` —
   * ровно тот шов, на который канал подписывается в `setup`, — и даёт emit,
   * чтобы тест публиковал кадры за движок.
   */
  function makeAnswerCtx(): {
    ctx: { on(event: string, listener: (payload: unknown) => void): () => void; get(key: string): unknown };
    emit(frame: unknown): void;
  } {
    let listener: ((payload: unknown) => void) | undefined;
    return {
      ctx: {
        on(event: string, fn: (payload: unknown) => void): () => void {
          if (event === "agent/assistant-stream") listener = fn;
          return () => {
            listener = undefined;
          };
        },
        get: () => undefined
      },
      emit(frame: unknown): void {
        listener?.({ frame });
      }
    };
  }

  it("exposes the running task turn's text and nothing else", async () => {
    const { agents, runner } = await makeRunner();
    agents.cfg({ holdIdle: true, answers: ["полный ответ"] });
    const result = runner.run({ scope: "home" }, "задача");
    await waitFor(() => agents.createOpts.length === 1);
    const answer = makeAnswerCtx();
    agents.createOpts[0]!.setup(answer.ctx);
    await waitFor(() => runner.progress({ scope: "home" }).phase === "running");

    answer.emit({ type: "chunk", chunk: { type: "text-delta", text: "пол" } });
    expect(runner.answer({ scope: "home" })).toEqual({ phase: "running", taskText: "задача", text: "пол" });

    // Рассуждения и служебные кадры в витрину не попадают.
    answer.emit({ type: "chunk", chunk: { type: "reasoning-delta", text: "шум" } });
    answer.emit({ type: "start" });
    answer.emit({ type: "chunk", chunk: { type: "tool-call-delta", text: "{}" } });
    expect(runner.answer({ scope: "home" }).text).toBe("пол");

    answer.emit({ type: "chunk", chunk: { type: "text-delta", text: "ный ответ" } });
    expect(runner.answer({ scope: "home" }).text).toBe("полный ответ");

    agents.created[0]!.releaseParked();
    await result;
  });

  it("reports idle without a turn of its own and after the turn settled", async () => {
    const { agents, runner } = await makeRunner();
    expect(runner.answer({ scope: "home" })).toEqual({ phase: "idle" });

    agents.cfg({ holdIdle: true, answers: ["готово"] });
    const result = runner.run({ scope: "home" }, "задача");
    await waitFor(() => agents.createOpts.length === 1);
    const answer = makeAnswerCtx();
    agents.createOpts[0]!.setup(answer.ctx);
    await waitFor(() => runner.progress({ scope: "home" }).phase === "running");
    answer.emit({ type: "chunk", chunk: { type: "text-delta", text: "живое" } });
    expect(runner.answer({ scope: "home" }).phase).toBe("running");

    agents.created[0]!.releaseParked();
    await result;

    // Осевший ход живого текста не оставляет, даже если кадр придёт позже.
    answer.emit({ type: "chunk", chunk: { type: "text-delta", text: "поздно" } });
    expect(runner.answer({ scope: "home" })).toEqual({ phase: "idle" });
  });

  it("does not report another workspace's live text", async () => {
    const { agents, runner } = await makeRunner();
    agents.cfg({ holdIdle: true, answers: ["ответ"] });
    const result = runner.run(PROJECT_ALPHA, "задача");
    await waitFor(() => agents.createOpts.length === 1);
    const answer = makeAnswerCtx();
    agents.createOpts[0]!.setup(answer.ctx);
    await waitFor(() => runner.progress(PROJECT_ALPHA).phase === "running");
    answer.emit({ type: "chunk", chunk: { type: "text-delta", text: "текст" } });

    expect(runner.answer({ scope: "home" })).toEqual({ phase: "idle" });
    expect(runner.answer(PROJECT_ALPHA).text).toBe("текст");

    agents.created[0]!.releaseParked();
    await result;
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.test.ts -t "live answer stream"`
Expected: FAIL — `runner.answer is not a function`.

- [ ] **Step 3: Добавить типы**

В `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` — импорт рядом с существующими и новый тип рядом с `TaskProgress` (инвариант `TaskProgress` не трогать!):

```ts
import { createLiveAnswer, type AssistantFrameLike, type LiveAnswer } from "./answerStream.js";
```

```ts
/**
 * Живой текст хода задачи этой workspace, для растущего сообщения потока.
 *
 * Отдельный от {@link TaskProgress} read намеренно: `TaskProgress` остаётся
 * content-free («the assistant's text never appears»), а текст модели живёт
 * здесь. Как и прогресс, снимок описывает ТОЛЬКО свой ход: у ожидающей задачи
 * фазы нет, у осевшей — тоже («a settled turn has no live state»).
 */
export interface LiveAnswerSnapshot {
  phase: "idle" | "running";
  /** Текст задачи, которой принадлежит ход: потребитель сверяется со своей. */
  taskText?: string;
  /** Накопленный хвост текста модели (<= LIVE_ANSWER_LIMIT). */
  text?: string;
}
```

В интерфейс `AgentTaskRunner` — метод сразу после `progress`:

```ts
  /**
   * Живой текст хода задачи этой workspace, или `idle`. Read-only и дешёвый:
   * ни I/O, ни агентского вызова — только буфер, который наполняет
   * agent-scoped слушатель `agent/assistant-stream`.
   */
  answer(ref: WorkspaceRef): LiveAnswerSnapshot;
```

- [ ] **Step 4: Открыть буфер в `setup` и в окне хода**

1. `interface KeyedEntry` — новое поле:

```ts
  /** Живой буфер ответа этого агента; окно открывает ход задачи. */
  liveAnswer: LiveAnswer | undefined;
```

2. Литерал entry в `run()` — добавить `liveAnswer: undefined` рядом с `memory: undefined`.

3. `acquireHandle` — создать буфер, подписаться в `setup`, вернуть его вместе с handle:

```ts
  async function acquireHandle(
    root: string,
    ref: WorkspaceRef,
    opts: { sessionId?: string } | undefined
  ): Promise<{ handle: AgentHandleLike; sessionId: string; memory: MemoryContextAttachmentLike | undefined; liveAnswer: LiveAnswer }> {
    const selection = liveSelection(deps.defaultModel);
    const freshSessionId = brandString(`session-${randomUUID()}`);
    let resumedSessionId: string | undefined = opts?.sessionId;
    let memory: MemoryContextAttachmentLike | undefined;
    /**
     * Живой поток ответа: agent-scoped слушатель получает кадры ТОЛЬКО этого
     * агента (scope-фильтрация движка) и снимается вместе со scope при
     * dispose. Окно открывает исключительно ход задачи (см. executeTurn),
     * поэтому дельты служебного хода извлечения памяти в буфер не попадают.
     */
    const liveAnswer = createLiveAnswer();
    const listenForAnswer = (agentCtx: unknown): void => {
      (agentCtx as {
        on(event: string, listener: (payload: { frame: AssistantFrameLike }) => void): () => void;
      }).on("agent/assistant-stream", ({ frame }) => liveAnswer.accept(frame));
    };
    const setup = (agentCtx: unknown): void => {
      composeAgentSetup(agentCtx, { selection: selection.ref });
      deps.approvals?.attach(agentCtx, ref);
      listenForAnswer(agentCtx);
      memory = deps.memory?.attach(
        agentCtx,
        ref.scope === "home" ? { kind: "global" } : { kind: "project", name: ref.name },
        {
          channel: "telegram",
          sessionId: resumedSessionId ?? freshSessionId,
          selection: { provider: selection.initial.provider, model: selection.initial.model }
        }
      );
    };
    if (opts?.sessionId !== undefined) {
      try {
        const handle = await deps.agents.resume({
          resumeSessionId: opts.sessionId,
          agentOptions: selection.initial,
          setup
        });
        return { handle, sessionId: opts.sessionId, memory, liveAnswer };
      } catch (error) {
        resumedSessionId = undefined;
        deps.logger?.warn(
          `dsh-balbes-telegram: resuming session "${opts.sessionId}" failed; creating a fresh session: ${errorMessage(error)}`
        );
      }
    }
    const sessionId = freshSessionId;
    const handle = await deps.agents.create({
      sessionId,
      meta: { cwd: root },
      agentOptions: selection.initial,
      setup
    });
    return { handle, sessionId, memory, liveAnswer };
  }
```

4. `executeTurn` — сохранить буфер на entry там, где сохраняется handle:

```ts
        entry.handle = handle;
        entry.sessionId = sessionId;
        entry.memory = acquired.memory;
        entry.liveAnswer = acquired.liveAnswer;
```

…и в ветке ошибки, где handle сбрасывается (`entry.handle = undefined; entry.sessionId = undefined; entry.memory = undefined;`), добавить `entry.liveAnswer = undefined;` (там же, где живёт `disposeQuietly(doomed, …)`).

5. `executeTurn` — открыть окно вместе с окном прогресса:

```ts
      entry.firstSeq = firstSeq;
      entry.startedAt = Date.now();
      // Поток ответа ограничен этим же ходом: служебный ход извлечения памяти
      // окно не открывает, поэтому в буфер не пишет.
      entry.liveAnswer?.startTurn();
```

6. `startTurn` (внешний FIFO-цикл) — в `finally`, рядом с очисткой окна прогресса:

```ts
      entry.firstSeq = undefined;
      entry.startedAt = undefined;
      // Осевший ход не оставляет живого текста: следующий тик чата не должен
      // подхватить чужой или уже доставленный ответ.
      entry.liveAnswer?.endTurn();
```

- [ ] **Step 5: Добавить read**

В возвращаемый объект `createAgentTaskRunner`, сразу после `progress(ref)`:

```ts
    /**
     * Живой текст хода задачи. Свободен от побочных эффектов ровно как
     * `progress`: чат читает его, пока ход в полёте, и не должен ни ждать, ни
     * будить агента.
     */
    answer(ref: WorkspaceRef): LiveAnswerSnapshot {
      const entry = cache.get(workspaceRefKey(ref));
      if (entry === undefined) return { phase: "idle" };
      if (!entry.busy || entry.handle === undefined || entry.firstSeq === undefined) {
        return { phase: "idle" };
      }
      const snapshot: LiveAnswerSnapshot = { phase: "running", text: entry.liveAnswer?.text() ?? "" };
      if (entry.activeText !== undefined) snapshot.taskText = entry.activeText;
      return snapshot;
    },
```

- [ ] **Step 6: Держать пакет типобезопасным**

Фейк `AgentTaskRunner` живёт в `packages/plugins/dsh-balbes-telegram/tests/chat.test.ts` (в `makeRunner`). Добавить туда заглушку нового read, чтобы `pnpm --filter dsh-balbes-telegram run typecheck` оставался зелёным уже на этом шаге (Task 4 превратит её в управляемый фейк):

```ts
  const answer = vi.fn((): LiveAnswerSnapshot => ({ phase: "idle" }));
```

…включить `answer` в объект `service` и в возвращаемый объект `makeRunner`, добавив `import type { LiveAnswerSnapshot } from "../src/agentTask.js";`.

- [ ] **Step 7: Убедиться, что тесты и типы проходят**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.test.ts`
Expected: PASS — новые тесты блока «live answer stream» и весь прежний набор `agentTask`.

Run: `pnpm --filter dsh-balbes-telegram run typecheck`
Expected: PASS (включая `tests/chat.test.ts` с заглушкой из Step 6).

- [ ] **Step 8: Коммит**

```bash
git add packages/plugins/dsh-balbes-telegram/src/agentTask.ts packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts packages/plugins/dsh-balbes-telegram/tests/chat.test.ts
git commit -m "feat(telegram): expose the live answer of a task turn (p11)"
```

---

### Task 4: растущее сообщение в чате, финализация, отмена и ошибка

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/chat.ts` (`ChatDeps`, `startAnswerStream`, `runTask`)
- Test: `packages/plugins/dsh-balbes-telegram/tests/chat.test.ts`

**Interfaces:**
- Consumes: `answerView` (Task 2), `answer(ref): LiveAnswerSnapshot` (Task 3).
- Produces (для Task 5): `ChatDeps.streamIntervalMs?: number`, `ChatDeps.streamAnswers?: () => boolean` — проводку геттера из секции настроек делает Task 5, когда поле секции уже существует.

- [ ] **Step 1: Расширить фейк раннера и написать падающий тест**

В `packages/plugins/dsh-balbes-telegram/tests/chat.test.ts`:

1. Заглушка `answer` из Task 3 (Step 6) уже есть в `makeRunner` — убедиться, что она отдаётся наружу (`answer` в возвращаемом объекте и в типе возврата), тесты переопределяют её через `h.runner.answer.mockReturnValue(...)`.

2. В `makeHarness` — прокинуть опции и читать геттер настройки:

```ts
    streamIntervalMs?: number;
    streamAnswers?: boolean;
```

```ts
    ...(opts.streamIntervalMs === undefined ? {} : { streamIntervalMs: opts.streamIntervalMs }),
    streamAnswers: () => opts.streamAnswers ?? true,
```

3. Добавить тесты в `describe("chat machine: tasks")`:

```ts
  it("grows a separate answer message while the task streams", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ streamIntervalMs: 1000 });
      withActive(h);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("долгая задача"));
      const cardId = h.bot.sent[0]!.messageId;

      h.runner.answer.mockReturnValue({ phase: "running", taskText: "долгая задача", text: "первый" });
      await vi.advanceTimersByTimeAsync(1000);

      // Поток — своё сообщение, карточка остаётся картой хода.
      expect(h.bot.sent).toHaveLength(2);
      expect(h.bot.sent[1]!.text).toBe("первый");
      expect(h.bot.sent[1]!.markup).toBeUndefined();
      const streamId = h.bot.sent[1]!.messageId;
      expect(streamId).not.toBe(cardId);

      // Идентичный текст не переотправляется.
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.bot.sent).toHaveLength(2);

      h.runner.answer.mockReturnValue({ phase: "running", taskText: "долгая задача", text: "первый второй" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.bot.lastEdit().messageId).toBe(streamId);
      expect(h.bot.lastEdit().text).toBe("первый второй");

      // Финал: сообщение потока становится точным ответом (он короче лимита,
      // поэтому это единственное сообщение ответа — новых не появляется).
      gate.release({ ok: true, text: "первый второй третий", sessionId: "s-1" });
      await drain();

      expect(h.bot.texts()).toEqual(["⏳ Дом агента · 0:00", "первый"]);
      expect(h.bot.lastEdit().messageId).toBe(streamId);
      expect(h.bot.lastEdit().text).toBe("первый второй третий");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows only the tail of a long answer and finalizes it as the first chunk", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ streamIntervalMs: 1000 });
      withActive(h);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("длинная"));
      const head = "H".repeat(4000);
      const tail = "T".repeat(3500);
      h.runner.answer.mockReturnValue({ phase: "running", taskText: "длинная", text: head + tail });
      await vi.advanceTimersByTimeAsync(1000);

      expect(h.bot.sent[1]!.text).toBe(tail); // витрина — хвост
      const streamId = h.bot.sent[1]!.messageId;

      gate.release({ ok: true, text: head + tail, sessionId: "s-1" });
      await drain();

      // Финал переписывает сообщение началом точного ответа (первый чанк
      // `splitMessage` — здесь без переводов строки, значит жёсткий срез 4096),
      // остаток уходит новым сообщением, и весь текст на месте без потерь.
      const firstChunk = (head + tail).slice(0, 4096);
      expect(h.bot.lastEdit().messageId).toBe(streamId);
      expect(h.bot.lastEdit().text).toBe(firstChunk);
      const rest = h.bot.texts().slice(2);
      expect(h.bot.lastEdit().text + rest.join("")).toBe(head + tail);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never creates a stream message when the setting is off", async () => {    vi.useFakeTimers();
    try {
      const h = makeHarness({ streamIntervalMs: 1000, streamAnswers: false });
      withActive(h);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("задача"));
      h.runner.answer.mockReturnValue({ phase: "running", taskText: "задача", text: "текст" });
      await vi.advanceTimersByTimeAsync(3000);

      expect(h.bot.sent).toHaveLength(1);

      gate.release({ ok: true, text: "готово", sessionId: "s-1" });
      await drain();
      expect(h.bot.texts()).toEqual(["⏳ Дом агента · 0:00", "готово"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the fragment and sends the rest as new messages when the final edit fails", async () => {
    vi.useFakeTimers();
    try {
      // Первый же editMessageText — финальный: он и отказывает. Правок карточки
      // в окне теста нет (тик карточки 3500 мс, окно — 1000 мс).
      const h = makeHarness({ streamIntervalMs: 1000, failEditPlan: [true] });
      withActive(h);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("задача"));
      h.runner.answer.mockReturnValue({ phase: "running", taskText: "задача", text: "фрагмент" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.bot.texts()[1]).toBe("фрагмент");

      gate.release({ ok: true, text: "точный ответ", sessionId: "s-1" });
      await drain();

      // Ответ не потерян: ушёл новым сообщением, фрагмент остался в чате.
      expect(h.bot.texts()).toContain("точный ответ");
      expect(h.bot.texts()).toContain("фрагмент");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the streamed fragment alone when the owner stops the task", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ streamIntervalMs: 1000 });
      withActive(h);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("задача"));
      h.runner.answer.mockReturnValue({ phase: "running", taskText: "задача", text: "недописан" });
      await vi.advanceTimersByTimeAsync(1000);
      const streamId = h.bot.sent[1]!.messageId;
      const editsBefore = h.bot.edits.filter((edit) => edit.messageId === streamId).length;

      gate.release({ ok: false, code: "cancelled", message: "остановлено" });
      await drain();

      // Фрагмент не удаляем и не помечаем: его сообщение больше не правится,
      // новых сообщений ответа нет — исход несёт квитанция карточки.
      expect(h.bot.texts()).toEqual(["⏳ Дом агента · 0:00", "недописан"]);
      expect(h.bot.edits.filter((edit) => edit.messageId === streamId)).toHaveLength(editsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
```

> Замечание исполнителю: `LiveAnswerSnapshot` для фейка берётся из `../src/agentTask.js` — добавить `import type { LiveAnswerSnapshot } from "../src/agentTask.js";` к существующим импортам этого файла. Если набор `tests/chat.test.ts` под fake timers уже имеет свой хелпер «прогнать N тиков», используй его вместо `vi.advanceTimersByTimeAsync` — смысл проверок не меняется.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/chat.test.ts -t "grows a separate answer message"`
Expected: FAIL — сообщение потока не появляется (тика потока ещё нет).

- [ ] **Step 3: Расширить `ChatDeps` и добавить handle потока**

В `packages/plugins/dsh-balbes-telegram/src/chat.ts`:

1. Импорт:

```ts
import { answerView } from "./answerStream.js";
```

2. `interface ChatDeps` — два новых поля рядом с `progressIntervalMs`:

```ts
  /** How often the growing answer message re-reads the runner (default progressIntervalMs). */
  streamIntervalMs?: number;
  /** Live switch of the answer stream; absent means enabled (setting default). */
  streamAnswers?: () => boolean;
```

3. Константа интервала — рядом с `progressIntervalMs`:

```ts
  /**
   * Answer-stream cadence. Mirrors the card's interval by default: two edits per
   * window is still well under Telegram's per-chat limit, and the card only
   * writes when its text really changed.
   */
  const streamIntervalMs = clampInt(
    deps.streamIntervalMs ?? deps.progressIntervalMs,
    DEFAULT_PROGRESS_INTERVAL_MS,
    1,
    3_600_000
  );
```

4. Handle и тикер — рядом с `startProgressCard`:

```ts
/** Одно растущее сообщение ответа: см. {@link startAnswerStream}. */
interface AnswerStreamHandle {
  /** Сообщение потока, или `undefined`, пока оно не создано. */
  messageId(): number | undefined;
  /** Текст, который сообщение показывает сейчас (последняя успешная запись). */
  shown(): string;
  /** Остановить тикер: новые правки не начинаются. */
  stop(): void;
  /** Дождаться уже ушедшей правки; никогда не reject'ит. */
  idle(): Promise<void>;
}
```

```ts
  /**
   * Растущее сообщение ответа. Поток — ПРЕДПРОСМОТР: точный текст приходит из
   * раннера в финале, поэтому сообщение создаётся лениво (ход без текста
   * лишнего сообщения не оставляет), а его жизнь зеркалит карточку прогресса:
   * цепочка правок, счётчик неудач, `idle()` перед финализацией. Кнопок у
   * сообщения нет, `liveCards` его не знает — нажатий на нём не бывает.
   */
  function startAnswerStream(chatId: number, ref: WorkspaceRef, taskText: string): AnswerStreamHandle {
    let messageId: number | undefined;
    let lastText = "";
    let failures = 0;
    let pending: Promise<void> = Promise.resolve();
    const tick = async (): Promise<void> => {
      try {
        const snapshot = deps.runner.answer(ref);
        // Чужая или ещё не начатая задача: это сообщение молчит, как и карточка.
        if (snapshot.phase === "idle" || snapshot.taskText !== taskText) return;
        const view = answerView(snapshot.text ?? "");
        if (view === "" || view === lastText) return;
        if (messageId === undefined) {
          const created = await deps.bot.sendMessage(chatId, view);
          // 0 — «id неизвестен» (см. bot.ts): править нечего, поток заканчивается,
          // ответ доедет штатной финальной доставкой.
          if (created === 0) {
            clearInterval(timer);
            return;
          }
          messageId = created;
        } else {
          await deps.bot.editMessageText(chatId, messageId, view);
        }
        lastText = view;
        // Успешная запись доказывает, что поток жив: счётчик неудач обнуляется.
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= MAX_CARD_EDIT_FAILURES) clearInterval(timer);
        warn(`answer stream write failed (${codeOf(error)})`);
      }
    };
    const timer = setInterval(() => {
      // Та же цепочка, что у карточки: две правки одного сообщения не должны
      // обгонять друг друга, а `idle()` покрывает всё, что уже на проводе.
      pending = pending.then(() => tick(), () => {}).catch(() => {});
    }, streamIntervalMs);
    timer.unref?.();
    return {
      messageId: () => messageId,
      shown: () => lastText,
      stop: () => clearInterval(timer),
      idle: () => pending.catch(() => undefined)
    };
  }
```

- [ ] **Step 4: Встроить поток в `runTask`**

1. В начале `runTask` (до `deps.runner.run`) — фиксация настройки и старт потока:

```ts
    /**
     * Поток фиксируется на задачу: выключение посреди генерации не отрывает
     * уже растущее сообщение, а включение не оживляет прошлую задачу.
     */
    const stream = (deps.streamAnswers?.() ?? true) ? startAnswerStream(chatId, ref, text) : undefined;
```

2. Успешная ветка (`if (result.ok)`) — финализация вместо безусловной отправки чанков:

```ts
      if (result.ok) {
        receipt = {
          kind: "done",
          steps: Math.max(deps.runner.progress(ref).steps.length, card?.steps() ?? 0)
        };
        // Сначала остановить поток и дождаться правки «в полёте»: иначе поздний
        // тик перепишет финальный ответ, который владельцу больше неоткуда взять.
        stream?.stop();
        await stream?.idle();
        const chunks = splitMessage(sanitizeReply(result.text));
        const streamedId = stream?.messageId();
        if (chunks.length === 0) {
          // Фрагмент владельцу уже показан и остаётся ответом; пустой плашки нет.
          if (streamedId === undefined) await send(chatId, EMPTY_REPLY);
          return;
        }
        if (streamedId !== undefined && stream?.shown() === chunks[0]) {
          // Показанное уже точное начало ответа: доотправляем только остаток.
          for (const chunk of chunks.slice(1)) await send(chatId, chunk);
          return;
        }
        if (streamedId !== undefined) {
          try {
            await deps.bot.editMessageText(chatId, streamedId, chunks[0]);
            for (const chunk of chunks.slice(1)) await send(chatId, chunk);
          } catch (error) {
            // Правка не прошла: ответ важнее отсутствия дубля — уходит целиком.
            warn(`answer stream finalize failed (${codeOf(error)})`);
            for (const chunk of chunks) await send(chatId, chunk);
          }
          return;
        }
        for (const chunk of chunks) await send(chatId, chunk);
        return;
      }
```

3. `finally` — гасить поток вместе с карточкой (идемпотентно для успешной ветки):

```ts
      card?.stop();
      stream?.stop();
      await card?.idle();
      await stream?.idle();
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/chat.test.ts`
Expected: PASS — новые тесты потока и весь прежний набор `chat` (в частности прежние утверждения «ответ уходит отдельным сообщением» и «карточка не содержит ответа»).

- [ ] **Step 6: Коммит**

```bash
git add packages/plugins/dsh-balbes-telegram/src/chat.ts packages/plugins/dsh-balbes-telegram/tests/chat.test.ts
git commit -m "feat(telegram): grow a separate answer message while the model streams (p11)"
```

---

### Task 5: настройка `streamAnswers` — плагин, секция настроек, контракты, ручки

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/index.ts` (`Config`, `TelegramConfigLike`, `telegramSettingsSchema`, `createSettingsScope`)
- Modify: `packages/plugins/dsh-balbes-telegram/src/admin.ts` (`TelegramSettingsSection`, `TelegramStatus`, `buildTelegramStatus`, `telegram.save`)
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/admin.test.ts`, `packages/plugins/dsh-balbes-telegram/tests/index.test.ts`, `packages/contracts/tests/contracts.test.ts`

**Interfaces:**
- Consumes: `ChatDeps.streamAnswers` (Task 4).
- Produces (для Task 6): поле `streamAnswers: boolean` в `TelegramSettingsStatus` и `streamAnswers?: boolean` в `TelegramSaveRequest` из `dsh-balbes-contracts`; код ошибки `invalid-stream-answers`.

- [ ] **Step 1: Расширить контракты и написать падающий тест контрактов**

`packages/contracts/src/index.ts`:

```ts
export interface TelegramSettingsStatus {
  state: TelegramState;
  /** Token presence is reported as a boolean; the token itself never appears in responses. */
  tokenConfigured: boolean;
  enabled: boolean;
  /** Answer streaming in the chat; an absent settings key resolves to true. */
  streamAnswers: boolean;
  /** Allowed Telegram user id; absent = no allowlist. */
  allowedUserId?: number;
  botUsername?: string;
  lastPollAt?: string; // ISO 8601
  /** R-API-1 error envelope shape; present only when state === "error". */
  error?: { code: string; message: string };
}
```

```ts
export interface TelegramSaveRequest {
  /** Bot token to store; absent = keep unchanged (never echoed back). */
  token?: string;
  allowedUserId?: number;
  enabled?: boolean;
  /** Answer streaming in the chat; absent = keep the stored value. */
  streamAnswers?: boolean;
}
```

`packages/contracts/tests/contracts.test.ts` — в тесте `"status carries no token, only tokenConfigured"` добавить `streamAnswers` во все литералы `TelegramSettingsStatus` и новый запрос:

```ts
    const status: TelegramSettingsStatus = { state: "connected", tokenConfigured: true, enabled: true, streamAnswers: true, allowedUserId: 12345, botUsername: "balbes_bot", lastPollAt: "2026-09-10T00:00:00.000Z" };
    const statusRes: TelegramStatusResponse = { status };
    const saveRes: TelegramSaveResponse = { status: { state: "disabled", tokenConfigured: true, enabled: false, streamAnswers: false, allowedUserId: 12345 } };
    const saveReq: TelegramSaveRequest = { allowedUserId: 12345, enabled: true, streamAnswers: false }; // token absent = keep
    const streamReq: TelegramSaveRequest = { streamAnswers: true }; // только переключатель потока
    const disableRes: TelegramDisableResponse = { status: { state: "disabled", tokenConfigured: true, enabled: false, streamAnswers: true } };
    const clearRes: TelegramClearTokenResponse = { status: { state: "not-configured", tokenConfigured: false, enabled: false, streamAnswers: true } };
```

…и добавить `streamReq` в финальный `expect([...])`.

Run: `pnpm --filter dsh-balbes-contracts exec vitest run`
Expected: FAIL — компилятор/тест требует поле `streamAnswers` там, где его ещё нет в `admin.ts` (типы плагина независимы, тест контрактов пройдёт первым — тогда падение придёт на typecheck плагина в Step 4).

- [ ] **Step 2: Написать падающие тесты настроек**

В `packages/plugins/dsh-balbes-telegram/tests/admin.test.ts` — добавить в подходящий `describe` ручек `telegram.status`/`telegram.save`:

```ts
  it("reports the stream setting, defaulting an absent key to enabled", async () => {
    // Секция старого документа настроек ключа не несёт — это «включено».
    const withoutKey = makeDeps({ settings: new FakeScope({ enabled: true, allowedUserId: 7, streamAnswers: undefined }) });
    await call(withoutKey.registration, "/api/telegram/status", {}, withoutKey.res);
    expect(statusOf(withoutKey.res).streamAnswers).toBe(true);

    const explicitOff = makeDeps({ settings: new FakeScope({ enabled: true, allowedUserId: 7, streamAnswers: false }) });
    await call(explicitOff.registration, "/api/telegram/status", {}, explicitOff.res);
    expect(statusOf(explicitOff.res).streamAnswers).toBe(false);
  });

  it("saves the stream setting without touching the other fields", async () => {
    const deps = makeDeps({ settings: new FakeScope({ enabled: true, allowedUserId: 7, streamAnswers: true }) });
    await call(deps.registration, "/api/telegram/save", { streamAnswers: false }, deps.res);
    expect(deps.scope.updates).toEqual([{ streamAnswers: false }]);
    expect(statusOf(deps.res).streamAnswers).toBe(false);
    expect(statusOf(deps.res).enabled).toBe(true);
    expect(statusOf(deps.res).allowedUserId).toBe(7);
  });

  it("rejects a non-boolean stream setting", async () => {
    const deps = makeDeps({ settings: new FakeScope({ enabled: true, allowedUserId: 7, streamAnswers: true }) });
    await call(deps.registration, "/api/telegram/save", { streamAnswers: "yes" }, deps.res);
    expect(deps.res.status).toBe(400);
    expect(errorCodeOf(deps.res)).toBe("invalid-stream-answers");
    expect(deps.scope.updates).toEqual([]);
  });
```

> Замечание исполнителю: имена хелперов `makeDeps`/`call`/`statusOf`/`errorCodeOf` возьми те, что уже используются в этом файле для соседних ручек (`telegram.status`/`telegram.save`); если хелпер называется иначе — используй существующий, форма проверок выше не меняется.

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/admin.test.ts -t "stream"`
Expected: FAIL — `streamAnswers` в статусе отсутствует / сохранение не пишет поле.

- [ ] **Step 4: Реализовать секцию, статус и сохранение**

1. `admin.ts`, `TelegramSettingsSection`:

```ts
export interface TelegramSettingsSection {
  enabled: boolean;
  /**
   * Потоковый ответ в чате. Ключ может отсутствовать (документ настроек старше
   * поля) — отсутствие означает «включено», как и дефолт настройки.
   */
  streamAnswers?: boolean;
  allowedUserId?: number | null;
}
```

2. `admin.ts`, `TelegramStatus` — поле рядом с `enabled`:

```ts
  /** Потоковый ответ в чате: всегда конкретное значение (отсутствующий ключ → true). */
  streamAnswers: boolean;
```

3. `admin.ts`, `buildTelegramStatus` — сразу после `const enabled = section.enabled === true;`:

```ts
  const streamAnswers = section.streamAnswers ?? true;
```

…и в литерал `status`:

```ts
  const status: TelegramStatus = { state: "error", tokenConfigured: configured, enabled, streamAnswers };
```

4. `admin.ts`, ручка `telegram.save` — рядом с разбором `enabled`:

```ts
      const streamAnswers = typeof input.streamAnswers === "boolean" ? input.streamAnswers : undefined;
      if (input.streamAnswers !== undefined && streamAnswers === undefined) {
        fail(res, 400, CODE_INVALID_STREAM_ANSWERS, "streamAnswers must be a boolean");
        return;
      }
```

…и в патч рядом с `enabled`:

```ts
      if (enabled !== undefined) patch.enabled = enabled;
      if (streamAnswers !== undefined) patch.streamAnswers = streamAnswers;
```

Константа рядом с `CODE_INVALID_USER_ID`:

```ts
/** `telegram.save` отказал: `streamAnswers` не boolean. */
const CODE_INVALID_STREAM_ANSWERS = "invalid-stream-answers";
```

5. `index.ts`, `TelegramConfigLike` и `Config`:

```ts
interface TelegramConfigLike {
  dshHome?: string;
  apiBase?: string;
  maxFileBytes?: number;
  enabled?: { get(): boolean };
  streamAnswers?: { get(): boolean };
  allowedUserId?: { get(): number | null | undefined };
}
```

```ts
  enabled: z.boolean().default(false).volatile(),
  // Потоковый ответ в чате: дефолт включён, переключается страницей «Telegram».
  streamAnswers: z.boolean().default(true).volatile(),
  allowedUserId: z.union([z.natural().min(1), z.const(null)]).default(null).volatile()
```

6. `index.ts`, `telegramSettingsSchema`:

```ts
export const telegramSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  streamAnswers: z.boolean().default(true),
  allowedUserId: z.union([z.natural().min(1), z.const(null)]).default(null)
});
```

7. `index.ts`, `createSettingsScope.read()`:

```ts
  const read = (): TelegramSettingsSection => ({
    enabled: configRefValue(config.enabled, false),
    streamAnswers: configRefValue(config.streamAnswers, true),
    allowedUserId: configRefValue(config.allowedUserId, null) ?? null
  });
```

8. `index.ts`, проводка в `ChatDeps` — в объект `createChatMachine({ ... })`, рядом с `maxFileBytes`:

```ts
    // Живой переключатель потока ответа: значение читается на старте задачи.
    streamAnswers: () => settingsScope.get().streamAnswers ?? true,
```

9. `index.ts`, `tests/index.test.ts` — добавить проверку проводки: с `settingsScope.get()` возвращающим `streamAnswers: false`, сообщение владельца не создаёт сообщения потока (тот же сценарий, что unit-тест «never creates a stream message», но через композицию плагина). Если в этом файле есть тест на дефолты `Config`, добавить туда же `streamAnswers: true`.

- [ ] **Step 5: Убедиться, что тесты и типы проходят**

Run: `pnpm --filter dsh-balbes-contracts exec vitest run && pnpm --filter dsh-balbes-contracts run typecheck`
Expected: PASS.

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/admin.test.ts tests/index.test.ts`
Expected: PASS.

Run: `pnpm --filter dsh-balbes-telegram run typecheck`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add packages/contracts packages/plugins/dsh-balbes-telegram/src/admin.ts packages/plugins/dsh-balbes-telegram/src/index.ts packages/plugins/dsh-balbes-telegram/tests/admin.test.ts packages/plugins/dsh-balbes-telegram/tests/index.test.ts
git commit -m "feat(telegram): expose the streamAnswers setting over the admin API (p11)"
```

---

### Task 6: переключатель «Потоковый ответ» в админке

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/pages/TelegramPage.tsx`
- Test: `packages/frontend/dsh-balbes-admin/tests/TelegramPage.test.tsx`

**Interfaces:**
- Consumes: `TelegramSettingsStatus.streamAnswers`, `TelegramSaveRequest.streamAnswers` (Task 5).
- Produces: пользовательскую поверхность настройки; код дальше не потребляет.

- [ ] **Step 1: Починить литералы статуса в тестах (компилятор укажет все)**

`packages/frontend/dsh-balbes-admin/tests/TelegramPage.test.tsx` — добавить `streamAnswers` в литералы `NOT_CONFIGURED`, `CONNECTED`, `DISABLED`, `FAILED` (например `streamAnswers: true` у `CONNECTED`, `false` у `DISABLED`), и в фейке `telegramSave` применять поле как остальные `save`-поля:

```ts
    if (req.streamAnswers !== undefined) state.streamAnswers = req.streamAnswers;
```

- [ ] **Step 2: Написать падающий UI-тест**

```tsx
  it("saves the answer-stream switch and restores it from the status", async () => {
    const api = makeApi({ ...CONNECTED, streamAnswers: true });
    render(<TelegramPage api={api} />);
    const toggle = await screen.findByTestId("telegram-stream-answers-input");
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("telegram-save"));

    await waitFor(() => expect(api.telegramSave).toHaveBeenCalled());
    expect(api.telegramSave.mock.calls.at(-1)![0].streamAnswers).toBe(false);
  });
```

Run: `pnpm --filter dsh-balbes-admin exec vitest run tests/TelegramPage.test.tsx -t "answer-stream"`
Expected: FAIL — `Unable to find an element by: [data-testid="telegram-stream-answers-input"]`.

- [ ] **Step 3: Реализовать переключатель**

`TelegramPage.tsx`:

1. Состояние рядом с `enabled`:

```ts
  const [streamAnswers, setStreamAnswers] = useState(true);
```

2. `refresh(syncForm=true)` — рядом с `setEnabled(res.status.enabled)`:

```ts
      setStreamAnswers(res.status.streamAnswers);
```

3. `buildSaveRequest()` — рядом с `enabled`:

```ts
    const req: TelegramSaveRequest = { enabled, streamAnswers };
```

4. Разметка — сразу после чекбокса «Включить бота»:

```tsx
            <label className="form-check">
              <input
                type="checkbox"
                data-testid="telegram-stream-answers-input"
                checked={streamAnswers}
                onChange={(e) => setStreamAnswers(e.target.checked)}
              />
              <span>Потоковый ответ</span>
            </label>
            <span className="form-hint">
              Показывать текст ответа модели по мере генерации в отдельном растущем сообщении. Выключено — ответ
              приходит одним финальным сообщением, как раньше.
            </span>
```

- [ ] **Step 4: Убедиться, что тесты и сборка проходят**

Run: `pnpm --filter dsh-balbes-admin exec vitest run tests/TelegramPage.test.tsx`
Expected: PASS — новый тест и весь прежний набор страницы.

Run: `pnpm --filter dsh-balbes-admin run build`
Expected: PASS (`tsc --noEmit && vite build`; SPA-артефакты пересобраны).

- [ ] **Step 5: Коммит**

```bash
git add packages/frontend/dsh-balbes-admin/src/pages/TelegramPage.tsx packages/frontend/dsh-balbes-admin/tests/TelegramPage.test.tsx
git commit -m "feat(admin): answer-stream switch on the Telegram page (p11)"
```

---

### Task 7: REAL-композиция — поток на реальном профиле

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/tests/helpers/stub-llm.mjs`
- Modify: `packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs` (синхронная копия)
- Test: `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts`

**Interfaces:**
- Consumes: `answerStream`/`agentTask`/`chat` (Tasks 2–4), `streamAnswers` (Task 5).
- Produces: доказательство, что agent-scoped слушатель реально получает `agent/assistant-stream` от движка, а служебный ход извлечения памяти в поток не попадает.

- [ ] **Step 1: Расширить стаб LLM дрипом дельт (обе копии)**

В `tests/helpers/stub-llm.mjs` добавить форму `entry.textChunks` (массив кусков) и `entry.chunkDelayMs` (пауза между кусками); `chunkedFrames(text, parts, delayMs, res)` пишет кадры по мере времени:

```js
/**
 * Text response, split into `parts` text deltas written one at a time:
 * `message_start` + `content_block_start` immediately, then every delta after
 * `delayMs`, then the closing frames. A REAL test uses this to observe a turn
 * while the model is genuinely mid-response (the channel's stream preview must
 * have something to grow between two ticks).
 */
function dripTextFrames(text, parts, delayMs, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  res.write(ssePayload(messageStart()));
  res.write(ssePayload({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  const pieces = [];
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, parts)));
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  let at = 0;
  const next = () => {
    if (at >= pieces.length) {
      res.write(ssePayload({ type: "content_block_stop", index: 0 }));
      res.write(ssePayload({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }));
      res.write(ssePayload({ type: "message_stop" }));
      res.end();
      return;
    }
    res.write(ssePayload({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: pieces[at] } }));
    at += 1;
    setTimeout(next, delayMs);
  };
  next();
}
```

…и в обработчике запроса — ветку до `res.end(framesFor(entry)...)`:

```js
        const entry = entries === null ? { text } : entries[cursor++ % entries.length];
        if (typeof entry.text === "string" && entry.textChunks !== undefined) {
          dripTextFrames(entry.text, entry.textChunks, entry.chunkDelayMs ?? 0, res);
          return;
        }
        res.end(framesFor(entry).map(ssePayload).join(""));
```

Скопировать файл в `packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs` (заголовок файла требует дословной синхронности копий).

- [ ] **Step 2: Написать падающий REAL-тест**

В `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts` — новый `it` после существующих сценариев (тот же `describe`, общий temp home; активный воркспейс выбирается тем же колбэком `ws:pick:0`, что и в сценарии 1 — «Дом агента»). Хелперы `requireApi`/`waitForOutbound`/`waitForMessage`/`sentTexts`/`sentMessageId` уже есть:

```ts
  it("streams the answer into its own growing message and finalizes it exactly", async () => {
    const server = requireApi();
    const from = server.outbound.length;
    // Выбор воркспейса — тот же колбэк, что в сценарии 1 (индекс 0 = дом агента).
    server.enqueueCallback({ fromId: OWNER_USER_ID, data: "ws:pick:0", messageId: 424_242 });
    await waitForMessage((text) => text.includes("Воркспейс: Дом агента"), "the workspace card", from, 60_000);

    // Ответ приходит тремя кусками с паузой: канал обязан успеть показать его
    // середину до финала (тик потока ~3.5 с, поэтому куски идут заметно чаще).
    const reply = "первый кусок второй кусок третий кусок";
    llm.setScript([{ text: reply, textChunks: 3, chunkDelayMs: 1200 }]);

    const taskFrom = server.outbound.length;
    server.enqueueMessage({ fromId: OWNER_USER_ID, text: "ответь тремя кусками" });

    // 1) Сообщение потока — отдельное от карточки и появляется ДО финала:
    //    его текст — префикс точного ответа, но ещё не весь ответ.
    const partial = await waitForMessage(
      (text) => text.length > 0 && reply.startsWith(text) && text !== reply,
      "the growing answer message",
      taskFrom,
      180_000
    );
    expect(partial.text).not.toContain("Готово");

    // 2) Финальный текст — ТОЧНЫЙ ответ, и он в ТОМ ЖЕ сообщении (первый чанк).
    const final = await waitForMessage((text) => text === reply, "the finalized answer", taskFrom, 180_000);
    expect(final.messageId).toBe(partial.messageId);
  });
```

- [ ] **Step 3: Убедиться, что REAL-тест падает без реализации**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-telegram exec vitest run tests/integration.test.ts -t "growing message"`
Expected (до Tasks 2–4 — на ветке без них): FAIL — сообщение потока не появляется. После Tasks 2–4 тест обязан проходить. Если он падает уже после них — значит agent-scoped слушатель не получает `agent/assistant-stream`; тогда разобраться через `systematic-debugging` (проверить диспетчеризацию шва), а не менять архитектуру молча.

- [ ] **Step 4: Добавить проверку, что служебный ход не течёт в поток**

В REAL-сценарии извлечения памяти (`extraction.real.test.ts`, там уже композируется p10g) — после квитанции задачи дождаться правок сообщения потока и убедиться, что после финального текста его сообщение больше не правится, хотя служебный ход идёт в той же сессии:

```ts
    const before = requireApi().outbound.length;
    await sleep(4000); // служебный ход извлечения памяти идёт в этой же сессии
    const late = requireApi()
      .outbound.slice(before)
      .filter((entry) => entry.method === "editMessageText" && sentMessageId(entry) === final.messageId);
    expect(late).toEqual([]);
```

- [ ] **Step 5: Прогнать REAL-набор**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-telegram exec vitest run tests/integration.test.ts tests/extraction.real.test.ts tests/agentTask.real.test.ts`
Expected: PASS (при `dsh` в `PATH`; без него наборы пропускаются — тогда явно сообщить об этом в отчёте, не выдавая за проверку).

- [ ] **Step 6: Коммит**

```bash
git add packages/plugins/dsh-balbes-telegram/tests/helpers/stub-llm.mjs packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs packages/plugins/dsh-balbes-telegram/tests/integration.test.ts
git commit -m "test(telegram): prove answer streaming over the real composition (p11)"
```

---

### Task 8: ранбук, закрытие канона и полная проверка

**Files:**
- Modify: `docs/runbooks/stage2-vps.md`

**Interfaces:**
- Consumes: всё предыдущее.
- Produces: инструкции владельцу для проверки на VPS; закрытие `canon-audit`.

- [ ] **Step 1: Обновить ранбук**

В `docs/runbooks/stage2-vps.md`, в раздел «Настройка Telegram через админку»:

1. В перечень формы добавить чекбокс: **«Потоковый ответ»** — текст ответа модели растёт в отдельном сообщении; выключение возвращает доставку одним финальным сообщением. Пустое/отсутствующее значение в документе настроек читается как включено.
2. Добавить пункт про поведение: карточка прогресса остаётся индикатором хода; сообщение потока появляется только когда модель начала писать текст; при остановке задачи фрагмент остаётся, исход показывает квитанция.

В раздел «Smoke без браузера (curl + JWT)» — блок про настройку (ожидаемый ответ содержит поле):

```bash
# потоковый ответ: включено по умолчанию
curl -sS -X POST http://127.0.0.1:8080/api/telegram/status \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).status.streamAnswers"
# ожидается: true

# выключить и убедиться, что сохранилось
curl -sS -X POST http://127.0.0.1:8080/api/telegram/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"streamAnswers":false}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).status.streamAnswers"
# ожидается: false

# не-boolean отклоняется целиком
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/telegram/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"streamAnswers":"yes"}'
# ожидается: 400 ({"error":{"code":"invalid-stream-answers",...}})

# вернуть включённое состояние
curl -sS -X POST http://127.0.0.1:8080/api/telegram/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"streamAnswers":true}' >/dev/null
```

И ручной блок «Поток ответа в чате» (действия владельца в Telegram, с ожидаемым результатом):

```markdown
1. Включите «Потоковый ответ» на странице «Telegram» и сохраните.
2. Отправьте боту задачу с заведомо длинным ответом, например:
   «Перечисли от 1 до 200 по одному числу в строке».
   Ожидается: сообщение-карточка с ходом задачи и рядом отдельное сообщение,
   текст которого растёт; карточка текста ответа не содержит.
3. Дождитесь финала: сообщение потока становится началом точного ответа,
   остаток приходит следующими сообщениями; карточка превращается в «✅ Готово».
4. Задача с ответом длиннее ~3500 символов: во время генерации видно хвост,
   в финале сообщение показывает начало ответа, весь текст доезжает целиком.
5. `/stop` посреди генерации: фрагмент остаётся в чате без пометки, карточка
   показывает «⏹ Остановлено», новых сообщений нет.
6. Выключите «Потоковый ответ» и повторите п. 2: растущего сообщения нет,
   ответ приходит одним финальным сообщением, как раньше.
```

- [ ] **Step 2: Полная проверка**

Run: `pnpm typecheck`
Expected: PASS по всем пакетам.

Run: `pnpm lint`
Expected: PASS.

Run: `pnpm test`
Expected: PASS. REAL-наборы без `RUN_REAL=1`/`dsh` пропускаются — отметить это в отчёте.

Run: `pnpm build`
Expected: PASS (включая SPA `dsh-balbes-admin` и `lib/` плагинов).

- [ ] **Step 3: Закрыть канон через `canon-audit`**

Вызвать скилл `canon-audit` по теме «поток ответа модели в Telegram»: сверить реализацию с обновлённым каноном (`ARCHITECTURE.md`, `API_CONTRACTS.md`, `ADMIN_UI.md`, `GLOSSARY.md`, `OVERVIEW.md`), зафиксировать расхождения в `docs/canon/DISCREPANCIES.md`, если они есть, и убедиться, что формулировки канона совпадают с кодом (имена полей, коды ошибок, константы 8 КиБ/3500, дефолт `true`).

- [ ] **Step 4: Коммит**

```bash
git add docs/runbooks/stage2-vps.md docs/canon/DISCREPANCIES.md
git commit -m "docs(runbook): verify the Telegram answer stream on the server (p11)"
```

- [ ] **Step 5: Передача владельцу**

Сообщить: изменения должны попасть на `origin/main` (пуш — только с явного разрешения владельца), затем на VPS:

```bash
cd /opt/dsh-balbes-server   # каталог установки
git pull --ff-only
scripts/install.sh
systemctl restart dsh-balbes   # если install.sh не перезапускает сам — см. его сводку
```

…и передать smoke-шаги из Step 1 с ожидаемыми результатами. Доступа к серверу у агента нет: интерпретировать вывод владельца по запросу.

---

## Self-Review

**1. Покрытие спеки:**

| Раздел спеки | Задача |
|---|---|
| §Архитектура → Точка съёма сигнала | Task 3 (Step 4, подписка в `setup`) + Task 7 (доказательство на реальном движке) |
| §Архитектура → Буфер живого ответа | Task 2 (+ инвариант `TaskProgress` — Global Constraints, Task 3) |
| §Архитектура → Окно хода | Task 3 (Steps 3–5) + Task 7 Step 4 |
| §Архитектура → Read-шов | Task 3 (Step 5) |
| §Жизненный цикл → Растущее сообщение | Task 4 (Step 3) |
| §Жизненный цикл → Финализация | Task 4 (Step 4, п. 2) |
| §Жизненный цикл → Отмена/ошибка/рестарт | Task 4 (Step 1 тесты + Step 4, п. 3) |
| §Поверхность → настройка | Task 5 (плагин/секция/ручки) + Task 6 (UI) |
| §Деградация и ошибки | Task 4 (счётчик неудач, фолбэк чанков, ленивое сообщение) |
| §Тестирование | Tasks 2–7 |
| §Канон | Task 1 + Task 8 (`canon-audit`) |
| §Обновление на сервере | Task 8 |
| §Отложено (админка/SSE, несколько сообщений, reasoning) | Task 1 (канон: граница и статус инициативы) |

**2. Скан плейсхолдеров:** незаполненных шагов нет; два «замечания исполнителю» уточняют имена существующих тестовых хелперов, которые надо взять из соседних тестов того же файла (сам код проверок приведён целиком).

**3. Согласованность типов и имён:** `LiveAnswer`/`AssistantFrameLike`/`createLiveAnswer`/`answerView`/`LIVE_ANSWER_LIMIT`/`ANSWER_VIEW_LIMIT` (Task 2) ↔ использование в Tasks 3–4; `LiveAnswerSnapshot` и `answer(ref)` (Task 3) ↔ `deps.runner.answer` в chat (Task 4) и в фейке `makeRunner` (Task 4); `streamIntervalMs`/`streamAnswers` (Task 4) ↔ проводка в `index.ts` (Tasks 4–5); `streamAnswers` в контрактах и `invalid-stream-answers` (Task 5) ↔ UI (Task 6) и ранбук (Task 8); `textChunks`/`chunkDelayMs` (Task 7) ↔ сценарий REAL-теста.

**Найденные при самопроверке правки (внесены):**

1. Тест «shows only the tail…» (Task 4) сравнивал финальный чанк самодельной арифметикой — заменено на явный `(head + tail).slice(0, 4096)` плюс проверку, что сообщение потока + остаток дают точный ответ без потерь.
2. Тест «grows a separate answer message» ожидал лишнее сообщение «третий»: короткий ответ целиком помещается в первое сообщение потока, поэтому новых сообщений быть не должно — ожидание исправлено на `["⏳ Дом агента · 0:00", "первый"]`.
3. Тест отказа финальной правки использовал `failEditPlan: [false, true, …]`, то есть отказывал не первой правке — исправлено на `[true]` (в окне теста это ровно финальный `editMessageText`).
4. Проверка отмены сравнивала число правок через тавтологию `editsBefore === 0 ? 0 : 0` — заменено на честный захват числа правок сообщения потока до остановки.
5. Порядок задач: проводка `streamAnswers` в `ChatDeps` (Task 4 → Task 5) перенесена в Task 5, где поле секции настроек уже существует, — иначе `index.ts` не типизируется на шаге Task 4. Заглушка `answer` в фейке `chat.test.ts` перенесена в Task 3, чтобы typecheck пакета оставался зелёным после каждой задачи.
6. REAL-тест (Task 7) приведён к реальным именам обвязки: `llm.setScript`, `server.enqueueMessage`, `server.enqueueCallback`, `sentMessageId`, выбор воркспейса колбэком `ws:pick:0`.
