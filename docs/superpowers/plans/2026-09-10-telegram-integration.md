# Telegram-интеграция с воркспейсами — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Единственный владелец сервера получает канал Telegram: настройка token/User ID/enabled в JWT-админке, long polling в том же dsh/Cordis-процессе, выбор «Дом агента»/проекта inline-кнопками, задачи штатному dsh agent loop с persistent-сессией на каждый workspace (resume после рестарта), lazy-дерево и просмотр ограниченных text-файлов.

**Architecture:** Отдельный пакет-плагин `dsh-balbes-telegram` (function plugin: `name`/`inject`/`Config`/`apply`) поверх существующих services — `balbesHttp` (роуты настроек), `settings` (зарегистрированный namespace `balbes-telegram`), `credentials` (token в `$DSH_HOME/.credentials.yaml`), нового service `balbesWorkspaces` (регистрирует `dsh-balbes-workspaces`: безопасное разрешение корня, чтение каталога/файла), и новый модуль `agentTask` (общая граница workspace-aware задач: persistent-сессии create/resume штатными `agents`/`sessions`, FIFO на workspace). Bot API вызывается тонким клиентом поверх `fetch` (никаких новых runtime-зависимостей), long polling без webhook, dispose через `AbortController` + `ctx.effect`. Нечувствительное состояние — атомарный файл `$DSH_HOME/telegram-state.json` (600). Admin API: `telegram.status/save/test/disable/clear-token` (bearer POST). SPA — страница «Telegram».

**Tech Stack:** TypeScript strict ESM, dsh 0.1.2-rc.1 (Cordis plugins, schemastery), node:fetch, vitest, React 18 + Vite SPA, bash (install.sh), YAML patches.

**Spec:** `docs/superpowers/specs/2026-09-10-telegram-integration-design.md` (authoritative; план аргументирует от него). Связанный canon: `docs/canon/{API_CONTRACTS,ADMIN_UI,ARCHITECTURE,GLOSSARY,OVERVIEW}.md`, runbook `docs/runbooks/stage2-vps.md` — canon/runbook-описания уже закоммичены с дизайном.

## Global Constraints

- **Seams dsh — ground truth.** Поведение `agents.create/resume`, `sessions.flush`, `Agent.cancel`, реальных tools при `meta.cwd` проверяется эмпирически в Task 1 (REAL) на установленной версии dsh; обнаруженное фактическое поведение — норма для всех последующих задач (как поведение движка в модельных REAL-тестах). dsh никогда не патчится (`@deepseek-ai/*` — dependency, не fork); плагин не добавляет runtime-зависимостей на `@deepseek-ai/*` (резолв подъёмом к зеркалу профиля).
- **R-API-1:** все `/api/*` — POST; ошибки `{error:{code,message}}`; ответы никогда не содержат bot token (маска `••••` или отсутствие поля). Правила имён/копирайта: код и комментарии — английский, UI-копия — русская; строгий TS (ESM, `.js`-импорты в пакетах, `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` — optional-поле никогда не присваивается `undefined` явно); файлы kebab-case.
- **Telegram-инварианты (из спеки):** один разрешённый числовой `from.id` + только `chat.type === "private"`; групповые чаты и другие User ID игнорируются без раскрытия состояния; callback и пути никогда не доверяются — перепроверяются на сервере; containment проверяется до запуска агента и до чтения файла; symlink для file view не разыменовывается; лог не содержит текст сообщений/содержимое файлов/секреты; только long polling (без webhook, без отдельного systemd-процесса); polling стартует/останавливается сменой настроек без рестарта; задачи одного workspace — последовательно (FIFO, до 3 ожидающих); 401 от Bot API — фатален (polling останавливается, статус `error`).
- **Состояние:** файл `$DSH_HOME/telegram-state.json` (atomic tmp+rename, mode 600) содержит только `activeWorkspace`, mapping `workspaceRef -> sessionId`, последний `offset`; token туда не пишется. Сессия возобновляется только штатным `agents.resume`; незавершённая задача не повторяется автоматически.
- **Настройки:** namespace `balbes-telegram` регистрируется самим плагином через `settings.register` (схема: `enabled: boolean`, `allowedUserId: number | null`); token — ref `BALBES_TELEGRAM_BOT_TOKEN` через `ctx.credentials`.
- **REAL-гейт:** REAL-тесты — `RUN_REAL=1` И наличие `dsh` (`describe.skipIf`), зеркало `packages/bundles/dsh-balbes-host/tests/integration.test.ts`; компиляция src→lib перед boot (tsc из стора, cwd пакета обязателен для vitest — pnpm/corepack shim не использовать, запускать `bash node_modules/.bin/...`).
- **Docs-правила:** `docs/canon/**` уже синхронизированы — в задачах не править; runbook при функциональных изменениях — в том же коммите, что и код; каждый таск завершается зелёными проверками и одним коммитом (глагол в subject, ≤ ~72 символа).
- **Branch/push:** план и код коммитятся на текущей ветке; push на общий бранч — только после go-ahead владельца; сервер обновляется перезапуском `scripts/install.sh` (см. `docs/runbooks/stage2-vps.md`).

## Файловая карта

Новые файлы:
- `packages/plugins/dsh-balbes-telegram/{package.json,tsconfig.json,tsconfig.build.json}` — пакет (зеркало `dsh-balbes-models`)
- `packages/plugins/dsh-balbes-telegram/src/{index,bot,poller,updates,chat,text,agentTask,state}.ts`
- `packages/plugins/dsh-balbes-telegram/tests/{index,bot,poller,updates,chat,text,agentTask,state,integration}.test.ts`
- `packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-profile/{package.json,cordis.patch.yml}`
- `packages/plugins/dsh-balbes-telegram/tests/helpers/{stub-llm.mjs,fake-bot-api.mjs}` (по образцу host `tests/helpers/`)
- `packages/bundles/dsh-balbes-host/tests/seams.test.ts` — REAL-проба seams dsh (Task 1)
- `packages/plugins/dsh-balbes-workspaces/src/{file.ts,service.ts}` — чтение файлов + service facade

Изменяемые файлы:
- `packages/contracts/src/index.ts`, `packages/contracts/tests/contracts.test.ts` — типы `telegram.*`
- `packages/plugins/dsh-balbes-workspaces/src/{index.ts,tree.ts}`, `tests/{index,tree}.test.ts` — read-file функция + `ctx.provide("balbesWorkspaces")`
- `profiles/balbes/cordis.patch.yml` — insert `dsh-balbes-telegram` (после `balbes-models`)
- `scripts/install.sh` — `copy_telegram_into_profile` (зеркало `copy_models_into_profile`) + вызов в `main`
- `.github/workflows/ci.yml` — копирование нового плагина в профиль
- `packages/frontend/dsh-balbes-admin/src/api/client.ts`, `src/App.tsx`, `src/components/Sidebar.tsx`, `src/pages/TelegramPage.tsx` (новый), `tests/{client,App,Sidebar,TelegramPage}.test.tsx`
- `packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs` — поддержка scripted multi-turn ответов (backward-compatible)
- `docs/runbooks/stage2-vps.md` — smoke-блоки Telegram API (Task 13)

Порядок: Task 1 (проба seams) идёт первым осознанно — спека требует фактических ответов на 4 открытых проверки до остального кода; остальные REAL-таски ссылаются на его файлы.

---

### Task 1: REAL-проба seams dsh — containment tools при `meta.cwd`, resume после рестарта, scripted LLM-стаб

**Files:**
- Modify: `packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs` (обратно совместимое расширение: опция `script` для многоходовых ответов с tool-call)
- Create: `packages/bundles/dsh-balbes-host/tests/seams.test.ts` (REAL, `RUN_REAL=1` gate как в `integration.test.ts`)
- Read first: `packages/bundles/dsh-balbes-host/tests/integration.test.ts`, `tests/helpers/{runprobe.mjs,stub-llm.mjs}` (весь каркас in-process boot уже там), `packages/bundles/dsh-balbes-host/src/runner.ts`

**Consumes:** каркас in-process boot (`@deepseek-ai/dsh-app-boot` `boot` + `healProfilesModuleFallback` + `loadOverlayPatches` + runprobe global `__balbesRunProbeCtx__`), `startStubLlm`.
**Produces (факты для задач agentTask и REAL-композиции — Task 7/12):**
- Точная процедура create/resume persistent-агента с `meta.cwd` = корень workspace и `sessions.flush` после каждого turn; что происходит с persisted-файлом сессии (`$DSH_HOME/sessions/<...>`) при `handle.dispose()`.
- Реальный состав tools у registry-агента и containment: работает ли fs `read` c относительным путём от корня workspace; пропускаются ли абсолютные пути (`/etc/hostname`, `$DSH_HOME/admin-auth.json`), `..`-traversal, symlink-выход, bash `cat`/`cd ..`; если что-то из перечисленного проходит — какие штатные рычаги в setup/scope (`restrict`, scoped fs provider, session cwd) закрывают это.
- Расширенный `startStubLlm` с scripted ответами: multi-turn, tool-call chunk `{name:"read", arguments:"{\"file_path\":\"...\"}"}` затем финальный текст; подтверждённый формат streaming SSE и того, что инструменты исполняются и результат попадает в следующий запрос модели.
- Resume после «рестарта»: double-boot в одном vitest-процессе — `boot` → создать агента, turn, flush, `fiber.dispose()` → повторный `boot` → `agents.resume({resumeSessionId,...})` → следующий turn видит историю (seq/события первого turn), `agent-default-model` и tools как у create.

**Что спека требует подтвердить:** наличие/семантика `agents.resume`; фактическое containment-поведение fs/bash/code tools при `meta.cwd`; способ graceful cancellation активного `AgentHandle`; совместимость клиента (план: чистый `fetch`, см. Task 5). Пункт «cancellation» отдельно: проверить `Agent.cancel(cause)` + сходимость `whenIdle()` и что `dispose()` на busy-агенте корректно останавливает loop (это семантика «Сбросить контекст»).

- [ ] **Step 1: расширить `startStubLlm`** (обратная совместимость: текущее поведение `{text}` сохраняется, существующие вызовы не меняются)

