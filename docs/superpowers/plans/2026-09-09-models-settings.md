# «Модели» (провайдеры/ключи/дефолтная модель) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Раздел «Модели» в админке: CRUD подключений провайдеров (DeepSeek официальный + OpenAI-совместимые с кастомным URL), управление API-ключами и глобальной дефолтной моделью — тонким слоем над штатными сервисами движка dsh.

**Architecture:** Новый функциональный плагин packages/plugins/dsh-balbes-models (по образцу dsh-balbes-workspaces) регистрирует bearer-ручки /api/models/* через сервис balbesHttp и пишет/читает состояние движка: роуты провайдеров — settings-секция llm-pi-ai (сервис ctx.settings), ключи — refs в .credentials.yaml (сервис ctx.credentials), дефолтная модель — сервис agentDefaultModel. SPA получает страницу «Модели» и типизированные методы клиента; installer/CI копируют пакет в profile node_modules.

**Tech Stack:** TypeScript strict ESM, Cordis-плагины dsh (dsh 0.1.2-rc.1), vitest, React+Vite SPA, bash-установщик, GitHub Actions.

**Spec:** docs/superpowers/specs/2026-09-09-models-settings-design.md — план аргументирует от спеки; исполнители читают оба файла.

## Global Constraints

- dsh — зависимость, не форк: никогда не править установленные @deepseek-ai/*; не обходить ядро.
- Плагин — функциональный: именованные экспорты name/inject/Config/apply, без default-export. inject = ["balbesHttp"]; остальные сервисы читаются строгим ctx.get(key) со структурными типами (как runner.ts).
- R-API-1: все ручки /api/* — только POST; ошибки — {error:{code,message}}; коды стабильны.
- Секреты: никогда не логировать, не возвращать в ответах, не коммитить. Записи ключей — только через credentials-слой движка (atomic write + lock).
- Строгий TS, ESM; в package-local импортах расширение .js при относительных путях (./models.js). Код и комментарии — английские.
- Тесты — vitest в tests/; продукт-видимый плагин обязан иметь REAL-композицию (boot cordis.yml через Loader/app; мок только внешние/недетерминированные границы). REAL-тесты гоняются с RUN_REAL=1 и наличием глобального dsh.
- Canon-first: правки docs/canon/** только через скиллы canon (Task 0); правки runbook/installer/CI — в том же коммите, что и код.
- UI-копия — русская; admin-тесты используют @testing-library/react и data-testid.
- Профильный патч profiles/balbes/cordis.patch.yml — insert-строки плагинов; установщик и CI копируют собранные пакеты в profile node_modules.
- Коммит-сообщения по прецедентам: feat(models): …, docs(canon): …, fix(admin): ….

## Известное отклонение от спеки (решение в плане)

Спека (§3) говорит «deepseek — каталог движка». In-process публичного списка моделей официального роута у движка нет (каталог отдаётся только в его web-UI через remote-каталог). v1: официальные модели — константа DEEPSEEK_OFFICIAL_MODELS в src/models.ts (deepseek-v4-flash, deepseek-v4-pro — каталог dsh-llm-deepseek на 0.1.2-rc.1) с пометкой о синхронизации при апгрейде движка. Кастомные роуты — их модели из settings (ввёл владелец). Сверка на REAL-тесте: дефолт движка в свежем home — deepseek-v4-flash.

Второе отклонение (семантика ключа в models.save): спека §4 упоминала «key: null → unset». v1 упрощаем: поле key в save опционально, пустое/отсутствующее — не трогает сохранённый ключ; явного сброса ключа без удаления подключения нет (удаление ключа = удаление подключения).

---

### Task 0: Canon — раздел «Модели» (canon-write)

> Требует скилла canon-write (доступен в сессии). После коммита Task 0 — пауза на go-ahead владельца перед Task 1 (правило AGENTS: после существенных canon-правок — go-ahead).

**Files:**
- Modify: docs/canon/OVERVIEW.md — «управление ключами/моделями в UI» из Out of scope перенести в In scope (страница «Модели»: подключения провайдеров, ключи, дефолтная модель); Success signals +1 (смена ключа/дефолта применяется к следующему промпту без рестарта).
- Modify: docs/canon/ARCHITECTURE.md — Building blocks: пакет packages/plugins/dsh-balbes-models/; Key flows: поток «настройка моделей» (настройки в settings.yaml: llm-pi-ai + agent-default-model; ключи — refs в .credentials.yaml; эффект — со следующего запроса).
- Modify: docs/canon/API_CONTRACTS.md — реестр ручек models.list / models.save / models.delete / models.default (метод/путь/auth/request/response/errors/notes — по §4 спеки; список «сейчас» дополнить).
- Modify: docs/canon/ADMIN_UI.md — Current state: страница «Модели» (карточки подключений, селект дефолтной модели, модалки).
- Modify: docs/canon/GLOSSARY.md — термины: «Подключение (модель/провайдер)», «Дефолтная модель».
- Validate: doc-canon validate --json (exit 0, без error) и doc-canon index.
- Commit: docs(canon): add models/provider/key settings section.

---

### Task 1: Scaffold пакета плагина + доменная модель

**Files:**
- Create: packages/plugins/dsh-balbes-models/package.json
- Create: packages/plugins/dsh-balbes-models/tsconfig.json
- Create: packages/plugins/dsh-balbes-models/tsconfig.build.json
- Create: packages/plugins/dsh-balbes-models/src/models.ts
- Create: packages/plugins/dsh-balbes-models/src/index.ts (каркас плагина без роутов — раскрывается в Task 2)
- Create: packages/plugins/dsh-balbes-models/tests/models.test.ts

**Interfaces (produces для Task 2–4, из src/models.ts):**
- ModelKind = "deepseek" | "custom"; ModelOption {id, name?}; ModelConnection {routeId, kind, displayName, baseURL?, hasKey, models: string[], isDefault}
- const DEEPSEEK_OFFICIAL_ROUTE = "deepseek-official"; const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY"
- const DEEPSEEK_OFFICIAL_MODELS: ModelOption[] (deepseek-v4-flash, deepseek-v4-pro)
- routeIdFromName(name): string | null (lower-hyphen ^[a-z][a-z0-9-]*$, <= 63)
- refNameForRoute(route): string (BALBES_ + UPPER_SNAKE + _API_KEY)
- validateBaseUrl(value): boolean (http/https)
- parseModelIds(raw: string[]): string[] | null (>=1, уникальные, без пробелов/запятых)
- validateCustomPayload(p): ok-объект | {error: invalid-display-name | invalid-url | invalid-key | invalid-models}

- [ ] **Step 1: Write the failing unit tests (tests/models.test.ts)**

~~~~ts
import { describe, expect, it } from "vitest";
import {
  routeIdFromName, refNameForRoute, validateBaseUrl, parseModelIds,
  validateCustomPayload, DEEPSEEK_OFFICIAL_MODELS
} from "../src/models.js";

describe("models domain", () => {
  it("generates lower-hyphen route ids from display names", () => {
    expect(routeIdFromName("My Gateway")).toBe("my-gateway");
    expect(routeIdFromName("OpenAI Compatible!")).toBe("openai-compatible");
    expect(routeIdFromName("мышь")).toBeNull();
    expect(routeIdFromName("")).toBeNull();
    expect(routeIdFromName("x".repeat(64))).toBeNull();
    expect(routeIdFromName("a b")).toBe("a-b");
    expect(routeIdFromName("_lead")).toBeNull();
  });

  it("maps a route to a POSIX-safe env ref name", () => {
    expect(refNameForRoute("my-gateway")).toBe("BALBES_MY_GATEWAY_API_KEY");
    expect(refNameForRoute("deepseek-official")).toBe("BALBES_DEEPSEEK_OFFICIAL_API_KEY");
  });

  it("validates base URLs as http(s)", () => {
    expect(validateBaseUrl("https://api.example.com/v1")).toBe(true);
    expect(validateBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(validateBaseUrl("ftp://x")).toBe(false);
    expect(validateBaseUrl("not a url")).toBe(false);
  });

  it("parses model id lists: >=1, unique, no spaces", () => {
    expect(parseModelIds(["gpt-4o-mini", "gpt-4o"])).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(parseModelIds([])).toBeNull();
    expect(parseModelIds(["a b"])).toBeNull();
    expect(parseModelIds(["a", "a"])).toBeNull();
  });

  it("validates the custom connection payload", () => {
    const ok = validateCustomPayload({ displayName: "My GW", baseURL: "https://x.example/v1", key: "sk-1", models: ["m1"] });
    expect(ok).toEqual({ displayName: "My GW", baseURL: "https://x.example/v1", key: "sk-1", models: ["m1"] });
    expect(validateCustomPayload({ displayName: "", baseURL: "https://x", models: ["m1"] })).toEqual({ error: "invalid-display-name" });
    expect(validateCustomPayload({ displayName: "X", baseURL: "nope", models: ["m1"] })).toEqual({ error: "invalid-url" });
    expect(validateCustomPayload({ displayName: "X", baseURL: "https://x", models: [] })).toEqual({ error: "invalid-models" });
  });

  it("exposes the pinned official DeepSeek catalog (dsh 0.1.2-rc.1)", () => {
    expect(DEEPSEEK_OFFICIAL_MODELS.map((m) => m.id)).toContain("deepseek-v4-flash");
    expect(DEEPSEEK_OFFICIAL_MODELS.map((m) => m.id)).toContain("deepseek-v4-pro");
  });
});
~~~~

- [ ] **Step 2: Run tests, expect fail (module missing)**
Run: pnpm --filter dsh-balbes-models test → FAIL (module not found).

- [ ] **Step 3: Scaffold package files**
package.json — копия структуры dsh-balbes-workspaces/package.json (name dsh-balbes-models; exports "." и "./package.json"; scripts build = tsc -p tsconfig.build.json, typecheck = tsc --noEmit -p tsconfig.json, test = vitest run; devDeps: @types/node, typescript, vitest ^2.1.0). tsconfig.json и tsconfig.build.json — скопировать из dsh-balbes-workspaces (build исключает tests/ и пишет lib/). src/index.ts — минимальный каркас:

~~~~ts
import z from "@deepseek-ai/schemastery";

export const name = "balbes-models";
export const inject = ["balbesHttp"];
export const Config = z.object({});

export function apply(ctx: { get(key: string): unknown; logger: { warn(m: string): void } }, _config: unknown): void {
  const http = ctx.get("balbesHttp") as { post(..._args: unknown[]): void } | undefined;
  if (http === undefined) ctx.logger.warn("balbes-models: balbesHttp service missing; routes not registered");
}
~~~~

- [ ] **Step 4: Implement src/models.ts** (полный код)

~~~~ts
export type ModelKind = "deepseek" | "custom";

export interface ModelOption {
  id: string;
  name?: string;
}

export interface ModelConnection {
  routeId: string;
  kind: ModelKind;
  displayName: string;
  baseURL?: string;
  hasKey: boolean;
  models: string[];
  isDefault: boolean;
}

export const DEEPSEEK_OFFICIAL_ROUTE = "deepseek-official";
export const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";

/** Official DeepSeek catalog pinned to dsh 0.1.2-rc.1 (dsh-llm-deepseek).
 *  The engine exposes no in-process list for this fixed route; sync this
 *  constant with the engine catalog on a dsh upgrade. */
