import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, rm, writeFile, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

/**
 * REAL-композиция агентского дома: настоящий профиль dsh (dsh-base +
 * host-бандл + balbes-home), поднятый настоящим CLI. Проверяется не форма
 * регистрации секции, а её фактический путь до модели: строка из
 * `$DSH_HOME/agent/self.md` обязана оказаться в системном промпте в теле
 * запроса, который получает LLM. Единственная подмена — внешняя LLM-граница:
 * адаптер deepseek-official направлен на локальный SSE-стаб
 * (`tests/helpers/stub-llm.mjs`, тем же приёмом, что и соседние REAL-наборы).
 *
 * Два прохода с одним и тем же запущенным сервером доказывают обе стороны:
 *   1) self.md есть — маркер в системном промпте;
 *   2) self.md удалён — следующая сборка промпта идёт БЕЗ маркера.
 * Второй проход — это и проверка ЖИВОСТИ чтения: плагин кеширует файл по
 * mtime, и удаление обязано сбросить кеш, а не оставить прошлый текст навсегда.
 *
 * Гейт: RUN_REAL=1 и `dsh` в PATH (как у соседних REAL-наборов).
 */

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const fixtureProfile = join(here, "fixtures", "balbes-home-profile");
const PROFILE = "balbes-home-test";

interface StubCall {
  path: string;
  body: { messages?: Array<{ role?: string; content?: unknown }> };
}
interface StubLlm {
  port: number;
  calls: StubCall[];
  close(): Promise<void>;
}

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

/** Сериализованное содержимое системного сообщения запроса (или "{}"). */
function systemText(call: StubCall): string {
  const system = (call.body.messages ?? []).find((message) => message.role === "system");
  return JSON.stringify(system ?? {});
}

const realEnabled = (process.env.RUN_REAL ?? "").trim() !== "" ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (agent home self.md)", () => {
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;

  /** Один деплоябельный тестовый дом: фикстура профиля + собранные пакеты в node_modules. */
  async function prepareHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "balbes-home-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, PROFILE), { recursive: true });
    const nm = join(profiles, PROFILE, "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    for (const piece of ["lib", "package.json"]) {
      await cp(join(pkgRoot, piece), join(nm, "dsh-balbes-home", piece), { recursive: true });
    }
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(home, creds);
    return home;
  }

  async function bootServer(home: string): Promise<string> {
    child = spawn("dsh", ["--profile", PROFILE], {
      env: {
        ...process.env,
        DSH_HOME: home,
        BALBES_PORT: String(port),
        DSH_TELEMETRY_DISABLED: "1",
        // адаптер deepseek-official требует ключ даже против стаба (как в telegram REAL)
        DEEPSEEK_API_KEY: "test-key"
      },
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

  it("puts $DSH_HOME/agent/self.md into the system prompt the model receives", async () => {
    const stubUrl = new URL("./helpers/stub-llm.mjs", import.meta.url).href;
    const { startStubLlm } = (await import(stubUrl)) as {
      startStubLlm(options?: { text?: string }): Promise<StubLlm>;
    };
    // Маркер без пробелов и без `{{`: строка переживает trim/схлопывание и не
    // задевает строгую интерполяцию промпта.
    const marker = "balbes-self-probe-7f3a2c";
    const promptText = "Reply with exactly: ok";
    const stub = await startStubLlm({ text: "ok from stub" });
    const home = await prepareHome();
    try {
      const agentDir = join(home, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "self.md"), `# Agent self

${marker}
`, "utf8");
      // default model -> deepseek-official, adapter -> stub (ключ даёт env, как в telegram REAL)
      await writeFile(
        join(home, "settings.yaml"),
        `agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
llm-deepseek:
  baseURL: http://127.0.0.1:${stub.port}
`
      );
      const base = `http://127.0.0.1:${port}`;
      const token = await bootServer(home);

      // Проход 1: self.md существует прямо сейчас. Секция плагина входит в
      // сборку промпта, и системное сообщение запроса обязано нести маркер.
      // Границы между проходами по индексам стаба: один /api/prompt может
      // породить несколько запросов (например, заголовок сессии), поэтому
      // проверяется весь системный текст новых запросов, а не один «последний».
      const before = stub.calls.length;
      const first = await postJson(`${base}/api/prompt`, { prompt: promptText }, token);
      expect(first.status, first.raw).toBe(200);
      const firstCalls = stub.calls.slice(before);
      expect(firstCalls.length).toBeGreaterThan(0);
      const firstSystem = firstCalls.map(systemText).join("\n");
      expect(firstSystem, firstSystem.slice(0, 4000)).toContain(marker);

      // Проход 2: файл удалён, тот же процесс сервера. Сборка промпта для
      // свежего агента рендерит секцию заново; mtime-кеш обязан сброситься, и
      // маркер не имеет права остаться ни в одном новом запросе. Промпт
      // маркера не содержит, так что источник у него ровно один — self.md.
      await unlink(join(agentDir, "self.md"));
      const boundary = stub.calls.length;
      const second = await postJson(`${base}/api/prompt`, { prompt: promptText }, token);
      expect(second.status, second.raw).toBe(200);
      const secondCalls = stub.calls.slice(boundary);
      expect(secondCalls.length).toBeGreaterThan(0);
      for (const call of secondCalls) {
        const serialized = JSON.stringify(call.body);
        expect(serialized, serialized.slice(0, 4000)).not.toContain(marker);
      }
    } finally {
      await stopServer();
      await rm(home, { recursive: true, force: true });
      await stub.close();
    }
  }, 300_000);
});
