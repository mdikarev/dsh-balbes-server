# Сессии воркспейса из Telegram — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец начинает новую сессию воркспейса из Telegram неразрушающим `/reset`, видит список сессий (`/sessions`), возвращается к любой из них штатным resume и убирает ненужные в архив.

**Architecture:** Реестр `workspace-sessions.json` остаётся append-only источником принадлежности; `telegram-state.json` хранит активную сессию (`sessions[воркспейс]`) и добавляет опциональный архив (`archived[воркспейс]`). Канал-специфичный срез `SessionsSlice` в `index.ts` соединяет реестр с `sessionQuery.readTitleSnapshots` и управляет выбором/архивом; чат рисует карточки `/sessions` и «Архив» и маршрутизирует callback-коды.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Cordis-плагины dsh, vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-telegram-sessions-design.md`

## Global Constraints

- dsh — зависимость, не форк: `@deepseek-ai/*` не редактируются; только штатные швы.
- `docs/canon/**` не редактируется вручную — только через `canon-write` / `canon-future-plan` / `canon-audit`.
- После существенных правок canon — **STOP и ждать явного go-ahead** владельца перед кодом.
- Функциональное изменение серверной поверхности правит `docs/runbooks/stage2-vps.md` **в том же коммите**.
- ESM only, относительные импорты внутри пакета — с расширением `.js`; strict TS, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.
- `telegram-state.json`: версия 1, новые поля только опциональные; тот же строгий `assertShape` на load и save; пустой `sessionId` недопустим.
- Реестр `workspace-sessions.json` не меняется; удаление из него не добавляется.
- Команды канала — не HTTP API; `/api/*` и `dsh-balbes-contracts` не меняются.
- UI-копия на русском; стиль текстов — существующий.
- Автотесты не ходят в модель (R-TEST-1); REAL-тесты за гейтом `RUN_REAL=1`.
- Каждая задача завершается зелёными `typecheck`/тестами и коммитом.

---

### Task 1: Canon-first — живые секции и статус инициативы

**Files:**
- Modify (через skill `canon-write`, не вручную): `docs/canon/OVERVIEW.md`, `docs/canon/ARCHITECTURE.md`, `docs/canon/GLOSSARY.md`
- Modify (через `canon-future-plan`): `docs/canon/future_plans/p5-telegram-sessions.md`, `docs/canon/future_plans/INDEX.md`

**Interfaces:**
- Consumes: spec `docs/superpowers/specs/2026-09-19-telegram-sessions-design.md`.
- Produces: живой SoT модели сессий канала, на который обязаны опираться задачи 2–9.

- [ ] **Step 1: Вызвать skill `canon-write`**

  - `OVERVIEW.md` — в пункте Telegram-канала заменить «persistent dsh-сессия на workspace» на «набор сессий воркспейса с активной: реестр — источник списка, `telegram-state.json` — активная и архив; `/reset` начинает новую сессию, прежние доступны через `/sessions`»; в перечень управляющих команд добавить `/sessions`.
  - `ARCHITECTURE.md` — жизненный цикл сессий канала: активная привязка и архив в `telegram-state.json`, список из реестра (канал `telegram`), `selectSession` отсоединяет текущий хэндл и включает lazy resume выбранной; ничего не удаляется.
  - `GLOSSARY.md` — термины «активная сессия воркспейса», «список сессий канала», «архив сессий канала».
  - `ADMIN_UI.md` и `API_CONTRACTS.md` — не меняются (управление остаётся вне админки; HTTP-поверхность та же).

- [ ] **Step 2: Вызвать skill `canon-future-plan`** для `p5-telegram-sessions.md`: status `draft` → `implementing`; закрыть открытые вопросы решением из spec (неразрушающий `/reset`; `/sessions`; архив в `telegram-state.json`; отказ при занятости; список только активного воркспейса); синхронизировать `INDEX.md`.

- [ ] **Step 3: Проверить canon**

Run: `doc-canon scout 'сессии воркспейса из Telegram /sessions архив'`
Expected: в выдаче — обновлённые `OVERVIEW.md`/`ARCHITECTURE.md`/`future_plans/p5-telegram-sessions.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/canon
git commit -m "docs(canon): define Telegram workspace session list and archive"
```

- [ ] **Step 5: STOP — go-ahead.** Сообщить владельцу, что canon обновлён, и ждать явного разрешения перед кодом (правило репозитория).

---

### Task 2: Состояние канала — поле `archived`

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/state.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/state.test.ts`

**Interfaces:**
- Produces: `TelegramStateData.archived?: Record<string, string[]>`; `TelegramState.load()/save()` валидируют и переносят архив; отсутствие поля = пустой архив.

- [ ] **Step 1: Падающий тест** (дописать в `describe` файла `state.test.ts`)

```ts
it("round-trips the archived map and normalizes empties", async () => {
  const file = join(dir, "telegram-state.json");
  const store = new TelegramState(file);
  await store.save({
    version: 1,
    sessions: { home: "session-a" },
    archived: { home: ["session-old"], "project:x": ["session-x", "session-old"] }
  });
  const loaded = await store.load();
  expect(loaded.archived).toEqual({ home: ["session-old"], "project:x": ["session-x", "session-old"] });
});

it("drops an empty archived list rather than persisting it", async () => {
  const file = join(dir, "telegram-state.json");
  const store = new TelegramState(file);
  await store.save({ version: 1, sessions: {}, archived: { home: [] } });
  const loaded = await store.load();
  expect(loaded.archived).toBeUndefined();
});

it("loads a v1 file without archived as an empty archive", async () => {
  const file = join(dir, "telegram-state.json");
  await writeFile(file, JSON.stringify({ version: 1, sessions: { home: "session-a" } }), { mode: 0o600 });
  const loaded = await new TelegramState(file).load();
  expect(loaded.archived).toBeUndefined();
  expect(loaded.sessions).toEqual({ home: "session-a" });
});

it("rejects a damaged archived map naming the file", async () => {
  const file = join(dir, "telegram-state.json");
  await writeFile(file, JSON.stringify({ version: 1, sessions: {}, archived: { home: [""] } }), { mode: 0o600 });
  await expect(new TelegramState(file).load()).rejects.toThrow(/telegram state file .*invalid archived session id/);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram test -- state`
Expected: FAIL — `archived` отбрасывается (первый/второй тесты).

- [ ] **Step 3: Минимальная реализация**

В `TelegramStateData` добавить поле после `sessions`:

```ts
  /** Workspace key -> archived session ids (hidden from the channel's active list). */
  archived?: Record<string, string[]>;
