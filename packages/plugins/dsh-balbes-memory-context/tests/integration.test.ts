import { afterAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminAuth, writeAdminAuth } from "../../../bundles/dsh-balbes-host/src/core.js";

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(here, "..");
const hostPkgRoot = join(pkgRoot, "..", "..", "bundles", "dsh-balbes-host");
const memoryPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory");
const memoryAdminPkgRoot = join(pkgRoot, "..", "dsh-balbes-memory-admin");
const contractsPkgRoot = join(pkgRoot, "..", "..", "contracts");
const fixtureProfile = join(here, "fixtures", "balbes-memory-context-profile");
const PROFILE = "balbes-memory-context-test";

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
    [contractsPkgRoot, "tsconfig.build.json"],
    [memoryPkgRoot, "tsconfig.build.json"],
    [memoryAdminPkgRoot, "tsconfig.build.json"],
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
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = "Bearer " + token;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* not json */
  }
  return { status: response.status, json, raw };
}

async function waitForHealth(port: number, child: ReturnType<typeof spawn>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("dsh exited early (code " + child.exitCode + ")");
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/api/health", { method: "POST" });
      const json = (await response.json()) as { ok?: boolean };
      if (response.status === 200 && json.ok === true) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server did not become healthy within " + timeoutMs + "ms");
}

const realEnabled = (process.env.RUN_REAL ?? "").trim() !== "" ? await hasDsh() : false;

