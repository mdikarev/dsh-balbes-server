# Ревью и автономия записи памяти (p10f) — дизайн

- Status: approved design
- Date: 2026-09-30
- Базируется на: `docs/canon/future_plans/p10f-memory-review.md`,
  `p10-memory-system.md`, `p10a-memory-store.md`, `p10b-memory-admin.md`,
  `p10c-memory-context.md`, `p10e-memory-remember.md`, `p10g-memory-extraction.md`,
  спеках `2026-09-26-memory-store-design.md`,
  `2026-09-27-memory-admin-design.md`,
  `2026-09-29-memory-remember-design.md`, `docs/canon/ARCHITECTURE.md`,
  `docs/canon/API_CONTRACTS.md`, `docs/canon/ADMIN_UI.md`,
  `docs/canon/GLOSSARY.md`

## Цель

Запись, порождённая пайплайном, не должна молча становиться истиной. Слой
вводит **предложенные записи**: они живут в отдельной таблице, владелец
одобряет или отклоняет их в админке, а одобрение промоутит предложение в
настоящую запись памяти. Политика автономии фиксируется и видна владельцу:
владелец и явный `remember` пишут сразу, пайплайн — только через ревью.

Слой опирается на хранилище (p10a), админ-поверхность (p10b), доставку (p10c)
и явную запись (p10e) и не меняет ни одно из их поведений. Это предпосылка
автоизвлечения (p10g): извлечённое знание становится предложением, а не истиной.

## Решения и границы

Согласовано с владельцем:

| Вопрос | Решение |
|---|---|
| Политика автономии | Явный `remember` (p10e) пишет сразу; предложения создаёт пайплайн через `propose` |
| Носитель предложений | Отдельная таблица `memory_proposals` (таблица истины `memories` не меняется) |
| Видимость предложений | Скрыты от доставки структурно: доставка читает `memories`, а не предложения |
| Продюсер в этой итерации | Механизм + серверная ручка `memory.propose` как шов пайплайна (p10g) |
| Режим доверия | Нет: автоодобрения нет, настройки нет, политика одна и неизменна |
| Поверхность владельца | Только админка (вкладка «Очередь ревью» на странице «Память»); Telegram не задействован |
| Жизненный цикл | Durable, без TTL; решённое остаётся (`accepted`/`rejected`); затухание — p10d |
| Правка при одобрении | Разрешена; `origin`/`originRef` предложившего сохраняются, факт правки содержания — в аудите |
| Теги предложения | JSON-колонка, не отдельная таблица |
| Порядок очереди | FIFO (`proposedAt ASC`) |
| `decidedEdit` | Только правка содержания (`type`/`text`/`tags`); пиннинг не считается |

Границы:

- Таблица истины `memories` и её FTS-триггеры не меняются ни одной строкой;
  `save`/`update`/`delete`/`list`/`search`/`count` сохраняют семантику p10a.
- **Приоритет владельца** конкретно означает: (а) единственный путь из
  `proposed` в истину — решение владельца; (б) владелец правит и удаляет
  принятую запись когда угодно, и это никогда не порождает предложение и не
  проходит ревью; (в) предложение пайплайна не перезаписывает существующую
  запись — без дедупа и слияния (p10d) одобрение только добавляет новую.
- Никакой новой модельной поверхности: агент не получает инструмент
  `propose_memory`; `propose` — серверный шов.
- Промоушен — единственный новый путь записи в `memories`, он живёт внутри
  сервиса `balbesMemory` и переиспользует нормализаторы, детектор секретов и
  insert-стейтменты `save`; обходного пути нет.
- Мультиюзерность, роли и несколько ревьюеров — вне scope: `decidedBy` в v1
  всегда `owner`.
- Дедупликация, затухание, конфликты — p10d; извлечение — p10g; метрики — p10h.

## Архитектура

### Хранилище: миграция v2

