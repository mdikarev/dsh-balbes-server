# Управление памятью из админки (p10b) — дизайн

- Status: draft design (на ревью)
- Date: 2026-09-27
- Базируется на: `docs/canon/future_plans/p10b-memory-admin.md`,
  `docs/canon/future_plans/p10-memory-system.md`,
  `docs/superpowers/specs/2026-09-26-memory-store-design.md`,
  `docs/canon/ARCHITECTURE.md`, `docs/canon/API_CONTRACTS.md`,
  `docs/canon/ADMIN_UI.md`

## Цель

Дать владельцу видимую и редактируемую поверхность долговременной памяти
(p10a): просмотр, создание, правку и удаление записей из админки
`dsh-balbes-admin` через серверные ручки поверх сервиса `balbesMemory`.
Автонаполнения ещё нет (p10d), поэтому это слой ручного управления; при этом
canon требует, чтобы правка владельца была главнее автоматической.

## Решения и границы

Согласовано с владельцем:

| Вопрос | Решение |
|---|---|
| Размещение UI | Отдельный пункт сайдбара «Память» (самостоятельная страница) |
| Фильтры и вид списка | Поиск (FTS) + фильтр по типу + тег + «только пиннутые»; плоский список: пиннутые сверху, затем по времени изменения |
| Конфликт «владелец/агент» | Показать провенанс и время, последняя запись побеждает; разрешение конфликтов — p10d |
| Доступ без JWT | Ничего: все ручки памяти — bearer, публичного доступа нет |
| Orphan-память удалённых проектов | Не удалять автоматически (документированная политика); каскад/уборка — при p10d |
| Композиция сервера | Отдельный плагин `dsh-balbes-memory-admin` (хранилище остаётся headless) |
| API | Три ручки `list` / `save` / `delete`; типы записи переезжают в `dsh-balbes-contracts` |

Границы:

- Память остаётся невидимой модели: никакого подмешивания в контекст,
  инструментов и секций промпта (p10c), никакого автоизвлечения (p10d).
- Сессионная память движка dsh не затрагивается.
- Мультиюзерность, роли, общий доступ — вне scope.
- Публичный доступ к памяти без авторизации — вне scope.
- Полноценный редактор структурированных знаний/граф — вне scope.
- dsh — зависимость: установленные `@deepseek-ai/*` не редактируются; плагин
  использует штатные швы (`ctx.provide`, `ctx.get`, патчи профиля).

## Архитектура

### Контракты (`dsh-balbes-contracts`)

Примитивы записи переезжают из локального `types.ts` плагина памяти в
`packages/contracts/src/index.ts` (обещание p10a: «Типы сервиса пока локальны;
перенос в `dsh-balbes-contracts` — вместе с HTTP-контрактом в p10b»):

```ts
type MemoryType = "fact" | "preference" | "decision" | "note";
type MemoryScope = { kind: "global" } | { kind: "project"; name: string };
type MemoryOrigin = "owner" | "agent";

interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags: string[];
  pinned: boolean;
  origin: MemoryOrigin;
  originRef: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
```

Плагин `dsh-balbes-memory` реэкспортирует эти типы из `./types.js` — сигнатуры
сервиса и существующие тесты не меняются. Тело записи безопасно для провода:
секреты в неё не попадают (забор p10a), поэтому форма ответа — сам
`MemoryRecord`.

Wire-типы:

```ts
interface MemoryListRequest {
  scope?: MemoryScope;      // отсутствует = без фильтра по scope (все уровни)
  type?: MemoryType;
  tag?: string;
  pinned?: boolean;
  query?: string;           // непустой → FTS-поиск, иначе список
  limit?: number;
  offset?: number;
}
interface MemoryListResponse {
  records: MemoryRecord[];
}

interface MemorySaveRequest {
  id?: string;              // есть id → update, иначе create
  scope?: MemoryScope;      // обязателен при create; при update запрещён
  type: MemoryType;
  text: string;
  tags?: string[];
  pinned?: boolean;
}
interface MemorySaveResponse {
  record: MemoryRecord;
}

interface MemoryDeleteRequest {
  id: string;
}
interface MemoryDeleteResponse {
  deleted: boolean;
}
```

Пустое тело list-запроса кодируется как `{}` (R-API-1).

### Плагин `dsh-balbes-memory-admin`

Новый пакет `packages/plugins/dsh-balbes-memory-admin` — функциональный
Cordis-плагин по шаблону репозитория:

```ts
export const name = "balbes-memory-admin";
export const inject = ["balbesHttp"];
export const Config = z.object({});
export function apply(ctx, _config): void { /* ... */ }
```