describe.skipIf(!realEnabled)("REAL composition (memory delivery)", () => {
  let port: number;
  let login: string;
  let password: string;
  let child: ReturnType<typeof spawn> | null = null;

  async function prepareHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "balbes-memory-context-real-"));
    const profiles = join(home, "profiles");
    await mkdir(profiles, { recursive: true });
    await cp(fixtureProfile, join(profiles, PROFILE), { recursive: true });
    const nm = join(profiles, PROFILE, "node_modules");
    await mkdir(nm, { recursive: true });
    for (const piece of ["lib", "package.json", "cordis.patch.yml"]) {
      await cp(join(hostPkgRoot, piece), join(nm, "dsh-balbes-host", piece), { recursive: true });
    }
    const plugins: Array<[string, string]> = [
      [memoryPkgRoot, "dsh-balbes-memory"],
      [memoryAdminPkgRoot, "dsh-balbes-memory-admin"],
      [pkgRoot, "dsh-balbes-memory-context"]
    ];
    for (const [root, dirName] of plugins) {
      await cp(join(root, "lib"), join(nm, dirName, "lib"), { recursive: true });
      await cp(join(root, "package.json"), join(nm, dirName, "package.json"));
    }
    const creds = await createAdminAuth();
    login = creds.login;
    password = creds.plaintextPassword;
    await writeAdminAuth(home, creds);
    return home;
  }

  async function bootServer(home: string): Promise<string> {
    child = spawn("dsh", ["--profile", PROFILE], {
      env: { ...process.env, DSH_HOME: home, BALBES_PORT: String(port), DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "test-key" },
      cwd: home,
      stdio: "ignore"
    });
    await waitForHealth(port, child);
    const loginRes = await postJson("http://127.0.0.1:" + port + "/api/auth/login", { login, password });
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

  afterAll(async () => {
    await stopServer();
  }, 60_000);

  it("delivers the pinned core, the task-relevant push and the recall tool", async () => {
    const stubUrl = new URL("./helpers/stub-llm.mjs", import.meta.url).href;
    const { startStubLlm } = (await import(stubUrl)) as {
      startStubLlm(options?: { text?: string }): Promise<{
        port: number;
        calls: Array<{ path: string; body: { system?: unknown; tools?: unknown; messages?: unknown } }>;
        setScript(
          script: Array<{ text?: string; toolCall?: { name: string; arguments: string } }>
        ): void;
        close(): Promise<void>;
      }>;
    };
    await buildPackages();
    port = await freePort();
    const coreMarker = "p10c-core-marker-4b8e";
    const pushMarker = "p10c-push-marker-9d17";
    const livenessMarker = "p10c-liveness-marker-5c02";
    const stub = await startStubLlm({ text: "ok from stub" });
    const home = await prepareHome();
    try {
      await writeFile(
        join(home, "settings.yaml"),
        "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nllm-deepseek:\n  baseURL: http://127.0.0.1:" + stub.port + "\n"
      );
      const base = "http://127.0.0.1:" + port;
      const token = await bootServer(home);

      const coreSave = await postJson(
        base + "/api/memory/save",
        { scope: { kind: "global" }, type: "fact", text: "Pinned core " + coreMarker + " always visible", pinned: true, tags: ["p10c"] },
        token
      );
      expect(coreSave.status, coreSave.raw).toBe(200);
      const pushSave = await postJson(
        base + "/api/memory/save",
        // Маркер стоит за пределами MAP_PREVIEW (100 символов), поэтому его может нести только
        // push-блок: preview карты обрывается раньше, и ассерт доказывает именно push-доставку.
        { scope: { kind: "global" }, type: "decision", text: "deploy " + "a".repeat(120) + " " + pushMarker, pinned: false },
        token
      );
      expect(pushSave.status, pushSave.raw).toBe(200);

      const before = stub.calls.length;
      const first = await postJson(base + "/api/prompt", { prompt: "deploy checks" }, token);
      expect(first.status, first.raw).toBe(200);
      const calls = stub.calls.slice(before);
      expect(calls.length).toBeGreaterThan(0);
      const systems = calls.map((call) => (typeof call.body.system === "string" ? call.body.system : "")).join("\n");
      expect(systems, systems.slice(0, 4000)).toContain(coreMarker);
      const serialized = JSON.stringify(calls.map((call) => call.body));
      expect(serialized, serialized.slice(0, 4000)).toContain(pushMarker);
      expect(JSON.stringify(calls.map((call) => call.body.tools))).toContain("recall");

      const livenessSave = await postJson(
        base + "/api/memory/save",
        { scope: { kind: "global" }, type: "fact", text: "Pinned later " + livenessMarker, pinned: true },
        token
      );
      expect(livenessSave.status, livenessSave.raw).toBe(200);
      const boundary = stub.calls.length;
      const second = await postJson(base + "/api/prompt", { prompt: "anything else" }, token);
      expect(second.status, second.raw).toBe(200);
      const secondSystems = stub.calls
        .slice(boundary)
        .map((call) => (typeof call.body.system === "string" ? call.body.system : ""))
        .join("\n");
      expect(secondSystems, secondSystems.slice(0, 4000)).toContain(livenessMarker);

      const rememberMarker = "p10eremembermarker7a31";
      stub.setScript([
        {
          toolCall: {
            name: "remember",
            arguments: JSON.stringify({ text: "durable fact " + rememberMarker, type: "fact" })
          }
        },
        { text: "saved" }
      ]);
      const writeRun = await postJson(base + "/api/prompt", { prompt: "Remember the durable fact" }, token);
      expect(writeRun.status, writeRun.raw).toBe(200);

      const listRes = await postJson(base + "/api/memory/list", { query: rememberMarker }, token);
      expect(listRes.status, listRes.raw).toBe(200);
      const records = (listRes.json as { records: Array<Record<string, unknown>> }).records;
      const saved = records.find(
        (entry) => typeof entry.text === "string" && entry.text.includes(rememberMarker)
      );
      expect(saved, JSON.stringify(records)).toBeDefined();
      expect(saved!.origin).toBe("agent");
      expect(saved!.pinned).toBe(false);
      expect(saved!.type).toBe("fact");
      expect(String(saved!.originRef)).toMatch(/^admin session:/);

      // Write→read convergence: the record the model wrote is delivered back to the
      // model by the next prompt (map/push), so write and read meet. The prompt is
      // deliberately marker-free and the assertion reads `system` only: the record is
      // unpinned, so delivery happens through the map/push sections of the system
      // prompt — the request's own user message must not be able to satisfy this.
      stub.setScript([{ text: "noted" }]);
      const deliveryBefore = stub.calls.length;
      const delivery = await postJson(base + "/api/prompt", { prompt: "what do you know about this system?" }, token);
      expect(delivery.status, delivery.raw).toBe(200);
      const deliveryCalls = stub.calls.slice(deliveryBefore);
      expect(deliveryCalls.length).toBeGreaterThan(0);
      const deliverySystems = deliveryCalls
        .map((call) => (typeof call.body.system === "string" ? call.body.system : ""))
        .join("\n");
      expect(deliverySystems, deliverySystems.slice(0, 4000)).toContain(rememberMarker);

      // p10f: a staged proposal is not knowledge until the owner approves it.
      const proposalMarker = "p10fproposalmarker6e40";
      const proposalRes = await postJson(
        base + "/api/memory/propose",
        {
          scope: { kind: "global" },
          type: "fact",
          text: "Pending " + proposalMarker + " must not be delivered before review",
          originRef: "pipeline:real-test"
        },
        token
      );
      expect(proposalRes.status, proposalRes.raw).toBe(200);
      const proposalId = (proposalRes.json as { proposal: { id: string } }).proposal.id;

      stub.setScript([{ text: "pending run" }]);
      const beforePending = stub.calls.length;
      const pendingRun = await postJson(base + "/api/prompt", { prompt: "anything about pending" }, token);
      expect(pendingRun.status, pendingRun.raw).toBe(200);
      const pendingCalls = stub.calls.slice(beforePending);
      // A non-empty slice is the precondition: JSON.stringify([]) trivially
      // satisfies not.toContain, so the negative assertion needs real bodies.
      expect(pendingCalls.length).toBeGreaterThan(0);
      const pendingBodies = JSON.stringify(pendingCalls.map((call) => call.body));
      expect(pendingBodies, pendingBodies.slice(0, 4000)).not.toContain(proposalMarker);

      const approveRes = await postJson(base + "/api/memory/review/approve", { id: proposalId }, token);
      expect(approveRes.status, approveRes.raw).toBe(200);

      stub.setScript([{ text: "approved run" }]);
      const beforeApproved = stub.calls.length;
      const approvedRun = await postJson(base + "/api/prompt", { prompt: "anything about pending" }, token);
      expect(approvedRun.status, approvedRun.raw).toBe(200);
      const approvedBodies = JSON.stringify(stub.calls.slice(beforeApproved).map((call) => call.body));
      expect(approvedBodies, approvedBodies.slice(0, 4000)).toContain(proposalMarker);

      // p10h: наблюдаемость доставки — снимок без текста памяти.
      const metricsRes = await postJson(base + "/api/memory/metrics", {}, token);
      expect(metricsRes.status, metricsRes.raw).toBe(200);
      const metrics = (metricsRes.json as { metrics: Record<string, unknown> }).metrics;
      // Снимок admin-ручки — ЛОКАЛЬНОЕ структурное зеркало memory-context
      // (`MemoryMetricsSnapshotLike` в admin/src/routes.ts, без компиляторной связи
      // между пакетами). REAL-тест — единственное место, где оба пакета встречаются,
      // поэтому дрейф ключей обязан краснеть здесь: канон (API_CONTRACTS.md →
      // `memory.metrics`) документирует ровно этот набор полей.
      expect(Object.keys(metrics).sort(), JSON.stringify(metrics)).toEqual([
        "byChannel",
        "byScope",
        "dropped",
        "process",
        "recall",
        "schema",
        "topRecords",
        "unqueriedDelivered",
        "window"
      ]);
      const admin = (metrics.byChannel as Record<string, { turns: number; deliveries: number }>).admin;
      expect(admin, JSON.stringify(metrics.byChannel)).toBeDefined();
      expect(admin!.turns).toBeGreaterThanOrEqual(1);
      expect(admin!.deliveries).toBeGreaterThanOrEqual(1);
      const topRecords = metrics.topRecords as Array<{ id: string; type: string; scope: string; inCore: number }>;
      const pinnedId = (coreSave.json as { record: { id: string } }).record.id;
      const tracked = topRecords.find((entry) => entry.id === pinnedId);
      expect(tracked, JSON.stringify(topRecords)).toBeDefined();
      expect(tracked!.inCore).toBeGreaterThanOrEqual(1);
      expect(tracked!.type).toBe("fact");
      expect(tracked!.scope).toBe("global");
      // Форма записи зеркала обязана совпадать с `MemoryMetricsRecordMetrics`.
      // Ключи читаются с `tracked` — доказанного выше элемента, а не с первого
      // в выдаче: `topRecords` сортируется по числу попаданий, и первый элемент
      // не обязан быть той записью, существование которой уже проверено.
      expect(Object.keys(tracked!).sort(), JSON.stringify(tracked)).toEqual([
        "id",
        "inCore",
        "inMap",
        "inPush",
        "recallDelivered",
        "recallQueries",
        "scope",
        "type"
      ]);
      // Приватность: ни текст памяти, ни originRef в снимок не попадают.
      // Ручка отдаёт снимок четырежды (окно, детальный снимок top:100, reset и
      // пустое окно после reset) — сканируем каждый ответ, а не только первый.
      const expectPrivate = (label: string, raw: string): void => {
        for (const secret of [coreMarker, pushMarker, rememberMarker, proposalMarker, "originRef"]) {
          expect(raw, label).not.toContain(secret);
        }
      };
      expectPrivate("metrics window", metricsRes.raw);

      // recall: вызов с попаданием учитывается, пустой результат — промах.
      stub.setScript([
        { toolCall: { name: "recall", arguments: JSON.stringify({ query: "deploy checks" }) } },
        { text: "recalled" }
      ]);
      const recallRun = await postJson(base + "/api/prompt", { prompt: "recall please" }, token);
      expect(recallRun.status, recallRun.raw).toBe(200);
      stub.setScript([
        { toolCall: { name: "recall", arguments: JSON.stringify({ query: "zzz-nonexistent-subject" }) } },
        { text: "nothing matched" }
      ]);
      const emptyRun = await postJson(base + "/api/prompt", { prompt: "recall the impossible" }, token);
      expect(emptyRun.status, emptyRun.raw).toBe(200);
      // Снимок без reset окно не мутирует, а `top: 100` нужен, чтобы попадание
      // по id доставленной записи не срезалось сортировкой top-N: окно уже
      // содержит больше пяти записей с попаданиями.
      const recallDetailRes = await postJson(base + "/api/memory/metrics", { top: 100 }, token);
      expect(recallDetailRes.status, recallDetailRes.raw).toBe(200);
      const recallDetail = (recallDetailRes.json as {
        metrics: { topRecords: Array<{ id: string; recallDelivered: number; recallQueries: number }> };
      }).metrics;
      const recallRes = await postJson(base + "/api/memory/metrics", { reset: true, top: 5 }, token);
      expect(recallRes.status, recallRes.raw).toBe(200);
      const recallMetrics = (recallRes.json as { metrics: { recall: { calls: number; empty: number; failed: number } } }).metrics;
      // Каждое recall-обращение стаба даёт вызов инструмента, но точное число
      // вызовов здесь — свойство харнесса, а не p10h: путь admin-промпта делает
      // дополнительный запрос к модели без инструментов, а очередь скрипта стаба
      // round-robin, поэтому промпт повторно входит в свой скрипт и зовёт recall
      // дважды. Пиннуем нижнюю границу, а конкретику попадания — по id записи.
      expect(recallMetrics.recall.calls).toBeGreaterThanOrEqual(2);
      expect(recallMetrics.recall.empty).toBeGreaterThanOrEqual(1);
      expect(recallMetrics.recall.failed).toBe(0);
      // Первый recall («deploy checks») вернул push-запись: попадание видно по
      // её id, а не только по общему `empty`.
      const recalledId = (pushSave.json as { record: { id: string } }).record.id;
      const recalled = recallDetail.topRecords.find((entry) => entry.id === recalledId);
      expect(recalled, JSON.stringify(recallDetail.topRecords)).toBeDefined();
      expect(recalled!.recallDelivered).toBeGreaterThanOrEqual(1);
      expectPrivate("recall detail window (top:100)", recallDetailRes.raw);
      // reset закрыл окно: следующий вызов видит пустое окно и сохранённые тоталы.
      const afterReset = await postJson(base + "/api/memory/metrics", {}, token);
      expect(afterReset.status, afterReset.raw).toBe(200);
      const resetMetrics = (afterReset.json as { metrics: { window: { turns: number }; process: { totals: { turns: number } } } }).metrics;
      expect(resetMetrics.window.turns).toBe(0);
      expect(resetMetrics.process.totals.turns).toBeGreaterThanOrEqual(1);
      expectPrivate("reset window", recallRes.raw);
      expectPrivate("window after reset", afterReset.raw);
    } finally {
      await stopServer();
      await rm(home, { recursive: true, force: true });
      await stub.close();
    }
  }, 300_000);
});
