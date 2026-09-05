# Этап 1: разворачиваемое ядро dsh-base на сервере — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Получить разворачиваемый на VPS одной командой профиль dsh `balbes` (ядро dsh-base + headless для smoke) с минимальным CI, проверяемый smoke-задачей.

**Architecture:** Профиль dsh — это только манифест (`package.json` c `dsh.profile.bundles`) + `cordis.patch.yml`, без node_modules в репо: базовые бандлы (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-headless`) резолвятся из mirror установки dsh (`$DSH_HOME/profiles/node_modules` — симлинки на установку). Установка одной командой: `curl | bash` скрипт, который ставит системный Node/pnpm/dsh (sudo), клонирует репо, синхронизирует профиль в `$DSH_HOME/profiles/balbes`, интерактивно принимает ключ и печатает инструкцию smoke. CI (GitHub Actions) валидирует композицию профиля без LLM.

**Tech Stack:** bash (install.sh), YAML (профиль/патч/CI), dsh CLI 0.1.2-rc.1 (`dsh --profile balbes`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-mvp-design.md` раздел 8 «Этап 1».

## Global Constraints

- dsh — зависимость, не форк: установленные `@deepseek-ai/*` не редактируются, ядро не обходится.
- `docs/canon/**` вручную не редактируется (только canon-write); этот план не трогает canon.
- Секреты не попадают в git; CI работает без ключей.
- Профиль `balbes`: bundles `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]`, `patchReload: startup`; `cordis.patch.yml` = `[]` (пустой или только-комментарный файл роняет старт).
- Базовые бандлы НЕ добавляются в `dependencies` профиля и не ставятся через pnpm (registry-версии битые, проверено спайком).
- Node ≥ 22 на VPS (dsh использует `node:sqlite`); Ubuntu (apt), sudo для установки системного Node/pnpm.
- Один коммит = одно изменение; первая строка сообщения — глагол + суть ≤ ~72 символов.

---

### Task 1: Структура монорепо + профиль `balbes`

**Files:**
- Create: `profiles/balbes/package.json`
- Create: `profiles/balbes/cordis.patch.yml`
- Create: `profiles/balbes/pnpm-workspace.yaml`
- Create: `packages/bundles/.gitkeep`
- Create: `packages/plugins/.gitkeep`

**Interfaces:**
- Consumes: ничего (первая задача).
- Produces: каталог `profiles/balbes/` — источник профиля для install.sh (Task 3) и CI (Task 4).

- [ ] **Step 1: Создать манифест профиля**

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
        "@deepseek-ai/dsh-headless"
      ],
      "patchReload": "startup"
    }
  }
}
```

- [ ] **Step 2: Создать пустой патч-слой**

`profiles/balbes/cordis.patch.yml` (ровно так — пустой список обязателен, иначе старт падает):
```yaml
[]
```

- [ ] **Step 3: Создать pnpm-workspace.yaml** (служебный, для будущих link-пакетов)

`profiles/balbes/pnpm-workspace.yaml`:
```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

