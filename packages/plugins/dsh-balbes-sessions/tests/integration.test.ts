import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, rm, writeFile, readdir, stat as statFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

/**
 * REAL-композиция домена сессий: настоящий профиль dsh (dsh-base + host-бандл
 * + balbes-workspaces + balbes-sessions), поднятый настоящим CLI. Проверяются
 * реальные ручки, реальный реестр на диске и реальные коды ошибок; движок
 * сессий — настоящий (во втором сценарии в нём просто нет сессий, поэтому
 * годные записи реестра отсеиваются, а повреждённый реестр даёт 500).
 *
 * Третий сценарий — положительный контроль к этому отсеиванию: сессию создаёт
 * настоящий /api/prompt, и её заголовок с временем создания приходят из
 * движка. Единственная подмена — внешняя LLM-граница: адаптер
 * deepseek-official направлен на локальный SSE-стаб
 * (`tests/helpers/stub-llm.mjs`, тем же приёмом, что и telegram REAL). Всё
 * остальное — shipped код: композиция профиля, ручки плагинов, реестр на
 * диске, движок сессий и персистенция.
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

  /** Сервер, поднятый в каталоге проекта: cwd сессии из /api/prompt = этот каталог. */
  async function bootServerWithCwd(home: string, cwd: string): Promise<string> {
    child = spawn("dsh", ["--profile", PROFILE], {
      env: {
        ...process.env,
        DSH_HOME: home,
        BALBES_PORT: String(port),
        DSH_TELEMETRY_DISABLED: "1",
        // адаптер deepseek-official требует ключ даже против стаба (как в telegram REAL)
        DEEPSEEK_API_KEY: "test-key"
      },
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
      const registry = join(home, "workspace-sessions.json");
      let token = await bootServer(home);

      // 401 без токена
      const anon = await postJson(`${base}/api/sessions/list`, { scope: "home" });
      expect(anon.status).toBe(401);

      // 400: битая форма, неизвестный scope, name у дома
      expect((await postJson(`${base}/api/sessions/list`, [], token)).status).toBe(400);
      expect((await postJson(`${base}/api/sessions/list`, { scope: "galaxy" }, token)).status).toBe(400);
      expect((await postJson(`${base}/api/sessions/list`, { scope: "project" }, token)).status).toBe(400);
      expect((await postJson(`${base}/api/sessions/list`, { scope: "home", name: "alpha" }, token)).status).toBe(400);

      // 404: проект не существует. Текст обязателен: сам http-сит отвечает на
      // незарегистрированный путь тем же кодом not-found, поэтому код в
      // одиночку не доказывает, что ответила именно ручка плагина.
      const missing = await postJson(`${base}/api/sessions/list`, { scope: "project", name: "nope" }, token);
      expect(missing.status).toBe(404);
      expect((missing.json as { error?: { code?: string } }).error?.code).toBe("not-found");
      expect((missing.json as { error?: { message?: string } }).error?.message).toMatch(/^project not found: nope$/);

      // проект создаётся реальной ручкой, список сессий пуст (реестра ещё нет)
      const created = await postJson(`${base}/api/workspaces/create`, { name: "alpha" }, token);
      expect(created.status, created.raw).toBe(200);
      const empty = await postJson(`${base}/api/sessions/list`, { scope: "project", name: "alpha" }, token);
      expect(empty.status, empty.raw).toBe(200);
      expect(empty.json).toEqual({ sessions: [] });
      // Пусто именно потому, что реестра ещё нет, а не потому, что он разобран
      // как пустой документ.
      expect(existsSync(registry)).toBe(false);

      // Реестр читается один раз за жизнь процесса (WorkspaceSessionsRegistry
      // кэширует состояние), поэтому каждое состояние файла наблюдает свой
      // процесс: запись в реестр после первого `list` этому процессу уже не
      // видна, и повреждённый файл молча выглядел бы «пусто».
      await stopServer();
      await writeFile(
        registry,
        JSON.stringify({ version: 1, workspaces: { "project:alpha": [{ sessionId: "session-ghost", channel: "telegram" }] } }),
        "utf8"
      );
      expect(existsSync(registry)).toBe(true);
      token = await bootServer(home);

      // реестр с неизвестной движку сессией: запись отсеивается
      const ghost = await postJson(`${base}/api/sessions/list`, { scope: "project", name: "alpha" }, token);
      expect(ghost.status, ghost.raw).toBe(200);
      expect(ghost.json).toEqual({ sessions: [] });

      // повреждённый реестр — 500, а не «пусто»
      await stopServer();
      await writeFile(registry, "{not json", "utf8");
      token = await bootServer(home);
      const broken = await postJson(`${base}/api/sessions/list`, { scope: "project", name: "alpha" }, token);
      expect(broken.status).toBe(500);
      expect((broken.json as { error?: { message?: string } }).error?.message).toMatch(/not valid JSON/);
    } finally {
      await stopServer();
      await rm(home, { recursive: true, force: true });
    }
  }, 240_000);

  /**
   * Настоящая сессия в рабочем каталоге проекта: /api/prompt создаёт свежую
   * сессию с cwd = process.cwd() сервера, поэтому сервер поднимается в
   * каталоге проекта, а id находится сканированием $DSH_HOME/sessions.
   *
   * Это положительный контроль ко второму сценарию: там `{sessions: []}` сам по
   * себе не различал «реестр прочитан, а запись отсеяна движком» и «реестр не
   * прочитан». Здесь годная запись есть, и ответ обязан её показать.
   */
  it("lists a real session with the title and creation time from the engine", async () => {
    const stubUrl = new URL("./helpers/stub-llm.mjs", import.meta.url).href;
    const { startStubLlm } = (await import(stubUrl)) as {
      startStubLlm(options?: { text?: string }): Promise<{ port: number; close(): Promise<void> }>;
    };
    const stub = await startStubLlm({ text: "ok from stub" });
    const home = await prepareHome();
    try {
      // Каталог проекта создаётся заранее: сервер поднимается ИМЕННО в нём, чтобы
      // cwd сессии из /api/prompt совпал с корнем воркспейса. Ручная папка —
      // валидный проект (каталог — источник правды), поэтому /api/workspaces/create
      // здесь не нужен.
      const projectDir = join(home, "projects", "alpha");
      await mkdir(projectDir, { recursive: true });
      // default model -> deepseek-official, adapter -> stub (ключ даёт env, как в telegram REAL)
      await writeFile(
        join(home, "settings.yaml"),
        `agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nllm-deepseek:\n  baseURL: http://127.0.0.1:${stub.port}\n`
      );
      const base = `http://127.0.0.1:${port}`;
      const token = await bootServerWithCwd(home, projectDir);

      const prompt = await postJson(`${base}/api/prompt`, { prompt: "Reply with exactly: ok from stub" }, token);
      expect(prompt.status, prompt.raw).toBe(200);

      const sessionId = await findNewSessionId(home);
      expect(sessionId).toMatch(/^session-/);

      // ПОРЯДОК ЗДЕСЬ КРИТИЧЕН, НЕ ПЕРЕСТАВЛЯТЬ. Реестр читается один раз за
      // жизнь процесса: WorkspaceSessionsRegistry.load() мемоизирует состояние,
      // экземпляр один на процесс, и читает его только ручка sessions.list.
      // Поэтому запись файла «сбоку» обязана случиться ДО первого за жизнь
      // этого процесса вызова sessions.list — иначе она этому процессу уже не
      // видна, и сценарий позеленел бы/покраснел по неверной причине. Текущий
      // порядок: boot -> prompt -> запись файла -> list; ни одного
      // sessions.list (и вообще ничего, что трогает store) до этой строки
      // добавлять нельзя.
      //
      // Зарегистрировать сессию через сервис balbesSessions в этом фикстурном
      // профиле тоже нельзя: HTTP-ручки регистрации нет, а telegram —
      // единственный вызывающий register() — в профиль не входит. «Сбоку, но
      // до первого чтения» здесь единственный корректный путь.
      await writeFile(
        join(home, "workspace-sessions.json"),
        JSON.stringify({ version: 1, workspaces: { "project:alpha": [{ sessionId, channel: "telegram" }] } }),
        "utf8"
      );

      // Запись реестра состоит ровно из двух полей — { sessionId, channel }
      // (WorkspaceSessionEntry): ни заголовка, ни времени создания реестр не
      // хранит вообще, и подставить их «из реестра» физически нечем. Их
      // приносит движок: sessionQuery.readTitleSnapshots отдаёт header сессии
      // (оттуда createdAt) и сложенный из лога сессии заголовок. Проверки ниже
      // доказывают именно это: id — тот, что движок материализовал на диске,
      // заголовок — непустая строка, время — валидная ISO-дата.
      const listed = await postJson(`${base}/api/sessions/list`, { scope: "project", name: "alpha" }, token);
      expect(listed.status, listed.raw).toBe(200);
      const sessions = (listed.json as { sessions: Array<{ id: string; title: string | null; channel: string; createdAt: string }> }).sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe(sessionId);
      expect(sessions[0]?.channel).toBe("telegram");
      // Значение заголовка не фиксируем: его ставит движок (LLM-провайдер
      // заголовков поверх стаба либо детерминированный fallback из первого
      // промпта) — это не граница плагина. Непустая строка доказывает, что
      // заголовок дошёл от движка, а не остался null.
      expect(typeof sessions[0]?.title).toBe("string");
      expect((sessions[0]?.title ?? "").length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(sessions[0]?.createdAt ?? ""))).toBe(false);
    } finally {
      await stopServer();
      await rm(home, { recursive: true, force: true });
      await stub.close();
    }
  }, 300_000);
});
