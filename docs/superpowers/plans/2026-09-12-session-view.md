# Просмотр сессии в админке — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец открывает сессию воркспейса из таба «Сессии» и читает её диалог в отдельном табе правой зоны, не покидая страницу «Проекты».

**Architecture:** Серверная ручка `sessions.read` в существующем плагине `dsh-balbes-sessions` читает полный лог сессии у движка (`sessionQuery.readSession`) и строит гибридный транскрипт: реплики — из append-origin событий (durable), системный промпт/контекст — только из текущей модельной поверхности; каноническая проекция — `deriveEventMessage` из `@deepseek-ai/dsh-session`. Фронтенд добавляет динамические табы сессий в `WorkspaceRightPane`, новый `SessionTranscript` и кликабельные строки в `SessionsTab`.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Cordis-плагины dsh, vitest, React + Vite + @testing-library/react, dsh 0.1.5-rc.2 (`@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session-query`).

**Spec:** `docs/superpowers/specs/2026-09-12-session-view-design.md`

## Global Constraints

- dsh — зависимость, не форк: `@deepseek-ai/*` не редактируются; только импорт штатных швов.
- `docs/canon/**` не редактируется вручную — только через `canon-write` / `canon-future-plan`.
- Функциональное изменение серверной поверхности правит `docs/runbooks/stage2-vps.md` **в том же коммите**.
- ESM only, относительные импорты внутри пакета — с расширением `.js`; strict TS, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.
- Тесты — vitest; REAL-тесты за гейтом `RUN_REAL=1` и `dsh` в PATH; автотесты не ходят в модель (LLM-граница — local stub).
- UI-копия на русском, прямо в компонентах; стиль — существующие токены `styles.css`.
- R-API-1: все `/api/*` — POST, ошибки `{error:{code,message}}`; контракты-типы — компиляторный SoT в `dsh-balbes-contracts`.
- Каждая задача завершается зелёными `typecheck`/тестами и коммитом.

---

### Task 1: Canon-first — обновить живые секции и статус инициативы

**Files:**
- Modify (через skill `canon-write`, не вручную): `docs/canon/API_CONTRACTS.md`, `docs/canon/ARCHITECTURE.md`, `docs/canon/ADMIN_UI.md`, `docs/canon/GLOSSARY.md`
- Modify (через `canon-future-plan`): `docs/canon/future_plans/p2-session-view.md`, `docs/canon/future_plans/INDEX.md`

**Interfaces:**
- Consumes: spec `docs/superpowers/specs/2026-09-12-session-view-design.md`.
- Produces: живой SoT контракта `sessions.read` и правила транскрипта, на который обязаны опираться задачи 2–11.

- [ ] **Step 1: Вызвать skill `canon-write`** с задачей: добавить блок `sessions.read` в `API_CONTRACTS.md` ровно с формой из spec (method POST, path `/api/sessions/read`, bearer, request `{scope,name?,sessionId}`, response `{session, messages:[TranscriptEntry]}`, errors 400/401/404/500, containment по реестру); в `ARCHITECTURE.md` — домен `sessions.read`, правило источника транскрипта (durable append-origin + текущая поверхность для контекста, `inContext`), containment; убрать «просмотр диалога» из «не входит (следующие этапы)»; в `ADMIN_UI.md` — кликабельные строки таба «Сессии», динамические табы с «×», сброс при смене воркспейса, свёрнутые tool/context-строки и пометка «не в контексте»; в `GLOSSARY.md` — термины «диалог сессии (транскрипт)», «модельная поверхность», «в контексте».

- [ ] **Step 2: Вызвать skill `canon-future-plan`** для `p2-session-view.md`: status `draft` → `implementing`, закрыть открытые вопросы согласно spec; синхронизировать `INDEX.md`.

- [ ] **Step 3: Проверить canon** запуском `doc-canon scout 'sessions.read транскрипт сессии'` — в выдаче должны быть обновлённые секции.

- [ ] **Step 4: Commit**

```bash
git add docs/canon
git commit -m "docs(canon): fix session view contract and dialogue source rule"
```

- [ ] **Step 5: STOP — go-ahead.** Сообщить владельцу, что canon обновлён, и ждать явного разрешения перед кодом (правило репозитория).

---

### Task 2: Контрактные типы транскрипта

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/tests/contracts.test.ts` (создать при отсутствии)

**Interfaces:**
- Consumes: ничего.
- Produces: `TranscriptRole`, `TranscriptKind`, `TranscriptEntry`, `SessionsReadRequest`, `SessionsReadResponse` из `dsh-balbes-contracts`.

- [ ] **Step 1: Дописать типы в конец `packages/contracts/src/index.ts`**

```ts
// Session transcript surface — one workspace session's dialogue
export type TranscriptRole = "user" | "assistant" | "system";
export type TranscriptKind = "message" | "tool-call" | "tool-result" | "context";

export interface TranscriptEntry {
  seq: number;
  time: string; // ISO 8601
  role: TranscriptRole;
  kind: TranscriptKind;
  /** Видимое тело; "" для строк, у которых тело в detail. */
  text: string;
  /** Техническое тело свёрнутой строки (аргументы, результат, служебный текст). */
  detail?: string;
  /** kind === "tool-call". */
  toolName?: string;
  /** kind === "context": plugin ContextForm, когда объявлен. */
  form?: string;
  /** kind === "tool-result". */
  isError?: boolean;
  /** Событие входит в текущую модельную поверхность. */
  inContext: boolean;
}

export interface SessionsReadRequest {
  scope: WorkspaceScope;
  /** Проект-слаг; обязателен для scope === "project", отсутствует для "home". */
  name?: string;
  sessionId: string;
}
export interface SessionsReadResponse {
  session: WorkspaceSessionInfo;
  messages: TranscriptEntry[];
}
```

- [ ] **Step 2: Проверить сборку типов**

Run: `pnpm --filter dsh-balbes-contracts build`
Expected: exit 0, `lib/index.d.ts` содержит `TranscriptEntry`.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter dsh-balbes-contracts typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/index.ts
git commit -m "feat(contracts): add session transcript types"
```

---

### Task 3: Чистый построитель транскрипта `transcript.ts`

**Files:**
- Create: `packages/plugins/dsh-balbes-sessions/src/transcript.ts`
- Create: `packages/plugins/dsh-balbes-sessions/tests/fixtures/events.ts`
- Test: `packages/plugins/dsh-balbes-sessions/tests/transcript.test.ts`