Новые объекты в том же файле `$DSH_HOME/storages/memory.sqlite` (тот же
`DatabaseSync`, тот же единственный writer). Только `CREATE`, поэтому свежая БД
и апгрейд v1→v2 дают идентичную схему; перед апгрейдом штатно делается бэкап
`memory.sqlite.bak-v1`.

```sql
CREATE TABLE memory_proposals (
  id           TEXT PRIMARY KEY,
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('global','project')),
  scope_name   TEXT,
  type         TEXT NOT NULL CHECK (type IN ('fact','preference','decision','note')),
  text         TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  origin       TEXT NOT NULL CHECK (origin IN ('owner','agent')),
  origin_ref   TEXT,
  status       TEXT NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed','accepted','rejected')),
  proposed_at  TEXT NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT,
  decided_edit INTEGER NOT NULL DEFAULT 0 CHECK (decided_edit IN (0,1)),
  memory_id    TEXT REFERENCES memories(id) ON DELETE SET NULL,
  CHECK ((scope_kind = 'global'  AND scope_name IS NULL)
      OR (scope_kind = 'project' AND scope_name IS NOT NULL)),
  CHECK ((status =  'proposed' AND decided_at IS NULL)
      OR (status <> 'proposed' AND decided_at IS NOT NULL))
);

CREATE INDEX idx_memory_proposals_status ON memory_proposals(status, proposed_at);
CREATE INDEX idx_memory_proposals_scope  ON memory_proposals(scope_kind, scope_name);
```

- **Пиннинга у предложения не существует** — колонки `pinned` нет, значит
  пайплайн структурно не может предложить закрепление. Пиннуть запись можно
  только при одобрении, рукой владельца.
- `memory_id` — промоутированная запись; `ON DELETE SET NULL` сохраняет строку
  аудита, если владелец потом удалит саму запись. Поэтому lifecycle-CHECK
  связывает только `status` и `decided_at`: `SET NULL` — это `UPDATE` дочерней
  строки, и более сильный CHECK сломал бы удаление памяти.
- Теги — JSON-массив нормализованных слагов в `tags`; фильтр по тегу в очереди
  идёт через `EXISTS (SELECT 1 FROM json_each(p.tags) WHERE json_each.value = ?)`.
  В `memories` при промоушене теги по-прежнему попадают в нормализованную
  `memory_tags`: модель истины не меняется.
- `validateMemorySchema` расширяется таблицей `memory_proposals`, чтобы чужая
  или побитая БД на v2 отсекалась при старте (политика отказа p10a: лог
  `balbes-memory: ...`, сервис не предоставляется, сервер живёт).
- Миграция `MIGRATIONS` получает `{version: 2, ...}`; существующий код
  `openMemoryDatabase`/`migrate`/бэкапа не меняется.

Записи, созданные до p10f, миграции не касаются: они уже истина.

### Сервис `balbesMemory` — аддитивно

Существующие методы не меняются. Добавляются:

```ts
export type MemoryProposalStatus = "proposed" | "accepted" | "rejected";

export interface MemoryProposal {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags: string[];
  origin: MemoryOrigin;          // в v1 всегда "agent"
  originRef: string | null;
  status: MemoryProposalStatus;
  proposedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;      // в v1 всегда "owner"
  decidedEdit: boolean;
  memoryId: string | null;
}

export interface MemoryProposalDraft {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  originRef?: string | null;
}

export interface MemoryProposalFilter {
  scope?: MemoryScope;
  type?: MemoryType;
  tag?: string;
  status?: MemoryProposalStatus[];
  limit?: number;
  offset?: number;
}

export interface MemoryDecisionPatch {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
}

propose(draft: MemoryProposalDraft): Promise<MemoryProposal>;
getProposal(id: string): Promise<MemoryProposal | undefined>;
listProposals(filter?: MemoryProposalFilter): Promise<MemoryProposal[]>;
approve(id: string, patch?: MemoryDecisionPatch):
  Promise<{ proposal: MemoryProposal; record: MemoryRecord }>;
reject(id: string): Promise<MemoryProposal>;
```