- `inject = ["balbesHttp"]`; сервис `balbesMemory` читается лениво — в
  обработчике, через `ctx.get("balbesMemory")`. Это осознанное отступление от
  привычки инжектить сервисы данных: (а) плагин применяется независимо от
  порядка загрузки хранилища, (б) если хранилище не открылось (политика отказа
  p10a), ручки отвечают `503 memory-unavailable`, а не исчезают в общий 404.
- Регистрируются три ручки (все bearer, POST):

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/memory/list` | список/поиск по фильтрам |
| POST | `/api/memory/save` | создание (нет `id`) или правка (есть `id`) |
| POST | `/api/memory/delete` | удаление по `id` |

Разбор тела — как в `dsh-balbes-sessions`: отказ называет, что именно не так
(`bad-request`, 400). Валидация значений записи остаётся в сервисе p10a
(`normalizeDraft`/`normalizePatch`) — второй валидации на ручке не заводим.

- `list`: при непустом `query` (после `trim`) вызывается `service.search`,
  иначе `service.list`; фильтры (`scope`, `type`, `tag`, `pinned`) и
  `limit`/`offset` передаются в оба. Порядок задаёт сервис
  (пиннутые сверху; для поиска — по релевантности). Дефолты/максимумы лимитов —
  сервисные (list 100/500, search 20/100).
- `save` при отсутствии `id`: `scope` обязателен, сервер **форсит**
  `origin: "owner"` (SPA не может подделать провенанс). При наличии `id`:
  вызывается `service.update(id, patch)`, поле `scope` запрещено (scope
  неизменяем, canon p10a), `origin` не трогается.
- `delete`: `service.delete(id)` → `{deleted}` (200). Идемпотентно и
  дружелюбно к гонке: повторное удаление даёт `{deleted:false}`.
- Маппинг ошибок сервиса `MemoryError`:

| Код сервиса | HTTP | Тело |
|---|---|---|
| `invalid-record`, `invalid-scope`, `invalid-filter`, `invalid-query`, `secret-detected` | 400 | `{error:{code,message}}` (код сохраняется) |
| `not-found` (save с чужим `id`) | 404 | `{error:{code:"not-found",...}}` |
| неизвестная ошибка | 500 | `{error:{code:"internal",...}}` |
| сервис отсутствует | 503 | `{error:{code:"memory-unavailable",...}}` |

- Ответы никогда не содержат токенов/секретов; `secret-detected` отдаёт только
  правило-срабатывание, чтобы UI показал понятное сообщение.

### Упаковка и жизненный цикл

- `packages/plugins/dsh-balbes-memory-admin/package.json` — `name`,
  `main: ./lib/index.js`, скрипты `build`/`typecheck`/`test` по образцу
  соседей; `tsconfig.json`.
- `profiles/balbes/cordis.patch.yml`: строка `balbes-memory-admin`
  сразу после `balbes-memory`.
- `scripts/install.sh`: `copy_memory_admin_into_profile()` — зеркало
  `copy_memory_into_profile`, вызов в `main()`, обновление шапки-комментария и
  инвентаря плагинов.
- `docs/runbooks/stage2-vps.md`: инвентарь плагинов, блок smoke ручек памяти
  (см. «Обновление на сервере»).

## UI (админка)

- Сайдбар: новый live-пункт «Память» в группе «Управление»; `App.tsx` получает
  страницу `memory` и заголовок в топбаре.
- Страница `src/pages/MemoryPage.tsx` следует идиомам
  WorkspacesPage/TelegramPage: единственный `role="alert"` баннер, кнопки
  блокируются на время операции, русская копия, `data-testid`.
- Селектор уровня («Дом» / список проектов из `workspaces.list`) задаёт scope.
  По умолчанию «Дом»; если выбранный проект исчез при обновлении — откат на
  «Дом». Удалённые проекты (orphan-scope) в селекторе не показываются.
- Контролы над списком: строка поиска (FTS), фильтр типа (Все / fact /
  preference / decision / note), поле тега, тумблер «только пиннутые»,
  «+ Добавить запись», «Обновить».
- Список: плоские строки — метка пиннинга, бейдж типа, текст (`pre-wrap`),
  чипы тегов, строка провенанса «владелец · дата» / «агент · дата» (видимый
  провенанс и время), действия «Изменить» / «Удалить».
- Состояния: «Загрузка…»; пустой уровень — «Память пуста — добавьте первую
  запись»; поиск/фильтр без попаданий — «Ничего не найдено»; ошибка загрузки с
  «Повторить»; ошибки мутаций — в общий баннер.
- Модалка create/edit: селект типа, textarea текста, поле тегов, чекбокс
  пиннинга; scope показан как неизменяемый контекст (для create — выбранный
  уровень, для edit — disabled). Edit предзаполняет запись.
- Удаление: модальное подтверждение в стиле админки (`btn-danger`,
  «Удалить»/«Отмена»), нативный `confirm` не используется.
- Ошибки: `secret-detected` — inline в модалке «текст похож на секрет
  (<rule>) — запись отклонена»; `invalid-record`/`invalid-scope`/
  `invalid-query` — сообщение сервера; устаревший `404` — обновление списка.
- Свежесть: серверного push для памяти нет (SSE `workspaces.events` — только
  fs), поэтому страница перечитывает список после каждой мутации и по кнопке
  «Обновить». Это осознанный non-goal, а не скрытый пробел.

## Тестирование

- Unit плагина (fake http-seat, как в `dsh-balbes-sessions`): пути и auth
  ручек; разбор тел и отказы; форс `origin: "owner"` при create; запрет `scope`
  при update; маппинг кодов `MemoryError`; `503 memory-unavailable` без
  сервиса; `secret-detected` не пишет запись.
- Unit сервиса/контрактов памяти уже покрыты p10a; новых миграций нет.
- REAL-composition (обязательное требование репозитория): boot тестового
  профиля (dsh-base + host bundle + `balbes-memory` + `balbes-memory-admin`)
  через реальный CLI с временным `DSH_HOME`; `POST /api/auth/login` → JWT;
  затем по HTTP list/save/delete, проверка `origin: "owner"`, персистентности
  и отказа `secret-detected`. Без сети и LLM (R-TEST-1); гейт `RUN_REAL=1` +
  `dsh` в PATH, как у соседних REAL-наборов.
- SPA: `client.test.ts` — три новых метода клиента (пути/тела); тесты
  `MemoryPage` — состояния загрузки/пустоты/ошибки и CRUD-флоу по образцу
  `TelegramPage.test.tsx`/`WorkspacesPage.test.tsx`.

## Канон (по canon-first, после согласования спеки)

Правки вносит `canon-write` (агент не редактирует `docs/canon/**` напрямую):

- `ARCHITECTURE.md` — поверхность управления памятью: новый плагин, ленивое
  чтение сервиса и деградация 503, форс `origin: "owner"`, неизменяемый scope,
  отсутствие секретов в ответах; перенос типов записи в `dsh-balbes-contracts`.
- `API_CONTRACTS.md` — три записи `memory.list|save|delete` и список ручек
  в начале файла.
- `ADMIN_UI.md` — страница «Память»: размещение, селектор уровня, контролы,
  список с провенансом, модалки CRUD, состояния.
- `OVERVIEW.md` — владельческий контроль памяти как факт; аккуратное уточнение
  этапов и сигнал успеха.
- `future_plans/p10b-memory-admin.md` + `future_plans/INDEX.md` — статус
  `draft` → `implementing`/`absorbed`, снятые открытые вопросы, ссылка на
  этот дизайн.
- `docs/runbooks/stage2-vps.md` — инвентарь плагинов и smoke ручек памяти
  (правится в том же коммите, что и поведение).

Закрытие инициативы — `canon-audit`.

## Обновление на сервере

Обновление — прежняя одна команда: повторный `install.sh` на сервере
(`git pull --ff-only` → сборка → `sync_profile` с новой строкой
`balbes-memory-admin` → `copy_memory_admin_into_profile` → перезапуск
`dsh-balbes`). Миграции БД не требуются: схема памяти не меняется.

Smoke после старта (JWT из `/api/auth/login`):

```bash
TOKEN=... # из POST /api/auth/login
curl -fsS -X POST http://127.0.0.1:8080/api/memory/list \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
# ожидается: {"records":[]} (или непустой список)

curl -fsS -X POST http://127.0.0.1:8080/api/memory/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":{"kind":"global"},"type":"note","text":"smoke note","tags":["smoke"]}'
# ожидается: {"record":{...,"origin":"owner",...}}; id берётся из ответа

curl -fsS -X POST http://127.0.0.1:8080/api/memory/delete \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"id":"<id>"}'
# ожидается: {"deleted":true}
```

Диск: `ls -l "$HOME/.dsh/storages/memory.sqlite"` и `PRAGMA user_version = 1`
(как в p10a). UI: вход в админку → «Память» → создать/изменить/удалить запись,
проверить сохранение после перезагрузки страницы.

## Отложено (не в p10b)

- Автонаполнение, очередь ревью, дедуп, TTL, конфликты и признак
  «тронуто владельцем» — p10d.
- Доставка памяти в контекст, инструменты `recall`/`remember`, ядро и карта
  памяти — p10c.
- Orphan-память: каскадное удаление и показ orphan-scope в селекторе — не
  реализуем; политика «не удалять автоматически» задокументирована, уборка — при
  p10d.
- Пагинация списка и серверный push событий памяти — при росте объёма.