```

В `assertShape` расширить тип `record` полем `archived?: unknown` и добавить разбор после цикла по `sessions`:

```ts
  const archived: Record<string, string[]> = {};
  if (record.archived !== undefined) {
    if (!isPlainObject(record.archived)) throw invalid("has an invalid archived map");
    for (const [key, rawIds] of Object.entries(record.archived)) {
      if (key === "") throw invalid("has an empty archived workspace key");
      if (!Array.isArray(rawIds)) throw invalid(`has a non-array archived list for key ${key}`);
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const raw of rawIds) {
        if (typeof raw !== "string" || raw === "") {
          throw invalid(`has an invalid archived session id for key ${key}`);
        }
        if (seen.has(raw)) continue;
        seen.add(raw);
        ids.push(raw);
      }
      if (ids.length > 0) archived[key] = ids;
    }
  }
```

и перед `return data;`:

```ts
  if (Object.keys(archived).length > 0) data.archived = archived;
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-telegram test -- state`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/state.ts packages/plugins/dsh-balbes-telegram/tests/state.test.ts
git commit -m "feat(telegram): persist per-workspace session archive in channel state"
```

---

### Task 3: Команда `/sessions`

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/commands.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/commands.test.ts`

**Interfaces:**
- Produces: `CommandName` включает `"sessions"`; `parseCommand("/sessions") === "sessions"`; `TELEGRAM_COMMANDS` содержит строку с описанием.

- [ ] **Step 1: Падающий тест**

```ts
it("recognizes /sessions as a channel command", () => {
  expect(parseCommand("/sessions")).toBe("sessions");
  expect(TELEGRAM_COMMANDS.some((spec) => spec.command === "sessions")).toBe(true);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram test -- commands`
Expected: FAIL — `parseCommand("/sessions")` возвращает `"unknown"`.

- [ ] **Step 3: Реализация**

```ts
export type CommandName = "menu" | "status" | "ws" | "model" | "reset" | "sessions" | "stop" | "help";
```

В `TELEGRAM_COMMANDS` после `model` добавить:

```ts
  { command: "sessions", description: "Сессии воркспейса: список, возврат, архив" },
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-telegram test -- commands`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/commands.ts packages/plugins/dsh-balbes-telegram/tests/commands.test.ts
git commit -m "feat(telegram): add /sessions command"
```

---

### Task 4: Клавиатуры списка сессий и архива

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/keyboards.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/keyboards.test.ts`

**Interfaces:**
- Produces: `SessionRowButton`, `sessionsKeyboard({rows, page, pages})`, `archiveKeyboard({rows, page, pages})`. Callback-коды: `ses:<i>`, `arc:<i>`, `unarc:<i>`, `ses:arch`, `ses:back`, `ses:pg:<n>`.

- [ ] **Step 1: Падающий тест**

```ts
import { sessionsKeyboard, archiveKeyboard } from "../src/keyboards.js";

it("renders the active session list with an archive button per row", () => {
  const kb = sessionsKeyboard({
    rows: [{ index: 0, label: "Без заголовка", active: true }, { index: 1, label: "Вторая", active: false }],
    page: 0,
    pages: 1
  });
  expect(kb.inline_keyboard).toEqual([
    [{ text: "• Без заголовка", callback_data: "ses:0" }, { text: "🗄", callback_data: "arc:0" }],
    [{ text: "Вторая", callback_data: "ses:1" }, { text: "🗄", callback_data: "arc:1" }],
    [{ text: "🗄 Архив", callback_data: "ses:arch" }],
    [{ text: "⬅ Меню", callback_data: "mnu" }]
  ]);
});

it("renders archive rows with a restore button and a back row", () => {
  const kb = archiveKeyboard({ rows: [{ index: 0, label: "Старая", active: false }], page: 0, pages: 1 });
  expect(kb.inline_keyboard).toEqual([
    [{ text: "Старая", callback_data: "ses:0" }, { text: "↩", callback_data: "unarc:0" }],
    [{ text: "⬆ К сессиям", callback_data: "ses:back" }],
    [{ text: "⬅ Меню", callback_data: "mnu" }]
  ]);
});

it("adds pagination to both session lists", () => {
  const kb = sessionsKeyboard({ rows: [{ index: 0, label: "A", active: false }], page: 1, pages: 2 });
  expect(kb.inline_keyboard[1]).toEqual([
    { text: "◀", callback_data: "ses:pg:0" },
    { text: "▶", callback_data: "ses:pg:1" }
  ]);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram test -- keyboards`
Expected: FAIL — экспорты не найдены.

- [ ] **Step 3: Реализация** (добавить в `keyboards.ts`)

```ts
/** One session row: global index, display label and whether it is the active one. */
export interface SessionRowButton {
  index: number;
  label: string;
  active: boolean;
}

/** The active list: [title][archive] per row, pagination, archive and menu rows. */
export function sessionsKeyboard(opts: {
  rows: SessionRowButton[];
  page: number;
  pages: number;
}): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = opts.rows.map((row) => [
    { text: `${row.active ? "• " : ""}${row.label}`, callback_data: `ses:${row.index}` },
    { text: "🗄", callback_data: `arc:${row.index}` }
  ]);
  if (opts.pages > 1) rows.push(paginationRow("ses:pg", opts.page, opts.pages));
  rows.push([{ text: "🗄 Архив", callback_data: "ses:arch" }]);
  rows.push(menuRow());
  return { inline_keyboard: rows };
}

/** The archive list: [title][restore] per row, pagination, back and menu rows. */
export function archiveKeyboard(opts: {
  rows: SessionRowButton[];
  page: number;
  pages: number;
}): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = opts.rows.map((row) => [
    { text: row.label, callback_data: `ses:${row.index}` },
    { text: "↩", callback_data: `unarc:${row.index}` }
  ]);
  if (opts.pages > 1) rows.push(paginationRow("ses:pg", opts.page, opts.pages));
  rows.push([{ text: "⬆ К сессиям", callback_data: "ses:back" }]);
  rows.push(menuRow());
  return { inline_keyboard: rows };
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-telegram test -- keyboards`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/keyboards.ts packages/plugins/dsh-balbes-telegram/tests/keyboards.test.ts
git commit -m "feat(telegram): session list and archive keyboards"
```

---

### Task 5: Тексты — `/sessions` в справке и кнопка в меню

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/cards.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/cards.test.ts`

**Interfaces:**
- Produces: обновлённые `HELP_TEXT` и `menuCard` (кнопка `act:sessions`).

- [ ] **Step 1: Падающий тест**

```ts
it("advertises /sessions and the non-destructive /reset", () => {
  expect(HELP_TEXT).toContain("/sessions — сессии воркспейса");
  expect(HELP_TEXT).toContain("прежние остаются");
});

it("the active-workspace menu carries the sessions button", () => {
  const card = menuCard({ workspaceLabel: "Дом агента", taskLine: "нет активной задачи", queue: 0 });
  const data = card.keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  expect(data).toContain("act:sessions");
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram test -- cards`
Expected: FAIL.

- [ ] **Step 3: Реализация**

В `HELP_TEXT` заменить строку `/reset` и добавить `/sessions`:

```ts
export const HELP_TEXT = [
  "/menu — меню и состояние",
  "/status — воркспейс, модель, задача, очередь",
  "/ws — сменить воркспейс",
  "/model — сменить модель",
  "/reset — начать новую сессию (прежние остаются в /sessions)",
  "/sessions — сессии воркспейса: список, возврат, архив",
  "/stop — остановить задачу (контекст сохраняется)",
  "/help — эта справка.",
  "Прочий текст — задача агенту (нужен воркспейс; «Воркспейсы» — список)."
].join("\n");
```

В `menuCard`, в ветке с выбранным воркспейсом, заменить массив `rows` на:

```ts
    : [
        [
          { text: "📄 Файлы", callback_data: "act:files" },
          { text: "🧠 Модель", callback_data: "mdl" }
        ],
        [
          { text: "🗂 Сессии", callback_data: "act:sessions" },
          { text: "📁 Воркспейс", callback_data: "ws" }
        ],
        [
          { text: "🔄 Сбросить контекст", callback_data: "act:reset" },
          { text: "⏹ Стоп", callback_data: "stp" }
        ],
        REFRESH_ROW
      ];
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-telegram test -- cards`
Expected: PASS (обновить прочие ассерты меню, если они перечисляют кнопки).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/cards.ts packages/plugins/dsh-balbes-telegram/tests/cards.test.ts
git commit -m "feat(telegram): sessions help text and menu button"
```

---

### Task 6: Чат — снимок, карточки и callback-диспетчер сессий

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/chat.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/chat.test.ts`

**Interfaces:**
- Consumes: `sessionsKeyboard`, `archiveKeyboard`, `SessionRowButton` (Task 4); `CommandName "sessions"` (Task 3); `HELP_TEXT`/`menuCard` (Task 5).
- Produces: `ChannelSessionRow`, `SessionsSlice`, `ChatDeps.sessions?: SessionsSlice`; callback-коды `act:sessions`, `ses:arch`, `ses:back`, `ses:pg:<n>`, `ses:<i>`, `arc:<i>`, `unarc:<i>`.

- [ ] **Step 1: Падающий тест** (расширить `makeHarness` фейком и дописать `describe`)

```ts
function makeSessions(rows: ChannelSessionRow[] = []) {
  const calls: string[] = [];
  const service: SessionsSlice = {
    list: async () => rows.map((row) => ({ ...row })),
    select: async (_ref, id) => { calls.push(`select:${id}`); },
    archive: async (_ref, id) => { calls.push(`archive:${id}`); },
    unarchive: async (_ref, id) => { calls.push(`unarchive:${id}`); }
  };
  return { service, calls };
}

describe("chat machine: session list and archive", () => {
  const rows: ChannelSessionRow[] = [
    { id: "session-a", title: "Первая", createdAt: "2026-09-19T10:00:00.000Z", available: true, archived: false, active: true },
    { id: "session-b", title: null, createdAt: "2026-09-18T10:00:00.000Z", available: true, archived: false, active: false }
  ];

  it("act:sessions renders the list, marks the active session and shows titles", async () => {
    const sessions = makeSessions(rows);
    const h = makeHarness({ sessions });
    await h.machine.onMessage(message("/ws"));
    await h.machine.onCallback(callback("ws:pick:0", 600));
    await h.machine.onCallback(callback("act:sessions", 610));
    expect(h.bot.lastEdit().text).toContain("🗂 Сессии");
    expect(h.bot.buttons(h.bot.lastEdit().markup).map((b) => b.text)).toEqual([
      "• Первая", "🗄", "Без заголовка", "🗄", "🗄 Архив", "⬅ Меню"
    ]);
    expect(h.bot.data(h.bot.lastEdit().markup)).toContain("arc:1");
  });

  it("ses:<i> selects the session and confirms in the menu", async () => {
    const sessions = makeSessions(rows);
    const h = makeHarness({ sessions });
    await h.machine.onMessage(message("/ws"));
    await h.machine.onCallback(callback("ws:pick:0", 600));
    await h.machine.onCallback(callback("act:sessions", 610));
    await h.machine.onCallback(callback("ses:1", 610));
    expect(sessions.calls).toContain("select:session-b");
    expect(h.bot.lastEdit().text).toContain("Выбрана сессия");
  });

  it("refuses to select while the workspace task is running", async () => {
    const sessions = makeSessions(rows);
    const h = makeHarness({ sessions });
    await h.machine.onMessage(message("/ws"));
    await h.machine.onCallback(callback("ws:pick:0", 600));
    h.runner.service.progress = () => ({ phase: "running", steps: [], queued: 0 });
    await h.machine.onCallback(callback("act:sessions", 610));
    await h.machine.onCallback(callback("ses:1", 610));
    expect(sessions.calls).toEqual([]);
  });

  it("archives a session", async () => {
    const sessions = makeSessions(rows);
    const h = makeHarness({ sessions });
    await h.machine.onMessage(message("/ws"));
    await h.machine.onCallback(callback("ws:pick:0", 600));
    await h.machine.onCallback(callback("act:sessions", 610));
    await h.machine.onCallback(callback("arc:1", 610));
    expect(sessions.calls).toContain("archive:session-b");
  });

  it("answers the /sessions command as a new message", async () => {
    const sessions = makeSessions(rows);
    const h = makeHarness({ sessions });
    await h.machine.onMessage(message("/ws"));
    await h.machine.onCallback(callback("ws:pick:0", 600));
    await h.machine.onMessage(message("/sessions"));
    expect(h.bot.sent.at(-1)?.text).toContain("🗂 Сессии");
  });

  it("degrades when the sessions slice is missing", async () => {
    const h = makeHarness();
    await h.machine.onMessage(message("/ws"));
    await h.machine.onCallback(callback("ws:pick:0", 600));
    await h.machine.onCallback(callback("act:sessions", 610));
    expect(h.bot.lastEdit().text).toContain("Список сессий недоступен");
  });
});
```

> **Исправление (R6, внесено после Task 6).** Сетап ниже «onMessage(/ws) -> ws:pick:0 с фиксированным id 600» недействителен: у сообщения 600 нет снимка списка воркспейсов, и выбор отвечает STALE_ACTION, а не активирует воркспейс. Корректный поток: взять id сообщения, которым отрисован список (`h.bot.sent.at(-1)!.messageId`), и послать `ws:pick:0` на него; последующие callback-и (`act:sessions`, `ses:<i>`) адресовать id меню, отрисованного после выбора. Рабочая версия — в `tests/chat.test.ts` (хелпер `pickHome`). Правка R6 в ledger; код — источник истины.

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram test -- chat`
Expected: FAIL — типы/экспорты и обработчики отсутствуют.

- [ ] **Step 3: Реализация**

3a. Импорты из `keyboards.js` дополнить `archiveKeyboard`, `sessionsKeyboard`, `SessionRowButton`.

3b. Рядом с `WorkspaceFileResult` объявить:

```ts
/** One session of a workspace as the channel reports it. */
export interface ChannelSessionRow {
  id: string;
  title: string | null;
  createdAt: string | null;
  available: boolean;
  archived: boolean;
  active: boolean;
}

/** The channel's session catalog and mutations (wired in index.ts). */
export interface SessionsSlice {
  list(ref: WorkspaceRef): Promise<ChannelSessionRow[]>;
  select(ref: WorkspaceRef, sessionId: string): Promise<void>;
  archive(ref: WorkspaceRef, sessionId: string): Promise<void>;
  unarchive(ref: WorkspaceRef, sessionId: string): Promise<void>;
}
```

3c. В `ChatDeps` добавить:

```ts
  /** The channel's session catalog; absent when the sessions registry is not composed. */
  sessions?: SessionsSlice;
```

3d. Добавить снимок рядом с `WorkspacesSnapshot`:

```ts
/** One rendered session list: the whole catalog, keyed by the message showing it. */
interface SessionListSnapshot {
  kind: "sessionList";
  chatId: number;
  ref: WorkspaceRef;
  mode: "active" | "archive";
  rows: ChannelSessionRow[];
  page: number;
}
```

3e. Добавить константы рядом с `LIST_FAILED`:

```ts
const SESSIONS_TITLE = "Выберите сессию:";
const ARCHIVE_TITLE = "Выберите сессию из архива:";
const SESSIONS_NONE = "Сессий пока нет";
const SESSIONS_NONE_ACTIVE = "Активных сессий нет";
const ARCHIVE_EMPTY = "Архив пуст";
const SESSIONS_FAILED = "Не удалось получить список сессий. Попробуйте позже.";
const SESSIONS_UNAVAILABLE = "Список сессий недоступен";
const SESSION_UNAVAILABLE = "Сессия недоступна";
const SESSION_BUSY = "Задача выполняется — дождитесь завершения или /stop";
```

3f. Рядом с `buildWorkspaceView` добавить построитель и рендеры:

```ts
function sessionLabel(row: ChannelSessionRow): string {
  const title = row.title !== null && row.title.trim() !== "" ? row.title : "Без заголовка";
  return row.available ? title : `${title} (недоступна)`;
}

/** One page of the session list (active or archive), or undefined on failure. */
async function buildSessionsView(chatId: number, ref: WorkspaceRef, mode: "active" | "archive", page: number): Promise<
  | { text: string; keyboard: InlineKeyboardMarkup; snapshot: SessionListSnapshot }
  | undefined
> {
  if (deps.sessions === undefined) return undefined;
  let all: ChannelSessionRow[];
  try {
    all = await deps.sessions.list(ref);
  } catch (error) {
    warn(`session list failed (${codeOf(error)})`);
    return undefined;
  }
  const rows = all.filter((row) => (mode === "archive" ? row.archived : !row.archived));
  const pages = Math.max(1, Math.ceil(rows.length / listPageSize));
  const current = clampPage(page, pages);
  const start = current * listPageSize;
  const buttons: SessionRowButton[] = rows.slice(start, start + listPageSize).map((row, offset) => ({
    index: start + offset,
    label: sessionLabel(row),
    active: row.active
  }));
  const header = mode === "archive" ? `🗄 Архив сессий · ${refLabel(ref)}` : `🗂 Сессии · ${refLabel(ref)}`;
  const empty = mode === "archive" ? ARCHIVE_EMPTY : all.some((row) => row.archived) ? SESSIONS_NONE_ACTIVE : SESSIONS_NONE;
  const text =
    rows.length === 0
      ? empty
      : withPageLine(`${header}\n${mode === "archive" ? ARCHIVE_TITLE : SESSIONS_TITLE}`, current, pages);
  const keyboard =
    mode === "archive"
      ? archiveKeyboard({ rows: buttons, page: current, pages })
      : sessionsKeyboard({ rows: buttons, page: current, pages });
  return { text, keyboard, snapshot: { kind: "sessionList", chatId, ref: copyRef(ref)!, mode, rows, page: current } };
}

/** Render one session page into a known message. */
async function renderSessions(chatId: number, messageId: number, ref: WorkspaceRef, mode: "active" | "archive", page: number): Promise<void> {
  const view = await buildSessionsView(chatId, ref, mode, page);
  if (view === undefined) {
    await editWithMenu(chatId, messageId, deps.sessions === undefined ? SESSIONS_UNAVAILABLE : SESSIONS_FAILED);
    return;
  }
  putSnapshot(messageId, view.snapshot);
  await edit(chatId, messageId, view.text, view.keyboard);
}

/** Send one session page as a new message (the /sessions command path). */
async function sendSessions(chatId: number, ref: WorkspaceRef, mode: "active" | "archive", page: number): Promise<void> {
  const view = await buildSessionsView(chatId, ref, mode, page);
  if (view === undefined) {
    await sendMenu(chatId, deps.sessions === undefined ? SESSIONS_UNAVAILABLE : SESSIONS_FAILED);
    return;
  }
  const sentId = await send(chatId, view.text, view.keyboard);
  if (sentId !== undefined) putSnapshot(sentId, view.snapshot);
}
```

3g. В `dispatchCallback` после ветки `act:reset` добавить (порядок веток сохранить):

```ts
    if (data === "act:sessions") {
      const ref = active;
      if (ref === undefined) {
        await answerNoActive(chatId, messageId);
        return undefined;
      }
      await renderSessions(chatId, messageId, ref, "active", 0);
      return undefined;
    }
    if (data === "ses:arch" || data === "ses:back") {
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined || snapshot.kind !== "sessionList") return STALE_ACTION;
      await renderSessions(chatId, messageId, snapshot.ref, data === "ses:arch" ? "archive" : "active", 0);
      return undefined;
    }
    if (data.startsWith("ses:pg:")) {
      const page = parseIndex(data.slice("ses:pg:".length));
      const snapshot = snapshotOf(chatId, messageId);
      if (page === undefined || snapshot === undefined || snapshot.kind !== "sessionList") return STALE_ACTION;
      await renderSessions(chatId, messageId, snapshot.ref, snapshot.mode, page);
      return undefined;
    }
    if (data.startsWith("ses:")) {
      const index = parseIndex(data.slice("ses:".length));
      const snapshot = snapshotOf(chatId, messageId);
      if (index === undefined || snapshot === undefined || snapshot.kind !== "sessionList") return STALE_ACTION;
      const row = snapshot.rows[index];
      if (row === undefined) return STALE_ACTION;
      if (!row.available) return SESSION_UNAVAILABLE;
      const progress = deps.runner.progress(snapshot.ref);
      if (progress.phase !== "idle" || progress.queued > 0) return SESSION_BUSY;
      try {
        if (snapshot.mode === "archive") await deps.sessions!.unarchive(snapshot.ref, row.id);
        await deps.sessions!.select(snapshot.ref, row.id);
      } catch (error) {
        warn(`selecting a session failed (${codeOf(error)})`);
        return SESSIONS_FAILED;
      }
      if (active !== undefined && workspaceRefKey(active) === workspaceRefKey(snapshot.ref)) {
        await editWithMenu(chatId, messageId, `Выбрана сессия: ${sessionLabel(row)}`);
      }
      return undefined;
    }
    if (data.startsWith("arc:")) {
      const index = parseIndex(data.slice("arc:".length));
      const snapshot = snapshotOf(chatId, messageId);
      if (index === undefined || snapshot === undefined || snapshot.kind !== "sessionList") return STALE_ACTION;
      const row = snapshot.rows[index];
      if (row === undefined) return STALE_ACTION;
      if (row.active) {
        const progress = deps.runner.progress(snapshot.ref);
        if (progress.phase !== "idle" || progress.queued > 0) return SESSION_BUSY;
      }
      try {
        await deps.sessions!.archive(snapshot.ref, row.id);
      } catch (error) {
        warn(`archiving a session failed (${codeOf(error)})`);
        return SESSIONS_FAILED;
      }
      await renderSessions(chatId, messageId, snapshot.ref, "active", snapshot.page);
      return undefined;
    }
    if (data.startsWith("unarc:")) {
      const index = parseIndex(data.slice("unarc:".length));
      const snapshot = snapshotOf(chatId, messageId);
      if (index === undefined || snapshot === undefined || snapshot.kind !== "sessionList") return STALE_ACTION;
      const row = snapshot.rows[index];
      if (row === undefined) return STALE_ACTION;
      try {
        await deps.sessions!.unarchive(snapshot.ref, row.id);
      } catch (error) {
        warn(`unarchiving a session failed (${codeOf(error)})`);
        return SESSIONS_FAILED;
      }
      await renderSessions(chatId, messageId, snapshot.ref, "archive", snapshot.page);
      return undefined;
    }
```

> Порядок важен: `ses:arch`/`ses:back`/`ses:pg:` проверяются раньше общего `ses:`, иначе `parseIndex("arch")` вернёт STALE_ACTION.

3h. В `onMessage` роутере после `command === "model"`:

```ts
        if (command === "sessions") {
          const ref = active;
          if (ref === undefined) {
            await sendMenu(update.chatId, NO_ACTIVE_HINT);
            return;
          }
          await sendSessions(update.chatId, ref, "active", 0);
          return;
        }
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-telegram test -- chat`
Expected: PASS. Обновить устаревшие ассерты меню (новая кнопка «🗂 Сессии»).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/chat.ts packages/plugins/dsh-balbes-telegram/tests/chat.test.ts
git commit -m "feat(telegram): session list and archive cards in the chat"
```

---

### Task 7: Обвязка — каталог, выбор и архив

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/index.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/index.test.ts`

**Interfaces:**
- Consumes: `TelegramStateData.archived` (Task 2); `ChannelSessionRow`, `SessionsSlice` (Task 6).
- Produces: `channelSessions: SessionsSlice`; `live.archived`; `selectSession`; `sessionIdOf` возвращает выбранную до первого turn'а; `persist()` пишет архив.

- [ ] **Step 1: Падающий тест** (дописать в `index.test.ts` по образцу соседних тестов пакета)

```ts
it("selects a stored session and persists the active id", async () => {
  const harness = await bootTelegram({ state: { version: 1, sessions: { home: "session-a" } } });
  await harness.channelSessions.select({ scope: "home" }, "session-b");
  expect(await readState(harness.dshHome)).toMatchObject({ sessions: { home: "session-b" } });
});

it("archives the active session: clears the active id and records the archive", async () => {
  const harness = await bootTelegram({ state: { version: 1, sessions: { home: "session-a" } } });
  await harness.channelSessions.archive({ scope: "home" }, "session-a");
  expect(await readState(harness.dshHome)).toMatchObject({ archived: { home: ["session-a"] } });
  expect((await readState(harness.dshHome)).sessions.home).toBeUndefined();
});

it("unarchives without touching the active id", async () => {
  const harness = await bootTelegram({ state: { version: 1, sessions: { home: "session-a" }, archived: { home: ["session-old"] } } });
  await harness.channelSessions.unarchive({ scope: "home" }, "session-old");
  const state = await readState(harness.dshHome);
  expect(state.sessions).toEqual({ home: "session-a" });
  expect(state.archived).toBeUndefined();
});
```

> `bootTelegram`/`readState`/`harness.channelSessions` — переиспользовать существующую фабрику композиции пакета; `channelSessions` доступен только тесту через возвращаемую обвязку (при необходимости добавить его в возвращаемый объект фабрики в тестовом хелпере).

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram test -- index`
Expected: FAIL — нет `channelSessions`.

- [ ] **Step 3: Реализация**

3a. Расширить структурный срез реестра и добавить срез движка:

```ts
interface SessionsRegistryLike {
  register(ref: WorkspaceRef, sessionId: string, channel: string): Promise<void>;
  list(ref: WorkspaceRef): Promise<Array<{ sessionId: string; channel: string }>>;
}

interface TitleObservationLike {
  sessionId: string;
  status: "fulfilled" | "rejected";
  value?: { session: { createdAt: number }; title?: { title: string } };
}

interface SessionQueryLike {
  readTitleSnapshots(ids: readonly string[]): Promise<TitleObservationLike[]>;
}
```

3b. Рядом с `sessionsRegistry` получить `sessionQuery`:

```ts
  const sessionQuery = ctx.get("sessionQuery") as SessionQueryLike | undefined;
```

3c. В `persist()` добавить поле архива:

```ts
    ...(live.archived !== undefined && Object.keys(live.archived).length > 0 ? { archived: live.archived } : {}),
```

3d. Отвязать раннер от IIFE. Заменить блок
`const runnerWithSessions: AgentTaskRunner = (() => { const runner = createAgentTaskRunner({...}); return {...}; })();`
на прямые определения:

```ts
  const runner = createAgentTaskRunner({
    workspaces: workspaces as unknown as AgentTaskDeps["workspaces"],
    agents: ctx.get("agents") as AgentTaskDeps["agents"],
    sessions: ctx.get("sessions") as AgentTaskDeps["sessions"],
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(loader !== undefined ? { loader } : {}),
    logger: ctx.logger
  });

  /** Detach the live handle and make sessionId the workspace's active session. */
  async function selectSession(ref: WorkspaceRef, sessionId: string): Promise<void> {
    await runner.reset(ref);
    live.sessions[workspaceRefKey(ref)] = sessionId;
    persist();
  }

  /** Hide a session from the active list; archiving the active one also detaches it. */
  async function archiveSession(ref: WorkspaceRef, sessionId: string): Promise<void> {
    const key = workspaceRefKey(ref);
    const current = live.archived?.[key] ?? [];
    if (!current.includes(sessionId)) {
      live.archived = { ...(live.archived ?? {}), [key]: [...current, sessionId] };
    }
    if (live.sessions[key] === sessionId) {
      await runner.reset(ref);
      delete live.sessions[key];
    }
    persist();
  }

  /** Return a session to the active list; the active id is untouched. */
  async function unarchiveSession(ref: WorkspaceRef, sessionId: string): Promise<void> {
    const key = workspaceRefKey(ref);
    const current = live.archived?.[key];
    if (current === undefined) return;
    const next = current.filter((id) => id !== sessionId);
    const archived = { ...(live.archived ?? {}) };
    if (next.length === 0) delete archived[key];
    else archived[key] = next;
    live.archived = archived;
    persist();
  }

  /** The channel's session catalog: registry (telegram) joined with engine titles. */
  async function listChannelSessions(ref: WorkspaceRef): Promise<ChannelSessionRow[]> {
    const key = workspaceRefKey(ref);
    const entries = sessionsRegistry === undefined ? [] : await sessionsRegistry.list(ref);
    const telegram = entries.filter((entry) => entry.channel === "telegram");
    const archived = new Set(live.archived?.[key] ?? []);
    const activeId = live.sessions[key];
    const rows: ChannelSessionRow[] = [];
    if (sessionQuery !== undefined && telegram.length > 0) {
      let observations: TitleObservationLike[] = [];
      try {
        observations = await sessionQuery.readTitleSnapshots(telegram.map((entry) => entry.sessionId));
      } catch (error) {
        ctx.logger.warn(`balbes-telegram: reading session titles failed: ${reasonOf(error)}`);
      }
      const byId = new Map(observations.map((observation) => [observation.sessionId, observation]));
      for (const entry of telegram) {
        const observation = byId.get(entry.sessionId);
        const fulfilled = observation?.status === "fulfilled";
        rows.push({
          id: entry.sessionId,
          title: fulfilled ? observation?.value?.title?.title ?? null : null,
          createdAt: fulfilled ? new Date(observation!.value!.session.createdAt).toISOString() : null,
          available: fulfilled,
          archived: archived.has(entry.sessionId),
          active: entry.sessionId === activeId
        });
      }
      rows.sort((a, b) => (a.createdAt === null || b.createdAt === null ? 0 : a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    } else {
      for (const entry of telegram) {
        rows.push({
          id: entry.sessionId,
          title: null,
          createdAt: null,
          available: true,
          archived: archived.has(entry.sessionId),
          active: entry.sessionId === activeId
        });
      }
      rows.reverse();
    }
    return rows;
  }

  const runnerWithSessions: AgentTaskRunner = {
    run(ref, text, opts) {
      // ... существующее тело run (lazy resume + persist + register), без изменений ...
    },
    async reset(ref) {
      await runner.reset(ref);
      const key = workspaceRefKey(ref);
      if (key in live.sessions) {
        delete live.sessions[key];
        persist();
      }
    },
    cancel: (ref) => runner.cancel(ref),
    progress: (ref) => runner.progress(ref),
    sessionIdOf: (ref) => runner.sessionIdOf(ref) ?? live.sessions[workspaceRefKey(ref)],
    snapshot: () => runner.snapshot()
  };

  const channelSessions: SessionsSlice = {
    list: listChannelSessions,
    select: selectSession,
    archive: archiveSession,
    unarchive: unarchiveSession
  };
```

> Тело `run` переносится из IIFE дословно; `reset` теперь обращается к `runner` напрямую.

3e. В `createChatMachine({...})` пробросить срез, когда реестр скомпонован:

```ts
    ...(sessionsRegistry !== undefined ? { sessions: channelSessions } : {}),
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-telegram test -- index`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/index.ts packages/plugins/dsh-balbes-telegram/tests/index.test.ts
git commit -m "feat(telegram): wire session catalog, selection and archive"
```

---

### Task 8: REAL-композиция — выбор и архив переживают рестарт

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts`

**Interfaces:**
- Consumes: `channelSessions` (Task 7), `telegram-state.json` (Task 2).
- Produces: REAL-тест через Loader, подтверждающий персистентность выбора и архива.

- [ ] **Step 1: Падающий тест** (добавить сценарий в REAL-тест под `RUN_REAL`)

```ts
it("persists the active session choice and the archive across a restart", async () => {
  const first = await composeTelegram();
  await first.sessions.register({ scope: "home" }, "session-a", "telegram");
  await first.sessions.register({ scope: "home" }, "session-b", "telegram");
  await first.channelSessions.select({ scope: "home" }, "session-b");
  await first.channelSessions.archive({ scope: "home" }, "session-a");
  await first.dispose();

  const second = await composeTelegram();
  const rows = await second.channelSessions.list({ scope: "home" });
  expect(rows.find((row) => row.id === "session-b")?.active).toBe(true);
  expect(rows.find((row) => row.id === "session-a")?.archived).toBe(true);
  await second.dispose();
});
```

> `composeTelegram` и доступ к сервисам — по образцу существующего REAL-теста пакета; переиспользовать его хелперы, не дублировать boot.

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-telegram test -- integration`
Expected: FAIL — нет `channelSessions`/персистентности.

- [ ] **Step 3: Реализация** — уже сделана в задачах 2 и 7; если тест падает, исправить обвязку, а не тест: `persist()` пишет `archived`, `listChannelSessions` читает `live.archived`, повторный boot восстанавливает `live` из файла.

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-telegram test -- integration`
Expected: PASS (нужен `dsh` на PATH).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-telegram/tests/integration.test.ts
git commit -m "test(telegram): REAL coverage for session selection and archive persistence"
```

---

### Task 9: Рунбук, полная проверка и закрытие canon

**Files:**
- Modify: `docs/runbooks/stage2-vps.md`
- Modify (через `canon-future-plan`): `docs/canon/future_plans/p5-telegram-sessions.md`, `docs/canon/future_plans/INDEX.md`
- Modify (через `canon-audit`): `docs/canon/DISCREPANCIES.md` (если расхождения найдены)

**Interfaces:**
- Consumes: всё выше.
- Produces: актуальный runbook, статус инициативы `absorbed`, закрытый canon-audit.

- [ ] **Step 1: Обновить runbook**

  - Шаг 7 «Настройка Telegram через админку»: в перечень команд добавить `/sessions`.
  - Шаг 8: текст про **«🔄 Сбросить контекст»** — «начинает новую сессию; прежняя остаётся и доступна через /sessions»; описать `/sessions` и архив.
  - Раздел «Чеклист проверки Telegram (после обновления)»: smoke — две задачи, `/reset`, следующая задача, `/sessions` показывает прежнюю и активную; `🗄` прячет, `↩` возвращает.

- [ ] **Step 2: Полный прогон**

```bash
pnpm typecheck
pnpm lint
pnpm test
RUN_REAL=1 pnpm --filter dsh-balbes-telegram test
pnpm build
```

Expected: все команды exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/stage2-vps.md
git commit -m "docs(runbook): document /sessions, non-destructive reset and archive"
```

- [ ] **Step 4: Закрыть инициативу** — skill `canon-future-plan`: `p5-telegram-sessions.md` status `implementing` → `absorbed`, `INDEX.md` синхронизировать.

- [ ] **Step 5: Аудит canon** — skill `canon-audit` по теме «сессии воркспейса из Telegram»; устранить расхождения код↔canon или зафиксировать в `DISCREPANCIES.md`.

- [ ] **Step 6: Commit**

```bash
git add docs/canon
git commit -m "docs(canon): absorb Telegram workspace sessions initiative"
```

---

## Self-Review

**1. Покрытие spec:**
- Неразрушающий `/reset` → Task 1 (canon), Task 6 (обработчик команды остаётся существующим, HELP), Task 9 (runbook). ✅
- `/sessions` список/возврат → Task 3, 4, 5, 6. ✅
- Архив + возврат → Task 2 (state), 4 (клавиатуры), 6 (диспетчер), 7 (обвязка). ✅
- Реестр как источник принадлежности, без изменений → Task 7 (фильтр `telegram`), не трогается. ✅
- Активная привязка + merge `sessionIdOf` → Task 7. ✅
- Заголовок/время/доступность из `sessionQuery` → Task 7. ✅
- Busy-отказ → Task 6. ✅
- Контеймент по активному воркспейсу → Task 6 (снимок хранит `ref`). ✅
- Тесты unit + REAL → Tasks 2–8. ✅
- Канон и runbook → Task 1, 9. ✅
- Техпроверки spec → Task 8 (resume после reset, персистентность) + ручная проверка на сервере перед приёмкой.

**2. Placeholder scan:** незаполненных TBD/TODO нет. Два места ссылаются на существующие тестовые хелперы («по образцу соседних тестов») — это требование переиспользовать фабрику пакета, а не пропуск кода.

**3. Type consistency:** `ChannelSessionRow`/`SessionsSlice` определены в Task 6 и используются в Task 7/8; `SessionRowButton`/`sessionsKeyboard`/`archiveKeyboard` — Task 4, используются Task 6; callback-коды совпадают во всех задачах (`act:sessions`, `ses:arch`, `ses:back`, `ses:pg:`, `ses:`, `arc:`, `unarc:`); поле `archived` — Task 2, используется Task 7; merge `sessionIdOf` — Task 7, читается меню Task 6.
