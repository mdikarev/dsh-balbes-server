# Дизайн: воркспейсы на сервере (дом агента + проекты)

- Дата: 2026-09-06
- Статус: черновик на ревью
- Тип: дизайн первого шага инициативы
  `docs/canon/future_plans/p0-agent-workspaces.md`
- Порядок по canon: спека → canon-write (абсорбция в живые секции) → go-ahead
  владельца на код → реализация → canon-audit

## 1. Цель и границы

Первый реализуемый шаг инициативы «Воркспейсы на сервере»: вводится серверная
сущность «воркспейс» двух типов — домашний (агентский) и проекты. Воркспейс —
каталог на диске в `$DSH_HOME`, файлы внутри — обычные файлы, владелец всегда
главнее. Реализуются: сущность, автосоздание дома, реестр-индекс, API
«список/создать/удалить», страница админки.

**Вне границ этого шага** (последующие инициативы): git/ключи, сессии и чат,
исполнение задач агентом внутри воркспейса, наполнение дома (`self.md`,
`skills/`, `notes/`), переименование воркспейсов, стартовый набор файлов
проекта (создаётся пустой каталог).

## 2. Решения (подтверждены владельцем в брейншторме)

1. Берём весь «первый шаг» из In scope доки: сущность + дом (автосоздание) +
   реестр + API list/create/delete + страница админки с подтверждением
   удаления.
2. Новый проект «с нуля» — пустой каталог (без стартовых файлов).
3. Порядок работ — canon-first (спека → canon-write → go-ahead → код →
   canon-audit).
4. **Каталог — источник правды, реестр — индекс.** List = скан
   `$DSH_HOME/projects/*` + всегда присутствующий дом; расхождения
   вычищаются сами (осиротевшие строки реестра удаляются, ручные каталоги
   видны без метаданных).
5. Реестр — `$DSH_HOME/projects.json` (рядом с `admin-auth.json`, не внутри
   дома агента): дом остаётся чистым рабочим каталогом без служебных файлов
   сервера.
6. Имя проекта — строгий slug `[A-Za-z0-9._-]`, ≤ 64, без ведущих/хвостовых
   точек, без `/`, `..`, пробелов. Имя = имя каталога под `$DSH_HOME/projects/`.
7. Реализация — отдельный пакет-плагин `packages/plugins/dsh-balbes-workspaces`
   (CONTRIBUTING: плагин одной возможности → `packages/plugins/`, подключение —
   insert в патч профиля).

## 3. Модель и домен

### Типы воркспейсов

- **home (дом агента)** — фиксированный, путь `$DSH_HOME/agent/`, существует
  всегда; пользователем не создаётся и не удаляется. Дом вне корня проектов,
  поэтому недостижим операциями проектов по построению.
- **project** — каталог `$DSH_HOME/projects/<имя>/`. Любой каталог под этим
  корнем — проект (каталог — источник правды), независимо от того, создан он
  через API или руками.

### Правило имени проекта

- Разрешено: `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$`, длина ≤ 64.
  Без ведущей/хвостовой точки, без `..`, `/`, пробелов, юникода.
- Проверяется на create (400 `invalid-name`). Каталог с именем вне правила,
  созданный руками, остаётся виден в списке (каталог — правда); удалить его
  можно (после проверки containment).

### Реестр `$DSH_HOME/projects.json` (индекс)

```json
{
  "version": 1,
  "projects": {
    "<name>": { "createdAt": "2026-09-06T12:00:00.000Z" }
  }
}
```

- Хранит только метаданные, которых нет у каталога (сейчас — `createdAt`).
- Запись — атомарно: tmp-файл + rename (паттерн `writeAdminAuth` в core.ts),
  режим 600.
- Согласование (reconciliation): при list и при любой записи строки, чей
  каталог исчез, вычищаются; каталоги без строки показываются с
  `createdAt: undefined` (в UI — прочерк). Выдуманные даты не пишутся.
- Дом в реестре не хранится (он не проект и не создаётся пользователем).

## 4. API

Правила: R-API-1 — только POST, ошибки `{error:{code,message}}`, типы в
`dsh-balbes-contracts`, реестр в `docs/api-contracts.md` правится в том же
изменении.

### workspaces.list
- method: POST, path: /api/workspaces/list, auth: bearer
- request: `{}`
- response: `{ home: { path: string }, projects: Array<{ name: string; path: string; createdAt?: string }> }`
- errors: 401; 500 (нечитаемый корень/реестр)
- notes: скан `$DSH_HOME/projects/*` (только каталоги, без скрытых), дом
  всегда в ответе (ensureHome перед ответом); createdAt — из реестра, если
  строка есть.