```js
// NEW optional option: script — an ordered list of per-request responses.
// Each entry: { toolCall: { name, arguments }, toolCalls?: [...] } for one
// assistant tool-call delta, or { text } for the final content delta.
// When script is omitted the helper behaves exactly as before (single text).
export function startStubLlm({ text = "ok", script } = {}) {
  // ...existing server, then in the request handler pick the next entry:
  //   const entry = script ? script[nextIndex++ % script.length] : { text };
  // Emit SSE chunks: entry.toolCall -> one delta.tool_calls chunk with
  //   { index: 0, id: "call_stub", type: "function",
  //     function: { name, arguments } } and finish_reason "tool_calls";
  //   entry.text -> role/content delta + finish_reason "stop" as today.
  // The engine must see the SAME function name/args JSON the real tool
  // expects — the probe's tool-dump step decides the exact value.
}
```

- [ ] **Step 2: написать REAL `seams.test.ts` — секция «session cwd и fs tool»**

Факты, закрепляемые тестами (структурный подход — dsh 0.1.2-rc.1, см. `@deepseek-ai/dsh-tool-fs/lib/types/{read,session-cwd}.d.ts`):
- In-process boot по образцу `integration.test.ts` (basePatches + `balbes-runprobe` + disable `session-telemetry-otel`), `settings.yaml` в temp `$DSH_HOME` пишется ДО boot: `agent-default-model: {provider: deepseek-official, model: deepseek-v4-flash}` + `llm-deepseek: {baseURL: http://127.0.0.1:<stub.port>}`, env `DEEPSEEK_API_KEY=test-key` (образец строки 143-146).
- Создать temp workspace-каталог `ws/` с `notes.txt`; `agents.create({ sessionId: brandString("session-seam-1"), meta: { cwd: <ws> }, agentOptions: { provider: "deepseek-official", model: "deepseek-v4-flash" }, setup })`; первый turn scripted-стаба — tool call `read` c `{"file_path":"notes.txt"}` (затем текст `"read ok"`); assert финального `text` == "read ok" и что в `stub.calls` второй запрос содержит результат инструмента (messages с role tool) — доказательство, что инструмент реально выполнен в агенте.
- Дальше — трафик containment: отдельными агентами/turns со scripted read/bash попытаться:
  1. `{"file_path": "../outside.txt"}` (файл вне ws, но внутри temp home) — ожидание: отказ инструмента (ошибка в turn, reason error) ИЛИ чтение; фиксируем факт.
  2. абсолютный путь `{"file_path": "/etc/hostname"}` и `$DSH_HOME/admin-auth.json` — ожидание: отказ; если не отказ — фиксируем.
  3. symlink `ws/link.txt -> /etc/hostname`: `{"file_path": "link.txt"}` — ожидание: не читает содержимое вне ws.
  4. bash-инструмент: `cd .. && pwd`, `cat /etc/hostname` — ожидание: ограничен/отказ (tool-bash поверх sandbox/permission); фиксируем фактическое.
  Каждое наблюдение — `expect` с явным ожиданием, выведенным из **Step 3** фактов (см. ниже), плюс комментарий «dsh 0.1.2-rc.1 seam fact: …».
- Если какой-то канал раскрывает корень (абсолютные пути/`..`/shell-выход читают файлы вне ws), containment-провал фиксируется ЗДЕСЬ как известный факт, а закрытие выносится в Task 7 (шаг guard в `composeAgentSetup`) — Task 1 НЕ патчит dsh и НЕ пишет обходных путей.

- [ ] **Step 3: dump tools у registry-агента** — до запуска инструментов в Step 2 выполнить отдельный turn со scripted текстом-заглушкой, а в тесте после boot через probe ctx прочитать состав tool-поверхности: зарегистрированные имена fs/bash tools. Если у `ctx.get("tools")` (`ToolRuntime`) нет публичного листинга — читать в тесте структуру через доступные методы/типы пакета и зафиксировать имена из `@deepseek-ai/dsh-tool-fs` (`read`/`write`/`edit`, аргумент `file_path`) как константу ожидания. Записать вывод в комментарий теста («registry agent exposes fs read/write/edit + bash …»).

- [ ] **Step 4: resume после «рестарта» + dispose-семантика**

В том же `seams.test.ts`: boot #1 → create агента `session-seam-1` (cwd ws), turn `"Reply with exactly: ok from stub"` → `text == CANNED` → `sessions.flush` → найти persisted-файл сессии под `$DSH_HOME/sessions/` (jsonl layout ключуется по cwd-каталогу) и assert существования → `fiber.dispose()` (полный останов процесса-в-миниатюре) → boot #2 (новый fiber, тот же `$DSH_HOME`) → `agents.resume({ resumeSessionId: "session-seam-1", agentOptions: {...}, setup })` → следующий turn; assert: финальный текст и что история первого turn видна (например, `agent.session.seq > seqПослеПервогоTurn` или найден первый user message через `eventAt(0..)`). Отдельно: `handle.dispose()` на живой сессии — assert, что агент исчез из `agents.list()`; зафиксировать, удаляется ли persisted-файл сессии (если да — это семантика «Сбросить контекст»; если нет — reset дополнительно чистит mapping, а durable-файл остаётся, и при следующем resume одноимённой сессии поведение фиксируем фактом).

- [ ] **Step 5: прогон и фиксация**

Run: `cd packages/bundles/dsh-balbes-host && bash node_modules/.bin/vitest run tests/seams.test.ts` (env: `RUN_REAL=1`). Expected: все assertions зелёные **на фактических значениях**; любые расхождения ожиданий с реальным поведением dsh 0.1.2-rc.1 правятся В ТЕСТЕ (ожидание = факт), комментарий `seam fact:` фиксирует вывод. Затем прогнать существующий REAL-сьют host — не сломан расширением стаба: `bash node_modules/.bin/vitest run tests/integration.test.ts`.

- [ ] **Step 6: commit**

```bash
git add packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs packages/bundles/dsh-balbes-host/tests/seams.test.ts
git commit -m "test(host): REAL seam probe for agent cwd, resume, tool containment"
```

---

### Task 2: Контракты `telegram.*` в `dsh-balbes-contracts`

**Files:**
- Modify: `packages/contracts/src/index.ts` (append ниже `ModelsCatalogResponse`)
- Test: `packages/contracts/tests/contracts.test.ts`

**Consumes:** ничего (структурные типы — самодостаточны).
**Produces (потребляют Task 11 ручки, Task 13 SPA-клиент):**
- `TelegramState = "not-configured" | "disabled" | "connected" | "error"`
- `TelegramSettingsStatus { state: TelegramState; tokenConfigured: boolean; enabled: boolean; allowedUserId?: number; botUsername?: string; lastPollAt?: string; error?: { code: string; message: string } }` — токен в ответе отсутствует принципиально (`tokenConfigured` вместо значения)
- `TelegramStatusRequest {}`, `TelegramStatusResponse { status: TelegramSettingsStatus }`
- `TelegramSaveRequest { token?: string; allowedUserId?: number; enabled?: boolean }` (отсутствующее поле = не менять)
- `TelegramSaveResponse`, `TelegramDisableResponse`, `TelegramClearTokenResponse` — все `{ status: TelegramSettingsStatus }`
- `TelegramTestRequest {}`, `TelegramTestResponse { username: string }`
- `TelegramDisableRequest {}`, `TelegramClearTokenRequest {}`

- [ ] **Step 1: написать failing-тест** — в `contracts.test.ts` структурный блок по образцу существующих (см. блок workspace-контрактов в этом файле):

```ts
import type {
  TelegramClearTokenRequest, TelegramClearTokenResponse, TelegramDisableRequest,
  TelegramDisableResponse, TelegramSaveRequest, TelegramSaveResponse,
  TelegramSettingsStatus, TelegramState, TelegramStatusRequest,
  TelegramStatusResponse, TelegramTestRequest, TelegramTestResponse
} from "../src/index.js";

describe("telegram contracts", () => {
  it("status carries no token, only tokenConfigured", () => {
    const status: TelegramSettingsStatus = { state: "connected", tokenConfigured: true, enabled: true, allowedUserId: 12345, botUsername: "balbes_bot", lastPollAt: "2026-09-10T00:00:00.000Z" };
    const statusRes: TelegramStatusResponse = { status };
    const saveRes: TelegramSaveResponse = { status: { state: "disabled", tokenConfigured: true, enabled: false, allowedUserId: 12345 } };
    const saveReq: TelegramSaveRequest = { allowedUserId: 12345, enabled: true }; // token absent = keep
    const disableReq: TelegramDisableRequest = {};
    const disableRes: TelegramDisableResponse = { status: { state: "disabled", tokenConfigured: true, enabled: false } };
    const clearReq: TelegramClearTokenRequest = {};
    const clearRes: TelegramClearTokenResponse = { status: { state: "not-configured", tokenConfigured: false, enabled: false } };
    const testReq: TelegramTestRequest = {};
    const testRes: TelegramTestResponse = { username: "balbes_bot" };
    const states: TelegramState[] = ["not-configured", "disabled", "connected", "error"];
    expect([status, statusRes, saveReq, saveRes, disableReq, disableRes, clearReq, clearRes, testReq, testRes, states]).toBeTruthy();
  });
});
```

- [ ] **Step 2: run — RED.** Run: `cd packages/contracts && bash node_modules/.bin/tsc --noEmit -p tsconfig.json && bash node_modules/.bin/vitest run` — Expected: TS2305 на импортах (типов нет).
- [ ] **Step 3: реализовать типы** в `packages/contracts/src/index.ts` (append; точные имена/поля из Produces выше; комментарий: «Telegram settings surface — no secret ever leaves the server, tokenConfigured only»).
- [ ] **Step 4: run — GREEN + typecheck.** Run: команды Step 2. Expected: PASS.
- [ ] **Step 5: commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/tests/contracts.test.ts
git commit -m "feat(contracts): telegram settings contract types"
```

---

### Task 3: Scaffold пакета `dsh-balbes-telegram` + профиль/install.sh/CI

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/package.json`, `tsconfig.json`, `tsconfig.build.json` (копии конфигов `dsh-balbes-workspaces` — сначала прочитать их), `src/index.ts` (скелет плагина), `tests/index.test.ts`
- Modify: `profiles/balbes/cordis.patch.yml`, `scripts/install.sh` (новая `copy_telegram_into_profile` + вызов в `main`), `.github/workflows/ci.yml`

