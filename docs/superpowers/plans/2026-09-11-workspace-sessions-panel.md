# Сессии воркспейса в правой панели — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На странице «Проекты» админки правая зона получает плашку табов с одним табом «Сессии», в котором показан список сессий выбранного воркспейса (заголовок, канал, время создания) из нового серверного реестра `$DSH_HOME/workspace-sessions.json`.

**Architecture:** Новый функциональный плагин `dsh-balbes-sessions` владеет файловым реестром «воркспейс → сессии» (append-only, upsert по `sessionId`) и ручкой `sessions.list`; заголовок и время сессии берутся из движка одним вызовом `ctx.sessionQuery.readTitleSnapshots`. Плагин telegram получает сервис `balbesSessions` через `inject` и регистрирует свои workspace-сессии. Правая панель админки становится контейнером табов (табы описаны данными), таб «Сессии» — тонкий клиент ручки.

**Tech Stack:** TypeScript (strict, ESM), Cordis-плагины dsh, Node 22 `node:fs/promises`, vitest, React 18 + Testing Library (jsdom), bash-установщик.

**Spec:** `docs/superpowers/specs/2026-09-11-workspace-sessions-panel-design.md`

## Global Constraints

- Канон — источник правды: `docs/canon/**` правится **только** через скилл `canon-write` (и `canon-future-plan` для future-plan), никогда руками. Код приложения идёт **после** обновления канона (задача 1 — первая).
- Плагины: функциональный плагин экспортирует named `name` / `inject` / `Config` / `apply`, без default-export. `Config` — `@deepseek-ai/schemastery`. Зависимости объявляются через `inject`; сервисы читаются `ctx.get(name)` со структурной типизацией (как в существующих плагинах).
- Никогда не править установленные `@deepseek-ai/*`. Кросс-импорт между нашими плагинами запрещён (композиция — через профиль).
- R-API-1: все `/api/*` — только POST, JSON тело/ответ, ошибки `{error:{code,message}}`, `auth: bearer` кроме публичных.
- Ключ воркспейса — формат telegram: `home` | `project:<имя>`.
- Новый файл состояния создаётся с правами 600, пишется атомарно (tmp + rename), проверка формы — **до** записи.
- UI-копия русская, короткая; стиль — существующие токены `:root` в `src/styles.css`; `data-testid` в kebab-case.
- Прогон после каждой задачи: `pnpm --filter <пакет> run test`, финал — `pnpm typecheck && pnpm test`.
- Рунбук `docs/runbooks/stage2-vps.md` — живой документ: правится в том же изменении, что и серверная поверхность. Ветка не считается готовой, пока рунбук не описывает новую поверхность (задачи 4 и 11).
- Работа идёт в этом воркспейсе, где параллельно может идти чужая правка `docs/canon/**` (в начале работы в дереве были незакоммиченные правки канона). Перед задачей 1 проверить `git status --short docs/canon`: если там чужие незакоммиченные изменения — остановиться и согласовать порядок с владельцем, а не подмешивать свои правки в чужой коммит.

---

### Task 1: Канон под новую поверхность (canon-write)

**Files:**
- Modify (через `canon-write`, не редактором): `docs/canon/API_CONTRACTS.md`, `docs/canon/ADMIN_UI.md`, `docs/canon/ARCHITECTURE.md`, `docs/canon/GLOSSARY.md`, `docs/canon/OVERVIEW.md`
- Create (через `canon-future-plan`): `docs/canon/future_plans/p1-workspace-sessions-chat.md` + синхронизация `docs/canon/future_plans/INDEX.md`

**Interfaces:**
- Consumes: спек `docs/superpowers/specs/2026-09-11-workspace-sessions-panel-design.md`.
- Produces: зафиксированные в каноне формулировки ручки `sessions.list`, реестра `$DSH_HOME/workspace-sessions.json`, правой зоны с табами и терминов; задачa 4 и 11 ссылаются на эти формулировки, а не изобретают свои.

- [ ] **Step 1: Проверить, что чужой работы в каноне нет**

Run: `git status --short docs/canon`
Expected: пусто (или только файлы, которые правит эта задача). Непустой список чужих правок — СТОП и вопрос владельцу.

- [ ] **Step 2: Обновить канон скиллом `canon-write`** (не редактором)

Тема: «сессии воркспейса: реестр и витрина в админке». Внести:

`API_CONTRACTS.md` — в Scope добавить `sessions.list`, ниже — раздел:

```markdown
### sessions.list — сессии воркспейса
- method: POST
- path: /api/sessions/list
- auth: bearer
- request: `{scope: "home" | "project", name?: string}` (`name` обязателен для `project`, запрещён для `home`)
- response: `{sessions: [{id: string, title: string | null, channel: string, createdAt: string(ISO)}]}` (новейшие первыми)
- errors: 400 (битая форма тела/scope/лишний name), 401, 404 (проект не найден), 500 (реестр нечитаем/битый, отказ движка)
- notes: список — записи серверного реестра воркспейса (`$DSH_HOME/workspace-sessions.json`);
  заголовок и `createdAt` берутся из движка одним вызовом `sessionQuery.readTitleSnapshots`;
  `id`, неизвестный движку, из ответа выпадает; реестр чтением не переписывается.
```

`ADMIN_UI.md` — заменить «правая пустая зона (зарезервирована под будущее содержимое, шапки нет)» на: правая зона — контейнер табов (плашка сверху, табы описаны данными, сейчас один — «Сессии»; кнопка «Обновить» справа в плашке; без выбранного воркспейса — заглушка «Выберите воркспейс»); таб «Сессии» — строки «заголовок · канал · время», состояния «Загрузка…», «Сессий пока нет», ошибка с «Повторить»; клик по строке ничего не делает.

`ARCHITECTURE.md` — реестр сессий воркспейса: файл `$DSH_HOME/workspace-sessions.json` (600, атомарная запись, append-only, upsert по `sessionId`), владелец — плагин `dsh-balbes-sessions`, писатели — все, кто создаёт сессию для воркспейса (сейчас telegram, через сервис `balbesSessions`); домен `sessions.*`; движок — источник заголовков/времени (`sessionQuery`), реестр хранит только принадлежность.

`GLOSSARY.md` — термины: «реестр сессий воркспейса», «ключ воркспейса» (`home` / `project:<имя>`), «канал сессии» (кто создал: `telegram`).

`OVERVIEW.md` — если там перечисляется API-поверхность, добавить `sessions.list`.

- [ ] **Step 3: Завести future-plan скиллом `canon-future-plan`**

Направление «Сессии и чат в воркспейсе»: intent (владелец видит сессии воркспейса и работает с ними из правой панели), in scope (витрина сессий — этот шаг; просмотр диалога; создание сессии из админки; чат со стримингом), out of scope (каналы кроме telegram, права/роли), open questions (признак активной сессии, уборка записей реестра, живые события). Синхронизировать `future_plans/INDEX.md`.

- [ ] **Step 4: Проверить канон**

Run: `doc-canon validate`
Expected: exit 0, без ошибок схемы/структуры.

- [ ] **Step 5: Commit**

```bash
git add docs/canon
git commit -m "docs(canon): workspace session registry and the sessions tab in the projects page"
```

---

### Task 2: Пакет `dsh-balbes-sessions` и файловый реестр

**Files:**
- Create: `packages/plugins/dsh-balbes-sessions/package.json`
- Create: `packages/plugins/dsh-balbes-sessions/tsconfig.json`
- Create: `packages/plugins/dsh-balbes-sessions/tsconfig.build.json`
- Create: `packages/plugins/dsh-balbes-sessions/src/registry.ts`
- Test: `packages/plugins/dsh-balbes-sessions/tests/registry.test.ts`

**Interfaces:**
- Consumes: ничего из наших пакетов.
- Produces: `refKey(ref): string`, `registryFile(dshHome): string`, `WorkspaceRef`, `WorkspaceSessionEntry {sessionId, channel}`, `RegistryData {version: 1, workspaces}`, `assertRegistryShape(value, file): RegistryData`, `readRegistryFile(file): Promise<RegistryData>`, `class WorkspaceSessionsRegistry` c `list(ref)`, `register(ref, sessionId, channel)`, `static defaultFile(dshHome)`. Задачи 3 и 7 используют ровно эти имена.

- [ ] **Step 1: Создать манифест и конфиги пакета**

`packages/plugins/dsh-balbes-sessions/package.json`:

```json
{
  "name": "dsh-balbes-sessions",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/plugins/dsh-balbes-sessions/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests"]
}
```

`packages/plugins/dsh-balbes-sessions/tsconfig.build.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "lib",
    "rootDir": "src",
    "declarationDir": "lib/types"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Установить зависимости воркспейса** (нужно, чтобы vitest/typescript появились в новом пакете)

Run: `pnpm install`
Expected: пакет `dsh-balbes-sessions` появляется в воркспейсе, `node_modules` создан.

- [ ] **Step 3: Написать падающие тесты реестра**

`packages/plugins/dsh-balbes-sessions/tests/registry.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceSessionsRegistry,
  assertRegistryShape,
  refKey,
  registryFile
} from "../src/registry.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ws-sessions-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("refKey", () => {
  it("uses the telegram key format", () => {
    expect(refKey({ scope: "home" })).toBe("home");
    expect(refKey({ scope: "project", name: "alpha" })).toBe("project:alpha");
  });
});

describe("assertRegistryShape", () => {
  it("normalizes a valid document and drops unknown fields", () => {
    const data = assertRegistryShape(
      {
        version: 1,
        extra: "ignored",
        workspaces: {
          home: [{ sessionId: "s-1", channel: "telegram", note: "dropped" }]
        }
      },
      "file.json"
    );
    expect(data).toEqual({ version: 1, workspaces: { home: [{ sessionId: "s-1", channel: "telegram" }] } });
  });

  it("deduplicates repeated session ids, keeping the first", () => {
    const data = assertRegistryShape(
      {
        version: 1,
        workspaces: {
          "project:a": [
            { sessionId: "s-1", channel: "telegram" },
            { sessionId: "s-1", channel: "admin" }
          ]
        }
      },
      "file.json"
    );
    expect(data.workspaces["project:a"]).toEqual([{ sessionId: "s-1", channel: "telegram" }]);
  });

  it("rejects damage and foreign documents, naming the file", () => {
    expect(() => assertRegistryShape({ version: 2, workspaces: {} }, "file.json")).toThrow(/file\.json/);
    expect(() => assertRegistryShape({ version: 1 }, "file.json")).toThrow(/workspaces/);
    expect(() => assertRegistryShape({ version: 1, workspaces: { home: {} } }, "file.json")).toThrow(/non-array/);
    expect(() => assertRegistryShape({ version: 1, workspaces: { home: [{ sessionId: "", channel: "telegram" }] } }, "file.json")).toThrow(/session id/);
    expect(() => assertRegistryShape({ version: 1, workspaces: { home: [{ sessionId: "s", channel: "Telegram!" }] } }, "file.json")).toThrow(/channel/);
  });
});

