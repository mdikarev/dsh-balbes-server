# Telegram Control Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать владельцу вызываемое из любой точки диалога меню, смену воркспейса, сброс контекста, смену модели, живую карточку прогресса задачи и остановку задачи без потери контекста.

**Architecture:** Командная поверхность регистрируется нативными ручками Bot API (`setMyCommands`), текст роутится таблицей команд в `commands.ts`, все карточки собираются чистыми билдерами в `cards.ts`, состояние вьюх остаётся в `chat.ts`. Раннер получает три узких шва: живой выбор модели над глобальным дефолтом, `cancel(ref)` через штатный `Agent.cancel` с сохранением inbox и `progress(ref)` — сводка хода задачи из лога сессии. Список соединений и смена дефолтной модели выносятся в сервис `balbesModels` плагина моделей, чтобы админка и Telegram ходили через одну валидацию.

**Tech Stack:** TypeScript (strict, ESM), Node ≥ 22, Cordis-плагины dsh 0.1.2-rc.1, vitest, Telegram Bot API (long polling), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-11-telegram-control-surface-design.md`

## Global Constraints

- dsh — зависимость, не форк: установленные `@deepseek-ai/*` не редактируются; новые возможности — только через штатные швы (`agents`/`sessions`/`installModelSelection`/`Agent.cancel`/`ctx.provide`).
- `docs/canon/**` руками не правится: канон уже обновлён коммитом `docs(canon): telegram control surface`. Если реализация разойдётся с каноном — останавливаться и эскалировать, а не править канон в этом плане.
- Плагины — функциональные: named-export `name`/`inject`/`Config`/`apply`, без default-export; сервисы отдаются через `ctx.provide`.
- Относительные импорты внутри пакета — с расширением `.ts`-стиля репозитория: `import { x } from "./y.js";`.
- Весь текст бота — русский, plain text, без Markdown/HTML.
- Callback-payload — только короткие коды ≤ 64 байт; строки `provider`/`model`/пути из callback никогда не принимаются.
- Текст, начинающийся с «/», никогда не уходит агенту как задача.
- Проверки после каждой задачи: `pnpm --filter dsh-balbes-telegram run typecheck`, `pnpm --filter dsh-balbes-models run typecheck` (где применимо) и `pnpm --filter <пакет> run test`. REAL-наборы — только с `RUN_REAL=1` и локально.
- Коммит после каждой задачи; сообщения — в стиле репозитория (`feat(telegram): …`, `feat(models): …`).

---

## File Structure

**Создаются:**

- `packages/plugins/dsh-balbes-models/src/service.ts` — сервис `balbesModels`: список соединений, текущий дефолт, `saveDefault` с валидацией (единственный источник правды для админки и Telegram).
- `packages/plugins/dsh-balbes-models/tests/service.test.ts` — юнит-тесты сервиса.
- `packages/plugins/dsh-balbes-telegram/src/cards.ts` — чистые билдеры карточек «текст + клавиатура» (меню, статус, модель, прогресс, квитанции) и `formatElapsed`.
- `packages/plugins/dsh-balbes-telegram/src/commands.ts` — таблица команд (`name`/`description`), `parseCommand`, текст справки.
- `packages/plugins/dsh-balbes-telegram/tests/cards.test.ts` — тесты билдеров карточек.
- `packages/plugins/dsh-balbes-telegram/tests/commands.test.ts` — тесты роутинга команд.

**Изменяются:**

- `packages/plugins/dsh-balbes-models/src/index.ts` — `readConnections` переезжает в `service.ts`; `ctx.provide("balbesModels", …)`; ручки `/api/models/list` и `/api/models/default` используют сервис.
- `packages/plugins/dsh-balbes-models/tests/index.test.ts` — ctx-дабл получает `provide`, ручки проверяются через сервис.
- `packages/plugins/dsh-balbes-telegram/src/bot.ts` — `setMyCommands`, `setChatMenuButton` в `BotClient`.
- `packages/plugins/dsh-balbes-telegram/tests/bot.test.ts` — тесты двух новых методов.
- `packages/plugins/dsh-balbes-telegram/tests/helpers/fake-bot-api.mjs` — обработчики `setMyCommands`/`setChatMenuButton`.
- `packages/plugins/dsh-balbes-telegram/tests/{chat,admin,poller}.test.ts` — фейковые `BotClient` получают два новых метода.
- `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` — живой selection, `cancel(ref)`, `progress(ref)`, код `cancelled`.
- `packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts` — тесты трёх швов; фейковый хэндл получает `cancel`-семантику.
- `packages/plugins/dsh-balbes-telegram/src/chat.ts` — команды, карточка-меню, пикер моделей, карточка прогресса, `/stop`.
- `packages/plugins/dsh-balbes-telegram/tests/chat.test.ts` — тесты нового UX; фейковый раннер получает `cancel`/`progress`.
- `packages/plugins/dsh-balbes-telegram/src/keyboards.ts` — удаляются `menuKeyboard`/`workspaceActionsKeyboard` (их заменяют карточки).
- `packages/plugins/dsh-balbes-telegram/tests/keyboards.test.ts` — удаляются тесты удалённых билдеров.
- `packages/plugins/dsh-balbes-telegram/src/index.ts` — `balbesModels` в `inject`, проброс `models`/команд в чат, регистрация команд на transition.
- `packages/plugins/dsh-balbes-telegram/tests/index.test.ts` — проверка регистрации команд и деградации без сервиса моделей.
- `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts` — REAL-проверки: `setMyCommands` end-to-end, `/model` в `agentDefaultModel`, `/stop` без потери контекста.
- `docs/runbooks/stage2-vps.md` — шаги чеклиста Telegram.

**Не меняются:** `src/state.ts` (состояние на диске остаётся версии 1), `src/poller.ts`, `src/updates.ts`, `src/text.ts`, `src/admin.ts` (кроме проброса клиента в `index.ts`).

---

### Task 1: Сервис моделей `balbesModels`

**Files:**
- Create: `packages/plugins/dsh-balbes-models/src/service.ts`
- Modify: `packages/plugins/dsh-balbes-models/src/index.ts`
- Test: `packages/plugins/dsh-balbes-models/tests/service.test.ts`, `packages/plugins/dsh-balbes-models/tests/index.test.ts`

**Interfaces:**
- Consumes: `ModelConnection`, `ModelCatalogReader`, `catalogKeyForRoute`, `isPresetProviderId`, `DEEPSEEK_OFFICIAL_ROUTE` из `./models.js`.
- Produces: `createModelsService(deps): BalbesModelsService` с `list(): Promise<ModelConnection[]>`, `current(): { provider: string; model: string }`, `saveDefault(provider: string, model: string): Promise<{ provider: string; model: string }>`; класс `ModelsServiceError` с `code: "invalid-route" | "invalid-model"`; экспортируемая `readConnections(...)`.

- [ ] **Step 1: Написать падающий тест сервиса**

Создать `packages/plugins/dsh-balbes-models/tests/service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createModelsService, ModelsServiceError } from "../src/service.js";

const LLM_PI_AI_NS = "llm-pi-ai";

function makeSettings(providers: Record<string, unknown>) {
  const sections: Record<string, unknown> = { [LLM_PI_AI_NS]: { providers } };
  return {
    sections,
    get: (ns: string): unknown => sections[ns],
    async replace(ns: string, section: object): Promise<void> {
      sections[ns] = section;
    }
  };
}

function makeCredentials(configured: string[] = []) {
  return {
    async describe(ref: string) {
      return { configured: configured.includes(ref), writable: true };
    },
    async set(): Promise<void> {},
    async unset(): Promise<void> {}
  };
}

function makeDefault(provider: string, model: string) {
  let current = { provider, model };
  return {
    currentSelection: () => current,
    async saveSelection(next: { provider: string; model: string }): Promise<void> {
      current = next;
    }
  };
}

describe("balbesModels service", () => {
  it("lists the official route plus configured connections and marks the default", async () => {
    const service = createModelsService({
      settings: makeSettings({ openai: { displayName: "OpenAI", apiKeyEnv: "BALBES_OPENAI_API_KEY", models: [{ id: "gpt-4o" }] } }),
      credentials: makeCredentials(["DEEPSEEK_API_KEY", "BALBES_OPENAI_API_KEY"]),
      defaultModel: makeDefault("deepseek-official", "deepseek-v4-flash"),
      reader: { list: () => [{ id: "deepseek-v4-pro" }] }
    });

    const connections = await service.list();

    expect(connections[0]).toMatchObject({ routeId: "deepseek-official", kind: "deepseek", hasKey: true, isDefault: true });
    expect(connections[0]!.models).toEqual(["deepseek-v4-pro"]);
    expect(connections[1]).toMatchObject({ routeId: "openai", kind: "preset", hasKey: true, isDefault: false, models: ["gpt-4o"] });
    expect(service.current()).toEqual({ provider: "deepseek-official", model: "deepseek-v4-flash" });
  });

  it("saves a model that the connection offers", async () => {
    const defaultModel = makeDefault("deepseek-official", "deepseek-v4-flash");
    const service = createModelsService({
      settings: makeSettings({ openai: { displayName: "OpenAI", apiKeyEnv: "BALBES_OPENAI_API_KEY", models: [{ id: "gpt-4o" }] } }),
      credentials: makeCredentials(["BALBES_OPENAI_API_KEY"]),
      defaultModel,
      reader: { list: () => [] }
    });

    await expect(service.saveDefault("openai", "gpt-4o")).resolves.toEqual({ provider: "openai", model: "gpt-4o" });
    expect(defaultModel.currentSelection()).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("refuses an unknown connection and a model the connection does not offer", async () => {
    const service = createModelsService({
      settings: makeSettings({ openai: { displayName: "OpenAI", apiKeyEnv: "BALBES_OPENAI_API_KEY", models: [{ id: "gpt-4o" }] } }),
      credentials: makeCredentials(),
      defaultModel: makeDefault("deepseek-official", "deepseek-v4-flash"),
      reader: { list: () => [] }
    });

    const unknown = await service.saveDefault("nope", "m").then(() => null, (e: unknown) => e as ModelsServiceError);
    expect(unknown?.code).toBe("invalid-route");
    const badModel = await service.saveDefault("openai", "nope").then(() => null, (e: unknown) => e as ModelsServiceError);
    expect(badModel?.code).toBe("invalid-model");
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pnpm --filter dsh-balbes-models exec vitest run tests/service.test.ts`
Expected: FAIL — «Failed to resolve import "../src/service.js"».

- [ ] **Step 3: Создать `src/service.ts`**

Перенести сюда `routeProviders`, `modelIdsOf` и `readConnections` из `src/index.ts` без изменения логики, добавив типы и сервис:

```ts
import {
  DEEPSEEK_OFFICIAL_ROUTE,
  catalogKeyForRoute,
  isPresetProviderId,
  type ModelCatalogReader,
  type ModelConnection
} from "./models.js";

const LLM_PI_AI_NS = "llm-pi-ai";

export interface ModelsSettingsLike {
  get(ns: string): unknown;
  replace(ns: string, section: object): Promise<void>;
}
export interface ModelsCredentialsLike {
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}
export interface ModelsDefaultLike {
  currentSelection(): { provider: string; model: string };
  saveSelection(next: { provider: string; model: string }): Promise<void>;
}

export type ModelsServiceErrorCode = "invalid-route" | "invalid-model";

/** Invalid model selection, mapped by the HTTP layer onto a 400 + code. */
export class ModelsServiceError extends Error {
  constructor(
    readonly code: ModelsServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ModelsServiceError";
  }
}

export interface BalbesModelsService {
  list(): Promise<ModelConnection[]>;
  current(): { provider: string; model: string };
  saveDefault(provider: string, model: string): Promise<{ provider: string; model: string }>;
}

function routeProviders(settings: ModelsSettingsLike): Record<string, unknown> {
  const section = settings.get(LLM_PI_AI_NS) as { providers?: Record<string, unknown> } | undefined;
  return section?.providers ?? {};
}

function modelIdsOf(entry: unknown): string[] {
  const models = (entry as { models?: Array<{ id?: string }> })?.models;
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const m of models) if (typeof m?.id === "string") ids.push(m.id);
  return ids;
}

export async function readConnections(
  credentials: ModelsCredentialsLike,
  settings: ModelsSettingsLike,
  defaultModel: ModelsDefaultLike,
  reader: ModelCatalogReader = engineCatalogReader
): Promise<ModelConnection[]> { /* тело перенесено из src/index.ts без изменений */ }

