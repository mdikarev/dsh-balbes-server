# Просмотр сессии в админке — дизайн

- Status: approved design
- Date: 2026-09-12
- Инициатива: `docs/canon/future_plans/p2-session-view.md`

## Цель

Владелец открывает сессию воркспейса прямо из админки и читает её диалог, не
покидая страницу «Проекты» и не переключаясь на другой канал. Витрина сессий
(p1) даёт обзор; этот шаг даёт чтение содержимого. Отправка сообщений и создание
сессий остаются отдельными шагами направления.

## Решения и границы

- **Открытие сессии — динамический таб в правой зоне.** Клик по строке в табе
  «Сессии» добавляет таб с названием сессии и «×»; внутри — диалог. Таб
  «Сессии» остаётся первым и незакрываемым. Открытых табов может быть сколько
  угодно; они не переживают перезагрузку, уход со страницы и смену воркспейса —
  состояние табов UI-локальное.
- **Источник данных — движок, а не реестр.** Реестр даёт принадлежность
  (какая сессия какому воркспейсу) и канал; заголовок, время и содержимое
  даёт `sessionQuery`. Движок — единственный источник фактов сессии.
- **Гибридный источник диалога.** Реплики строятся из append-origin событий лога
  (durable-транскрипт): замещения и компакция не стирают то, что владелец уже
  видел. Системный промпт и служебный контекст берутся только из текущей
  модельной поверхности (то, что реально уйдёт в следующий запрос). У каждой
  реплики есть флаг `inContext` — видно, что сейчас в контексте, а что вытеснено.
  Докблок движка (`dsh-session/surface`) прямо называет модельную поверхность
  неправильным источником для человеческого транскрипта, поэтому реплики берутся
  не из неё.
- **Нормализация — на сервере.** Плагин применяет каноническую поштучную проекцию
  движка `deriveEventMessage` и отдаёт стабильный DTO; контракт не повторяет типы
  движка, SPA только рендерит и сворачивает. Правила проекции не переписываются.
- **Показ сообщений:** реплики владельца и модели — основное; вызовы инструментов,
  результаты, системный промпт и служебный контекст — свёрнуты и разворачиваются
  по клику (владельцу важно видеть, что попадает в контекст).
- **Объём — вся история сразу.** Движок всё равно отдаёт полный лог одним
  чтением `readSession`; пагинация сэкономила бы только размер ответа и число
  DOM-строк и отложена.
- **Живого обновления нет.** Диалог читается при открытии таба и по общей кнопке
  «Обновить» (поднимает `reloadKey` активного таба).
- **Containment.** Ручка читает сессию, только если она зарегистрирована за
  запрошенным воркспейсом: иначе по чужому `sessionId` можно было бы читать любую
  сессию движка.
- Вне границ: отправка сообщений и стриминг; создание, переименование и удаление
  сессий; редактирование/удаление сообщений; поиск, экспорт и скачивание истории;
  специфика каналов (разметка Telegram и т.п.); reasoning-блоки; права и роли
  (сервер single-user); постраничная догрузка; живые push-события.

## Архитектура

### Плагин `dsh-balbes-sessions`

Пакет уже существует; добавляется ручка чтения и построение транскрипта.

- `src/transcript.ts` — чистый модуль без cordis: принимает `SessionLogSnapshot`
  и возвращает `TranscriptEntry[]`. Тестируется на синтетических событиях через
  реальные функции движка.
- `src/index.ts` — ручка `sessions.read`; структурный срез движка расширяется
  методом `readSession(sessionId)` (рядом с `readTitleSnapshots`).
- Импорты движка (не правки): `deriveEventMessage`, `isSurfaceEvent`,
  `isAppendSurfaceEvent`, `foldSurface` из `@deepseek-ai/dsh-session/surface`;
  `extractSessionEventText` и тип `SessionLogSnapshot` из
  `@deepseek-ai/dsh-session-query`; типы `SessionEvent`/`SessionHeader` из
  `@deepseek-ai/dsh-session`. Пакет подключается к тем же engine-зависимостям, что
  host-бандл и telegram-плагин.