**Interfaces:**
- Consumes: `@deepseek-ai/dsh-session` (`deriveEventMessage`, `foldSurface`, `isAppendSurfaceEvent`, `isSurfaceEvent`), типы `@deepseek-ai/dsh-llm`.
- Produces: `buildTranscript(log: TranscriptLog): TranscriptEntry[]`, `TranscriptEntry`, `TranscriptLog` из `src/transcript.js`.

- [ ] **Step 1: Написать фикстуры событий `tests/fixtures/events.ts`**

```ts
import type { SessionEvent } from "@deepseek-ai/dsh-session";

const T = 1_700_000_000_000;
type Replace = { op: "replace"; startSeq: number; endSeq: number };

function event(
  type: string,
  seq: number,
  surfaceOp: "append" | Replace,
  data: unknown,
  sourceEventSeqs?: number[]
): SessionEvent {
  return {
    type,
    seq,
    time: T + seq,
    surfaceOp,
    data,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs })
  } as unknown as SessionEvent;
}

export function userMessage(
  seq: number,
  text: string,
  surfaceOp: "append" | Replace = "append",
  sourceEventSeqs?: number[]
): SessionEvent {
  return event(
    "user/message",
    seq,
    surfaceOp,
    { id: `m${seq}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
    sourceEventSeqs
  );
}

export function pluginContext(seq: number, text: string, form?: string): SessionEvent {
  return event("user/message", seq, "append", {
    id: `m${seq}`,
    role: "user",
    content: [{ type: "text", text }],
    source: form === undefined ? { kind: "plugin", plugin: "test" } : { kind: "plugin", plugin: "test", form }
  });
}

function assistantContent(seq: number, content: unknown[]): SessionEvent {
  return event("assistant/message", seq, "append", {
    turn: 0,
    step: 0,
    stream: [],
    message: { id: `m${seq}`, role: "assistant", content, source: { kind: "model", provider: "test", model: "test" } }
  });
}

export function assistantText(seq: number, text: string): SessionEvent {
  return assistantContent(seq, [{ type: "text", text }]);
}

export function assistantToolCall(seq: number, name: string, args: string, text?: string): SessionEvent {
  const call = { type: "tool-call", id: "call-1", name, arguments: args };
  return assistantContent(seq, text === undefined ? [call] : [{ type: "text", text }, call]);
}

export function emptyAssistant(seq: number): SessionEvent {
  return assistantContent(seq, []);
}

export function systemMessage(seq: number, text: string): SessionEvent {
  return event("system/message", seq, "append", {
    turn: 0,
    step: 0,
    message: { id: `m${seq}`, role: "system", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "test" } }
  });
}

export function toolResult(seq: number, text: string, isError = false): SessionEvent {
  return event("tool/result", seq, "append", {
    turn: 0,
    step: 0,
    message: {
      id: `m${seq}`,
      role: "user",
      content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text }], isError }],
      source: { kind: "tool", callId: "call-1" }
    }
  });
}
```

- [ ] **Step 2: Написать падающий тест `tests/transcript.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { buildTranscript } from "../src/transcript.js";
import { assistantText, assistantToolCall, emptyAssistant, pluginContext, systemMessage, toolResult, userMessage } from "./fixtures/events.js";

const session = { id: "session-1", createdAt: 1_700_000_000_000 } as never;

describe("buildTranscript", () => {
  it("maps durable messages, tool calls, results and current context", () => {
    const events = [
      systemMessage(0, "системный промпт"),
      pluginContext(1, "правила проекта", "instructions"),
      userMessage(2, "привет"),
      assistantToolCall(3, "read", "{\"path\":\"/a\"}", "сейчас прочитаю"),
      toolResult(4, "содержимое файла"),
      toolResult(5, "не нашёл", true)
    ];
    const entries = buildTranscript({ session, events });
    expect(entries.map((e) => [e.seq, e.kind, e.role, e.inContext])).toEqual([
      [0, "context", "system", true],
      [1, "context", "user", true],
      [2, "message", "user", true],
      [3, "message", "assistant", true],
      [3, "tool-call", "assistant", true],
      [4, "tool-result", "user", true],
      [5, "tool-result", "user", true]
    ]);
    expect(entries[0]?.detail).toBe("системный промпт");
    expect(entries[1]?.form).toBe("instructions");
    expect(entries[4]?.toolName).toBe("read");
    expect(entries[4]?.detail).toBe("{\"path\":\"/a\"}");
    expect(entries[5]?.detail).toBe("содержимое файла");
    expect(entries[6]?.isError).toBe(true);
  });

  it("drops a replaced context snapshot but keeps the durable conversation", () => {
    const events = [
      pluginContext(0, "старые правила", "instructions"),
      userMessage(1, "привет"),
      userMessage(2, "сводка", { op: "replace", startSeq: 0, endSeq: 0 }, [0])
    ];
    const entries = buildTranscript({ session, events });
    expect(entries.map((e) => [e.seq, e.kind, e.inContext])).toEqual([
      [1, "message", true],
      [2, "message", true]
    ]);
  });

  it("skips a surface event that projects to no message", () => {
    expect(buildTranscript({ session, events: [emptyAssistant(0)] })).toEqual([]);
  });
});
```

- [ ] **Step 3: Запустить тест — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-sessions test -- transcript`
Expected: FAIL — `Cannot find module '../src/transcript.js'`.

- [ ] **Step 4: Реализовать `src/transcript.ts`**

