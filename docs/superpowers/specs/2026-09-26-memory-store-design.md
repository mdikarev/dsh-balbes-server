# Хранилище и модель памяти (p10a) — дизайн

- Status: approved design
- Date: 2026-09-26
- Базируется на: `docs/canon/future_plans/p10a-memory-store.md`,
  `docs/canon/future_plans/p10-memory-system.md`,
  `docs/superpowers/specs/2026-09-12-agent-home-context-design.md`,
  `docs/canon/ARCHITECTURE.md`

## Цель

Дать Балбесу долговременное хранилище знания и модель записи — фундамент, поверх
которого строятся управление из админки (p10b), доставка в контекст (p10c) и
автоизвлечение/компактизация (p10d). Слой **host-side**: он не подмешивается в
контекст и не наполняется автоматически; его единственная задача — быть
источником правды о знании и предоставить сервис `balbesMemory`.

## Решения и границы

Согласовано с владельцем:

| Вопрос | Решение |
|---|---|
| Носитель истины | SQLite через `node:sqlite` (Node ≥ 22), файл `$DSH_HOME/storages/memory.sqlite` |
| Поиск | FTS5 + `bm25()` в p10a; векторный — аддитивный слой позже |
| Приоритет | Сначала durable-фундамент; retrieval наращивается аддитивно |
| Scope проекта | Слаг проекта (`scope_kind='project'`, `scope_name=<name>`) |
| Удаление проектной памяти | Политика p10b; в p10a автоматического удаления нет |
| Модель записи | Lean-core: без `title`, без review-статусов |
| Теги | Нормализованная таблица `memory_tags` |
| Секреты | Запись отклоняется с `secret-detected` (fail loud) |
| Композиция | Отдельный пакет `dsh-balbes-memory`, строка в профиле `balbes` |
| HTTP-ручки | Не входят — это p10b |

Границы:

- Headless-слой: никаких инструментов модели, секций системного промпта и
  подмешивания в контекст (p10c), никакого автоизвлечения (p10d).
- Сессионная память движка dsh не переизобретается и не затрагивается.
- Мультиюзерность, общий доступ между владельцами, граф знаний — вне scope.
- Векторный backend и внешние embedding-сервисы — вне p10a. В схеме только
  резервная колонка `embedding`.
- dsh — зависимость: установленные `@deepseek-ai/*` не редактируются; плагин
  общается с ядром через штатные швы (`ctx.provide`, `ctx.effect`, патчи
  профиля).

## Архитектура

### Пакет и композиция

Новый пакет `packages/plugins/dsh-balbes-memory` — функциональный
Cordis-плагин по шаблону репозитория:

```ts
export const name = "balbes-memory";
export const Config = z.object({
  dshHome: z.string().required(false),
  memoryPath: z.string().required(false)
});
```

`inject` не объявляется: сервисы dsh не нужны. `apply(ctx, config)`:

1. Резолвит дом как все плагины:
   `dshHome = config.dshHome ?? $DSH_HOME ?? ~/.dsh`;
   `dbPath = config.memoryPath ?? join(dshHome, "storages", "memory.sqlite")`.
2. `mkdir -p` каталога, открывает БД (см. «Носитель»), прогоняет миграции.
3. `ctx.provide("balbesMemory", service)`.
4. `ctx.effect(() => () => db.close())` — HMR-safe, освобождение хэндла.

Регистрация — строка `balbes-memory` в `profiles/balbes/cordis.patch.yml`
(отдельный пакет, как `dsh-balbes-home` и др.). Типы сервиса пока локальны;
перенос в `dsh-balbes-contracts` — вместе с HTTP-контрактом в p10b.

### Носитель

- `node:sqlite` (`DatabaseSync`), синхронный. Версия Node в контуре — 24.x,
  dsh сам использует `node:sqlite` в `dsh-session-query-sqlite`.
  ExperimentalWarning принимается.
- При открытии: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- Файл: `$DSH_HOME/storages/memory.sqlite` (+ `-wal`/`-shm` от WAL). С
  json-бэкендом dsh (`$DSH_HOME/storages`, домены `<unit>.json`/`<unit>/`) не
  конфликтует: у него другие имена.
- Все запросы — подготовленные выражения; единственный writer — сервис.

### Модель данных и схема (v1)

Запись памяти:

```ts
type MemoryType = "fact" | "preference" | "decision" | "note";
type MemoryScope = { kind: "global" } | { kind: "project"; name: string };
type MemoryOrigin = "owner" | "agent";

interface MemoryRecord {
  id: string;              // crypto.randomUUID()
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags: string[];
  pinned: boolean;
  origin: MemoryOrigin;
  originRef: string | null;
  createdAt: string;       // ISO-8601
  updatedAt: string;
}
```