export function createModelsService(deps: {
  settings: ModelsSettingsLike;
  credentials: ModelsCredentialsLike;
  defaultModel: ModelsDefaultLike;
  reader: ModelCatalogReader;
}): BalbesModelsService {
  return {
    list: () => readConnections(deps.credentials, deps.settings, deps.defaultModel, deps.reader),
    current: () => deps.defaultModel.currentSelection(),
    async saveDefault(provider, model) {
      const connection = (await readConnections(deps.credentials, deps.settings, deps.defaultModel, deps.reader)).find(
        (c) => c.routeId === provider
      );
      if (connection === undefined) {
        throw new ModelsServiceError("invalid-route", "no such provider connection");
      }
      if (!connection.models.includes(model)) {
        throw new ModelsServiceError("invalid-model", `model ${model} is not offered by ${provider}`);
      }
      await deps.defaultModel.saveSelection({ provider, model });
      return { provider, model };
    }
  };
}
```

Примечание: параметр `reader` в `readConnections` остаётся необязательным ровно как сегодня — `engineCatalogReader` живёт в `index.ts`; в `service.ts` объявить модульную константу нельзя, поэтому сигнатуру сделать `reader: ModelCatalogReader` обязательной и передавать его из обоих мест (`index.ts` — `engineCatalogReader`, тесты — фейк).

- [ ] **Step 4: Запустить тест сервиса**

Run: `pnpm --filter dsh-balbes-models exec vitest run tests/service.test.ts`
Expected: PASS — 3 теста.

- [ ] **Step 5: Перевести `src/index.ts` на сервис**

Удалить из `index.ts` локальные `routeProviders`, `modelIdsOf`, `readConnections` и `LLM_PI_AI_NS`; импортировать `createModelsService`, `readConnections`, `ModelsServiceError` из `./service.js`; в `ctx`-слайсе добавить `provide(key: string, value: unknown): void;`; в `apply` после чтения сервисов движка добавить:

```ts
  const modelsService = createModelsService({
    settings,
    credentials,
    defaultModel,
    reader: engineCatalogReader
  });
  ctx.provide("balbesModels", modelsService);
```

Ручка `/api/models/default` становится:

```ts
  http.post("/api/models/default", "bearer", async (_req, res, body) => {
    try {
      const b = body as { provider?: unknown; model?: unknown };
      const provider = typeof b.provider === "string" ? b.provider : "";
      const model = typeof b.model === "string" ? b.model : "";
      send(res, 200, { default: await modelsService.saveDefault(provider, model) });
    } catch (error) {
      if (error instanceof ModelsServiceError) return fail(res, 400, error.code, error.message);
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });
```

Ручка `/api/models/list` читает через сервис: `send(res, 200, { connections: await modelsService.list(), default: modelsService.current() });`. Остальные ручки (`save`/`delete`) продолжают звать `readConnections(credentials, settings, defaultModel, engineCatalogReader)` напрямую.

- [ ] **Step 6: Дополнить `tests/index.test.ts`**

В модульном ctx-дабле (`const ctx = { get(key) {…}, logger: {…} }`) добавить запись provided и метод:

```ts
  provided: {} as Record<string, unknown>,
  provide(key: string, value: unknown): void {
    this.provided[key] = value;
  }
```

и тест:

```ts
  it("provides the balbesModels service for in-process consumers", () => {
    apply(ctx, {});
    expect(typeof (ctx.provided["balbesModels"] as { list?: unknown }).list).toBe("function");
    expect((ctx.provided["balbesModels"] as { current(): unknown }).current()).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash"
    });
  });
```

(Идентификаторы `settings`/`credentials`/`agentDefaultModel` в тесте уже есть — использовать их как в соседних кейсах.)

- [ ] **Step 7: Прогнать пакет и закоммитить**

Run: `pnpm --filter dsh-balbes-models run typecheck && pnpm --filter dsh-balbes-models run test`
Expected: PASS (все прежние кейсы `/api/models/*` остаются зелёными: коды ошибок и тела не изменились).

```bash
git add packages/plugins/dsh-balbes-models
git commit -m "feat(models): expose balbesModels service over settings/credentials/default-model"
```

---

### Task 2: Регистрация команд Bot API

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/bot.ts`
- Modify: `packages/plugins/dsh-balbes-telegram/src/index.ts` (проброс в `chatBot`)
- Modify: `packages/plugins/dsh-balbes-telegram/tests/helpers/fake-bot-api.mjs`
- Test: `packages/plugins/dsh-balbes-telegram/tests/bot.test.ts`, `tests/{chat,admin,poller}.test.ts`

**Interfaces:**
- Produces: `BotClient.setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void>` и `BotClient.setChatMenuButton(button?: { type: "commands" }): Promise<void>`.

- [ ] **Step 1: Написать падающий тест клиента**

Добавить в `tests/bot.test.ts`:

```ts
  it("registers the command list and the commands menu button", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, result: true }));
    const client = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchMock) });

    await client.setMyCommands([{ command: "menu", description: "Меню и состояние" }]);
    expect((fetchMock.mock.calls[0]![0] as string).endsWith("/setMyCommands")).toBe(true);
    expect(parsedBody(fetchMock)).toEqual({ commands: [{ command: "menu", description: "Меню и состояние" }] });

    await client.setChatMenuButton();
    expect((fetchMock.mock.calls[1]![0] as string).endsWith("/setChatMenuButton")).toBe(true);
    expect(parsedBody(fetchMock)).toEqual({ menu_button: { type: "commands" } });
  });

  it("surfaces a rejected registration without leaking the token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { ok: false, error_code: 400, description: `bad token ${TOKEN}` }));
    const client = createBotClient({ token: TOKEN, apiBase: API_BASE, fetchImpl: asFetch(fetchMock), retries: 0 });

    const err = await rejectionOf(client.setMyCommands([]));
    expect(err).toBeInstanceOf(BotApiError);
    expect(err.message).not.toContain(TOKEN);
  });
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/bot.test.ts`
Expected: FAIL — «client.setMyCommands is not a function».

- [ ] **Step 3: Реализовать в `src/bot.ts`**

В интерфейс `BotClient` после `answerCallbackQuery` добавить:

```ts
  /**
   * Replace the bot's command list (Telegram's «/» autocomplete and the default
   * «Меню» button). Idempotent: the same list may be pushed on every start.
   */
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
  /** Pin the chat menu button to the command list (`{type:"commands"}`). */
  setChatMenuButton(button?: { type: "commands" }): Promise<void>;
```

и в возвращаемый объект клиента:

```ts
    async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
      await call<unknown>("setMyCommands", { commands });
    },

    async setChatMenuButton(button: { type: "commands" } = { type: "commands" }): Promise<void> {
      await call<unknown>("setChatMenuButton", { menu_button: button });
    },
