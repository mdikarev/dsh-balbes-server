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
  `workspaces.tree`, `workspaces.events`, `models.list`, `models.catalog`,
  `models.save`, `models.delete`, `models.default`, `telegram.status`,
  `telegram.save`, `telegram.test`, `telegram.disable`, `telegram.clear-token`.
- Вне scope: статика SPA (не API), внутренние сервисные интерфейсы Cordis,
  streaming-доставка ответов модели (Telegram MVP отправляет финальные
  сообщения; SSE/WS остаются отдельным этапом).
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

### models.list — список подключений и дефолтная модель
- method: POST
- path: /api/models/list
- auth: bearer
- request: `{}`
- response: `{connections: [{routeId: string, kind: "deepseek"|"preset"|"custom", providerId?: string, displayName: string, baseURL?: string, hasKey: boolean, models: string[], isDefault: boolean}], default: {provider: string, model: string}}`
- errors: 401
- notes: отдаёт состояние движка: роуты провайдеров (settings-секция
  `llm-pi-ai`); встроенный `deepseek-official` в списке всегда, его модели —
  из рантайм-каталога движка dsh (`deepseek-v4-flash`, `deepseek-v4-pro`,
  `deepseek-v4-flash-vision-exp`); pinned-список DeepSeek — только fallback
  при недоступности рантайм-каталога, синхронизируется по движку.
  Пресеты (`kind: "preset"`) — подключения по каталоговым провайдерам
  движка dsh (pi-ai catalog): у `kind: "preset"` элемент несёт
  `providerId` (равен `routeId`) — каталоговый id провайдера (напр.
  `openai`, `anthropic`, `openrouter`, `groq`, `google`,
  `mistral`, `xai`, `together`, `cerebras`, `fireworks`,
  `opencode`); официальные URL/протокол движок берёт из каталога —
  в route config `baseURL`/`api` не пишутся; `baseURL` в ответе есть
  только при override «свой URL»; модели пресета — выбранные владельцем из
  каталога провайдера (≥ 1; models.catalog — источник выбора, ручной ввод —
  fallback); «Свой URL» (custom) каталога не имеет — модели вводятся
  вручную. `hasKey` — признак наличия ключа: значение секрета не возвращается
  никогда; `isDefault` — derived (на этом подключении стоит дефолтная
  модель).

### models.catalog — каталог моделей провайдера
- method: POST
- path: /api/models/catalog
- auth: bearer
- request: `{provider: string}` (`provider` — каталоговый провайдер:
  `deepseek-official` или id пресета из каталога движка)
- response: `{provider: string, models: [{id: string, name?: string}]}`
- errors: 400 `invalid-provider` (провайдер вне каталога движка: не
  `deepseek-official` и не один из 11 пресетов, в т.ч. custom), 401
- notes: список моделей провайдера — из рантайм-каталога движка dsh (pi-ai
  builtin + каталог dsh-llm-deepseek); модели не хардкодятся как основной
  источник (pinned-список DeepSeek — только fallback при недоступности
  рантайм-каталога).
  DeepSeek официальный — 3 модели каталога движка (`deepseek-v4-flash`,
  `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`); пресеты (11
  каталоговых провайдеров) — модели их builtin-каталога в движке. Ручка —
  источник для выбора моделей при подключении/правке провайдера в UI
  (ADMIN_UI.md); выбранные модели подключения (chosen) остаются источником
  для дефолтной модели и карточек (models.list). «Свой URL» (custom)
  каталога не имеет — модели вводятся вручную при save.

### models.save — создать/обновить подключение провайдера
- method: POST
- path: /api/models/save
- auth: bearer
- request: `{routeId?, kind: "deepseek"|"preset"|"custom", provider?: string, displayName?, baseURL?, key?: string|null, models?: string[]}` (`provider` — для `kind: "preset"`: каталоговый id провайдера, он же `routeId` роута)
- response: `{connection: {...}}` (форма элемента — как в models.list)
- errors: 400 `invalid-*` (имя/routeId/baseURL/модели), 400 `invalid-provider`
  (preset: `provider` вне списка пресетов каталога движка), 409
  `route-exists`, 409 `default-in-use` (правка убрала бы дефолтную модель),
  401
