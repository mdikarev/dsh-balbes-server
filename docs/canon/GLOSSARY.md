# Glossary

## How to use

Термины canon используются единообразно во всех секциях canon, в спеке, планах,
runbook и коде. Если термин из этого списка встречается в проекте — он означает
именно то, что зафиксировано здесь.

## Terms

### dsh
DeepSeek Harness — лоадер профилей и платформа расширений. Профиль =
`dsh.profile.bundles` + свой слой патчей; функции dsh — Cordis-компоненты
(бандлы/плагины). В этом проекте dsh — зависимость, не форк.

### Профиль (profile)
Каталог `$DSH_HOME/profiles/<name>` (в репозитории — `profiles/<name>/`) с
манифестом `package.json` (`dsh.profile.bundles` — список бандлов,
`patchReload: startup | live`), слоем патчей `cordis.patch.yml` и
`pnpm-workspace.yaml`. Один профиль = одна поверхность dsh.

### Бандл (bundle)
npm-пакет с декларацией `dsh.bundle.patch` (указывает на свой
`cordis.patch.yml`); поставляет патч-слой композиции. Бандл из списка `bundles`
обязан иметь такую декларацию, иначе старт падает громко. Примеры:
`@deepseek-ai/dsh-base`, `dsh-balbes-host`.

### Плагин (plugin)
Обычный Cordis-плагин без `dsh.bundle.patch`: сервис, api-роут, тул, ui-плагин.
Подключается записями `insert: {id, name}` в патч профиля.

### Патч (patch) / `cordis.patch.yml`
Слой композиции: YAML-массив записей — переопределение конфига по `id`
(заменяет конфиг целиком, deep-merge нет), отключение (`disabled: true`) и
`insert` новых записей под уникальными `id`. Пустой или только-комментарный
файл роняет старт — отключение слоя пишется как `[]`.

### Host
Транспортный слой внутри процесса dsh (HTTP-роуты, раздача статики), а не
«сервер на каждую интеграцию». Штатная морда dsh (`dsh-web-app`) не
используется; наш host — собственный бандл `dsh-balbes-host` (плагины
`startup`/`server`/`auth`/`static`/`api`) в том же процессе dsh. Host раздаёт
API (только POST, R-API-1) и SPA-админку; будущие каналы — другие плагины
того же процесса, клиенты того же API.

### `dsh-balbes-host`
Собственный Cordis-бандл над `dsh-base`: `cordis.patch.yml` (persona, PTC-
режим, `code-runtime`, вставки плагинов) + плагины по экспортным подпутям.
Приложение профиля: `dsh --profile balbes` поднимает сервер и держит процесс
(в отличие от one-shot headless); процесс живёт, пока слушает HTTP-сервер,
и аккуратно закрывается по SIGTERM (dispose плагинов).

### `dsh-balbes-admin`
Админка — React SPA (Vite), НЕ плагин dsh: статика, которую host раздаёт
браузеру; общается с сервером только по HTTP API (JWT в localStorage,
`Authorization: Bearer`). Связь «агентский сервис ↔ клиенты»: будущие каналы —
клиенты того же API.

### `dsh-balbes-contracts`
Пакет чистых TS-типов API-контрактов (запросы/ответы/`ApiErrorBody`).
Импортируется SPA-клиентом; host держит структурные формы — соответствие
проверяется REAL-тестами и typecheck. Человекочитаемый реестр —
`docs/api-contracts.md`.

### `admin-auth.json`
Учётные данные админки в `$DSH_HOME` (600): `{login, passwordHash, jwtSecret,
createdAt}`. Пароль — только scrypt-хэш, открытый текст не хранится (печать
один раз при генерации). Сброс пароля ротирует `jwtSecret`: выданные JWT
становятся недействительными.

### R-API-1
Правило API: все запросы к `/api/*` — только POST (исключение — статика SPA,
это не API). Ошибки — тело `{error:{code,message}}`.

### Headless
`@deepseek-ai/dsh-headless` — one-shot драйвер: одна задача из CLI → финальный
ответ в stdout → exit. Исторический smoke-инструмент этапа 1; начиная с этапа 2
в профиль `balbes` не входит (заменён host-бандлом).

### `$DSH_HOME`
Каталог данных dsh (по умолчанию `~/.dsh`): `profiles/`, `.credentials.yaml`,
сессии, настройки. Уважается установщиком и runbook'ом.

### Mirror установки (`$DSH_HOME/profiles/node_modules`)
Симлинки-зеркало на каталог установки dsh, через которое резолвятся базовые
бандлы профиля. Поэтому базовые бандлы не кладутся в `dependencies` профиля и
не ставятся через pnpm (registry содержит сломанные устаревшие версии).

### Smoke
Ручная проверка работоспособности сервера: вход в админку / `curl` с JWT —
`POST /api/auth/login` → `POST /api/prompt` с реальным ответом модели
(этап 1: headless-CLI `dsh --profile balbes "<задача>"`). Установщик LLM
автоматически не запускает; автотесты в модель не ходят (R-TEST-1).

## Naming conventions

- Пакеты надстройки: `dsh-balbes-<роль>` (kebab-case); неймспейс
  `@deepseek-ai` не занимается.
- Файлы: kebab-case; функции/переменные camelCase; классы/типы PascalCase;
  константы UPPER_SNAKE; булевы — `is*/has*/should*`. Код и комментарии — на
  английском.
- Один профиль на поверхность; имя профиля — `<name>` в
  `$DSH_HOME/profiles/<name>` и в `profiles/<name>/` репозитория.

## Related canon

- OVERVIEW.md, ARCHITECTURE.md — контекст использования терминов.
- CANON_CONTRACT.md — структура canon.