export const DEEPSEEK_OFFICIAL_MODELS: ModelOption[] = [
  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" }
];

const ROUTE_ID_RE = /^[a-z][a-z0-9-]*$/;

export function routeIdFromName(name: string): string | null {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug === "" || slug.length > 63 || !ROUTE_ID_RE.test(slug)) return null;
  return slug;
}

export function refNameForRoute(route: string): string {
  return "BALBES_" + route.replace(/-/g, "_").toUpperCase() + "_API_KEY";
}

export function validateBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseModelIds(raw: string[]): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const id = item.trim();
    if (id === "" || /[\s,]/.test(id) || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function validateCustomPayload(p: {
  displayName?: unknown; baseURL?: unknown; key?: unknown; models?: unknown;
}): { displayName: string; baseURL?: string; key?: string; models: string[] }
  | { error: "invalid-display-name" | "invalid-url" | "invalid-key" | "invalid-models" } {
  if (typeof p.displayName !== "string" || p.displayName.trim() === "") return { error: "invalid-display-name" };
  if (p.baseURL !== undefined && p.baseURL !== null && p.baseURL !== "" && (typeof p.baseURL !== "string" || !validateBaseUrl(p.baseURL))) return { error: "invalid-url" };
  if (p.key !== undefined && p.key !== null && p.key !== "" && typeof p.key !== "string") return { error: "invalid-key" };
  const models = parseModelIds(Array.isArray(p.models) ? p.models : []);
  if (models === null) return { error: "invalid-models" };
  const out: { displayName: string; baseURL?: string; key?: string; models: string[] } = {
    displayName: p.displayName.trim(),
    models
  };
  if (typeof p.baseURL === "string" && p.baseURL !== "") out.baseURL = p.baseURL;
  if (typeof p.key === "string" && p.key !== "") out.key = p.key;
  return out;
}
~~~~

- [ ] **Step 5: Run tests, expect pass** (pnpm --filter dsh-balbes-models test)
- [ ] **Step 6: Typecheck (pnpm --filter dsh-balbes-models typecheck) + commit**
Commit: feat(models): scaffold plugin package with domain model

---

### Task 2: Ручки плагина поверх engine-сервисов (unit)

**Files:**
- Modify: packages/plugins/dsh-balbes-models/src/models.ts (добавить чистые помощники mergeCustomRoute / withoutRoute)
- Modify: packages/plugins/dsh-balbes-models/src/index.ts (полный плагин: 4 роута + структурные типы сервисов)
- Create: packages/plugins/dsh-balbes-models/tests/index.test.ts (fake-сервисы; паттерн dsh-balbes-workspaces/tests/index.test.ts)

**Structural service slices (через ctx.get; имена проверены по d.ts 0.1.2-rc.1):**
- settings: { get(ns): unknown; update(ns, patch: object): Promise<void>; replace(ns, section: object): Promise<void> } — сервис "settings"; секция "llm-pi-ai" = { providers: Record<string, ProviderRoute> }, роут = { displayName, baseURL?, api, apiKeyEnv, models: [{ id, name? }] }
- credentials: { describe(ref): Promise<{ configured: boolean; writable: boolean }>; set(ref, value): Promise<void>; unset(ref): Promise<void> } — сервис "credentials"
- agentDefaultModel: { currentSelection(): { provider, model }; saveSelection(next): Promise<void> } — сервис "agentDefaultModel"

**Роуты:** POST /api/models/list|save|delete|default (bearer). Error codes: invalid-display-name, invalid-url, invalid-key, invalid-models, invalid-route, route-exists (409), not-found (404), reserved (400), default-in-use (409), invalid-model (400).

- [ ] **Step 1: Write failing tests (tests/index.test.ts)** — fake-сервисы и хелпер call(route, body):

~~~~ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { apply, name, inject } from "../src/index.js";

interface Seat { path: string; auth: string; handler(req: unknown, res: unknown, body: unknown): Promise<void> | void; }

class FakeSettings {
  sections: Record<string, unknown> = {};
  get(ns: string): unknown { return this.sections[ns]; }
  async update(ns: string, patch: object): Promise<void> {
    const cur = (this.sections[ns] ?? {}) as { providers?: Record<string, unknown> };
    const p = patch as { providers?: Record<string, unknown> };
    this.sections[ns] = { ...cur, providers: { ...(cur.providers ?? {}), ...(p.providers ?? {}) } };
  }
  async replace(ns: string, section: object): Promise<void> { this.sections[ns] = section; }
}
class FakeCredentials {
  refs = new Map<string, string>();
  async describe(ref: string) { return { configured: this.refs.has(ref), writable: true }; }
  async set(ref: string, value: string) { this.refs.set(ref, value); }
  async unset(ref: string) { this.refs.delete(ref); }
}
class FakeDefaultModel {
  current = { provider: "deepseek-official", model: "deepseek-v4-flash" };
  currentSelection() { return this.current; }
  async saveSelection(next: { provider: string; model: string }) { this.current = next; }
}

let seats: Seat[];
let settings: FakeSettings;
let credentials: FakeCredentials;
let agentDefaultModel: FakeDefaultModel;
const http = { post(path: string, auth: string, handler: Seat["handler"]) { seats.push({ path, auth, handler }); } };

const ctx = {
  get(key: string): unknown {
    return key === "balbesHttp" ? http
      : key === "settings" ? settings
      : key === "credentials" ? credentials
      : key === "agentDefaultModel" ? agentDefaultModel
      : undefined;
  },
  logger: { warn(_m: string) {} }
};

async function call(route: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const seat = seats.find((s) => s.path === route);
  if (!seat) throw new Error("no seat " + route);
  const res = { status: 0, payload: "" };
  await seat.handler({}, {
    writeHead(status: number) { res.status = status; },
    end(body?: string) { res.payload = String(body ?? ""); },
    write() { return true; }, on() {}, destroyed: false, writableEnded: false
  }, body);
  return { status: res.status, json: JSON.parse(res.payload) };
}

describe("balbes-models plugin", () => {
  beforeEach(() => {
    seats = [];
    settings = new FakeSettings();
    credentials = new FakeCredentials();
    agentDefaultModel = new FakeDefaultModel();
  });

  it("exposes name/inject/apply contract and registers four bearer routes", () => {
    expect(name).toBe("balbes-models");
    expect(inject).toEqual(["balbesHttp"]);
    apply(ctx as never, {});
    expect(seats.map((s) => s.path).sort()).toEqual([
      "/api/models/delete", "/api/models/default", "/api/models/list", "/api/models/save"
    ]);
    for (const s of seats) expect(s.auth).toBe("bearer");
  });

  it("list returns the pinned deepseek connection as default without a key", async () => {
    apply(ctx as never, {});
    const { status, json } = await call("/api/models/list", {});
    expect(status).toBe(200);
    const body = json as { connections: Array<{ routeId: string; kind: string; hasKey: boolean; models: string[]; isDefault: boolean }> };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({ routeId: "deepseek-official", kind: "deepseek", hasKey: false, isDefault: true });
    expect(body.connections[0].models).toContain("deepseek-v4-flash");
  });

  it("save custom writes the pi-ai route and the key ref", async () => {
    apply(ctx as never, {});
    const saved = await call("/api/models/save", {
      kind: "custom", displayName: "My Gateway", baseURL: "https://gw.example/v1", key: "sk-abc", models: ["m-1", "m-2"]
    });
    expect(saved.status).toBe(200);
    const section = settings.get("llm-pi-ai") as { providers: Record<string, any> };
    const route = section.providers["my-gateway"] as any;
    expect(route).toMatchObject({ displayName: "My Gateway", baseURL: "https://gw.example/v1", apiKeyEnv: "BALBES_MY_GATEWAY_API_KEY" });
    expect(route.models).toEqual([{ id: "m-1" }, { id: "m-2" }]);
    expect(credentials.refs.get("BALBES_MY_GATEWAY_API_KEY")).toBe("sk-abc");
  });

  it("save with a taken route id -> 409 route-exists", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://x", models: ["m"] });
    const dup = await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://y", models: ["m"] });
    expect(dup.status).toBe(409);
  });

  it("deepseek save only edits the official key ref", async () => {
    apply(ctx as never, {});
    const res = await call("/api/models/save", { kind: "deepseek", key: "sk-new" });
    expect(res.status).toBe(200);
    expect(credentials.refs.get("DEEPSEEK_API_KEY")).toBe("sk-new");
  });

  it("delete custom removes route + ref; delete deepseek -> 400 reserved", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://x", key: "k", models: ["m"] });
    const gone = await call("/api/models/delete", { routeId: "my-gateway" });
    expect(gone.status).toBe(200);
    expect((settings.get("llm-pi-ai") as { providers: Record<string, unknown> }).providers["my-gateway"]).toBeUndefined();
    expect(credentials.refs.has("BALBES_MY_GATEWAY_API_KEY")).toBe(false);
    const reserved = await call("/api/models/delete", { routeId: "deepseek-official" });
    expect(reserved.status).toBe(400);
    expect((reserved.json as { error: { code: string } }).error.code).toBe("reserved");
  });

  it("default model can be switched to a custom connection model and back", async () => {
    apply(ctx as never, {});
    await call("/api/models/save", { kind: "custom", displayName: "My Gateway", baseURL: "https://x", models: ["m-1"] });
    const setDefault = await call("/api/models/default", { provider: "my-gateway", model: "m-1" });
    expect(setDefault.status).toBe(200);
    expect(agentDefaultModel.current).toEqual({ provider: "my-gateway", model: "m-1" });
    const bad = await call("/api/models/default", { provider: "my-gateway", model: "nope" });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: { code: string } }).error.code).toBe("invalid-model");
  });
});
~~~~