### Построение транскрипта

1. `sessionQuery.readSession(sessionId)` → `{session, events}` полного лога
   (live-preferred, с replay-валидацией). Ошибка чтения → 404/500 по коду ручки.
2. `foldSurface(events).nodes` — seq'ы текущей модельной поверхности
   (`currentNodes`).
3. Идём по `events` по возрастанию `seq`; не-surface события (attempt, boundary,
   log-only) пропускаем. Для каждого поверхностного события:
   - `inContext = currentNodes.has(event.seq)`;
   - `message = deriveEventMessage(event)`; `null` (пустой assistant, живущий
     ради usage) — пропускаем;
   - `durable = isAppendSurfaceEvent(event)`;
   - **служебный контекст** (`message.source.kind === "plugin"`): берём только
     если `inContext` — устаревшие снапшоты контекста не показываем;
   - **не-служебные реплики** (владелец, модель, инструмент): берём, если
     `durable` или `inContext` — так в транскрипт попадают и заменяющие копии
     (сводка компакции), вытеснившие раннюю историю.
4. Классификация и разбор по `message.source` и `message.content`:
   - `source.kind === "tool"` → `tool-result`; `detail` — конкатенация блоков
     `text` из `tool-result.content` (fallback `extractSessionEventText(event)`);
     `isError` из блока;
   - assistant с блоками `tool-call` → по одной строке `tool-call` на блок;
     `toolName` — `block.name`, `detail` — `block.arguments` (сырой JSON-строкой);
   - `source.kind === "plugin"` → `context`; `form` — объявленный
     `source.form`, если есть; `text` пустой, а `detail` —
     `extractSessionEventText(event)` (полный служебный текст);
   - остальное → `message`; `text` — конкатенация блоков `text`.
   Текстовое событие может дать несколько строк (текст + вызовы инструментов);
   строки идут в порядке блоков. Текст реплики берётся из блоков `text`, а не из
   `extractSessionEventText`, чтобы аргументы инструментов не задваивались;
   `extractSessionEventText` остаётся для служебного контекста и как fallback
   результата инструмента. Блоки `reasoning` в v1 пропускаются.
5. `time` — `new Date(event.time).toISOString()`.

Ошибка `foldSurface` (нарушение surface-метаданных) → 500: чтение честно
отказывает, а не отдаёт искажённый диалог.

### `session` в ответе

Собирается из трёх источников без дублирования: `id` и `createdAt` — из
`readSession(...).session`, `title` — `sessionQuery.readTitle(sessionId)`,
`channel` — из записи реестра (та, по которой прошла containment-проверка).

## Контракты API

Типы — компиляторный SoT в `packages/contracts/src/index.ts`.

### `sessions.read` — диалог сессии

- method: POST
- path: /api/sessions/read
- auth: bearer
- request: `{scope: "home" | "project", name?: string, sessionId: string}`
  (`name` обязателен для `project`, запрещён для `home`; `sessionId` — непустая
  строка)
- response:

```json
{
  "session": { "id": "…", "title": "… | null", "channel": "telegram", "createdAt": "ISO" },
  "messages": [
    {
      "seq": 12,
      "time": "ISO",
      "role": "user",
      "kind": "message",
      "text": "…",
      "inContext": true
    },
    {
      "seq": 13,
      "time": "ISO",
      "role": "assistant",
      "kind": "tool-call",
      "text": "",
      "detail": "{\"path\":\"…\"}",
      "toolName": "read",
      "inContext": true
    }
  ]
}
```

- errors: 400 (`bad-request`: форма тела, scope, лишний `name`, пустой
  `sessionId`), 401, 404 (`not-found`: проект отсутствует; сессия не
  зарегистрирована за этим воркспейсом; движок не знает id), 500 (`internal`:
  лог нечитаем/битый, отказ движка, нарушение surface-метаданных)