```

- [ ] **Step 4: Обновить фейковые клиенты и проброс**

- `src/index.ts`, литерал `chatBot`: добавить
  `setMyCommands: (commands) => runtime.bot().setMyCommands(commands),` и
  `setChatMenuButton: (button) => runtime.bot().setChatMenuButton(button),`.
- `tests/chat.test.ts` (`makeBot`), `tests/admin.test.ts` (фейк клиента) и `tests/poller.test.ts` (объект с `getMe`) — добавить `async setMyCommands() {},` и `async setChatMenuButton() {},`.

- [ ] **Step 5: Научить фейковый Bot API отвечать на новые методы**

В `tests/helpers/fake-bot-api.mjs` в `handleMethod`, рядом с `answerCallbackQuery`:

```js
    } else if (method === "setMyCommands") {
      result = true;
    } else if (method === "setChatMenuButton") {
      result = true;
    } else if (method === "answerCallbackQuery") {
```

и в комментарии-шапке файла строкой про маршруты добавить `setMyCommands`/`setChatMenuButton` -> `true`.

- [ ] **Step 6: Прогнать и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram exec vitest run tests/bot.test.ts tests/chat.test.ts tests/admin.test.ts tests/poller.test.ts`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-telegram
git commit -m "feat(telegram): bot client registers commands and the commands menu button"
```

---

### Task 3: Живой выбор модели в раннере

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/agentTask.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts`

**Interfaces:**
- Consumes: `deps.defaultModel.currentSelection()`.
- Produces: `ModelSelectionRefLike = { current?: { provider: string; model: string }; assembled?: { provider: string; model: string } }`; `composeAgentSetup(agentCtx, { root, selection })` принимает ref вместо снимка (экспортируемая сигнатура `AgentSetupOptions.selection` меняет тип).

- [ ] **Step 1: Написать падающий тест**

В `tests/agentTask.test.ts` добавить локальный рекордер слушателей (dsh вешает на agent-scope два waterfall-слушателя, поэтому живой выбор проверяется ровно на них — без выдуманных сервисов):

```ts
/**
 * The agent-scope context a real `setup` callback receives, recording the two
 * waterfall listeners `installModelSelection` installs so a test can drive one
 * prompt-assembly + request round by hand.
 */
function makeRecordingAgentCtx(): {
  ctx: { on(event: string, listener: never): () => void; get(key: string): unknown };
  appliedModel(): Promise<string | undefined>;
} {
  const listeners = new Map<string, unknown>();
  const tools = makeTools([]);
  return {
    ctx: {
      on(event: string, listener: never): () => void {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
      get: (key: string) => (key === "tools" ? tools : undefined)
    },
    async appliedModel(): Promise<string | undefined> {
      const assemble = listeners.get("system-prompt/assemble") as unknown as (
        assembly: unknown,
        context: unknown,
        next: () => Promise<unknown>
      ) => Promise<unknown>;
      const request = listeners.get("agent/request") as unknown as (
        payload: unknown,
        next: () => Promise<unknown>
      ) => Promise<unknown>;
      await assemble({}, {}, async () => ({ variables: {} }));
      const resolved = (await request({}, async () => ({ provider: "p", model: "m" }))) as { model?: string };
      return resolved.model;
    }
  };
}
```

и сам тест:

```ts
describe("live model selection", () => {
  it("resolves every request through the current global default", async () => {
    let selection = { provider: "deepseek-official", model: "deepseek-v4-flash" };
    const recorder = makeRecordingAgentCtx();

    composeAgentSetup(recorder.ctx, {
      root: "/tmp/ws-root",
      selection: {
        get current() {
          return selection;
        },
        assembled: undefined
      }
    });

    expect(await recorder.appliedModel()).toBe("deepseek-v4-flash");

    selection = { provider: "deepseek-official", model: "deepseek-v4-pro" };

    expect(await recorder.appliedModel()).toBe("deepseek-v4-pro");
  });

  it("keeps the session id when the default changes between turns", async () => {
    const { runner, deps } = await makeRunner();
    const first = await runner.run(PROJECT_ALPHA, "первая");
    const sessionId = expectOk(first).sessionId;

    vi.spyOn(deps.defaultModel!, "currentSelection").mockReturnValue({
      provider: "deepseek-official",
      model: "deepseek-v4-pro"
    });

    const second = await runner.run(PROJECT_ALPHA, "вторая");

    expect(expectOk(second).sessionId).toBe(sessionId);
  });
});
```

Обрати внимание: `expectOk` и `makeTools` в файле уже есть, а `deps.defaultModel` — объект с `currentSelection`, поэтому `vi.spyOn` типизируется без приведения.

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.test.ts -t "live model selection"`
Expected: FAIL — второй `appliedModel()` возвращает `deepseek-v4-flash` (сессия держит снимок, а `composeAgentSetup` принимает только пару).

- [ ] **Step 3: Реализовать живой ref**

В `agentTask.ts` заменить тип и создание selection:

```ts
/** The mutable selection dsh's installModelSelection reads per step. */
export interface ModelSelectionRefLike {
  current?: { provider: string; model: string } | undefined;
  assembled?: { provider: string; model: string } | undefined;
}

/**
 * The live selection of one keyed session: `agentOptions` needs a concrete pair
 * at create/resume time, but every later request must read the CURRENT global
 * default, so a change made from the admin page or the chat reaches a session
 * that is already alive. The `assembled` slot stays owned by dsh.
 */
function liveSelection(defaultModel: AgentTaskDeps["defaultModel"]): {
  ref: ModelSelectionRefLike;
  initial: { provider: string; model: string };
} {
  const initial = defaultModel?.currentSelection() ?? { provider: "", model: "" };
  const ref: ModelSelectionRefLike = {
    get current(): { provider: string; model: string } {
      return defaultModel?.currentSelection() ?? initial;
    },
    assembled: undefined
  };
  return { ref, initial };
}
```

`AgentSetupOptions.selection` меняет тип на `ModelSelectionRefLike`, а `composeAgentSetup` передаёт ref прямо в dsh:

```ts
export function composeAgentSetup(agentCtx: unknown, options: AgentSetupOptions): void {
  installModelSelection(agentCtx as never, options.selection as never);
  /* остальное тело без изменений */
}
```

В `acquireHandle`:

```ts
    const selection = liveSelection(deps.defaultModel);
    const setup = (agentCtx: unknown): void => {
      composeAgentSetup(agentCtx, { root, selection: selection.ref });
    };
    if (opts?.sessionId !== undefined) {
      try {
        const handle = await deps.agents.resume({
          resumeSessionId: opts.sessionId,
          agentOptions: selection.initial,
          setup
        });
        return { handle, sessionId: opts.sessionId };
      /* …существующий catch без изменений… */
    }
    const sessionId = brandString(`session-${randomUUID()}`);
    const handle = await deps.agents.create({
      sessionId,
      meta: { cwd: root },
      agentOptions: selection.initial,
      setup
    });
```

Тесты, звавшие `composeAgentSetup(ctx, { root, selection: { provider, model } })`, обновить на `selection: { current: { provider, model } }`.

- [ ] **Step 4: Прогнать и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.test.ts`
Expected: PASS, включая прежние кейсы resume/create.

```bash
git add packages/plugins/dsh-balbes-telegram
git commit -m "feat(telegram): read the live global model selection per request"
```

---

### Task 4: Остановка задачи без потери контекста

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/agentTask.ts`
- Modify: `packages/plugins/dsh-balbes-telegram/src/index.ts` (проброс `cancel` в `runnerWithSessions`)
- Test: `packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts`, `tests/chat.test.ts` (фейковый раннер)

**Interfaces:**
- Produces: `AgentTaskRunner.cancel(ref: WorkspaceRef): Promise<{ cancelled: boolean; dropped: number }>`; `TaskResult` получает код `"cancelled"`; константа `CANCELLED_MESSAGE = "task cancelled by the owner"`.

- [ ] **Step 1: Написать падающие тесты**

В `tests/agentTask.test.ts` (в `makeHandle` фейковый `cancel` перестаёт быть пустой заглушкой — он моделирует abort-конвергенцию парковки и закрывает открытый turn причиной «владелец»):

```ts
    cancel: vi.fn((_cause: unknown, _options?: unknown) => {
      // Реальный Agent.cancel прерывает активный turn и разрешает парковку
      // whenIdle; turn/end с причиной "aborted" появляется только если turn
      // действительно был открыт.
      const open = events.some((event) => event.type === "turn/start") && events.at(-1)?.type !== "turn/end";
      if (open) {
        events.push({ type: "turn/end", data: { reason: { kind: "aborted", reason: { kind: "user" } } } });
      }
      releaseParked();
    }),
```

(объявление `releaseParked` нужно поднять выше объекта `agent`; `events` и `parked` уже в замыкании.)

Тесты:

```ts
describe("cancel", () => {
  it("cancels the active turn and clears the queue while keeping the session", async () => {
    const { runner, agents } = await makeRunner();
    agents.cfg({ holdIdle: true });
    const running = runner.run(PROJECT_ALPHA, "долгая");
    await waitFor(() => agents.created.length === 1);
    const handle = agents.created[0]!;
    await waitFor(() => handle.parkedCount === 1);

    const queued = runner.run(PROJECT_ALPHA, "в очереди");
    const outcome = await runner.cancel(PROJECT_ALPHA);

    expect(outcome).toEqual({ cancelled: true, dropped: 1 });
    await expect(queued).resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(running).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(runner.sessionIdOf(PROJECT_ALPHA)).toBeDefined();
  });

  it("settles a turn that was already running as cancelled", async () => {
    const { runner, agents } = await makeRunner();
    agents.cfg({ holdIdle: true });
    const running = runner.run(PROJECT_ALPHA, "долгая");
    await waitFor(() => agents.created.length === 1);
    const handle = agents.created[0]!;
    await waitFor(() => handle.parkedCount === 1);
    handle.releaseParked();                                 // пропускаем followup
    await waitFor(() => handle.agent.followup.mock.calls.length === 1);
    await waitFor(() => handle.parkedCount === 1);          // парковка после followup

    const outcome = await runner.cancel(PROJECT_ALPHA);

    expect(outcome.cancelled).toBe(true);
    await expect(running).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(handle.dispose).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing runs", async () => {
    const { runner } = await makeRunner();
    await expect(runner.cancel(PROJECT_ALPHA)).resolves.toEqual({ cancelled: false, dropped: 0 });
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.test.ts -t "cancel"`
Expected: FAIL — «runner.cancel is not a function».

- [ ] **Step 3: Реализовать `cancel`**

```ts
const CANCELLED_MESSAGE = "task cancelled by the owner";
```

В `TaskResult` добавить `"cancelled"` в объединение кодов. В `KeyedEntry` добавить поле:

```ts
  /** Set by cancel() for the current turn; cleared when that turn settles. */
  cancelled: boolean;
```

инициализировать `cancelled: false` в `run()`. В `executeTurn` после каждого существующего чекпоинта `entry.retired` добавить проверку отмены, а итог различать по причине turn'а:

```ts
      const outcome = summarizeTurn(agent.session, firstSeq);
      // Отмена подтверждается ПРИЧИНОЙ turn'а, а не только флагом: cancel,
      // пришедший в момент, когда turn уже завершался, не должен превращать
      // успешный результат в «остановлено».
      if (entry.cancelled && outcome.reason?.kind === "aborted") {
        return { ok: false, code: "cancelled", message: CANCELLED_MESSAGE };
      }
      if (entry.cancelled) entry.cancelled = false;
```

Чекпоинты до followup (после `acquireHandle`, после первого `whenIdle`) получают симметричную ветку, сохраняющую хэндл:

```ts
        if (entry.cancelled) {
          entry.cancelled = false;
          return { ok: false, code: "cancelled", message: CANCELLED_MESSAGE };
        }
```

В `startTurn`'s `finally` сбрасывать флаг (`entry.cancelled = false;`) до передачи очереди следующей задаче. Публичный метод:

```ts
    async cancel(ref: WorkspaceRef): Promise<{ cancelled: boolean; dropped: number }> {
      const key = workspaceRefKey(ref);
      const entry = cache.get(key);
      if (entry === undefined) return { cancelled: false, dropped: 0 };
      let dropped = 0;
      while (entry.queue.length > 0) {
        entry.queue.shift()!.resolve({ ok: false, code: "cancelled", message: CANCELLED_MESSAGE });
        dropped += 1;
      }
      if (!entry.busy) return { cancelled: false, dropped };
      // Мягкая отмена: сессия и хэндл остаются живыми, инбокс задач не чистится
      // (keepInbox), поэтому следующая задача продолжает ту же сессию.
      entry.cancelled = true;
      entry.handle?.agent.cancel({ kind: "user" }, { keepInbox: true });
      return { cancelled: true, dropped };
    },
```

`AgentLike` получает `cancel(cause: { kind: "user" }, options?: { keepInbox?: boolean }): void;`.

- [ ] **Step 4: Обновить проброс в `index.ts` и фейковый раннер в `chat.test.ts`**

`runnerWithSessions` (объект-литерал типа `AgentTaskRunner`) получает:

```ts
      async cancel(ref) {
        return runner.cancel(ref);
      },
```

Фейковый раннер в `tests/chat.test.ts` получает `cancel: vi.fn(async () => ({ cancelled: false, dropped: 0 }))` (сохранить рядом с `runs`/`resets`, чтобы тесты Task 9 могли его настраивать).

- [ ] **Step 5: Прогнать и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.test.ts tests/chat.test.ts`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-telegram
git commit -m "feat(telegram): cancel an active task and its queue without losing the session"
```

---

### Task 5: Сводка прогресса задачи

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/agentTask.ts`
- Modify: `packages/plugins/dsh-balbes-telegram/src/index.ts` (проброс `progress`)
- Test: `packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts`, `tests/chat.test.ts`

**Interfaces:**
- Produces: `TaskProgress` и `progress(ref: WorkspaceRef): TaskProgress` на `AgentTaskRunner`:

```ts
export interface TaskProgressStep {
  name: string;
  target?: string;
  status: "running" | "ok" | "failed";
}
export interface TaskProgressTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}
export interface TaskProgress {
  /** The workspace's own turn: a task waiting in the queue has no phase. */
  phase: "idle" | "running";
  taskText?: string;
  startedAt?: number;
  step?: number;
  steps: TaskProgressStep[];
  todos?: TaskProgressTodo[];
  queued: number;
}
```

- [ ] **Step 1: Написать падающие тесты суммаризатора**

```ts
  it("summarizes steps, targets and todos of the running turn", () => {
    const session = fakeSessionWith([
      { type: "turn/start", data: {} },
      { type: "step/start", data: { turn: 1, step: 1 } },
      { type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: '{"file_path":"notes.txt"}' } },
      { type: "tool/result", data: { turn: 1, step: 1, message: {} } },
      { type: "tool/call", data: { turn: 1, step: 2, callId: "c2", name: "write", arguments: '{"file_path":"out.txt","content":"a\\nb"}' } },
      { type: "todo/write", data: { todos: [{ content: "Разобрать логи", status: "completed" }] } }
    ]);

    const progress = summarizeProgress(session, SessionSeqLike(0), 5);

    expect(progress.steps).toEqual([
      { name: "read", target: "notes.txt", status: "ok" },
      { name: "write", target: "out.txt", status: "running" }
    ]);
    expect(progress.todos).toEqual([{ content: "Разобрать логи", status: "completed" }]);
  });

  it("never renders file content or long targets", () => {
    const long = "x".repeat(500);
    const session = fakeSessionWith([
      { type: "turn/start", data: {} },
      { type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "write", arguments: JSON.stringify({ file_path: `${long}\n\nsecret`, content: "СОДЕРЖИМОЕ" }) } }
    ]);

    const line = summarizeProgress(session, SessionSeqLike(0), 5).steps[0]!;

    expect(line.target).toBe(`${"x".repeat(80)}…`);
    expect(JSON.stringify(line)).not.toContain("СОДЕРЖИМОЕ");
  });

  it("reports an idle phase and the queue depth", async () => {
    const runner = await makeRunner();
    expect(runner.progress(PROJECT_ALPHA)).toEqual({ phase: "idle", steps: [], queued: 0 });
  });
```

`fakeSessionWith(events)` и `SessionSeqLike(n)` — маленькие локальные хелперы, повторяющие фейковую сессию из `makeHandle`:

```ts
/** A session whose log is exactly `events`, for pure summarizer tests. */
function fakeSessionWith(events: EventLike[]): { seq: number; eventAt(seq: unknown): EventLike | undefined } {
  return {
    get seq(): number {
      return events.length;
    },
    eventAt: (seq: unknown) => events[Number(seq)]
  };
}
const SessionSeqLike = (n: number): never => n as never;
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.test.ts -t "summar"` 
Expected: FAIL — `summarizeProgress` не экспортируется.

- [ ] **Step 3: Реализовать суммаризатор**

Экспортируемая чистая функция рядом с `summarizeTurn`:

```ts
/**
 * Arguments worth showing in the progress card, by tool. Everything else is
 * omitted: `write`/`edit` arguments carry whole file bodies, and a card that
 * rendered them would push workspace content into the chat.
 */
const PROGRESS_TARGET_ARG: Record<string, string> = {
  read: "file_path",
  read_image: "file_path",
  write: "file_path",
  edit: "file_path",
  glob: "path",
  grep: "path",
  web_search: "query"
};
const PROGRESS_TARGET_MAX = 80;
const PROGRESS_STEP_MAX = 5;

function progressTarget(tool: string, rawArguments: string): string | undefined {
  const argName = PROGRESS_TARGET_ARG[tool];
  if (argName === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return undefined;
  }
  const value = (parsed as Record<string, unknown> | undefined)?.[argName];
  if (typeof value !== "string" || value === "") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed === "") return undefined;
  return collapsed.length > PROGRESS_TARGET_MAX ? `${collapsed.slice(0, PROGRESS_TARGET_MAX)}…` : collapsed;
}

/** Steps, todo list and step number of one turn's event slice. */
export function summarizeProgress(
  session: AgentLike["session"],
  firstSeq: number,
  limit = PROGRESS_STEP_MAX
): { steps: TaskProgressStep[]; todos?: TaskProgressTodo[]; step?: number } {
  const byCallId = new Map<string, TaskProgressStep>();
  const steps: TaskProgressStep[] = [];
  let todos: TaskProgressTodo[] | undefined;
  let step: number | undefined;
  let started = false;
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    if (event.type === "turn/start") started = true;
    if (!started) continue;
    const data = event.data as {
      step?: number;
      callId?: string;
      name?: string;
      arguments?: string;
      error?: unknown;
      todos?: TaskProgressTodo[];
    };
    if (event.type === "step/start" && typeof data.step === "number") step = data.step;
    if (event.type === "todo/write" && Array.isArray(data.todos)) {
      todos = data.todos.map((todo) => ({ content: todo.content, status: todo.status }));
    }
    if (event.type === "tool/call" && typeof data.callId === "string" && typeof data.name === "string") {
      const line: TaskProgressStep = { name: data.name, status: "running" };
      const target = progressTarget(data.name, data.arguments ?? "");
      if (target !== undefined) line.target = target;
      byCallId.set(data.callId, line);
      steps.push(line);
    }
    if (event.type === "tool/result" && typeof data.callId === "string") {
      const line = byCallId.get(data.callId);
      if (line !== undefined) line.status = data.error === undefined ? "ok" : "failed";
    }
  }
  const out: { steps: TaskProgressStep[]; todos?: TaskProgressTodo[]; step?: number } = {
    steps: steps.slice(Math.max(0, steps.length - limit))
  };
  if (todos !== undefined) out.todos = todos;
  if (step !== undefined) out.step = step;
  return out;
}
```

`SessionEventLike.data` расширить полями `callId?: string; name?: string; arguments?: string; step?: number; todos?: TaskProgressTodo[]; error?: unknown`.

- [ ] **Step 4: Отдать `progress(ref)` из раннера**

`KeyedEntry` получает `firstSeq?: number` и `startedAt?: number`; в `executeTurn` перед `followup`:

```ts
      entry.firstSeq = agent.session.seq;
      entry.startedAt = Date.now();
```

(и обнулять `entry.firstSeq = undefined; entry.startedAt = undefined;` в `finally` у `startTurn`). Публичный метод:

```ts
    progress(ref: WorkspaceRef): TaskProgress {
      const entry = cache.get(workspaceRefKey(ref));
      if (entry === undefined) return { phase: "idle", steps: [], queued: 0 };
      const queued = entry.queue.length;
      if (!entry.busy || entry.handle === undefined || entry.firstSeq === undefined) {
        return { phase: "idle", steps: [], queued };
      }
      const summary = summarizeProgress(entry.handle.agent.session, entry.firstSeq);
      const out: TaskProgress = {
        phase: "running",
        steps: summary.steps,
        queued,
        startedAt: entry.startedAt ?? Date.now()
      };
      if (entry.activeText !== undefined) out.taskText = entry.activeText;
      if (summary.step !== undefined) out.step = summary.step;
      if (summary.todos !== undefined) out.todos = summary.todos;
      return out;
    },
```

`AgentTaskRunner` объявляет `progress(ref: WorkspaceRef): TaskProgress;`.

- [ ] **Step 5: Обновить проброс и фейковый раннер**

`index.ts`, `runnerWithSessions`: `progress: (ref) => runner.progress(ref),`.
`tests/chat.test.ts`, фейковый раннер: `progress: vi.fn(() => ({ phase: "idle", steps: [], queued: 0 }))`.

- [ ] **Step 6: Прогнать и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.test.ts tests/chat.test.ts`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-telegram
git commit -m "feat(telegram): summarize task progress from the session log"
```

---

### Task 6: Карточки `cards.ts`

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/src/cards.ts`
- Modify: `packages/plugins/dsh-balbes-telegram/src/keyboards.ts` (позже, в Task 8 — не сейчас)
- Test: `packages/plugins/dsh-balbes-telegram/tests/cards.test.ts`

**Interfaces:**
- Consumes: `InlineKeyboardMarkup`, `InlineKeyboardButton` из `./keyboards.js`; `TaskProgress`, `TaskProgressStep`, `TaskProgressTodo` из `./agentTask.js`.
- Produces: `formatElapsed(ms: number): string`; `CardView = { text: string; keyboard: InlineKeyboardMarkup }`; `menuCard(opts)`, `modelConnectionsCard(opts)`, `modelListCard(opts)`, `progressCard(opts)`, `queuedCard(opts)`, `receiptCard(opts)`; константы текстов `MENU_TITLE`, `TASK_IDLE_LINE`, `NO_ACTIVE_WORKSPACE_LINE`, `STOP_IDLE_ANSWER`, `MODEL_HINT`, `NO_KEY_HINT`, `MODELS_UNAVAILABLE`, `HELP_TEXT`, `UNKNOWN_COMMAND`.

- [ ] **Step 1: Написать падающие тесты**

Создать `tests/cards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  menuCard,
  modelConnectionsCard,
  modelListCard,
  progressCard,
  queuedCard,
  receiptCard
} from "../src/cards.js";

const data = (card: { keyboard: { inline_keyboard: Array<Array<{ callback_data: string }>> } }): string[] =>
  card.keyboard.inline_keyboard.flat().map((button) => button.callback_data);

describe("formatElapsed", () => {
  it("renders m:ss below an hour and h:mm:ss above", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(134_000)).toBe("2:14");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });
});

describe("menuCard", () => {
  it("shows workspace, model, task line and the action grid", () => {
    const card = menuCard({
      workspaceLabel: "Проект: balbes",
      modelLabel: "deepseek-v4-pro · deepseek-official",
      taskLine: "выполняется · 2:14 · шаг 5",
      queue: 1
    });

    expect(card.text).toContain("🤖 Агент сервера");
    expect(card.text).toContain("Воркспейс: Проект: balbes");
    expect(card.text).toContain("Модель: deepseek-v4-pro · deepseek-official");
    expect(card.text).toContain("Задача: выполняется · 2:14 · шаг 5");
    expect(card.text).toContain("Очередь: 1");
    expect(data(card)).toEqual(["act:files", "mdl", "ws", "act:reset", "stp", "mnu:refresh"]);
  });

  it("offers only workspace and model buttons without an active workspace", () => {
    const card = menuCard({ workspaceLabel: undefined, modelLabel: undefined, taskLine: "нет активной задачи", queue: 0 });

    expect(card.text).toContain("Воркспейс не выбран");
    expect(data(card)).toEqual(["ws", "mdl", "mnu:refresh"]);
  });
});

describe("model cards", () => {
  it("marks the current connection and refuses the keyless one", () => {
    const card = modelConnectionsCard({
      currentLabel: "deepseek-v4-pro · deepseek-official",
      rows: [
        { index: 0, label: "DeepSeek (официальный)", selectable: true, isDefault: true },
        { index: 1, label: "OpenAI (нет ключа)", selectable: false, isDefault: false }
      ],
      page: 0,
      pages: 1
    });

    expect(data(card)).toEqual(["mdl:c:0", "mdl:c:1", "mnu"]);
    expect(card.keyboard.inline_keyboard[0]![0]!.text).toContain("• ");
    expect(card.keyboard.inline_keyboard[1]![0]!.text).toContain("нет ключа");
  });

  it("pages a long model list and marks the active model", () => {
    const models = Array.from({ length: 10 }, (_, i) => `m-${i}`);
    const card = modelListCard({ label: "DeepSeek (официальный)", models, page: 1, pages: 2, currentModel: "m-8" });

    expect(data(card)).toEqual(["mdl:m:8", "mdl:m:9", "mdl:pg:0", "mdl:pg:1", "mdl:back"]);
    expect(card.keyboard.inline_keyboard[0]![0]!.text).toContain("• m-8");
  });
});

describe("progressCard", () => {
  it("renders todos, steps and the stop/menu row", () => {
    const card = progressCard({
      workspaceLabel: "Проект: balbes",
      taskText: "починить парсер",
      elapsedMs: 72_000,
      step: 4,
      steps: [
        { name: "read", target: "notes.txt", status: "ok" },
        { name: "grep", target: "TODO", status: "ok" },
        { name: "edit", target: "notes.txt", status: "running" }
      ],
      todos: [
        { content: "Разобрать логи", status: "completed" },
        { content: "Починить парсер", status: "in_progress" }
      ],
      queued: 0
    });

    expect(card.text).toContain("⏳ Проект: balbes · 1:12 · шаг 4");
    expect(card.text).toContain("☑ Разобрать логи");
    expect(card.text).toContain("▸ Починить парсер");
    expect(card.text).toContain("🔧 edit notes.txt …");
    expect(card.text).toContain("🔧 read notes.txt ✔");
    expect(data(card)).toEqual(["stp", "mnu"]);
  });

  it("never renders a tool result body", () => {
    const card = progressCard({
      workspaceLabel: "Проект: balbes",
      taskText: "t",
      elapsedMs: 1000,
      steps: [{ name: "grep", status: "ok" }],
      queued: 0
    });

    expect(card.text).toContain("🔧 grep ✔");
  });
});

describe("queuedCard", () => {
  it("states the task's place in the queue and offers stop", () => {
    const card = queuedCard({ workspaceLabel: "Проект: balbes", taskText: "вторая", position: 2 });

    expect(card.text).toContain("🕓 Проект: balbes");
    expect(card.text).toContain("в очереди №2");
    expect(card.text).toContain("вторая");
    expect(data(card)).toEqual(["stp", "mnu"]);
  });
});

describe("receiptCard", () => {  it("replaces the stop row with a menu row and states the outcome", () => {
    expect(receiptCard({ kind: "done", elapsedMs: 100_000, steps: 6 }).text).toBe("✅ Готово · 1:40 · 6 шагов");
    expect(receiptCard({ kind: "stopped", elapsedMs: 10_000, steps: 2 }).text).toBe("⏹ Остановлено владельцем · 0:10");
    expect(receiptCard({ kind: "reset", elapsedMs: 10_000, steps: 2 }).text).toBe("⏹ Остановлено сбросом контекста");
    expect(receiptCard({ kind: "error", elapsedMs: 10_000, steps: 2 }).text).toBe("⚠️ Ошибка · 0:10");
    expect(data(receiptCard({ kind: "done", elapsedMs: 1, steps: 0 }))).toEqual(["mnu"]);
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/cards.test.ts`
Expected: FAIL — «Failed to resolve import "../src/cards.js"».

- [ ] **Step 3: Реализовать `src/cards.ts`**

```ts
/**
 * Pure builders of the owner's cards: every function returns the exact text and
 * inline keyboard one message needs. No I/O, no bot client, no state — the chat
 * machine owns snapshots and dispatch, this module owns copy and layout.
 */
import type { TaskProgressStep, TaskProgressTodo } from "./agentTask.js";
import type { InlineKeyboardMarkup } from "./keyboards.js";

export interface CardView {
  text: string;
  keyboard: InlineKeyboardMarkup;
}

export const MENU_TITLE = "🤖 Агент сервера";
export const TASK_IDLE_LINE = "нет активной задачи";
export const NO_ACTIVE_WORKSPACE_LINE = "Воркспейс не выбран";
export const STOP_IDLE_ANSWER = "Сейчас ничего не выполняется";
export const MODEL_HINT = "Смена применится со следующего шага; текущий шаг доигрывает на прежней модели.";
export const NO_KEY_HINT = "Ключ не задан — добавьте в админке";
export const MODELS_UNAVAILABLE = "Раздел моделей недоступен";
export const UNKNOWN_COMMAND = "Не знаю такой команды.";
export const HELP_TEXT = [
  "/menu — меню и состояние",
  "/status — воркспейс, модель, задача, очередь",
  "/ws — сменить воркспейс",
  "/model — сменить модель",
  "/reset — сбросить контекст (сессия удаляется)",
  "/stop — остановить задачу (контекст сохраняется)",
  "/help — эта справка.",
  "Любой другой текст уходит агенту как задача."
].join("\n");

/** `m:ss` below one hour, `h:mm:ss` above. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

const MENU_BUTTON = { text: "⬅ Меню", callback_data: "mnu" } as const;
const REFRESH_ROW = [{ text: "🔄 Обновить", callback_data: "mnu:refresh" }];

export function menuCard(opts: {
  workspaceLabel: string | undefined;
  modelLabel: string | undefined;
  taskLine: string;
  queue: number;
  sessionLabel?: string;
}): CardView {
  const lines = [MENU_TITLE, ""];
  lines.push(`Воркспейс: ${opts.workspaceLabel ?? NO_ACTIVE_WORKSPACE_LINE}`);
  if (opts.modelLabel !== undefined) lines.push(`Модель: ${opts.modelLabel}`);
  lines.push(`Задача: ${opts.taskLine}`);
  if (opts.sessionLabel !== undefined) lines.push(`Сессия: ${opts.sessionLabel}`);
  if (opts.queue > 0) lines.push(`Очередь: ${opts.queue}`);
  const rows = opts.workspaceLabel === undefined
    ? [
        [{ text: "📁 Воркспейсы", callback_data: "ws" }],
        [{ text: "🧠 Модель", callback_data: "mdl" }],
        REFRESH_ROW
      ]
    : [
        [
          { text: "📄 Файлы", callback_data: "act:files" },
          { text: "🧠 Модель", callback_data: "mdl" }
        ],
        [
          { text: "📁 Воркспейс", callback_data: "ws" },
          { text: "🔄 Сбросить контекст", callback_data: "act:reset" }
        ],
        [
          { text: "⏹ Стоп", callback_data: "stp" },
          ...REFRESH_ROW
        ]
      ];
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}

export function modelConnectionsCard(opts: {
  currentLabel: string | undefined;
  rows: Array<{ index: number; label: string; selectable: boolean; isDefault: boolean }>;
  page: number;
  pages: number;
}): CardView {
  const header = opts.currentLabel === undefined
    ? "🧠 Модель"
    : `🧠 Модель сейчас: ${opts.currentLabel}`;
  const lines = [header, "", "Выберите соединение:"];
  const rows = opts.rows.map((row) => [
    { text: `${row.isDefault ? "• " : ""}${row.label}`, callback_data: `mdl:c:${row.index}` }
  ]);
  if (opts.pages > 1) rows.push(paginationRow("mdl:pg", opts.page, opts.pages));
  rows.push([MENU_BUTTON]);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}

export function modelListCard(opts: {
  label: string;
  models: string[];
  page: number;
  pages: number;
  currentModel?: string;
}): CardView {
  const rows = opts.models.map((model, offset) => [
    { text: `${opts.currentModel === model ? "• " : ""}${model}`, callback_data: `mdl:m:${opts.page * PAGE_SIZE + offset}` }
  ]);
  if (opts.pages > 1) rows.push(paginationRow("mdl:pg", opts.page, opts.pages));
  rows.push([{ text: "⬅ Назад", callback_data: "mdl:back" }, MENU_BUTTON]);
  return {
    text: [`🧠 ${opts.label}`, "", "Выберите модель:", MODEL_HINT].join("\n"),
    keyboard: { inline_keyboard: rows }
  };
}

const STEP_MARK: Record<TaskProgressStep["status"], string> = { running: "…", ok: "✔", failed: "✖" };
const TODO_MARK: Record<TaskProgressTodo["status"], string> = { completed: "☑", in_progress: "▸", pending: "☐" };

export function progressCard(opts: {
  workspaceLabel: string;
  taskText: string;
  elapsedMs: number;
  step?: number;
  steps: TaskProgressStep[];
  todos?: TaskProgressTodo[];
  queued: number;
}): CardView {
  const head = `⏳ ${opts.workspaceLabel} · ${formatElapsed(opts.elapsedMs)}${opts.step === undefined ? "" : ` · шаг ${opts.step}`}`;
  const lines = [head];
  if (opts.todos !== undefined && opts.todos.length > 0) {
    lines.push("", ...opts.todos.map((todo) => `${TODO_MARK[todo.status]} ${todo.content}`));
  }
  if (opts.steps.length > 0) {
    lines.push("", ...opts.steps.map((step) => `🔧 ${step.name}${step.target === undefined ? "" : ` ${step.target}`} ${STEP_MARK[step.status]}`));
  }
  if (opts.queued > 0) lines.push("", `Очередь: ${opts.queued}`);
  return {
    text: lines.join("\n"),
    keyboard: { inline_keyboard: [[{ text: "⏹ Стоп", callback_data: "stp" }, MENU_BUTTON]] }
  };
}

/**
 * A task accepted while another one runs: the card states its place in the
 * queue and carries the same stop button, so the owner can cancel before the
 * task ever starts. The chat replaces it with a live progress card once this
 * task's own turn begins.
 */
export function queuedCard(opts: { workspaceLabel: string; taskText: string; position: number }): CardView {
  return {
    text: [`🕓 ${opts.workspaceLabel} · в очереди №${opts.position}`, "", opts.taskText].join("\n"),
    keyboard: { inline_keyboard: [[{ text: "⏹ Стоп", callback_data: "stp" }, MENU_BUTTON]] }
  };
}

export function receiptCard(opts: {  kind: "done" | "stopped" | "reset" | "error";
  elapsedMs: number;
  steps: number;
  detail?: string;
}): CardView {
  const elapsed = formatElapsed(opts.elapsedMs);
  const text =
    opts.kind === "done"
      ? `✅ Готово · ${elapsed} · ${opts.steps} шагов`
      : opts.kind === "stopped"
        ? `⏹ Остановлено владельцем · ${elapsed}`
        : opts.kind === "reset"
          ? "⏹ Остановлено сбросом контекста"
          : `⚠️ Ошибка · ${elapsed}${opts.detail === undefined ? "" : `: ${opts.detail}`}`;
  return { text, keyboard: { inline_keyboard: [[MENU_BUTTON]] } };
}
```

Импортировать `paginationRow` из `./keyboards.js` (он уже экспортируется) и объявить `const PAGE_SIZE = 8;` (модульная константа страницы списка моделей; чат передаёт тот же размер страницы, что и в своих списках).

- [ ] **Step 4: Прогнать и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram exec vitest run tests/cards.test.ts`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-telegram/src/cards.ts packages/plugins/dsh-balbes-telegram/tests/cards.test.ts
git commit -m "feat(telegram): pure card builders for menu, model, progress and receipts"
```

---

### Task 7: Таблица команд `commands.ts`

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/src/commands.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/commands.test.ts`

**Interfaces:**
- Produces: `TELEGRAM_COMMANDS: Array<{ command: string; description: string }>` (тот же массив уходит в `setMyCommands`), `COMMAND_NAMES`, `parseCommand(text: string): CommandName | "unknown" | undefined`.

- [ ] **Step 1: Написать падающий тест**

```ts
import { describe, expect, it } from "vitest";
import { TELEGRAM_COMMANDS, parseCommand } from "../src/commands.js";

describe("command table", () => {
  it("is a Telegram-valid list and names exactly the routed commands", () => {
    expect(TELEGRAM_COMMANDS.map((c) => c.command)).toEqual(["menu", "status", "ws", "model", "reset", "stop", "help"]);
    for (const entry of TELEGRAM_COMMANDS) {
      expect(entry.command).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe("parseCommand", () => {
  it("routes every registered command, including /start as menu", () => {
    expect(parseCommand("/menu")).toBe("menu");
    expect(parseCommand("/start")).toBe("menu");
    expect(parseCommand("/ws")).toBe("ws");
    expect(parseCommand("/model")).toBe("model");
    expect(parseCommand("/reset")).toBe("reset");
    expect(parseCommand("/stop")).toBe("stop");
    expect(parseCommand("/status")).toBe("status");
    expect(parseCommand("/help")).toBe("help");
  });

  it("strips the bot mention, ignores case and surrounding spaces", () => {
    expect(parseCommand("  /Menu@balbes_test_bot ")).toBe("menu");
    expect(parseCommand("/MODEL")).toBe("model");
  });

  it("reports unknown commands and leaves plain text alone", () => {
    expect(parseCommand("/foo")).toBe("unknown");
    expect(parseCommand("/")).toBe("unknown");
    expect(parseCommand("Воркспейсы")).toBeUndefined();
    expect(parseCommand("почини /etc/hosts в проекте")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/commands.test.ts`
Expected: FAIL — «Failed to resolve import "../src/commands.js"».

- [ ] **Step 3: Реализовать `src/commands.ts`**

```ts
/**
 * The channel's command surface, in one place: the same table feeds the Bot API
 * registration (`setMyCommands`) and the text router, so the list a owner sees in
 * Telegram can never drift from what the bot actually answers. A text command
 * never reaches the agent — that invariant lives here.
 */

export type CommandName = "menu" | "status" | "ws" | "model" | "reset" | "stop" | "help";

export interface CommandSpec {
  command: CommandName;
  description: string;
}

/** Telegram command limits: lowercase latin name ≤ 32 chars, description ≤ 256. */
export const TELEGRAM_COMMANDS: CommandSpec[] = [
  { command: "menu", description: "Меню и состояние" },
  { command: "status", description: "Статус: воркспейс, модель, задача, очередь" },
  { command: "ws", description: "Сменить воркспейс" },
  { command: "model", description: "Сменить модель" },
  { command: "reset", description: "Сбросить контекст" },
  { command: "stop", description: "Остановить задачу" },
  { command: "help", description: "Справка" }
];

export const COMMAND_NAMES: ReadonlySet<string> = new Set<string>(TELEGRAM_COMMANDS.map((spec) => spec.command));

/**
 * Classify one text message: a known command, an unknown command ("unknown"), or
 * not a command at all (undefined — it is a task). `/start` is the Telegram
 * entry point and maps onto the menu.
 */
export function parseCommand(text: string): CommandName | "unknown" | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const bare = trimmed.slice(1).split("@", 1)[0]!.toLowerCase();
  if (bare === "start") return "menu";
  return COMMAND_NAMES.has(bare) ? (bare as CommandName) : "unknown";
}
```

- [ ] **Step 4: Прогнать и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/commands.test.ts`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-telegram/src/commands.ts packages/plugins/dsh-balbes-telegram/tests/commands.test.ts
git commit -m "feat(telegram): command table shared by registration and routing"
```

---

### Task 8: Чат — команды, карточка-меню, `/stop`

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/chat.ts`
- Modify: `packages/plugins/dsh-balbes-telegram/src/keyboards.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/chat.test.ts`, `tests/keyboards.test.ts`

**Interfaces:**
- Consumes: `cards.ts` (`menuCard`, `receiptCard`, `MENU_TITLE`, `TASK_IDLE_LINE`, `NO_ACTIVE_WORKSPACE_LINE`, `STOP_IDLE_ANSWER`, `HELP_TEXT`, `UNKNOWN_COMMAND`, `formatElapsed`), `commands.ts` (`parseCommand`), `runner.cancel`, `runner.progress`.
- Produces: `ChatDeps.models?: ModelsSlice` (используется в Task 9); карточка-меню; обработчики callback `mnu`, `mnu:refresh`, `stp`.

- [ ] **Step 1: Написать падающие тесты**

В `tests/chat.test.ts` (в конце файла — новый `describe`):

```ts
describe("chat machine: commands and menu card", () => {
  it("/start and /menu render the menu card as a new message", async () => {
    const h = makeHarness();
    await h.machine.onMessage(message("/start"));

    expect(h.bot.sent).toHaveLength(1);
    expect(h.bot.sent[0]!.text).toContain("🤖 Агент сервера");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["ws", "mdl", "mnu:refresh"]);
  });

  it("an unknown command answers with the card and never reaches the agent", async () => {
    const h = makeHarness();
    await h.machine.onMessage(message("/foo"));

    expect(h.runner.runs).toHaveLength(0);
    expect(h.bot.sent[0]!.text).toContain("Не знаю такой команды.");
  });

  it("/help answers with the reference text", async () => {
    const h = makeHarness();
    await h.machine.onMessage(message("/help"));

    expect(h.bot.sent[0]!.text).toContain("/stop — остановить задачу (контекст сохраняется)");
  });

  it("the menu card reflects the active workspace and the live task line", async () => {
    const h = makeHarness();
    await h.machine.setActiveWorkspace(HOME);
    await h.machine.onMessage(message("/status"));

    expect(h.bot.sent[0]!.text).toContain("Воркспейс: Дом агента");
    expect(h.bot.sent[0]!.text).toContain("Задача: нет активной задачи");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["act:files", "mdl", "ws", "act:reset", "stp", "mnu:refresh"]);
  });

  it("mnu:refresh re-renders the card in place", async () => {
    const h = makeHarness();
    const sentId = (await h.machine.onMessage(message("/menu")), h.bot.sent[0]!.messageId);

    await h.machine.onCallback(callback("mnu:refresh", sentId));

    expect(h.bot.lastEdit().messageId).toBe(sentId);
    expect(h.bot.lastEdit().text).toContain("🤖 Агент сервера");
  });
});

describe("chat machine: stop", () => {
  it("stops the running task, reports the dropped queue and keeps the context", async () => {
    const h = makeHarness();
    await h.machine.setActiveWorkspace(HOME);
    h.runner.cancel.mockResolvedValue({ cancelled: true, dropped: 2 });

    const sentId = (await h.machine.onMessage(message("/menu")), h.bot.sent[0]!.messageId);
    await h.machine.onCallback(callback("stp", sentId));

    expect(h.runner.cancel).toHaveBeenCalledWith(HOME);
    expect(h.bot.sent.at(-1)!.text).toBe(
      "Остановил. Отменено задач в очереди: 2. Контекст сохранён — можно ставить новую задачу."
    );
  });

  it("answers «Сейчас ничего не выполняется» without a message when idle", async () => {
    const h = makeHarness();
    await h.machine.setActiveWorkspace(HOME);
    h.runner.cancel.mockResolvedValue({ cancelled: false, dropped: 0 });

    await h.machine.onCallback(callback("stp", 777));

    expect(h.bot.answers.at(-1)!.text).toBe("Сейчас ничего не выполняется");
  });
});
```

`makeHarness` дополняется так, чтобы `h.runner.cancel` был доступен (Task 4 его уже добавил), а `h.machine.setActiveWorkspace` берётся из `ChatMachine`.

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/chat.test.ts -t "commands and menu card"`
Expected: FAIL — `/start` по-прежнему отвечает «Привет! Я агент твоего сервера.».

- [ ] **Step 3: Реализовать в `src/chat.ts`**

1. Импорты: `menuCard`, `receiptCard`, `HELP_TEXT`, `MENU_TITLE`, `NO_ACTIVE_WORKSPACE_LINE`, `STOP_IDLE_ANSWER`, `TASK_IDLE_LINE`, `UNKNOWN_COMMAND`, `formatElapsed` из `./cards.js`; `parseCommand` из `./commands.js`.
2. Удалить константы `WELCOME` и `TASK_HINT`; добавить:

```ts
const TASK_ANSWER_DELAY_HINT = "Отправьте задачу текстом — я выполню её в этом воркспейсе.";
const STOP_HINT = "Остановил.";
const STOP_CONTEXT_SAVED = "Контекст сохранён — можно ставить новую задачу.";
const STOP_DROPPED = (count: number): string => `Отменено задач в очереди: ${count}.`;
```

3. Функция сборки карточки-меню:

```ts
  /** The owner's single control panel: live state plus every action. */
  async function menuView(opts: { extended?: boolean } = {}): Promise<{ text: string; keyboard: InlineKeyboardMarkup }> {
    const ref = active;
    const progress = ref === undefined ? undefined : deps.runner.progress(ref);
    const model = deps.models?.current();
    const taskLine =
      progress === undefined || progress.phase === "idle"
        ? TASK_IDLE_LINE
        : [`выполняется`, formatElapsed(Date.now() - (progress.startedAt ?? Date.now())), progress.step === undefined ? undefined : `шаг ${progress.step}`]
            .filter((part): part is string => part !== undefined)
            .join(" · ");
    const card = menuCard({
      workspaceLabel: ref === undefined ? undefined : refLabel(ref),
      modelLabel: model === undefined ? undefined : `${model.model} · ${model.provider}`,
      taskLine,
      queue: progress?.queued ?? 0,
      ...(opts.extended === true
        ? { sessionLabel: ref !== undefined && deps.runner.sessionIdOf(ref) !== undefined ? "активна" : "не создана" }
        : {})
    });
    return { text: card.text, keyboard: card.keyboard };
  }
```

4. Отправка и редактирование карточки (одна точка, чтобы карточка была и «новым сообщением», и правкой на месте):

```ts
  /** Send the menu card as a new message and remember it for its own buttons. */
  async function sendMenu(chatId: number): Promise<void> {
    const view = await menuView();
    const messageId = await send(chatId, view.text, view.keyboard);
    if (messageId !== undefined) putSnapshot(messageId, { kind: "menu", chatId });
  }

  /** Re-render the menu card into the message it lives in. */
  async function renderMenu(chatId: number, messageId: number, extended = false): Promise<void> {
    const view = await menuView({ extended });
    putSnapshot(messageId, { kind: "menu", chatId });
    await edit(chatId, messageId, view.text, view.keyboard);
  }
```

и новый вид снапшота `interface MenuSnapshot { kind: "menu"; chatId: number; }` в объединении `Snapshot` (кнопки меню — чистые коды, снапшот нужен, чтобы `mnu:refresh` знал, что сообщение — карточка).

5. `onMessage` переписывается на таблицу команд:

```ts
    async onMessage(update: MessageUpdate): Promise<void> {
      const text = update.text.trim();
      const command = parseCommand(text);
      if (command !== undefined) {
        if (command === "unknown") {
          await send(update.chatId, UNKNOWN_COMMAND);
          await sendMenu(update.chatId);
          return;
        }
        if (command === "help") {
          await send(update.chatId, HELP_TEXT);
          return;
        }
        if (command === "menu" || command === "status") {
          await sendMenu(update.chatId);
          return;
        }
        if (command === "ws") {
          /* существующая ветка LIST_COMMANDS без изменений */
          return;
        }
        if (command === "model") {
          await sendModelsCard(update.chatId);   // Task 9
          return;
        }
        if (command === "reset") {
          await sendResetConfirm(update.chatId); // вынесенное подтверждение сброса
          return;
        }
        // stop
        await stopTask(update.chatId);
        return;
      }
      /* дальше существующая логика: пустое сообщение, нет активного воркспейса, запуск задачи */
    },
```

`LIST_COMMANDS` и прежняя ветка `isCommand(...) → WELCOME` удаляются; `isCommand` больше не импортируется. Прежний текст «Активный воркспейс: …» (для пустого сообщения) заменяется на `await sendMenu(update.chatId)`.

6. `/stop`:

```ts
  /** Stop the active task and clear the queue; the session survives. */
  async function stopTask(chatId: number): Promise<void> {
    const ref = active;
    if (ref === undefined) {
      await send(chatId, NO_ACTIVE_HINT, menuCard({ /* см. ниже */ }).keyboard);
      return;
    }
    const outcome = await deps.runner.cancel(ref);
    if (!outcome.cancelled && outcome.dropped === 0) {
      await send(chatId, STOP_IDLE_ANSWER);
      return;
    }
    const parts = [STOP_HINT];
    if (outcome.dropped > 0) parts.push(STOP_DROPPED(outcome.dropped));
    parts.push(STOP_CONTEXT_SAVED);
    await send(chatId, parts.join(" "));
  }
```

(в ветке «нет активного воркспейса» используется `sendMenu` после подсказки — `NO_ACTIVE_HINT` остаётся константой, а клавиатура берётся из `await menuView()`.)

7. Callback-диспетчер: заменить `data === "menu"` на `mnu` (перерисовать карточку в том же сообщении) и добавить:

```ts
    if (data === "mnu") {
      await renderMenu(chatId, messageId);
      return undefined;
    }
    if (data === "mnu:refresh") {
      await renderMenu(chatId, messageId, true);
      return undefined;
    }
    if (data === "stp") {
      const ref = active;
      if (ref === undefined) return STOP_IDLE_ANSWER;
      const outcome = await deps.runner.cancel(ref);
      if (!outcome.cancelled && outcome.dropped === 0) return STOP_IDLE_ANSWER;
      const parts = [STOP_HINT];
      if (outcome.dropped > 0) parts.push(STOP_DROPPED(outcome.dropped));
      parts.push(STOP_CONTEXT_SAVED);
      await send(chatId, parts.join(" "));
      return undefined;
    }
```

Ветки `act:task`, `act:files`, `act:ws`, `act:reset` продолжают работать: `act:task` вместо текста «Активный воркспейс…» вызывает `renderMenu(chatId, messageId, true)`, `act:ws` — прежний список воркспейсов, `act:reset` — прежнее подтверждение (тот же код, теперь доступный и по команде `/reset` через `sendResetConfirm`, которая отправляет новое сообщение с `resetConfirmKeyboard()` и регистрирует `reset`-снапшот под его id).

8. Прочие места, где использовался `menuKeyboard()`, перевести на карточку: `LIST_FAILED`, `NO_ACTIVE_HINT`, `WORKSPACE_GONE`, `act:files` при ошибке открытия (`workspaceActionsKeyboard()` → `(await menuView()).keyboard`). Из `keyboards.ts` удалить `menuKeyboard` и `workspaceActionsKeyboard`, а из `tests/keyboards.test.ts` — их тесты.

9. Обновить существующие ожидания в `tests/chat.test.ts`: строки 298/311/401 («Привет! Я агент твоего сервера.») → проверки карточки; кейс «a text message «Воркспейсы» renders the list as a new message» остаётся (текст «Воркспейсы» не команда и `LIST_COMMANDS` больше не нужен — вместо него команда `/ws`; сохранить поддержку текста «Воркспейсы» явной проверкой `text === "Воркспейсы"` перед `parseCommand`).

- [ ] **Step 4: Прогнать и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram exec vitest run tests/chat.test.ts tests/keyboards.test.ts`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-telegram
git commit -m "feat(telegram): command routing, menu card and stop without context loss"
```

---

### Task 9: Чат — пикер моделей

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/chat.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/chat.test.ts`

**Interfaces:**
- Consumes: `ChatDeps.models?: ModelsSlice`:

```ts
export interface ModelConnectionRow {
  routeId: string;
  displayName: string;
  hasKey: boolean;
  models: string[];
  isDefault: boolean;
}
export interface ModelsSlice {
  list(): Promise<ModelConnectionRow[]>;
  current(): { provider: string; model: string };
  saveDefault(provider: string, model: string): Promise<{ provider: string; model: string }>;
}
```

- Produces: снапшоты `modelConnections` и `modelList`; callback-коды `mdl`, `mdl:c:<i>`, `mdl:pg:<n>`, `mdl:m:<i>`, `mdl:back`.

- [ ] **Step 1: Написать падающие тесты**

```ts
describe("chat machine: model picker", () => {
  const CONNECTIONS = [
    { routeId: "deepseek-official", displayName: "DeepSeek (официальный)", hasKey: true, models: ["deepseek-v4-flash", "deepseek-v4-pro"], isDefault: true },
    { routeId: "openai", displayName: "OpenAI", hasKey: false, models: ["gpt-4o"], isDefault: false }
  ];

  it("lists connections, marks the current one and never accepts a raw model string", async () => {
    const h = makeHarness({ models: makeModels(CONNECTIONS) });
    await h.machine.onMessage(message("/model"));

    expect(h.bot.sent[0]!.text).toContain("🧠 Модель сейчас: deepseek-v4-flash · deepseek-official");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["mdl:c:0", "mdl:c:1", "mnu"]);

    const openai = h.bot.buttonByData(h.bot.sent[0]!.markup, "mdl:c:1")!;
    expect(openai.text).toContain("нет ключа");
    h.bot.sent.length = 0;
    await h.machine.onCallback(callback("mdl:c:1", 42));

    expect(h.models.saved).toHaveLength(0);
    expect(h.bot.answers.at(-1)!.text).toBe("Ключ не задан — добавьте в админке");
  });

  it("opens a connection, saves the chosen model and reflects it in the menu", async () => {
    const h = makeHarness({ models: makeModels(CONNECTIONS) });
    const listId = (await h.machine.onMessage(message("/model")), h.bot.sent[0]!.messageId);
    await h.machine.onCallback(callback("mdl:c:0", listId));

    expect(h.bot.lastEdit().text).toContain("🧠 DeepSeek (официальный)");
    await h.machine.onCallback(callback("mdl:m:1", listId));

    expect(h.models.saved).toEqual([{ provider: "deepseek-official", model: "deepseek-v4-pro" }]);
    expect(h.bot.lastEdit().text).toContain("deepseek-v4-pro · deepseek-official");
  });

  it("pages a long model list and returns to the connections", async () => {
    const many = { ...CONNECTIONS[0]!, models: Array.from({ length: 10 }, (_, i) => `m-${i}`) };
    const h = makeHarness({ models: makeModels([many]), listPageSize: 8 });
    const listId = (await h.machine.onMessage(message("/model")), h.bot.sent[0]!.messageId);
    await h.machine.onCallback(callback("mdl:c:0", listId));

    expect(h.bot.data(h.bot.lastEdit().markup)).toEqual(["mdl:m:0", /* … */ "mdl:pg:0", "mdl:pg:1", "mdl:back"]);
    await h.machine.onCallback(callback("mdl:pg:1", listId));
    expect(h.bot.lastEdit().text).toContain("Страница 2/2");
    await h.machine.onCallback(callback("mdl:back", listId));
    expect(h.bot.lastEdit().text).toContain("Выберите соединение:");
  });

  it("degrades when the models service is absent", async () => {
    const h = makeHarness();
    await h.machine.onMessage(message("/model"));

    expect(h.bot.sent[0]!.text).toBe("Раздел моделей недоступен");
  });

  it("reports a vanished connection instead of saving it", async () => {
    const models = makeModels(CONNECTIONS);
    models.saveDefault = async () => {
      throw Object.assign(new Error("no such provider connection"), { code: "invalid-route" });
    };
    const h = makeHarness({ models });
    const listId = (await h.machine.onMessage(message("/model")), h.bot.sent[0]!.messageId);
    await h.machine.onCallback(callback("mdl:c:0", listId));
    await h.machine.onCallback(callback("mdl:m:0", listId));

    expect(h.bot.answers.at(-1)!.text).toBe("Не удалось сменить модель — обновите список");
  });
});
```

`makeHarness` получает опцию `models` и возвращает `h.models` с массивом `saved`; `makeModels(rows)` — фейк, помнящий `current` и пишущий в `saved`.

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/chat.test.ts -t "model picker"`
Expected: FAIL — `/model` отвечает «Не знаю такой команды.».

- [ ] **Step 3: Реализовать**

1. Снапшоты:

```ts
interface ModelConnectionsSnapshot {
  kind: "modelConnections";
  chatId: number;
  rows: ModelConnectionRow[];
  page: number;
  pages: number;
}
interface ModelListSnapshot {
  kind: "modelList";
  chatId: number;
  routeId: string;
  label: string;
  models: string[];
  page: number;
  pages: number;
}
```

2. Загрузка соединений с сортировкой «с ключом вперёд» и пагинацией по `listPageSize`:

```ts
  async function buildConnectionsView(chatId: number, page: number): Promise<
    { text: string; keyboard: InlineKeyboardMarkup; snapshot: ModelConnectionsSnapshot } | undefined
  > {
    if (deps.models === undefined) return undefined;
    let rows: ModelConnectionRow[];
    try {
      rows = await deps.models.list();
    } catch (error) {
      warn(`models list failed (${codeOf(error)})`);
      return undefined;
    }
    const current = deps.models.current();
    const pages = Math.max(1, Math.ceil(rows.length / listPageSize));
    const currentPage = clampPage(page, pages);
    const start = currentPage * listPageSize;
    const visible = rows.slice(start, start + listPageSize).map((row, offset) => ({
      index: start + offset,
      label: row.hasKey ? row.displayName : `${row.displayName} (нет ключа)`,
      selectable: row.hasKey,
      isDefault: row.isDefault
    }));
    const card = modelConnectionsCard({
      currentLabel: `${current.model} · ${current.provider}`,
      rows: visible,
      page: currentPage,
      pages
    });
    return {
      text: card.text,
      keyboard: card.keyboard,
      snapshot: { kind: "modelConnections", chatId, rows: rows.map((row) => ({ ...row })), page: currentPage, pages }
    };
  }
```

3. Отправка (`sendModelsCard`) и рендер в известное сообщение (`renderConnections`, `renderModelList`) — по образцу `renderWorkspaces`; список моделей соединения странично рендерится `modelListCard` с `currentModel` текущего дефолта.

4. Диспетчер callback'ов:

```ts
    if (data === "mdl") {
      const view = await buildConnectionsView(chatId, 0);
      if (view === undefined) {
        await edit(chatId, messageId, MODELS_UNAVAILABLE, (await menuView()).keyboard);
        return undefined;
      }
      putSnapshot(messageId, view.snapshot);
      await edit(chatId, messageId, view.text, view.keyboard);
      return undefined;
    }
    if (data.startsWith("mdl:c:")) {
      const index = parseIndex(data.slice("mdl:c:".length));
      if (index === undefined) return STALE_ACTION;
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined || snapshot.kind !== "modelConnections") return STALE_ACTION;
      const row = snapshot.rows[index];
      if (row === undefined) return STALE_ACTION;
      if (!row.hasKey) return NO_KEY_HINT;
      await renderModelList(chatId, messageId, { routeId: row.routeId, label: row.displayName, models: row.models }, 0);
      return undefined;
    }
    if (data.startsWith("mdl:pg:")) { /* страница списка моделей: перерисовать по снапшоту modelList */ }
    if (data.startsWith("mdl:m:")) {
      const index = parseIndex(data.slice("mdl:m:".length));
      if (index === undefined) return STALE_ACTION;
      const snapshot = snapshotOf(chatId, messageId);
      if (snapshot === undefined || snapshot.kind !== "modelList") return STALE_ACTION;
      const model = snapshot.models[index];
      if (model === undefined || deps.models === undefined) return STALE_ACTION;
      try {
        await deps.models.saveDefault(snapshot.routeId, model);
      } catch (error) {
        warn(`saving the default model failed (${codeOf(error)})`);
        return "Не удалось сменить модель — обновите список";
      }
      await renderMenu(chatId, messageId, true);
      return undefined;
    }
    if (data === "mdl:back") { /* перерисовать список соединений из снапшота */ }
```

`NO_KEY_HINT` и `MODELS_UNAVAILABLE` импортируются из `cards.ts`; строка «Не удалось сменить модель — обновите список» объявляется константой `MODEL_SAVE_FAILED` в `chat.ts`.

5. `notifySaved` больше не нужен: карточка-меню после сохранения перерисовывается тем же сообщением, и владелец видит новую модель в строке «Модель:».

- [ ] **Step 4: Прогнать и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram exec vitest run tests/chat.test.ts`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-telegram
git commit -m "feat(telegram): model picker over the shared models service"
```

---

### Task 10: Чат — живая карточка прогресса

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/chat.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/chat.test.ts`

**Interfaces:**
- Consumes: `deps.runner.progress(ref)`, `deps.progressIntervalMs?: number`.
- Produces: карточка прогресса, создаваемая при приёме задачи; `⚠️ Ошибка`/`✅ Готово`/`⏹ Остановлено…` квитанции; отсутствие сообщения «Задача принята…».

- [ ] **Step 1: Написать падающие тесты**

```ts
describe("chat machine: progress card", () => {
  it("marks a task accepted while another runs as queued", async () => {
    const h = makeHarness();
    await h.machine.setActiveWorkspace(HOME);
    h.runner.hold();
    h.runner.progress.mockReturnValue({ phase: "running", taskText: "первая", startedAt: Date.now(), steps: [], queued: 1 });
    await h.machine.onMessage(message("первая"));

    await h.machine.onMessage(message("вторая"));

    expect(h.bot.sent.at(-1)!.text).toContain("🕓 в очереди №2");
    expect(h.bot.data(h.bot.sent.at(-1)!.markup)).toEqual(["stp", "mnu"]);
  });

  it("replaces «Задача принята…» with a progress card carrying the stop button", async () => {
    const h = makeHarness();
    await h.machine.setActiveWorkspace(HOME);
    h.runner.hold();

    await h.machine.onMessage(message("починить парсер"));

    expect(h.bot.sent).toHaveLength(1);
    expect(h.bot.sent[0]!.text).toContain("⏳ Дом агента");
    expect(h.bot.texts()).not.toContain("Задача принята…");
    expect(h.bot.data(h.bot.sent[0]!.markup)).toEqual(["stp", "mnu"]);
  });

  it("edits the card while the task runs and turns it into a receipt when it finishes", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ progressIntervalMs: 3500 });
      await h.machine.setActiveWorkspace(HOME);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("починить парсер"));
      const cardId = h.bot.sent[0]!.messageId;

      h.runner.progress.mockReturnValue({
        phase: "running",
        taskText: "починить парсер",
        startedAt: Date.now() - 72_000,
        step: 4,
        steps: [{ name: "read", target: "notes.txt", status: "ok" }],
        todos: [{ content: "Разобрать логи", status: "completed" }],
        queued: 0
      });
      await vi.advanceTimersByTimeAsync(3500);
      expect(h.bot.lastEdit().messageId).toBe(cardId);
      expect(h.bot.lastEdit().text).toContain("🔧 read notes.txt ✔");

      // Идентичный текст не редактируется повторно.
      const editsBefore = h.bot.edits.length;
      await vi.advanceTimersByTimeAsync(3500);
      expect(h.bot.edits).toHaveLength(editsBefore);

      gate.release({ ok: true, text: "готово", sessionId: "s-1" });
      await settle();
      expect(h.bot.lastEdit().text).toContain("✅ Готово");
      expect(h.bot.sent.at(-1)!.text).toBe("готово");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps a receipt for a stopped task and never reports it as an agent failure", async () => {
    const h = makeHarness();
    await h.machine.setActiveWorkspace(HOME);
    const gate = h.runner.hold();
    await h.machine.onMessage(message("долгая"));

    gate.release({ ok: false, code: "cancelled", message: "task cancelled by the owner" });
    await settle();

    expect(h.bot.lastEdit().text).toBe("⏹ Остановлено владельцем · 0:00");
    expect(h.bot.texts().some((text) => text.includes("Агент не смог выполнить задачу"))).toBe(false);
  });

  it("stops updating the card after three failed edits but keeps the task running", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ progressIntervalMs: 3500, failEdits: 3 });
      await h.machine.setActiveWorkspace(HOME);
      const gate = h.runner.hold();
      await h.machine.onMessage(message("долгая"));
      h.runner.progress.mockReturnValue({
        phase: "running", taskText: "долгая", startedAt: Date.now(), steps: [{ name: "read", status: "running" }], queued: 0
      });

      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(3500);

      expect(h.bot.edits).toHaveLength(3);
      gate.release({ ok: true, text: "готово", sessionId: "s-1" });
      await settle();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

`makeHarness` получает опции `progressIntervalMs` и `failEdits` (фейковый бот бросает на `editMessageText` первые N раз), а `h.runner` — `progress` как `vi.fn(() => ({ phase: "idle", steps: [], queued: 0 }))`.

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/chat.test.ts -t "progress card"`
Expected: FAIL — «Задача принята…» всё ещё отправляется.

- [ ] **Step 3: Реализовать**

1. `ChatDeps` получает `progressIntervalMs?: number` (по умолчанию `DEFAULT_PROGRESS_INTERVAL_MS = 3500`).
2. Таймер карточки принадлежит САМОЙ задаче (не воркспейсу): иначе карточка очереди затирала бы карточку выполняющейся задачи, а «зависшее» обновление переживало свой turn.

```ts
interface ProgressCardHandle {
  messageId: number;
  startedAt: number;
  stop(): void;
}
const MAX_CARD_EDIT_FAILURES = 3;
```

3. Запуск задачи (`onMessage`, ветка «есть активный воркспейс») вместо `await send(chatId, TASK_ACCEPTED)`:

```ts
      const state = deps.runner.progress(ref);
      // Задача, принятая во время чужой работы, получает карточку очереди: её
      // собственная карточка начнётся, когда до неё дойдёт ход.
      const view =
        state.phase === "running"
          ? queuedCard({ workspaceLabel: refLabel(ref), taskText: update.text, position: state.queued + 1 })
          : progressCard({ workspaceLabel: refLabel(ref), taskText: update.text, elapsedMs: 0, steps: [], queued: 0 });
      const messageId = await send(update.chatId, view.text, view.keyboard);
      const card =
        messageId === undefined ? undefined : startProgressCard(update.chatId, messageId, copyRef(ref)!, update.text, view.text);
      void runTask(update.chatId, copyRef(ref)!, update.text, card).catch((error: unknown) => {
        warn(`task pipeline failed (${codeOf(error)})`);
      });
```

`runTask` получает четвёртым аргументом `card: ProgressCardHandle | undefined` и в `finally` зовёт `card?.stop()`.

```ts
  /**
   * Own one task's progress card: poll the runner and edit the message in place.
   * The returned handle is the only way to stop it, so a card can never outlive
   * the run that created it, and two tasks in one workspace never share it.
   */
  function startProgressCard(
    chatId: number,
    messageId: number,
    ref: WorkspaceRef,
    taskText: string,
    initialText: string
  ): ProgressCardHandle {
    const startedAt = Date.now();
    let lastText = initialText;
    let failures = 0;
    const timer = setInterval(() => {
      void (async () => {
        const progress = deps.runner.progress(ref);
        // Пока в работе чужая задача (или ничего), карточка остаётся карточкой
        // очереди: своя начнётся ровно тогда, когда runner отдаст её текст.
        if (progress.phase === "idle" || progress.taskText !== taskText) return;
        const view = progressCard({
          workspaceLabel: refLabel(ref),
          taskText,
          elapsedMs: Date.now() - startedAt,
          ...(progress.step !== undefined ? { step: progress.step } : {}),
          steps: progress.steps,
          ...(progress.todos !== undefined ? { todos: progress.todos } : {}),
          queued: progress.queued
        });
        if (view.text === lastText) return;
        try {
          await deps.bot.editMessageText(chatId, messageId, view.text, { reply_markup: view.keyboard });
          lastText = view.text;
        } catch (error) {
          failures += 1;
          if (failures >= MAX_CARD_EDIT_FAILURES) clearInterval(timer);
          warn(`progress card edit failed (${codeOf(error)})`);
        }
      })();
    }, progressIntervalMs);
    timer.unref?.();
    return { messageId, startedAt, stop: () => clearInterval(timer) };
  }
```

4. `runTask` получает квитанцию и гасит таймер в `finally`:

```ts
  async function runTask(
    chatId: number,
    ref: WorkspaceRef,
    text: string,
    card: ProgressCardHandle | undefined
  ): Promise<void> {
    let receipt: Parameters<typeof receiptCard>[0] | undefined;
    try {
      /* существующее тело: каждая result-ветка дополнительно выставляет receipt */
    } finally {
      card?.stop();
      if (card !== undefined && receipt !== undefined) {
        const view = receiptCard(receipt);
        await edit(chatId, card.messageId, view.text, view.keyboard);
      }
    }
  }
```

Соответствие результатов квитанциям: `ok: true`/`queue-full`/`busy` → `{kind:"done"}` с `steps: deps.runner.progress(ref).steps.length` (для `queue-full`/`busy` — без шагов, `steps: 0`), `cancelled` → `{kind:"stopped"}`, `workspace-gone` → `{kind:"error", detail: "воркспейс удалён"}`, прочие `agent-error` с фразами сброса (`RESET_ABORT_PHRASES`) → `{kind:"reset"}`, остальные `agent-error` → `{kind:"error", detail: safePhrase(...)}`. Ветки `queue-full`, `busy`, `workspace-gone` и `agent-error` продолжают отправлять свои сообщения как сейчас; для `cancelled` сообщение **не** отправляется (карточка уже стала квитанцией).

5. Обновить существующие ожидания `tests/chat.test.ts` (строки 571, 575, 582, 587, 614, 637, 651, 683) и `tests/integration.test.ts` (строка 778): вместо «Задача принята…» проверяется карточка `⏳ …` и её кнопки `["stp","mnu"]`.

- [ ] **Step 4: Прогнать и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram exec vitest run tests/chat.test.ts`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-telegram
git commit -m "feat(telegram): live progress card with throttled in-place updates"
```

---

### Task 11: Проводка в `index.ts` и регистрация команд

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/index.ts`
- Test: `packages/plugins/dsh-balbes-telegram/tests/index.test.ts`

**Interfaces:**
- Consumes: `ctx.get("balbesModels")` (сервис из Task 1), `TELEGRAM_COMMANDS` из `./commands.js`.
- Produces: `registerCommands(client, logger)` внутри `apply`; `inject` содержит `balbesModels`; `createChatMachine({ …, models })`.

- [ ] **Step 1: Написать падающий тест**

В `tests/index.test.ts` (в стиле существующих кейсов со stub-сервером и `makeCtx`):

```ts
  it("pushes the command list on every successful runtime transition", async () => {
    const stub = await startStubTelegram(); // существующий в файле локальный стаб /apiBase
    try {
      const ctx = makeCtx();
      apply(ctx, { dshHome: home, apiBase: stub.url });
      await ctx.settings.committed();       // существующий способ дождаться transition
      await waitFor(() => stub.methods().includes("setMyCommands"));

      const call = stub.lastCall("setMyCommands");
      expect(call.body.commands.map((c: { command: string }) => c.command)).toEqual([
        "menu", "status", "ws", "model", "reset", "stop", "help"
      ]);
      expect(stub.methods()).toContain("setChatMenuButton");
    } finally {
      await stub.close();
    }
  });

  it("keeps polling alive when command registration fails", async () => {
    const stub = await startStubTelegram({ failMethods: ["setMyCommands"] });
    try {
      const ctx = makeCtx();
      apply(ctx, { dshHome: home, apiBase: stub.url });
      await ctx.settings.committed();

      expect(ctx.warns.some((line) => line.includes("command registration failed"))).toBe(true);
      await expect(stub.polling()).resolves.toBe(true);
    } finally {
      await stub.close();
    }
  });
```

(`startStubTelegram`, `ctx.warns` и `waitFor` — локальные хелперы теста: добавить их в файл рядом с существующим стабом; `ctx.warns` собирается из переданного в `makeCtx` логгера.)

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter dsh-balbes-telegram exec vitest run tests/index.test.ts -t "command list"`
Expected: FAIL — стаб не получает `setMyCommands` (метод отвечает 404).

- [ ] **Step 3: Реализовать**

1. `inject`: добавить `"balbesModels"` в массив.
2. В `apply` прочитать сервис моделей и передать его в чат:

```ts
  const balbesModels = ctx.get("balbesModels") as ChatDeps["models"] | undefined;
  /* … в createChatMachine: */
    ...(balbesModels !== undefined ? { models: balbesModels } : {}),
```

3. Регистрация команд (идемпотентная, best-effort), вызываемая из `reconcile()` после `runtime.apply()`:

```ts
  /**
   * Push the command list to Telegram. Best-effort by design: the chat works
   * without it (a owner can still type the commands), so a rejected call must
   * never take polling down — only a warning is recorded.
   */
  async function registerCommands(): Promise<void> {
    let client: BotClient;
    try {
      client = runtime.bot();
    } catch {
      return; // no token stored yet: nothing to register against
    }
    try {
      await client.setMyCommands(TELEGRAM_COMMANDS.map((spec) => ({ command: spec.command, description: spec.description })));
      await client.setChatMenuButton();
    } catch (error) {
      ctx.logger.warn(`balbes-telegram: command registration failed: ${reasonOf(error)}`);
    }
  }

  const reconcile = async (): Promise<void> => {
    await booted;
    await runtime.apply();
    await registerCommands();
  };
```

4. `src/index.ts` больше не импортирует `menuKeyboard` (его нет) — проверить импорты после Task 8.

- [ ] **Step 4: Прогнать и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram exec vitest run tests/index.test.ts`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-telegram
git commit -m "feat(telegram): wire the models service and push the command list on start"
```

---

### Task 12: REAL-проверки канала

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts`
- Maybe modify: `packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-profile/cordis.patch.yml` (только если композиция фикстуры не включает `dsh-balbes-models`)
- Maybe modify: `packages/plugins/dsh-balbes-telegram/tests/agentTask.real.test.ts`

**Interfaces:**
- Consumes: всё построенное в задачах 1–11.
- Produces: доказательство, что канал работает end-to-end через настоящий профиль и настоящий dsh agent loop.

- [ ] **Step 1: Проверить состав фикстуры**

Run: `cat packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-profile/cordis.patch.yml`
Expected: среди insert-записей есть `dsh-balbes-models` (нужен для `/model`). Если записи нет — добавить её рядом с `balbes-workspaces` и `balbes-telegram` тем же форматом, что в `profiles/balbes/cordis.patch.yml`.

- [ ] **Step 2: Написать REAL-кейсы (падающие по существу, не по компиляции)**

Добавить в `tests/integration.test.ts`:

```ts
  it("REAL: registers commands at start and routes /model through the models service", async () => {
    // …существующая сборка harness (профиль + фейковый Bot API + stub LLM)…
    await harness.start();

    const registration = fake.outbound.find((entry) => entry.method === "setMyCommands");
    expect(registration).toBeDefined();
    expect(registration!.body.commands.map((c: { command: string }) => c.command)).toContain("model");

    fake.enqueueMessage({ text: "/model" });
    const connections = await waitForMessage((text) => text.includes("🧠 Модель"));
    expect(connections.text).toContain("deepseek-official");

    // Смена модели через чат видна в состоянии сервера.
    fake.enqueueCallback({ data: "mdl:c:0", messageId: connections.messageId });
    const models = await waitForMessage((text) => text.includes("Выберите модель"));
    fake.enqueueCallback({ data: "mdl:m:1", messageId: models.messageId });

    await waitFor(async () => {
      const state = await harness.readDefaultModel();
      expect(state.model).not.toBe("");
    });
  });

  it("REAL: /stop cancels the running task and the next task keeps the same session", async () => {
    // …первая задача ставится и паркуется stub-LLM (существующий механизм удержания ответа)…
    fake.enqueueMessage({ text: "считай долго" });
    await waitForMessage((text) => text.includes("⏳"));

    fake.enqueueMessage({ text: "/stop" });
    await waitForMessage((text) => text.includes("Остановил."));
    await waitForMessage((text) => text.includes("⏹ Остановлено владельцем"));

    fake.enqueueMessage({ text: "напомни, что было раньше" });
    const answer = await waitForMessage((text) => text.includes("было раньше") || text.length > 0);
    expect(harness.sessionsFor("home")).toHaveLength(1); // сессия не пересоздана
  });
```

`harness.readDefaultModel()`, `harness.sessionsFor(key)` и `waitForMessage` — хелперы теста: первый читает `agentDefaultModel.currentSelection()` через сервис профиля (или `ctx.get("agentDefaultModel")` пробника), второй берёт ключи карты сессий из `$DSH_HOME/telegram-state.json` (`sessions`) через `readFile`.

- [ ] **Step 3: Добавить агентский REAL-кейс отмены**

В `tests/agentTask.real.test.ts`:

```ts
  it("REAL: a cancelled turn keeps the session and its context", async () => {
    const runner = await makeRealRunner();
    const first = await runner.run(HOME_REF, "Запомни число 41 и ответь одним словом «запомнил».");
    expect(first.ok).toBe(true);

    const long = runner.run(HOME_REF, "Считай от 1 до 1000 по одному числу в строке, не останавливайся.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const outcome = await runner.cancel(HOME_REF);
    expect(outcome.cancelled).toBe(true);
    await expect(long).resolves.toMatchObject({ ok: false, code: "cancelled" });

    const followUp = await runner.run(HOME_REF, "Какое число ты запомнил? Ответь только числом.");
    expect(followUp.ok).toBe(true);
    expect(followUp.ok ? followUp.text : "").toContain("41");
  });
```

- [ ] **Step 4: Прогнать REAL-наборы локально**

Run: `RUN_REAL=1 pnpm --filter dsh-balbes-telegram exec vitest run tests/agentTask.real.test.ts tests/integration.test.ts`
Expected: PASS (наборы требуют stub-LLM и локального фейкового Bot API — сеть наружу не нужна).

- [ ] **Step 5: Прогнать весь пакет и закоммитить**

Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram run test`
Expected: PASS.

```bash
git add packages/plugins/dsh-balbes-telegram
git commit -m "test(telegram): real coverage for command registration, model switch and stop"
```

---

### Task 13: Runbook и хендовер проверки на сервере

**Files:**
- Modify: `docs/runbooks/stage2-vps.md`

**Interfaces:**
- Consumes: поведение, реализованное в задачах 1–12.
- Produces: обновлённый чеклист проверки Telegram-канала для владельца.

- [ ] **Step 1: Переписать шаг «Первый контакт в Telegram»**

Текст шага становится:

```md
**Шаг 4. Первый контакт в Telegram.** `/start` → карточка-меню «🤖 Агент сервера»
с активным воркспейсом, моделью, строкой задачи и очередью; по «/» виден список
команд (`/menu`, `/status`, `/ws`, `/model`, `/reset`, `/stop`, `/help`), у поля
ввода — кнопка «Меню». Кнопка «Воркспейсы» открывает список (`Дом агента` и
проекты), выбор проекта → карточка-меню с новым воркспейсом. Неизвестная команда
(`/foo`) отвечает «Не знаю такой команды.» и карточкой; агенту такая команда не
уходит.
```

- [ ] **Step 2: Переписать шаг «Задача» под карточку прогресса**

```md
**Шаг 5. Задача.** Текстовое сообщение → на месте ответа появляется живая
карточка «⏳ <воркспейс> · время · шаг N» со списком шагов инструментов
(`🔧 read notes.txt ✔`) и кнопками «⏹ Стоп» / «⬅ Меню»; карточка обновляется не
чаще раза в 3–4 секунды. По завершении карточка превращается в квитанцию
(`✅ Готово · время · N шагов`), а следом отдельным сообщением приходит финальный
ответ (длинный — несколькими сообщениями). Проверьте, что агент работает с
выбранным воркспейсом: попросите прочитать файл внутри проекта.
```

- [ ] **Step 3: Дополнить шаг «Файлы и сброс контекста»**

Добавить в конец шага:

```md
Отдельно проверьте три вещи. `/model` → «🧠 Модель сейчас: …» → соединение →
модель: после выбора карточка показывает новую модель, раздел «Модели» в админке
показывает ту же модель, а следующая задача в том же воркспейсе отвечает без
сброса контекста (агент помнит предыдущий вопрос). `/stop` во время длинной
задачи («считай от 1 до 1000») → «Остановил. Контекст сохранён…» и квитанция
`⏹ Остановлено владельцем`; следующая задача **помнит** предыдущий диалог — в
отличие от `/reset`, после которого агент не помнит ничего. Соединение без ключа
в пикере помечено «нет ключа», нажатие отвечает «Ключ не задан — добавьте в
админке» и ничего не меняет.
```

- [ ] **Step 4: Дополнить шаг «Данные на диске»**

```md
Форма `telegram-state.json` не изменилась при добавлении команд и смены модели:
те же `activeWorkspace`, `sessions`, `offset`, версия `1`, прав `600`; модель
хранится не здесь, а в секции `agent-default-model` файла
`$DSH_HOME/settings.yaml` (одна настройка с разделом «Модели»).
```

- [ ] **Step 5: Дополнить диагностику**

В раздел «Если что-то не так» добавить:

```md
- В Telegram нет списка команд и кнопки «Меню»: регистрация `setMyCommands`
  best-effort и не влияет на polling. Проверьте журнал
  (`sudo journalctl -u dsh-balbes -n 200 | grep "command registration failed"`)
  и спросите у Telegram `getMyCommands`
  (`curl -sS "https://api.telegram.org/bot<token>/getMyCommands"`).
- Карточка задачи перестала обновляться, а задача идёт: после трёх подряд
  неудачных правок сообщения карточка «замирает» — это по дизайну, а не поломка;
  финальная квитанция и ответ придут как обычно.
- Смена модели не подействовала на текущую задачу: смена применяется со
  следующего шага, текущий шаг доигрывает на прежней модели.
```

- [ ] **Step 6: Прогнать проверку доков и закоммитить**

Run: `grep -n "setMyCommands\|/model\|/stop" docs/runbooks/stage2-vps.md | head -20`
Expected: новые шаги на месте, старые формулировки («Задача принята…», «Любая другая команда отвечает корневым меню») удалены — проверить `grep -n "Задача принята" docs/runbooks/stage2-vps.md` (не должно быть совпадений).

```bash
git add docs/runbooks/stage2-vps.md
git commit -m "docs(runbook): telegram command surface, model switch and stop verification"
```

- [ ] **Step 7: Хендовер владельцу (не код)**

Сообщить владельцу инструкции проверки на сервере строго по runbook:

1. Обновление: перезапуск `scripts/install.sh` на VPS (git pull --ff-only → сборка → синк профиля → копия плагинов в `node_modules` профиля → деплой SPA → рестарт `dsh-balbes`).
2. Смоук API: `curl -sS -X POST http://127.0.0.1:8080/api/telegram/status …` → `state: "connected"`.
3. Диск: `ls -l $DSH_HOME/telegram-state.json` → права `600`, версия `1`, новых полей нет.
4. В личном чате: шаги 4–8 обновлённого чеклиста (команды и кнопка «Меню», карточка прогресса, `/model`, `/stop`, `/reset`).
5. Прислать вывод упавшего шага и журнал — не пересылать bot token.

**Пуш в `origin/main` — только после разрешения владельца.**

---

## Self-Review

**1. Покрытие спеки.** Команды и нативная регистрация — Task 7 + Task 11 (+ Task 2). Карточка-меню — Task 6 + Task 8. Смена модели — Task 1 + Task 3 + Task 9 + Task 11. Живая карточка прогресса — Task 5 + Task 6 + Task 10. `/stop` без потери контекста — Task 4 + Task 8 + Task 12. Карточка ≠ streaming и запрет на содержимое файлов в карточке — Task 5 (`PROGRESS_TARGET_ARG`, `progressTarget`) + Task 6 (тест «never renders a tool result body»). Состояние на диске без изменений — Global Constraints + Task 13 Step 4. Runbook и хендовер — Task 13. REAL-проверки — Task 12. Открытые технические проверки спеки закрываются так: (1) методы Bot API в фейке — Task 2 Step 5; (2) `cancel` при простое — Task 4 Step 1; (3) resume при смене дефолта — Task 3 Step 1 + Task 12 Step 3; (4) `session.append("model/selection")` — от записи события отказались by design (Task 3), следовательно проверка не нужна; (5) лимиты Telegram на правки — троттлинг 3–4 с и остановка после трёх неудач — Task 10 Step 3.

**2. Placeholder scan.** Незаполненных «TBD/TODO/implement later» нет. В местах, где код задачи встраивается в существующие длинные функции (`runTask`, `dispatchCallback`), приведены точные старые/новые фрагменты и имена; тела, переносимые без изменений, помечены как перенос (`readConnections`, ветка `/ws`, ветка сброса).

**3. Type consistency.** `TaskProgress`/`TaskProgressStep`/`TaskProgressTodo` определены в `agentTask.ts` (Task 5) и используются в `cards.ts` (Task 6) и `chat.ts` (Task 10). `ModelConnectionRow`/`ModelsSlice` определены в `chat.ts` (Task 9) и совпадают по полям с `ModelConnection` из `models` (Task 1). Callback-коды совпадают с таблицей спеки: `mnu`, `mnu:refresh`, `mdl`, `mdl:c:<i>`, `mdl:pg:<n>`, `mdl:m:<i>`, `mdl:back`, `stp`. Новый метод раннера называется `progress(ref)` — не `snapshot()`, потому что `snapshot()` уже занят картой сессий для персистентности.