Семантика:

- `propose` нормализует scope/type/text/tags теми же функциями, что `save`,
  прогоняет текст через `detectSecret`, пишет `origin = "agent"`,
  `status = "proposed"`, `proposedAt = now`, `decided*` пустыми,
  `tags = JSON.stringify(normalizeTags(...))`.
- `listProposals` без `status` отдаёт только `proposed`; порядок
  `proposed_at ASC` (FIFO — старое предложение не голодает); лимиты как у
  `list` (100 по умолчанию, максимум 500).
- `approve` — промоушен **одной транзакцией**:
  1. загрузить предложение; нет → `not-found`; `status !== "proposed"` →
     `invalid-status`;
  2. нормализовать патч (`normalizeDecisionPatch`: только `type`/`text`/`tags`/
     `pinned`; `originRef` предложения не меняется);
  3. вычислить эффективные значения (`type`, `text`, `tags` — из патча или из
     предложения; `pinned` — из патча, иначе `false`);
  4. `detectSecret` на эффективном тексте;
  5. `BEGIN`: вставка в `memories` (`origin = "agent"`, `originRef` из
     предложения, `created_at`/`updated_at` = now) → теги в `memory_tags` →
     `UPDATE memory_proposals SET status='accepted', decided_at=now,
     decided_by='owner', decided_edit=?, memory_id=?` → `COMMIT`; при ошибке
     `ROLLBACK`, предложение остаётся `proposed`;
  6. вернуть `{proposal, record}`.
- `decidedEdit = true` тогда и только тогда, когда патч **меняет содержание**
  (`type`/`text`/`tags`) относительно текущих значений предложения. Патч,
  совпадающий с предложением, и патч только с `pinned` дают `decidedEdit = false`.
  Считает сервер сравнением нормализованных значений, а не UI.
- `reject`: нет → `not-found`; не `proposed` → `invalid-status`; иначе
  `status='rejected'`, `decided_at`, `decided_by='owner'`, `decided_edit=0`,
  `memory_id` остаётся NULL. Строка сохраняется как аудит.
- Обратных переходов нет; решение по уже решённому предложению — всегда
  `invalid-status`.

**Изоляция чтения.** `list`/`search`/`count` читают `memories` и не знают о
предложениях; `get`/`update`/`delete` работают только с `memories`. Поэтому
доставка p10c (`prepare` → ядро/карта/push, `recall`) не меняется ни строкой и
структурно не может увидеть предложение: это не фильтр, а другая таблица.

Новая ошибка — `invalid-status` (400) в дополнение к кодам p10a
(`secret-detected`, `invalid-record`, `invalid-scope`, `invalid-filter`,
`invalid-query`, `not-found`).

### Контракты `dsh-balbes-contracts`

Аддитивно, компиляторный SoT форм:

```ts
export type MemoryProposalStatus = "proposed" | "accepted" | "rejected";

export interface MemoryProposal { /* как в сервисе */ }

export interface MemoryAutonomyPolicy {
  immediate: Array<"owner" | "remember">;  // пишется сразу
  review: Array<"pipeline">;               // идёт в очередь
  autoApprove: "none";                     // режима доверия нет
}

export interface MemoryProposeRequest {
  scope: MemoryScope; type: MemoryType; text: string;
  tags?: string[]; originRef?: string;
}
export interface MemoryProposeResponse { proposal: MemoryProposal }

export interface MemoryReviewListRequest {
  scope?: MemoryScope; type?: MemoryType; tag?: string;
  status?: MemoryProposalStatus[]; limit?: number; offset?: number;
}
export interface MemoryReviewListResponse {
  proposals: MemoryProposal[]; policy: MemoryAutonomyPolicy;
}

export interface MemoryReviewApproveRequest {
  id: string; type?: MemoryType; text?: string; tags?: string[]; pinned?: boolean;
}
export interface MemoryReviewApproveResponse {
  proposal: MemoryProposal; record: MemoryRecord;
}

export interface MemoryReviewRejectRequest { id: string }
export interface MemoryReviewRejectResponse { proposal: MemoryProposal }
```

