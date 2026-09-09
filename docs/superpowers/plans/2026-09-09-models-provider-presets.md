# Пресеты провайдеров в «Моделях» (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Расширить раздел «Модели» выбором провайдера из каталога движка dsh (pi-ai): подключение по каталоговому id без указания URL (официальный подставляет движок), ключ + модели вводит владелец; «Свой URL» и закреплённый DeepSeek остаются как v1.

**Architecture:** Та же тройка пакетов, что в v1: contracts (display-данные пресетов + типы kind preset), плагин dsh-balbes-models (валидация allowlist, сборка роута без api/baseURL, чтение/классификация), SPA ModelsPage (селект провайдера в форме, карточки пресетов). Canon-коммит выполняется отдельно (Task 0).

**Tech Stack:** TypeScript strict ESM, Cordis-плагины dsh 0.1.2-rc.1, vitest, React+Vite SPA.

**Spec:** docs/superpowers/specs/2026-09-09-models-provider-presets-design.md (плюс базовый дизайн docs/superpowers/specs/2026-09-09-models-settings-design.md).

## Global Constraints (v1-инварианты + v2)

- Как в v1-плане (R-API-1 POST; {error:{code,message}}; секреты не возвращаются; строгий TS ESM .js-импорты; английские код/комментарии; русская UI-копия; TDD; REAL-композиция RUN_REAL=1; правки docs/canon только через canon-скиллы; пакет уже подключён к профилю/installer/CI — их НЕ трогать).
- kind: "deepseek" (закреплён) | "preset" (новое) | "custom" (как v1).
- Роут пресета: routeId == providerId; конфиг {displayName?, apiKeyEnv, models:[{id}]} БЕЗ api; baseURL пишем только при явном override («свой URL» у пресета). Один официальный роут на провайдера (повторный save того же providerId без routeId -> 409 route-exists; с явным routeId=providerId существующий -> update).
- Allowlist пресетов (11): openai, anthropic, openrouter, groq, google, mistral, xai, together, cerebras, fireworks, opencode. providerId вне allowlist -> 400 invalid-provider (до движка).
- Классификация при чтении (models.list): роут с api-полем -> custom (v1-писатель всегда ставил api); иначе если id в allowlist -> preset; иначе (неизвестный роут в настройках) -> custom.
- Пресеты удаляются/правятся как обычные роуты; default-in-use/reserved семантика v1 сохраняется.
- Sandbox: pnpm/corepack shim может падать (/usr/bin/env node) — запускать пакетные tsc/vitest через bash node_modules/.bin/... из каталога пакета (cwd пакета обязателен для vitest, иначе собираются все тесты репо).

---

### Task 0: Canon (коммит уже делается отдельным canon-write агентом на main)

Файлы docs/canon/{API_CONTRACTS,ADMIN_UI,OVERVIEW,GLOSSARY}.md — коммит "docs(canon): provider presets from engine catalog (models v2)" на main. Исполнитель плана: проверить, что коммит существует и doc-canon validate --json чист; если нет — НЕ править canon самим, сообщить контроллеру.

### Task 1: Contracts — kind preset + display-список пресетов

**Files:** Modify packages/contracts/src/index.ts

**Interfaces (produces):**
- export type ModelKind = "deepseek" | "preset" | "custom"
- export const MODEL_PROVIDER_PRESETS: ReadonlyArray<{ providerId: string; label: string }> — 11 записей: openai "OpenAI", anthropic "Anthropic (Claude)", openrouter "OpenRouter", groq "Groq", google "Google (Gemini)", mistral "Mistral", xai "xAI (Grok)", together "Together", cerebras "Cerebras", fireworks "Fireworks", opencode "OpenCode"
- ModelConnection += providerId?: string (только kind preset)
- ModelsSaveRequest += provider?: string (только kind preset), displayName больше не обязателен для preset (label по умолчанию)

- [ ] Step 1: изменить типы (код выше), Step 2: typecheck пакета/корня (bash node_modules/.bin/tsc --noEmit -p tsconfig.json из packages/contracts), Step 3: commit feat(contracts): provider presets for models (kind preset)

### Task 2: Плагин — пресеты (валидация + save + list-классификация)

**Files:** packages/plugins/dsh-balbes-models/src/models.ts, src/index.ts; tests/models.test.ts, tests/index.test.ts