**Consumes:** паттерны `packages/plugins/dsh-balbes-models/src/index.ts` (структура плагина/ручек), `packages/plugins/dsh-balbes-workspaces/src/index.ts`, их `tests/index.test.ts` (fake http-seats), `scripts/install.sh::copy_models_into_profile`, CI-блок копирования models.
**Produces (потребляют Task 4-12):**
- Пакет `dsh-balbes-telegram` (build→`lib/`, types), подключаемый в профиль и REAL-фикстуры.
- В `src/index.ts`: `export const name = "balbes-telegram"`, `inject = ["balbesHttp", "settings", "credentials", "balbesWorkspaces", "agents", "sessions"]`, `Config = z.object({ dshHome: z.string().optional(), apiBase: z.string().default("https://api.telegram.org"), maxFileBytes: z.number().default(256 * 1024) })`; `apply` пока: резолв `dshHome` (config → `DSH_HOME` env → `~/.dsh`), `settings.register("balbes-telegram", schema)` (schema из Task 6-констант: `z.object({ enabled: z.boolean().default(false), allowedUserId: z.number().int().min(1).nullable().default(null) })`), при отсутствии `balbesHttp` — warn и return (паттерн models). Роуты/полинг подключаются в Task 10.
- Константа `export const TELEGRAM_BOT_TOKEN_REF = "BALBES_TELEGRAM_BOT_TOKEN"` (в `src/names.ts`? нет — пока в `src/index.ts`; Task 5 перенесёт при необходимости в `bot.ts`-совместный модуль — на усмотрение исполнителя с сохранением имени).
- install.sh: `copy_telegram_into_profile` — дословное зеркало `copy_models_into_profile` с заменой имён пакета; вызов после `copy_models_into_profile`. CI: копирование `packages/plugins/dsh-balbes-telegram` в `$HOME/.dsh/profiles/balbes/node_modules` по образцу models-блока.

- [ ] **Step 1: пакет и конфиги** — создать `package.json` (`"name": "dsh-balbes-telegram"`, `"type": "module"`, `main`/`types` на `./lib/*`, scripts `build`/`typecheck`/`test`, devDeps `@types/node`/`typescript`/`vitest`), `tsconfig.json` + `tsconfig.build.json` скопировать из `dsh-balbes-workspaces` и поправить только пути; добавить пакет в root workspace (проверить `pnpm-workspace.yaml` — при glob `packages/*` ничего менять не надо; при явном списке — добавить). `pnpm install` в корне.
- [ ] **Step 2: скелет `src/index.ts`** (см. Produces; warn-ветка при отсутствии http как в models; регистрация namespace возвращает `SettingsScope` — сохранить в замыкании для Task 10, поле пока не используется). `tests/index.test.ts` (зеркало `dsh-balbes-workspaces/tests/index.test.ts`): fake `ctx.get` возвращает fake `balbesHttp` (массив seats) и fake `settings` (для `register` — объект, запоминающий вызов), fake `credentials`; assertions: `name === "balbes-telegram"`; `inject` содержит `balbesHttp`/`settings`/`credentials`; apply вызывает `settings.register("balbes-telegram", …)` и при отсутствии http логирует warn без падения.
- [ ] **Step 3: run — RED (build/typecheck).** Run: `cd packages/plugins/dsh-balbes-telegram && bash node_modules/.bin/tsc --noEmit -p tsconfig.json` — Expected: ошибки отсутствующих файлов/типов по мере заполнения; после написания — GREEN. (Для нового пакета шаг RED сводится к проверке, что tsc действительно компилирует скелет; основной тест-цикл начинается с Task 5.)
- [ ] **Step 4: профиль + install.sh + CI.** Добавить `- id: balbes-telegram / name: 'dsh-balbes-telegram'` в `profiles/balbes/cordis.patch.yml` (после `balbes-models`). В `install.sh`: функция-зеркало `copy_telegram_into_profile` + вызов в `main()` после `copy_models_into_profile`; обновить заголовочный комментарий (перечень пакетов). В CI: блок копирования telegram по образцу models (после models-блока). Проверки: `bash -n scripts/install.sh`; `bash -n .github/workflows/ci.yml` не нужен (YAML) — вместо этого валидировать YAML профиля через `dsh --profile balbes --dump-config` НЕ запускать локально (требует зеркала) — только в CI; локально — `node -e "JSON.parse(...)"` для package.json не требуется (пакет не меняет профиль package.json).
- [ ] **Step 5: прогон** — `cd packages/plugins/dsh-balbes-telegram && bash node_modules/.bin/vitest run && bash node_modules/.bin/tsc --noEmit -p tsconfig.json` — Expected: PASS. Плюс `bash -n scripts/install.sh` в корне.
- [ ] **Step 6: commit**

```bash
git add packages/plugins/dsh-balbes-telegram profiles/balbes/cordis.patch.yml scripts/install.sh .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "feat(telegram): scaffold plugin package and profile wiring"
```

---

### Task 4: `dsh-balbes-workspaces` — чтение файла + service `balbesWorkspaces`