describe("WorkspaceSessionsRegistry", () => {
  it("reads a missing file as empty and an unreadable one as an error", async () => {
    const file = join(dir, "workspace-sessions.json");
    const registry = new WorkspaceSessionsRegistry(file);
    expect(await registry.list({ scope: "home" })).toEqual([]);

    await writeFile(file, "{not json", "utf8");
    const broken = new WorkspaceSessionsRegistry(file);
    await expect(broken.list({ scope: "home" })).rejects.toThrow(/not valid JSON/);
  });

  it("does not cache a failed load as empty", async () => {
    const file = join(dir, "workspace-sessions.json");
    await writeFile(file, "{not json", "utf8");
    const registry = new WorkspaceSessionsRegistry(file);
    await expect(registry.list({ scope: "home" })).rejects.toThrow();

    await writeFile(
      file,
      JSON.stringify({ version: 1, workspaces: { home: [{ sessionId: "s-1", channel: "telegram" }] } }),
      "utf8"
    );
    expect(await registry.list({ scope: "home" })).toEqual([{ sessionId: "s-1", channel: "telegram" }]);
  });

  it("registers idempotently, writes 600, and separates workspaces", async () => {
    const file = join(dir, "workspace-sessions.json");
    const registry = new WorkspaceSessionsRegistry(file);
    await registry.register({ scope: "project", name: "alpha" }, "s-1", "telegram");
    await registry.register({ scope: "project", name: "alpha" }, "s-1", "telegram");
    await registry.register({ scope: "project", name: "alpha" }, "s-2", "telegram");
    await registry.register({ scope: "home" }, "s-home", "telegram");

    expect(await registry.list({ scope: "project", name: "alpha" })).toEqual([
      { sessionId: "s-1", channel: "telegram" },
      { sessionId: "s-2", channel: "telegram" }
    ]);
    expect(await registry.list({ scope: "home" })).toEqual([{ sessionId: "s-home", channel: "telegram" }]);

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { version: number };
    expect(onDisk.version).toBe(1);
  });

  it("refuses an invalid channel instead of writing it", async () => {
    const file = join(dir, "workspace-sessions.json");
    const registry = new WorkspaceSessionsRegistry(file);
    await expect(registry.register({ scope: "home" }, "s-1", "Bad Channel")).rejects.toThrow(/channel/);
    expect(await registry.list({ scope: "home" })).toEqual([]);
  });
});
```

- [ ] **Step 4: Запустить тесты — убедиться, что падают**

Run: `cd packages/plugins/dsh-balbes-sessions && pnpm vitest run tests/registry.test.ts`
Expected: FAIL — `Failed to resolve import "../src/registry.js"`.

- [ ] **Step 5: Реализовать `src/registry.ts`**

```ts
import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Одна ссылка на воркспейс: дом агента или проект. */
export type WorkspaceRef = { scope: "home" } | { scope: "project"; name: string };

/** Одна запись реестра: сессия и канал, который её создал. */
export interface WorkspaceSessionEntry {
  sessionId: string;
  channel: string;
}

/** Документ реестра целиком. */
export interface RegistryData {
  version: 1;
  workspaces: Record<string, WorkspaceSessionEntry[]>;
}

/** Каналы — короткие слаг-имена: "telegram" сейчас, "admin"/"web" позже. */
const CHANNEL_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Ключ воркспейса — тот же формат, что использует telegram (`home`/`project:<имя>`). */
export function refKey(ref: WorkspaceRef): string {
  return ref.scope === "home" ? "home" : `project:${ref.name}`;
}