### workspaces.create
- method: POST, path: /api/workspaces/create, auth: bearer
- request: `{ name: string }`
- response: `{ project: { name: string; path: string; createdAt: string } }`
- errors: 400 `invalid-name`; 409 `name-exists` (каталог уже существует — в
  т.ч. созданный руками, регистрировать его create не будет); 401; 500
- notes: создаёт пустой каталог + upsert строки реестра (`createdAt: now`).

### workspaces.delete
- method: POST, path: /api/workspaces/delete, auth: bearer
- request: `{ name: string }`
- response: `{}`
- errors: 400 `invalid-name`; 404 `not-found` (каталога нет); 401; 500
- notes: рекурсивно удаляет каталог проекта + prune строки реестра.
  Confirmation — на стороне UI. Дом удалить нельзя: имя — один сегмент пути,
  проверка containment под `$DSH_HOME/projects/`.

## 5. Серверный пакет `dsh-balbes-workspaces`

Расположение: `packages/plugins/dsh-balbes-workspaces/`.

- Манифест по CONTRIBUTING: `type: module`, `main: ./lib/index.js`,
  `exports` минимум `"."` и `"./package.json"`, **без** `dsh.bundle.patch`
  (это плагин, не бандл). devDeps: typescript, vitest, @types/node.
- `src/workspaces.ts` — чистые доменные функции (без Cordis):
  - `validateProjectName(name): string | null` (нормализация/проверка);
  - `ensureHome(dshHome): Promise<string>` (mkdir -p `$DSH_HOME/agent`,
    идемпотентно);
  - `listWorkspaces(dshHome)` → `{ home: {path}, projects: [...] }` — скан +
    merge реестра + reconciliation;
  - `createProject(dshHome, name)` → mkdir (EEXIST → ошибка `name-exists`) +
    upsert реестра;
  - `deleteProject(dshHome, name)` → rm -rf каталога + prune реестра;
  - работа с реестром: `readRegistry`, `writeRegistry` (атомарно), prune.
  - безопасность путей: имя — один сегмент; разрешённый каталог обязан лежать
    под корнем проектов (resolve + префикс-проверка).
- `src/index.ts` — функциональный плагин: `name = "balbes-workspaces"`,
  `inject = ["balbesHttp"]`, `Config = z.object({ dshHome: z.string() })` с
  fallback `process.env.DSH_HOME ?? ~/.dsh` в `apply` (паттерн auth/static);
  `apply` вызывает `ensureHome` (boot, warn при неудаче, не роняет старт) и
  регистрирует три сиденья `http.post("/api/workspaces/*", "bearer", ...)`.
  Структурные формы запросов/ответов держит локально (контракт-типы —
  в contracts; соответствие проверяют REAL-тесты и typecheck).
- Регистрации — эффекты (`ctx.on("dispose")` при необходимости; сиденья
  добавляются в `balbesHttp`, который живёт в server-плагине).

## 6. Подключение и упаковка

- `profiles/balbes/cordis.patch.yml`: `[]` → insert `balbes-workspaces`
  (`name: dsh-balbes-workspaces`) под уникальным id (слой становится непустым —
  это валидно).
- `scripts/install.sh`: копирование собранного `dsh-balbes-workspaces` в
  `$DSH_HOME/profiles/balbes/node_modules/` (по образцу
  `copy_host_into_profile`, очистка src/tests/lib/types/tsconfig).
- `.github/workflows/ci.yml`: тот же шаг копирования в «Sync profile», чтобы
  `--dump-config` и композиция проверяли полный профиль.
- Порядок в патче: вставка плагина идёт после бандлов ядра и host; патч
  профиля применяется последним.

## 7. Админка (`dsh-balbes-admin`)

- `App.tsx`: состояние вида `"test" | "workspaces"`; `Sidebar` получает
  `active` + `onNavigate`; ghost-пункт «Проекты» (группа «Работа») становится
  живым с `id: "workspaces"`.
- Новая страница `pages/WorkspacesPage.tsx`:
  - секция «Дом агента»: путь, пометка «зарезервирован», действий нет;
  - секция «Проекты»: список (имя, путь, дата создания или прочерк) +
    форма создания (инпут + кнопка) + кнопка «Удалить» на каждом проекте;
  - подтверждение удаления — `window.confirm` с русским текстом и именем
    проекта; ошибки API — блок `role="alert"` (паттерн TestPage).
