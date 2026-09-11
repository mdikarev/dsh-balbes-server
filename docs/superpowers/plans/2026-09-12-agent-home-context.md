# Agent Home Global Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать дом агента `$DSH_HOME/agent/` источником глобального контекста (правила, `self.md`, скиллы) для всех сессий и завести у проектов собственные скиллы `<project>/.dsh/skills`.

**Architecture:** Глобальные правила и скиллы дома подключаются конфигом нативных швов dsh (`agent-instructions.dshHome`, `skill-filesystem.customSkillDirs`) в host-бандле; `self.md` инжектится новым плагином `dsh-balbes-home` секцией системного промпта. Провижн воркспейсов создаёт `.dsh/skills` у проектов и переименовывает стартовый README так, чтобы провайдер скиллов его не парсил.

**Tech Stack:** TypeScript (strict, ESM), Node ≥ 22, Cordis-плагины dsh 0.1.5-rc.2, vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-12-agent-home-context-design.md`

## Global Constraints

- dsh — зависимость, не форк: установленные `@deepseek-ai/*` не редактируются.
- `docs/canon/**` руками не правится: Task 1 выполняется через `canon-write`; после него нужен явный go-ahead владельца до кода.
- Плагины функциональные: named-export `name`/`inject`/`Config`/`apply`, без default-export; сервисы читаются `ctx.get`, регистрации — эффекты.
- Относительные импорты внутри пакета — с `.js`-расширением.
- Проверки после каждого кода-task: `pnpm --filter <пакет> run typecheck` и `pnpm --filter <пакет> run test`.
- **Безопасность:** repo-wide `RUN_REAL=1 pnpm test` на слабой dev-машине НЕ запускать (см. addendum плана SP1). Локально — bounded (`--workspace-concurrency=1`), полный REAL — на Linux VPS.
- Коммит после каждого task в стиле репозитория (`feat(home): …`, `feat(workspaces): …`, `docs(canon): …`).

---

## File Structure

**Создаются:**
- `packages/plugins/dsh-balbes-home/package.json`, `tsconfig.json`, `tsconfig.build.json`
- `packages/plugins/dsh-balbes-home/src/index.ts` — секция `balbes:self` из `self.md`.
- `packages/plugins/dsh-balbes-home/tests/index.test.ts` — юнит.
- `packages/plugins/dsh-balbes-home/tests/integration.test.ts` + `tests/fixtures/balbes-home-profile/{cordis.patch.yml,package.json}` — REAL-композиция.

**Изменяются:**
- `packages/plugins/dsh-balbes-workspaces/src/workspaces.ts` — `.dsh/skills`, README без `.md`, миграция.
- `packages/plugins/dsh-balbes-workspaces/tests/workspaces.test.ts` — тесты провижна.
- `packages/bundles/dsh-balbes-host/cordis.patch.yml` — override `agent-instructions` и `skill-filesystem`.
- `profiles/balbes/cordis.patch.yml` — insert `balbes-home`.
- `scripts/install.sh` — `copy_home_into_profile` + вызов.
- `docs/canon/{ARCHITECTURE,OVERVIEW,GLOSSARY}.md` (через `canon-write`), `docs/canon/future_plans/p0-agent-workspaces.md` (через `canon-future-plan`), `docs/runbooks/stage2-vps.md`.

---

### Task 1: Канон и runbook (canon-first)

**Files:**
- Modify via canon-write: `docs/canon/ARCHITECTURE.md`, `docs/canon/OVERVIEW.md`, `docs/canon/GLOSSARY.md`
- Status via canon-future-plan: `docs/canon/future_plans/p0-agent-workspaces.md`
- Modify: `docs/runbooks/stage2-vps.md`

- [ ] **Step 1: Вызвать `canon-write`** для топика "agent home global context". Scout, expand, deep-read. Описать: дом `$DSH_HOME/agent/` — глобальный слой (правила `AGENTS.md`, `self.md` секцией системного промпта, `skills/`); у проекта — `<project>/.dsh/skills` (нативный project-корень); порядок слоёв global -> project.
- [ ] **Step 2: Валидировать** `doc-canon validate --json` (exit 0, ноль error), затем `doc-canon index`.
- [ ] **Step 3: `canon-future-plan`** — пометить пункт «Наполнение дома … глобальные правила и скиллы» absorbed и синхронизировать `future_plans/INDEX.md`.
- [ ] **Step 4: Runbook** — раздел про файлы дома: `agent/AGENTS.md`, `agent/self.md`, `agent/skills/`, `<project>/.dsh/skills`; как это видно из Telegram; правки подхватываются без переустановки.
- [ ] **Step 5: Commit** `git add docs/canon docs/runbooks/stage2-vps.md && git commit -m "docs(canon): agent home global context"`
- [ ] **Step 6: CHECKPOINT — остановиться за go-ahead владельца перед кодом.**

---

### Task 2: Провижн воркспейсов — per-workspace скиллы

**Files:**
- Modify: `packages/plugins/dsh-balbes-workspaces/src/workspaces.ts`
- Test: `packages/plugins/dsh-balbes-workspaces/tests/workspaces.test.ts`

- [ ] **Step 1: Тесты (ожидаемо падают).** Добавить в `workspaces.test.ts`:
  - `ensureHome` создаёт `agent/skills/README` (без `.md`);
  - если `agent/skills/README.md` равен старому стартеру — он удалён; изменённый владельцем — сохранён;
  - `createProject` создаёт `<project>/.dsh/skills/README`.
- [ ] **Step 2: Убедиться, что падают**
  Run: `pnpm --filter dsh-balbes-workspaces run test -- tests/workspaces.test.ts`
  Expected: FAIL.
- [ ] **Step 3: Реализация.** В `workspaces.ts`:
  - Обновить `SKILLS_README_STARTER` (формат скилла `<name>/SKILL.md` или плоский `<name>.md` с frontmatter `name`/`description`; домашние скиллы глобальны, проектные локальны).
  - Добавить `const OLD_SKILLS_README_STARTER = ["# skills/", "", "Directory for agent skills (later stages). Format and wiring to be defined."].join("\n");`.
  - `ensureHome`: заменить `provisionFile(join(skillsDir, "README.md"), SKILLS_README_STARTER)` на `provisionFile(join(skillsDir, "README"), SKILLS_README_STARTER)`; затем вызвать `removeLegacySkillsReadme(skillsDir)`.
  - Добавить функцию:

```ts
async function removeLegacySkillsReadme(skillsDir: string): Promise<void> {
  const legacy = join(skillsDir, "README.md");
  try {
    if ((await readFile(legacy, "utf8")) !== OLD_SKILLS_README_STARTER) return;
    await unlink(legacy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
```

  - В `createProject` после успешного `mkdir(target, { recursive: false })` (и до `const createdAt = ...`) добавить:

```ts
  const skillsDir = join(target, ".dsh", "skills");
  await mkdir(skillsDir, { recursive: true });
  await provisionFile(join(skillsDir, "README"), SKILLS_README_STARTER);
```

- [ ] **Step 4: Проверить, что проходит**
  Run: `pnpm --filter dsh-balbes-workspaces run typecheck && pnpm --filter dsh-balbes-workspaces run test`
  Expected: PASS.
- [ ] **Step 5: Commit** `feat(workspaces): per-project skills dir and warning-free starter README`

---

### Task 3: Плагин `dsh-balbes-home` + юнит-тесты

**Files:**
- Create: `packages/plugins/dsh-balbes-home/package.json`, `tsconfig.json`, `tsconfig.build.json`
- Create: `packages/plugins/dsh-balbes-home/src/index.ts`
- Test: `packages/plugins/dsh-balbes-home/tests/index.test.ts`

**Interfaces:**
- Produces: функциональный плагин `name = "balbes-home"`, `inject = ["systemPrompt"]`, `Config = z.object({ dshHome: z.string().optional() })`; регистрирует секцию `balbes:self` порядка `100`.

- [ ] **Step 1: Scaffold.** Скопировать `package.json`/`tsconfig.json`/`tsconfig.build.json` у `packages/plugins/dsh-balbes-sessions` в `packages/plugins/dsh-balbes-home`, заменив имя пакета на `dsh-balbes-home`.
- [ ] **Step 2: Юнит-тест (ожидаемо падает).** `tests/index.test.ts`: фейковый ctx с `systemPrompt.section`, рекордер; проверки:
  - секция зарегистрирована с `name === "balbes:self"` и `order === 100`;
  - `text()` возвращает содержимое `<dshHome>/agent/self.md`;
  - отсутствие файла -> `""`;
  - `{{` в файле экранируется (`{{` -> `{ {`);
  - без сервиса `systemPrompt` -> `warn` и ничего не регистрируется.
- [ ] **Step 3: Убедиться, что падает** (нет `src/index.ts`). Run: `pnpm --filter dsh-balbes-home run test`.
- [ ] **Step 4: Реализация `src/index.ts`:**

```ts
import z from "@deepseek-ai/schemastery";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const name = "balbes-home";
export const inject = ["systemPrompt"];
export const Config = z.object({ dshHome: z.string().optional() });

const SECTION_NAME = "balbes:self";
const SECTION_ORDER = 100;
const SECTION_LABEL = "## Agent self-description (from the agent home)";

interface SystemPromptSeatLike {
  section(section: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void;
}
interface CtxLike { get(key: string): unknown; logger: { warn(m: string): void } }

/** Escape strict {{variable}} interpolation so owner text can never throw assembly. */
function escapeInterpolation(text: string): string {
  return text.replace(/\{\{/g, "{ {");
}

export function apply(ctx: CtxLike, config: { dshHome?: string }): void {
  const systemPrompt = ctx.get("systemPrompt") as SystemPromptSeatLike | undefined;
  if (systemPrompt === undefined) {
    ctx.logger.warn("balbes-home: systemPrompt service missing; self.md not injected");
    return;
  }
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const selfPath = join(dshHome, "agent", "self.md");
  let cachedMtime = -1;
  let cachedText = "";
  const renderSelf = (): string => {
    try {
      const info = statSync(selfPath);
      if (info.mtimeMs !== cachedMtime) {
        cachedMtime = info.mtimeMs;
        cachedText = readFileSync(selfPath, "utf8").trim();
      }
    } catch {
      cachedMtime = -1;
      cachedText = "";
    }
    if (cachedText === "") return "";
    return `${SECTION_LABEL}\n\n${escapeInterpolation(cachedText)}`;
  };
  systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: renderSelf });
}
```

- [ ] **Step 5: Проверить** `pnpm --filter dsh-balbes-home run typecheck && pnpm --filter dsh-balbes-home run test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(home): inject agent home self.md as a system prompt section`

---

### Task 4: REAL-композиция плагина

**Files:**
- Create: `packages/plugins/dsh-balbes-home/tests/fixtures/balbes-home-profile/cordis.patch.yml`
- Create: `packages/plugins/dsh-balbes-home/tests/fixtures/balbes-home-profile/package.json`
- Create: `packages/plugins/dsh-balbes-home/tests/integration.test.ts`

- [ ] **Step 1: Fixture.** `package.json`:

```json
{
  "name": "dsh-profile-balbes-home-test",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-balbes-host"], "patchReload": "startup" } }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: balbes-home
      name: 'dsh-balbes-home'
```

- [ ] **Step 2: REAL-тест.** Взять паттерн `packages/plugins/dsh-balbes-sessions/tests/integration.test.ts` (boot настоящего профиля через CLI, gated `RUN_REAL=1` и `dsh` в PATH, LLM-граница — `tests/helpers/stub-llm.mjs`). Суть проверки:
  1. создать `$DSH_HOME/agent/self.md` с уникальной строкой;
  2. вызвать `/api/prompt` (или создать сессию) так, чтобы стаб-LLM захватил тело запроса;
  3. `expect(JSON.stringify(captured.messages)).toContain(<уникальная строка>)`;
  4. удалить `self.md`, повторить — уникальной строки в следующем запросе нет.
  Для stub-LLM и boot-хелперов переиспользовать `tests/helpers/stub-llm.mjs`, скопировав его из `dsh-balbes-sessions`.
- [ ] **Step 3: Прогон** `RUN_REAL=1 pnpm --filter dsh-balbes-home run test` (на VPS; локально допустимо `SKIP`, но typecheck обязателен).
- [ ] **Step 4: Commit** `test(home): REAL composition proves self.md reaches the system prompt`

---

### Task 5: Проводка композиции и установки

**Files:**
- Modify: `packages/bundles/dsh-balbes-host/cordis.patch.yml`
- Modify: `profiles/balbes/cordis.patch.yml`
- Modify: `scripts/install.sh`

- [ ] **Step 1: Host-патч — два override.** После строки `- id: tools` блока добавить (whole-config replacement, поэтому `maxBytes` повторяется):

```yaml
- id: agent-instructions
  config:
    maxBytes: 65536
    dshHome: !!js (process.env.DSH_HOME ?? (process.env.HOME + "/.dsh")) + "/agent"

- id: skill-filesystem
  config:
    customSkillDirs: !!js [(process.env.DSH_HOME ?? (process.env.HOME + "/.dsh")) + "/agent/skills"]
```

- [ ] **Step 2: Profile-патч.** В `profiles/balbes/cordis.patch.yml` добавить в `insert`:

```yaml
    - id: balbes-home
      name: 'dsh-balbes-home'
```

- [ ] **Step 3: install.sh.** Добавить `copy_home_into_profile` по образцу `copy_sessions_into_profile` (src `packages/plugins/dsh-balbes-home`, dst `$DSH_HOME/profiles/$PROFILE_NAME/node_modules/dsh-balbes-home`, проверка `lib`, удаление `tsconfig*`, `src`, `tests`, `lib/types`) и вызвать её в списке копирования (рядом с `copy_sessions_into_profile`, ~строка 785).
- [ ] **Step 4: Проверка.** `bash -n scripts/install.sh`; `pnpm --filter dsh-balbes-host run typecheck`; при возможности `dsh --profile balbes --dump-config` и глазами убедиться, что строки `agent-instructions`/`skill-filesystem` имеют новые значения, а `balbes-home` присутствует.
- [ ] **Step 5: Commit** `feat(home): wire global home context into the balbes profile`

---

### Task 6: Полная верификация и канон-аудит

- [ ] **Step 1:** `COREPACK_HOME=/tmp/corepack-dsh pnpm typecheck` — Expected: exit 0.
- [ ] **Step 2:** `COREPACK_HOME=/tmp/corepack-dsh pnpm -r --workspace-concurrency=1 --if-present run test` — Expected: exit 0 (REAL/интеграционные пропущены гейтом).
- [ ] **Step 3:** На VPS: `RUN_REAL=1 pnpm test` (полный набор) и серверный smoke из Task 1 runbook.
- [ ] **Step 4:** `canon-audit` по топику; расхождений быть не должно.
- [ ] **Step 5:** Commit оставшихся изменений (если есть).

---

## Self-Review

**Spec coverage:** плагин `dsh-balbes-home` — Task 3; его REAL-тест — Task 4; конфиг нативных швов — Task 5; провижн `.dsh/skills` и README — Task 2; канон/runbook — Task 1; верификация — Task 6. Все секции спеки покрыты.

**Placeholder scan:** заглушек нет; каждый шаг — команда или код.

**Type consistency:** секция `balbes:self`/order `100`/Config `{ dshHome? }` согласованы между Task 3 и Task 4; имена функций провижна — внутри Task 2.