- [ ] **Step 4: Создать каркас packages/**

`packages/bundles/.gitkeep` и `packages/plugins/.gitkeep` — пустые файлы (роли описаны в CONTRIBUTING.md: bundles = патч-слои, plugins = обычные Cordis-плагины).

- [ ] **Step 5: Проверить композицию профиля локально**

Профиль в репо резолвится только после синхронизации в `$DSH_HOME/profiles`. Временная проверка — скопировать в изолированный DSH_HOME:
```bash
rm -rf /tmp/dsh-stage1-home && mkdir -p /tmp/dsh-stage1-home/profiles
cp -r profiles/balbes /tmp/dsh-stage1-home/profiles/balbes
DSH_HOME=/tmp/dsh-stage1-home dsh --profile balbes --dump-config > /tmp/stage1-dump.yml
echo "exit=$?"
head -20 /tmp/stage1-dump.yml
```
Expected: `exit=0`; в выводе есть секции `# == @deepseek-ai/dsh-base` и `headless-startup`/`headless-runner` (headless поверх base).

- [ ] **Step 6: Проверить CLI-справку профиля**

```bash
DSH_HOME=/tmp/dsh-stage1-home dsh --profile balbes --help
```
Expected: usage от headless (`dsh --profile headless [options] [task...]`), exit 0.

- [ ] **Step 7: Убрать временные файлы**

```bash
rm -rf /tmp/dsh-stage1-home /tmp/stage1-dump.yml
```

- [ ] **Step 8: Коммит**

```bash
git add profiles/balbes packages/bundles/.gitkeep packages/plugins/.gitkeep
git commit -m "add balbes profile over dsh-base with headless smoke layer"
```

---

### Task 2: Runbook Этапа 1 (docs)

**Files:**
- Create: `docs/runbooks/stage1-vps.md`

**Interfaces:**
- Consumes: профиль из Task 1.
- Produces: эксплуатационный runbook (установка одной командой, smoke, обновление, устранение неполадок) — критерий готовности этапа «по runbook'у профиль разворачивается».

- [ ] **Step 1: Написать runbook**

`docs/runbooks/stage1-vps.md` со структурой: цель; требования (Ubuntu, sudo, curl); установка одной командой (curl | bash, ссылка на scripts/install.sh из Task 3); что делает установщик (по шагам); smoke-проверка (`dsh --profile balbes "..."`); обновление (повторный запуск установщика / git pull); устранение неполадок (нет node ≥22, битые registry-версии — почему не pnpm add, ключ не принят, chmod 600 credentials); где лежат данные (`$DSH_HOME`).

- [ ] **Step 2: Коммит**

```bash
git add docs/runbooks/stage1-vps.md
git commit -m "add stage 1 VPS runbook"
```

---

### Task 3: Установщик одной командой `scripts/install.sh`

**Files:**
- Create: `scripts/install.sh`
- Modify: `docs/runbooks/stage1-vps.md` (точная команда установки, если отличается от задуманной)

**Interfaces:**
- Consumes: профиль `profiles/balbes` из Task 1; репо на GitHub (`https://github.com/mdikarev/dsh-balbes-server`).
- Produces: установленный на VPS глобальный dsh, профиль в `$DSH_HOME/profiles/balbes`, ключ в `$DSH_HOME/.credentials.yaml`, инструкция smoke в stdout.

- [ ] **Step 1: Написать `scripts/install.sh`**

Ключевые свойства скрипта:
- `set -euo pipefail`; bash; идемпотентен (повторный запуск = обновление).
- **Окружение (sudo, apt, Ubuntu):** если `node --version` < 22 — установить Node 22 LTS через NodeSource (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -` + `sudo apt-get install -y nodejs`); если нет pnpm — `sudo npm i -g pnpm`; если нет git — `sudo apt-get install -y git`.
- **dsh:** если `dsh --version` отсутствует — `sudo npm i -g @deepseek-ai/dsh`.
- **Репо:** `REPO_DIR="${DSH_BALBES_REPO_DIR:-$HOME/dsh-balbes-server}"`; если нет — `git clone https://github.com/mdikarev/dsh-balbes-server "$REPO_DIR"`, иначе `git -C "$REPO_DIR" pull --ff-only`.
- **Профиль:** `DSH_HOME="${DSH_HOME:-$HOME/.dsh}"`; `mkdir -p "$DSH_HOME/profiles"`; синхронизация `cp -R "$REPO_DIR/profiles/balbes" "$DSH_HOME/profiles/balbes"` (перезапись актуальна: профиль — источник правды в репо).
- **Ключ (интерактивный ввод):** если `DEEPSEEK_API_KEY` не в env — `read -rsp "DeepSeek API key (пусто = пропустить): "`; при непустом значении — дописать в `$DSH_HOME/.credentials.yaml` секцию `refs.DEEPSEEK_API_KEY` (создать файл с `version: 1` + `refs:` + `records:` при отсутствии; chmod 600). Простейший надёжный способ — сгенерировать файл целиком, если его нет; если файл уже существует с другими записями — не перезаписывать чужие секции, а вывести инструкцию ручной правки. Допустимо: если файла нет — писать целиком; если есть — только предупредить и показать формат.
- **Верификация:** `DSH_HOME="$DSH_HOME" dsh --profile balbes --dump-config >/dev/null` (падение = ошибка установки).
- **Финал:** echo инструкции smoke: `dsh --profile balbes "Напиши 'ok' и больше ничего"`.

- [ ] **Step 2: Проверить синтаксис и базовое поведение**

```bash
bash -n scripts/install.sh && echo "syntax ok"
```
Expected: `syntax ok`.

Проверка без sudo и сети невозможна локально — полная проверка на VPS (Task 5). Локально дополнительно проверить вспомогательные функции (генерация credentials-файла), если они вынесены в отдельные функции, — запуском функции с временным `$DSH_HOME`:
```bash
DSH_HOME=/tmp/dsh-cred-test bash -c 'source scripts/install.sh 2>/dev/null; write_credentials_file "sk-test-123"'; cat /tmp/dsh-cred-test/.credentials.yaml; rm -rf /tmp/dsh-cred-test
```
(имя функции — по факту реализации; если функции нет — пропустить, проверка на VPS).

- [ ] **Step 3: Сделать исполняемым**

```bash
chmod +x scripts/install.sh
```

- [ ] **Step 4: Коммит**

```bash
git add scripts/install.sh
git commit -m "add one-command VPS installer for balbes profile"
```

---

### Task 4: Минимальный CI (GitHub Actions)

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: профиль `profiles/balbes` из Task 1.
- Produces: зелёный CI на push/PR: валидация композиции профиля без LLM.

- [ ] **Step 1: Написать workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  validate-profile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Node 22
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dsh CLI
        run: npm i -g @deepseek-ai/dsh

      - name: Sync balbes profile into DSH_HOME
        run: |
          mkdir -p "$HOME/.dsh/profiles"
          cp -R profiles/balbes "$HOME/.dsh/profiles/balbes"

      - name: Validate profile composition (no LLM)
        run: dsh --profile balbes --dump-config >/dev/null

      - name: Validate installer syntax
        run: bash -n scripts/install.sh

      - name: Validate profile manifest is JSON
        run: node -e "JSON.parse(require('fs').readFileSync('profiles/balbes/package.json','utf8'))"
```

- [ ] **Step 2: Проверить YAML-синтаксис локально**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/ci.yml','utf8');console.log('yaml bytes:',s.length)" && bash -n scripts/install.sh
```
Expected: вывод без ошибок. (Полный прогон — на GitHub после пуша.)

- [ ] **Step 3: Коммит**

```bash
git add .github/workflows/ci.yml
git commit -m "add minimal CI validating balbes profile composition"
```

---

### Task 5: Деплой на VPS и smoke (требует доступа пользователя)

**Files:** нет изменений в репо (если только runbook не потребует правок по факту).

**Interfaces:**
- Consumes: Task 3 (install.sh), Task 2 (runbook).
- Produces: подтверждение критерия готовности Этапа 1 — профиль развёрнут на VPS, smoke выполнен.

- [ ] **Step 1: Получить доступ к VPS** (пользователь даёт адрес/SSH-ключ).
- [ ] **Step 2: Запустить установку одной командой**

```bash
curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash
```
(на VPS; при вводе ключа — вставить DEEPSEEK_API_KEY).

- [ ] **Step 3: Проверить, что установлено**

```bash
dsh --version && ls "$HOME/.dsh/profiles/balbes"
```
Expected: версия dsh, три файла профиля.

- [ ] **Step 4: Smoke-задача**

```bash
dsh --profile balbes "Напиши 'ok' и больше ничего"
```
Expected: в stdout финальный ответ агента (содержит ok), exit 0.

- [ ] **Step 5: Проверить, что штатная морда не поднята**

```bash
ps aux | grep -i "dsh" | grep -v grep
```
Expected: запущенных веб-процессов dsh нет (профиль headless ничего не оставляет после себя).

- [ ] **Step 6: Зафиксировать результат** (в ответе пользователю; при необходимости — правки runbook/install.sh отдельными коммитами).

---

## Self-Review

**1. Spec coverage (раздел 8 спеки):**
- 8.3.1 монорепо-структура → Task 1 (packages/ + profiles/).
- 8.3.2 профиль на dsh-base без штатной морды → Task 1 (bundles base+headless, без dsh-web-app).
- 8.3.3 лёгкая развёртка (runbook + команда) → Tasks 2–3.
- 8.3.4 минимальный CI → Task 4 (валидация композиции, без LLM).
- 8.3.5 ручной smoke по SSH → Task 5.
- 8.5 критерии готовности: деплой по runbook (Tasks 3+5), smoke (Task 5), морда не поднята (Task 5), CI зелёный (Task 4), секреты не в репо (Global Constraints; ключ пишется в `$DSH_HOME`, не в репо).
- Выборы диалога: Ubuntu + sudo (Task 3), curl|bash (Task 3), профиль из репо (Task 3), интерактивный ключ (Task 3), headless как smoke-инструмент, не сервер (Task 1 — bundles; в проде headless заменят host-бандлом в Этапе 2).

**2. Placeholder scan:** код в шагах приведён полностью; «имя функции — по факту реализации» в Task 3 Step 2 — осознанная развилка (функция может не выделяться), с альтернативой «пропустить, проверка на VPS», не заглушка. Runbook/Task 5 опираются на фактический install.sh из Task 3.

**3. Type consistency:** профиль называется `balbes` во всех задачах; bundles одинаковы (`dsh-base`, `dsh-headless`); пути `profiles/balbes`, `scripts/install.sh`, `.github/workflows/ci.yml`, `docs/runbooks/stage1-vps.md` согласованы между задачами.