- [ ] **Step 2: Run, expect fail** (роутов ещё нет)
- [ ] **Step 3: Implement src/index.ts** — полный плагин (код ниже; общий список соединений вынести в readConnections(credentials, settings, defaultModel), из неё же брать default для delete-проверки; маршрутизация роутов и send/fail — как в шаблоне)

~~~~ts
import z from "@deepseek-ai/schemastery";
import {
  ModelConnection, DEEPSEEK_OFFICIAL_ROUTE, DEEPSEEK_API_KEY_REF,
  DEEPSEEK_OFFICIAL_MODELS, routeIdFromName, refNameForRoute, validateCustomPayload
} from "./models.js";

export const name = "balbes-models";
export const inject = ["balbesHttp"];
export const Config = z.object({});

interface HttpSeatLike {
  post(path: string, auth: "public" | "bearer", handler: (req: unknown, res: unknown, body: unknown) => Promise<void> | void): void;
}
interface SettingsLike {
  get(ns: string): unknown;
  update(ns: string, patch: object): Promise<void>;
  replace(ns: string, section: object): Promise<void>;
}
interface CredentialsLike {
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}
interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string };
  saveSelection(next: { provider: string; model: string }): Promise<void>;
}
interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
  write(chunk: string): boolean;
  on(event: string, listener: () => void): unknown;
  destroyed: boolean;
  writableEnded: boolean;
}