- notes: containment — сначала `balbesWorkspaces.list()` (проект), затем запись
  реестра для этого воркспейса; только после этого чтение у движка. Диалог —
  гибрид durable append-origin и текущей модельной поверхности (см. «Построение
  транскрипта»); `inContext` показывает, входит ли событие в текущую поверхность.

```ts
export type TranscriptRole = "user" | "assistant" | "system";
export type TranscriptKind = "message" | "tool-call" | "tool-result" | "context";
export interface TranscriptEntry {
  seq: number;
  time: string; // ISO 8601
  role: TranscriptRole;
  kind: TranscriptKind;
  text: string; // видимое тело; "" для строк, у которых тело в detail
  detail?: string; // техническое тело свёрнутой строки
  toolName?: string; // kind === "tool-call"
  form?: string; // kind === "context": plugin ContextForm, когда объявлен
  isError?: boolean; // kind === "tool-result"
  inContext: boolean;
}
export interface SessionsReadRequest {
  scope: WorkspaceScope;
  name?: string;
  sessionId: string;
}
export interface SessionsReadResponse {
  session: WorkspaceSessionInfo;
  messages: TranscriptEntry[];
}
```

### Фронтенд

- `WorkspaceRightPane.tsx` — менеджер табов. Состояние: `active`,
  `reloadKey`, `sessionTabs: {id, title}[]`. id таба сессии —
  `session:<sessionId>`. `onOpenSession(s)`: существующий таб — активировать,
  иначе добавить и активировать; подпись — `s.title?.trim() || "Без заголовка"`,
  `title`-атрибут с `channel · время` для различения одноимённых.
  `onCloseSession(id)`: закрыть, активным сделать соседний слева, иначе
  «Сессии». Смена воркспейса (сравнение через `isSameRef`) сбрасывает табы сессий
  и активность на «Сессии». Лента табов — горизонтальная прокрутка, подписи
  обрезаются с ellipsis. Кнопка «Обновить» остаётся общей. «×» — отдельная кнопка
  с `aria-label`; кнопка не вкладывается в кнопку.
- `SessionsTab.tsx` — строки кликабельны: новые пропы
  `onOpenSession(session)` и `activeSessionId` (подсветка открытой). Строка —
  кнопка, чтобы работала клавиатура.
- `SessionTranscript.tsx` (новый) — пропы `api`, `workspace`, `session`,
  `reloadKey`. Загрузка при монтировании, смене сессии и `reloadKey` с приёмом
  «поколение + счётчик запроса» (как `SessionsTab`/`FileTree`). Состояния:
  «Загрузка…», ошибка + «Повторить», «Сессия без сообщений». Рендер: `message` —
  метка роли («Владелец» / «Модель» / «Система») и текст `pre-wrap`;
  `tool-call`/`tool-result`/`context` — `<details>`, свёрнуто по умолчанию, в
  `<summary>` одна строка («Вызов инструмента: <имя>», «Результат инструмента»,
  «Системный промпт» / «Контекст: <form>»), тело — `detail` в `<pre>`;
  `inContext: false` — приглушённая пометка «не в контексте». После загрузки —
  прокрутка к последнему сообщению.
- `src/format.ts` (новый) — общий форматтер времени; существующий
  `formatCreatedAt` выносится из `SessionsTab`, чтобы список и диалог не
  разошлись.
- `api/client.ts` — `readSession(scope, name, sessionId)` → POST
  `/api/sessions/read`; `AdminApi` расширяется.

## Канон (canon-first)

Правки живых секций — через `canon-write` до кода приложения:

- `API_CONTRACTS.md` — блок `sessions.read`; домен в Scope.
- `ARCHITECTURE.md` — домен `sessions.read` и правило источника транскрипта
  (durable append-origin + текущая поверхность для контекста, флаг `inContext`);
  containment по реестру; «просмотр диалога» убирается из списка «не входит
  (следующие этапы)», создание/удаление сессий остаются вне.
- `ADMIN_UI.md` — таб «Сессии»: строки кликабельны и открывают диалог,
  динамические табы с «×», сброс при смене воркспейса, внешний вид транскрипта
  (свёрнутые строки, пометка «не в контексте»); фраза «Клик по строке ничего не
  делает» заменяется.
- `GLOSSARY.md` — термины «диалог сессии (транскрипт)», «модельная поверхность»,
  «в контексте».
- `future_plans/p2-session-view.md` — `draft` → `implementing`, открытые
  вопросы закрываются (`canon-future-plan`), `INDEX.md` синхронизируется.

## Рунбук и установщик

- `scripts/install.sh` не меняется: пакет и его копирование в профиль уже есть,
  новых автозагрузок нет.
- `docs/runbooks/stage2-vps.md`, блок «Сессии воркспейса» (рядом с
  `sessions.list`): smoke для `sessions.read` — несуществующий/чужой
  `sessionId` → 404 `not-found`; существующая сессия → `messages` (JSON,
  HTTP 200). Правится в том же коммите, что код.

## Тесты и проверки

Плагин `dsh-balbes-sessions`:

1. `transcript.test.ts` (юнит, на реальных функциях движка): append-origin
   реплика попадает; вытесненная (не в текущей поверхности) реплика остаётся с
   `inContext: false`; устаревший контекст-снапшот не показывается; заменяющая
   копия (сводка компакции) попадает с `inContext: true`; `tool-call`
   разбирается на `toolName`/`detail`; `tool-result` с `isError`; пустой
   assistant (`deriveEventMessage → null`) пропускается; порядок по `seq`.
2. `integration.test.ts` (REAL-композиция через Loader): `sessions.read` —
   400 (форма/scope/лишний name/пустой id), 404 (проект), 404 (сессия не в
   воркспейсе), 404 (id неизвестен движку), 200 с заголовком и сообщениями,
   401.

Фронтенд:

3. `SessionTranscript.test.tsx`: загрузка, ошибка + повтор, пусто, текст
   реплики, `tool`/`context` свёрнуты в `<details>`, пометка «не в контексте»,
   смена сессии не применяет ответ прошлой.
4. `WorkspaceRightPane.test.tsx`: открытие добавляет таб и активирует; повторный
   клик не дублирует; закрытие активирует соседа; смена воркспейса сбрасывает
   табы.
5. `SessionsTab.test.tsx`: клик по строке зовёт `onOpenSession`; открытая
   строка подсвечена.
6. `client.test.ts`: `readSession` — метод, путь, тело.
7. существующие тесты: фейки `AdminApi` дополняются `readSession`.

Прогон: `pnpm typecheck`, `pnpm test`,
`RUN_REAL=1 pnpm --filter dsh-balbes-sessions test`, `pnpm build`.

## Риски

- Полный лог на очень длинной сессии — крупный JSON и много DOM-строк; окно
  догрузки отложено, но серверный DTO уже не мешает его добавить.
- `readSession` делает полную replay-валидацию; для single-user приемлемо.
- Открытый таб сессии, которую движок перестал знать, покажет состояние ошибки с
  «Повторить» (сессии из витрины не удаляются, но движок может не найти id).
- Обновление движка меняет состав событий; контракт стабилен, но классификация
  `kind` опирается на `source.kind`/`content`, поэтому при новых типах блоков
  неизвестные падают в `message`/пропускаются без падения.

## Отложено (не в этом шаге)

- Постраничная догрузка (курсор) и «показать раннее».
- Живое обновление открытого таба (push в SSE или опрос).
- Reasoning-блоки и картинки/файлы в диалоге.
- Создание/удаление сессий, чат, экспорт истории.