/** `$DSH_HOME/workspace-sessions.json`. */
export function registryFile(dshHome: string): string {
  return join(dshHome, "workspace-sessions.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Проверка формы и нормализация: документ читается только по известным полям,
 * неизвестные отбрасываются, повторные sessionId внутри воркспейса — первое
 * вхождение. Повреждённый или чужой файл — ошибка с именем файла: молчаливый
 * сброс потерял бы принадлежность сессий.
 */
export function assertRegistryShape(value: unknown, file: string): RegistryData {
  const invalid = (why: string): Error => new Error(`workspace sessions registry ${file} ${why}`);
  if (!isPlainObject(value)) throw invalid("is not a JSON object");
  if (value.version !== 1) throw invalid("has an unsupported version");
  if (!isPlainObject(value.workspaces)) throw invalid("misses the workspaces map");
  const workspaces: Record<string, WorkspaceSessionEntry[]> = {};
  for (const [key, rawEntries] of Object.entries(value.workspaces)) {
    if (key === "") throw invalid("has an empty workspace key");
    if (!Array.isArray(rawEntries)) throw invalid(`has a non-array entry list for key ${key}`);
    const entries: WorkspaceSessionEntry[] = [];
    const seen = new Set<string>();
    for (const raw of rawEntries) {
      if (!isPlainObject(raw)) throw invalid(`has a non-object entry for key ${key}`);
      const sessionId = raw.sessionId;
      const channel = raw.channel;
      if (typeof sessionId !== "string" || sessionId === "") throw invalid(`has an invalid session id for key ${key}`);
      if (typeof channel !== "string" || !CHANNEL_RE.test(channel)) {
        throw invalid(`has an invalid channel for key ${key}`);
      }
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      entries.push({ sessionId, channel });
    }
    workspaces[key] = entries;
  }
  return { version: 1, workspaces };
}

/** Одна запись при записи: та же проверка, что и при чтении. */
function assertEntry(sessionId: string, channel: string, file: string): WorkspaceSessionEntry {
  const data = assertRegistryShape(
    { version: 1, workspaces: { entry: [{ sessionId, channel }] } },
    file
  );
  const entry = data.workspaces.entry?.[0];
  if (entry === undefined) throw new Error(`workspace sessions registry ${file} rejected an entry`);
  return entry;
}

/** Чтение файла: отсутствие — пустой документ, повреждение — ошибка. */
export async function readRegistryFile(file: string): Promise<RegistryData> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    // ENOENT — единственный код, означающий «ещё ничего не писали»; EACCES и
    // EISDIR обязаны всплыть, а не обнулить реестр.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: {} };
    throw new Error(
      `workspace sessions registry ${file} unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`workspace sessions registry ${file} is not valid JSON`);
  }
  return assertRegistryShape(parsed, file);
}

/**
 * Атомарное хранилище реестра: один экземпляр владеет одним файлом, запись
 * сериализуется внутри экземпляра, каждый записанный документ проходит
 * проверку формы ДО записи. Неудачная загрузка не кэшируется: следующий вызов
 * перечитает файл.
 */
export class WorkspaceSessionsRegistry {
  private state: RegistryData | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  static defaultFile(dshHome: string): string {
    return registryFile(dshHome);
  }

  /** Записи воркспейса в порядке добавления (копии, не ссылки на состояние). */
  async list(ref: WorkspaceRef): Promise<WorkspaceSessionEntry[]> {
    const state = await this.load();
    return (state.workspaces[refKey(ref)] ?? []).map((entry) => ({ ...entry }));
  }

  /** Добавить сессию в воркспейс; повторный вызов с тем же id ничего не меняет. */
  async register(ref: WorkspaceRef, sessionId: string, channel: string): Promise<void> {
    const entry = assertEntry(sessionId, channel, this.file);
    const run = this.queue.then(() => this.registerLocked(ref, entry));
    // последовательность не должна ломаться отвергнутой записью
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async registerLocked(ref: WorkspaceRef, entry: WorkspaceSessionEntry): Promise<void> {
    const state = await this.load();
    const key = refKey(ref);
    const entries = state.workspaces[key] ?? [];
    if (entries.some((existing) => existing.sessionId === entry.sessionId)) return;
    const next: RegistryData = {
      version: 1,
      workspaces: { ...state.workspaces, [key]: [...entries, entry] }
    };
    await this.save(next);
    this.state = next;
  }

  private async load(): Promise<RegistryData> {
    if (this.state !== null) return this.state;
    const state = await readRegistryFile(this.file);
    this.state = state;
    return state;
  }

  private async save(next: RegistryData): Promise<void> {
    const data = assertRegistryShape(next, this.file);
    // Уникальный tmp на запись: немьютексеченные цепочки writeFile -> chmod ->
    // rename не должны делить один tmp-путь.
    const tmp = `${this.file}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
}
```

- [ ] **Step 6: Запустить тесты — убедиться, что проходят**

Run: `cd packages/plugins/dsh-balbes-sessions && pnpm vitest run tests/registry.test.ts`
Expected: PASS (все кейсы), включая `mode 0o600` и «does not cache a failed load as empty».

- [ ] **Step 7: Проверить типы**

Run: `cd packages/plugins/dsh-balbes-sessions && pnpm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/dsh-balbes-sessions pnpm-lock.yaml
git commit -m "feat(sessions): workspace session registry plugin with an atomic file store"
```

---

### Task 3: Сервис `balbesSessions` и ручка `sessions.list`

**Files:**
- Create: `packages/plugins/dsh-balbes-sessions/src/service.ts`
- Create: `packages/plugins/dsh-balbes-sessions/src/index.ts`
- Test: `packages/plugins/dsh-balbes-sessions/tests/index.test.ts`

**Interfaces:**
- Consumes: из задачи 2 — `WorkspaceSessionsRegistry`, `registryFile`, `refKey`, `WorkspaceRef`, `WorkspaceSessionEntry`.
- Produces: плагин `name = "balbes-sessions"`, `inject = ["balbesHttp", "balbesWorkspaces", "sessionQuery"]`, `Config`, `apply(ctx, config)`; сервис `BalbesSessionsService {register(ref, sessionId, channel), list(ref)}` под именем `balbesSessions`; ручка `POST /api/sessions/list`. Задача 7 вызывает `register(ref, sessionId, "telegram")` через `ctx.get("balbesSessions")`.

- [ ] **Step 1: Написать падающие тесты ручки**

`packages/plugins/dsh-balbes-sessions/tests/index.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, inject } from "../src/index.js";

interface Seat {
  path: string;
  auth: string;
  handler(req: unknown, res: unknown, body: unknown): Promise<void> | void;
}

interface ResLike {
  writeHead(status: number): void;
  end(body?: string): void;
}

/** Ответ ручки в память: статус + распарсенный JSON (как в telegram-тестах). */
function makeRes(): { res: ResLike; read(): { status: number; json: unknown; raw: string } } {
  const box = { status: 0, raw: "" };
  return {
    res: {
      writeHead(status: number) {
        box.status = status;
      },
      end(body?: string) {
        box.raw = String(body ?? "");
      }
    },
    read: () => ({ status: box.status, raw: box.raw, json: JSON.parse(box.raw) as unknown })
  };
}

const PROJECTS = [{ name: "alpha", path: "/h/projects/alpha" }];

interface HarnessOptions {
  projects?: unknown;
  observations?: unknown[];
  queryThrows?: boolean;
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sessions-plugin-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function harness(options: HarnessOptions = {}): {
  seats: Seat[];
  provided: Map<string, unknown>;
  call(path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }>;
} {
  const seats: Seat[] = [];
  const provided = new Map<string, unknown>();
  const ctx = {
    get(key: string): unknown {
      if (key === "balbesHttp") {
        return {
          post(path: string, auth: string, handler: Seat["handler"]) {
            seats.push({ path, auth, handler });
          }
        };
      }
      if (key === "balbesWorkspaces") {
        return {
          list: async () => ({ home: { path: join(home, "agent") }, projects: options.projects ?? PROJECTS })
        };
      }
      if (key === "sessionQuery") {
        return {
          readTitleSnapshots: async (ids: readonly string[]) => {
            if (options.queryThrows === true) throw new Error("persistence listing failed");
            const all = (options.observations ?? []) as Array<{ sessionId: string; status: string; value?: unknown }>;
            return all.filter((o) => ids.includes(o.sessionId));
          }
        };
      }
      return undefined;
    },
    provide(key: string, value: unknown): void {
      provided.set(key, value);
    },
    logger: { warn(_m: string): void {} }
  };
  apply(ctx, { dshHome: home });
  return {
    seats,
    provided,
    async call(path, body) {
      const seat = seats.find((s) => s.path === path);
      if (seat === undefined) throw new Error(`no seat for ${path}`);
      const { res, read } = makeRes();
      await seat.handler({}, res, body);
      return read();
    }
  };
}

describe("balbes-sessions plugin", () => {
  it("exposes name/inject/apply contract", () => {
    expect(name).toBe("balbes-sessions");
    expect(inject).toEqual(["balbesHttp", "balbesWorkspaces", "sessionQuery"]);
  });

  it("registers one bearer route and provides balbesSessions", () => {
    const h = harness();
    expect(h.seats.map((s) => [s.path, s.auth])).toEqual([["/api/sessions/list", "bearer"]]);
    const service = h.provided.get("balbesSessions") as { register?: unknown; list?: unknown };
    expect(typeof service.register).toBe("function");
    expect(typeof service.list).toBe("function");
  });

  it("rejects a malformed body with 400 bad-request", async () => {
    const h = harness();
    expect((await h.call("/api/sessions/list", [])).status).toBe(400);
    expect((await h.call("/api/sessions/list", { scope: "galaxy" })).status).toBe(400);
    expect((await h.call("/api/sessions/list", { scope: "project" })).status).toBe(400);
    const home = await h.call("/api/sessions/list", { scope: "home", name: "alpha" });
    expect(home.status).toBe(400);
    expect((home.json as { error?: { code?: string } }).error?.code).toBe("bad-request");
  });

  it("returns 404 for an unknown project", async () => {
    const h = harness();
    const res = await h.call("/api/sessions/list", { scope: "project", name: "nope" });
    expect(res.status).toBe(404);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe("not-found");
  });

  it("returns an empty list for a workspace with no registry entries", async () => {
    const h = harness();
    const res = await h.call("/api/sessions/list", { scope: "project", name: "alpha" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ sessions: [] });
  });

  it("maps titles and creation times, drops unknown ids and sorts newest first", async () => {
    const h = harness({
      observations: [
        {
          sessionId: "s-old",
          status: "fulfilled",
          value: { session: { createdAt: 1_700_000_000_000 }, title: { title: "старая задача" } }
        },
        {
          sessionId: "s-new",
          status: "fulfilled",
          value: { session: { createdAt: 1_700_000_100_000 } }
        },
        { sessionId: "s-gone", status: "rejected", reason: new Error("no such session") }
      ]
    });
    const service = h.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await service.register({ scope: "project", name: "alpha" }, "s-old", "telegram");
    await service.register({ scope: "project", name: "alpha" }, "s-new", "telegram");
    await service.register({ scope: "project", name: "alpha" }, "s-gone", "telegram");

    const res = await h.call("/api/sessions/list", { scope: "project", name: "alpha" });
    expect(res.status, res.raw).toBe(200);
    expect(res.json).toEqual({
      sessions: [
        { id: "s-new", title: null, channel: "telegram", createdAt: new Date(1_700_000_100_000).toISOString() },
        { id: "s-old", title: "старая задача", channel: "telegram", createdAt: new Date(1_700_000_000_000).toISOString() }
      ]
    });
  });

  it("serves the home workspace and reports engine failure as 500", async () => {
    const ok = harness();
    const okService = ok.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await okService.register({ scope: "home" }, "s-home", "telegram");
    expect((await ok.call("/api/sessions/list", { scope: "home" })).json).toEqual({ sessions: [] });

    const broken = harness({ queryThrows: true });
    const brokenService = broken.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await brokenService.register({ scope: "home" }, "s-home", "telegram");
    const res = await broken.call("/api/sessions/list", { scope: "home" });
    expect(res.status).toBe(500);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe("internal");
  });

  it("reports a damaged registry file as 500 instead of an empty list", async () => {
    const h = harness();
    await writeFile(join(home, "workspace-sessions.json"), "{not json", "utf8");
    const res = await h.call("/api/sessions/list", { scope: "home" });
    expect(res.status).toBe(500);
    expect((res.json as { error?: { message?: string } }).error?.message).toMatch(/not valid JSON/);
  });

  it("writes the registry to $DSH_HOME with 600", async () => {
    const h = harness();
    const service = h.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await service.register({ scope: "project", name: "alpha" }, "s-1", "telegram");
    const raw = await readFile(join(home, "workspace-sessions.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      workspaces: { "project:alpha": [{ sessionId: "s-1", channel: "telegram" }] }
    });
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `cd packages/plugins/dsh-balbes-sessions && pnpm vitest run tests/index.test.ts`
Expected: FAIL — `Failed to resolve import "../src/index.js"`.

- [ ] **Step 3: Реализовать `src/service.ts`**

```ts
import { WorkspaceSessionsRegistry, type WorkspaceRef, type WorkspaceSessionEntry } from "./registry.js";

/**
 * Фасад домена для других плагинов: единственный способ записи в реестр.
 * Предоставляется как "balbesSessions".
 */
export interface BalbesSessionsService {
  register(ref: WorkspaceRef, sessionId: string, channel: string): Promise<void>;
  list(ref: WorkspaceRef): Promise<WorkspaceSessionEntry[]>;
}

export function createSessionsService(registry: WorkspaceSessionsRegistry): BalbesSessionsService {
  return {
    register: (ref, sessionId, channel) => registry.register(ref, sessionId, channel),
    list: (ref) => registry.list(ref)
  };
}
```

- [ ] **Step 4: Реализовать `src/index.ts`**

```ts
import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { WorkspaceSessionsRegistry, type WorkspaceRef } from "./registry.js";
import { createSessionsService, type BalbesSessionsService } from "./service.js";

export const name = "balbes-sessions";
export const inject = ["balbesHttp", "balbesWorkspaces", "sessionQuery"];
export const Config = z.object({ dshHome: z.string() });

interface HttpSeatLike {
  post(path: string, auth: "public" | "bearer", handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void): void;
}

interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** Структурный срез сервиса воркспейсов (как в telegram: без импорта чужого плагина). */
interface WorkspacesSlice {
  list(): Promise<{ home: { path: string }; projects: Array<{ name: string; path: string }> }>;
}

/** Структурный срез движка сессий: только точное чтение заголовков. */
interface SessionQuerySlice {
  readTitleSnapshots(ids: readonly string[]): Promise<TitleObservation[]>;
}

type TitleObservation =
  | {
      sessionId: string;
      status: "fulfilled";
      value: { session: { createdAt: number }; title?: { title: string } };
    }
  | { sessionId: string; status: "rejected"; reason: unknown };

interface SessionRow {
  id: string;
  title: string | null;
  channel: string;
  createdAt: string;
}

function send(res: ResLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload))
  });
  res.end(payload);
}

/** Разбор тела `sessions.list`: отказ называет, что именно не так. */
function parseListRequest(body: unknown): { ok: true; ref: WorkspaceRef } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }
  const b = body as { scope?: unknown; name?: unknown };
  if (b.scope === "home") {
    if (b.name !== undefined) return { ok: false, message: "name is not allowed for the home workspace" };
    return { ok: true, ref: { scope: "home" } };
  }
  if (b.scope === "project") {
    if (typeof b.name !== "string" || b.name === "") {
      return { ok: false, message: "name is required for a project workspace" };
    }
    return { ok: true, ref: { scope: "project", name: b.name } };
  }
  return { ok: false, message: 'scope must be "home" or "project"' };
}

export function apply(ctx: {
  get(key: string): unknown;
  provide(key: string, value: unknown): void;
  logger: { warn(m: string): void };
}, config: { dshHome?: string }): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-sessions: balbesHttp service missing; routes not registered");
    return;
  }
  const workspaces = ctx.get("balbesWorkspaces") as WorkspacesSlice | undefined;
  const query = ctx.get("sessionQuery") as SessionQuerySlice | undefined;
  if (workspaces === undefined || query === undefined) {
    ctx.logger.warn("balbes-sessions: balbesWorkspaces/sessionQuery missing; routes not registered");
    return;
  }
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const store = new WorkspaceSessionsRegistry(WorkspaceSessionsRegistry.defaultFile(dshHome));
  const service: BalbesSessionsService = createSessionsService(store);
  ctx.provide("balbesSessions", service);

  http.post("/api/sessions/list", "bearer", async (_req, res, body) => {
    const parsed = parseListRequest(body);
    if (!parsed.ok) {
      send(res, 400, { error: { code: "bad-request", message: parsed.message } });
      return;
    }
    const ref = parsed.ref;
    try {
      // Опечатка в имени проекта должна давать 404, а не «пустой список».
      const { projects } = await workspaces.list();
      if (ref.scope === "project" && !projects.some((project) => project.name === ref.name)) {
        send(res, 404, { error: { code: "not-found", message: `project not found: ${ref.name}` } });
        return;
      }
      const entries = await service.list(ref);
      const observations = await query.readTitleSnapshots(entries.map((entry) => entry.sessionId));
      const channels = new Map(entries.map((entry) => [entry.sessionId, entry.channel]));
      const sessions: SessionRow[] = observations
        .filter((observation): observation is Extract<TitleObservation, { status: "fulfilled" }> =>
          observation.status === "fulfilled"
        )
        .map((observation) => ({
          id: observation.sessionId,
          title: observation.value.title?.title ?? null,
          channel: channels.get(observation.sessionId) ?? "unknown",
          createdAt: new Date(observation.value.session.createdAt).toISOString()
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      send(res, 200, { sessions });
    } catch (error) {
      send(res, 500, {
        error: { code: "internal", message: error instanceof Error ? error.message : String(error) }
      });
    }
  });
}

- [ ] **Step 5: Запустить тесты — убедиться, что проходят**

Run: `cd packages/plugins/dsh-balbes-sessions && pnpm vitest run tests/index.test.ts`
Expected: PASS (9 кейсов).

- [ ] **Step 6: Полный прогон пакета и типы**

Run: `cd packages/plugins/dsh-balbes-sessions && pnpm run typecheck && pnpm test`
Expected: exit 0, все тесты зелёные.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/dsh-balbes-sessions
git commit -m "feat(sessions): sessions.list route and the balbesSessions service"
```

---

### Task 4: Композиция профиля, установщик, CI

**Files:**
- Modify: `profiles/balbes/cordis.patch.yml`
- Modify: `scripts/install.sh` (шапка-комментарий, `copy_sessions_into_profile`, вызов в `main`, строка в `print_admin_summary`)
- Modify: `.github/workflows/ci.yml` (шаг «Sync balbes profile + host bundle into DSH_HOME»)

**Interfaces:**
- Consumes: пакет из задач 2–3 (`dsh-balbes-sessions`, main `./lib/index.js`).
- Produces: профиль `balbes`, поднимающий `balbes-sessions`; установщик, копирующий пакет в `node_modules` профиля. Задача 7 (telegram `inject: balbesSessions`) и задача 11 (рунбук) опираются на эту композицию.

- [ ] **Step 1: Вставить плагин в профиль**

`profiles/balbes/cordis.patch.yml` — строку `balbes-sessions` поставить **до** `balbes-telegram` (telegram инжектит его сервис):

```yaml
- insert:
    - id: balbes-workspaces
      name: 'dsh-balbes-workspaces'

    - id: balbes-models
      name: 'dsh-balbes-models'

    - id: balbes-sessions
      name: 'dsh-balbes-sessions'

    - id: balbes-telegram
      name: 'dsh-balbes-telegram'
```

- [ ] **Step 2: Добавить блок копирования в `scripts/install.sh`**

После `copy_telegram_into_profile` (перед `deploy_ui`):

```bash
# copy_sessions_into_profile — зеркало copy_telegram_into_profile: собранный
# плагин сессий воркспейса копируется реальным каталогом в node_modules профиля.
copy_sessions_into_profile() {
    local profile_dir="$DSH_HOME/profiles/$PROFILE_NAME"
    local src="$REPO_DIR/packages/plugins/dsh-balbes-sessions"
    local dst="$profile_dir/node_modules/dsh-balbes-sessions"
    if [[ ! -d "$src/lib" ]]; then
        die "sessions plugin not built at $src/lib — build step failed"
    fi
    mkdir -p "$profile_dir/node_modules"
    rm -rf "$dst"
    cp -R "$src" "$dst"
    rm -f "$dst/tsconfig.json" "$dst/tsconfig.build.json"
    rm -rf "$dst/tests" "$dst/src" "$dst/lib/types"
    chmod -R u+rwX,go-w "$dst"
    info "Sessions plugin copied into $dst"
}
```

В `main()` — после `copy_telegram_into_profile`:

```bash
    copy_models_into_profile
    copy_telegram_into_profile
    copy_sessions_into_profile
    deploy_ui
```

В шапке файла (перечень сборки, строки 12–13) и в `build_workspace` info-строке добавить `sessions` к списку пакетов; в `print_admin_summary` — строку про плагин сессий рядом с остальными.

- [ ] **Step 3: Добавить копирование в CI**

В `.github/workflows/ci.yml`, шаг «Sync balbes profile + host bundle into DSH_HOME», после блока `dsh-balbes-telegram`:

```yaml
          cp -R packages/plugins/dsh-balbes-sessions "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-sessions"
          rm -f "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-sessions/tsconfig.json" \
                "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-sessions/tsconfig.build.json"
          rm -rf "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-sessions/tests" \
                 "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-sessions/src" \
                 "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-sessions/lib/types"
```

- [ ] **Step 4: Проверить синтаксис, манифест и композицию**

Run:
```bash
bash -n scripts/install.sh
node -e "JSON.parse(require('fs').readFileSync('profiles/balbes/package.json','utf8'))"
grep -n "balbes-sessions" profiles/balbes/cordis.patch.yml scripts/install.sh .github/workflows/ci.yml
```
Expected: `bash -n` без вывода; JSON парсится; grep находит вставку в профиль, вызов копирования и блок CI.

Если `dsh` есть в PATH и профиль `balbes` установлен локально — дополнительно:
Run: `dsh --profile balbes --dump-config | grep -c "balbes-sessions"`
Expected: `1` (или больше). Если профиля локально нет — проверку композиции даёт REAL-тест задачи 5 и CI-шаг «Validate profile composition».

- [ ] **Step 5: Commit**

```bash
git add profiles/balbes/cordis.patch.yml scripts/install.sh .github/workflows/ci.yml
git commit -m "chore(deploy): compose and install the balbes-sessions plugin"
```

---

### Task 5: REAL-композиция плагина (без LLM)

**Files:**
- Create: `packages/plugins/dsh-balbes-sessions/tests/fixtures/balbes-sessions-profile/package.json`
- Create: `packages/plugins/dsh-balbes-sessions/tests/fixtures/balbes-sessions-profile/cordis.patch.yml`
- Test: `packages/plugins/dsh-balbes-sessions/tests/integration.test.ts`

**Interfaces:**
- Consumes: собранные `lib` пакетов (host-бандл, `dsh-balbes-workspaces`, `dsh-balbes-sessions`), `createAdminAuth`/`writeAdminAuth` из host-бандла.
- Produces: профиль-фикстура `balbes-sessions-profile` и REAL-сценарий, который расширяет задача 6 (тот же файл, тот же хелпер `prepareHome`, `bootServer`).

- [ ] **Step 1: Создать фикстуру профиля**

`packages/plugins/dsh-balbes-sessions/tests/fixtures/balbes-sessions-profile/package.json`:

```json
{
  "name": "dsh-profile-balbes-sessions-test",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-balbes-host"],
      "patchReload": "startup"
    }
  }
}
```

`packages/plugins/dsh-balbes-sessions/tests/fixtures/balbes-sessions-profile/cordis.patch.yml`:

```yaml
# Тестовая композиция: dsh-base + host-бандл (из package.json) + воркспейсы
# (нужны и для /api/workspaces/create, и как зависимость balbes-sessions).
- insert:
    - id: balbes-workspaces
      name: 'dsh-balbes-workspaces'
    - id: balbes-sessions
      name: 'dsh-balbes-sessions'
```

- [ ] **Step 2: Написать падающий REAL-тест**

`packages/plugins/dsh-balbes-sessions/tests/integration.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

/**
 * REAL-композиция домена сессий: настоящий профиль dsh (dsh-base + host-бандл
 * + balbes-workspaces + balbes-sessions), поднятый настоящим CLI. Проверяются
 * реальные ручки, реальный реестр на диске и реальные коды ошибок; движок
 * сессий — настоящий (в этом сценарии в нём просто нет сессий, поэтому годные
 * записи реестра отсеиваются, а повреждённый реестр даёт 500).
 *
 * Гейт: RUN_REAL=1 и `dsh` в PATH (как у соседних REAL-наборов).
 */

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const workspacesPkgRoot = join(pkgRoot, "..", "dsh-balbes-workspaces");
const fixtureProfile = join(here, "fixtures", "balbes-sessions-profile");
const PROFILE = "balbes-sessions-test";

async function hasDsh(): Promise<boolean> {
  try {
    await execFileP("dsh", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function buildPackages(): Promise<void> {
  const configs: Array<[string, string]> = [
    [pkgRoot, "tsconfig.build.json"],
    [workspacesPkgRoot, "tsconfig.build.json"],
    [hostPkgRoot, "tsconfig.json"]
  ];
  for (const [root, cfg] of configs) {
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    await execFileP(process.execPath, [tsc, "-p", join(root, cfg)], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024
    });
  }
}

async function postJson(url: string, body: unknown, token?: string): Promise<{ status: number; json: unknown; raw: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    body: JSON.stringify(body)
  });
  const raw = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw;
  }
  return { status: response.status, json, raw };
}

async function waitForHealth(port: number, child: ReturnType<typeof spawn>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh exited early (code ${child.exitCode}) before serving health`);
    try {
      const { status, json } = await postJson(`http://127.0.0.1:${port}/api/health`, {});
      if (status === 200 && (json as { ok?: boolean }).ok === true) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

const realEnabled = (process.env.RUN_REAL ?? "").trim() !== "" ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (sessions API)", () => {
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;

  /** Один деплоябельный тестовый дом: фикстура профиля + собранные пакеты в node_modules. */
  async function prepareHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "balbes-sessions-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, PROFILE), { recursive: true });
    const nm = join(profiles, PROFILE, "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    for (const [pkg, dirName] of [
      [workspacesPkgRoot, "dsh-balbes-workspaces"],
      [pkgRoot, "dsh-balbes-sessions"]
    ] as Array<[string, string]>) {
      await cp(join(pkg, "lib"), join(nm, dirName, "lib"), { recursive: true });
      await cp(join(pkg, "package.json"), join(nm, dirName, "package.json"));
    }
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(home, creds);
    return home;
  }

  async function bootServer(home: string): Promise<string> {
    child = spawn("dsh", ["--profile", PROFILE], {
      env: { ...process.env, DSH_HOME: home, BALBES_PORT: String(port), DSH_TELEMETRY_DISABLED: "1" },
      cwd: home,
      stdio: "ignore"
    });
    await waitForHealth(port, child);
    const loginRes = await postJson(`http://127.0.0.1:${port}/api/auth/login`, { login, password });
    expect(loginRes.status, loginRes.raw).toBe(200);
    return (loginRes.json as { token: string }).token;
  }

  async function stopServer(): Promise<void> {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child?.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      ]);
    }
    child = null;
  }

  beforeAll(async () => {
    await buildPackages();
    port = await freePort();
  }, 240_000);

  afterAll(async () => {
    await stopServer();
  }, 60_000);

  it("composes balbes-sessions", async () => {
    const home = await prepareHome();
    try {
      const { stdout } = await execFileP("dsh", ["--profile", PROFILE, "--dump-config"], {
        env: { ...process.env, DSH_HOME: home },
        maxBuffer: 16 * 1024 * 1024
      });
      expect(stdout).toContain("balbes-sessions");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);

  it("sessions API: auth, codes, registry on disk", async () => {
    const home = await prepareHome();
    try {
      const base = `http://127.0.0.1:${port}`;
      const token = await bootServer(home);

      // 401 без токена
      const anon = await postJson(`${base}/api/sessions/list`, { scope: "home" });
      expect(anon.status).toBe(401);

      // 400: битая форма, неизвестный scope, name у дома
      expect((await postJson(`${base}/api/sessions/list`, [], token)).status).toBe(400);
      expect((await postJson(`${base}/api/sessions/list`, { scope: "galaxy" }, token)).status).toBe(400);
      expect((await postJson(`${base}/api/sessions/list`, { scope: "project" }, token)).status).toBe(400);
      expect((await postJson(`${base}/api/sessions/list`, { scope: "home", name: "alpha" }, token)).status).toBe(400);

      // 404: проект не существует
      const missing = await postJson(`${base}/api/sessions/list`, { scope: "project", name: "nope" }, token);
      expect(missing.status).toBe(404);
      expect((missing.json as { error?: { code?: string } }).error?.code).toBe("not-found");

      // проект создаётся реальной ручкой, список сессий пуст (реестра ещё нет)
      const created = await postJson(`${base}/api/workspaces/create`, { name: "alpha" }, token);
      expect(created.status, created.raw).toBe(200);
      const empty = await postJson(`${base}/api/sessions/list`, { scope: "project", name: "alpha" }, token);
      expect(empty.status, empty.raw).toBe(200);
      expect(empty.json).toEqual({ sessions: [] });

      // реестр с неизвестной движку сессией: запись отсеивается
      await writeFile(
        join(home, "workspace-sessions.json"),
        JSON.stringify({ version: 1, workspaces: { "project:alpha": [{ sessionId: "session-ghost", channel: "telegram" }] } }),
        "utf8"
      );
      const ghost = await postJson(`${base}/api/sessions/list`, { scope: "project", name: "alpha" }, token);
      expect(ghost.status, ghost.raw).toBe(200);
      expect(ghost.json).toEqual({ sessions: [] });

      // повреждённый реестр — 500, а не «пусто»
      await writeFile(join(home, "workspace-sessions.json"), "{not json", "utf8");
      const broken = await postJson(`${base}/api/sessions/list`, { scope: "project", name: "alpha" }, token);
      expect(broken.status).toBe(500);
      expect((broken.json as { error?: { message?: string } }).error?.message).toMatch(/not valid JSON/);
    } finally {
      await stopServer();
      await rm(home, { recursive: true, force: true });
    }
  }, 240_000);
});
```

- [ ] **Step 3: Запустить REAL-тест**

Run: `cd packages/plugins/dsh-balbes-sessions && RUN_REAL=1 pnpm vitest run tests/integration.test.ts`
Expected: PASS оба `it`. Без `RUN_REAL=1` набор скипается (проверить: `pnpm vitest run tests/integration.test.ts` → skipped).

Если `dsh` в PATH отсутствует — тест скипается, и это ожидаемо; тогда REAL-проверку даёт CI-job `real` (после того как задача 5 добавит шаг в workflow — см. Step 4).

- [ ] **Step 4: Добавить REAL-набор в CI**

В `.github/workflows/ci.yml`, job `real`, после шага REAL-набора telegram:

```yaml
      - name: REAL suites — workspace sessions (registry + sessions.list)
        working-directory: packages/plugins/dsh-balbes-sessions
        env:
          RUN_REAL: "1"
        run: bash node_modules/.bin/vitest run tests/integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/dsh-balbes-sessions/tests .github/workflows/ci.yml
git commit -m "test(sessions): REAL composition suite for the sessions API"
```

---

### Task 6: REAL-сценарий с настоящей сессией и заголовком

**Files:**
- Create: `packages/plugins/dsh-balbes-sessions/tests/helpers/stub-llm.mjs`
- Modify: `packages/plugins/dsh-balbes-sessions/tests/integration.test.ts`

**Interfaces:**
- Consumes: из задачи 5 — `prepareHome`, `bootServer`, `stopServer`, `postJson`, `waitForHealth`.
- Produces: доказательство, что заголовок и `createdAt` приходят из настоящего движка (а не из реестра).

- [ ] **Step 1: Скопировать LLM-стаб**

Run:
```bash
cp packages/plugins/dsh-balbes-telegram/tests/helpers/stub-llm.mjs \
   packages/plugins/dsh-balbes-sessions/tests/helpers/stub-llm.mjs
```
Expected: файл создан. Первая строка-комментарий в нём ссылается на `packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs` — оставить как есть (это то же самое «verbatim copy» соглашение).

- [ ] **Step 2: Написать падающий тест с настоящей сессией**

Добавить в `tests/integration.test.ts` в `describe` третий `it` и хелперы:

```ts
import { readdir, stat as statFile } from "node:fs/promises";
```

В начале `it` — стаб LLM (экспорт `startStubLlm`, как в telegram REAL; модуль без деклараций, поэтому импорт через вычисленный URL):

```ts
    const stubUrl = new URL("./helpers/stub-llm.mjs", import.meta.url).href;
    const { startStubLlm } = (await import(stubUrl)) as {
      startStubLlm(options?: { text?: string }): Promise<{ port: number; close(): Promise<void> }>;
    };
    const stub = await startStubLlm({ text: "ok from stub" });
```

```ts
  /**
   * Настоящая сессия в рабочем каталоге проекта: /api/prompt создаёт свежую
   * сессию с cwd = process.cwd() сервера, поэтому сервер поднимается в
   * каталоге проекта, а id находится сканированием $DSH_HOME/sessions.
   */
  it("lists a real session with the title and creation time from the engine", async () => {
    const stubUrl = new URL("./helpers/stub-llm.mjs", import.meta.url).href;
    const { startStubServer } = (await import(stubUrl)) as {
      startStubServer(options: { replies: Array<{ text?: string }> }): Promise<{ port: number; close(): Promise<void> }>;
    };
    const stub = await startStubServer({ replies: [{ text: "ok from stub" }] });
    const home = await prepareHome();
    try {
      // default model -> deepseek-official, adapter -> stub (как в telegram REAL)
      await writeFile(
        join(home, "settings.yaml"),
        `agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nllm-deepseek:\n  baseURL: http://127.0.0.1:${stub.port}\n`
      );
      const base = `http://127.0.0.1:${port}`;
      const token = await bootServerWithCwd(home, join(home, "projects", "alpha"));

      await postJson(`${base}/api/workspaces/create`, { name: "alpha" }, token);
      const prompt = await postJson(`${base}/api/prompt`, { prompt: "Reply with exactly: ok from stub" }, token);
      expect(prompt.status, prompt.raw).toBe(200);

      const sessionId = await findNewSessionId(home);
      expect(sessionId).toMatch(/^session-/);

      await writeFile(
        join(home, "workspace-sessions.json"),
        JSON.stringify({ version: 1, workspaces: { "project:alpha": [{ sessionId, channel: "telegram" }] } }),
        "utf8"
      );

      const listed = await postJson(`${base}/api/sessions/list`, { scope: "project", name: "alpha" }, token);
      expect(listed.status, listed.raw).toBe(200);
      const sessions = (listed.json as { sessions: Array<{ id: string; title: string | null; channel: string; createdAt: string }> }).sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe(sessionId);
      expect(sessions[0]?.channel).toBe("telegram");
      expect(typeof sessions[0]?.title).toBe("string");
      expect((sessions[0]?.title ?? "").length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(sessions[0]?.createdAt ?? ""))).toBe(false);
    } finally {
      await stopServer();
      await rm(home, { recursive: true, force: true });
      await stub.close();
    }
  }, 300_000);