const LLM_PI_AI_NS = "llm-pi-ai";
const CUSTOM_WIRE_API = "chat"; // pi-ai wire protocol for OpenAI-compatible routes

function send(res: ResLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload))
  });
  res.end(payload);
}
function fail(res: ResLike, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}
function routeProviders(settings: SettingsLike): Record<string, unknown> {
  const section = settings.get(LLM_PI_AI_NS) as { providers?: Record<string, unknown> } | undefined;
  return section?.providers ?? {};
}
function modelIdsOf(entry: unknown): string[] {
  const models = (entry as { models?: Array<{ id?: string }> })?.models;
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const m of models) if (typeof m?.id === "string") ids.push(m.id);
  return ids;
}
async function readConnections(
  credentials: CredentialsLike,
  settings: SettingsLike,
  defaultModel: AgentDefaultModelLike
): Promise<ModelConnection[]> {
  const selection = defaultModel.currentSelection();
  const providers = routeProviders(settings);
  const out: ModelConnection[] = [{
    routeId: DEEPSEEK_OFFICIAL_ROUTE,
    kind: "deepseek",
    displayName: "DeepSeek (официальный)",
    hasKey: (await credentials.describe(DEEPSEEK_API_KEY_REF)).configured,
    models: DEEPSEEK_OFFICIAL_MODELS.map((m) => m.id),
    isDefault: selection.provider === DEEPSEEK_OFFICIAL_ROUTE
  }];
  for (const [route, entry] of Object.entries(providers)) {
    if (route === DEEPSEEK_OFFICIAL_ROUTE) continue;
    const e = entry as { displayName?: string; baseURL?: string; apiKeyEnv?: string };
    const hasKey = typeof e.apiKeyEnv === "string" && (await credentials.describe(e.apiKeyEnv)).configured;
    const connection: ModelConnection = {
      routeId: route,
      kind: "custom",
      displayName: e.displayName ?? route,
      hasKey,
      models: modelIdsOf(entry),
      isDefault: selection.provider === route
    };
    if (typeof e.baseURL === "string" && e.baseURL !== "") connection.baseURL = e.baseURL;
    out.push(connection);
  }
  return out;
}