DDL v1:

```sql
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('global','project')),
  scope_name  TEXT,
  type        TEXT NOT NULL CHECK (type IN ('fact','preference','decision','note')),
  text        TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  origin      TEXT NOT NULL CHECK (origin IN ('owner','agent')),
  origin_ref  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  embedding   BLOB,               -- резерв, в p10a не заполняется
  CHECK ((scope_kind = 'global'  AND scope_name IS NULL)
      OR (scope_kind = 'project' AND scope_name IS NOT NULL))
);
CREATE INDEX idx_memories_scope  ON memories(scope_kind, scope_name);
CREATE INDEX idx_memories_type   ON memories(type);

CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX idx_memory_tags_tag ON memory_tags(tag);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  text,
  content='memories', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
```

Синхронизация FTS — триггерами `AFTER INSERT / AFTER UPDATE OF text / AFTER
DELETE` по стандартному external-content шаблону fts5. Теги в FTS не входят:
фильтр по тегу — точный join с `memory_tags`, а не полнотекст (не плодим второй
источник правды). Проверено: build Node содержит FTS5, `bm25()` ранжирует,
триггеры обновляют индекс на insert/update.

Валидация выполняется вручную (без новых runtime-зависимостей):

- `scope.kind='project'` требует непустой слаг `[A-Za-z0-9._-]`, ≤ 64;
  `scope.kind='global'` запрещает `name`.
- `text` — непустой, обрезается по краям, ≤ 8 KiB.
- `type`/`origin` — строго enum.
- `tags` — массив слагов `[a-z0-9._-]`, ≤ 32, каждый ≤ 32 символов,
  без дублей; сохраняется в нижнем регистре.
- `originRef` — строка ≤ 512 или `null`.

### Сервис `balbesMemory`

```ts
interface MemoryFilter {
  scope?: MemoryScope;
  scopes?: MemoryScope[];   // глобальный + текущий проект одним запросом
  type?: MemoryType;
  tag?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

interface MemoryDraft extends Omit<MemoryRecord, "id" | "createdAt" | "updatedAt"> {}
interface MemoryPatch {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
  originRef?: string | null;
}

interface SearchHit { record: MemoryRecord; rank: number; }

interface BalbesMemoryService {
  save(draft: MemoryDraft): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  update(id: string, patch: MemoryPatch): Promise<MemoryRecord>;
  delete(id: string): Promise<boolean>;
  list(filter?: MemoryFilter): Promise<MemoryRecord[]>;
  search(request: { query: string; filter?: MemoryFilter; limit?: number }): Promise<SearchHit[]>;
  count(filter?: MemoryFilter): Promise<number>;
}
```

- Методы — `async` (Promise), хотя `DatabaseSync` синхронен: это стабильный шов
  на случай смены backend'а и единообразие с `balbesWorkspaces`/`balbesSessions`.
- `search`: `memory_fts MATCH ?` + `bm25()`; фильтры применяются тем же
  query-builder'ом, что и `list`; порядок `pinned DESC, rank ASC`, `limit`
  (дефолт 20, максимум 100). Пустой/пробельный `query` → `invalid-query`.
- `list`: порядок `pinned DESC, updated_at DESC`, `limit` — дефолт 100,
  максимум 500; `count` игнорирует `limit`/`offset`.
- `scope` неизменяем: `update` его не принимает (смена scope — delete + save).
- Ошибки со стабильными кодами: `secret-detected`, `invalid-record`,
  `not-found`, `invalid-scope`, `invalid-query`. Тип `MemoryError`.
- Дедупликации, TTL и конфликтов нет — это p10d. `update` не меняет `origin`
  и не трекает «кто последний правил» — тоже p10d.

### Приватность

На `save` и на `update` (с непустым `text`) текст проходит детектор секретов.
Совпадение → `secret-detected`, ничего не пишется. Паттерны:

- префиксы провайдерских ключей: `sk-`, `ghp_`, `github_pat_`, `xoxb-`,
  `xoxp-`, `AKIA[0-9A-Z]{16}`;
- Telegram bot token: `\d{8,10}:[A-Za-z0-9_-]{35}`;
- PEM private key: `-----BEGIN[^-]*PRIVATE KEY-----`;
- присваивания: `(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S+`;
- connection string с паролем: `://[^/:\s]+:[^/@\s]+@`;
- `Bearer\s+[A-Za-z0-9._-]{16,}`.