**Files:**
- Create: `packages/plugins/dsh-balbes-workspaces/src/file.ts`, `src/service.ts`
- Modify: `packages/plugins/dsh-balbes-workspaces/src/index.ts` (provide сервиса), `tests/index.test.ts` (fake ctx + assertions), `packages/plugins/dsh-balbes-workspaces/tests/tree.test.ts` (добавить проверку чтения файла поверх существующих helper'ов, если уместно — на усмотрение исполнителя)
- Create: `packages/plugins/dsh-balbes-workspaces/tests/file.test.ts`, `tests/service.test.ts`

**Consumes:** `src/workspaces.ts` (`WorkspaceError`, `workspaceError`, `workspaceBase`, `listWorkspaces`, `homeDir`, `projectsRoot`, `validateProjectName`), `src/tree.ts` (`readWorkspaceDir`, `isValidRelPath`, `WorkspaceScope`, `TreeEntry`). Спекулятивная справка по containment-правилам: `tree.ts` уже делает lexical + realpath containment; дизайн требует тех же правил для чтения файла.

**Produces (потребляют Task 10 chat.ts, Task 11 admin, Task 7 agentTask):**
- `src/file.ts`:
  ```ts
  export type WorkspaceFileKind = "text" | "binary" | "link";
  export type WorkspaceFileResult =
    | { kind: "text"; content: string; truncated: boolean }
    | { kind: "binary"; size: number }
    | { kind: "link" };
  export async function readWorkspaceFile(
    dshHome: string, scope: WorkspaceScope, name: string | undefined,
    relPath: string, opts?: { maxBytes?: number }
  ): Promise<WorkspaceFileResult>;
  ```
  Поведение: `isValidRelPath` иначе `invalid-path`; `workspaceBase` (бросает `invalid-name`/`invalid-path` для несуществующих/выходящих имён); lstat конечной записи `resolve(base, relPath)`: symlink → `{kind:"link"}` без разыменования; realpath-контеймент конечной записи внутри realpath-корня (иначе `not-found` с сообщением outside — как в `readWorkspaceDir`); чтение Buffer'ом лимит `maxBytes` (default 256 KiB) + 1 байт; NUL-байт в первых 8 KiB → `binary`; иначе utf8-декод; если размер файла > `maxBytes` — `truncated: true` и контент обрезан; ENOENT/ENOTDIR → `not-found`. Права файла не меняются (read-only).
- `src/service.ts`:
  ```ts
  export interface BalbesWorkspacesService {
    list(): Promise<{ home: { path: string }; projects: Array<{ name: string; path: string; createdAt?: string }> }>;
    root(scope: WorkspaceScope, name: string | undefined): Promise<string>;
    readDir(scope: WorkspaceScope, name: string | undefined, relPath: string): Promise<TreeEntry[]>;
    readFile(scope: WorkspaceScope, name: string | undefined, relPath: string): Promise<WorkspaceFileResult>;
  }
  export function createWorkspacesService(dshHome: string): BalbesWorkspacesService;
  ```
  `index.ts::apply` дополнительно: `ctx.provide("balbesWorkspaces", createWorkspacesService(dshHome))` (после `ensureHome`). Тип ctx в apply расширяется полем `provide(key: string, value: unknown): void`.

- [ ] **Step 1: failing unit-тесты `file.test.ts`**

Временный `dshHome` (mkdtemp), проект создаётся через доменные функции (`createProject`), файлы пишутся вручную. Кейсы (каждый — `await expect(...).rejects.toMatchObject({ code })` или результат kind):
- text: `notes.txt` "hello world" → `{kind:"text", content:"hello world", truncated:false}` (scope project + home);
- nested: `src/a/b.txt`;
- missing → code `not-found`;
- traversal `../x.txt`, absolute `/etc/hostname`, `..\x` → `invalid-path`;
- выход из проекта: scope project `name:"p1"`, rel `"../p2/x.txt"` → `invalid-path` (лексика) и rel внутрь p2 через symlink-каталог → `not-found` outside;
- symlink: `ln -s /etc/hostname ws/p1/evil.txt` → `{kind:"link"}` (содержимое не читается);
- symlink-каталог: `ln -s <outside> ws/p1/out` + `readWorkspaceFile(...,"out/x.txt")` → `not-found` outside;
- binary: Buffer `[0x00, 0x01]` → `{kind:"binary"}`;
- oversize: файл 300 байт при `{maxBytes: 100}` → `truncated:true`, `content.length === 100`;
- home scope: файл в `$DSH_HOME/agent/` читается с scope home.

- [ ] **Step 2: run — RED** (`cd packages/plugins/dsh-balbes-workspaces && bash node_modules/.bin/vitest run tests/file.test.ts`) — Expected: модуль `../src/file.js` не найден.
- [ ] **Step 3: реализовать `file.ts`** по Produces; переиспользовать `isWithin`-логику из `tree.ts` (вынести общий `isRealWithin(root, target)` в `tree.ts` и импортировать в `file.ts` — рефактор минимальный, существующие тесты tree остаются зелёными).
- [ ] **Step 4: GREEN file** + typecheck (`bash node_modules/.bin/tsc --noEmit -p tsconfig.json`).
- [ ] **Step 5: service + provide.** Реализовать `service.ts`; в `index.ts::apply` добавить `provide`; дополнить `tests/index.test.ts`: fake ctx получает `provide(key, value)` (запоминает в Map), assertion — `provided["balbesWorkspaces"]` определён; в `tests/service.test.ts` — facade поверх temp-дома: `list()` возвращает home+project; `root("project","p1")` === путь; `readDir`/`readFile` проксируют в доменные функции (энд-ту-энд кейс text-чтения).
- [ ] **Step 6: прогнать весь unit-сьют пакета** (workspaces): `bash node_modules/.bin/vitest run` — GREEN; затем типчек.
- [ ] **Step 7: commit**

```bash
git add packages/plugins/dsh-balbes-workspaces/src packages/plugins/dsh-balbes-workspaces/tests
git commit -m "feat(workspaces): file read with containment and balbesWorkspaces service"
```

---

### Task 5: Bot API клиент (чистый `fetch`, retry, masking) + unit

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/src/bot.ts`, `tests/bot.test.ts`

**Consumes:** факт Task 1 (клиент без новых зависимостей — node:fetch), структура плагина Task 3. Справка: Telegram Bot API — POST `https://api.telegram.org/bot<token>/<method>` JSON; `getMe`/`getUpdates`/`sendMessage`/`editMessageText`/`answerCallbackQuery`; ошибки `{ok:false, error_code, description}`.
**Produces (потребляют Task 9 poller, Task 10 chat, Task 11 admin):**
```ts
export interface BotUpdate { update_id: number; message?: { message_id: number; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean }; text?: string; date?: number }; callback_query?: { id: string; from: { id: number }; message?: { message_id: number; chat: { id: number; type: string } }; data?: string } }
export class BotApiError extends Error { constructor(public status: number, public telegramCode: number | undefined, message: string) }
export interface BotClient {
  getMe(): Promise<{ username?: string; id?: number }>;
  getUpdates(opts: { offset?: number; timeout?: number }): Promise<BotUpdate[]>;
  sendMessage(chatId: number, text: string, extra?: { reply_markup?: unknown }): Promise<void>;
  editMessageText(chatId: number, messageId: number, text: string, extra?: { reply_markup?: unknown }): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<void>;
}
export function createBotClient(opts: { token: string; apiBase?: string; fetchImpl?: typeof fetch; retries?: number }): BotClient;
```
- Каждый вызов — `POST {apiBase}/bot{token}/{method}`; `apiBase` default `https://api.telegram.org` (переопределяется в тестах и REAL-фикстуре на `http://127.0.0.1:<fake-port>`); `timeout` для getUpdates передаётся телом запроса.
- Ошибка HTTP: парсим `{ok:false, error_code?, description?}` → `BotApiError(status, error_code, description)`. Токен ни в одном сообщении ошибки не фигурирует; сообщение ошибки — только description от Telegram.
- Временные сбои (network rejection, 429/5xx): `retries` (default 2) повторов с паузой (25ms × n, чтобы тесты были быстрыми); после исчерпания — `BotApiError(0, undefined, "temporary failure: <reason>")`. 4xx (включая 401) НЕ ретраятся.

- [ ] **Step 1: failing-тесты `bot.test.ts`** — fake `fetchImpl` (vi.fn) возвращает управляемые Response-подобные объекты `{ ok, status, json: async () => body }`; каждый тест инжектит свой fetchImpl:
  - `getMe` — assert URL равен `http://fake.local/bot<token>/getMe`, body `{}`; результат username.
  - `getUpdates({offset: 41, timeout: 50})` — body `{"offset":41,"timeout":50}`; возвращает `result` массив.
  - `sendMessage(1, "hi", {reply_markup:{...}})` — тело содержит text и reply_markup.
  - `answerCallbackQuery` — тело `{callback_query_id, ...}`.
  - ошибка `{ok:false, error_code:401, description:"Unauthorized"}` → `BotApiError` со `status === 401`, `.telegramCode === 401`; **сообщение ошибки не содержит token** (`expect(String(err)).not.toContain("TOKEN")`).
  - retry: первый вызов `fetch` бросает network error (rejects), второй успешен → итог ok, `fetchImpl` вызван 2 раза; 401 не ретраится (`fetchImpl` вызван 1 раз).
- [ ] **Step 2: run — RED** (cwd пакета, vitest по файлу).
- [ ] **Step 3: реализовать `bot.ts`** по Produces; внутри `call()`: JSON.stringify payload, `AbortSignal.timeout(60_000)`, буфер ответа текстом и `JSON.parse` (иначе `BotApiError(0, undefined, "non-json response")`); проверка `ok !== true` в ответе.
- [ ] **Step 4: run — GREEN** + typecheck пакета.
- [ ] **Step 5: commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/bot.ts packages/plugins/dsh-balbes-telegram/tests/bot.test.ts
git commit -m "feat(telegram): Bot API fetch client with retry and error masking"
```

---

### Task 6: Разбор/авторизация update + текстовые helpers

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/src/updates.ts`, `src/text.ts`, `tests/updates.test.ts`, `tests/text.test.ts`

**Consumes:** `src/bot.ts` (`BotUpdate`). Правила спеки: allowlist `from.id` + `chat.type === "private"`; чужие update игнорируются «без раскрытия состояния сервера»; callback и пути никогда не доверяются; ответы Telegram-лимита разбиваются; текст агента уходит plain text (без parse_mode).
**Produces (потребляют Task 10 chat, Task 9 poller):**
```ts
// updates.ts
export type ClassifiedUpdate =
  | { kind: "message"; messageId: number; chatId: number; text: string }
  | { kind: "callback"; callbackQueryId: string; messageId: number; chatId: number; data: string };
export function isAuthorized(update: BotUpdate, allowedUserId: number): boolean; // message/callback: from.id === allowedUserId И chat.type === "private"; без from/не private — false
export function classify(update: BotUpdate): ClassifiedUpdate | null; // null = игнорируемый (без текста/data, edit-события и т.п.)
export function isCommand(text: string): boolean; // text.startsWith("/")

// text.ts
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export function splitMessage(text: string, limit?: number): string[]; // по границам \n, без пустых чанков, каждый <= limit
export function sanitizeReply(text: string): string; // обрезает управляющие \0, заменяет \r\n? -> \n; гарантирует plain-text совместимость
```
Авторизация в poller/chat: `classify` вызывается только ПОСЛЕ `isAuthorized` — неавторизованный update вообще не классифицируется (нет ветки, способной что-то «узнать»). Всё чистое (без I/O, без сети) — unit-friendly.

- [ ] **Step 1: failing-тесты**

`updates.test.ts` (маленькие фабрики `mkMessage(fromId, chatType, text)`, `mkCallback(...)`):
- авторизация: свой from.id + private → true; чужой from.id + private → false; свой from.id + group/supergroup/channel → false; без `from`/`chat.type` → false; callback с тем же правилом.
- classify: текстовое сообщение → `{kind:"message", text}`; сообщение без text (фото и т.п.) → null; callback c data → `{kind:"callback", data}`; callback без data → null.
- isCommand: `/start`, `/files` → true; `привет /files` (не в начале) → false.

`text.test.ts`:
- splitMessage: текст ≤ limit → один чанк; текст 10000 символов с \n каждые 40 → чанки все ≤ limit и непустые, join === исходный текст; слово длиннее limit → режется без потерь (join === исходный).
- sanitizeReply: `\0` вырезаются; `\r\n` нормализуются; остальное не меняется.

- [ ] **Step 2: run — RED** (оба файла, vitest cwd пакета).
- [ ] **Step 3: реализовать `updates.ts`, `text.ts`** по Produces. В `splitMessage` сначала резать по `\n`, длинные «куски» дорезать по limit символов; пустые чанки отбрасывать.
- [ ] **Step 4: run — GREEN** + typecheck.
- [ ] **Step 5: commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/updates.ts packages/plugins/dsh-balbes-telegram/src/text.ts packages/plugins/dsh-balbes-telegram/tests/updates.test.ts packages/plugins/dsh-balbes-telegram/tests/text.test.ts
git commit -m "feat(telegram): update auth/classify and message split helpers"
```

---

### Task 7: `agentTask` — workspace-aware runner штатного agent loop (persistent-сессии)

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/src/agentTask.ts`, `tests/agentTask.test.ts`

**Consumes:** Task 1 факты (процедура create/resume/flush; семантика dispose/cancel; контеймент-вывод), Task 4 service `balbesWorkspaces`, структурные типы из `packages/bundles/dsh-balbes-host/src/runner.ts` (AgentLike/AgentHandleLike/AgentsService/SessionsService/DefaultModelService, `brandString`, `createUserMessage`, `installModelSelection` — прочитать и переиспользовать как образец; сам runner НЕ импортируется). Факт Task 1 может показать необходимость guard'а в `composeAgentSetup` (абсолютные пути/`..`/shell-выход реальных tools) — этот шаг здесь.
**Produces (потребляют Task 10 chat, Task 11 index; используется Task 12 REAL):**
```ts
export type WorkspaceRef = { scope: "home" } | { scope: "project"; name: string };
export function workspaceRefKey(ref: WorkspaceRef): string; // "home" | "project:<name>" (ключ state-маппинга)
export type TaskResult =
  | { ok: true; text: string; sessionId: string }
  | { ok: false; code: "workspace-gone" | "agent-error" | "queue-full" | "busy"; message: string };
export interface AgentTaskRunner {
  run(ref: WorkspaceRef, text: string, opts?: { sessionId?: string }): Promise<TaskResult>;
  reset(ref: WorkspaceRef): Promise<void>;
  sessionIdOf(ref: WorkspaceRef): string | undefined;
  snapshot(): Array<{ key: string; sessionId: string }>; // для персиста mapping (Task 8/11)
}
export interface AgentTaskDeps {
  loader?: { await(): Promise<void> };
  agents: { create(o: unknown): Promise<AgentHandleLike>; resume(o: { resumeSessionId: string; agentOptions: { provider: string; model: string }; setup: (c: unknown) => void }): Promise<AgentHandleLike> }; // структурно, см. runner.ts + Task 1 факты
  sessions: { flush(session: unknown): Promise<void> };
  defaultModel?: { currentSelection(): { provider: string; model: string } };
  workspaces: BalbesWorkspacesService; // Task 4
  logger?: { warn(m: string): void };
}
export function createAgentTaskRunner(deps: AgentTaskDeps): AgentTaskRunner;
```
Семантика:
- `run`: `await deps.loader?.await()`; `ref` → `root = workspaces.root(scope, name)` (исключение `WorkspaceError` → `{ok:false, code:"workspace-gone"}` c безопасным сообщением); активная задача на тот же key → `{ok:false, code:"busy"}` (не дублируется); очередь key — до 3 ожидающих, переполнение → `{ok:false, code:"queue-full"}`; затем сериализованно: handle из кэша key, иначе create/resume: `opts.sessionId` известен → `agents.resume({resumeSessionId, agentOptions:{provider,model} из defaultModel.currentSelection(), setup})`; resume-провал (сессия не найдена/повреждена) логируется warn → создаётся новая (`agents.create`), mapping сбрасывается (plugin узнает через `sessionIdOf`); без sessionId → `agents.create({sessionId: brandString("session-"+randomUUID()), meta:{cwd: root}, agentOptions, setup: composeAgentSetup})`. `composeAgentSetup(agentCtx)` = `installModelSelection(...)` по образцу runner.ts, ПЛЮС, если Task 1 показал containment-провал, guard (restrict/scope-инструменты до корня; реализация опирается на рычаги, найденные в Task 1 Step 2/3, с REAL-регрессией из Task 1 как приёмкой).
- Turn (по runner.ts): `await agent.whenIdle()` → `agent.followup(createUserMessage({content:[{type:"text",text}], source:{kind:"user"}}))` → `await agent.whenIdle()` → `await sessions.flush(agent.session)`; текст и reason собираются из session-событий циклом `firstSeq..seq` (перенести логику из runner.ts дословно); `{ok:true, text, sessionId}`. Исключение/`reason.kind === "error"` → `{ok:false, code:"agent-error", message: <безопасно>}` (без stack).
- `reset`: отменить текущую задачу (если активна) и очистить очередь key: по фактам Task 1 — `handle.dispose()` (останавливает loop, убирает агента из реестра) и/или `agent.cancel` перед dispose; handle из кэша удаляется; mapping обнуляется (`sessionIdOf` → undefined).
- `snapshot`/`sessionIdOf`: кэш `Map<key, {handle, sessionId, busy, queue: string[]}>`.

Unit-тесты — с фейковыми deps (никакого реального dsh/LLM): `agents.create` возвращает fake-handle, эмулирующий session-события (после followup пишет ассистентский текст в события; `whenIdle` резолвится) — тем самым проверяются: create один раз на key, повторный run без sessionId переиспользует handle (create вызван 1 раз); resume при переданном `sessionId`; FIFO: 2 задачи на key выполняются последовательно (create один, followup дважды); активная задача → busy; очередь 4-я задача → queue-full; reset убирает handle и mapping; workspace-gone при `workspaces.root` броске; agent-error при throw из whenIdle (без stack в message); два разных key → два разных sessionId (`snapshot()`), create вызван дважды; `sessions.flush` вызван после каждого успешного run; текст из события извлекается.

- [ ] **Step 1: failing-тесты `agentTask.test.ts`** (fake deps по описанию выше; фейковый `workspaces` с temp-путём, `root` возвращает mkdtemp-каталог).
- [ ] **Step 2: run — RED** (модуль не существует).
- [ ] **Step 3: реализовать `agentTask.ts`** по Produces; логику извлечения текста/reason перенести из `runner.ts` (указать файл как источник).
- [ ] **Step 4: run — GREEN** + typecheck. Затем прогнать REAL Task 1 (seams.test.ts) — если containment-провал в Task 1 зафиксирован и guard добавлен в `composeAgentSetup`, REAL-тест seams должен остаться зелёным (guard не ломает разрешённые чтения внутри ws).
- [ ] **Step 5: commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/agentTask.ts packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts
git commit -m "feat(telegram): workspace-aware agent task runner with persistent sessions"
```

---

### Task 8: State-файл `telegram-state.json`

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/src/state.ts`, `tests/state.test.ts`

**Consumes:** правила спеки §Состояние (только нечувствительные данные; mode 600; atomic tmp+rename; token не пишется), образец атомарной записи — `packages/plugins/dsh-balbes-workspaces/src/workspaces.ts::writeRegistry` и shape-валидация `packages/bundles/dsh-balbes-host/src/core.ts::parseAdminAuth`.
**Produces (потребляют Task 11 index, Task 7 agentTask через snapshot/опции):**
```ts
export interface TelegramStateData {
  version: 1;
  activeWorkspace?: string;             // "home" | "project:<name>" — см. workspaceRefKey
  sessions: Record<string, string>;     // key -> dsh sessionId
  offset?: number;                      // последний обработанный Telegram update_id
}
export class TelegramState {
  constructor(private readonly file: string) {}
  load(): Promise<TelegramStateData>;              // ENOENT -> default {version:1, sessions:{}}
  save(next: TelegramStateData): Promise<void>;    // atomic tmp+rename, chmod 600
  static defaultFile(dshHome: string): string;     // join(dshHome, "telegram-state.json")
}
```
Валидация при load: shape-check как `parseAdminAuth` (version===1, sessions — объект строк; offset — положительное целое если есть; activeWorkspace — string если есть); невалидный файл → ошибка с именем файла (не «тихий» сброс). Сессионные id и имена проектов — только `[A-Za-z0-9._:-]`-подобные символы (sessionId из `brandString`), секретов в файле нет по построению.

- [ ] **Step 1: failing-тесты** (temp dir):
  - save → файл существует, mode 600 (`stat(...).mode & 0o777 === 0o600`), JSON валиден;
  - load после save возвращает те же данные (round-trip с activeWorkspace/sessions/offset);
  - ENOENT → default `{version:1, sessions:{}}`;
  - повреждённый JSON / неверный version / sessions не объект строк → бросает с именем файла;
  - token-строка, случайно попавшая в данные, НЕ является частью контракта — тест только фиксирует, что тип данных не имеет поля token (compile-time, не runtime).
- [ ] **Step 2: run — RED; Step 3: реализовать `state.ts`** (load: readFile → ENOENT default; parse+shape-check; save: writeFile tmp `${file}.tmp.${pid}.${randomUUID()}` mode 600 → chmod → rename, best-effort unlink tmp при ошибке — дословный паттерн writeRegistry).
- [ ] **Step 4: run — GREEN** + typecheck.
- [ ] **Step 5: commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/state.ts packages/plugins/dsh-balbes-telegram/tests/state.test.ts
git commit -m "feat(telegram): atomic state file with strict shape validation"
```

---

### Task 9: Polling loop (long polling, offset, retry/backoff, dispose)

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/src/poller.ts`, `tests/poller.test.ts`

**Consumes:** Task 5 `BotClient`/`BotApiError`, Task 6 `BotUpdate`/`isAuthorized`. Правила спеки: один long-polling loop на процесс; `getUpdates` с offset; retry/backoff для временных ошибок; `401 Unauthorized` — остановка и статус ошибки; dispose через `AbortController`; offset персистится (Task 8) и восстанавливается после рестарта.
**Produces (потребляют Task 10 chat, Task 11 index; REAL Task 12):**
```ts
export type PollState = "stopped" | "running" | "error";
export interface PollStatusDetail { state: PollState; lastPollAt?: string; lastError?: { code: string; message: string } }
export interface PollerCallbacks {
  onUpdate(update: BotUpdate): Promise<void> | void; // уже авторизованные? нет — isAuthorized внутри poller по allowedUserId
  onFatal(error: BotApiError): void;                 // 401: poller останавливается, статус error
}
export interface Poller {
  start(opts: { bot: BotClient; allowedUserId: number; offset?: number }): void;
  stop(): Promise<void>;                              // abort + дождаться выхода цикла
  status(): PollStatusDetail;
}
export function createPoller(cb: PollerCallbacks, opts?: { pollTimeoutSec?: number; idleMs?: number; maxBackoffMs?: number }): Poller;
```
Логика цикла:
- `start`: если уже running — no-op; сброс `lastError`; цикл: `getUpdates({offset, timeout: pollTimeoutSec})` → для каждого update: `isAuthorized(update, allowedUserId)` → авторизованный передаётся в `cb.onUpdate` (неавторизованный игнорируется без какой-либо обработки); после успешной пачки `offset = last.update_id + 1` и `lastPollAt` обновляется; между пачками пауза `idleMs` (default 300ms) через abortable sleep; ошибка:
  - `BotApiError` со `status === 401` → `cb.onFatal`, state → "error", цикл завершается;
  - прочие `BotApiError`/network — backoff (начинается 1s, удвоение до `maxBackoffMs` default 30s), state остаётся "running", `lastError` обновляется; после успешной пачки backoff сбрасывается.
- Весь цикл слушает один `AbortSignal` (из `AbortController` poller'а): `stop()` aborts и ждёт завершения итерации (Promise); dispose-чистота: никаких висячих таймеров (sleep/timer с signal), повторный `start` после `stop` работает (новый offset берётся из аргумента/последнего).
- Poller НЕ знает про Telegram-состояние/файлы — чистый транспорт.

Unit-тесты (fake `BotClient` из Task 5 стиля — объект с vi.fn, управляемые очереди ответов; детерминированные короткие таймеры через инжект `idleMs`/`maxBackoffMs`):
- первая пачка: offset без значения → getUpdates вызван c `{timeout: 50}`; после 2 update → второй вызов `{offset: second+1}`.
- onUpdate получает только авторизованные (allowedUserId матчинг); неавторизованный из той же пачки не передан.
- 401 → onFatal вызван, status().state === "error", цикл остановлен (больше getUpdates нет).
- временная ошибка → backoff, следующий getUpdates через ≥ maxBackoff/backoff; после успеха backoff сброшен (следующий вызов сразу).
- stop() на running → getUpdates больше не вызывается, Promise stop резолвится; повторный start работает.
- status() до start: "stopped".

- [ ] **Step 1: failing-тесты `poller.test.ts`** (по кейсам выше; fake bot: `getUpdates` = vi.fn с последовательностью: возврат массива / бросок network Error / возврат...; для 401 — бросок `BotApiError(401, 401, "Unauthorized")`).
- [ ] **Step 2: run — RED; Step 3: реализовать `poller.ts`** (цикл через `while (!signal.aborted)`, abortable sleep `new Promise(resolve => { const t = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); })`; `stop()` = abort + ожидание текущего `run`-promise).
- [ ] **Step 4: run — GREEN** + typecheck. (Детерминизм: в тестах использовать `idleMs: 1`, `maxBackoffMs: 5`, а не реальные секунды.)
- [ ] **Step 5: commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/poller.ts packages/plugins/dsh-balbes-telegram/tests/poller.test.ts
git commit -m "feat(telegram): long-polling loop with offset, backoff, fatal 401"
```

---

### Task 10: `chat.ts` — UX-машина владельца (workspace-выбор, задачи, дерево, файлы)

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/src/chat.ts`, `tests/chat.test.ts`
- (Опционально при росте: `src/keyboards.ts` — чистые билдеры inline-клавиатур; решение исполнителя, интерфейсы ниже не меняются.)

**Consumes:** Task 4 (`BalbesWorkspacesService`), Task 5 (`BotClient`), Task 6 (`ClassifiedUpdate`, `splitMessage`, `sanitizeReply`, TELEGRAM_MESSAGE_LIMIT), Task 7 (`AgentTaskRunner`, `WorkspaceRef`, `workspaceRefKey`). UX-спека: разделы «Выбор workspace», «Задачи», «Файлы», «Состояния и ошибки» дизайн-документа.

**Callback-протокол (payload ≤ 64 символа; никаких путей/имён в payload — только короткие коды и индексы из snapshot'а, который сервер держит в памяти и пере-валидирует на диске при каждом callback):**
- `menu` — корневое меню; `ws` / `ws:pg:<n>` — список воркспейсов, страница n;
- `ws:pick:<i>` — выбор i-й строки последнего отрисованного списка (перечитать `workspaces.list()`, строку i проверить заново);
- `act:task`, `act:files`, `act:ws` (другой воркспейс), `act:reset` — действия под активным workspace;
- `e:<i>` — i-я запись текущего listing-снапшота (каталог/файл; re-readDir/re-readFile по relPath снапшота);
- `up` — родительский каталог; `pg:<n>` — страница listing/файла;
- `reset:yes` / `reset:no` — подтверждение сброса контекста.

**Публичный интерфейс:**
```ts
export interface ChatDeps {
  workspaces: BalbesWorkspacesService;
  runner: AgentTaskRunner;
  bot: BotClient;
  maxFileBytes: number;                 // из Config
  listPageSize?: number;                // default 8 (workspaces), filePageChars default 3000
  onActiveChange(ref: WorkspaceRef | undefined): void; // index.ts персистит activeWorkspace
  logger?: { warn(m: string): void };
}
export interface ChatMachine {
  onMessage(update: ClassifiedUpdate & { kind: "message" }): Promise<void>;
  onCallback(update: ClassifiedUpdate & { kind: "callback" }): Promise<void>;
  activeWorkspace(): WorkspaceRef | undefined;
  setActiveWorkspace(ref: WorkspaceRef | undefined): void; // boot-restore из state
}
export function createChatMachine(deps: ChatDeps): ChatMachine;
```
Семантика (безопасные тексты на русском; всё идёт через `bot.sendMessage`/`bot.editMessageText`; текст — plain text, разбивается `splitMessage`; ошибки агента/Telegram — без stack):
- `/start`, `menu`: приветствие «Привет! Я агент твоего сервера.» + inline-клавиатура [«Воркспейсы»].
- «Воркспейсы»/`ws`: `workspaces.list()`; строки: «Дом агента», затем проекты; страницы по `listPageSize`; пагинация — `editMessageText` того же сообщения; каждая строка — кнопка `ws:pick:<i>`; внизу «◀ ▶» при нескольких страницах. Пустой список проектов — всё равно показывается Дом агента (спека: home всегда есть).
- `ws:pick:<i>`: перечитать `list()`; строка i вне диапазона/проект исчез — безопасное «Список устарел, откройте заново» (answerCallbackQuery) и перерисовать список; иначе `setActiveWorkspace`, `onActiveChange`, сообщение «Выбран: <Дом агента|Проект: name>» + клавиатура [«Задачи», «Файлы», «Сбросить контекст», «Другой воркспейс»].
- Сообщение-текст (не команда): без активного — подсказка + кнопка «Воркспейсы»; с активным — `bot.sendMessage(chatId, "Задача принята…")`, затем `runner.run(ref, text)`:
  - `ok:true` → финальное сообщение: `splitMessage(sanitizeReply(text))`, каждому чанку свой sendMessage;
  - `ok:false` по кодам: `queue-full` → «В этом воркспейсе уже 3 задачи в очереди — дождитесь завершения»; `busy` → «Задача уже выполняется…»; `workspace-gone` → сброс active (onActiveChange(undefined)) + «Воркспейс удалён — выберите другой» + кнопка «Воркспейсы»; `agent-error` → «Агент не смог выполнить задачу: <message>» (message — код/безопасная фраза).
- `act:files`: чтение корня активного: `readDir(scope, name, "")`; snapshot в памяти по messageId; список кнопками (каталоги и файлы; `kind:"link"` — кнопка disabled с суффиксом «(ссылка)»); «⬆ вверх» (на relPath родителя), страницы.
- `e:<i>` на каталог: re-readDir по snapshot relPath (исчез — перерисовать с родителя, если родитель тоже исчез — с корня); на файл: `readFile` → `link`/`binary` → сообщение «Это ссылка/бинарный файл (N байт) — просмотр недоступен»; `text` → страницы по `filePageChars` (re-readFile на каждой «Дальше» — контент актуален), первая страница + «Дальше» при наличии остатка/`truncated`, «⬆ назад к списку» (редактирование того же сообщения через `editMessageText`).
- `act:reset` → подтверждение `reset:yes/no`; `reset:yes` → `runner.reset(ref)` + «Контекст сессии сброшен».
- Неизвестный/устаревший callback (messageId нет в памяти — после рестарта, индекс вне снапшота, неизвестный код) → `answerCallbackQuery(id)` без текста либо «Действие устарело — повторите»; содержимое чужих данных не раскрывается.

Unit-тесты `chat.test.ts` (fake deps: `workspaces` с temp-каталогом или захардкоженными списками, `runner` с управляемым `run`-результатом, `bot` — записывающий fake по образцу bot.test; проталкиваются `ClassifiedUpdate` объекты, вызываются методы машины, ассерты — по вызовам `bot.sendMessage`/`editMessageText`): /start; список с пагинацией (2 страницы); pick home и project; задача ok (текст режется на 2 чанка при >4096); все четыре кода ошибки runner (включая сброс active при workspace-gone); дерево: dir open, up, файл text c «Дальше», binary, link (кнопка-ссылка не открывается); reset confirm/cancel; stale callback по неизвестному data; пустое состояние без active (подсказка). Если машина разрастётся — файл `keyboards.ts` с чистыми функциями клавиатур и своими юнитами, остальное без изменений.

- [ ] **Step 1: failing-тесты** (по списку выше; запуск только тестов chat).
- [ ] **Step 2: run — RED** (модуль отсутствует).
- [ ] **Step 3: реализовать `chat.ts`** по протоколу/семантике; структура состояния машины: `Map<messageId, Snapshot>` (snapshots listing/file), текущий `active`, ожидание ответа задачи не блокирует другие сообщения (runner сам сериализует).
- [ ] **Step 4: run — GREEN** + typecheck; прогнать весь unit-сьют пакета (bot/updates/text/poller/state/agentTask/chat) — все зелёные.
- [ ] **Step 5: commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src/chat.ts packages/plugins/dsh-balbes-telegram/src/keyboards.ts packages/plugins/dsh-balbes-telegram/tests/chat.test.ts packages/plugins/dsh-balbes-telegram/tests/keyboards.test.ts
git commit -m "feat(telegram): owner chat UX machine (workspaces, tasks, file tree)"
```

---

### Task 11: Сборка плагина — настройки, polling runtime, admin-ручки

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/index.ts` (полная реализация), `tests/index.test.ts` (расширить)
- Create: `packages/plugins/dsh-balbes-telegram/src/admin.ts` (опционально — чистые обработчики ручек; решение исполнителя, экспорт `registerTelegramRoutes` из index.ts или admin.ts)

**Consumes:** Task 2 контракты (структурно, пакет их не импортирует — дублирует структурные типы по образцу workspace-плагина), Task 3 namespace `balbes-telegram` + `TELEGRAM_BOT_TOKEN_REF`, Task 5 `createBotClient`/`BotApiError`, Task 7 `createAgentTaskRunner`, Task 8 `TelegramState`, Task 9 `createPoller`, Task 10 `createChatMachine`, Task 4 `balbesWorkspaces`, Task 6 `classify`/`isAuthorized`. Образцы кода: models `registerModelsCatalogRoute`-паттерн (чистая регистрация ручек с инжектированными deps) и `packages/plugins/dsh-balbes-models/src/index.ts::apply`.

**Produces (потребляют Task 12 REAL, Task 13 SPA):**
```ts
// export из index.ts (admin.ts), чистая функция — unit без сети:
export interface TelegramAdminDeps {
  settingsScope: { get(): { enabled: boolean; allowedUserId: number | null }; update(patch: object): Promise<void> };
  credentials: { describe(ref: string): Promise<{ configured: boolean }>; set(ref: string, v: string): Promise<void>; unset(ref: string): Promise<void> };
  botFactory: (token: string) => BotClient;
  poller: Poller;
  statusExtras(): Promise<{ botUsername?: string; lastPollAt?: string }>; // из runtime-кэша (getMe result, poller.lastPollAt)
}
export function registerTelegramRoutes(http: HttpSeatLike, deps: TelegramAdminDeps): void;
```
Ручки (bearer, POST) с валидацией и маппингом ошибок по R-API-1:
- `POST /api/telegram/status` → `{ status: <TelegramSettingsStatus> }`. Маппинг state: `!tokenConfigured` → `not-configured`; `enabled=false` → `disabled`; иначе: poller `running` без lastError → `connected`, poller `error`/не running → `error` с `error:{code,message}`. Поле `tokenConfigured` — boolean; **токен не возвращается** (ответ строится из ключей контракта Task 2).
- `POST /api/telegram/save` `{ token?, allowedUserId?, enabled? }`: пустой/не-string `token` → не менять; непустой — `credentials.set(REF, token.trim())`. `allowedUserId`: отсутствует → не менять; иначе положительное целое (Number.isInteger, >0) → иначе 400 `invalid-user-id`. `enabled: true` при `!tokenConfigured || allowedUserId==null` → 400 `invalid-config` («включите после ввода токена и User ID»). Запись: `settingsScope.update({...(allowedUserId!=null ? {allowedUserId}: {}), ...(typeof enabled==="boolean" ? {enabled}: {})})`. Затем runtime-переход (см. apply). Ответ `{ status }`.
- `POST /api/telegram/test`: без tokenConfigured → 400 `not-configured`; иначе `botFactory(token).getMe()` → 200 `{ username }`; ошибка getMe (401 и пр.) → 502/400 по типу с безопасным сообщением. Ничего не сохраняет и polling не трогает.
- `POST /api/telegram/disable`: `settingsScope.update({enabled:false})` + остановка poller; ответ `{ status }`.
- `POST /api/telegram/clear-token`: остановка poller; `credentials.unset(REF)`; `settingsScope.update({enabled:false})`; ответ `{ status }`.

`apply` (полный): резолв `dshHome`; `settings.register("balbes-telegram", schema)` → scope (схема из Task 3); инициализация компонентов: `state = new TelegramState(join(dshHome,"telegram-state.json"))`, `workspacesService = ctx.get("balbesWorkspaces")`, `runner = createAgentTaskRunner({loader, agents, sessions, defaultModel, workspaces, logger})` (агентские сервисы — структурные типы runner.ts), `poller = createPoller({onUpdate, onFatal})`, `chat = createChatMachine({workspaces, runner, bot: отложенно, onActiveChange})`; **bot создаётся per-токен** (меняется при save/clear) — индирекция `currentBot()`. Обработка update: `classify` авторизованного → `chat.onMessage/onCallback` (answerCallbackQuery внутри chat), после каждой пачки — персист offset в state. Runtime-переходы:
- `applyRuntime()` (асинхронно, с catch-warn): если `scope.get().enabled && tokenConfigured` → `poller.start({bot: currentBot(), allowedUserId, offset: state.offset})`, кэшируем `botUsername` через `bot.getMe()` (ошибка → poller error-state, сообщение в статус); иначе — ничего (disabled).
- `scope.watch((next) => applyRuntime-ish)`: `enabled` false→ stop; true→ start (watch вызывается после коммита настроек; переходы идемпотентны: `start` на running — no-op). Это и есть «изменение настроек запускает/останавливает polling без рестарта».
- boot-restore: `state.load()` → если активный workspace есть в `workspaces.list()` — `chat.setActiveWorkspace` (иначе сброс); mapping sessions НЕ восстанавливается в runner принудительно — каждый workspace при первой задаче resume-ится лениво через `opts.sessionId = state.sessions[key]` (Task 7); после каждого успешного `runner.run` — `state.sessions[key]=sessionId` + save.
- `onFatal` (401): статус `error`; polling остановлен; runtime-ошибка доступна в `/status`.
- dispose: `ctx.effect`-очистка: `poller.stop()` (AbortController), никаких таймеров; регистрация effect-ов по образцу dsh-плагинов (`ctx.effect(() => () => {...})`), при отсутствии `ctx.effect` в типе — вызов через `(ctx as {effect?: (fn:()=>()=>void)=>unknown}).effect`.

Unit-тесты `tests/index.test.ts` (по паттерну models `registerModelsCatalogRoute`-тестов и workspace index-тестов): fake `http`-seats собирают роуты (5 ручек, все bearer); fake settingsScope (объект с get/update), fake credentials (в памяти), fake botFactory (возвращает fake bot: getMe → {username:"test_bot"}, getUpdates — управляемо), fake poller со state-переходами (start/stop/status): 
- status: нет токена → not-configured; есть токен, enabled=false → disabled; enabled + poller running → connected; enabled + poller error → error c кодом; **ни в одном JSON-ответе нет ключа `token`** (проверка по сериализованному телу на `/"token"\s*:/` и `"botToken"`).
- save: с token → `credentials.set(REF, token)` вызван; без token → set не вызван; allowedUserId=0/-1/1.5/«abc» → 400 invalid-user-id; enabled=true без токена → 400 invalid-config; enabled=true с токеном+userId → scope.update({enabled:true,...}) + poller.start.
- test: без токена → 400 not-configured; с токеном → botFactory getMe вызван, poller.start НЕ вызван.
- disable → scope.update({enabled:false}) + poller.stop; clear-token → unset + stop + enabled false.
- chat/apply-интеграция ручек не тестируется на сети — только роуты с фейками; логика apply (watch-переходы) — на фейковом scope.watch: подписка зарегистрирована; эмуляция коммита enabled=true запускает start; false — stop.

- [ ] **Step 1: failing-тесты** (по списку).
- [ ] **Step 2: run — RED.**
- [ ] **Step 3: реализовать ручки + apply** по спецификации выше (модули Task 5-10 уже на месте; index.ts собирает их).
- [ ] **Step 4: run — GREEN** (весь unit-сьют пакета) + typecheck.
- [ ] **Step 5: commit**

```bash
git add packages/plugins/dsh-balbes-telegram/src packages/plugins/dsh-balbes-telegram/tests
git commit -m "feat(telegram): settings routes, polling runtime, boot restore"
```

---

### Task 12: REAL-композиция — fake Bot API + LLM-стаб (весь сценарий владельца)

**Files:**
- Create: `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts`
- Create: `packages/plugins/dsh-balbes-telegram/tests/helpers/fake-bot-api.mjs`, `tests/helpers/stub-llm.mjs` (копия расширенного host-стаба из Task 1 + комментарий «keep in sync with packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs»)
- Create: `packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-profile/package.json` (`"name": "dsh-profile-balbes-telegram-test"`, bundles `["@deepseek-ai/dsh-base","dsh-balbes-host"]` — образец models-фикстуры) и `cordis.patch.yml`:

```yaml
- insert:
    - id: balbes-workspaces
      name: 'dsh-balbes-workspaces'
    - id: balbes-telegram
      name: 'dsh-balbes-telegram'
```

**Consumes:** REAL-каркас Task 1-фактов и образцы: `packages/plugins/dsh-balbes-models/tests/integration.test.ts` (buildPackages → bootServer/stopServer, fixture-копирование host+plugin в node_modules, health/login), host `integration.test.ts` (settings.yaml llm-стаб, spawn с pipe для логов), Task 5-11 код. Fake Bot API — локальный HTTP-сервер `http://127.0.0.1:<port>`, на который смотрит `apiBase` Config плагина (инжект через patch-конфиг плагина: `- id: balbes-telegram / config: { apiBase: 'http://127.0.0.1:<port>' }` нельзя вписать до знания порта — вместо этого env-переменная `BALBES_TELEGRAM_API_BASE` с `Config`-правилом: `apiBase: z.string().default(process.env.BALBES_TELEGRAM_API_BASE ?? "https://api.telegram.org")` — добавить это правило в Task 3/11 при необходимости (решение: расширить Config в Task 3-м, шаг в Task 12 проверяет).
**Fake Bot API** (`fake-bot-api.mjs`, по образцу `stub-llm.mjs`): `createServer`; маршрут `POST /bot<token>/<method>`; `getMe` → `{ok:true,result:{id:1,username:"balbes_test_bot",is_bot:true}}`; `getUpdates` — long-poll: держит ответ открытым до появления внешнего update или таймаута 1s, затем `{ok:true,result:[...]}`, очередь управляется тестом через `enqueueUpdate(...)`; `sendMessage`/`editMessageText`/`answerCallbackQuery` — записывают в `outbound` массив `{method, body}`; экспорт `{port, outbound, enqueueUpdate, reset, close}`. Все ответы — корректный Telegram JSON.
**Сценарии REAL** (describe.skipIf(RUN_REAL + dsh); каждый `it` — bootServer → действия → stopServer; токен бота fake `"123:FAKE"`):

1. **Полный цикл владельца**: boot (home temp; `settings.yaml` llm-стаб как в host-REAL; `DEEPSEEK_API_KEY=test-key`; fixture скопирована, host/workspaces/telegram собранные скопированы в node_modules); login → token; `workspaces/create` проекта `demo`; в `$DSH_HOME/projects/demo/note.txt` записать текст; `telegram/status` без настроек → state `not-configured`; `telegram/save {token:"123:FAKE", allowedUserId:OWNER, enabled:true}` → 200, state `connected` (после первого getMe); fake-bot: enqueue `/start` от OWNER (private) → outbound содержит сообщение с inline-клавиатурой (кнопка «Воркспейсы»); enqueue callback-нажатие «Воркспейсы» → список (Дом агента + проекты); enqueue выбор «Дом агента» (`ws:pick:0`) → подтверждение выбора; enqueue text-задачу «Reply with exactly: ok from stub» → outbound получает «Задача принята…» и затем финальный ответ со stub-текстом (`ok from stub`); assert: llm-стаб получал запросы (calls>0) и в body сообщений встречается путь корня выбранного workspace (persona `{{cwd}}` — если Task 1 подтвердил подстановку; иначе — только факт ответа); state-файл `$DSH_HOME/telegram-state.json` содержит `sessions` с одним ключом и **не содержит** `123:FAKE`; enqueue открытие «Файлы» → дерево с `note.txt`; выбор файла → outbound с содержимым страницы.
2. **Два workspace + рестарт + resume**: продолжить на том же home: создать проект `two`; выбрать его; задача → `sessions` в state имеет **два разных** sessionId; stopServer; bootServer заново (тот же home) → status по-прежнему `connected`, offset восстановлен (нет повторной доставки старых update — fake-bot очередь новая, но state offset сохранён — проверка, что после рестарта новая задача в `two` выполняется и sessionId в state **тот же**, что до рестарта); llm-стаб: второй boot'овый запрос для той же сессии содержит историю предыдущего turn (messages.length вырос) — resume-доказательство.
3. **Безопасность и секреты**: чужой from.id (OWNER+1) private-сообщение → за тайм-бокс (например 1.5s поллинга) в outbound НЕТ новых записей; группа (chat.type "group", from OWNER) → тоже нет; `telegram/disable` → 200, poller остановлен (getUpdates больше не приходит за окно), token сохранён (`.credentials.yaml` содержит ref); `telegram/save {enabled:true}` без смены токена при `disable`-состоянии → start работает; `telegram/clear-token` → state `not-configured`, `.credentials.yaml` без `BALBES_TELEGRAM_BOT_TOKEN`, poller не активен; **секреты**: собранные stdout/stderr dsh-процесса (`spawn` c pipe, как host-REAL) не содержат `123:FAKE`; все ответы `/api/telegram/*` не содержат ключа `token`; `/status` содержит `tokenConfigured: true` без значения.

- [ ] **Step 1: расширить Config плагина** (apiBase из env `BALBES_TELEGRAM_API_BASE`) и fixture/helper'ы; failing-тесты писать в integration.test.ts по сценариям 1-3 (структура файла — копия models integration: hasDsh/freePort/buildPackages(telegram+workspaces+host)/postJson/waitForHealth/bootServer/stopServer).
- [ ] **Step 2: run — RED** (RUN_REAL=1; падает на несуществующих ручках/поведении).
- [ ] **Step 3: GREEN** — итерации: чинить ожидания по фактическому поведению dsh (как в модельных REAL), НЕ обходя security-assert'ы; любые изменения кода (не тестов) — в соответствующие модули Task 5-11 отдельными мини-правками с коммитами при необходимости.
- [ ] **Step 4: полный REAL-прогон пакета + host seams** (`RUN_REAL=1`): telegram integration + host seams.test.ts — зелёные.
- [ ] **Step 5: commit**

```bash
git add packages/plugins/dsh-balbes-telegram/tests
git commit -m "test(telegram): REAL composition with fake Bot API and LLM stub"
```

---

### Task 13: SPA — клиент `telegram.*` и страница «Telegram»

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/api/client.ts`, `src/App.tsx`, `src/components/Sidebar.tsx`, `tests/client.test.ts`, `tests/App.test.tsx`, `tests/Sidebar.test.tsx`
- Create: `packages/frontend/dsh-balbes-admin/src/pages/TelegramPage.tsx`, `tests/TelegramPage.test.tsx`

**Consumes:** Task 2 контракты (import type из `dsh-balbes-contracts`), паттерны `ModelsPage.tsx` (статус-карточка/формы/Modal/ошибки/data-testid, русская копия), `WorkspacesPage.tsx`, `client.ts` (request/guard), `Sidebar.tsx`/`App.tsx` (навигация, PAGE_TITLES). Дизайн-спека §Админка: статусы `не настроено`/`выключено`/`подключено`/`ошибка`; token password-маска; числовой User ID; enabled toggle; кнопки «Проверить подключение», «Сохранить», «Отключить», «Удалить токен» (с подтверждением); обновление статуса после каждой операции без рестарта.

**Produces (потребляет Task 14 runbook/smoke):**
- client.ts: `telegramStatus(): Promise<TelegramStatusResponse>`, `telegramSave(req: TelegramSaveRequest): Promise<TelegramSaveResponse>`, `telegramTest(): Promise<TelegramTestResponse>`, `telegramDisable(): Promise<TelegramDisableResponse>`, `telegramClearToken(): Promise<TelegramClearTokenResponse>` (guard-обёртки, как models-методы), типы — через импорт контрактов.
- App: `Page` union += `"telegram"`; `PAGE_TITLES.telegram = "Telegram"`; рендер `TelegramPage`.
- Sidebar: пункт «Telegram» в группе настроек рядом с «Модели» (см. текущую структуру Sidebar — повторяет способ входа models).
- TelegramPage: на mount `load()` → `telegramStatus`; карточка: бейдж состояния (4 варианта, русские подписи + data-testid `telegram-state`), строка «Бот: @username» при наличии, «Последний успешный опрос: <time>» (или «—»), безопасная ошибка (`error.message`); форма: token `<input type="password">` (placeholder: tokenConfigured ? "•••• (пусто — оставить текущий)" : "123456:ABC…"), User ID `<input type="number">` (placeholder = текущий allowedUserId ?? ""), checkbox enabled; кнопки: «Проверить подключение» (test → показывает username или ошибку), «Сохранить» (валидация: enabled без userId → блок; token необязателен), «Отключить» (disable), «Удалить токен» (кнопка danger → Modal подтверждения → clearToken); после каждой успешной операции — refresh статуса; ошибки — `role="alert"` баннер `telegram-error`; busy-блокировка кнопок; при 401 — стандартный уход на login через guard.
- Тесты страницы (fake api по образцу ModelsPage.test): загрузка статуса и рендер бейджа; save отправляет `{token, allowedUserId, enabled}` (token пустой → поле отсутствует — «не менять»); validation enabled-без-user; test-кнопка → username показан; disable и clear-token (Modal) вызывают нужные методы и обновляют статус; ошибка API → баннер; никакой токен не рендерится (input-значение не выводится текстом, только маска placeholder). client.test: методы шлют правильные пути/тела с Bearer.

- [ ] **Step 1: failing-тесты** (client.test + TelegramPage.test + Sidebar/App-навигация).
- [ ] **Step 2: run — RED** (`cd packages/frontend/dsh-balbes-admin && bash node_modules/.bin/vitest run tests/TelegramPage.test.tsx` и client).
- [ ] **Step 3: реализовать** client-методы → TelegramPage → навигация.
- [ ] **Step 4: run — GREEN** (весь SPA-сьют) + `pnpm -r --if-present run build` для SPA (типы против contracts lib) + typecheck фронта.
- [ ] **Step 5: commit**

```bash
git add packages/frontend/dsh-balbes-admin/src packages/frontend/dsh-balbes-admin/tests
git commit -m "feat(admin): telegram settings page and client methods"
```

---

### Task 14: Runbook, финальная верификация, canon-audit

**Files:**
- Modify: `docs/runbooks/stage2-vps.md` (секция «Настройка Telegram через админку» уже есть из дизайн-коммита — сверить с фактическим UX; добавить curl-smoke-блок ручек `/api/telegram/*` в раздел «Smoke без браузера», ожидаемые ответы — по Task 12 фактам), при необходимости `scripts/install.sh` summary (curl-строки telegram.status)

**Проверки (выполнить и зафиксировать вывод):**
- [ ] `pnpm typecheck` (корень) — все пакеты.
- [ ] `pnpm test` (корень, unit без REAL) — все пакеты зелёные.
- [ ] REAL: `cd packages/plugins/dsh-balbes-telegram && RUN_REAL=1 bash node_modules/.bin/vitest run`; `cd packages/bundles/dsh-balbes-host && RUN_REAL=1 bash node_modules/.bin/vitest run tests/integration.test.ts tests/seams.test.ts`; `cd packages/plugins/dsh-balbes-workspaces && RUN_REAL=1 bash node_modules/.bin/vitest run` (workspaces-REAL не сломан новым сервисом); models-REAL при желании.
- [ ] `bash -n scripts/install.sh`; git log/grep: в коммитах нет правок `docs/canon/**` (кроме дизайн-коммита) и `@deepseek-ai/*`.
- [ ] `doc-canon validate --json` — чист; canon-audit по теме «telegram» canon-скиллом (исполнитель: если недоступен — сообщить контроллеру, не править canon вручную).
- [ ] Runbook: smoke-раздел согласован с фактическим API; секция Telegram описывает только реальное поведение.
- [ ] Финал: whole-branch review (ветка, коммиты по одному на таск), отчёт владельцу + handoff по `docs/runbooks/stage2-vps.md` (обновление сервера: повторный запуск `scripts/install.sh` на VPS: `git pull --ff-only` → rebuild → profile sync → plugin copy → SPA deploy → restart; smoke: `/api/telegram/status`, настройка бота в админке, `/start`, задача, файл, отказ группе/чужому). Push на общий бранч — только после go-ahead владельца.

- [ ] **Commit:** `docs: runbook telegram smoke and final verification` (в конце задачи; если правок runbook нет — коммит не нужен, оставить проверки зафиксированными в отчёте).

---

## Self-review плана

- **Spec coverage:** цель/границы (private-chat single-user, long polling in-process, token через credentials, настройки без рестарта — Task 11), AgentTaskService с create/resume/FIFO/containment (Task 7 + Task 1 probe + Task 4), workspace domain (Task 4), состояние/offset/mapping (Task 8/11/12-2), Telegram UX выбор/задачи/файлы/ошибки (Task 10), админка+API (Task 11 + Task 2 контракты + Task 13 SPA), безопасность (Task 6 авторизация, Task 4 containment, Task 11/12 секреты, dispose Task 9), тестирование unit/REAL/containment (Tasks 5-12; containment-секция спеки = Task 1 + Task 4 + Task 12-3), эксплуатация/runbook (Task 14), критерии готовности (Task 12 сценарий покрывает все пункты DoD), не-в-этапе (webhook/группы/бинарники и т.д. — задач нет, scope не расширялся). Открытые проверки спеки — Task 1 с правилом «факт = ожидание».
- **Placeholder scan:** «TBD/TODO» нет; единственные «адаптивные» места — Task 1 (факты dsh фиксируются тестами, как требуют REAL-конвенции репозитория) и Task 7 guard (появление только при доказанном Task 1 containment-провале, с приёмкой = Task 1 REAL). Конфиг `apiBase` env — правило добавлено в Task 12 Step 1 как явный шаг.
- **Type consistency:** имена/сигнатуры сквозные: `BalbesWorkspacesService` (Task 4) → `ChatDeps`/`AgentTaskDeps` (7/10); `BotClient`/`BotUpdate`/`BotApiError` (5) → poller/chat/admin (9/10/11); `TelegramStateData` (8) и `workspaceRefKey`/`WorkspaceRef` (7) согласованы; контракты (2) совпадают с ручками (11) и SPA (13); state-ключи `not-configured|disabled|connected|error` совпадают во всех слоях.
- **Scope:** один план, один продуктовый deliverable, таски независимо проверяемы (каждый — свой тест-цикл и коммит).

---