export function apply(ctx: { get(key: string): unknown; logger: { warn(m: string): void } }, _config: unknown): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-models: balbesHttp service missing; routes not registered");
    return;
  }
  const settings = ctx.get("settings") as SettingsLike;
  const credentials = ctx.get("credentials") as CredentialsLike;
  const defaultModel = ctx.get("agentDefaultModel") as AgentDefaultModelLike;

  http.post("/api/models/list", "bearer", async (_req, res) => {
    try {
      send(res, 200, { connections: await readConnections(credentials, settings, defaultModel), default: defaultModel.currentSelection() });
    } catch (error) {
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });

  http.post("/api/models/save", "bearer", async (_req, res, body) => {
    try {
      const b = body as { routeId?: unknown; kind?: unknown; key?: unknown; displayName?: unknown; baseURL?: unknown; models?: unknown };
      if (b.kind === "deepseek") {
        if (typeof b.key !== "string" || b.key.trim() === "") return fail(res, 400, "invalid-key", "key is required");
        await credentials.set(DEEPSEEK_API_KEY_REF, b.key.trim());
        send(res, 200, { connection: (await readConnections(credentials, settings, defaultModel)).find((c) => c.routeId === DEEPSEEK_OFFICIAL_ROUTE) });
        return;
      }
      if (b.kind !== "custom") return fail(res, 400, "invalid-route", "kind must be deepseek or custom");
      const payload = validateCustomPayload({ displayName: b.displayName, baseURL: b.baseURL, key: b.key, models: b.models });
      if ("error" in payload) return fail(res, 400, payload.error, "invalid custom connection payload");
      const editing = typeof b.routeId === "string" && b.routeId !== "" && b.routeId !== DEEPSEEK_OFFICIAL_ROUTE;
      const route = editing ? b.routeId : routeIdFromName(payload.displayName);
      if (route === null || route === DEEPSEEK_OFFICIAL_ROUTE || !/^[a-z][a-z0-9-]*$/.test(route)) {
        return fail(res, 400, "invalid-route", "bad route id");
      }
      const providers = routeProviders(settings);
      if (!editing && providers[route] !== undefined) return fail(res, 409, "route-exists", "route " + route + " already exists");
      const apiKeyEnv = refNameForRoute(route);
      const routeConfig: Record<string, unknown> = {
        displayName: payload.displayName,
        api: CUSTOM_WIRE_API,
        apiKeyEnv,
        models: payload.models.map((id) => ({ id }))
      };
      if (payload.baseURL !== undefined) routeConfig.baseURL = payload.baseURL;
      await settings.update(LLM_PI_AI_NS, { providers: { [route]: routeConfig } });
      if (typeof payload.key === "string" && payload.key !== "") await credentials.set(apiKeyEnv, payload.key);
      const connection = (await readConnections(credentials, settings, defaultModel)).find((c) => c.routeId === route);
      send(res, 200, { connection });
    } catch (error) {
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });

  http.post("/api/models/delete", "bearer", async (_req, res, body) => {
    try {
      const route = (body as { routeId?: unknown }).routeId;
      if (typeof route !== "string" || route === "") return fail(res, 400, "invalid-route", "routeId required");
      if (route === DEEPSEEK_OFFICIAL_ROUTE) return fail(res, 400, "reserved", "deepseek-official cannot be deleted");
      const providers = routeProviders(settings);
      if (providers[route] === undefined) return fail(res, 404, "not-found", "route " + route + " not found");
      const selection = defaultModel.currentSelection();
      if (selection.provider === route) return fail(res, 409, "default-in-use", "change the default model first");
      const next: Record<string, unknown> = { ...providers };
      delete next[route];
      const section = settings.get(LLM_PI_AI_NS) as Record<string, unknown> | undefined;
      await settings.replace(LLM_PI_AI_NS, { ...(section ?? {}), providers: next });
      await credentials.unset(refNameForRoute(route));
      send(res, 200, {});
    } catch (error) {
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });

  http.post("/api/models/default", "bearer", async (_req, res, body) => {
    try {
      const b = body as { provider?: unknown; model?: unknown };
      const provider = typeof b.provider === "string" ? b.provider : "";
      const model = typeof b.model === "string" ? b.model : "";
      const connection = (await readConnections(credentials, settings, defaultModel)).find((c) => c.routeId === provider);
      if (connection === undefined) return fail(res, 400, "invalid-route", "no such provider connection");
      if (!connection.models.includes(model)) return fail(res, 400, "invalid-model", "model " + model + " is not offered by " + provider);
      await defaultModel.saveSelection({ provider, model });
      send(res, 200, { default: { provider, model } });
    } catch (error) {
      fail(res, 500, "internal", error instanceof Error ? error.message : String(error));
    }
  });
}
~~~~

- [ ] **Step 4: Run unit tests, expect pass** (pnpm --filter dsh-balbes-models test)
- [ ] **Step 5: typecheck + commit**
Commit: feat(models): register models.* bearer routes over engine settings/credentials

---

### Task 3: Типы контрактов в dsh-balbes-contracts

**Files:**
- Modify: packages/contracts/src/index.ts (append после WorkspaceEvent)

**Interfaces (produces для Task 6):** ModelsListRequest/Response, ModelsSaveRequest/Response, ModelsDeleteRequest/Response, ModelsDefaultRequest/Response, ModelConnection, ModelKind — зеркалят §4 спеки и src/models.ts.

- [ ] **Step 1: Append types**

~~~~ts
export type ModelKind = "deepseek" | "custom";

export interface ModelConnection {
  routeId: string;
  kind: ModelKind;
  displayName: string;
  baseURL?: string;
  hasKey: boolean;
  models: string[];
  isDefault: boolean;
}

export interface ModelsListRequest {}
export interface ModelsListResponse {
  connections: ModelConnection[];
  default: { provider: string; model: string };
}

export interface ModelsSaveRequest {
  routeId?: string;
  kind: ModelKind;
  displayName?: string;
  baseURL?: string;
  key?: string;
  models?: string[];
}
export interface ModelsSaveResponse {
  connection: ModelConnection;
}

export interface ModelsDeleteRequest {
  routeId: string;
}
export interface ModelsDeleteResponse {}

export interface ModelsDefaultRequest {
  provider: string;
  model: string;
}
export interface ModelsDefaultResponse {
  default: { provider: string; model: string };
}
~~~~

- [ ] **Step 2: Typecheck** (pnpm --filter dsh-balbes-contracts typecheck, либо корневой pnpm typecheck), expect pass
- [ ] **Step 3: Commit** — feat(contracts): add models API shapes

---

### Task 4: REAL-композиция ручек models.* (boot через Loader/app)

> Паттерн — dsh-balbes-workspaces/tests/integration.test.ts. Требует глобального dsh и RUN_REAL=1. REAL-тест валидирует форму роутов движком (api: chat, apiKeyEnv, models): если движок отклоняет поле — ошибка при save назовёт проблемный ключ; исправить объект роута в src/index.ts и прогнать снова (evidence-driven).

**Files:**
- Create: packages/plugins/dsh-balbes-models/tests/fixtures/balbes-models-profile/package.json (по образцу balbes-workspaces-profile; name dsh-profile-balbes-models-test; bundles ["@deepseek-ai/dsh-base", "dsh-balbes-host"])
- Create: packages/plugins/dsh-balbes-models/tests/fixtures/balbes-models-profile/cordis.patch.yml:

~~~~yaml
- insert:
    - id: balbes-models
      name: 'dsh-balbes-models'
~~~~

- Create: packages/plugins/dsh-balbes-models/tests/integration.test.ts (по образцу workspaces integration.test.ts: buildPackages для models (tsconfig.build.json) и host (tsconfig.json); копия host (lib/package.json/cordis.patch.yml) и models (lib/package.json) в temp profile node_modules; createAdminAuth/writeAdminAuth импортируются из ../../../bundles/dsh-balbes-host/src/core.js; freePort; spawn dsh --profile balbes-models-test c DSH_HOME; waitForHealth; login)

- [ ] **Step 1: Write the failing REAL test** (основные проверки; полный бойлерплейт скопировать из workspaces integration.test.ts)

~~~~ts
describe.skipIf(!realEnabled)("REAL composition (models API)", () => {
  // beforeAll (240s): buildPackages; freePort; mkdtemp home; profile fixture в
  //   home/profiles/balbes-models-test; копии host+models в node_modules;
  //   creds = await createAdminAuth(); await writeAdminAuth(home, creds);
  // bootServer(): spawn("dsh", ["--profile", "balbes-models-test"], {env:{...process.env, DSH_HOME: home, BALBES_PORT: String(port), DSH_TELEMETRY_DISABLED: "1"}, cwd: home}); waitForHealth; login -> token
  // afterAll: SIGKILL child; rm home

  it("models API: auth, save custom connection, engine state on disk, delete, default", async () => {
    const token = await bootServer();
    const base = "http://127.0.0.1:" + port;

    expect((await postJson(base + "/api/models/list", {})).status).toBe(401);
    expect((await postJson(base + "/api/models/save", { kind: "custom", displayName: "X" })).status).toBe(401);

    const empty = await postJson(base + "/api/models/list", {}, token);
    expect(empty.status).toBe(200);
    const body = empty.json as { connections: Array<{ routeId: string; kind: string; hasKey: boolean; models: string[]; isDefault: boolean }>; default: { provider: string; model: string } };
    expect(body.default).toEqual({ provider: "deepseek-official", model: "deepseek-v4-flash" });
    const ds = body.connections.find((c) => c.routeId === "deepseek-official");
    expect(ds?.kind).toBe("deepseek");
    expect(ds?.hasKey).toBe(false);
    expect(ds?.models).toContain("deepseek-v4-flash");
    expect(ds?.isDefault).toBe(true);

    const saved = await postJson(base + "/api/models/save", {
      kind: "custom", displayName: "My Gateway", baseURL: "https://gw.example/v1", key: "sk-abc", models: ["m-1", "m-2"]
    }, token);
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);

    const settingsYaml = await readFile(join(home, "settings.yaml"), "utf8");
    expect(settingsYaml).toContain("my-gateway");
    expect(settingsYaml).toContain("apiKeyEnv: BALBES_MY_GATEWAY_API_KEY");
    const credsYaml = await readFile(join(home, ".credentials.yaml"), "utf8");
    expect(credsYaml).toContain("BALBES_MY_GATEWAY_API_KEY: sk-abc");

    const listed = await postJson(base + "/api/models/list", {}, token);
    const gw = (listed.json as { connections: Array<{ routeId: string; hasKey: boolean; models: string[] }> }).connections.find((c) => c.routeId === "my-gateway");
    expect(gw?.hasKey).toBe(true);
    expect(gw?.models).toEqual(["m-1", "m-2"]);

    const setDefault = await postJson(base + "/api/models/default", { provider: "my-gateway", model: "m-1" }, token);
    expect(setDefault.status).toBe(200);
    const afterDefault = await postJson(base + "/api/models/list", {}, token);
    expect((afterDefault.json as { default: { provider: string } }).default.provider).toBe("my-gateway");

    const blocked = await postJson(base + "/api/models/delete", { routeId: "my-gateway" }, token);
    expect(blocked.status).toBe(409);
    expect((blocked.json as { error: { code: string } }).error.code).toBe("default-in-use");

    await postJson(base + "/api/models/default", { provider: "deepseek-official", model: "deepseek-v4-flash" }, token);
    const deleted = await postJson(base + "/api/models/delete", { routeId: "my-gateway" }, token);
    expect(deleted.status).toBe(200);
    const settingsAfter = await readFile(join(home, "settings.yaml"), "utf8");
    expect(settingsAfter).not.toContain("my-gateway");

    const reserved = await postJson(base + "/api/models/delete", { routeId: "deepseek-official" }, token);
    expect(reserved.status).toBe(400);
    expect((reserved.json as { error: { code: string } }).error.code).toBe("reserved");
  }, 240_000);
});
~~~~

- [ ] **Step 2: Run** — RUN_REAL=1 pnpm --filter dsh-balbes-models test → итерировать форму роута до 200 на save; затем полный проход
- [ ] **Step 3: Commit** — test(models): REAL composition for models.* API

---

### Task 5: Профиль, установщик и CI

**Files:**
- Modify: profiles/balbes/cordis.patch.yml (insert balbes-models рядом с balbes-workspaces)
- Modify: scripts/install.sh (копирование собранного пакета: по образцу copy_workspaces_into_profile, строки ~402-407, вызов ~582-583; заголовочный комментарий ~11-13; убедиться, что секция сборки workspace перечисляет новый пакет)
- Modify: .github/workflows/ci.yml (блок копии после строк про workspaces ~55-59)
- Modify: docs/runbooks/stage2-vps.md (список копируемых пакетов + smoke models.list)

- [ ] **Step 1: Profile patch** — под insert balbes-workspaces добавить:

~~~~yaml
    - id: balbes-models
      name: 'dsh-balbes-models'
~~~~

- [ ] **Step 2: install.sh** — функция по образцу copy_workspaces_into_profile():

~~~~bash
# copy_models_into_profile — собранный плагин моделей реальным каталогом в
# node_modules профиля (как workspaces)
copy_models_into_profile() {
    local src="$REPO_DIR/packages/plugins/dsh-balbes-models"
    local dst="$profile_dir/node_modules/dsh-balbes-models"
    rm -rf "$dst"
    cp -R "$src" "$dst"
}
~~~~

и вызов copy_models_into_profile после copy_workspaces_into_profile.

- [ ] **Step 3: CI** — после копии workspaces добавить (по образцу):

~~~~yaml
          cp -R packages/plugins/dsh-balbes-models "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-models"
          rm -f "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-models/tsconfig.json"                 "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-models/tsconfig.build.json"
          rm -rf "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-models/tests"                  "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-models/src"
~~~~

- [ ] **Step 4: Runbook** — в раздел smoke добавить:

~~~~bash
# models.list (JWT из входа)
curl -sS -X POST http://IP:8080/api/models/list -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
# ожидается: { connections: [ { routeId: "deepseek-official", kind: "deepseek", hasKey: true, ... } ], default: { provider: "deepseek-official", model: "deepseek-v4-flash" } }
~~~~

- [ ] **Step 5: Проверки + commit**
Run: bash -n scripts/install.sh; pnpm --filter dsh-balbes-host test (без RUN_REAL скипается) — нет регресса.
Commit: feat: wire balbes-models into profile, installer and CI

---

### Task 6: SPA — методы клиента models.*

**Files:**
- Modify: packages/frontend/dsh-balbes-admin/src/api/client.ts
- Modify: packages/frontend/dsh-balbes-admin/tests/client.test.ts

**Interfaces:** Consumes типы Task 3. Produces методы AdminApi: listModels(): Promise<ModelsListResponse>; saveModel(req: ModelsSaveRequest): Promise<ModelsSaveResponse>; deleteModel(routeId: string): Promise<ModelsDeleteResponse>; setDefaultModel(provider: string, model: string): Promise<ModelsDefaultResponse>.

- [ ] **Step 1: Failing client tests** (append в client.test.ts)

~~~~ts
import type { ModelsSaveRequest } from "dsh-balbes-contracts";

it("listModels POSTs to /api/models/list", async () => {
  localStorage.setItem("balbes.authToken", "tok-1");
  const body = { connections: [{ routeId: "deepseek-official", kind: "deepseek", displayName: "D", hasKey: true, models: ["deepseek-v4-flash"], isDefault: true }], default: { provider: "deepseek-official", model: "deepseek-v4-flash" } };
  const fetchMock = mockFetchOnce(200, body);
  vi.stubGlobal("fetch", fetchMock);
  const api = createApiClient();
  const res = await api.listModels();
  expect(res.connections[0]?.routeId).toBe("deepseek-official");
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/models/list");
  expect(init.method).toBe("POST");
});

it("saveModel/deleteModel/setDefaultModel post the right bodies", async () => {
  localStorage.setItem("balbes.authToken", "tok-1");
  const seen: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ path: String(_url), body: JSON.parse(String(init?.body)) });
    return { ok: true, status: 200, json: async () => ({}) };
  }));
  const api = createApiClient();
  const req: ModelsSaveRequest = { kind: "custom", displayName: "GW", baseURL: "https://g/v1", key: "sk", models: ["m"] };
  await api.saveModel(req);
  await api.deleteModel("gw");
  await api.setDefaultModel("gw", "m");
  expect(seen).toEqual([
    { path: "/api/models/save", body: req },
    { path: "/api/models/delete", body: { routeId: "gw" } },
    { path: "/api/models/default", body: { provider: "gw", model: "m" } }
  ]);
});
~~~~

