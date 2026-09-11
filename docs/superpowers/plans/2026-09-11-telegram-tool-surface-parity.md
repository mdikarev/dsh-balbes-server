# Telegram Tool-Surface Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Снять per-agent allow-фильтр и read-containment-guard у Telegram-задач, чтобы агент видел и мог вызывать весь набор инструментов процесса (bash, web_fetch, skill, subagent и т.д.), как Web-агент.

**Architecture:** `composeAgentSetup` в `dsh-balbes-telegram` перестаёт регистрировать `tools.restrict`/`tools.guard` и оставляет только `installModelSelection`. Процессный sandbox и approval-политика не меняются. Все тесты, кодировавшие старую границу, переписываются под паритет; канон обновляется первым (canon-first).

**Tech Stack:** TypeScript (strict, ESM), Node ≥ 22, Cordis-плагины dsh 0.1.5-rc.2, vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-11-telegram-tool-surface-parity-design.md`

## Global Constraints

- dsh — зависимость, не форк: установленные `@deepseek-ai/*` не редактируются.
- `docs/canon/**` руками не правится: Task 1 выполняется через навык `canon-write`; после него нужен явный go-ahead владельца до любого кода.
- Процессный sandbox/approval не меняется: `DSH_PERMISSION_MODE` остаётся `workspace-write`, approval — `ask`. `danger-full-access` не берём.
- Плагин остаётся функциональным (`name`/`inject`/`Config`/`apply`, без default-export).
- Относительные импорты внутри пакета — с `.js`-расширением (стиль репозитория).
- После каждого кода-task: `pnpm --filter dsh-balbes-telegram run typecheck` и `pnpm --filter dsh-balbes-telegram run test`.
- REAL-наборы — только с `RUN_REAL=1` и `dsh` на PATH.
- Коммит после каждого task в стиле репозитория (`refactor(telegram): …`, `test(telegram): …`, `docs(canon): …`).

---

## File Structure

**Изменяются:**

- `packages/plugins/dsh-balbes-telegram/src/agentTask.ts` — удаляются restrict/guard и мёртвый код.
- `packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts` — hermetic-блок поверхности заменяется.
- `packages/plugins/dsh-balbes-telegram/tests/agentTask.real.test.ts` — REAL surface-тесты под паритет.
- `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts` — убирается containment-сценарий.
- `packages/bundles/dsh-balbes-host/tests/seams.test.ts` — только комментарии.
- `docs/canon/ARCHITECTURE.md`, `docs/canon/OVERVIEW.md` — через `canon-write`.
- `docs/runbooks/stage2-vps.md` — раздел о границах канала.

---

### Task 1: Канон и runbook под паритет (canon-first)

**Files:**
- Modify via canon-write: `docs/canon/ARCHITECTURE.md:211-214`, `docs/canon/OVERVIEW.md:79-80`
- Modify: `docs/runbooks/stage2-vps.md:299-342`

- [ ] **Step 1: Вызвать навык `canon-write`** для топика "telegram tool-surface parity".
  Выполнить `doc-canon scout "telegram tool surface parity containment"`, показать working set и verdict, затем deep-read только ARCHITECTURE/OVERVIEW.
  Переписать `ARCHITECTURE.md` §211–214: убрать allow-фильтр, read-guard и запрет `web_fetch`; написать, что Telegram-задача имеет полную поверхность процесса, а границы — sandbox/approval движка.
  Переписать `OVERVIEW.md` §79–80: убрать формулировку про "без shell, skill, subagent".
- [ ] **Step 2: Валидировать канон**
  Run: `doc-canon validate --json`
  Expected: exit 0 и ноль issues severity error. Затем `doc-canon index`.
- [ ] **Step 3: Обновить runbook**
  Переписать `docs/runbooks/stage2-vps.md:299-342`: у задачи полный набор инструментов; доступ к сети и файлам как у Web-агента; границы — sandbox-политика процесса; убрать абзац о намеренной недоступности `web_fetch`.
- [ ] **Step 4: Commit**
  `git add docs/canon docs/runbooks/stage2-vps.md && git commit -m "docs(canon): telegram tool-surface parity"`
- [ ] **Step 5: CHECKPOINT — остановиться и взять go-ahead владельца** (canon-write требует явного подтверждения после существенной правки канона перед кодом).

---

### Task 2: Убрать restrict/guard в `composeAgentSetup` (TDD, hermetic)

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/src/agentTask.ts:1-7,442-739,750`
- Test: `packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts:1095-1418`

**Interfaces:**
- Produces: `composeAgentSetup(agentCtx: unknown, options: { selection: ModelSelectionRefLike }): void` — устанавливает только живой выбор модели.

- [ ] **Step 1: Переписать hermetic-тесты (ожидаемо падают).**
  Удалить `KEPT_BY_CONTRACT` (строки 1181–1198).
  Полностью заменить `describe("composeAgentSetup tool surface", …)` (строки 1200–1359) на:

```ts
describe("composeAgentSetup tool surface", () => {
  it("applies no restriction and no path guard: the agent keeps the whole deployment surface", () => {
    const registered = ["read", "write", "bash", "web_fetch", "skill", "some_future_shell"];
    const tools = makeTools(registered);
    composeAgentSetup(makeAgentCtx(tools), { selection: { current: SELECTION } });
    expect(tools.restrictions).toEqual([]);
    expect(tools.guards).toEqual([]);
  });

  it("installs neither restriction nor guard through the create and resume callbacks", async () => {
    const registered = ["read", "write", "bash", "web_fetch", "skill"];
    const created = await makeRunner();
    await created.runner.run(PROJECT_ALPHA, "first task");
    const createTools = makeTools(registered);
    created.agents.createOpts[0]!.setup(makeAgentCtx(createTools));
    expect(createTools.restrictions).toEqual([]);
    expect(createTools.guards).toEqual([]);

    const resumed = await makeRunner();
    await resumed.runner.run(PROJECT_BRAVO, "resume me", { sessionId: "session-known" });
    const resumeTools = makeTools(registered);
    resumed.agents.resumeOpts[0]!.setup(makeAgentCtx(resumeTools));
    expect(resumeTools.restrictions).toEqual([]);
    expect(resumeTools.guards).toEqual([]);
  });
});
```

  В `describe("live model selection", …)` убрать поле `root` из вызовов `composeAgentSetup` (строки ~1366, ~1398, ~1418): аргумент становится `{ selection: … }`.

- [ ] **Step 2: Убедиться, что тесты падают**
  Run: `pnpm --filter dsh-balbes-telegram run test -- agentTask.test.ts`
  Expected: FAIL — сейчас `restrictions`/`guards` заполняются.

- [ ] **Step 3: Реализация в `src/agentTask.ts`.**
  Импорт-блок (строки 1–7) становится:

```ts
import { randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
```

  Удалить целиком: `KEPT_TOOL_NAMES`, `FALLBACK_DENIED_TOOL_NAMES`, `restrictToolSurface`, `ToolsSurface`, `READ_PATH_ARG_BY_TOOL`, `GuardExecLike`, `rootEscapes` (диапазон от `const KEPT_TOOL_NAMES` до конца `rootEscapes`), а также большой doc-комментарий "WHAT IS CONTAINED / WHAT IS NOT CONTAINED".

  `AgentSetupOptions` (508–517) сводится к:

```ts
export interface AgentSetupOptions {
  selection: ModelSelectionRefLike;
}
```

  `composeAgentSetup` (722–739) сводится к:

```ts
export function composeAgentSetup(agentCtx: unknown, options: AgentSetupOptions): void {
  installModelSelection(agentCtx as never, options.selection as never);
}
```

  Вызов в `acquireHandle` (строка 750) становится:

```ts
  composeAgentSetup(agentCtx, { selection: selection.ref });
```

  `liveSelection`, `ModelSelectionRefLike`, `PROGRESS_TARGET_ARG` и весь остальной код не трогаются. `root` в `acquireHandle` продолжает использоваться для `meta: { cwd: root }`.

- [ ] **Step 4: Проверить, что проходит**
  Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram run test -- agentTask.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add packages/plugins/dsh-balbes-telegram/src/agentTask.ts packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts && git commit -m "refactor(telegram): drop per-agent tool restriction and read guard"`

---

### Task 3: REAL-набор — паритет поверхности

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/tests/agentTask.real.test.ts:33-38,52-158,218-252,340-360,418-505,525-727`

- [ ] **Step 1: Удалить константы старой границы.**
  Удалить `KEPT_TOOLS` (52–77), `DENIED_TOOLS` (79–106), `DENIED_DEPLOYED_TOOLS` (149–158), `CREDENTIALS_PROBE_CONTENT` (37) и запись `credentials-probe.txt` (строка 352), `EGRESS_BAIT_CONTENT` (221) и функцию `startEgressBait` (223–252). `DEPLOYMENT_TOOLS` (108–147) остаётся как цель паритета.

- [ ] **Step 2: Переписать surface-тест (533–587).**
  Новое тело:

```ts
it("the tool surface of a telegram-launched agent is the whole deployment surface", async () => {
  const handle = captured[0];
  expect(handle, "a handle created through the runner").toBeDefined();
  const agent = handle!.agent;
  const names = tools!.schemas(agent).map((schema) => schema.name);
  const deploymentNames = tools!.schemas().map((schema) => schema.name);

  expect([...deploymentNames].sort()).toEqual([...DEPLOYMENT_TOOLS].sort());
  expect([...names].sort()).toEqual([...DEPLOYMENT_TOOLS].sort());
  for (const name of DEPLOYMENT_TOOLS) {
    expect(tools!.get(name, agent), `tools.get(${name}, agent)`).toBeDefined();
  }
});
```

- [ ] **Step 3: Переписать containment-тесты.**
  Тест 418: убрать из имени "(guard allows)".
  Тест 437 ("containment: a sibling project and $DSH_HOME are unreadable…"): заменить ожидание отказа на ожидание содержимого (`toContain(SIBLING_SECRET_CONTENT.trim())` и `toContain(FAKE_AUTH_CONTENT.trim())`), сохранив проверки переиспользования сессии; имя — "a sibling project and $DSH_HOME are readable (parity); the session is reused across runs".
  Тест 604 ("containment: shell, editor and web_fetch channels are absent…"): удалить целиком.
  Тест 697 ("containment: the kept read tools cannot traverse out of the workspace"): удалить целиком.
  Тест 665: переименовать в "an in-workspace write still reaches the disk" и заменить `WRITE_PROOF_CONTENT` (строка 38) на `"written through the parity surface"`.

- [ ] **Step 4: Убрать осиротевшие импорты.**
  Run: `pnpm --filter dsh-balbes-telegram run typecheck`
  Удалить импорты, ставшие неиспользуемыми (ожидаемо `createServer` из `node:http` и, возможно, `readFileSync`/`existsSync`).

- [ ] **Step 5: REAL-прогон**
  Run: `RUN_REAL=1 pnpm --filter dsh-balbes-telegram run test -- agentTask.real.test.ts`
  Expected: PASS (нужен `dsh` на PATH; на macOS bash может fail-closed — тесты паритета не зависят от этого).

- [ ] **Step 6: Commit**
  `git add packages/plugins/dsh-balbes-telegram/tests/agentTask.real.test.ts && git commit -m "test(telegram): assert full tool-surface parity in the REAL suite"`

---

### Task 4: Integration — убрать containment-сценарий

**Files:**
- Modify: `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts:965,1082-1105`

- [ ] **Step 1:** Удалить блок "(g) containment through the COMPOSED profile" (строки ~1082–1105).
- [ ] **Step 2:** Удалить константы `PROMPT_CONTAINMENT` и `CONTAINMENT_REPLY`, если после удаления блока они больше нигде не используются (`grep`).
- [ ] **Step 3:** В имени сценария 2 (строка 965) убрать "read containment".
- [ ] **Step 4:** Run: `pnpm --filter dsh-balbes-telegram run typecheck && pnpm --filter dsh-balbes-telegram run test -- integration.test.ts`
  Expected: PASS (REAL-гейт как в Task 3).
- [ ] **Step 5: Commit** `git add packages/plugins/dsh-balbes-telegram/tests/integration.test.ts && git commit -m "test(telegram): drop the composed-profile containment scenario"`

---

### Task 5: Комментарии seams-набора

**Files:**
- Modify: `packages/bundles/dsh-balbes-host/tests/seams.test.ts:420,440-443,509-512`

- [ ] **Step 1:** В комментариях убрать утверждения, что Telegram-канал удаляет `bash`/навешивает read-guard. Пример замены (строки 509–512):

```ts
    // This is why the Telegram channel now ships the FULL process surface
    // (composeAgentSetup installs no restriction and no read guard): the
    // engine sandbox is the boundary, and it is deliberately relied upon
    // rather than compensated for. Reads and the shell may reach any
    // host-readable path; writes stay fenced by the sandbox policy.
```

- [ ] **Step 2:** Ассерты НЕ менять. Run: `pnpm --filter dsh-balbes-host run typecheck && pnpm --filter dsh-balbes-host run test -- seams.test.ts`
  Expected: PASS (REAL-гейт).
- [ ] **Step 3: Commit** `git add packages/bundles/dsh-balbes-host/tests/seams.test.ts && git commit -m "docs(test): seams comments reflect tool-surface parity"`

---

### Task 6: Полная верификация и закрытие канона

- [ ] **Step 1:** Run: `pnpm typecheck && pnpm lint && pnpm test` — Expected: PASS.
- [ ] **Step 2:** Run: `RUN_REAL=1 pnpm test` (при `dsh` на PATH) — Expected: PASS.
- [ ] **Step 3:** Вызвать навык `canon-audit` по топику паритета; расхождений быть не должно.
- [ ] **Step 4:** Хендовер: инструкции проверки на VPS по `docs/runbooks/stage2-vps.md` (та же команда `install.sh`; smoke-задача, читающая файл вне воркспейса и дергающая `web_fetch`).
- [ ] **Step 5: Commit** оставшихся изменений (если есть).

---

## Self-Review

**Spec coverage:** снятие restrict/guard — Task 2; паритет REAL — Task 3; integration — Task 4; seams — Task 5; канон/runbook — Task 1; верификация — Task 6. Все секции спеки покрыты.

**Placeholder scan:** заглушек нет; каждый шаг содержит команду или код.

**Type consistency:** единственная изменённая сигнатура — `composeAgentSetup(agentCtx, { selection })`; согласована во всех задачах и тестах.