`MemoryRecord` не меняется: у истины нет статуса ревью.

### Серверная поверхность

Всё — в существующем плагине `dsh-balbes-memory-admin` (тот же `inject =
["balbesHttp"]`, тот же ленивый `ctx.get("balbesMemory")` на каждый запрос).
Четыре новых ручки, все POST по R-API-1:

**`POST /api/memory/propose`** — шов пайплайна

- request: `{scope, type, text, tags?, originRef?}`
- response: `{proposal: MemoryProposal}`
- errors: 400 `bad-request` (форма), 400 `invalid-record`/`invalid-scope`/
  `secret-detected`, 401, 503 `memory-unavailable`, 500
- notes: `origin="agent"` и `status="proposed"` форсит сервер; значения
  `origin`/`status`/`decided*` из тела игнорируются; поля `pinned` в контракте
  нет вовсе.

**`POST /api/memory/review/list`** — очередь ревью

- request: `{scope?, type?, tag?, status?, limit?, offset?}`
- response: `{proposals: MemoryProposal[], policy: MemoryAutonomyPolicy}`
- errors: 400 `bad-request`/`invalid-filter`/`invalid-scope`, 401, 500, 503
- notes: без `status` — только `proposed`, FIFO `proposedAt ASC`; явный `status`
  показывает решённые; `policy` — константа плагина, единый источник описания
  автономии для UI (`immediate: ["owner","remember"]`, `review: ["pipeline"]`,
  `autoApprove: "none"`).

**`POST /api/memory/review/approve`**

- request: `{id, type?, text?, tags?, pinned?}` (патч необязателен)
- response: `{proposal, record}`
- errors: 400 `bad-request`, 400 `secret-detected`/`invalid-record`,
  400 `invalid-status` (уже решено), 404 `not-found`, 401, 500, 503
- notes: правка применяется к промоутируемой записи, `origin`/`originRef`
  предложения сохраняются, `decidedEdit` — только при изменении содержания;
  промоушен атомарен.

**`POST /api/memory/review/reject`**

- request: `{id}`; response: `{proposal}`
- errors: 400 `bad-request`, 400 `invalid-status`, 404 `not-found`, 401, 500, 503

`SERVICE_ERROR_STATUS` получает `"invalid-status": 400`. Ручки
`memory.list`/`save`/`delete` и их контракты не меняются.

### Админ-UI

Страница «Память» получает две вкладки; нового пункта сайдбара нет.

- **«Записи»** — текущее содержимое без изменений.
- **«Очередь ревью»** — новая вкладка, на ярлыке счётчик ожидающих:
  - строка политики, отрендеренная из `policy`
    («Владелец и явный `remember` пишут сразу; предложения пайплайна — через
    ревью. Автоодобрения нет»);
  - тулбар: уровень («Дом» / проект из `workspaces.list` / «Все», тот же
    паттерн и откат на «Дом»), фильтр типа, поле тега, тумблер «Показать
    решённые», «Обновить»;
  - строка: бейдж типа, бейдж уровня, текст, чипы тегов, провенанс
    «предложено пайплайном · `originRef`», время предложения; у решённых —
    бейдж «принято» / «принято с правкой» / «отклонено», время решения,
    действий нет;
  - действия у ожидающих: «Одобрить» (модалка с предзаполненными типом,
    текстом, тегами и тумблером пиннинга; подтверждение отправляет патч) и
    «Отклонить» (модальное подтверждение). Отдельной кнопки «Изменить и
    одобрить» нет — правка живёт внутри модалки одобрения;
  - состояния: «Очередь пуста», «Решённых предложений нет», «Ничего не
    найдено», ошибка с «Повторить»; `secret-detected` при правке — inline в
    модалке (как на существующей странице); `invalid-status` — «Предложение уже
    решено» и перезагрузка; 404 — перезагрузка;
  - серверного push нет: перечитывание после мутации и по «Обновить».