- [ ] **Step 2: Run, expect fail** (методов нет)
- [ ] **Step 3: Implement client** — импорты типов; 4 метода в AdminApi и в createApiClient:

~~~~ts
listModels: () => guard(request<ModelsListResponse>("/api/models/list", {})),
saveModel: (req) => guard(request<ModelsSaveResponse>("/api/models/save", req satisfies ModelsSaveRequest)),
deleteModel: (routeId) => guard(request<ModelsDeleteResponse>("/api/models/delete", { routeId } satisfies ModelsDeleteRequest)),
setDefaultModel: (provider, model) => guard(request<ModelsDefaultResponse>("/api/models/default", { provider, model } satisfies ModelsDefaultRequest))
~~~~

- [ ] **Step 4: Run, pass; commit** — feat(admin): add models API client methods

---

### Task 7: SPA — навигация (Sidebar/App/Topbar)

**Files:**
- Modify: packages/frontend/dsh-balbes-admin/src/components/Sidebar.tsx (группа «Управление»: заменить ghost «Ключи» на { id: "models", label: "Модели", soon: false })
- Modify: packages/frontend/dsh-balbes-admin/src/App.tsx (type Page = "test" | "workspaces" | "models"; импорт ModelsPage; title Topbar «Модели»; ветка page === "models")
- Modify: packages/frontend/dsh-balbes-admin/tests/Sidebar.test.tsx, tests/App.test.tsx