Это «защитный забор», а не доказательство: набор фиксируется в каноне, покрыт
тестами, слова вроде «password policy» без значения не срабатывают. Дополнительный
инвариант: плагин не читает `$DSH_HOME/.credentials.yaml`, а `originRef` не может
ссылаться на credential-ref.

### Миграции и жизненный цикл

Миграции живут в коде плагина как упорядоченный список
`{ version, up(db) }[]`; `LATEST` — версия последней. Прогон — при `apply()`
на каждом старте:

1. Открыть БД, выставить pragmas.
2. `PRAGMA user_version`.
3. `0` → применить миграцию v1.
4. `< LATEST` → **бэкап** через `node:sqlite` `backup()` (WAL-безопасный,
   онлайн) в `memory.sqlite.bak-v<текущая>` (файл перезаписывается — храним один предыдущий срез), затем применить недостающие
   миграции в одной транзакции и выставить `user_version = LATEST` внутри неё.
   DDL в SQLite транзакционен: ошибка → rollback, БД остаётся на старой версии.
5. `> LATEST` (БД новее кода) → отказать: не открывать на запись, логировать,
   не предоставлять сервис.
6. `== LATEST` → no-op.

Политика отказа: ошибка миграции/открытия не бросается наружу — плагин логирует
`balbes-memory: ...` и **не предоставляет `balbesMemory`**. Сервер остаётся
живым (Telegram/HTTP работают), потребители деградируют как при отсутствии любого
сервиса; `Restart=on-failure` не уходит в цикл. Данные целы: транзакция
откатилась, рядом `.bak-vN`.

### Тестирование

Unit: валидация записи и scope; детектор секретов (каждый паттерн + безопасные
примеры); раннер миграций (v0→v1, no-op, даунгрейд-отказ, откат при сбое);
query-builder фильтров; ранжирование `search`.

REAL-composition (требование репозитория): boot тестового `cordis.yml` через
Loader с временным `DSH_HOME` — `save/get/update/delete/list/search`, изоляция
scope (global не видит project и наоборот), `scopes`-выборка global+project,
отказ `secret-detected`, персистентность после `close`/`reopen`. Без сети и
LLM (R-TEST-1).

### Обновление на сервере

Обновление — прежняя одна команда (`install.sh`), миграции дополнительного шага
не требуют:

- В `scripts/install.sh`: добавить `copy_memory_into_profile()` (зеркало
  `copy_home_into_profile`), вызов в `main()`, обновить шапку-комментарий.
- `build_workspace` собирает пакет через `pnpm -r`; `sync_profile` кладёт
  строку `balbes-memory` из репо-патча; `verify_composition`
  (`--dump-config`) валидирует композицию; `write_systemd_unit` перезапускает
  сервис — миграции применяются при старте плагина.
- `docs/runbooks/stage2-vps.md`: абзац про миграции при рестарте в «Обновлении»;
  восстановление из `.bak-vN` в «Устранении неполадок»; дисковый smoke после
  старта (серверного API в p10a нет):

```bash
ls -l "$HOME/.dsh/storages/memory.sqlite"
node --no-warnings -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.HOME+"/.dsh/storages/memory.sqlite");console.log("user_version:",db.prepare("PRAGMA user_version").get().user_version)'
# ожидается: файл существует, user_version: 1
```

### Канон

По canon-first, до кода и после согласования спеки — `canon-write`:

- `ARCHITECTURE.md` — слой памяти: носитель, уровни/scope, модель записи, сервис,
  приватность, композиция.
- `GLOSSARY.md` — «запись памяти», «scope/уровень памяти».
- `p10a-memory-store.md` — статус `refining` → `implementing`, снятые открытые
  вопросы.
- `OVERVIEW.md` — аккуратное уточнение этапов (без преждевременного снятия
  «Долговременной памяти» из out-of-scope).

Закрытие инициативы — `canon-audit`.

## Отложено (не в p10a)

- HTTP-ручки и UI памяти — p10b; там же политика orphan-памяти удалённых проектов.
- Инструменты `recall`/`remember`, ядро и карта памяти — p10c.
- Автоизвлечение, дедуп, TTL, конфликты, review-очередь — p10d.
- Векторный retrieval и `embedding`: колонка зарезервирована, индекс (in-process
  перебор или Qdrant как пересобираемый индекс) — отдельный горизонт. Выбор
  требует источника эмбеддингов, которого в контуре сейчас нет.
- Ручной `scripts/memory-status.mjs` для диагностики — не закладывается; при
  необходимости добавляется позже.