## Ошибки и деградация

| Ситуация | Поведение |
|---|---|
| `balbesMemory` не предоставлен | все четыре ручки → 503 `memory-unavailable` (не 404) |
| нет/просрочен bearer | 401 |
| хранилище упало в момент промоушена | транзакция откатывается, предложение остаётся `proposed`, 500/503 |
| правка при одобрении похожа на секрет | 400 `secret-detected`, предложение остаётся `proposed` |
| повторное решение | 400 `invalid-status` |
| неизвестный `id` | 404 `not-found` |
| доставка при недоступном хранилище | как p10c: warning, пустой снапшот, ход не ломается |
| вкладка «Записи» при 503 | как сегодня (ошибка + «Повторить») |

## Наблюдаемость

Плагин пишет по одной `logger.info`-строке на мутацию ревью, без текста памяти:
`balbes-memory-admin: propose id=<id> scope=<global|project:name>`,
`... approve id=<id> edited=<true|false>`, `... reject id=<id>`. Это
детерминированный след для серверного smoke, не метрики p10h. Аудит решения
живёт в данных (`decided_at`, `decided_by`, `decided_edit`, `memory_id`).

## Тестирование

**Схема** (`dsh-balbes-memory`): свежая БД несёт `memory_proposals`; апгрейд
v1→v2 создаёт `memory.sqlite.bak-v1` и сохраняет существующие записи;
БД на `user_version = 2` без `memory_proposals` отсекается
`validateMemorySchema`; `CHECK` статуса↔`decided_at` не даёт вставить
несогласованную строку; `json_valid` не даёт записать мусор в теги.

**Сервис**: `propose` нормализует теги в JSON, валидирует scope/type/text,
ловит секрет; `approve` промоутит с сохранением `origin="agent"`/`originRef`,
теги попадают в `memory_tags`; правка содержания → `decidedEdit = true`, патч
только с `pinned` → `false`, идентичный патч → `false`; `reject` оставляет
строку со статусом `rejected` и не создаёт запись; повторное решение →
`invalid-status`; неизвестный `id` → `not-found`; правка-секрет откатывает
транзакцию и оставляет `proposed`; FIFO-порядок; фильтры по статусу и тегу;
`memoryId` → `null` после удаления промоутированной записи; предложения не
появляются в `list`/`search`/`count`; `get`/`update`/`delete` не видят
предложений.

**REAL-композиция памяти**: ожидающее предложение не появляется ни в
ядре/карте/push, ни в `recall`; после одобрения запись доставляется следующим
`prepare`; `remember` (p10e) по-прежнему пишет сразу и видно со следующего
`prepare` — регрессия закрыта.

**REAL-композиция админки**: `propose` → `review/list` → `approve` →
`memory.list`; ветка `reject` (в `memory.list` записи нет); 401 без bearer;
503 без хранилища; повторный `approve` → `invalid-status`; `secret-detected`
на `propose`; `policy` в ответе `review/list`.

**Фронтенд** (`MemoryPage.test.tsx`): переключение вкладок, рендер очереди,
модалка одобрения с патчем, подтверждение отклонения, строка политики, пустые
и ошибочные состояния, счётчик ожидающих.

**Локальные проверки**: `pnpm typecheck`, `pnpm test`, `pnpm build` (скрипта
`lint` в workspace нет). REAL-прогоны — с `RUN_REAL=1` и `dsh` в `PATH`, как у
соседних пакетов.

## Канон

По canon-first, после утверждения этой спеки и **до кода** — `canon-write`:

- `ARCHITECTURE.md` — Memory layer: жизненный цикл знания, предложенная запись,
  ревью, политика автономии, промоушен; явно зафиксировать, что `remember`
  (p10e) пишет сразу и не меняется, а предложения лежат в отдельной таблице.