- [ ] **Step 1: Failing tests**

~~~~tsx
// Sidebar.test.tsx
it("«Модели» is a live item under Управление", () => {
  const spy = vi.fn();
  render(<Sidebar active="test" onNavigate={spy} />);
  const item = screen.getByRole("button", { name: "Модели" });
  expect(item).toBeTruthy();
  fireEvent.click(item);
  expect(spy).toHaveBeenCalledWith("models");
});

// App.test.tsx: после me() успеха клик «Модели» рендерит data-testid models-page
~~~~

- [ ] **Step 2: Run, expect fail**
- [ ] **Step 3: Implement** (правки выше; ModelsPage импортируется и рендерится)
- [ ] **Step 4: Run, pass; commit** — feat(admin): add Models nav item and route

---

### Task 8: SPA — страница «Модели»

**Files:**
- Create: packages/frontend/dsh-balbes-admin/src/pages/ModelsPage.tsx
- Create: packages/frontend/dsh-balbes-admin/tests/ModelsPage.test.tsx
- Modify: packages/frontend/dsh-balbes-admin/src/styles.css (карточки/чипы/ошибки — минимально, по образцу)

**Interfaces:** Consumes AdminApi (Task 6), Modal (components/Modal.tsx), типы ModelConnection/ModelKind (contracts). data-testid: models-page, model-connection:<routeId>, default-model-select, models-add, model-delete-confirm, key-input, connection-errors.

