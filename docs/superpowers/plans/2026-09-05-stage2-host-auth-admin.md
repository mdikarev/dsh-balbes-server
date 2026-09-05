# Этап 2: собственный host + авторизация + админка-срез «одна кнопка» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Получить на VPS сервер-демон `dsh --profile balbes` (dsh-base + собственный `dsh-balbes-host` вместо headless) с HTTP-админкой: вход по сгенерированным логину/паролю (JWT), одна кнопка «тестовый промпт» → ответ LLM над кнопкой; установка/обновление одной командой, автозапуск systemd.

**Architecture:** Один процесс dsh (B1). `dsh-balbes-host` — Cordis-бандл в `packages/bundles/` (по образцу `dsh-headless`): собственный `cordis.patch.yml` + плагины `startup`/`server`/`static`/`auth`/`api` (экспортные подпути). Админка — НЕ плагин dsh, а React SPA (`packages/frontend/dsh-balbes-admin`), собираемая Vite в статику, которую раздаёт host из `$DSH_HOME/balbes/ui`. Связь — только HTTP: все `/api/*` POST (R-API-1), JWT на каждом хендлере кроме login/health. Контракты типов — пакет `dsh-balbes-contracts`. Установка: VPS собирает из клона репо (root pnpm workspace), host копируется реальным каталогом в `node_modules` профиля (резолв `@deepseek-ai/*` подъёмом к зеркалу), SPA — в `$DSH_HOME/balbes/ui`; systemd-юнит с автозапуском.

**Tech Stack:** TypeScript (strict, ESM), node:http / node:crypto (scrypt, HMAC HS256), Cordis (плагины, патчи), dsh 0.1.2-rc.1 (`dsh-base`), React + Vite (SPA), vitest + React Testing Library, bash (install.sh), systemd, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-mvp-design.md` раздел 9 «Этап 2» (все решения 9.1–9.5).

## Global Constraints

- dsh — зависимость, не форк: установленные `@deepseek-ai/*` не редактируются, ядро не обходится; надстройка — только штатные швы (сервисы/события Cordis, патчи Loader).
- `docs/canon/**` вручную не редактируется (только canon-write); этот план canon не трогает.
- Секреты не попадают в git; CI без ключей; автотесты в модель не ходят (R-TEST-1): LLM мокается как HTTP-эндпоинт, fetch в SPA мокается.
- Правила репозитория: R-API-1 (все `/api/*` — POST), контракты-типы в `dsh-balbes-contracts`, именование пакетов `dsh-balbes-<роль>` (неймспейс `@deepseek-ai` не занимаем).
- Манифест пакета: `"type": "module"`, `main: "lib/index.js"`, `types: "lib/types/index.d.ts"`, `exports` с подпутями и `"./package.json"`; бандл дополнительно экспортирует `"./cordis.patch.yml"`; `files` — только собранное. Функциональный плагин: именованные экспорты `name`/`inject`/`Config`/`apply`, без default-экспорта. `Config` — схема `@deepseek-ai/schemastery`.
- Регистрации — эффекты: вклад через `ctx.effect()`/`ctx.on()`, disposer откатывает; `ctx.on("dispose", ...)` — закрыть сервер.
- `@deepseek-ai/*` не тянутся из registry (версии битые) — в workspace резолвятся bootstrap-линковкой зеркала dsh (Task 1), на VPS — копией под профилем.
- Профиль `balbes`: bundles `["@deepseek-ai/dsh-base", "dsh-balbes-host"]`, `patchReload: startup`; headless удаляется; `code-runtime-worker-thread` остаётся; пустой патч-файл роняет старт — пишется `[]`.
- Node ≥ 22 (`node:sqlite`); строгий TS; ESM; файлы kebab-case, код/комментарии — английский; один коммит = одно изменение, первая строка ≤ ~72 символов.
- Учётные данные админки: `$DSH_HOME/admin-auth.json` (600), пароль — только scrypt-хэш (без открытого пароля), печать один раз при генерации; `--reset-admin-password` — сброс.

---

### Task 1: Root workspace + bootstrap-линковка ядра

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml` (root)
- Create: `tsconfig.base.json`
- Create: `scripts/link-core.mjs`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/bundles/dsh-balbes-host/package.json` (манифест-заготовка)
- Create: `packages/frontend/dsh-balbes-admin/package.json` (манифест-заготовка)

**Interfaces:**
- Consumes: существующий репо-каркас этапа 1 (`packages/bundles/.gitkeep`, `packages/plugins/.gitkeep`).
- Produces: корневые команды `pnpm typecheck` / `pnpm build` / `pnpm test`; скрипт `node scripts/link-core.mjs`, после которого из корня резолвятся `@deepseek-ai/*` (используется всеми пакетами и CI).

- [ ] **Step 1: Создать корневой workspace**

`package.json` (root):
```json
{
  "name": "dsh-balbes-server",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "scripts": {
    "typecheck": "pnpm -r --if-present run typecheck",
    "build": "pnpm -r --if-present run build",
    "test": "pnpm -r --if-present run test",
    "link:core": "node scripts/link-core.mjs"
  }
}
```

`pnpm-workspace.yaml` (root):
```yaml
packages:
  - packages/bundles/*
  - packages/plugins/*
  - packages/frontend/*
  - packages/contracts
```
(`profiles/*` намеренно НЕ участники workspace — деплой-манифесты, см. спека 9.5.4.)

- [ ] **Step 2: Создать базовый tsconfig**

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 3: Создать bootstrap-линковку ядра**

`scripts/link-core.mjs` — линкует `@deepseek-ai/*` из установки dsh в корневой `node_modules`, чтобы tsc/vitest наших пакетов видели ядро без registry:
```js
import { mkdirSync, readdirSync, symlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "node_modules", "@deepseek-ai");

function candidates() {
  const list = [];
  if (process.env.DSH_HOME) list.push(join(process.env.DSH_HOME, "profiles", "node_modules", "@deepseek-ai"));
  if (process.env.HOME) list.push(join(process.env.HOME, ".dsh", "profiles", "node_modules", "@deepseek-ai"));
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    list.push(join(g, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
  } catch { /* npm root недоступен — пробуем остальные */ }
  return list;
}