```ts
import {
  deriveEventMessage,
  foldSurface,
  isAppendSurfaceEvent,
  isSurfaceEvent
} from "@deepseek-ai/dsh-session";
import type { ContentBlock, Message, ToolCallBlock, ToolResultBlock } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";

export type TranscriptRole = "user" | "assistant" | "system";
export type TranscriptKind = "message" | "tool-call" | "tool-result" | "context";

export interface TranscriptEntry {
  seq: number;
  time: string;
  role: TranscriptRole;
  kind: TranscriptKind;
  text: string;
  detail?: string;
  toolName?: string;
  form?: string;
  isError?: boolean;
  inContext: boolean;
}

export interface TranscriptLog {
  session: SessionHeader;
  events: readonly SessionEvent[];
}

function joinTextBlocks(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => (block as Extract<ContentBlock, { type: "text" }>).text)
    .join("\n");
}

function contextForm(message: Message): string | undefined {
  if (message.source.kind !== "plugin") return undefined;
  const form = (message.source as { form?: unknown }).form;
  return typeof form === "string" ? form : undefined;
}

function entriesForEvent(event: SessionEvent, message: Message, inContext: boolean): TranscriptEntry[] {
  const head = { seq: event.seq, time: new Date(event.time).toISOString(), role: message.role, inContext };
  if (message.source.kind === "tool") {
    const blocks = message.content.filter((block): block is ToolResultBlock => block.type === "tool-result");
    const detail = joinTextBlocks(blocks.flatMap((block) => block.content));
    const entry: TranscriptEntry = { ...head, kind: "tool-result", text: "", detail };
    return blocks.some((block) => block.isError === true) ? [{ ...entry, isError: true }] : [entry];
  }
  if (message.source.kind === "plugin") {
    const entry: TranscriptEntry = { ...head, kind: "context", text: "", detail: joinTextBlocks(message.content) };
    const form = contextForm(message);
    return form === undefined ? [entry] : [{ ...entry, form }];
  }
  const entries: TranscriptEntry[] = [];
  const text = joinTextBlocks(message.content);
  if (text !== "") entries.push({ ...head, kind: "message", text });
  for (const call of message.content.filter((block): block is ToolCallBlock => block.type === "tool-call")) {
    entries.push({ ...head, kind: "tool-call", text: "", detail: call.arguments, toolName: call.name });
  }
  return entries;
}

/** Гибридный транскрипт: реплики — append-origin, контекст — текущая поверхность. */
export function buildTranscript(log: TranscriptLog): TranscriptEntry[] {
  const currentNodes = new Set(foldSurface(log.events).nodes);
  const entries: TranscriptEntry[] = [];
  for (const event of log.events) {
    if (!isSurfaceEvent(event)) continue;
    const message = deriveEventMessage(event);
    if (message === null) continue;
    const inContext = currentNodes.has(event.seq);
    const isContext = message.source.kind === "plugin";
    if (isContext && !inContext) continue;
    if (!isContext && !isAppendSurfaceEvent(event) && !inContext) continue;
    entries.push(...entriesForEvent(event, message, inContext));
  }
  return entries;
}
```

- [ ] **Step 5: Запустить тест — убедиться, что проходит**

Run: `pnpm --filter dsh-balbes-sessions test -- transcript`
Expected: PASS (3 теста).

- [ ] **Step 6: Typecheck и commit**

Run: `pnpm --filter dsh-balbes-sessions typecheck`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-sessions/src/transcript.ts packages/plugins/dsh-balbes-sessions/tests/transcript.test.ts packages/plugins/dsh-balbes-sessions/tests/fixtures/events.ts
git commit -m "feat(sessions): build hybrid session transcript from the engine log"
```

---

### Task 4: Ручка `sessions.read` и runbook

**Files:**
- Modify: `packages/plugins/dsh-balbes-sessions/src/index.ts`
- Modify: `packages/plugins/dsh-balbes-sessions/tests/index.test.ts`
- Modify: `docs/runbooks/stage2-vps.md`

**Interfaces:**
- Consumes: `buildTranscript` из Task 3; структурный срез `sessionQuery` с `readSession`/`readTitle`; `SessionQueryError` из `@deepseek-ai/dsh-session-query`.
- Produces: HTTP `POST /api/sessions/read` → `{session, messages}`.

- [ ] **Step 1: Дописать падающие тесты в `tests/index.test.ts`**

Заменить мок `sessionQuery` в `harness` (строки ~73–80) на:

```ts
      if (key === "sessionQuery") {
        return {
          readTitleSnapshots: async (ids: readonly string[]) => {
            if (options.queryThrows === true) throw new Error("persistence listing failed");
            const all = (options.observations ?? []) as Array<{ sessionId: string; status: string; value?: unknown }>;
            return all.filter((o) => ids.includes(o.sessionId));
          },
          readSession: async (_id: string) => {
            if (options.readThrows !== undefined) throw options.readThrows;
            return options.log;
          },
          readTitle: async (_id: string) => options.title
        };
      }
```

Расширить `HarnessOptions`:

```ts
interface HarnessOptions {
  projects?: unknown;
  observations?: unknown[];
  queryThrows?: boolean;
  log?: unknown;
  title?: unknown;
  readThrows?: unknown;
}
```

Изменить ожидание маршрутов:

```ts
    expect(h.seats.map((s) => [s.path, s.auth])).toEqual([
      ["/api/sessions/list", "bearer"],
      ["/api/sessions/read", "bearer"]
    ]);
```

Добавить импорты:

```ts
import { SessionQueryError } from "@deepseek-ai/dsh-session-query";
import { userMessage } from "./fixtures/events.js";
```

Добавить тесты:

```ts
  it("serves a workspace session transcript and 404s an unregistered session", async () => {
    const h = harness({
      log: { session: { id: "s-1", createdAt: 1_700_000_000_000 }, events: [userMessage(0, "привет")] },
      title: { title: "задача" }
    });
    const service = h.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await service.register({ scope: "project", name: "alpha" }, "s-1", "telegram");

    const res = await h.call("/api/sessions/read", { scope: "project", name: "alpha", sessionId: "s-1" });
    expect(res.status, res.raw).toBe(200);
    expect(res.json).toEqual({
      session: { id: "s-1", title: "задача", channel: "telegram", createdAt: new Date(1_700_000_000_000).toISOString() },
      messages: [
        { seq: 0, time: new Date(1_700_000_000_000).toISOString(), role: "user", kind: "message", text: "привет", inContext: true }
      ]
    });

    const foreign = await h.call("/api/sessions/read", { scope: "project", name: "alpha", sessionId: "s-2" });
    expect(foreign.status).toBe(404);
    expect((foreign.json as { error?: { code?: string } }).error?.code).toBe("not-found");
  });

  it("rejects a read without a sessionId and an unknown project", async () => {
    const h = harness();
    expect((await h.call("/api/sessions/read", { scope: "project", name: "alpha" })).status).toBe(400);
    expect((await h.call("/api/sessions/read", { scope: "project", name: "nope", sessionId: "s-1" })).status).toBe(404);
  });

  it("maps an unknown engine session to 404 and another engine failure to 500", async () => {
    const missing = harness({
      readThrows: new SessionQueryError("no such session", "SESSION_QUERY_SESSION_NOT_FOUND")
    });
    const missingService = missing.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await missingService.register({ scope: "project", name: "alpha" }, "s-1", "telegram");
    const notFound = await missing.call("/api/sessions/read", { scope: "project", name: "alpha", sessionId: "s-1" });
    expect(notFound.status).toBe(404);

    const broken = harness({ readThrows: new Error("replay failed") });
    const brokenService = broken.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await brokenService.register({ scope: "project", name: "alpha" }, "s-1", "telegram");
    const res = await broken.call("/api/sessions/read", { scope: "project", name: "alpha", sessionId: "s-1" });
    expect(res.status).toBe(500);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe("internal");
  });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `pnpm --filter dsh-balbes-sessions test -- index`
Expected: FAIL — нет маршрута `/api/sessions/read`.

