# Дизайн: настройка моделей (подключения провайдеров, ключи, дефолтная модель)

- Дата: 2026-09-09
- Статус: черновик на ревью
- Тип: дизайн новой функциональности админки/API (раздел «Модели»)
- Порядок по canon: спека → canon-write (перенос «управления ключами в UI»
  из out-of-scope в in-scope + новые ручки/страница/термины) → go-ahead
  владельца на код → реализация (TDD, REAL-композиция) → canon-audit

## 1. Цель и границы

Раздел «Модели» в админке dsh-balbes-server: владелец управляет моделями, на
которых работает сервер. Строка списка — **подключение провайдера**: вид
провайдера, имя, опциональный кастомный baseURL и один API-ключ. Отдельно
выбирается **глобальная дефолтная модель** — на неё уходят все последующие
запросы `/api/prompt` (runner уже читает engine-selection).

Ключевой факт исследования: **движок dsh 0.1.2-rc.1 уже реализует всю
механику** (каталог провайдеров `deepseek-official` + кастомные pi-ai-роуты с
baseURL и моделями; refs-ключи в `.credentials.yaml` с живым резолвом на
каждый запрос; settings-секции `llm-pi-ai` и `agent-default-model`),
и эта механика уже активна в процессе balbes (входит в композицию
`dsh-base`). Проект делает **тонкий CRUD-слой** над сервисами движка
(`ctx.settings`, `ctx.credentials`, `agentDefaultModel`) — без правок
установленных `@deepseek-ai/*` и без собственного хранилища ключей.

**Вне границ этого шага** (последующие итерации): несколько ключей на одно
подключение, проверка ключа реальным LLM-запросом, выбор модели per-request
на странице промпта, `reasoningEffort` в UI, шаблоны известных провайдеров,
автоподтягивание моделей с `/v1/models`, сессии/чат.

## 2. Решения (подтверждены владельцем в брейншторме)

1. Вариант реализации — **тонкий слой поверх движка** (не overlay-реестр, не
   штатная web-морда dsh).
2. Модель данных: строка = подключение провайдера (имя + вид + ключ +
   опциональный baseURL). Дефолтная модель выбирается отдельно.
3. Дефолтная модель — **глобальная**, в разделе «Модели»; per-request
   override не делаем.
4. Виды подключений v1: **DeepSeek официальный** (только ключ, URL
   фиксирован, закреплён, не удаляется) и **OpenAI-совместимый** (displayName,
   baseURL, ключ, список id моделей ≥ 1).
5. Хранилище — нативное для движка: роуты в settings-секции `llm-pi-ai`,
   значения ключей — refs в `$DSH_HOME/.credentials.yaml`, дефолтная модель —
   секция `agent-default-model`. Изменения применяются к следующему запросу
   без рестарта (движок резолвит ключ/настройки на каждый запрос).
6. Реализация — отдельный пакет-плагин
   `packages/plugins/dsh-balbes-models` (прецедент: workspaces), ручки под
   bearer, R-API-1 (POST), контракты в `dsh-balbes-contracts` и в canon
   `API_CONTRACTS.md`.
7. Порядок работ — canon-first: спека → canon-write → go-ahead → код (TDD) →
   canon-audit; runbook/установщик/CI правятся в том же коммите, что и код.

## 3. Модель и домен

### Подключение (connection)

| поле | тип | заметки |
| --- | --- | --- |
| `routeId` | string | id роута движка: `deepseek-official` или lower-hyphen имя кастомного роута |
| `kind` | `"deepseek" \| "custom"` | вид подключения |
| `displayName` | string | человекопонятное имя (для custom — вводит владелец) |
| `baseURL` | string? | только custom; для deepseek — фиксированный официальный (не показывается/не редактируется) |
| `hasKey` | boolean | есть ли сохранённый ключ (значение нигде не возвращается) |
| `models` | string[] | id доступных моделей; deepseek — каталог движка, custom — введённые владельцем |
| `isDefault` | boolean | на этом подключении стоит дефолтная модель (derived) |

Встроенный `deepseek-official` существует всегда (kind deepseek, каталог
движка `dsh-llm-deepseek`, ключ-реф `DEEPSEEK_API_KEY`), удалению не
подлежит — аналог закреплённого «Дома агента».

### Маппинг на состояние движка

- **custom-подключение** → settings-секция `llm-pi-ai`, роут
  `providers.<routeId>`:
  `{displayName, baseURL, apiKeyEnv, models: [{id, name?}]}`. Поле `api`
  (протокол) для полностью кастомного роута — уточняется по
  `supportedProtocols()`/d.ts движка при реализации; цель v1 — chat-
  completions совместимость. `apiKeyEnv` = сгенерированное имя env-ref,
  напр. `BALBES_<ROUTE_UPPER_SNAKE>_API_KEY`.
- **значение ключа** → ref в `$DSH_HOME/.credentials.yaml` (`refs:`),
  запись через сервис `ctx.credentials` (atomic write + файловая блокировка
  credentials-local), удаление — unset ref. Никогда не логируется и не
  возвращается API.