**Produces:** const PROVIDER_PRESETS (id+label, 11 шт. — те же, что в contracts; комментарий о синхронизации); validateProviderPreset(p): {providerId} | {error:"invalid-provider"|"invalid-models"|"invalid-key"|"invalid-url"}; buildPresetRouteConfig(...); kind-классификация в readConnections (см. Global Constraints).

- [ ] Step 1: failing unit tests:
  - models.test.ts: PROVIDER_PRESETS содержит 11 заданных id; validateProviderPreset: валидный openai -> ok; неизвестный id -> {error:"invalid-provider"}; пустые модели -> invalid-models.
  - index.test.ts: (a) save {kind:"preset", provider:"openai", key:"sk-o", models:["gpt-4o-mini"]} -> 200; settings llm-pi-ai.providers["openai"] == {displayName:"OpenAI", apiKeyEnv:"BALBES_OPENAI_API_KEY", models:[{id:"gpt-4o-mini"}]} и БЕЗ ключей api/baseURL; credentials ref записан; list показывает kind:"preset", providerId:"openai", без baseURL.
  (b) save {kind:"preset", provider:"openai", baseURL:"https://custom/v1", ...} -> роут с baseURL и без api.
  (c) save {kind:"preset", provider:"nope", ...} -> 400 invalid-provider; settings/credentials не тронуты.
  (d) повторный save {kind:"preset", provider:"openai"} (без routeId) -> 409 route-exists.
  (e) list: вручную подложенный в settings роут opencode {apiKeyEnv} -> классифицируется preset; роут с api-полем и id openai -> custom.
- [ ] Step 2: run (cwd пакета) — RED; Step 3: implement; Step 4: GREEN + typecheck; Step 5: commit feat(models): provider presets from engine catalog

### Task 3: REAL — пресеты на живом движке

**Files:** packages/plugins/dsh-balbes-models/tests/integration.test.ts (добавить новый it; бойлерплейт уже есть)

- [ ] Step 1: failing REAL it: boot (существующий bootServer); 401 на preset-save без токена; save {kind:"preset", provider:"openai", key:"sk-abc", models:["gpt-4o-mini"]} -> 200; settings.yaml содержит openai роут без api: и без baseURL: (grep "providers" секцию) и .credentials.yaml содержит BALBES_OPENAI_API_KEY: sk-abc; list показывает preset c providerId openai и hasKey true; повторный save того же -> 409 route-exists; save неизвестного provider -> 400 invalid-provider (это же — дрифт-гард каталога: если движок больше не знает openai, save упадёт/ошибка — тест красный); delete пресета -> 200.
- [ ] Step 2: RUN_REAL=1 vitest (cwd пакета) — RED при отсутствии фичи, GREEN после Task 2; при несоответствии формы роута движку (ошибка валидации llm-pi-ai) — вернуть контроллеру точную ошибку (правка в Task 2, не в тестах).
- [ ] Step 3: commit test(models): REAL provider preset flow

### Task 4: SPA — селект провайдера, пресет-форма, карточки

**Files:** packages/frontend/dsh-balbes-admin/src/pages/ModelsPage.tsx, tests/ModelsPage.test.tsx (App/styles при необходимости минимально)

- [ ] Step 1: failing tests (fake api по v1-паттерну): (a) «+ Добавить» -> модалка с селектом провайдера: опции пресетов (OpenAI, Anthropic…, OpenCode) + «Свой URL»; выбор OpenAI -> поля ключ+модели, инфо «официальный URL», baseURL скрыт; toggle «свой URL» показывает baseURL. (b) submit preset -> saveModel({kind:"preset", provider:"openai", key, models}) (без baseURL), карточка пресета появляется (название «OpenAI», «официальный URL», чипы моделей). (c) выбор «Свой URL» -> привычная custom-форма. (d) ошибка invalid-provider -> connection-errors.
- [ ] Step 2: RED; Step 3: implement (селект + ветки формы + рендер карточек kind preset/providerId + дефолт-селект группы как v1); Step 4: GREEN (админ-сьют) + typecheck; Step 5: commit feat(admin): provider presets in Models page

### Task 5: Верификация и canon-audit

- [ ] Step 1: typecheck всех пакетов + unit (models/admin/workspaces/host) + RUN_REAL=1 models (cwd пакетов); bash -n install.sh не нужен (файл не менялся).
- [ ] Step 2: canon-audit по теме «модели/провайдеры» (validate/scout/semantic; docs↔code).
- [ ] Step 3: финальный whole-branch review + отчёт владельцу.