- [ ] **Step 3: Реализовать в `src/index.ts`**

Добавить импорты:

```ts
import { SessionQueryError } from "@deepseek-ai/dsh-session-query";
import { buildTranscript, type TranscriptLog } from "./transcript.js";
```

Расширить `SessionQuerySlice`:

```ts
interface SessionQuerySlice {
  readTitleSnapshots(ids: readonly string[]): Promise<TitleObservation[]>;
  readSession(sessionId: string): Promise<TranscriptLog>;
  readTitle(sessionId: string): Promise<{ title: string } | undefined>;
}
```

Добавить разбор тела:

```ts
/** Разбор тела `sessions.read`: ref как у list плюс обязательный sessionId. */
function parseReadRequest(
  body: unknown
): { ok: true; ref: WorkspaceRef; sessionId: string } | { ok: false; message: string } {
  const parsed = parseListRequest(body);
  if (!parsed.ok) return parsed;
  const sessionId = (body as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "string" || sessionId === "") {
    return { ok: false, message: "sessionId is required" };
  }
  return { ok: true, ref: parsed.ref, sessionId };
}
```

Добавить маршрут рядом с `/api/sessions/list`:

```ts
  http.post("/api/sessions/read", "bearer", async (_req, res, body) => {
    const parsed = parseReadRequest(body);
    if (!parsed.ok) {
      send(res, 400, { error: { code: "bad-request", message: parsed.message } });
      return;
    }
    const { ref, sessionId } = parsed;
    try {
      const { projects } = await workspaces.list();
      if (ref.scope === "project" && !projects.some((project) => project.name === ref.name)) {
        send(res, 404, { error: { code: "not-found", message: `project not found: ${ref.name}` } });
        return;
      }
      // Containment: читаем только сессию, зарегистрированную за этим воркспейсом.
      const entries = await service.list(ref);
      const entry = entries.find((candidate) => candidate.sessionId === sessionId);
      if (entry === undefined) {
        send(res, 404, { error: { code: "not-found", message: `session not found in workspace: ${sessionId}` } });
        return;
      }
      const log = await query.readSession(sessionId);
      const messages = buildTranscript(log);
      const title = await query.readTitle(sessionId);
      send(res, 200, {
        session: {
          id: log.session.id,
          title: title?.title ?? null,
          channel: entry.channel,
          createdAt: new Date(log.session.createdAt).toISOString()
        },
        messages
      });
    } catch (error) {
      if (error instanceof SessionQueryError && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") {
        send(res, 404, { error: { code: "not-found", message: `session not found: ${sessionId}` } });
        return;
      }
      send(res, 500, {
        error: { code: "internal", message: error instanceof Error ? error.message : String(error) }
      });
    }
  });
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `pnpm --filter dsh-balbes-sessions test -- index`
Expected: PASS.

- [ ] **Step 5: Обновить `docs/runbooks/stage2-vps.md`**

В блоке «Сессии воркспейса» (после примеров `sessions.list`) добавить:

```bash
# Диалог сессии (bearer; sessionId — из ответа sessions.list)
curl -sS -X POST http://127.0.0.1:8080/api/sessions/read \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":"project","name":"alpha","sessionId":"<session-id>"}'
#    ожидается: {"session":{"id":"<session-id>","title":...,"channel":...,"createdAt":...},
#                "messages":[{"seq":0,"time":...,"role":"user","kind":"message","text":...,"inContext":true}, ...]}
# Несуществующая/чужая сессия:
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/sessions/read \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":"home","sessionId":"session-nope"}'
#    ожидается: 404
```

- [ ] **Step 6: Typecheck и commit (runbook в том же коммите)**

Run: `pnpm --filter dsh-balbes-sessions typecheck`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-sessions/src/index.ts packages/plugins/dsh-balbes-sessions/tests/index.test.ts docs/runbooks/stage2-vps.md
git commit -m "feat(sessions): serve a session transcript via sessions.read"
```

---

### Task 5: REAL-композиция для `sessions.read`

**Files:**
- Modify: `packages/plugins/dsh-balbes-sessions/tests/integration.test.ts`

**Interfaces:**
- Consumes: собранные пакеты и запущенный сервер (существующий харнесс).
- Produces: доказательство, что ручка работает поверх реального движка и реестра.

- [ ] **Step 1: В сценарии «sessions API: auth, codes, registry on disk» добавить проверки**

После блока 401 (строка ~233) добавить:

```ts
      // 401 без токена для чтения диалога
      expect((await postJson(`${base}/api/sessions/read`, { scope: "home", sessionId: "s-1" })).status).toBe(401);
      // 400: нет sessionId
      expect((await postJson(`${base}/api/sessions/read`, { scope: "home" }, token)).status).toBe(400);
```

После проверки 404 проекта (строка ~247) добавить:

```ts
      const readMissing = await postJson(`${base}/api/sessions/read`, { scope: "project", name: "nope", sessionId: "s-1" }, token);
      expect(readMissing.status).toBe(404);
      expect((readMissing.json as { error?: { message?: string } }).error?.message).toMatch(/^project not found: nope$/);
```

После создания проекта `alpha` (строка ~251) добавить:

```ts
      // 404: сессия не зарегистрирована за воркспейсом
      const readForeign = await postJson(`${base}/api/sessions/read`, { scope: "project", name: "alpha", sessionId: "session-nope" }, token);
      expect(readForeign.status).toBe(404);
      expect((readForeign.json as { error?: { message?: string } }).error?.message).toMatch(/^session not found in workspace: session-nope$/);
```

После проверки ghost-списка (строка ~275) добавить:

```ts
      // 404: запись реестра есть, но движок сессию не знает
      const readGhost = await postJson(`${base}/api/sessions/read`, { scope: "project", name: "alpha", sessionId: "session-ghost" }, token);
      expect(readGhost.status).toBe(404);
```

- [ ] **Step 2: В третьем сценарии (реальная сессия) добавить положительное чтение**

После проверки `createdAt` (строка ~401) добавить:

```ts
      // Диалог реальной сессии: заголовок/канал — из реестра и движка, реплики — из лога.
      const read = await postJson(`${base}/api/sessions/read`, { scope: "project", name: "alpha", sessionId }, token);
      expect(read.status, read.raw).toBe(200);
      const transcript = read.json as {
        session: { id: string; channel: string };
        messages: Array<{ role: string; kind: string; text: string; inContext: boolean }>;
      };
      expect(transcript.session.id).toBe(sessionId);
      expect(transcript.session.channel).toBe("telegram");
      expect(transcript.messages.some((m) => m.role === "user" && m.text.includes(marker))).toBe(true);
      expect(transcript.messages.some((m) => m.role === "assistant")).toBe(true);
```