- **дефолтная модель** → settings-секция `agent-default-model`
  `{provider: routeId, model: id}` через сервис `agentDefaultModel`
  (`currentSelection()`/read, `saveSelection()`/write — runner.ts уже
  читает selection на каждый `/api/prompt`).

Чтение роутов/секций — `ctx.settings` (`get`/`update` с патч-merge по
одному роуту, без гонок при single-user). Каталог моделей deepseek и список
роутов движок отдаёт сам (`listModels`/`resolveModel`/каталог llm-deepseek)
— не дублируем списки в своём коде.

### Правила имён и валидация

- `routeId` custom — генерируется из displayName: lower-hyphen
  (`^[a-z][a-z0-9-]*$`), уникален среди роутов; `deepseek-official`
  зарезервирован.
- baseURL — валидный http(s)-URL.
- Модели custom — ≥ 1 id, строка без пробелов/запятых.
- Удаление custom-подключения, на котором стоит дефолтная модель → 409
  `default-in-use` (владелец сначала меняет дефолт).

## 4. API (R-API-1, POST, bearer; формы — `dsh-balbes-contracts`)

| ручка | запрос → ответ | ошибки |
| --- | --- | --- |
| `models.list` | `{}` → `{connections: [...], default: {provider, model}}` | 401 |
| `models.save` | `{routeId?} + {kind, displayName?, baseURL?, key?, models?}` → `{connection}` | 400 `invalid-*`, 409 `route-exists`, 401 |
| `models.delete` | `{routeId}` → `{}` | 400 `reserved` (deepseek-official), 404 `not-found`, 409 `default-in-use`, 401 |
| `models.default` | `{provider, model}` → `{default}` | 400 `invalid-*` (нет такого роута/модели), 401 |

Ключ в `models.save`: если передан — обновляет ref; если `key: null` у
custom — сбрасывает (unset). Секрет в ответах не возвращается никогда.

## 5. UI — страница «Модели»

- Новый пункт сайдбара «Модели» (по образцу WorkspacesPage; тёмная dev-tool
  тема, русская копия, API-клиент с JWT — существующий паттерн).
- Шапка страницы: селект «Дефолтная модель» (группы по подключениям: DeepSeek
  — модели каталога движка; custom — введённые id) и кнопка «+ Добавить».
- Список карточек подключений: закреплённая карточка **DeepSeek (официальный)**
  — ключ «••••» с кнопкой «Изменить ключ», удаления нет; карточки custom —
  displayName, baseURL, ключ «••••»/«не задан», чипы моделей, «⋮» → Изменить /
  Удалить (модальное подтверждение, как у проектов).
- Модалка «Добавить/Изменить»: вид *DeepSeek* — только поле ключа; вид
  *OpenAI-совместимый* — displayName, baseURL, ключ, модели (ввод по одному,
  минимум одна). Валидация полей на клиенте и сервере.
- Пустое состояние: нет custom-подключений — «Добавьте провайдера с ключом».

## 6. Ошибки и безопасность

- Тело ошибок — `{error:{code,message}}` (существующий паттерн); коды
  стабильны, покрыты REAL-тестами.
- Секреты: не логируются, не возвращаются, файл `.credentials.yaml` остаётся
  600; записи только через credentials-слой движка (atomic + lock), паттерн
  ручного `writeFile` для ключей не используется.

## 7. Тестирование

- Unit: генерация routeId, валидация baseURL/моделей, маппинг connection ↔
  роут settings/ref (с мок-сервисами — паттерн tests workspaces).
- REAL-композиция: тестовый `cordis.yml` (Loader/app) с временным
  `$DSH_HOME`: save custom-подключения → роут появился в `llm-pi-ai` и ref в
  `.credentials.yaml`; delete; установка/чтение дефолта; deepseek key save.
- Проверки после реализации: `pnpm typecheck`, `pnpm lint`, `pnpm test`
  (реально выполненные команды), запуск REAL-теста локально.

## 8. Canon и синхронные правки

- **canon-write (до кода, после go-ahead владельца на существенные правки):**
  OVERVIEW.md — «управление ключами/моделями в UI» переносится из out-of-scope
  в in-scope + сигналы успеха; ARCHITECTURE.md — новый плагин `dsh-balbes-models`
  и поток «настройка моделей»; API_CONTRACTS.md — ручки `models.*`;
  ADMIN_UI.md — страница «Модели»; GLOSSARY.md — термины (подключение,
  дефолтная модель, ref). Все — через скиллы canon, не вручную.
- **В одном коммите с кодом:** `scripts/install.sh` и `.github/workflows/ci.yml`
  (копия собранного `dsh-balbes-models` в profile `node_modules`),
  runbook `docs/runbooks/stage2-vps.md` (smoke новых ручек, обновление),
  `dsh-balbes-contracts` (типы) + SPA-клиент.
- **Завершение:** canon-audit по теме моделей.