- [ ] **Step 1: Failing page tests** — fake AdminApi (по образцу WorkspacesPage.test.tsx: makeApi с новыми методами; stateful список соединений):

Тесты: (1) карточка deepseek закреплена (нет «Удалить», есть «Изменить ключ») и пустое состояние «Добавьте провайдера с ключом»; (2) селект дефолтной модели: опции deepseek; после добавления custom — его модели; выбор вызывает setDefaultModel и обновляет UI; (3) «+ Добавить» → модалка: вид OpenAI-совместимый → поля displayName/baseURL/key/models; submit вызывает saveModel, список обновляется; серверная ошибка показывается в connection-errors; (4) «⋮» → Удалить → модальное подтверждение → deleteModel; для deepseek пункта «Удалить» нет.

- [ ] **Step 2: Run, expect fail**
- [ ] **Step 3: Implement** — компонент по структуре:

~~~~tsx
export default function ModelsPage({ api }: { api: AdminApi }) {
  // state: list (ModelsListResponse | null), error (string|null),
  //   editing: ModelConnection | "new-deepseek" | "new-custom" | null,
  //   confirming: ModelConnection | null
  // useEffect: api.listModels() -> setList (401 логинит клиент сам)
  // header: <select data-testid="default-model-select"> — опции сгруппированы по
  //   connection (value = provider + "|" + model); onChange -> api.setDefaultModel -> refresh
  // кнопка «+ Добавить» (data-testid="models-add") -> setEditing("new-custom")
  // карточки соединений (data-testid="model-connection:" + routeId):
  //   deepseek: «DeepSeek (официальный)», ключ «••••»/«не задан», кнопка «Изменить ключ»;
  //   custom: displayName, baseURL, ключ, чипы моделей, «⋮» меню: Изменить / Удалить
  // модалки (компонент Modal): добавление/редактирование (форма по kind: deepseek — только
  //   ключ; custom — displayName/baseURL/key/models; ошибки в connection-errors) и
  //   подтверждение удаления (data-testid="model-delete-confirm")
}
~~~~

Стиль — по WorkspacesPage (русские строки; классы в styles.css). После — pnpm --filter dsh-balbes-admin test.

- [ ] **Step 4: Run, pass; commit** — feat(admin): add Models page (connections, keys, default model)

---

### Task 9: Верификация и canon-audit

- [ ] **Step 1: Полный прогон** — pnpm typecheck, pnpm lint (если настроен), pnpm test, RUN_REAL=1 pnpm --filter dsh-balbes-models test (локально), RUN_REAL=1 pnpm --filter dsh-balbes-host test, bash -n scripts/install.sh
- [ ] **Step 2: canon-audit** по теме моделей (скилл canon-audit: validate + scout + semantic pass; расхождения — через dialogue)
- [ ] **Step 3: Коммит оставшихся правок** и отчёт владельцу: server verification по runbook (перезапуск scripts/install.sh на VPS + smoke models.list из Task 5 Step 4)