- [ ] **Step 3: Прогнать REAL-набор**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-sessions test`
Expected: PASS (нужен `dsh` в PATH).

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/dsh-balbes-sessions/tests/integration.test.ts
git commit -m "test(sessions): REAL coverage for sessions.read"
```

---

### Task 6: Клиент `readSession`

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/api/client.ts`
- Modify: `packages/frontend/dsh-balbes-admin/tests/client.test.ts`
- Modify: `packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx`, `packages/frontend/dsh-balbes-admin/tests/ModelsPage.test.tsx`, `packages/frontend/dsh-balbes-admin/tests/TelegramPage.test.tsx`

**Interfaces:**
- Consumes: `SessionsReadRequest`, `SessionsReadResponse`.
- Produces: `AdminApi.readSession(scope, name, sessionId): Promise<SessionsReadResponse>`.

- [ ] **Step 1: Падающий тест в `tests/client.test.ts`**

```ts
  it("readSession POSTs to /api/sessions/read with the session id", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const body = { session: { id: "s-1", title: "задача", channel: "telegram", createdAt: "2026-09-12T00:00:00.000Z" }, messages: [] };
    const fetchMock = mockFetchOnce(200, body);
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    const res = await api.readSession("project", "alpha", "s-1");
    expect(res.session.id).toBe("s-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/read");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ scope: "project", name: "alpha", sessionId: "s-1" });
  });
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter dsh-balbes-admin test -- client`
Expected: FAIL — `api.readSession is not a function`.

- [ ] **Step 3: Реализовать в `src/api/client.ts`**

Добавить в импорт типов: `SessionsReadRequest, SessionsReadResponse`. В интерфейс `AdminApi`:

```ts
  readSession(scope: WorkspaceScope, name: string | undefined, sessionId: string): Promise<SessionsReadResponse>;
```

В возвращаемый объект рядом с `listSessions`:

```ts
    readSession: (scope, name, sessionId) => {
      const body: SessionsReadRequest = name === undefined ? { scope, sessionId } : { scope, name, sessionId };
      return guard(request<SessionsReadResponse>("/api/sessions/read", body));
    },
```

- [ ] **Step 4: Добавить `readSession` в полные стабы AdminApi**

В `WorkspacesPage.test.tsx`, `ModelsPage.test.tsx`, `TelegramPage.test.tsx` рядом с `listSessions`:

```ts
    readSession: vi.fn(async () => ({ session: { id: "s", title: null, channel: "telegram", createdAt: "" }, messages: [] })),
```

- [ ] **Step 5: Тесты и typecheck**

Run: `pnpm --filter dsh-balbes-admin test -- client` → PASS
Run: `pnpm --filter dsh-balbes-admin typecheck` → PASS

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/api/client.ts packages/frontend/dsh-balbes-admin/tests
git commit -m "feat(admin): add readSession to the api client"
```

---

### Task 7: Общий форматтер времени

**Files:**
- Create: `packages/frontend/dsh-balbes-admin/src/format.ts`
- Test: `packages/frontend/dsh-balbes-admin/tests/format.test.ts`
- Modify: `packages/frontend/dsh-balbes-admin/src/components/SessionsTab.tsx`

**Interfaces:**
- Produces: `formatCreatedAt(iso: string): string` из `src/format.js`.

- [ ] **Step 1: Падающий тест `tests/format.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { formatCreatedAt } from "../src/format";

describe("formatCreatedAt", () => {
  it("renders ru-RU local time", () => {
    expect(formatCreatedAt("2026-09-11T01:40:00.000Z")).toBe(new Date("2026-09-11T01:40:00.000Z").toLocaleString("ru-RU"));
  });
  it("uses a dash for empty and echoes an unparseable value", () => {
    expect(formatCreatedAt("  ")).toBe("—");
    expect(formatCreatedAt("не дата")).toBe("не дата");
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter dsh-balbes-admin test -- format`
Expected: FAIL — нет модуля `../src/format`.

- [ ] **Step 3: Создать `src/format.ts`** (перенести функцию один-в-один из `SessionsTab.tsx`)

```ts
/**
 * Время в ru-RU, с ISO как честным fallback. Пустая (или пробельная) строка —
 * отсутствие времени, и тогда показывается заглушка: пустая ячейка читалась бы
 * как сломанная вёрстка.
 */
export function formatCreatedAt(iso: string): string {
  if (iso.trim() === "") return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ru-RU");
}
```

- [ ] **Step 4: Убрать локальную копию из `SessionsTab.tsx`**

Удалить функцию `formatCreatedAt` из `SessionsTab.tsx` и добавить импорт:

```ts
import { formatCreatedAt } from "../format";
```

- [ ] **Step 5: Тесты формата и SessionsTab**

Run: `pnpm --filter dsh-balbes-admin test -- format SessionsTab`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/format.ts packages/frontend/dsh-balbes-admin/src/components/SessionsTab.tsx packages/frontend/dsh-balbes-admin/tests/format.test.ts
git commit -m "refactor(admin): share the time formatter"
```

---

### Task 8: Компонент `SessionTranscript`

**Files:**
- Create: `packages/frontend/dsh-balbes-admin/src/components/SessionTranscript.tsx`
- Test: `packages/frontend/dsh-balbes-admin/tests/SessionTranscript.test.tsx`

**Interfaces:**
- Consumes: `AdminApi.readSession`, `formatCreatedAt`, тип `TranscriptEntry`.
- Produces: `default SessionTranscript({ api, workspace, sessionId, reloadKey })`; testid'ы `session-transcript`, `session-transcript-loading`, `session-transcript-error`, `session-transcript-retry`, `session-transcript-empty`, `session-entry-<index>`.

- [ ] **Step 1: Падающий тест `tests/SessionTranscript.test.tsx`**

```tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import SessionTranscript from "../src/components/SessionTranscript";
import type { AdminApi } from "../src/api/client";
import type { SessionsReadResponse } from "dsh-balbes-contracts";

const SESSION = { id: "s-1", title: "задача", channel: "telegram", createdAt: "2026-09-12T00:00:00.000Z" };
function response(messages: SessionsReadResponse["messages"]): SessionsReadResponse {
  return { session: SESSION, messages };
}
function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return { readSession: vi.fn(async () => response([])), ...overrides } as unknown as AdminApi;
}

afterEach(() => cleanup());