```

Хелперы рядом с `bootServer`:

```ts
  /** Сервер, поднятый в каталоге проекта: cwd сессии из /api/prompt = этот каталог. */
  async function bootServerWithCwd(home: string, cwd: string): Promise<string> {
    child = spawn("dsh", ["--profile", PROFILE], {
      env: { ...process.env, DSH_HOME: home, BALBES_PORT: String(port), DSH_TELEMETRY_DISABLED: "1" },
      cwd,
      stdio: "ignore"
    });
    await waitForHealth(port, child);
    const loginRes = await postJson(`http://127.0.0.1:${port}/api/auth/login`, { login, password });
    expect(loginRes.status, loginRes.raw).toBe(200);
    return (loginRes.json as { token: string }).token;
  }

  /** Новейшая материализованная сессия в $DSH_HOME/sessions (раскладка — деталь движка). */
  async function findNewSessionId(home: string): Promise<string> {
    const root = join(home, "sessions");
    const projectDirs = await readdir(root);
    const candidates: Array<{ id: string; mtime: number }> = [];
    for (const projectDir of projectDirs) {
      for (const sessionDir of await readdir(join(root, projectDir))) {
        const stats = await statFile(join(root, projectDir, sessionDir)).catch(() => null);
        if (stats === null) continue;
        candidates.push({ id: sessionDir, mtime: stats.mtimeMs });
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const newest = candidates[0];
    if (newest === undefined) throw new Error("no session materialized under $DSH_HOME/sessions");
    return newest.id;
  }
```

- [ ] **Step 3: Запустить REAL-тест**

Run: `cd packages/plugins/dsh-balbes-sessions && RUN_REAL=1 pnpm vitest run tests/integration.test.ts`
Expected: PASS все три `it`; в третьем `sessions[0].title` — непустая строка (стаб или fallback из первого промпта), `createdAt` — валидная ISO-дата.

- [ ] **Step 4: Добавить стаб-путь в комментарий набора и Commit**

Обновить docstring файла: описать, что LLM-граница заменена стабом (как в telegram REAL), а всё остальное — shipped код.

```bash
git add packages/plugins/dsh-balbes-sessions/tests
git commit -m "test(sessions): prove titles and creation times come from the engine"
```

---

### Task 7: Telegram регистрирует свои сессии

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/index.ts` (inject + регистрация + синк при apply)
- Modify: `packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-profile/cordis.patch.yml` (insert `balbes-sessions`)
- Test: `packages/plugins/dsh-balbes-telegram/tests/index.test.ts`

**Interfaces:**
- Consumes: сервис `balbesSessions` из задачи 3 (`register(ref, sessionId, channel)`).
- Produces: инвариант «сессия, созданная telegram для воркспейса, есть в реестре»; сервис `balbesSessions` в `inject` telegram.

- [ ] **Step 1: Написать падающий тест**

Добавить в `packages/plugins/dsh-balbes-telegram/tests/index.test.ts` (структура `apply`-харнесса там уже есть — использовать её же; ниже — целевые кейсы):

```ts
  it("declares balbesSessions as a dependency", () => {
    expect(inject).toContain("balbesSessions");
  });

  it("registers every session it runs for a workspace", async () => {
    const registered: Array<{ ref: unknown; sessionId: string; channel: string }> = [];
    // harness(ctx) — тот же, что в существующих тестах пакета; в него добавляется
    // заглушка сервиса реестра:
    const h = harness({
      balbesSessions: {
        register: async (ref: unknown, sessionId: string, channel: string) => {
          registered.push({ ref, sessionId, channel });
        }
      },
      // прогон одной успешной задачи воркспейса project/alpha, возвращающий sessionId
      taskResult: { ok: true, text: "ok", sessionId: "session-1" }
    });

    await h.runTask({ scope: "project", name: "alpha" }, "hello");

    expect(registered).toEqual([
      { ref: { scope: "project", name: "alpha" }, sessionId: "session-1", channel: "telegram" }
    ]);
  });

  it("syncs the persisted session map into the registry on apply", async () => {
    const registered: Array<{ ref: unknown; sessionId: string; channel: string }> = [];
    const h = harness({
      balbesSessions: {
        register: async (ref: unknown, sessionId: string, channel: string) => {
          registered.push({ ref, sessionId, channel });
        }
      },
      persistedSessions: { home: "session-home", "project:alpha": "session-alpha" }
    });

    await h.settleApply();

    expect(registered.sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { ref: { scope: "project", name: "alpha" }, sessionId: "session-alpha", channel: "telegram" },
      { ref: { scope: "home" }, sessionId: "session-home", channel: "telegram" }
    ]);
  });
```

Точные имена харнесс-хелперов (`harness(opts)`, `h.runTask`, `h.settleApply`, опции `balbesSessions`/`taskResult`/`persistedSessions`) ввести в этом шаге, расширив существующий харнесс файла: он уже строит фейковые `agents`/`sessions`/`balbesWorkspaces` и пишет состояние в temp-дом; новые опции прокидывают заглушку реестра, заранее записанный `telegram-state.json` и результат прогона.

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd packages/plugins/dsh-balbes-telegram && pnpm vitest run tests/index.test.ts`
Expected: FAIL — `inject` не содержит `balbesSessions`, регистраций нет.

- [ ] **Step 3: Реализовать интеграцию**

`src/index.ts`:

1) в `inject` добавить `"balbesSessions"` (после `"balbesWorkspaces"`):

```ts
export const inject = [
  "balbesHttp",
  "settings",
  "credentials",
  "balbesWorkspaces",
  "balbesSessions",
  "agents",
  "sessions",
  "agentDefaultModel"
];
```

2) рядом с чтением `workspaces` получить сервис:

```ts
  const sessionsRegistry = ctx.get("balbesSessions") as
    | { register(ref: WorkspaceRef, sessionId: string, channel: string): Promise<void> }
    | undefined;
  if (sessionsRegistry === undefined) {
    ctx.logger.warn("balbes-telegram: balbesSessions service is not available; sessions will not be listed in the admin");
  }
```

3) в обёртке `run()` — после успешной записи в `live.sessions[key]`:

```ts
            live.sessions[key] = result.sessionId;
            persist();
            if (sessionsRegistry !== undefined) {
              // Витрина сессий воркспейса: сбой записи в реестр не меняет исход
              // задачи — регистрация логируется и остаётся best-effort.
              await sessionsRegistry
                .register(ref, result.sessionId, "telegram")
                .catch((error: unknown) =>
                  ctx.logger.warn(
                    `balbes-telegram: registering session ${result.sessionId} in the workspace registry failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  )
                );
            }
```

4) синк при `apply` — после загрузки состояния (`live` заполнено) добавить разбор ключа в ссылку:

```ts
/** `home` | `project:<имя>` -> ссылка на воркспейс (формат ключа из state). */
function refFromStateKey(key: string): WorkspaceRef | undefined {
  if (key === "home") return { scope: "home" };
  if (key.startsWith("project:")) {
    const name = key.slice("project:".length);
    return name === "" ? undefined : { scope: "project", name };
  }
  return undefined;
}
```

и сам синк (идемпотентный upsert — повторный запуск ничего не дублирует):

```ts
  if (sessionsRegistry !== undefined) {
    for (const [key, sessionId] of Object.entries(live.sessions)) {
      const ref = refFromStateKey(key);
      if (ref === undefined) {
        ctx.logger.warn(`balbes-telegram: cannot map state key "${key}" to a workspace; session not registered`);
        continue;
      }
      await sessionsRegistry.register(ref, sessionId, "telegram").catch((error: unknown) =>
        ctx.logger.warn(
          `balbes-telegram: syncing session ${sessionId} into the workspace registry failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    }
  }
```

- [ ] **Step 4: Добавить плагин сессий в тестовый профиль telegram**

`packages/plugins/dsh-balbes-telegram/tests/fixtures/balbes-telegram-profile/cordis.patch.yml` — перед `balbes-telegram`:

```yaml
- insert:
    - id: balbes-workspaces
      name: 'dsh-balbes-workspaces'
    - id: balbes-sessions
      name: 'dsh-balbes-sessions'
    - id: balbes-telegram
      name: 'dsh-balbes-telegram'
```

В REAL-тесте telegram (`tests/integration.test.ts`, `prepareHome`) в список копируемых пакетов добавить `dsh-balbes-sessions` (тот же цикл `[pkgRoot, dirName]`):

```ts
    for (const [pkg, dirName] of [
      [workspacesPkgRoot, "dsh-balbes-workspaces"],
      [sessionsPkgRoot, "dsh-balbes-sessions"],
      [pkgRoot, "dsh-balbes-telegram"]
    ] as Array<[string, string]>) {
```

с объявлением `const sessionsPkgRoot = join(pkgRoot, "..", "dsh-balbes-sessions");` рядом с `workspacesPkgRoot`.

- [ ] **Step 5: Запустить тесты и типы пакета**

Run: `cd packages/plugins/dsh-balbes-telegram && pnpm run typecheck && pnpm test`
Expected: exit 0. Затем REAL-набор (если есть `dsh`): `RUN_REAL=1 pnpm vitest run tests/integration.test.ts` → PASS (композиция telegram теперь включает плагин сессий).

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/dsh-balbes-telegram
git commit -m "feat(telegram): register workspace sessions in the balbes sessions registry"
```

---

### Task 8: Контракты и клиент API админки

**Files:**
- Modify: `packages/contracts/src/index.ts` (в конец, рядом с telegram-блоками)
- Modify: `packages/frontend/dsh-balbes-admin/src/api/client.ts` (импорт типов, интерфейс, реализация)
- Test: `packages/frontend/dsh-balbes-admin/tests/client.test.ts`

**Interfaces:**
- Consumes: путь `/api/sessions/list` из задачи 3.
- Produces: `WorkspaceSessionInfo`, `SessionsListRequest`, `SessionsListResponse` (контракты) и `AdminApi.listSessions(scope, name?)` — ими пользуется задача 10.

- [ ] **Step 1: Написать падающий тест клиента**

Добавить в `packages/frontend/dsh-balbes-admin/tests/client.test.ts`:

```ts
  it("listSessions POSTs the workspace ref to /api/sessions/list", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const body = {
      sessions: [{ id: "session-1", title: "старая задача", channel: "telegram", createdAt: "2026-09-11T00:00:00.000Z" }]
    };
    const fetchMock = mockFetchOnce(200, body);
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    const res = await api.listSessions("project", "alpha");
    expect(res.sessions[0]?.title).toBe("старая задача");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/list");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok-1" });
    expect(JSON.parse(String(init.body))).toEqual({ scope: "project", name: "alpha" });
  });

  it("listSessions omits name for the home workspace", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const fetchMock = mockFetchOnce(200, { sessions: [] });
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    await api.listSessions("home");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ scope: "home" });
  });
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd packages/frontend/dsh-balbes-admin && pnpm vitest run tests/client.test.ts`
Expected: FAIL — `api.listSessions is not a function` (TS-ошибки в тесте допустимы до шага 3).

- [ ] **Step 3: Добавить контракты**

`packages/contracts/src/index.ts`:

```ts
export interface WorkspaceSessionInfo {
  id: string;
  /** Заголовок сессии из её лога; null, когда события title в логе нет. */
  title: string | null;
  /** Канал, создавший сессию: сейчас "telegram"; строка — форма не ломается на новых. */
  channel: string;
  createdAt: string; // ISO 8601
}

export interface SessionsListRequest {
  scope: WorkspaceScope;
  /** Проект-слаг; обязателен для scope === "project", отсутствует для "home". */
  name?: string;
}
export interface SessionsListResponse {
  sessions: WorkspaceSessionInfo[];
}
```

- [ ] **Step 4: Добавить метод в клиент**

`src/api/client.ts`: в импорт типов добавить `SessionsListRequest`, `SessionsListResponse`; в интерфейс `AdminApi` — после `readWorkspaceDir`:

```ts
  listSessions(scope: WorkspaceScope, name?: string): Promise<SessionsListResponse>;
```

в реализацию — после `readWorkspaceDir`:

```ts
    listSessions: (scope, name) => {
      const body: SessionsListRequest = name === undefined ? { scope } : { scope, name };
      return guard(request<SessionsListResponse>("/api/sessions/list", body));
    },
```

- [ ] **Step 5: Запустить тесты**

Run: `cd packages/frontend/dsh-balbes-admin && pnpm vitest run tests/client.test.ts`
Expected: PASS.

- [ ] **Step 6: Типы (фейки AdminApi в других тестах ещё сломаны — это задача 10)**

Run: `cd packages/frontend/dsh-balbes-admin && pnpm vitest run tests/client.test.ts`
Expected: PASS. Полный `pnpm run typecheck` временно красный из-за фейков `AdminApi` в `WorkspacesPage.test.tsx`/`App.test.tsx` — исправляется в задаче 10.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/index.ts packages/frontend/dsh-balbes-admin/src/api/client.ts packages/frontend/dsh-balbes-admin/tests/client.test.ts
git commit -m "feat(admin): sessions.list contract and client method"
```

---

### Task 9: Правая панель с плашкой табов

**Files:**
- Create: `packages/frontend/dsh-balbes-admin/src/components/WorkspaceRightPane.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/pages/WorkspacesPage.tsx` (замена `div.ws-void-pane`)
- Modify: `packages/frontend/dsh-balbes-admin/src/styles.css` (`.ws-void-pane` → `.ws-right-pane`, плашка, панель)
- Test: `packages/frontend/dsh-balbes-admin/tests/WorkspaceRightPane.test.tsx`

**Interfaces:**
- Consumes: `AdminApi` (задача 8), `WorkspaceRef` из `src/workspaceRef.ts`.
- Produces: `WorkspaceRightPane({api, workspace})`, `RightPaneTab {id, label, render}`; таб `sessions` рендерит `SessionsTab` (задача 10) с пропами `{api, workspace, reloadKey}`; кнопка `data-testid="ws-refresh"` и плашка `data-testid="ws-tabs"`.

- [ ] **Step 1: Написать падающий тест**

`packages/frontend/dsh-balbes-admin/tests/WorkspaceRightPane.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import WorkspaceRightPane from "../src/components/WorkspaceRightPane";
import type { AdminApi } from "../src/api/client";

function makeApi(): AdminApi {
  return {
    health: vi.fn(),
    login: vi.fn(),
    me: vi.fn(),
    prompt: vi.fn(),
    onUnauthorized: vi.fn(),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    readWorkspaceDir: vi.fn(),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listModels: vi.fn(),
    saveModel: vi.fn(),
    deleteModel: vi.fn(),
    setDefaultModel: vi.fn(),
    catalogModels: vi.fn(),
    telegramStatus: vi.fn(),
    telegramSave: vi.fn(),
    telegramTest: vi.fn(),
    telegramDisable: vi.fn(),
    telegramClearToken: vi.fn(),
    subscribeWorkspaceEvents: vi.fn(() => () => undefined)
  } as unknown as AdminApi;
}

describe("WorkspaceRightPane", () => {
  it("renders one tab and its panel", () => {
    render(<WorkspaceRightPane api={makeApi()} workspace={{ scope: "project", name: "alpha" }} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Сессии"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel")).toBeDefined();
    cleanup();
  });

  it("shows the placeholder instead of the panel content without a workspace", () => {
    render(<WorkspaceRightPane api={makeApi()} workspace={null} />);
    expect(screen.getByTestId("right-pane-prompt").textContent).toBe("Выберите воркспейс");
    expect(screen.queryByTestId("sessions-empty")).toBeNull();
    cleanup();
  });

  it("offers a refresh control", () => {
    render(<WorkspaceRightPane api={makeApi()} workspace={{ scope: "home" }} />);
    expect(screen.getByTestId("ws-refresh")).toBeDefined();
    cleanup();
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd packages/frontend/dsh-balbes-admin && pnpm vitest run tests/WorkspaceRightPane.test.tsx`
Expected: FAIL — не резолвится `../src/components/WorkspaceRightPane`.

- [ ] **Step 3: Реализовать компонент**

`src/components/WorkspaceRightPane.tsx`:

```tsx
import { useState, type ReactNode } from "react";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import SessionsTab from "./SessionsTab";

/** Один таб правой панели: id, подпись и рендер содержимого. */
export interface RightPaneTab {
  id: string;
  label: string;
  render: (reloadKey: number) => ReactNode;
}

interface WorkspaceRightPaneProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
}

/**
 * Правая зона страницы «Проекты»: плашка табов сверху и панель активного таба.
 * Табы описаны данными — следующий таб добавляется одной записью в TAB_DEFS.
 * Кнопка «Обновить» — общая для панели: она поднимает reloadKey, на который
 * реагирует активный таб.
 */
export default function WorkspaceRightPane({ api, workspace }: WorkspaceRightPaneProps) {
  const [active, setActive] = useState("sessions");
  const [reloadKey, setReloadKey] = useState(0);

  const tabs: RightPaneTab[] = [
    {
      id: "sessions",
      label: "Сессии",
      render: (key) => <SessionsTab api={api} workspace={workspace} reloadKey={key} />
    }
  ];
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  if (current === undefined) return null;

  return (
    <div className="ws-pane ws-right-pane" data-testid="ws-right-pane">
      <div className="ws-tabstrip" role="tablist" aria-label="Содержимое воркспейса" data-testid="ws-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`ws-tab-${tab.id}`}
            aria-selected={tab.id === current.id}
            aria-controls={`ws-tabpanel-${tab.id}`}
            className={tab.id === current.id ? "ws-tab active" : "ws-tab"}
            data-testid={`ws-tab-${tab.id}`}
            onClick={() => {
              setActive(tab.id);
              setReloadKey((key) => key + 1);
            }}
          >
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          className="btn-ghost ws-tabstrip-refresh"
          data-testid="ws-refresh"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          Обновить
        </button>
      </div>
      <div
        className="ws-tabpanel"
        role="tabpanel"
        id={`ws-tabpanel-${current.id}`}
        aria-labelledby={`ws-tab-${current.id}`}
        data-testid="ws-tabpanel"
      >
        {workspace === null ? (
          <p className="ws-placeholder" data-testid="right-pane-prompt">
            Выберите воркспейс
          </p>
        ) : (
          current.render(reloadKey)
        )}
      </div>
    </div>
  );
}
```

`SessionsTab` появится в задаче 10; чтобы этот шаг был самодостаточным, создать заглушку `src/components/SessionsTab.tsx` и в задаче 10 заменить её телом:

```tsx
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";

interface SessionsTabProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
  reloadKey: number;
}

/** Таб «Сессии»: список сессий воркспейса (наполняется в задаче 10). */
export default function SessionsTab({ reloadKey }: SessionsTabProps) {
  return <p className="ws-placeholder" data-testid="sessions-loading">Загрузка… {reloadKey}</p>;
}
```

- [ ] **Step 4: Запустить тест панели**

Run: `cd packages/frontend/dsh-balbes-admin && pnpm vitest run tests/WorkspaceRightPane.test.tsx`
Expected: PASS (3 кейса).

- [ ] **Step 5: Подключить панель на странице и поправить CSS**

`src/pages/WorkspacesPage.tsx`: импорт `import WorkspaceRightPane from "../components/WorkspaceRightPane";` и замена

```tsx
        <div className="ws-pane ws-void-pane" data-testid="ws-void-pane" />
```

на

```tsx
        <WorkspaceRightPane api={api} workspace={selected} />
```

`src/styles.css`: заменить строку `.ws-void-pane { flex: 1; min-width: 0; background: var(--bg); }` на блок:

```css
.ws-right-pane { flex: 1; min-width: 0; background: var(--bg); }
.ws-tabstrip {
  display: flex; align-items: center; gap: 2px;
  padding: 0 10px; border-bottom: 1px solid var(--border); background: var(--surface);
}
.ws-tab {
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--text-dim); font: inherit; font-size: 13px; padding: 10px 12px; cursor: pointer;
}
.ws-tab:hover { color: var(--text); }
.ws-tab.active { color: var(--text); border-bottom-color: var(--accent); }
.ws-tabstrip-refresh { margin-left: auto; font-size: 12px; }
.ws-tabpanel { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
```

- [ ] **Step 6: Прогнать тесты страницы и панели**

Run: `cd packages/frontend/dsh-balbes-admin && pnpm vitest run tests/WorkspaceRightPane.test.tsx tests/WorkspacesPage.test.tsx`
Expected: PASS. Если `WorkspacesPage.test.tsx` падает на `listSessions is not a function` — это ожидаемо до задачи 10; здесь допустимо только падение по этой причине, и оно устраняется там.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src packages/frontend/dsh-balbes-admin/tests/WorkspaceRightPane.test.tsx
git commit -m "feat(admin): tab strip in the right pane of the projects page"
```

---

### Task 10: Таб «Сессии» — данные, строки, состояния

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/components/SessionsTab.tsx` (тело вместо заглушки)
- Modify: `packages/frontend/dsh-balbes-admin/src/styles.css` (строки сессий)
- Test: `packages/frontend/dsh-balbes-admin/tests/SessionsTab.test.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/tests/WorkspacesPage.test.tsx`, `packages/frontend/dsh-balbes-admin/tests/App.test.tsx` (фейки `AdminApi` + `listSessions`)

**Interfaces:**
- Consumes: `AdminApi.listSessions`, `WorkspaceSessionInfo`, проп `reloadKey` из задачи 9.
- Produces: строки `data-testid="session-row-<id>"` с заголовком/каналом/временем; состояния `sessions-loading`, `sessions-empty`, `sessions-error` (+ `sessions-retry`).

- [ ] **Step 1: Написать падающие тесты**

`packages/frontend/dsh-balbes-admin/tests/SessionsTab.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import SessionsTab from "../src/components/SessionsTab";
import type { AdminApi } from "../src/api/client";

const SESSIONS = [
  { id: "session-new", title: "новая задача", channel: "telegram", createdAt: "2026-09-11T01:40:00.000Z" },
  { id: "session-old", title: null, channel: "telegram", createdAt: "2026-09-10T10:00:00.000Z" }
];

function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listSessions: vi.fn(async () => ({ sessions: SESSIONS })),
    ...overrides
  } as unknown as AdminApi;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("SessionsTab", () => {
  it("renders rows with title, channel and time", async () => {
    render(<SessionsTab api={makeApi()} workspace={{ scope: "project", name: "alpha" }} reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("session-row-session-new")).toBeDefined());
    expect(screen.getByTestId("session-row-session-new").textContent).toContain("новая задача");
    expect(screen.getByTestId("session-row-session-new").textContent).toContain("telegram");
    // сессия без заголовка получает явную заглушку, а не пустую строку
    expect(screen.getByTestId("session-row-session-old").textContent).toContain("Без заголовка");
  });

  it("shows the empty state", async () => {
    const api = makeApi({ listSessions: vi.fn(async () => ({ sessions: [] })) });
    render(<SessionsTab api={api} workspace={{ scope: "home" }} reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("sessions-empty")).toBeDefined());
  });

  it("shows an error with a retry that reloads", async () => {
    const listSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ sessions: SESSIONS });
    render(<SessionsTab api={makeApi({ listSessions })} workspace={{ scope: "home" }} reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("sessions-error")).toBeDefined());
    fireEvent.click(screen.getByTestId("sessions-retry"));
    await waitFor(() => expect(screen.getByTestId("session-row-session-new")).toBeDefined());
  });

  it("makes no request without a workspace", () => {
    const listSessions = vi.fn();
    render(<SessionsTab api={makeApi({ listSessions })} workspace={null} reloadKey={0} />);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("does not keep rows of the previous workspace after a switch", async () => {
    const listSessions = vi.fn(async (scope: string, name?: string) =>
      name === "alpha"
        ? { sessions: SESSIONS }
        : { sessions: [{ id: "session-beta", title: "бета", channel: "telegram", createdAt: "2026-09-11T02:00:00.000Z" }] }
    );
    const api = makeApi({ listSessions });
    const { rerender } = render(
      <SessionsTab api={api} workspace={{ scope: "project", name: "alpha" }} reloadKey={0} />
    );
    await waitFor(() => expect(screen.getByTestId("session-row-session-new")).toBeDefined());

    rerender(<SessionsTab api={api} workspace={{ scope: "project", name: "beta" }} reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("session-row-session-beta")).toBeDefined());
    expect(screen.queryByTestId("session-row-session-new")).toBeNull();
  });

  it("reloads when reloadKey changes", async () => {
    const listSessions = vi.fn(async () => ({ sessions: SESSIONS }));
    const api = makeApi({ listSessions });
    const { rerender } = render(<SessionsTab api={api} workspace={{ scope: "home" }} reloadKey={0} />);
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    rerender(<SessionsTab api={api} workspace={{ scope: "home" }} reloadKey={1} />);
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd packages/frontend/dsh-balbes-admin && pnpm vitest run tests/SessionsTab.test.tsx`
Expected: FAIL — нет `session-row-*`/`sessions-empty`/`sessions-error` (сейчас заглушка).

- [ ] **Step 3: Реализовать таб**

`src/components/SessionsTab.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceSessionInfo } from "dsh-balbes-contracts";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";

interface SessionsTabProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
  /** Счётчик внешних обновлений (кнопка «Обновить», клик по табу). */
  reloadKey: number;
}

/** Время создания сессии: ru-RU, с ISO в качестве честного fallback. */
function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ru-RU");
}