- `api/client.ts`: методы `listWorkspaces`, `createWorkspace`, `deleteWorkspace`;
  типы из `dsh-balbes-contracts`.
- Стиль — по направлению ADMIN_UI (тёмная dev-tool тема, токены `:root`,
  русская копия, моноширинный для путей/имён).

## 8. Контракты (`dsh-balbes-contracts`)

Добавить в `packages/contracts/src/index.ts`:

- `WorkspaceListRequest {}`, `WorkspaceListResponse { home: {path}; projects: WorkspaceProject[] }`
- `WorkspaceCreateRequest { name }`, `WorkspaceCreateResponse { project: WorkspaceProject }`
- `WorkspaceDeleteRequest { name }`, `WorkspaceDeleteResponse {}`
- `WorkspaceProject { name; path; createdAt?: string }`, `WorkspaceHome { path }`

## 9. Тесты

- **Unit (домен)** — `packages/plugins/dsh-balbes-workspaces/tests/` с
  временным `$DSH_HOME` (tmpdir, cleanup в teardown):
  - валидация имён (границы: пустое, `..`, `/`, точка в начале/конце, длина,
    юникод, пробелы);
  - ensureHome идемпотентен; каталог создаётся с нужными правами;
  - list: пустой корень → дом + `[]`; скан каталогов; merge createdAt;
    ручной каталог виден; осиротевшая строка реестра вычищается;
  - create: mkdir + запись; EEXIST → `name-exists`; атомарность реестра
    (нет tmp-хвостов);
  - delete: rm -rf + prune; нет каталога → `not-found`; отказ на имя вне
    корня проектов;
  - readRegistry: битый JSON/форма → понятная ошибка.
- **REAL-композиция** — по образцу `tests/integration.test.ts` host-бандла:
  фикстура профиля + копия собранного плагина в node_modules, boot dsh с
  временным DSH_HOME и `admin-auth.json`, stub-LLM; по HTTP:
  - 401 без токена на всех трёх роутах;
  - list → дом + проекты; create → каталог появился на диске; delete →
    каталог исчез; повторный create → 409; delete несуществующего → 404;
    имя-с-путём → 400;
  - дом не удаляется и не создаётся повторно (ensureHome идемпотентен).
- **Frontend**: `client.test.ts` (новые методы + 401), компонентные тесты
  `WorkspacesPage` (рендер дома/проектов, создание, удаление с
  confirm-моком), обновление `App.test.tsx`/`Sidebar.test.tsx` (навигация).

## 10. Canon и документация (canon-first)

Абсорбция через **canon-write** (не ручной правкой):

- `ARCHITECTURE.md` — сущность воркспейс, пути, реестр-индекс, правило имён,
  плагин `dsh-balbes-workspaces`, роуты `/api/workspaces/*`, роль в слоях.
- `GLOSSARY.md` — термины: воркспейс, дом агента, проект, `projects.json`,
  `dsh-balbes-workspaces`.
- `OVERVIEW.md` — scope первого шага и сигналы успеха.
- `ADMIN_UI.md` — страница воркспейсов (направление).
- `docs/api-contracts.md` — три контракта выше.
- `docs/runbooks/stage2-vps.md` — структура профиля (новый пакет), smoke
  воркспейсов.
- `future_plans/INDEX.md` + `p0-agent-workspaces.md` — статус → `absorbed`
  после реализации и canon-audit.

## 11. Порядок работ

1. Ревью этой спеки владельцем.
2. canon-write (раздел 10) → go-ahead владельца на код.
3. Реализация: contracts → домен+плагин (TDD, unit) → REAL-тесты → профиль/
   патч → install.sh/CI → frontend (клиент, страница, тесты) → api-contracts
   и runbook.
4. `pnpm typecheck`, `pnpm test` (+ `dsh --dump-config` локально после
   копирования пакета в профиль), REAL-тесты локально.
5. canon-audit по теме воркспейсов; статус future-plan → `absorbed`.

## 12. Открытые вопросы (не блокируют, фиксируются)

- Точные формулировки UI-копии страницы — при реализации по ADMIN_UI.
- Поведение при нечитаемом/битом реестре уже определено (fail loud в
  readRegistry, дом продолжает работать); права каталогов проектов — дефолт
  процесса (как у остального `$DSH_HOME`).