- notes: `routeId` — id роута движка: `deepseek-official` (зарезервирован,
  существует всегда) или lower-hyphen custom. Без `routeId` — создание
  (routeId генерируется из displayName, `^[a-z][a-z0-9-]*$`, уникален;
  дубль → 409 `route-exists`). С явным `routeId` — upsert: существующий
  роут обновляется, отсутствующий создаётся. Правка, убирающая модель,
  на которой стоит дефолт, → 409 `default-in-use`: владелец сначала меняет
  дефолтную модель. Для deepseek сохраняется только ключ (URL фиксирован;
  модели — из рантайм-каталога движка dsh: `deepseek-v4-flash`,
  `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`; pinned-список —
  только fallback при недоступности каталога, синхронизируется по движку). Валидация: baseURL — валидный http(s)-URL;
  модели custom — ≥ 1 id без пробелов/запятых. `key` передан — пишет ref
  в `$DSH_HOME/.credentials.yaml`; `key: null` у custom — сбрасывает (unset).
  Секрет не логируется и в ответ не возвращается никогда.
  Для `kind: "preset"` обязателен `provider` — каталоговый id провайдера
  движка dsh (pi-ai catalog); список selectable пресетов —
  `MODEL_PROVIDER_PRESETS` в `dsh-balbes-contracts` (провайдер id +
  отображаемое название; названия — бренды, англ.); сервер зеркалит его
  для валидации: вне списка — 400 `invalid-provider`.
  Создаётся официальный роут: `routeId` == каталоговый id, официальные
  URL/протокол движок подставляет из каталога (в route config не пишем
  `baseURL`/`api`), опциональный `baseURL` — override «свой URL»; ключ —
  apiKeyEnv-реф (как у custom), модели — выбранные владельцем из каталога
  провайдера (≥ 1; ручной ввод — fallback). Официальный
  роут на каталоговый id может быть только один: повторное официальное
  подключение к тому же провайдеру делается через «Свой URL»
  (`kind: "custom"`).

### models.delete — удалить подключение провайдера
- method: POST
- path: /api/models/delete
- auth: bearer
- request: `{routeId: string}`
- response: `{}`
- errors: 400 `reserved` (попытка удалить `deepseek-official`), 404 `not-found`
  (роута нет), 409 `default-in-use` (на подключении стоит дефолтная модель),
  401
- notes: удаляет только пользовательские подключения — пресеты
  (`kind: "preset"`) и `custom` — роуты в `llm-pi-ai`; закреплённый
  `deepseek-official` не удаляется. При `default-in-use` владелец сначала
  меняет дефолтную модель. Подтверждение — на стороне UI.

### models.default — глобальная дефолтная модель
- method: POST
- path: /api/models/default
- auth: bearer
- request: `{provider: string, model: string}` (`provider` = routeId подключения)
- response: `{default: {provider: string, model: string}}`
- errors: 400 `invalid-*` (нет такого роута/модели), 401
- notes: пишет settings-секцию `agent-default-model`; применяется к следующим
  запросам `/api/prompt` — runner читает selection на каждый запрос, рестарт
  сервера не нужен.

### telegram.status — состояние интеграции
- method: POST
- path: /api/telegram/status
- auth: bearer
- request: `{}`
- response: `{status: {state: "not-configured" | "disabled" | "connected" | "error", tokenConfigured: boolean, enabled: boolean, allowedUserId?: number,`
  `botUsername?: string, lastPollAt?: string(ISO), error?: {code: string, message: string}}}`
- errors: 401
- notes: token не возвращается никогда — только `tokenConfigured`. `state` выводится из наличия token, `enabled` и состояния poller: работающий polling → `connected`
  (устаревшая `error` не переводит статус в `error`), fatal `401` от Bot API или `enabled` без работающего polling → `error`. `error.message` — безопасный текст без token
  и stack trace.

### telegram.save — сохранить настройки
- method: POST
- path: /api/telegram/save
- auth: bearer
- request: `{token?: string, allowedUserId?: number, enabled?: boolean}` — отсутствующее поле не меняет прежнее значение
- response: `{status: TelegramStatus}` (форма как в `telegram.status`)
- errors: 400 `invalid-user-id` (user ID не положительное целое), 400 `invalid-config` (enabled без сохранённого token или положительного user ID), 401
- notes: token записывается через `ctx.credentials` и не возвращается. `save` не вызывает Bot API: username бота обновляется фоновым `getMe`.
  Переходы runtime сериализованы и не блокируют ответ — `status` отражает настройки, фактический старт/остановка polling наблюдаются последующим `telegram.status`.

### telegram.test — проверить сохранённый token
- method: POST
- path: /api/telegram/test
- auth: bearer
- request: `{}`
- response: `{username: string}`
- errors: 400 `not-configured` (token не сохранён), 400 `invalid-token` (Bot API ответил 401), 502 `telegram-error`, 401
- notes: вызывает `getMe` сохранённым token; не включает polling и не изменяет настройки.

### telegram.disable — выключить polling
- method: POST
- path: /api/telegram/disable
- auth: bearer
- request: `{}`
- response: `{status: TelegramStatus}`
- errors: 401
- notes: снимает `enabled`, token сохраняет. Остановка не мгновенна: цикл дожидается текущего long poll (до ~50 c на живой сети, до ~180 c при недоступном Bot API),
  при этом `status` сразу отражает настройки.

### telegram.clear-token — удалить token
- method: POST
- path: /api/telegram/clear-token
- auth: bearer
- request: `{}`
- response: `{status: TelegramStatus}`
- errors: 401
- notes: удаляет secret через credentials, автоматически снимает `enabled` и останавливает polling (та же граница остановки, что у `telegram.disable`).

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