describe("SessionTranscript", () => {
  it("renders messages and collapses tool/context rows", async () => {
    const api = makeApi({
      readSession: vi.fn(async () =>
        response([
          { seq: 0, time: "2026-09-12T00:00:00.000Z", role: "assistant", kind: "message", text: "ответ модели", inContext: true },
          { seq: 1, time: "2026-09-12T00:00:01.000Z", role: "assistant", kind: "tool-call", text: "", detail: "{}", toolName: "read", inContext: true },
          { seq: 2, time: "2026-09-12T00:00:02.000Z", role: "system", kind: "context", text: "", detail: "промпт", inContext: true },
          { seq: 3, time: "2026-09-12T00:00:03.000Z", role: "user", kind: "message", text: "старое", inContext: false }
        ])
      )
    });
    render(<SessionTranscript api={api} workspace={{ scope: "project", name: "alpha" }} sessionId="s-1" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("session-transcript")).toBeDefined());
    expect(api.readSession).toHaveBeenCalledWith("project", "alpha", "s-1");
    expect(screen.getByText("ответ модели")).toBeDefined();
    expect(screen.getByText("Вызов инструмента: read")).toBeDefined();
    expect(screen.getByText("Системный промпт")).toBeDefined();
    // свёрнутые строки — details без атрибута open
    expect(screen.getByTestId("session-entry-1").querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("не в контексте")).toBeDefined();
  });

  it("shows loading, empty and error with retry", async () => {
    const readSession = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(response([]));
    render(<SessionTranscript api={makeApi({ readSession })} workspace={{ scope: "home" }} sessionId="s-1" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("session-transcript-error")).toBeDefined());
    fireEvent.click(screen.getByTestId("session-transcript-retry"));
    await waitFor(() => expect(screen.getByTestId("session-transcript-empty")).toBeDefined());
  });

  it("makes no request without a workspace", () => {
    const api = makeApi();
    render(<SessionTranscript api={api} workspace={null} sessionId="s-1" reloadKey={0} />);
    expect(api.readSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter dsh-balbes-admin test -- SessionTranscript`
Expected: FAIL — нет модуля компонента.

- [ ] **Step 3: Реализовать `src/components/SessionTranscript.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionsReadResponse, TranscriptEntry } from "dsh-balbes-contracts";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";
import { formatCreatedAt } from "../format";

interface SessionTranscriptProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
  sessionId: string;
  reloadKey: number;
}

function label(entry: TranscriptEntry): string {
  if (entry.kind === "tool-call") return `Вызов инструмента: ${entry.toolName ?? "—"}`;
  if (entry.kind === "tool-result") return entry.isError === true ? "Результат инструмента (ошибка)" : "Результат инструмента";
  if (entry.kind === "context") {
    if (entry.form !== undefined) return `Контекст: ${entry.form}`;
    return entry.role === "system" ? "Системный промпт" : "Служебный контекст";
  }
  return entry.role === "assistant" ? "Модель" : entry.role === "system" ? "Система" : "Владелец";
}

export default function SessionTranscript({ api, workspace, sessionId, reloadKey }: SessionTranscriptProps) {
  const [data, setData] = useState<SessionsReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastWorkspace = useRef<WorkspaceRef | null>(null);
  const generation = useRef(0);
  const loadSeq = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<void> => {
    if (workspace === null) return;
    const myGen = generation.current;
    const mySeq = ++loadSeq.current;
    const stale = (): boolean => generation.current !== myGen || loadSeq.current !== mySeq;
    setError(null);
    try {
      const res = await api.readSession(workspace.scope, workspace.name, sessionId);
      if (!stale()) setData(res);
    } catch (err) {
      if (!stale()) {
        setData(null);
        setError(err instanceof Error ? err.message : "session read failed");
      }
    }
  }, [api, workspace, sessionId]);

  useEffect(() => {
    if (!isSameRef(lastWorkspace.current, workspace)) {
      lastWorkspace.current = workspace;
      generation.current += 1;
      setData(null);
      setError(null);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, sessionId, reloadKey]);

  useEffect(() => {
    if (bodyRef.current !== null) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [data]);

  if (workspace === null) return null;

  if (error !== null) {
    return (
      <p className="form-error ws-tab-error" role="alert" data-testid="session-transcript-error">
        Не удалось загрузить диалог: {error}{" "}
        <button type="button" className="btn-ghost" data-testid="session-transcript-retry" onClick={() => void load()}>
          Повторить
        </button>
      </p>
    );
  }
  if (data === null) return <p className="ws-placeholder" data-testid="session-transcript-loading">Загрузка…</p>;
  if (data.messages.length === 0) return <p className="ws-placeholder" data-testid="session-transcript-empty">Сессия без сообщений</p>;

  return (
    <div className="ws-transcript" data-testid="session-transcript" ref={bodyRef}>
      {data.messages.map((entry, index) => (
        <div className="ws-transcript-entry" data-testid={`session-entry-${index}`} key={`${entry.seq}-${index}`}>
          <div className="ws-transcript-head">
            <span>{label(entry)}</span>
            <span className="ws-transcript-time">{formatCreatedAt(entry.time)}</span>
            {entry.inContext ? null : <span className="ws-transcript-shadowed">не в контексте</span>}
          </div>
          {entry.kind === "message" ? (
            <p className="ws-transcript-text">{entry.text}</p>
          ) : (
            <details className="ws-transcript-details">
              <summary>подробнее</summary>
              <pre className="ws-transcript-pre">{entry.detail ?? entry.text}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Тесты и typecheck**

Run: `pnpm --filter dsh-balbes-admin test -- SessionTranscript` → PASS
Run: `pnpm --filter dsh-balbes-admin typecheck` → PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/components/SessionTranscript.tsx packages/frontend/dsh-balbes-admin/tests/SessionTranscript.test.tsx
git commit -m "feat(admin): render a session transcript"
```

---

### Task 9: Кликабельные строки таба «Сессии»

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/components/SessionsTab.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/tests/SessionsTab.test.tsx`

**Interfaces:**
- Consumes: тип `WorkspaceSessionInfo`.
- Produces: пропы `onOpenSession?: (s: WorkspaceSessionInfo) => void`, `activeSessionId?: string | null`; testid строки остаётся `session-row-<id>` на кнопке.

- [ ] **Step 1: Дописать тесты в `tests/SessionsTab.test.tsx`**

```tsx
  it("opens a session from a row click", async () => {
    const onOpenSession = vi.fn();
    render(
      <SessionsTab api={makeApi()} workspace={{ scope: "project", name: "alpha" }} reloadKey={0} onOpenSession={onOpenSession} />
    );
    await waitFor(() => expect(screen.getByTestId("session-row-session-new")).toBeDefined());
    fireEvent.click(screen.getByTestId("session-row-session-new"));
    expect(onOpenSession).toHaveBeenCalledWith(SESSIONS[0]);
  });

  it("marks the open session as active", async () => {
    render(
      <SessionsTab
        api={makeApi()}
        workspace={{ scope: "project", name: "alpha" }}
        reloadKey={0}
        activeSessionId="session-old"
      />
    );
    await waitFor(() => expect(screen.getByTestId("session-row-session-old")).toBeDefined());
    expect(screen.getByTestId("session-row-session-old").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("session-row-session-new").getAttribute("aria-current")).toBeNull();
  });
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter dsh-balbes-admin test -- SessionsTab`
Expected: FAIL — проп `onOpenSession` не существует / нет `aria-current`.

- [ ] **Step 3: Изменить проп-интерфейс и разметку строки**

В `SessionsTabProps` добавить:

```ts
  /** Открыть сессию: правый хост добавляет таб с диалогом. */
  onOpenSession?: (session: WorkspaceSessionInfo) => void;
  /** id открытой сессии для подсветки строки. */
  activeSessionId?: string | null;
```

Сигнатуру компонента заменить на `{ api, workspace, reloadKey, onOpenSession, activeSessionId }`. Разметку списка заменить на:

```tsx
    <ul className="ws-rows ws-session-rows" data-testid="sessions-list">
      {sessions.map((session) => {
        const active = session.id === activeSessionId;
        return (
          <li key={session.id} className={active ? "ws-session-row active" : "ws-session-row"}>
            <button
              type="button"
              className="ws-session-row-button"
              data-testid={`session-row-${session.id}`}
              aria-current={active ? "true" : undefined}
              onClick={() => onOpenSession?.(session)}
            >
              <span className="ws-session-title">{session.title?.trim() ? session.title : "Без заголовка"}</span>
              <span className="ws-session-meta">
                <span className="ws-session-channel">{session.channel}</span>
                <span className="ws-session-time">{formatCreatedAt(session.createdAt)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
```

- [ ] **Step 4: Тесты и typecheck**

Run: `pnpm --filter dsh-balbes-admin test -- SessionsTab` → PASS
Run: `pnpm --filter dsh-balbes-admin typecheck` → PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/components/SessionsTab.tsx packages/frontend/dsh-balbes-admin/tests/SessionsTab.test.tsx
git commit -m "feat(admin): make session rows open a transcript"
```

---

### Task 10: Динамические табы сессий в правой зоне

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/components/WorkspaceRightPane.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/tests/WorkspaceRightPane.test.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/styles.css`

**Interfaces:**
- Consumes: `SessionsTab.onOpenSession`, `SessionTranscript`.
- Produces: табы `session:<sessionId>`, `data-testid="ws-tab-close-session:<sessionId>"`; сброс при смене воркспейса.

- [ ] **Step 1: Дописать тесты в `tests/WorkspaceRightPane.test.tsx`**

```tsx
  it("opens a session tab from the list, focuses it and closes it", async () => {
    const session = { id: "session-alpha", title: "задача", channel: "telegram", createdAt: "2026-09-11T01:40:00.000Z" };
    const api = makeApi({
      listSessions: vi.fn(async () => ({ sessions: [session] })),
      readSession: vi.fn(async () => ({ session, messages: [] }))
    });
    render(<WorkspaceRightPane api={api} workspace={{ scope: "project", name: "alpha" }} />);
    await waitFor(() => expect(screen.getByTestId("session-row-session-alpha")).toBeDefined());

    fireEvent.click(screen.getByTestId("session-row-session-alpha"));
    await waitFor(() => expect(screen.getByTestId("session-transcript-empty")).toBeDefined());
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Сессии", "задача"]);

    // повторный клик не дублирует таб
    fireEvent.click(screen.getByTestId("session-row-session-alpha"));
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("ws-tab-close-session:session-alpha"));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "задача" })).toBeNull());
    cleanup();
  });

  it("resets session tabs on a workspace switch", async () => {
    const session = { id: "session-alpha", title: "задача", channel: "telegram", createdAt: "2026-09-11T01:40:00.000Z" };
    const api = makeApi({
      listSessions: vi.fn(async () => ({ sessions: [session] })),
      readSession: vi.fn(async () => ({ session, messages: [] }))
    });
    const { rerender } = render(<WorkspaceRightPane api={api} workspace={{ scope: "project", name: "alpha" }} />);
    await waitFor(() => expect(screen.getByTestId("session-row-session-alpha")).toBeDefined());
    fireEvent.click(screen.getByTestId("session-row-session-alpha"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "задача" })).toBeDefined());

    rerender(<WorkspaceRightPane api={api} workspace={{ scope: "project", name: "beta" }} />);
    await waitFor(() => expect(screen.queryByRole("tab", { name: "задача" })).toBeNull());
    cleanup();
  });
```

Добавить `readSession` в `makeApi` файла:

```ts
    readSession: vi.fn(async () => ({ session: { id: "s", title: null, channel: "telegram", createdAt: "" }, messages: [] })),
```

- [ ] **Step 2: Запустить — падает**

Run: `pnpm --filter dsh-balbes-admin test -- WorkspaceRightPane`
Expected: FAIL — нет динамических табов.

- [ ] **Step 3: Переписать `src/components/WorkspaceRightPane.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { WorkspaceSessionInfo } from "dsh-balbes-contracts";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";
import SessionsTab from "./SessionsTab";
import SessionTranscript from "./SessionTranscript";

interface SessionTab {
  id: string;
  sessionId: string;
  title: string | null;
}

interface WorkspaceRightPaneProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
}

function sessionLabel(title: string | null): string {
  return title?.trim() ? title : "Без заголовка";
}

export default function WorkspaceRightPane({ api, workspace }: WorkspaceRightPaneProps) {
  const [active, setActive] = useState("sessions");
  const [reloadKey, setReloadKey] = useState(0);
  const [sessionTabs, setSessionTabs] = useState<SessionTab[]>([]);
  const lastWorkspace = useRef<WorkspaceRef | null>(null);

  useEffect(() => {
    if (!isSameRef(lastWorkspace.current, workspace)) {
      lastWorkspace.current = workspace;
      setSessionTabs([]);
      setActive("sessions");
    }
  }, [workspace]);

  const openSession = useCallback((session: WorkspaceSessionInfo): void => {
    const id = `session:${session.id}`;
    setSessionTabs((tabs) => (tabs.some((tab) => tab.id === id) ? tabs : [...tabs, { id, sessionId: session.id, title: session.title }]));
    setActive(id);
  }, []);

  const closeSession = useCallback(
    (id: string): void => {
      const index = sessionTabs.findIndex((tab) => tab.id === id);
      const next = sessionTabs.filter((tab) => tab.id !== id);
      setSessionTabs(next);
      if (active === id) setActive(next[Math.max(0, index - 1)]?.id ?? "sessions");
    },
    [sessionTabs, active]
  );

  const openTab = sessionTabs.find((tab) => tab.id === active);
  const panelId = `ws-tabpanel-${active}`;

  return (
    <div className="ws-pane ws-right-pane" data-testid="ws-right-pane">
      <div className="ws-tabstrip" role="tablist" aria-label="Содержимое воркспейса" data-testid="ws-tabs">
        <button
          type="button"
          role="tab"
          id="ws-tab-sessions"
          aria-selected={active === "sessions"}
          aria-controls="ws-tabpanel-sessions"
          className={active === "sessions" ? "ws-tab active" : "ws-tab"}
          data-testid="ws-tab-sessions"
          onClick={() => {
            setActive("sessions");
            setReloadKey((key) => key + 1);
          }}
        >
          Сессии
        </button>
        {sessionTabs.map((tab) => {
          const selected = tab.id === active;
          const label = sessionLabel(tab.title);
          return (
            <span className={selected ? "ws-tab-group active" : "ws-tab-group"} key={tab.id}>
              <button
                type="button"
                role="tab"
                id={`ws-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`ws-tabpanel-${tab.id}`}
                className={selected ? "ws-tab active" : "ws-tab"}
                data-testid={`ws-tab-${tab.id}`}
                title={`${label} · ${tab.sessionId}`}
                onClick={() => {
                  setActive(tab.id);
                  setReloadKey((key) => key + 1);
                }}
              >
                {label}
              </button>
              <button
                type="button"
                className="ws-tab-close"
                aria-label={`Закрыть ${label}`}
                data-testid={`ws-tab-close-${tab.id}`}
                onClick={() => closeSession(tab.id)}
              >
                ×
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className="btn-ghost ws-tabstrip-refresh"
          data-testid="ws-refresh"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          Обновить
        </button>
      </div>
      <div
        className="ws-tabpanel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`ws-tab-${active}`}
        data-testid="ws-tabpanel"
      >
        {workspace === null ? (
          <p className="ws-placeholder" data-testid="right-pane-prompt">
            Выберите воркспейс
          </p>
        ) : openTab !== undefined ? (
          <SessionTranscript api={api} workspace={workspace} sessionId={openTab.sessionId} reloadKey={reloadKey} />
        ) : (
          <SessionsTab
            api={api}
            workspace={workspace}
            reloadKey={reloadKey}
            activeSessionId={active.startsWith("session:") ? active.slice("session:".length) : null}
            onOpenSession={openSession}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Добавить CSS в `src/styles.css`**

```css
.ws-tab-group { display: inline-flex; align-items: center; }
.ws-tab-close {
  border: 0; background: transparent; color: inherit; cursor: pointer;
  font-size: 1rem; line-height: 1; padding: 0 0.35rem;
}
.ws-tabstrip { overflow-x: auto; }
.ws-session-row-button {
  display: flex; justify-content: space-between; gap: 0.75rem;
  width: 100%; border: 0; background: transparent; color: inherit; cursor: pointer;
  text-align: left; padding: 0.4rem 0.5rem;
}
.ws-session-row.active .ws-session-row-button { background: rgba(255, 255, 255, 0.06); }
.ws-transcript { overflow-y: auto; height: 100%; }
.ws-transcript-entry { border-bottom: 1px solid rgba(255, 255, 255, 0.06); padding: 0.4rem 0.2rem; }
.ws-transcript-head { display: flex; gap: 0.6rem; align-items: baseline; font-size: 0.8rem; opacity: 0.85; }
.ws-transcript-time { opacity: 0.7; }
.ws-transcript-shadowed { color: #d9a441; }
.ws-transcript-text { white-space: pre-wrap; margin: 0.3rem 0 0; }
.ws-transcript-pre { white-space: pre-wrap; margin: 0.3rem 0 0; }
```

- [ ] **Step 5: Тесты, typecheck, сборка**

Run: `pnpm --filter dsh-balbes-admin test -- WorkspaceRightPane` → PASS
Run: `pnpm --filter dsh-balbes-admin typecheck` → PASS

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/components/WorkspaceRightPane.tsx packages/frontend/dsh-balbes-admin/src/styles.css packages/frontend/dsh-balbes-admin/tests/WorkspaceRightPane.test.tsx
git commit -m "feat(admin): open sessions in their own right-pane tabs"
```

---

### Task 11: Закрытие — полная проверка и canon-audit

**Files:**
- Modify (через `canon-future-plan`/`canon-audit`): `docs/canon/future_plans/p2-session-view.md`, `docs/canon/future_plans/INDEX.md`

**Interfaces:**
- Consumes: всё предыдущее.
- Produces: закрытая инициатива p2 (`absorbed`) и отсутствие расхождений.

- [ ] **Step 1: Полный локальный прогон**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS по всем пакетам.

- [ ] **Step 2: REAL-набор сессий**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-sessions test`
Expected: PASS.

- [ ] **Step 3: `canon-audit`** по теме «просмотр сессии в админке»; при расхождении — запись в `docs/canon/DISCREPANCIES.md` (через skill, не вручную).

- [ ] **Step 4: `canon-future-plan`** — перевести `p2-session-view.md` в `absorbed` и синхронизировать `INDEX.md`.

- [ ] **Step 5: Commit + handoff**

```bash
git add docs/canon
git commit -m "docs(canon): absorb p2 session view initiative"
```

Отдать владельцу инструкции по проверке на сервере: push в `origin/main` (только после его go-ahead) → на VPS перезапустить `scripts/install.sh` → smoke `/api/sessions/read` из runbook → открыть сессию в табе «Сессии» и сверить диалог.

---

## Self-review (spec coverage)

- Ручка `sessions.read` + containment + 404/400/401/500 — Task 4, Task 5.
- Гибридный источник (durable append-origin + текущая поверхность, `inContext`) — Task 1 (canon), Task 3 (код+тесты), Task 5 (REAL).
- DTO `TranscriptEntry` — Task 2, Task 4.
- Динамические табы с «×», сброс при смене воркспейса — Task 10.
- Кликабельные строки и подсветка — Task 9.
- Компонент диалога, состояния, сворачивание, «не в контексте», прокрутка — Task 8.
- Общий форматтер времени — Task 7.
- Канон-секции и future-plan — Task 1, Task 11.
- Runbook в том же коммите — Task 4.
- Тесты (юнит/REAL/фронтенд) — Tasks 3–10.
- Отложенное (пагинация, push, reasoning, картинки) — вне задач, зафиксировано в spec.
