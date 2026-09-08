# API Contracts

## Purpose

Человекочитаемый реестр API-контрактов сервера `dsh-balbes-server`: каждая
ручка `/api/*`, её запрос/ответ, ошибки и побочные эффекты. Компиляторный
источник правды форм — TS-типы в `dsh-balbes-contracts`
(`packages/contracts/src/index.ts`); эта секция — живая проекция для людей.

## Scope

- Покрывает: HTTP-контракты `/api/*` (method/path/auth/request/response/
  errors/notes) — сейчас `health`, `auth.login`, `auth.me`, `prompt`,
  `workspaces.list`, `workspaces.create`, `workspaces.delete`,
  `workspaces.tree`, `workspaces.events`.
- Вне scope: статика SPA (не API), внутренние сервисные интерфейсы Cordis,
  потоковая доставка ответов модели в чат (по-прежнему вне scope; новые
  каналы появятся здесь же по мере реализации).
- При расхождении реестра и типов побеждают типы (компилятор); реестр
  правится в том же изменении, что и типы/поведение.

## Current state

Правила: **R-API-1** — все запросы к `/api/*` только POST; JSON тело/ответ;
ошибки — `{error:{code,message}}`.

### health — проверка живости
- method: POST
- path: /api/health
- auth: public
- request: `{}`
- response: `{ok: true, version: string}`
- errors: — (500 при внутренней ошибке)
- notes: используется systemd/установщиком; данных не отдаёт.

### auth.login — вход владельца
- method: POST
- path: /api/auth/login
- auth: public
- request: `{login: string, password: string}`
- response: `{token: string, expiresAt: string(ISO)}`
- errors: 400 (нет полей), 401 (неверные учётные данные), 429 (лимит попыток по IP)
- notes: выдаёт JWT HS256 (24 ч); rate-limit 5 промахов / 30 мин по IP.

### auth.me — валидация токена
- method: POST
- path: /api/auth/me
- auth: bearer
- request: `{}`
- response: `{login: string}`
- errors: 401 (нет/битый/просроченный токен)
- notes: SPA решает при загрузке: логин или основная страница.

### prompt — тестовый промпт в LLM
- method: POST
- path: /api/prompt
- auth: bearer
- request: `{prompt: string (непустой)}`
- response: `{text: string, reason?: {kind: string, code?: string, message?: string}}`
- errors: 400 (нет/пустой prompt), 401, 502 (reason.kind === "error")
- notes: свежий агент на запрос (граница этапа 2), сессия персистится
  (`sessions.flush`); стриминг — следующий этап.

### workspaces.list — список воркспейсов (дом + проекты)
- method: POST
- path: /api/workspaces/list
- auth: bearer
- request: `{}`
- response: `{home: {path: string}, projects: [{name: string, path: string, createdAt?: string(ISO)}]}`
- errors: 401, 500 (нечитаемый корень/реестр)
- notes: каталог — источник правды: дом `$DSH_HOME/agent/` всегда в ответе,
  проекты — скан `$DSH_HOME/projects/*` (только каталоги, без скрытых);
  `createdAt` берётся из реестра-индекса `$DSH_HOME/projects.json`, если строка
  есть; осиротевшие строки реестра вычищаются при list.

### workspaces.create — создать проект (пустой каталог)
- method: POST
- path: /api/workspaces/create
- auth: bearer
- request: `{name: string}`
- response: `{project: {name: string, path: string, createdAt: string(ISO)}}`
- errors: 400 `invalid-name` (нарушение slug-правила), 409 `name-exists`
  (каталог уже существует — включая созданный руками), 401, 500
- notes: имя — строгий slug `[A-Za-z0-9._-]` ≤ 64 без `/`, `..`, пробелов и
  ведущих/хвостовых точек; создаёт пустой каталог
  `$DSH_HOME/projects/<имя>/` + upsert строки реестра (`createdAt: now`).

### workspaces.delete — удалить проект (каталог + запись)
- method: POST
- path: /api/workspaces/delete
- auth: bearer
- request: `{name: string}`
- response: `{}`
- errors: 400 `invalid-name` (в т.ч. traversal-имена), 404 `not-found`
  (каталога нет), 401, 500
- notes: рекурсивно удаляет каталог проекта + prune строки реестра.
  Подтверждение — на стороне UI. Дом удалить нельзя: имя — один сегмент пути,
  проверка containment под `$DSH_HOME/projects/`.

### workspaces.tree — дерево воркспейса (чтение одного каталога)
- method: POST
- path: /api/workspaces/tree
- auth: bearer
- request: `{scope: "home"|"project", name?: string, path: string}` (`name` —
  только при `scope: "project"`)
- response: `{entries: [{name: string, kind: "dir"|"file"|"link"}]}`
- errors: 400 `invalid-name` (нет/битый `name` у project), 400 `invalid-path`
  (неверный путь, в т.ч. traversal за корень), 404 `not-found` (каталога нет
  или он вне воркспейса), 401
- notes: ленивое чтение по одному каталогу (`path: ""` = корень воркспейса);
  записи — только из `Dirent`: симлинки = `kind: "link"` и никогда не
  разыменовываются; dot-записи включены; сначала каталоги (dirs first).
  Контеймент скоупа — лексический и по realpath: ручка никогда не выходит за
  корень воркспейса. Дерево дома — `$DSH_HOME/agent/`.

### workspaces.events — события изменений воркспейсов (SSE-канал)
- method: POST
- path: /api/workspaces/events
- auth: bearer
- request: `{}`
- response: 200 `text/event-stream`, поток не закрывается; кадры `data: {json}`,
  payload — `WorkspaceFsEvent` (`{kind: "fs", scope: "home"|"project", name?,
  path}` — каталог, чей список изменился; `path: ""` = корень) или
  `WorkspaceListEvent` (`{kind: "list"}` — состав проектов изменился);
  heartbeat `: ping` каждые 25 с
- errors: 401 (нет/битый токен)
- notes: push-канал изменений каталогов для дерева в админке (внешние правки
  владельца/агента); соединение закрывает клиент; исключения из R-API-1 нет —
  запрос остаётся POST; потоковая доставка ответов модели в чат — по-прежнему
  вне scope.

## Rules & invariants

- R-API-1: `/api/*` — только POST (исключение — статика SPA, это не API).
- Ошибки — тело `{error:{code,message}}`; коды стабильны и проверяются
  тестами (REAL-композиция).
- Типы `dsh-balbes-contracts` — компиляторный SoT форм; реестр им не
  противоречит и правится в том же изменении (типы побеждают при расхождении).
- Новая ручка `/api/*` появляется здесь в том же коммите, что и код.
- Секция редактируется только через canon-скиллы (canon-first), не вручную.

## Key details

- Контракты в `Current state` оформлены по шаблону: `### <id> — <название>` и
  поля method/path/auth/request/response/errors/notes (schema: пока пусто;
  zod/JSON Schema — при росте API).
- Bearer-токен: SPA хранит JWT в localStorage и шлёт `Authorization: Bearer`.
- Каталог-источник правды воркспейсов и пути (`$DSH_HOME/agent`,
  `$DSH_HOME/projects`) — в ARCHITECTURE.md; термины — в GLOSSARY.md.

## Open questions

- Пусто: каждая новая ручка добавляется сюда по мере реализации.

## Related canon

- ARCHITECTURE.md — слои host, роутинг, авторизация, воркспейсы.
- OVERVIEW.md — роль API в scope продукта.
- GLOSSARY.md — термины (`dsh-balbes-contracts`, R-API-1, воркспейс).