- `GLOSSARY.md` — «предложенная запись памяти», «ревью памяти», «политика
  автономии».
- `ADMIN_UI.md` — вкладки страницы «Память» и очередь ревью.
- `API_CONTRACTS.md` — четыре ручки, `MemoryProposal`, `MemoryAutonomyPolicy`,
  код `invalid-status`.
- `future_plans/p10f-memory-review.md` → `absorbed` с деталями;
  `p10-memory-system.md` — уточнение; `INDEX.md` — синк (через
  `canon-future-plan`).
- `docs/runbooks/stage2-vps.md` — smoke ревью и поправка «схема на v1» → v2.

После существенных правок канона — пауза на go-ahead владельца, затем код.
Закрытие инициативы — `canon-audit`.

## Обновление на сервере

Новых пакетов нет; появляется миграция БД v1→v2 (бэкап `.bak-v1` делается
автоматически). Обновление — повторный `scripts/install.sh` на сервере
(`git pull --ff-only` → сборка → `sync_profile` → копирование плагинов →
рестарт `dsh-balbes`).

Smoke после старта:

```bash
# 0) схема на v2 (бэкап v1 появился)
node --no-warnings -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.HOME+"/.dsh/storages/memory.sqlite");console.log("user_version:",db.prepare("PRAGMA user_version").get().user_version)'
ls -l "$HOME/.dsh/storages/memory.sqlite.bak-v1"   # ожидается после первого апгрейда

TOKEN=... # из POST /api/auth/login

# 1) пайплайн предлагает запись
curl -fsS -X POST http://127.0.0.1:8080/api/memory/propose \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":{"kind":"global"},"type":"fact","text":"smoke-review-marker: код сборки Балбеса — dsh-balbes","originRef":"pipeline:smoke"}'
  # ожидается: {"proposal":{...,"status":"proposed","origin":"agent","decidedAt":null,"memoryId":null}}

# 2) предложение в очереди и НЕ в памяти
curl -fsS -X POST http://127.0.0.1:8080/api/memory/review/list \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
  # ожидается: proposals с этим id, policy {immediate:[owner,remember],review:[pipeline],autoApprove:"none"}
curl -fsS -X POST http://127.0.0.1:8080/api/memory/list \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query":"smoke-review-marker"}'
  # ожидается: {"records":[]} — предложение не истина

# 3) одобрение с правкой
curl -fsS -X POST http://127.0.0.1:8080/api/memory/review/approve \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"<id>","text":"smoke-review-marker: код сборки Балбеса — dsh-balbes (проверено)"}'
  # ожидается: proposal.status "accepted", decidedEdit true, record с origin "agent"

# 4) запись стала истиной
curl -fsS -X POST http://127.0.0.1:8080/api/memory/list \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query":"smoke-review-marker"}'
  # ожидается: одна запись, origin "agent", originRef "pipeline:smoke"

# 5) повторное решение отклоняется
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/memory/review/approve \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"id":"<id>"}'
  # ожидается: 400

# 6) след в журнале
journalctl -u dsh-balbes -n 200 | grep balbes-memory-admin
  # ожидается: propose/approve строки без текста памяти

# 7) уборка
curl -fsS -X POST http://127.0.0.1:8080/api/memory/delete \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"id":"<record-id>"}'
```

## Отложено

- Автоизвлечение знания из задач — p10g (создаёт предложения через `propose`).
- Дедупликация, затухание, забывание, конфликты, перенос между scope — p10d.
- Метрики попаданий и пользы — p10h.
- Режим доверия/автоодобрение, настройка политики владельцем.
- Уведомления в Telegram и решения по предложениям из бота.
- Мультиюзерность, роли, несколько ревьюеров, история нескольких решений.
- Самообучение и правка агентом своих правил и скиллов.
- Агентский propose-путь и отдельное значение `origin = "pipeline"`.
- Правка или удаление предложения без решения (в v1 решение — единственный
  переход).
