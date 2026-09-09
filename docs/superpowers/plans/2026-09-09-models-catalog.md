# Каталог моделей из движка (v3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development или executing-plans; шаги — checkbox. Команды тестов — из каталога пакета (bash node_modules/.bin/...), REAL — RUN_REAL=1.

**Goal:** модели (DeepSeek официальный + пресеты) выбираются из рантайм-каталога движка dsh (эндпоинт models.catalog + UI-пикер), pinned/ручной ввод — fallback.

**Spec:** docs/superpowers/specs/2026-09-09-models-catalog-design.md; базовые: v1/v2 спски.

## Global Constraints
- R-API-1 POST bearer; {error:{code,message}}; секреты не возвращаются; строгий TS ESM; английские код/комментарии; русская UI-копия; TDD; REAL; canon-правки только canon-скиллами; allowlist провайдеров = deepseek + 11 пресетов (MODEL_PROVIDER_PRESETS + "deepseek").
- Каталог-ридер: ленивый require("@earendil-works/pi-ai/providers/all") с try/catch fallback; ids/имена не перечисляем в контрактах хардкодом (кроме pinned-фолбэка DeepSeek 3 id).
- Только пакеты contracts / dsh-balbes-models / dsh-balbes-admin могут меняться (installer/CI/профиль не трогаем).

---

### Task 0: Canon v3 (отдельный canon-write агент; на main). Исполнитель проверяет validate чист и коммит существует.

### Task 1: Контракты — models.catalog типы
**Files:** packages/contracts/src/index.ts
**Produces:** ModelsCatalogRequest {provider:string}; ModelsCatalogResponse {provider:string; models: ModelOption[]}; ModelOption {id:string; name?:string} (export).
- [ ] добавить типы (после ModelsDefault*), typecheck contracts, commit feat(contracts): models.catalog shapes

### Task 2: Плагин — каталог-ридер + ручка models.catalog + deepseek из каталога
**Files:** packages/plugins/dsh-balbes-models/src/models.ts, src/index.ts; tests/*.test.ts
**Produces:** reader listEngineModels(providerId): Promise<ModelOption[]> (ленивый require @earendil-works/pi-ai/providers/all; getBuiltinModels(providerId)->[{id,name?}]; fallback DEEPSEEK_OFFICIAL_MODELS для deepseek; [] для custom/неизвестных); DEEPSEEK_OFFICIAL_MODELS += deepseek-v4-flash-vision-exp (3); ручка POST /api/models/catalog (bearer) {provider} -> {provider, models} (allowlist: deepseek + 11 presets; custom/unknown -> 400 invalid-provider); в readConnections deepseek connection models = (await reader) ?? fallback; preserve choice semantics.
- [ ] unit tests (мок-модуль reader через inject? структурный: reader вынесен как функция с параметром requireFn — тестируем с фейком): deepseek 3, openai непусто (фейк), unknown->[], ручка 200/400, list deepseek models=3; REAL не трогаем в этом таске
- [ ] commit feat(models): engine model catalog endpoint

### Task 3: REAL — models.catalog на живом движке
**Files:** tests/integration.test.ts (новый it)
- [ ] boot; 401 без токена на catalog; catalog {provider:"deepseek"} -> 200 и models содержит deepseek-v4-flash/pro/vision-exp; {provider:"openai"} -> 200 models.length>0; {provider:"openai"...} дубли? нет; {provider:"<custom route id>"} -> 400 invalid-provider; models.list: deepseek connection models == 3 с vision-exp. commit test(models): REAL model catalog

### Task 4: SPA — пикер моделей из каталога
**Files:** packages/frontend/dsh-balbes-admin/src/pages/ModelsPage.tsx (+api client методы models.catalog), tests/ModelsPage.test.tsx, client.test.ts (метод catalogModels(provider))
- [ ] client метод catalogModels; пресет-форма: при выборе провайдера fetch каталога -> список с фильтром (input-поиск по id), выбор чипами (>=1); если каталог пуст/ошибка -> прежний ручной ввод; deepseek edit-ключ форма не меняется; карточка DeepSeek моделей 3 (из list). тесты: пикер отдаёт выбранные модели в saveModel; поиск фильтрует; fallback manual при ошибке. commit feat(admin): pick models from engine catalog

### Task 5: Верификация и canon-audit
- [ ] typecheck/unit/REAL (модели/admin), doc-canon validate; финальное whole-branch ревью; canon-audit «модели/каталог».