const src = candidates().find((c) => existsSync(c));
if (!src) {
  console.error("link-core: не найдено зеркало @deepseek-ai (нужен глобальный dsh или $DSH_HOME).");
  console.error("Установите: npm i -g @deepseek-ai/dsh  (CI делает это сам).");
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
mkdirSync(target, { recursive: true });
for (const name of readdirSync(src)) {
  const from = join(src, name);
  const to = join(target, name);
  if (!existsSync(to)) symlinkSync(from, to);
}
console.log(`link-core: @deepseek-ai связан из ${src}`);
```

- [ ] **Step 4: Создать манифесты-заготовки трёх пакетов**

`packages/contracts/package.json`:
```json
{
  "name": "dsh-balbes-contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```
(`main`/`types` на исходники: контракты — чистые типы, потребляются на этапе компиляции; для stage-2 сборка не нужна.)

`packages/contracts/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "tests"]
}
```

`packages/bundles/dsh-balbes-host/package.json` (полный манифест сразу, см. Task 3–7 за код):
```json
{
  "name": "dsh-balbes-host",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./startup": { "types": "./lib/types/startup.d.ts", "default": "./lib/startup.js" },
    "./server": { "types": "./lib/types/server.d.ts", "default": "./lib/server.js" },
    "./static": { "types": "./lib/types/static.d.ts", "default": "./lib/static.js" },
    "./auth": { "types": "./lib/types/auth.d.ts", "default": "./lib/auth.js" },
    "./api": { "types": "./lib/types/api.d.ts", "default": "./lib/api.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/frontend/dsh-balbes-admin/package.json`:
```json
{
  "name": "dsh-balbes-admin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0",
    "jsdom": "^25.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/user-event": "^14.5.0"
  }
}
```

- [ ] **Step 5: Проверить линковку и резолв**

Run:
```bash
pnpm install
node scripts/link-core.mjs
node -e "import('@deepseek-ai/dsh-session').then(() => console.log('core resolve ok')).catch(e => { console.error(e.message); process.exit(1); })"
```
Expected: `core resolve ok` (импорт резолвится через корневой `node_modules/@deepseek-ai`).

- [ ] **Step 6: Коммит**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json scripts/link-core.mjs \
        packages/contracts packages/bundles/dsh-balbes-host/package.json \
        packages/frontend/dsh-balbes-admin/package.json
git commit -m "add root workspace and core mirror linking"
```

---

### Task 2: Пакет контрактов `dsh-balbes-contracts`

**Files:**
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/tests/contracts.test.ts`

**Interfaces:**
- Consumes: ничего (типы, без рантайма).
- Produces: типы, импортируемые host'ом (`dsh-balbes-host/src`) и SPA: `HealthRequest/HealthResponse`, `LoginRequest/LoginResponse`, `MeRequest/MeResponse`, `PromptRequest/PromptResponse`, `ApiError`, `ApiResult<T>`.

- [ ] **Step 1: Написать типы**

`packages/contracts/src/index.ts`:
```ts
/** Пустые тела POST-запросов кодируются как {} — см. R-API-1. */

export interface HealthRequest {}
export interface HealthResponse {
  ok: true;
  version: string;
}

export interface LoginRequest {
  login: string;
  password: string;
}
export interface LoginResponse {
  token: string;
  expiresAt: string; // ISO 8601
}

export interface MeRequest {}
export interface MeResponse {
  login: string;
}

export interface PromptRequest {
  prompt: string;
}
export interface PromptResponse {
  text: string;
  reason?: {
    kind: string;
    code?: string;
    message?: string;
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiErrorBody["error"] };
```

- [ ] **Step 2: Тест формы (типы-контракты валидны и сериализуемы)**

`packages/contracts/tests/contracts.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { LoginRequest, PromptResponse } from "../src/index.js";

describe("contracts", () => {
  it("LoginRequest описывает поля login/password", () => {
    const req: LoginRequest = { login: "balbes-x", password: "secret" };
    expect(JSON.parse(JSON.stringify(req))).toEqual(req);
  });

  it("PromptResponse несёт текст и опциональный reason", () => {
    const ok: PromptResponse = { text: "ok" };
    const err: PromptResponse = { text: "", reason: { kind: "error", code: "E", message: "m" } };
    expect(ok.text).toBe("ok");
    expect(err.reason?.code).toBe("E");
  });
});
```

- [ ] **Step 3: Прогнать typecheck и тесты**

Run: `pnpm --filter dsh-balbes-contracts typecheck && pnpm --filter dsh-balbes-contracts test`
Expected: PASS (2 теста), typecheck без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add packages/contracts
git commit -m "add api contract types package"
```

---

### Task 3: Пакет host — каркас и ядро безопасности (`core.ts`)

**Files:**
- Create: `packages/bundles/dsh-balbes-host/tsconfig.json`
- Create: `packages/bundles/dsh-balbes-host/src/core.ts`
- Create: `packages/bundles/dsh-balbes-host/tests/core.test.ts`

**Interfaces:**
- Consumes: Task 1 (workspace, линковка `@deepseek-ai/*`).
- Produces (модуль `./src/core.js`, не плагин):
  - `interface AdminAuth { login: string; passwordHash: string; jwtSecret: string; createdAt: string }`
  - `interface AdminAuthWithPassword extends AdminAuth { plaintextPassword: string }`
  - `createAdminAuth(): Promise<AdminAuthWithPassword>` (пароль печатается один раз, в файл не пишется)
  - `hashPassword(password: string, salt?: Buffer): Promise<string>` → строка `scrypt$N$r$p$salt$hash` (base64url)
  - `verifyPassword(password: string, stored: string): Promise<boolean>`
  - `issueToken(jwtSecret: string, login: string, ttlSeconds?: number): { token: string; expiresAt: string }`
  - `verifyToken(jwtSecret: string, token: string): { login: string; exp: number } | null`
  - `loadAdminAuth(dir: string): Promise<AdminAuth>` (бросает с понятным сообщением на битый файл)
  - `writeAdminAuth(dir: string, auth: AdminAuth): Promise<void>` (tmp-файл 600 → rename, атомарно)
  - `defaultAdminAuthFile(dshHome: string): string` → `<dshHome>/admin-auth.json`

- [ ] **Step 1: tsconfig пакета**

`packages/bundles/dsh-balbes-host/tsconfig.json`:
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

- [ ] **Step 2: Написать падающий тест**

`packages/bundles/dsh-balbes-host/tests/core.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAdminAuth,
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  loadAdminAuth,
  writeAdminAuth,
  defaultAdminAuthFile
} from "../src/core.js";

describe("core", () => {
  it("scrypt round-trip: verifyPassword принимает верный пароль", async () => {
    const stored = await hashPassword("correct horse");
    expect(stored.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("correct horse", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
  });

  it("JWT round-trip: подпись и срок", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const { token, expiresAt } = issueToken(secret, "admin");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    const payload = verifyToken(secret, token);
    expect(payload?.login).toBe("admin");
  });

  it("JWT: изменённый токен отклоняется", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const { token } = issueToken(secret, "admin");
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(verifyToken(secret, tampered)).toBeNull();
  });

  it("credentials: пароль не хранится открытым текстом", async () => {
    const c = await createAdminAuth();
    expect(c.plaintextPassword).not.toBe(c.passwordHash);
    expect(c.plaintextPassword.length).toBeGreaterThanOrEqual(20);
    expect(c.login.startsWith("balbes-")).toBe(true);
  });

  it("admin-auth файл: атомарная запись и чтение, 600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-auth-"));
    try {
      const auth = {
        login: "balbes-abc",
        passwordHash: await hashPassword("pw"),
        jwtSecret: "0123456789abcdef0123456789abcdef",
        createdAt: new Date().toISOString()
      };
      await writeAdminAuth(dir, auth);
      const loaded = await loadAdminAuth(dir);
      expect(loaded.login).toBe(auth.login);
      expect(loaded.passwordHash).toBe(auth.passwordHash);
      const stat = await readFile(defaultAdminAuthFile(dir));
      expect(stat.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `pnpm --filter dsh-balbes-host test`
Expected: FAIL — `core.js` не существует.

- [ ] **Step 4: Реализовать `core.ts`**

`packages/bundles/dsh-balbes-host/src/core.ts`:
```ts
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

const scrypt = promisify(scryptCb);
const SCRYPT_N = 131072; // 2^17
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
const JWT_TTL_SECONDS = 24 * 60 * 60;

export interface AdminAuth {
  login: string;
  passwordHash: string;
  jwtSecret: string;
  createdAt: string;
}

export function defaultAdminAuthFile(dshHome: string): string {
  return join(dshHome, "admin-auth.json");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export async function hashPassword(password: string, salt: Buffer = randomBytes(SALT_BYTES)): Promise<string> {
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64url(salt)}$${b64url(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![n, r, p].every(Number.isInteger)) return false;
  const expected = Buffer.from(hashB64 ?? "", "base64url");
  const derived = (await scrypt(password, Buffer.from(saltB64 ?? "", "base64url"), expected.length, {
    N: n,
    r,
    p,
    maxmem: 256 * 1024 * 1024
  })) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export interface AdminAuthWithPassword extends AdminAuth {
  /** Открытый пароль — возвращается один раз вызывающей стороне и не пишется в файл. */
  plaintextPassword: string;
}

export async function createAdminAuth(): Promise<AdminAuthWithPassword> {
  const login = `balbes-${randomBytes(4).toString("hex")}`;
  const plaintextPassword = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(plaintextPassword);
  return {
    login,
    passwordHash,
    jwtSecret: randomBytes(32).toString("base64url"),
    createdAt: new Date().toISOString(),
    plaintextPassword
  };
}
```

- [ ] **Step 5: Добавить JWT-функции и файловые операции**

Дополните `core.ts`:
```ts
interface JwtHeader { alg: "HS256"; typ: "JWT" }
interface JwtPayload { sub: string; iat: number; exp: number }

function sign(secret: string, header: JwtHeader, payload: JwtPayload): string {
  const enc = (o: unknown) => b64url(JSON.stringify(o));
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function issueToken(jwtSecret: string, login: string, ttlSeconds = JWT_TTL_SECONDS): { token: string; expiresAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = { sub: login, iat: now, exp: now + ttlSeconds };
  return { token: sign(jwtSecret, { alg: "HS256", typ: "JWT" }, payload), expiresAt: new Date((now + ttlSeconds) * 1000).toISOString() };
}

export function verifyToken(jwtSecret: string, token: string): { login: string; exp: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let payload: JwtPayload;
  try {
    const header = JSON.parse(Buffer.from(h ?? "", "base64url").toString("utf8")) as JwtHeader;
    if (header.alg !== "HS256") return null;
    payload = JSON.parse(Buffer.from(p ?? "", "base64url").toString("utf8")) as JwtPayload;
  } catch {
    return null;
  }
  const expected = createHmac("sha256", jwtSecret).update(`${h}.${p}`).digest();
  const actual = Buffer.from(s ?? "", "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (payload.exp === undefined || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return { login: payload.sub, exp: payload.exp };
}

export async function writeAdminAuth(dshHome: string, auth: AdminAuth): Promise<void> {
  const file = defaultAdminAuthFile(dshHome);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  // tmp + rename — атомарно в рамках одного каталога; fsync опционален для stage-2.
  await writeFile(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export async function loadAdminAuth(dshHome: string): Promise<AdminAuth> {
  const file = defaultAdminAuthFile(dshHome);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`admin auth file ${file} unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: AdminAuth;
  try {
    parsed = JSON.parse(raw) as AdminAuth;
  } catch {
    throw new Error(`admin auth file ${file} is not valid JSON`);
  }
  if (typeof parsed.login !== "string" || typeof parsed.passwordHash !== "string" || typeof parsed.jwtSecret !== "string") {
    throw new Error(`admin auth file ${file} misses required fields`);
  }
  return parsed;
}
```

- [ ] **Step 6: Прогнать тесты**

Run: `pnpm --filter dsh-balbes-host test`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add packages/bundles/dsh-balbes-host
git commit -m "add host core security helpers (scrypt, jwt, atomic auth file)"
```

---

### Task 4: Host — плагины `startup` и `server` (транспорт)

**Files:**
- Create: `packages/bundles/dsh-balbes-host/src/startup.ts`
- Create: `packages/bundles/dsh-balbes-host/src/server.ts`
- Create: `packages/bundles/dsh-balbes-host/src/types.ts` (общие типы HTTP)
- Create: `packages/bundles/dsh-balbes-host/tests/server.test.ts`

**Interfaces:**
- Consumes: Task 3 (`core.ts` не нужен серверу; сервер использует только node:http).
- Produces:
  - `startup.ts` — плагин `{ name: "balbes-startup" }`: парсит CLI через `parseCmdline` из `@deepseek-ai/dsh-cmdline`, отклоняет позиционные аргументы usage-ошибкой, не вызывает `appExit`.
  - `server.ts` — плагин `{ name: "balbes-server" }`, предоставляет сервис `balbesHttp`:
    - `post(path: string, auth: "public" | "bearer", handler: HttpHandler): void`
    - `registerStatic(serve: (pathname: string) => Promise<{ status: number; body: Buffer | string; type?: string } | null>): void`
    - `HttpHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void`
  - `types.ts` — `HttpSeat`, `HttpHandler`, `BalbesHttp`.

- [ ] **Step 1: Общие типы**

`packages/bundles/dsh-balbes-host/src/types.ts`:
```ts
import type { IncomingMessage, ServerResponse } from "node:http";

export type HttpAuth = "public" | "bearer";
export type HttpHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;

export interface HttpSeat {
  method: "POST" | "GET";
  path: string;            // точный путь, например /api/prompt
  auth: HttpAuth;
  handler: HttpHandler;
}

export interface StaticResult {
  status: number;
  body: Buffer | string;
  type?: string;
}

export interface BalbesHttp {
  post(path: string, auth: HttpAuth, handler: HttpHandler): void;
  registerStatic(serve: (pathname: string) => Promise<StaticResult | null>): void;
}
```

- [ ] **Step 2: startup-плагин**

`packages/bundles/dsh-balbes-host/src/startup.ts`:
```ts
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

/** Стабильное имя плагина. */
export const name = "balbes-startup";
/** Сервис, требуемый до разбора аргументов. */
export const inject = ["cmdlineArgs"];

function balbesCommand(): Command {
  return new Command()
    .name("dsh --profile balbes")
    .description("balbes server: HTTP admin (auth + test prompt). No task arguments.")
    .helpOption("-h, --help", "show help")
    .allowExcessArguments(false)
    .addHelpText("after", `
Examples:
  dsh --profile balbes           start the admin server (daemon)
`);
}

export function apply(ctx: { provide(key: string, value: unknown): void }): void {
  const program = balbesCommand();
  program.action(() => {
    // Никаких аргументов: balbes — сервер, не one-shot. Excess args уже
    // отклонены allowExcessArguments(false); пустое действие достаточно.
  });
  parseCmdline(ctx as never, program);
}
```

- [ ] **Step 3: server-плагин (транспорт + роутер)**

`packages/bundles/dsh-balbes-host/src/server.ts`:
```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import z from "@deepseek-ai/schemastery";
import type { BalbesHttp, HttpHandler, HttpSeat, StaticResult } from "./types.js";

export const name = "balbes-server";
export const Config = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().default(8080)
});
export const inject: string[] = [];

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function apply(ctx: {
  get(key: string): unknown;
  provide(key: string, value: BalbesHttp): void;
  on(event: string, listener: (...args: never[]) => void): void;
  config: { host: string; port: number };
  logger: { warn(msg: string): void };
}): void {
  const seats: HttpSeat[] = [];
  let staticServe: ((pathname: string) => Promise<StaticResult | null>) | null = null;
  let server: Server | null = null;

  const http: BalbesHttp = {
    post(path, auth, handler) {
      seats.push({ method: "POST", path, auth, handler });
    },
    registerStatic(serve) {
      staticServe = serve;
    }
  };
  ctx.provide("balbesHttp", http);

  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (url.pathname.startsWith("/api/")) {
      const seat = seats.find((s) => s.method === method && s.path === url.pathname);
      if (seat === undefined) {
        send(res, 404, { error: { code: "not-found", message: `no route ${method} ${url.pathname}` } });
        return;
      }
      if (seat.auth === "bearer") {
        const authService = ctx.get("balbesAuth") as { verify(token: string): { login: string } | null } | undefined;
        if (authService === undefined) {
          send(res, 503, { error: { code: "auth-unavailable", message: "auth service not ready" } });
          return;
        }
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
        const payload = token === "" ? null : authService.verify(token);
        if (payload === null) {
          send(res, 401, { error: { code: "unauthorized", message: "missing or invalid bearer token" } });
          return;
        }
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        send(res, 400, { error: { code: "bad-request", message: "invalid or oversized json body" } });
        return;
      }
      try {
        await seat.handler(req, res, body);
      } catch (error) {
        ctx.logger.warn(`balbes-server: handler error: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) send(res, 500, { error: { code: "internal", message: "internal error" } });
      }
      return;
    }
    // Не-/api: статика SPA.
    if (method === "GET" && staticServe !== null) {
      const result = await staticServe(url.pathname);
      if (result !== null) {
        send(res, result.status, result.body, result.type ?? "application/octet-stream");
        return;
      }
    }
    send(res, 404, "not found", "text/plain");
  };

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    void dispatch(req, res);
  };

  server = createServer(listener);
  server.listen(ctx.config.port, ctx.config.host);
  ctx.logger.warn(`balbes-server: listening on ${ctx.config.host}:${ctx.config.port}`);

  ctx.on("dispose", () => {
    server?.close();
    server = null;
  });
}
```

- [ ] **Step 4: Написать тест сервера (реальный HTTP: роутинг, 401, 404, статика)**

`packages/bundles/dsh-balbes-host/tests/server.test.ts`:
```ts
import { describe, expect, it, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply as applyServer } from "../src/server.js";
import type { BalbesHttp } from "../src/types.js";

interface CtxLike {
  get(key: string): unknown;
  provide(key: string, value: unknown): void;
  on(event: string, listener: (...a: unknown[]) => void): void;
  config: { host: string; port: number };
  logger: { warn(m: string): void };
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function post(port: number, path: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe("server", () => {
  const disposers: Array<() => void> = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function boot() {
    const port = await freePort();
    const onDispose: Array<() => void> = [];
    let getImpl: (key: string) => unknown = () => undefined;
    let http: BalbesHttp | null = null;
    const ctx: CtxLike = {
      get: (k) => getImpl(k),
      provide: (_k, v) => { http = v as BalbesHttp; },
      on: (ev, fn) => { if (ev === "dispose") onDispose.push(fn as () => void); },
      config: { host: "127.0.0.1", port },
      logger: { warn: () => undefined }
    };
    applyServer(ctx); // server слушает внутри apply на свободном порту
    disposers.push(() => { for (const fn of onDispose) fn(); });
    return {
      port,
      http: http as unknown as BalbesHttp,
      setGet: (impl: (k: string) => unknown) => { getImpl = impl; }
    };
  }

  it("public route: POST /api/echo возвращает тело", async () => {
    const b = await boot();
    b.http.post("/api/echo", "public", async (_req, res, body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ got: body }));
    });
    const { status, json } = await post(b.port, "/api/echo", { hello: 1 });
    expect(status).toBe(200);
    expect(json).toEqual({ got: { hello: 1 } });
  });

  it("bearer route без токена — 401, с валидным — 200", async () => {
    const b = await boot();
    b.setGet((key) => (key === "balbesAuth" ? { verify: (t: string) => (t === "good" ? { login: "admin" } : null) } : undefined));
    let reached = false;
    b.http.post("/api/protected", "bearer", async (_req, res) => {
      reached = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    expect((await post(b.port, "/api/protected", {})).status).toBe(401);
    expect((await post(b.port, "/api/protected", {}, "bad")).status).toBe(401);
    expect((await post(b.port, "/api/protected", {}, "good")).status).toBe(200);
    expect(reached).toBe(true);
  });

  it("неизвестный /api/* — 404", async () => {
    const b = await boot();
    expect((await post(b.port, "/api/nope", {})).status).toBe(404);
  });

  it("статика: / отдаёт index.html из ui-каталога", async () => {
    const b = await boot();
    const dir = await mkdtemp(join(tmpdir(), "balbes-ui-"));
    dirs.push(dir);
    await writeFile(join(dir, "index.html"), "<h1>admin</h1>");
    b.http.registerStatic(async (pathname) => {
      if (pathname === "/") {
        const { readFile } = await import("node:fs/promises");
        return { status: 200, body: await readFile(join(dir, "index.html")), type: "text/html; charset=utf-8" };
      }
      return null;
    });
    const res = await fetch(`http://127.0.0.1:${b.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("admin");
  });
});
```

> **Note:** тест поднимает реальный HTTP-сервер на свободном порту (`freePort()`), ходит по HTTP и проверяет поведение dispatch (public/bearer/404/статика). 401-проверка использует подмену `balbesAuth` через `setGet` (auth-модуль тестируется отдельно в Task 5; полный 401-путь с настоящим auth — в REAL-тесте Task 6).

- [ ] **Step 5: typecheck**

Run: `pnpm --filter dsh-balbes-host typecheck`
Expected: без ошибок (исправьте типы `ctx`-заглушек под реальные сигнатуры Cordis по мере необходимости — тесты запускаются после `pnpm build`).

- [ ] **Step 6: Коммит**

```bash
git add packages/bundles/dsh-balbes-host/src/startup.ts packages/bundles/dsh-balbes-host/src/server.ts \
        packages/bundles/dsh-balbes-host/src/types.ts packages/bundles/dsh-balbes-host/tests/server.test.ts
git commit -m "add host startup and http server plugins"
```

---

### Task 5: Host — плагины `auth` и `static`

**Files:**
- Create: `packages/bundles/dsh-balbes-host/src/auth.ts`
- Create: `packages/bundles/dsh-balbes-host/src/static.ts`
- Create: `packages/bundles/dsh-balbes-host/tests/auth.test.ts`

**Interfaces:**
- Consumes: Task 3 (`core.ts`: `loadAdminAuth`, `verifyPassword`, `issueToken`, `verifyToken`, `defaultAdminAuthFile`), Task 4 (`balbesHttp.post`).
- Produces:
  - `auth.ts` — плагин `{ name: "balbes-auth" }`, сервис `balbesAuth`: `{ verify(token): { login } | null; checkLogin(login, password): Promise<boolean> }`. Регистрирует `POST /api/auth/login` (public) и `POST /api/auth/me` (bearer). Rate-limit: 5 промахов / 30 мин по IP (в памяти).
  - `static.ts` — плагин `{ name: "balbes-static" }`, Config `{ uiDistDir?: string }`; регистрирует раздачу `dist` SPA (index.html на `/`, безопасный `join`, 403 на выход за корень, 404 иначе).

- [ ] **Step 1: Написать падающий тест auth-логики (без сети)**

`packages/bundles/dsh-balbes-host/tests/auth.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminAuth, writeAdminAuth, verifyPassword, loadAdminAuth } from "../src/core.js";
import { createGuard } from "../src/auth.js";

describe("auth guard", () => {
  it("checkLogin принимает верную пару, отвергает неверную", async () => {
    const dir = await mkdtemp(join(tmpdir(), "balbes-authg-"));
    try {
      const creds = await createAdminAuth();
      await writeAdminAuth(dir, creds);
      const guard = createGuard({ adminAuthFile: join(dir, "admin-auth.json") });
      await expect(guard.checkLogin(creds.login, creds.plaintextPassword)).resolves.toBe(true);
      await expect(guard.checkLogin(creds.login, "wrong")).resolves.toBe(false);
      const token = guard.issue(creds.login);
      expect(guard.verify(token)?.login).toBe(creds.login);
      expect(guard.verify("garbage")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Реализовать `auth.ts`**

`packages/bundles/dsh-balbes-host/src/auth.ts`:
```ts
import z from "@deepseek-ai/schemastery";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BalbesHttp } from "./types.js";
import { issueToken, verifyPassword, verifyToken, type AdminAuth } from "./core.js";

export const name = "balbes-auth";
export const inject = ["balbesHttp"];
export const Config = z.object({
  adminAuthFile: z.string().optional(),
  dshHome: z.string().optional(),
  loginTtlSeconds: z.number().default(86400)
});

export interface AuthGuard {
  issue(login: string): string;
  verify(token: string): { login: string } | null;
  checkLogin(login: string, password: string): Promise<boolean>;
}

const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 30 * 60 * 1000;

export function createGuard(opts: { adminAuthFile: string; loginTtlSeconds?: number }): AuthGuard {
  let cached: AdminAuth | null = null;
  const fails = new Map<string, number[]>();

  async function load(): Promise<AdminAuth> {
    if (cached !== null) return cached;
    const raw = await readFile(opts.adminAuthFile, "utf8");
    cached = JSON.parse(raw) as AdminAuth;
    return cached;
  }

  return {
    issue(login) {
      const auth = cached;
      if (auth === null) throw new Error("auth: admin file not loaded");
      return issueToken(auth.jwtSecret, login, opts.loginTtlSeconds ?? 86400).token;
    },
    verify(token) {
      if (cached === null) return null;
      const payload = verifyToken(cached.jwtSecret, token);
      return payload === null ? null : { login: payload.login };
    },
    async checkLogin(login, password) {
      const auth = await load();
      if (login !== auth.login) return false;
      return verifyPassword(password, auth.passwordHash);
    }
  };
}

export function apply(ctx: {
  config: { adminAuthFile?: string; dshHome?: string; loginTtlSeconds?: number };
  provide(key: string, value: AuthGuard): void;
  get(key: string): BalbesHttp;
  logger: { warn(m: string): void };
}): void {
  const dshHome = ctx.config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const adminAuthFile = ctx.config.adminAuthFile ?? join(dshHome, "admin-auth.json");
  const guard = createGuard({ adminAuthFile, loginTtlSeconds: ctx.config.loginTtlSeconds });
  ctx.provide("balbesAuth", guard);
  const http = ctx.get("balbesHttp");
  const ipFails = new Map<string, number[]>();

  const blocked = (ip: string): boolean => {
    const now = Date.now();
    const list = (ipFails.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    ipFails.set(ip, list);
    return list.length >= FAIL_LIMIT;
  };
  const recordFail = (ip: string): void => {
    const list = ipFails.get(ip) ?? [];
    list.push(Date.now());
    ipFails.set(ip, list);
  };

  http.post("/api/auth/login", "public", async (req, res, body) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    if (blocked(ip)) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "rate-limited", message: "too many attempts" } }));
      return;
    }
    const b = body as { login?: unknown; password?: unknown };
    if (typeof b.login !== "string" || typeof b.password !== "string") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "bad-request", message: "login and password required" } }));
      return;
    }
    const ok = await guard.checkLogin(b.login, b.password);
    if (!ok) {
      recordFail(ip);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unauthorized", message: "invalid credentials" } }));
      return;
    }
    const token = guard.issue(b.login);
    const expiresAt = new Date(Date.now() + (ctx.config.loginTtlSeconds ?? 86400) * 1000).toISOString();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token, expiresAt }));
  });

  http.post("/api/auth/me", "bearer", async (_req, res) => {
    // Проверку bearer выполняет server.dispatch (см. Task 4); сюда попадают
    // только авторизованные. login достаём из заголовка повторно через guard.
    const authHeader = _req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const payload = guard.verify(token);
    if (payload === null) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unauthorized", message: "invalid token" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ login: payload.login }));
  });
}
```

- [ ] **Step 3: Реализовать `static.ts`**

`packages/bundles/dsh-balbes-host/src/static.ts`:
```ts
import z from "@deepseek-ai/schemastery";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { BalbesHttp, StaticResult } from "./types.js";

export const name = "balbes-static";
export const inject = ["balbesHttp"];
export const Config = z.object({
  uiDistDir: z.string().optional(),
  dshHome: z.string().optional()
});

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

export function apply(ctx: {
  config: { uiDistDir?: string; dshHome?: string };
  get(key: string): BalbesHttp;
  logger: { warn(m: string): void };
}): void {
  const dshHome = ctx.config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const distRoot = resolve(ctx.config.uiDistDir ?? join(dshHome, "balbes", "ui"));
  const http = ctx.get("balbesHttp");

  http.registerStatic(async (pathname) => {
    let target: string;
    try {
      target = resolve(join(distRoot, normalize(pathname).replace(/^[/\\]+/, "")));
    } catch {
      return { status: 403, body: "forbidden", type: "text/plain" };
    }
    if (target !== distRoot && !target.startsWith(distRoot + sep)) {
      return { status: 403, body: "forbidden", type: "text/plain" };
    }
    const file = pathname === "/" ? join(distRoot, "index.html") : target;
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      if (pathname === "/") return null;
      // SPA fallback: отдаём index.html для неизвестных путей.
      try {
        data = await readFile(join(distRoot, "index.html"));
      } catch {
        return null;
      }
    }
    const type = MIME[extname(file)] ?? "application/octet-stream";
    return { status: 200, body: data, type };
  });
  ctx.logger.warn(`balbes-static: serving ${distRoot}`);
}
```

- [ ] **Step 4: Прогнать typecheck и тесты**

Run: `pnpm --filter dsh-balbes-host typecheck && pnpm --filter dsh-balbes-host test`
Expected: PASS; typecheck чист.

- [ ] **Step 5: Коммит**

```bash
git add packages/bundles/dsh-balbes-host/src/auth.ts packages/bundles/dsh-balbes-host/src/static.ts \
        packages/bundles/dsh-balbes-host/tests/auth.test.ts
git commit -m "add host auth and static plugins"
```

---

### Task 6: Host — плагин `api` (prompt по шву ядра) + REAL-композиция с LLM-stub

**Files:**
- Create: `packages/bundles/dsh-balbes-host/src/api.ts`
- Create: `packages/bundles/dsh-balbes-host/src/runner.ts`
- Create: `packages/bundles/dsh-balbes-host/tests/integration.test.ts`
- Create: `packages/bundles/dsh-balbes-host/tests/fixtures/balbes-test-profile/package.json`
- Create: `packages/bundles/dsh-balbes-host/tests/fixtures/balbes-test-profile/cordis.patch.yml`
- Create: `packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs`

**Interfaces:**
- Consumes: Task 3–5; ядро dsh (`agents`, `agentDefaultModel`, `sessions`, `loader`), шов headless-раннера (см. спека 9.4/9.5.7).
- Produces:
  - `runner.ts`: `runPrompt(ctx): Promise<{ text: string; reason?: {...} }>` — точная копия логики headless `run()` без stdout/exit: `loader.await()` → `agentDefaultModel.currentSelection()` → `agents.create({...})` → `followup(createUserMessage(...))` → `whenIdle()` → `sessions.flush()` → сборка текста из событий сессии (`SessionSeq`, `agent.session.eventAt`).
  - `api.ts`: плагин `{ name: "balbes-api" }`; регистрирует `POST /api/health` (public, `{ok:true,version}`) и `POST /api/prompt` (bearer).

- [ ] **Step 1: Реализовать `runner.ts`**

```ts
import { randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";

export interface PromptOutcome {
  text: string;
  reason?: { kind: string; code?: string; message?: string };
}

/**
 * Выполнить один промпт через свежего агента (шов headless-раннера dsh).
 * Сессия создаётся с новым sessionId и персистится через sessions.flush —
 * граница этапа 2: агент не живёт между запросами.
 */
export async function runPrompt(ctx: {
  get(key: string): unknown;
  on(event: string, listener: (...a: never[]) => void): () => void;
}, prompt: string): Promise<PromptOutcome> {
  await (ctx.get("loader") as { await(): Promise<void> } | undefined)?.await();
  const agents = ctx.get("agents") as {
    create(opts: { sessionId: string; meta: { cwd: string }; agentOptions: { provider: string; model: string }; setup: (agentCtx: unknown) => void }): Promise<{ agent: AgentLike; session: unknown }>;
  };
  const defaultModel = ctx.get("agentDefaultModel") as { currentSelection(): { provider: string; model: string } };
  const sessions = ctx.get("sessions") as { flush(session: unknown): Promise<void> };
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    return { text: "", reason: { kind: "error", code: "core-unavailable", message: "agent core services missing" } };
  }

  const selection = defaultModel.currentSelection();
  const { agent } = await agents.create({
    sessionId: brandString(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx as never, { current: selection, assembled: undefined });
    }
  });
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(
    createUserMessage({
      content: [{ type: "text", text: prompt }],
      source: { kind: "user" }
    }) as never
  );
  await agent.whenIdle();
  await sessions.flush(agent.session);

  let started = false;
  let text = "";
  let reason: PromptOutcome["reason"];
  const length = agent.session.seq;
  for (let seq = firstSeq; seq < length; seq++) {
    const event = agent.session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    if (event.type === "turn/start") { started = true; continue; }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block: { type: string; text?: string }) => block.type === "text")
        .map((block: { text: string }) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") {
      const r = event.data.reason as { kind: string; error?: { code?: string; message?: string } } | undefined;
      if (r?.kind === "error") {
        reason = { kind: "error", code: r.error?.code, message: r.error?.message };
      } else {
        reason = { kind: r?.kind ?? "completed" };
      }
    }
  }
  return { text, reason };
}

interface AgentLike {
  whenIdle(): Promise<void>;
  followup(message: unknown): void;
  session: {
    seq: number;
    eventAt(seq: symbol): { type: string; data: { message?: { content: Array<{ type: string; text?: string }> }; reason?: unknown } } | undefined;
  };
}
```

> **Note:** типы `SessionSeq`/событий уточните по `@deepseek-ai/dsh-session`/`dsh-llm` d.ts при первой сборке — код выше повторяет публичный контракт из `dsh-headless/lib/index.js` (эталон для сигнатур).

- [ ] **Step 2: Реализовать `api.ts`**

```ts
import z from "@deepseek-ai/schemastery";
import type { BalbesHttp } from "./types.js";
import { runPrompt } from "./runner.js";

export const name = "balbes-api";
export const inject = ["balbesHttp", "agents", "agentDefaultModel", "sessions"];
export const Config = z.object({ version: z.string().default("0.1.0") });

export function apply(ctx: {
  config: { version: string };
  get(key: string): BalbesHttp;
  logger: { warn(m: string): void };
}): void {
  const http = ctx.get("balbesHttp");
  const agentCtx = ctx as never;

  http.post("/api/health", "public", async (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: ctx.config.version }));
  });

  http.post("/api/prompt", "bearer", async (_req, res, body) => {
    const b = body as { prompt?: unknown };
    if (typeof b.prompt !== "string" || b.prompt.trim() === "") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "bad-request", message: "prompt required" } }));
      return;
    }
    const outcome = await runPrompt(agentCtx, b.prompt);
    const status = outcome.reason?.kind === "error" ? 502 : 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(outcome));
  });
}
```

- [ ] **Step 3: LLM-stub для REAL-теста**

`packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs` — маленький OpenAI-совместимый сервер:
```js
import { createServer } from "node:http";

export function startStubLlm({ text = "ok" } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ path: req.url, body: JSON.parse(raw || "{}") });
      const body = JSON.stringify({
        id: "stub-1",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "stub",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, calls, close: () => server.close() });
    });
  });
}
```

- [ ] **Step 4: Написать REAL-тест (spawn dsh CLI с temp-профилем)**

Тест повторяет рецептуру install.sh в миниатюре: собирает host в `lib/` (вызывается `pnpm build` в CI до тестов), создаёт temp `DSH_HOME`, кладёт профиль `balbes-test` с нашим бандлом в `node_modules` профиля (копия `lib`+`package.json`+`cordis.patch.yml`), поднимает LLM-stub, прописывает `settings.yaml` с endpoint stub'а и запускает дочерний `dsh --profile balbes-test --patch <overlay>`.

`packages/bundles/dsh-balbes-host/tests/fixtures/balbes-test-profile/package.json`:
```json
{
  "name": "dsh-profile-balbes-test",
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

`packages/bundles/dsh-balbes-host/tests/fixtures/balbes-test-profile/cordis.patch.yml`:
```yaml
[]
```

Overlay (в тесте пишется во временный файл), которым включается LLM-stub:
```yaml
- id: agent-default-model
  config:
    provider: deepseek
    model: deepseek-chat
```

`packages/bundles/dsh-balbes-host/tests/integration.test.ts`:
```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStubLlm } from "./helpers/stub-llm.mjs";

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..", ".."); // dsh-balbes-host
const fixtureProfile = join(here, "fixtures", "balbes-test-profile");

async function hasDsh(): Promise<boolean> {
  try { await execFileP("dsh", ["--version"]); return true; } catch { return false; }
}

describe.skipIf(!process.env.RUN_REAL)("REAL composition (dsh CLI + LLM stub)", () => {
  let stub: { port: number; close: () => void };
  let home: string;

  beforeAll(async () => {
    stub = await startStubLlm({ text: "ok from stub" });
    home = await mkdtemp(join(tmpdir(), "balbes-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, "balbes-test"), { recursive: true });
    // Копия собранного бандла в node_modules профиля (рецептура install.sh).
    const nm = join(profiles, "balbes-test", "node_modules");
    await mkdir(nm, { recursive: true });
    await cp(join(pkgRoot, "lib"), join(nm, "dsh-balbes-host", "lib"), { recursive: true });
    await cp(join(pkgRoot, "package.json"), join(nm, "dsh-balbes-host", "package.json"));
    await cp(join(pkgRoot, "cordis.patch.yml"), join(nm, "dsh-balbes-host", "cordis.patch.yml"));
    // Настройки модели: endpoint на stub.
    await writeFile(join(home, "settings.yaml"), `agent-default-model:\n  provider: deepseek\n  model: deepseek-chat\nllm-deepseek:\n  endpoint: http://127.0.0.1:${stub.port}\n  apiKey: test-key\n`);
  }, 60_000);

  afterAll(async () => {
    stub.close();
    await rm(home, { recursive: true, force: true });
  });

  it("dsh --profile balbes-test composes with our bundle", async () => {
    const { stdout } = await execFileP("dsh", ["--profile", "balbes-test", "--dump-config"], { env: { ...process.env, DSH_HOME: home } });
    expect(stdout).toContain("balbes-api");
  }, 60_000);
});
```

> **Проводка (обязательная проверка перед merge задачи):** ключи `settings.yaml` (`agent-default-model`, `llm-deepseek.endpoint/apiKey`) взяты из комментариев `dsh-base/cordis.patch.yml` и кода `dsh-llm-deepseek` (connection.baseURL/apiKey). Если stub не получает запрос (проверяется счётчиком `stub.calls`), найдите точное имя settings-секции в `lib/index.js` пакета `@deepseek-ai/dsh-llm-deepseek` (grep `settings` / `connection`) и поправьте ключи в этом тесте. Приёмка задачи: `stub.calls.length > 0` после прогона smoke-промпта (добавьте в тест вызов POST /api/prompt и проверку `text === "ok from stub"`, когда host-профиль поднят; для скорости — сначала dump-config, затем полный цикл).

- [ ] **Step 5: Прогнать сборку и тесты**

Run: `pnpm --filter dsh-balbes-host build && pnpm --filter dsh-balbes-host test && RUN_REAL=1 pnpm --filter dsh-balbes-host test`
Expected: unit PASS; REAL-тест PASS при наличии `dsh` в PATH (иначе skip).

- [ ] **Step 6: Коммит**

```bash
git add packages/bundles/dsh-balbes-host/src/api.ts packages/bundles/dsh-balbes-host/src/runner.ts \
        packages/bundles/dsh-balbes-host/tests
git commit -m "add host api plugin with core prompt runner"
```

---

### Task 7: Композиция host-бандла и профиля `balbes`

**Files:**
- Create: `packages/bundles/dsh-balbes-host/cordis.patch.yml`
- Create: `packages/bundles/dsh-balbes-host/src/index.ts`
- Modify: `profiles/balbes/package.json`
- Modify: `profiles/balbes/cordis.patch.yml`

**Interfaces:**
- Consumes: Task 1–6 (плагины по экспортным подпутям).
- Produces: собранный профиль `balbes` = base + `dsh-balbes-host`, который проходит `dsh --profile balbes --dump-config` (после копии бандла в `node_modules` профиля — рецептура Task 6 Step 4 / install.sh).

- [ ] **Step 1: Патч-слой бандла**

`packages/bundles/dsh-balbes-host/cordis.patch.yml` (повторяет структуру headless/web: переопределения поверх base + insert):
```yaml
# dsh-balbes-host bundle patch: the balbes server surface over dsh-base.
# Overrides base rows by id (whole-config replacement), then inserts the
# server plugins. Applies after dsh-base; profile patch and --patch follow.

- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.

- id: tools
  config:
    mode: !!js process.env.DSH_TOOLS_MODE

- insert:
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'

    - id: balbes-startup
      name: 'dsh-balbes-host/startup'

    - id: balbes-server
      name: 'dsh-balbes-host/server'
      config:
        host: '0.0.0.0'
        port: !!js "Number(process.env.BALBES_PORT ?? 8080)"

    - id: balbes-static
      name: 'dsh-balbes-host/static'
      config:
        uiDistDir: !!js "process.env.BALBES_UI_DIST ?? null"

    - id: balbes-auth
      name: 'dsh-balbes-host/auth'

    - id: balbes-api
      name: 'dsh-balbes-host/api'
```

- [ ] **Step 2: Точка входа пакета**

`packages/bundles/dsh-balbes-host/src/index.ts`:
```ts
// Пакет-бандл: код живёт в экспортных подпутях (startup/server/static/
// auth/api); корневой вход перечисляет их для ясности и тестов.
export const name = "dsh-balbes-host";
```

- [ ] **Step 3: Обновить профиль**

`profiles/balbes/package.json`:
```json
{
  "name": "dsh-profile-balbes",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-balbes-host"
      ],
      "patchReload": "startup"
    }
  }
}
```

`profiles/balbes/cordis.patch.yml`:
```yaml
[]
```

- [ ] **Step 4: Проверить композицию локально (рецептура install.sh)**

```bash
pnpm --filter dsh-balbes-host build
rm -rf /tmp/dsh-stage2-home && mkdir -p /tmp/dsh-stage2-home/profiles
cp -R profiles/balbes /tmp/dsh-stage2-home/profiles/balbes
mkdir -p /tmp/dsh-stage2-home/profiles/balbes/node_modules
cp -R packages/bundles/dsh-balbes-host /tmp/dsh-stage2-home/profiles/balbes/node_modules/dsh-balbes-host
rm -rf /tmp/dsh-stage2-home/profiles/balbes/node_modules/dsh-balbes-host/lib/types
rm -f /tmp/dsh-stage2-home/profiles/balbes/node_modules/dsh-balbes-host/tsconfig.json
DSH_HOME=/tmp/dsh-stage2-home dsh --profile balbes --dump-config > /tmp/stage2-dump.yml
echo "exit=$?"
grep -c "balbes-api\|balbes-auth\|balbes-server" /tmp/stage2-dump.yml
```
Expected: `exit=0`; в выводе есть строки наших плагинов; `dsh-web-app`/`headless` отсутствуют (проверить `grep -c headless /tmp/stage2-dump.yml` = 0).

> **Note:** копия в `node_modules` профиля — как в Task 6: переносятся собранные `lib/`, `package.json`, `cordis.patch.yml`. Если `--dump-config` не находит `dsh-balbes-host`, проверьте, что `package.json` бандла декларирует `dsh.bundle.patch` (иначе старт падает громко — спека 9.1).

- [ ] **Step 5: Коммит**

```bash
git add packages/bundles/dsh-balbes-host/cordis.patch.yml packages/bundles/dsh-balbes-host/src/index.ts profiles/balbes
git commit -m "compose balbes profile over base with own host bundle"
```

---

### Task 8: SPA `dsh-balbes-admin` — каркас Vite и api-клиент

**Files:**
- Create: `packages/frontend/dsh-balbes-admin/index.html`
- Create: `packages/frontend/dsh-balbes-admin/vite.config.ts`
- Create: `packages/frontend/dsh-balbes-admin/tsconfig.json`
- Create: `packages/frontend/dsh-balbes-admin/src/main.tsx`
- Create: `packages/frontend/dsh-balbes-admin/src/api/client.ts`
- Create: `packages/frontend/dsh-balbes-admin/tests/client.test.ts`
- Create: `packages/frontend/dsh-balbes-admin/src/vite-env.d.ts`

**Interfaces:**
- Consumes: `dsh-balbes-contracts` (типы); Task 2.
- Produces: api-клиент `createApiClient(baseUrl)`, работающий с host: `login(login,password)`, `me()`, `prompt(text)`; авто-подстановка `Authorization: Bearer` из `localStorage["balbes.authToken"]`; при 401 — чистка токена.

- [ ] **Step 1: Конфиги Vite/TS**

`index.html`:
```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>balbes admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8080" }
  },
  test: {
    environment: "jsdom",
    setupFiles: [],
    globals: true
  }
});
```

`tsconfig.json`:
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "@testing-library/jest-dom"]
  },
  "include": ["src", "tests", "vite.config.ts"]
}
```

`src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

- [ ] **Step 2: api-клиент**

`src/api/client.ts`:
```ts
import type {
  HealthResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  PromptRequest,
  PromptResponse,
  ApiErrorBody
} from "dsh-balbes-contracts";

export const TOKEN_KEY = "balbes.authToken";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const stored = token ?? localStorage.getItem(TOKEN_KEY);
  if (stored) headers.authorization = `Bearer ${stored}`;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  if (!res.ok) {
    let errorBody: ApiErrorBody | null = null;
    try { errorBody = (await res.json()) as ApiErrorBody; } catch { /* not json */ }
    throw new ApiError(res.status, errorBody?.error.code ?? "http", errorBody?.error.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

export interface AdminApi {
  health(): Promise<HealthResponse>;
  login(login: string, password: string): Promise<LoginResponse>;
  me(): Promise<MeResponse>;
  prompt(text: string): Promise<PromptResponse>;
  onUnauthorized(cb: () => void): void;
}

export function createApiClient(): AdminApi {
  const listeners = new Set<() => void>();
  const notify401 = (): void => {
    localStorage.removeItem(TOKEN_KEY);
    for (const cb of listeners) cb();
  };
  const guard = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) notify401();
      throw error;
    }
  };
  return {
    health: () => request<HealthResponse>("/api/health", {}),
    login: (login, password) => guard(request<LoginResponse>("/api/auth/login", { login, password } satisfies LoginRequest)),
    me: () => guard(request<MeResponse>("/api/auth/me", {})),
    prompt: (text) => guard(request<PromptResponse>("/api/prompt", { prompt: text } satisfies PromptRequest)),
    onUnauthorized: (cb) => { listeners.add(cb); }
  };
}
```

- [ ] **Step 3: main.tsx (заглушка до Task 9)**

`src/main.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import { createApiClient } from "./api/client";

const root = document.getElementById("root");
if (root === null) throw new Error("no #root element");
createRoot(root).render(
  <div data-testid="app-root">
    <span data-testid="api-ready">api-ready</span>
  </div>
);
export const api = createApiClient();
```

- [ ] **Step 4: Тест клиента (fetch замокан — R-TEST-1)**

`tests/client.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createApiClient, ApiError, TOKEN_KEY } from "../src/api/client";

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body
  });
}