/**
 * Таб «Сессии»: список сессий выбранного воркспейса. Загрузка идёт при выборе
 * воркспейса, при смене reloadKey и по кнопке «Повторить» после ошибки. Ответы
 * защищены от гонок тем же приёмом «поколение + счётчик запроса», что в
 * FileTree: ответ прошлого воркспейса не применяется.
 */
export default function SessionsTab({ api, workspace, reloadKey }: SessionsTabProps) {
  const [sessions, setSessions] = useState<WorkspaceSessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastWorkspace = useRef<WorkspaceRef | null>(null);
  const generation = useRef(0);
  const loadSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (workspace === null) return;
    const myGen = generation.current;
    const mySeq = ++loadSeq.current;
    const stale = (): boolean => generation.current !== myGen || loadSeq.current !== mySeq;
    setError(null);
    try {
      const res = await api.listSessions(workspace.scope, workspace.name);
      if (!stale()) setSessions(res.sessions);
    } catch (err) {
      if (!stale()) {
        setSessions(null);
        setError(err instanceof Error ? err.message : "sessions failed");
      }
    }
  }, [api, workspace]);

  // смена воркспейса: полный сброс, включая отмену ответов прошлого воркспейса
  useEffect(() => {
    if (!isSameRef(lastWorkspace.current, workspace)) {
      lastWorkspace.current = workspace;
      generation.current += 1;
      setSessions(null);
      setError(null);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, reloadKey]);

  if (workspace === null) return null;

  if (error !== null) {
    return (
      <p className="form-error ws-tab-error" role="alert" data-testid="sessions-error">
        Не удалось загрузить сессии: {error}{" "}
        <button type="button" className="btn-ghost" data-testid="sessions-retry" onClick={() => void load()}>
          Повторить
        </button>
      </p>
    );
  }
  if (sessions === null) {
    return <p className="ws-placeholder" data-testid="sessions-loading">Загрузка…</p>;
  }
  if (sessions.length === 0) {
    return <p className="ws-placeholder" data-testid="sessions-empty">Сессий пока нет</p>;
  }
  return (
    <ul className="ws-rows ws-session-rows" data-testid="sessions-list">
      {sessions.map((session) => (
        <li key={session.id} className="ws-session-row" data-testid={`session-row-${session.id}`}>
          <span className="ws-session-title">{session.title ?? "Без заголовка"}</span>
          <span className="ws-session-meta">
            <span className="ws-session-channel">{session.channel}</span>
            <span className="ws-session-time">{formatCreatedAt(session.createdAt)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
```

CSS в `src/styles.css` (рядом с блоком правой панели):

```css
.ws-tab-error { margin: 0; padding: 12px 14px; }
.ws-session-rows { padding: 10px 12px; gap: 6px; }
.ws-session-row {
  display: flex; flex-direction: column; gap: 4px;
  padding: 9px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface);
}
.ws-session-title { font-size: 13.5px; color: var(--text); overflow-wrap: anywhere; }
.ws-session-meta { display: flex; align-items: center; gap: 8px; color: var(--text-dim); font-size: 11px; }
.ws-session-channel { font-family: var(--mono); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
```

- [ ] **Step 4: Запустить тесты таба**

Run: `cd packages/frontend/dsh-balbes-admin && pnpm vitest run tests/SessionsTab.test.tsx`
Expected: PASS (6 кейсов).

- [ ] **Step 5: Дополнить фейки `AdminApi` в существующих тестах**

В `tests/WorkspacesPage.test.tsx` (функция `makeApi`) и `tests/App.test.tsx` (фейк API) добавить:

```ts
    listSessions: vi.fn(async () => ({ sessions: [] })),
```

и в `WorkspacesPage.test.tsx` — кейс на связку страницы с табом:

```tsx
  it("loads sessions for the selected workspace", async () => {
    render(<WorkspacesPage api={api} />);
    await waitFor(() => expect(screen.getByTestId("workspace-row-alpha")).toBeDefined());
    fireEvent.click(screen.getByTestId("workspace-row-alpha"));
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledWith("project", "alpha"));
    expect(screen.getByTestId("ws-tabs")).toBeDefined();
  });
```

(`workspace-row-alpha` — существующий testid строки проекта; если в файле он назван иначе, использовать фактический.)

- [ ] **Step 6: Полный прогон фронтенда**

Run: `cd packages/frontend/dsh-balbes-admin && pnpm run typecheck && pnpm test`
Expected: exit 0 — все тесты зелёные, включая `client`, `WorkspaceRightPane`, `SessionsTab`, `WorkspacesPage`, `App`.

- [ ] **Step 7: Собрать SPA**

Run: `cd packages/frontend/dsh-balbes-admin && pnpm run build`
Expected: exit 0, `dist/index.html` обновлён.

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/dsh-balbes-admin
git commit -m "feat(admin): sessions tab lists the workspace sessions"
```

---

### Task 11: Рунбук и сводка установщика

**Files:**
- Modify: `docs/runbooks/stage2-vps.md` (раздел «Страница «Проекты» (три панели)», шаг с реестром в «Что делает установщик», smoke-блок, «Где лежат данные», «Устранение неполадок»)
- Modify: `scripts/install.sh` (`print_admin_summary`, если в задаче 4 строка про плагин сессий не добавлена)

**Interfaces:**
- Consumes: готовая ручка `/api/sessions/list` (задача 3), UI (задачи 9–10), установщик (задача 4).
- Produces: серверная проверка, которую владелец выполняет после `install.sh` — с ожидаемыми выводами.

- [ ] **Step 1: Описать UI в разделе про страницу «Проекты»**

Заменить описание правой пустой зоны на: плашка табов сверху правой зоны (сейчас один таб «Сессии», кнопка «Обновить» справа), под ней список сессий выбранного воркспейса (заголовок, канал, время создания); состояния «Загрузка…», «Сессий пока нет», «Не удалось загрузить сессии» + «Повторить»; без выбранного воркспейса — «Выберите воркспейс».

- [ ] **Step 2: Добавить smoke-блок в раздел «Smoke без браузера (curl + JWT)»**

После блока воркспейсов:

```bash
# sessions.list — сессии выбранного воркспейса (JWT из входа выше)
curl -sS -X POST "http://127.0.0.1:8080/api/sessions/list" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":"project","name":"alpha"}'
# ожидается: HTTP 200, {"sessions":[]} на воркспейсе без сессий;
# после задачи агенту через Telegram — одна запись вида
# {"id":"session-…","title":"…","channel":"telegram","createdAt":"2026-…Z"}

# несуществующий проект
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:8080/api/sessions/list" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":"project","name":"nope"}'
# ожидается: 404

# без токена
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:8080/api/sessions/list" \
  -H 'content-type: application/json' -d '{"scope":"home"}'
# ожидается: 401
```

- [ ] **Step 3: Дополнить «Где лежат данные» и устранение неполадок**

«Где лежат данные»: добавить `$DSH_HOME/workspace-sessions.json` — реестр сессий воркспейсов (600; append-only; в нём только принадлежность «воркспейс → sessionId + канал», заголовки и время берутся из логов сессий `$DSH_HOME/sessions/`).

«Устранение неполадок»: строка про `sessions.list` → 500 `workspace sessions registry … is not valid JSON` — реестр повреждён; файл можно удалить (витрина пересоберётся из новых сессий; telegram зарегистрирует текущие сессии воркспейсов при следующем старте), либо починить форму `{"version":1,"workspaces":{…}}`; права файла должны быть 600.

- [ ] **Step 4: Проверить, что рунбук не противоречит коду**

Run:
```bash
grep -n "sessions.list\|workspace-sessions.json" docs/runbooks/stage2-vps.md
grep -n "ws-tab\|ws-right-pane" packages/frontend/dsh-balbes-admin/src/styles.css | head
```
Expected: рунбук упоминает ручку и файл; CSS содержит использованные классы (никаких обещанных, но не существующих элементов).

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/stage2-vps.md scripts/install.sh
git commit -m "docs(runbook): workspace sessions tab and registry checks"
```

---

### Task 12: Финальная проверка и передача на сервер

**Files:**
- Modify: только при находках (исправления по месту).
- Create: ничего; результат — отчёт и текст передачи.

**Interfaces:**
- Consumes: все предыдущие задачи.
- Produces: доказательства прогона, закрытый канон-аудит, инструкции владельцу.

- [ ] **Step 1: Полный прогон воркспейса**

Run: `pnpm install && pnpm -r --if-present run build && pnpm -r --if-present run typecheck && pnpm -r --if-present run test`
Expected: exit 0 на каждой команде; в выводе — новые наборы `dsh-balbes-sessions` (registry + index), фронтенд-наборы с `SessionsTab`/`WorkspaceRightPane`.

- [ ] **Step 2: REAL-наборы (если `dsh` в PATH)**

Run:
```bash
cd packages/plugins/dsh-balbes-sessions && RUN_REAL=1 pnpm vitest run tests/integration.test.ts
cd ../../plugins/dsh-balbes-telegram && RUN_REAL=1 pnpm vitest run tests/integration.test.ts
```
Expected: PASS. Без `dsh` — зафиксировать в отчёте, что REAL-проверку даёт CI-job `real`.

- [ ] **Step 3: Сверить план со спеком**

Пройти по спеке `docs/superpowers/specs/2026-09-11-workspace-sessions-panel-design.md` и убедиться, что каждый пункт «Решения и границы», «Контракты API», «Канон», «Установщик и рунбук», «Тесты и проверки» имеет реализацию в коде/доках. Незакрытые пункты — исправить до отчёта.

- [ ] **Step 4: Закрыть канон-аудит**

Run: скилл `canon-audit` по теме «сессии воркспейса: реестр и витрина». Зафиксировать расхождения (если есть) в `docs/canon/DISCREPANCIES.md` согласно скиллу.

- [ ] **Step 5: Commit (если аудит потребовал правок)**

```bash
git add docs/canon
git commit -m "docs(canon): close the sessions registry audit"
```

- [ ] **Step 6: Передать инструкции владельцу** (без коммита)

Выдать текст: изменения должны быть на `origin/main` (push — только с согласия владельца), затем на сервере — повторный `scripts/install.sh` (он делает `git pull --ff-only`, сборку, sync профиля, копирование плагинов, деплой SPA, рестарт сервиса), после чего проверить:
1. `dsh --profile balbes --dump-config | grep -c balbes-sessions` → ≥ 1;
2. smoke-блок `sessions.list` из рунбука (200/404/401) с ожидаемыми выводами;
3. `ls -l $DSH_HOME/workspace-sessions.json` → 600 после первой сессии воркспейса (в Telegram: выбрать воркспейс и поставить задачу);
4. UI: страница «Проекты» → в правой зоне плашка с табом «Сессии», в списке — заголовок, `telegram`, время; у воркспейса без сессий — «Сессий пока нет»;
5. негативная проверка: испортить `workspace-sessions.json` (`echo '{' > …`) → вкладка показывает «Не удалось загрузить сессии» и «Повторить», после возврата валидного файла «Повторить» снова показывает список.