describe("api client", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", mockFetchOnce(200, { ok: true, version: "test" }));
  });

  it("login сохраняет токен", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(200, { token: "jwt-1", expiresAt: new Date().toISOString() }));
    const api = createApiClient();
    await api.login("admin", "pw");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("jwt-1");
  });

  it("prompt шлёт Authorization header", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-1");
    const fetchMock = mockFetchOnce(200, { text: "ok" });
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    await api.prompt("Привет");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: "Bearer tok-1" });
  });

  it("401 чистит токен и зовёт onUnauthorized", async () => {
    localStorage.setItem(TOKEN_KEY, "tok-expired");
    vi.stubGlobal("fetch", mockFetchOnce(401, { error: { code: "unauthorized", message: "expired" } }));
    const api = createApiClient();
    const spy = vi.fn();
    api.onUnauthorized(spy);
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(spy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Прогнать тесты и typecheck**

Run: `pnpm --filter dsh-balbes-admin install && pnpm --filter dsh-balbes-admin typecheck && pnpm --filter dsh-balbes-admin test`
Expected: PASS (3 теста).

- [ ] **Step 6: Коммит**

```bash
git add packages/frontend/dsh-balbes-admin
git commit -m "add admin SPA scaffold and typed api client"
```

---

### Task 9: SPA — экраны Login/Main и сборка

**Files:**
- Create: `packages/frontend/dsh-balbes-admin/src/App.tsx`
- Create: `packages/frontend/dsh-balbes-admin/src/styles.css`
- Create: `packages/frontend/dsh-balbes-admin/tests/App.test.tsx`
- Modify: `packages/frontend/dsh-balbes-admin/src/main.tsx`

**Interfaces:**
- Consumes: Task 8 (`createApiClient`, `TOKEN_KEY`).
- Produces: собранный `dist/` (Vite), который host раздаёт как статику.

- [ ] **Step 1: App с переключением Login/Main**

`src/App.tsx`:
```tsx
import { useEffect, useState, type FormEvent } from "react";
import { createApiClient, type AdminApi } from "./api/client";

type View = "loading" | "login" | "main";

const TEST_PROMPT = "Напиши 'ok' и больше ничего";

export default function App({ api }: { api: AdminApi }) {
  const [view, setView] = useState<View>("loading");
  const [loginValue, setLoginValue] = useState("");
  const [passwordValue, setPasswordValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .me()
      .then(() => { if (!cancelled) setView("main"); })
      .catch(() => { if (!cancelled) setView("login"); });
    api.onUnauthorized(() => setView("login"));
    return () => { cancelled = true; };
  }, [api]);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.login(loginValue, passwordValue);
      setView("main");
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    }
  }

  async function handlePrompt() {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await api.prompt(TEST_PROMPT);
      setAnswer(res.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "prompt failed");
    } finally {
      setBusy(false);
    }
  }

  if (view === "loading") return <div>Loading…</div>;
  if (view === "login") {
    return (
      <main>
        <h1>balbes admin</h1>
        <form onSubmit={handleLogin} data-testid="login-form">
          <label>
            Login
            <input value={loginValue} onChange={(e) => setLoginValue(e.target.value)} data-testid="login-input" autoComplete="username" />
          </label>
          <label>
            Password
            <input type="password" value={passwordValue} onChange={(e) => setPasswordValue(e.target.value)} data-testid="password-input" autoComplete="current-password" />
          </label>
          <button type="submit" data-testid="login-submit">Войти</button>
          {error !== null && <p role="alert">{error}</p>}
        </form>
      </main>
    );
  }
  return (
    <main>
      <h1>balbes admin</h1>
      <p>Тестовый промпт: <code>{TEST_PROMPT}</code></p>
      {answer !== null && <pre data-testid="answer">{answer}</pre>}
      <button onClick={() => void handlePrompt()} disabled={busy} data-testid="prompt-button">
        {busy ? "Отправляется…" : "Отправить тестовый промпт"}
      </button>
      {error !== null && <p role="alert">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 2: Стили (минимальные)**

`src/styles.css`:
```css
body { font-family: system-ui, sans-serif; margin: 2rem; }
main { max-width: 42rem; }
pre { white-space: pre-wrap; background: #f4f4f4; padding: 1rem; border-radius: 6px; }
button { margin-top: 1rem; }
p[role="alert"] { color: #b00020; }
```

- [ ] **Step 3: Подключить App в main.tsx**

Замените содержимое `src/main.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import App from "./App";
import { createApiClient } from "./api/client";
import "./styles.css";

const api = createApiClient();
const root = document.getElementById("root");
if (root === null) throw new Error("no #root element");
createRoot(root).render(<App api={api} />);
```

- [ ] **Step 4: Тест экранов (fetch замокан)**

`tests/App.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "../src/App";
import { createApiClient } from "../src/api/client";

function mockFetchSequence(...responses: Array<{ status: number; body: unknown }>) {
  const queue = [...responses];
  return vi.fn().mockImplementation(async () => {
    const next = queue.shift() ?? { status: 404, body: { error: { code: "x", message: "no more" } } };
    return { ok: next.status < 300, status: next.status, statusText: String(next.status), json: async () => next.body };
  });
}

describe("App", () => {
  beforeEach(() => localStorage.clear());

  it("показывает логин без токена и переходит к кнопке после входа", async () => {
    vi.stubGlobal("fetch", mockFetchSequence(
      { status: 401, body: { error: { code: "unauthorized", message: "no" } } },
      { status: 200, body: { token: "t", expiresAt: new Date().toISOString() } },
      { status: 200, body: { login: "balbes-x" } }
    ));
    render(<App api={createApiClient()} />);
    expect(await screen.findByTestId("login-form")).toBeTruthy();
    fireEvent.change(screen.getByTestId("login-input"), { target: { value: "balbes-x" } });
    fireEvent.change(screen.getByTestId("password-input"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("login-submit"));
    expect(await screen.findByTestId("prompt-button")).toBeTruthy();
  });

  it("кнопка отправляет промпт и показывает ответ над ней", async () => {
    vi.stubGlobal("fetch", mockFetchSequence(
      { status: 200, body: { login: "balbes-x" } },
      { status: 200, body: { text: "ok" } }
    ));
    localStorage.setItem("balbes.authToken", "t");
    render(<App api={createApiClient()} />);
    const button = await screen.findByTestId("prompt-button");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("answer").textContent).toBe("ok"));
    const answer = screen.getByTestId("answer");
    expect(button.compareDocumentPosition(answer)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 5: Собрать SPA**

Run: `pnpm --filter dsh-balbes-admin build`
Expected: `dist/` создан, typecheck чист.

- [ ] **Step 6: Коммит**

```bash
git add packages/frontend/dsh-balbes-admin
git commit -m "add admin login and test-prompt screens"
```

---

### Task 10: install.sh — сборка, учётные данные, systemd, health, сброс пароля

**Files:**
- Create: `scripts/admin-creds.mjs`
- Modify: `scripts/install.sh`

**Interfaces:**
- Consumes: Task 7 (профиль с host), Task 9 (SPA `dist/`), Task 3 (`dsh-balbes-host/lib/core.js`: `createAdminAuth`, `hashPassword`).
- Produces: демон на VPS: собраны host/SPA, host в `node_modules` профиля, SPA в `$DSH_HOME/balbes/ui`, `admin-auth.json`, systemd-юнит, health-проверка; флаг `--reset-admin-password`.

> **Решение по генерации credentials:** scrypt/jwtSecret генерируются Node-модулем host (`core.ts` в Task 3) — криптографию в bash не дублируем. install.sh зовёт маленький node-скрипт `scripts/admin-creds.mjs`, который динамически импортирует собранный `core.js` host'а (путь передаётся аргументом `--core`).

- [ ] **Step 1: Добавить конфиг-переменные и флаг**

В начало `scripts/install.sh` (после строки `PROFILE_NAME="balbes"` ~строка 35) добавить:
```bash
ADMIN_AUTH_FILE="$DSH_HOME/admin-auth.json"
UI_DIR="$DSH_HOME/balbes/ui"
SERVICE_NAME="dsh-balbes"
BALBES_PORT="${BALBES_PORT:-8080}"
RESET_ADMIN_PASSWORD=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --reset-admin-password) RESET_ADMIN_PASSWORD=1 ;;
        *) die "unknown option: $1 (supported: --reset-admin-password)" ;;
    esac
    shift
done
```

- [ ] **Step 2: Функция сборки workspace**

Перед `main()` добавить:
```bash
# build_workspace — собрать наши пакеты из репо (root pnpm workspace).
# Сборка идёт ДО рестарта сервиса: при падении install.sh выходит с ошибкой,
# работающий сервис не трогается.
build_workspace() {
    info "Building workspace packages (host, contracts, admin SPA)..."
    ( cd "$REPO_DIR" && pnpm install --frozen-lockfile=false && pnpm -r --if-present run build ) || die "workspace build failed"
    info "Workspace build OK."
}

# copy_host_into_profile — собранный host реальным каталогом в node_modules
# профиля (резолв @deepseek-ai подъёмом к зеркалу $DSH_HOME/profiles/node_modules).
copy_host_into_profile() {
    local profile_dir="$DSH_HOME/profiles/$PROFILE_NAME"
    local dst="$profile_dir/node_modules/dsh-balbes-host"
    mkdir -p "$profile_dir/node_modules"
    rm -rf "$dst"
    cp -R "$REPO_DIR/packages/bundles/dsh-balbes-host" "$dst"
    rm -f "$dst/tsconfig.json"
    rm -rf "$dst/tests" "$dst/src" "$dst/lib/types"
    chmod -R u+rwX,go-w "$dst"
    info "Host bundle copied into $dst"
}

# deploy_ui — собрать dist SPA в $DSH_HOME/balbes/ui (без старых файлов).
deploy_ui() {
    local src="$REPO_DIR/packages/frontend/dsh-balbes-admin/dist"
    local dst="$UI_DIR"
    if [[ ! -f "$src/index.html" ]]; then
        die "SPA dist missing at $src — workspace build did not produce it"
    fi
    mkdir -p "$(dirname "$dst")"
    rm -rf "$dst"
    cp -R "$src" "$dst"
    info "Admin UI deployed to $dst"
}
```

- [ ] **Step 3: Скрипт `admin-creds.mjs` + функции install.sh**

`scripts/admin-creds.mjs` (живёт в репо; bash только вызывает node):
```js
// Admin credentials lifecycle for the balbes server.
// Usage: node scripts/admin-creds.mjs ensure|reset --core <core.js> [--home <dshHome>]
// ensure: создаёт $DSH_HOME/admin-auth.json один раз (0600); если файл уже есть —
//         ничего не меняет. Печатает JSON {login, password?, created}.
// reset:  новый пароль (хэш), логин/jwtSecret не трогаются. Печатает {login, password}.
import { existsSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

function usage() {
  console.error("usage: admin-creds.mjs ensure|reset --core <core.js> [--home <dir>]");
  process.exit(2);
}
const args = process.argv.slice(2);
const cmd = args[0];
const opts = { core: "", home: process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh") };
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--core") opts.core = args[++i] ?? "";
  else if (args[i] === "--home") opts.home = args[++i] ?? "";
}
if ((cmd !== "ensure" && cmd !== "reset") || !opts.core) usage();

const core = await import(pathToFileURL(opts.core).href);
const file = join(opts.home, "admin-auth.json");
const tmp = `${file}.tmp.${process.pid}`;
const writeJson = async (obj) => {
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
};

if (cmd === "ensure") {
  if (existsSync(file)) {
    const auth = JSON.parse(await readFile(file, "utf8"));
    console.log(JSON.stringify({ login: auth.login, created: false }));
  } else {
    const creds = await core.createAdminAuth();
    await writeJson({
      login: creds.login,
      passwordHash: creds.passwordHash,
      jwtSecret: creds.jwtSecret,
      createdAt: creds.createdAt
    });
    console.log(JSON.stringify({ login: creds.login, password: creds.plaintextPassword, created: true }));
  }
} else {
  if (!existsSync(file)) {
    console.error("admin auth file missing:", file);
    process.exit(1);
  }
  const auth = JSON.parse(await readFile(file, "utf8"));
  const password = randomBytes(18).toString("base64url");
  auth.passwordHash = await core.hashPassword(password);
  auth.createdAt = new Date().toISOString();
  await writeJson(auth);
  console.log(JSON.stringify({ login: auth.login, password }));
}
```

В `scripts/install.sh` перед `main()` добавить:
```bash
# admin_credentials_ensure — создать admin-auth.json один раз (600) и
# напечатать логин/пароль. Повторный запуск = печать логина + подсказка.
admin_credentials_ensure() {
    local core_module="$DSH_HOME/profiles/$PROFILE_NAME/node_modules/dsh-balbes-host/lib/core.js"
    [[ -f "$core_module" ]] || die "host core not built at $core_module — build step failed"
    local out login created password
    out="$(DSH_HOME="$DSH_HOME" node "$REPO_DIR/scripts/admin-creds.mjs" ensure --core "$core_module" --home "$DSH_HOME")" || die "admin credentials step failed"
    login="$(printf '%s' "$out" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).login")"
    created="$(printf '%s' "$out" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).created")"
    if [[ "$created" == "true" ]]; then
        password="$(printf '%s' "$out" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).password")"
        chmod 600 "$ADMIN_AUTH_FILE"
        info "Admin credentials generated (stored hashed, printed once):"
        info "  login:    $login"
        info "  password: $password"
    else
        info "Admin login (unchanged): $login"
        info "Admin password is stored hashed only; reset it with: bash scripts/install.sh --reset-admin-password"
    fi
}

# admin_password_reset — новый пароль; логин/jwtSecret не меняются.
admin_password_reset() {
    local core_module="$DSH_HOME/profiles/$PROFILE_NAME/node_modules/dsh-balbes-host/lib/core.js"
    [[ -f "$ADMIN_AUTH_FILE" ]] || die "no admin auth file at $ADMIN_AUTH_FILE"
    [[ -f "$core_module" ]] || die "host core not built at $core_module — run the installer once first"
    local out login password
    out="$(DSH_HOME="$DSH_HOME" node "$REPO_DIR/scripts/admin-creds.mjs" reset --core "$core_module" --home "$DSH_HOME")" || die "password reset failed"
    login="$(printf '%s' "$out" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).login")"
    password="$(printf '%s' "$out" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).password")"
    info "Password reset for login: $login"
    info "  new password (printed once): $password"
}
```

- [ ] **Step 4: systemd-юнит + health + новый main**

Добавить:
```bash
# write_systemd_unit — шаблон юнита (спека 9.5.8); пути владельца подставляются.
write_systemd_unit() {
    local unit="/etc/systemd/system/$SERVICE_NAME.service"
    local dsh_bin home
    dsh_bin="$(command -v dsh)" || die "dsh not found"
    home="$HOME"
    run_priv tee "$unit" >/dev/null <<EOF
[Unit]
Description=dsh-balbes server (agent host + admin API)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$home
Environment=DSH_HOME=$DSH_HOME
Environment=BALBES_PORT=$BALBES_PORT
Environment=BALBES_UI_DIST=$UI_DIR
ExecStart=$dsh_bin --profile $PROFILE_NAME
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DSH_HOME $home
RestrictSUIDSGID=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
EOF
    run_priv systemctl daemon-reload
    run_priv systemctl enable --now "$SERVICE_NAME.service"
    info "systemd unit $SERVICE_NAME enabled and started."
}

# health_check — сервис отвечает POST /api/health (R-API-1: всё POST).
health_check() {
    local ok
    ok="$(curl -fsS -X POST "http://127.0.0.1:$BALBES_PORT/api/health" 2>/dev/null || true)"
    if [[ "$ok" != *'"ok":true'* ]]; then
        warn "health check failed — see: systemctl status $SERVICE_NAME; journalctl -u $SERVICE_NAME -n 50"
        return 1
    fi
    info "Health OK: POST http://127.0.0.1:$BALBES_PORT/api/health"
}
```

Заменить `print_smoke_instruction()` на:
```bash
print_admin_summary() {
    local ip
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    ip="${ip:-<IP>}"
    cat <<EOF

=====================================================================
Installation complete. Admin UI: http://$ip:$BALBES_PORT

  Login:    (printed above / see the install log)
  Password: (printed once on first install; reset via:
             bash scripts/install.sh --reset-admin-password)

Smoke without a browser (JWT):
  TOKEN=\$(curl -fsS -X POST http://127.0.0.1:$BALBES_PORT/api/auth/login \\
    -H 'content-type: application/json' \\
    -d '{"login":"<LOGIN>","password":"<PASSWORD>"}')
  curl -fsS -X POST http://127.0.0.1:$BALBES_PORT/api/prompt \\
    -H "authorization: Bearer \$TOKEN" \\
    -d '{"prompt":"Напиши ok"}'
=====================================================================
EOF
}
```

Обновить `main()`:
```bash
main() {
    info "== dsh '$PROFILE_NAME' installer (Stage 2: server + admin) =="
    info "repo: $REPO_URL -> $REPO_DIR"
    info "dsh home: $DSH_HOME"
    if [[ "$(id -u)" -eq 0 ]]; then
        warn "running as root: privileged steps skip sudo"
    fi
    ensure_tooling
    ensure_dsh
    ensure_repo
    if [[ "$RESET_ADMIN_PASSWORD" -eq 1 ]]; then
        admin_password_reset
        health_check || true
        exit 0
    fi
    build_workspace
    sync_profile
    copy_host_into_profile
    deploy_ui
    configure_api_key
    verify_composition
    admin_credentials_ensure
    write_systemd_unit
    health_check || die "service did not pass health check"
    print_admin_summary
}
```

> **Note:** `sync_profile` из этапа 1 заменяет каталог профиля целиком — порядок важен: sync (без node_modules) → `copy_host_into_profile` (создаёт node_modules с нашим бандлом). `configure_api_key` и `verify_composition` остаются из этапа 1 без изменений (ключ — по-прежнему в `.credentials.yaml`; композиция теперь включает host).

- [ ] **Step 5: Проверить синтаксис и сброс без сервера**

```bash
bash -n scripts/install.sh && echo "syntax ok"
DSH_HOME=/tmp/dsh-cred-test2 bash -c 'source scripts/install.sh 2>/dev/null; echo sourced-ok'
rm -rf /tmp/dsh-cred-test2
```
Expected: `syntax ok`; без ошибок source. Полная проверка — на VPS (Task 12).

- [ ] **Step 6: Коммит**

```bash
git add scripts/install.sh scripts/admin-creds.mjs
git commit -m "extend installer to stage 2 server with auth and systemd"
```

---

### Task 11: CI — workspace-сборка, тесты, композиция с host

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Tasks 1–9.
- Produces: зелёный CI на push/PR без ключей и LLM: сборка workspace, typecheck, vitest, композиция профиля с host (рецептура install.sh), `bash -n`.

- [ ] **Step 1: Переписать workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Node 22
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Enable corepack pnpm
        run: corepack enable && corepack prepare pnpm@10.0.0 --activate

      - name: Install dsh CLI
        run: npm i -g @deepseek-ai/dsh

      - name: Install workspace deps
        run: pnpm install

      - name: Link core mirror into workspace
        run: node scripts/link-core.mjs

      - name: Typecheck
        run: pnpm -r --if-present run typecheck

      - name: Unit tests (no LLM)
        run: pnpm -r --if-present run test

      - name: Build packages
        run: pnpm -r --if-present run build

      - name: Sync balbes profile + host bundle into DSH_HOME
        run: |
          mkdir -p "$HOME/.dsh/profiles"
          cp -R profiles/balbes "$HOME/.dsh/profiles/balbes"
          mkdir -p "$HOME/.dsh/profiles/balbes/node_modules"
          cp -R packages/bundles/dsh-balbes-host "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-host"
          rm -f "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-host/tsconfig.json"
          rm -rf "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-host/tests" \
                 "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-host/src" \
                 "$HOME/.dsh/profiles/balbes/node_modules/dsh-balbes-host/lib/types"

      - name: Validate profile composition (no LLM)
        run: dsh --profile balbes --dump-config >/dev/null

      - name: Assert no headless / web app in profile
        run: |
          ! dsh --profile balbes --dump-config | grep -q "dsh-headless\|dsh-web-app"

      - name: Validate installer syntax
        run: bash -n scripts/install.sh

      - name: Validate profile manifest is JSON
        run: node -e "JSON.parse(require('fs').readFileSync('profiles/balbes/package.json','utf8'))"
```

> **Note:** если `dsh --dump-config` в CI требует mirror раньше, чем он создаётся автоматически — добавьте перед ним шаг `dsh --profile balbes --dump-config` первого прогрева или `node scripts/link-core.mjs` (линковка уже есть). REAL-тест из Task 6 включается env-переменной `RUN_REAL=1` — в CI оставьте выключенным (быстрый путь), а на VPS проверяется вручную (Task 12).

- [ ] **Step 2: Локальная проверка YAML**

```bash
node -e "const s=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!s.includes('link-core')) process.exit(1); console.log('ci yaml ok')"
```
Expected: `ci yaml ok`.

- [ ] **Step 3: Коммит**

```bash
git add .github/workflows/ci.yml
git commit -m "extend CI to build and test stage 2 workspace"
```

---

### Task 12: Runbook этапа 2 + ручная проверка на VPS

**Files:**
- Create: `docs/runbooks/stage2-vps.md`
- Modify: `docs/runbooks/stage1-vps.md` (ссылка на этап 2; smoke этапа 1 заменён на кнопку/curl)

**Interfaces:**
- Consumes: Task 10 (install.sh), Task 7 (профиль).
- Produces: эксплуатационный runbook этапа 2 — критерий готовности «по runbook'у разворачивается»; ручная проверка DoD (спека 9.4).

- [ ] **Step 1: Написать runbook**

`docs/runbooks/stage2-vps.md` со структурой (содержание — по факту задач 1–11):
- Цель: сервер-демон с админкой (логин + кнопка тестового промпта).
- Требования: Ubuntu, sudo, curl; из этапа 1.
- Установка: `curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash` (сборка workspace, копия host в профиль, SPA в `$DSH_HOME/balbes/ui`, ключ API, генерация логина/пароля, systemd, health).
- Файрвол: `sudo ufw allow 8080/tcp` (и `sudo ufw enable`, если ещё нет).
- Доступ: `http://<IP>:8080`; логин/пароль из лога установки (печатаются один раз).
- Smoke без браузера (curl + JWT) — команды из `print_admin_summary`.
- Обновление: повторный запуск install.sh (git pull + пересборка + рестарт; пароль не меняется).
- Сброс пароля: `bash ~/dsh-balbes-server/scripts/install.sh --reset-admin-password`.
- Проверка демона: `systemctl status dsh-balbes`; после `sudo reboot` сервис активен.
- Устранение неполадок: сервис не стартует (`journalctl -u dsh-balbes -n 50`), health не отвечает, порт занят (`BALBES_PORT`), битый `admin-auth.json`, нет ключа модели.
- Где лежат данные: `$DSH_HOME` (профиль, `admin-auth.json` 600, `.credentials.yaml` 600, `balbes/ui`).

- [ ] **Step 2: Обновить ссылку в runbook этапа 1**

Добавить в шапку `docs/runbooks/stage1-vps.md` строку: «Дальше: Этап 2 (сервер + админка) — `docs/runbooks/stage2-vps.md`».

- [ ] **Step 3: Ручная проверка DoD на VPS (требует доступа пользователя)**

Список проверок — ровно спека 9.4:
```bash
# 1. Демон и reboot
systemctl is-enabled dsh-balbes && systemctl is-active dsh-balbes
sudo reboot   # после возврата:
systemctl is-active dsh-balbes
# 2. Админка и отсутствие штатной морды
curl -fsS -X POST http://127.0.0.1:8080/api/health
ps aux | grep -i dsh | grep -v grep   # один процесс dsh, веб-морды нет
# 3-4. Логин, кнопка/curl: команды из runbook stage2
# 5. 401 без токена
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/prompt -H 'content-type: application/json' -d '{"prompt":"x"}'   # 401
# 6-7. Обновление и сброс пароля — повторный install.sh, --reset-admin-password
# 8. Секреты не в git: в репо нет admin-auth.json/.credentials.yaml
# 9. CI зелёный (GitHub)
# 10. Контракты: host и SPA импортируют dsh-balbes-contracts (typecheck)
```

- [ ] **Step 4: Зафиксировать результат** (в ответе пользователю; при необходимости — правки отдельными коммитами).

- [ ] **Step 5: Коммит**

```bash
git add docs/runbooks/stage2-vps.md docs/runbooks/stage1-vps.md
git commit -m "add stage 2 VPS runbook and link from stage 1"
```

---

### Task 13: Реестр контрактов API (спека 9.2.9 / DoD п. 10)

**Files:**
- Create: `docs/api-contracts.md`

**Interfaces:**
- Consumes: Task 2 (типы в `dsh-balbes-contracts` — имена полей), Task 5–6 (реальные маршруты host).
- Produces: реестр контрактов по шаблону из спеки 9.1 (поле под будущую схему zod/JSON Schema) — человекочитаемый источник рядом с типами.

- [ ] **Step 1: Написать реестр с шаблоном и четырьмя контрактами**

`docs/api-contracts.md`:
```markdown
# API-контракты dsh-balbes-server

Правила: **R-API-1** — все запросы к `/api/*` только POST; JSON тело/ответ;
ошибки — `{error:{code,message}}`. Типы-контракты — `dsh-balbes-contracts`
(`packages/contracts/src/index.ts`); при расхождении реестра и типов побеждают
типы (компилятор), реестр правится в том же изменении.

## Шаблон контракта

### <id> — <название>
- method: POST
- path: /api/<domain>/<action>
- auth: public | bearer
- request:  <поля, типы, обязательность>
- response: <успех: поля, типы>
- errors:   <HTTP-коды и смысл>
- notes:    <что делает, побочные эффекты, будущие изменения>
- schema:   (пока пусто; zod/JSON Schema — при росте API)

## Контракты

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
```

- [ ] **Step 2: Проверить согласованность с типами**

Сверить имена полей с `packages/contracts/src/index.ts` (Task 2) — реестр выше написан по типам; при расхождении правится реестр в этом же коммите.

- [ ] **Step 3: Коммит**

```bash
git add docs/api-contracts.md
git commit -m "add api contract registry with template"
```

---

## Self-Review

**1. Spec coverage (раздел 9 спеки):**
- 9.1 решения: свой host (Task 4–6), R-API-1 (POST-only: все регистрации `http.post`, health тоже POST — Task 6), контракты (Task 2), JWT+scrypt+`admin-auth.json` (Task 3), печать один раз/сброс (Task 10), POST-маршруты и 401 на хендлерах (Task 4 server dispatch + Task 5), SPA React/Vite (Task 8–9), R-TEST-1 (мок fetch — Task 8–9; LLM-stub — Task 6), демон+systemd (Task 10), git-дистрибуция с npm-совместимыми пакетами (Task 1 манифесты).
- 9.2 состав: пакеты host/contracts/admin (Tasks 2–9), профиль base+host (Task 7), auth login/me (Task 5), health/prompt (Task 6), install.sh+systemd (Task 10), runbook (Task 12), CI (Task 11), реестр контрактов по шаблону (Task 13 → `docs/api-contracts.md`).
- 9.3 границы: сессии/чат — НЕ реализуются (runPrompt создаёт свежий агент, Task 6); HTTPS/стриминг/каналы/память — вне задач; web-паттерн чата описан в спеке как задел, в план не входит (верно).
- 9.4 DoD: пункты 1–9 покрыты Task 12/10/11/3/5/6; пункт 10 (реестр) — Task 13.
- 9.5 спайки: 1 (9.1 bullet), 2–3 (Task 10 copy_host_into_profile/deploy_ui + Task 7 Step 4), 4 (Task 1), 5 (Task 3 JWT), 6 (Task 3 scrypt/atomic), 7 (Task 6 REAL-тест), 8 (Task 10 юнит).

**2. Placeholder scan:** все шаги содержат код; единственная осознанная развилка — ключи `settings.yaml` в REAL-тесте (Task 6) с явной приёмкой `stub.calls > 0` и инструкцией, где искать точное имя секции в коде dsh при расхождении. Нет TBD/TODO.

**3. Type consistency:**
- `createAdminAuth()` (с `plaintextPassword`) вместо `generateCredentials()`: Task 3 «Interfaces» и тест согласованы.
- Сервис `balbesHttp` (post/registerStatic) — Task 4 определяет, Task 5/6 используют те же имена.
- Сервис `balbesAuth` {issue, verify} — Task 5; server dispatch вызывает `ctx.get("balbesAuth").verify` (Task 4).
- `runPrompt(ctx)` возвращает `{text, reason?}` — Task 6; api.ts мапит в `PromptResponse`.
- Контракты (Task 2) импортируются SPA-клиентом (Task 8) и по форме совпадают с ответами host (Task 5–6).
