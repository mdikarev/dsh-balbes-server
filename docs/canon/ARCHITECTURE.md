# Architecture

## Summary

Один процесс dsh (модель B1): ядро и будущие плагины-каналы живут в одном
Cordis-процессе; оркестрации нескольких процессов нет. Всё своё реализуется
механизмами dsh — профилем (`dsh.profile.bundles`), слоем патчей
(`cordis.patch.yml`) и собственными бандлами/плагинами; установленные
`@deepseek-ai/*` не редактируются и ядро не обходится. Текущее состояние —
Этап 1: профиль `balbes` (dsh-base + dsh-headless) разворачивается на VPS
одной командой; штатная веб-морда dsh не используется.

## System context

Внешние акторы и системы:

- VPS с Ubuntu (целевая — свежая LTS): хост, на котором живёт профиль `balbes`
  и данные dsh в `$DSH_HOME` (по умолчанию `~/.dsh`).
- npm registry: источник глобального пакета `@deepseek-ai/dsh` и системных
  инструментов (Node через NodeSource, pnpm).
- GitHub (`mdikarev/dsh-balbes-server`, ветка `main`): источник профиля и
  скриптов; `raw.githubusercontent.com` отдаёт install.sh для `curl | bash`;
  GitHub Actions — минимальный CI.
- API DeepSeek: модель для smoke-задачи; ключ приходит из
  `$DSH_HOME/.credentials.yaml` (env `DEEPSEEK_API_KEY`).
- dsh как установленный движок: его mirror (`$DSH_HOME/profiles/node_modules`)
  резолвит базовые бандлы профиля.

## Building blocks

- `profiles/balbes/` — профиль-манифест: `package.json` с
  `dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]`
  и `patchReload: startup`; `cordis.patch.yml` = `[]` (пустой список обязателен,
  иначе старт падает); `pnpm-workspace.yaml` — служебный каркас для будущих
  link-пакетов. В репозитории профиль живёт без `node_modules`.
- `@deepseek-ai/dsh-base` — бандл ядра: полный стандартный агентский набор
  (агентский цикл, тулы bash/fs/web/workflow/subagent/skill, скиллы, сессии,
  credentials, политики).
- `@deepseek-ai/dsh-headless` — временный app-слой: one-shot запуск одной
  задачи из CLI (задача → stdout → exit). Инструмент smoke-проверки, не сервер
  и не демон; в будущем заменяется собственным host-бандлом.
- `scripts/install.sh` — одно-командный установщик (`curl | bash`):
  `set -euo pipefail`, идемпотентен; ставит Node ≥ 22 (NodeSource) / pnpm / git /
  глобальный dsh, клонирует/обновляет репозиторий, синхронизирует профиль в
  `$DSH_HOME/profiles/balbes` (замена каталога целиком), принимает ключ DeepSeek
  интерактивно с `/dev/tty` (или из env) в `$DSH_HOME/.credentials.yaml`
  (chmod 600), проверяет композицию `--dump-config`, печатает команду smoke.
- `.github/workflows/ci.yml` — минимальный CI без LLM: Node 22, глобальный dsh,
  синхронизация профиля, `--dump-config`, `bash -n scripts/install.sh`,
  JSON-валидация манифеста профиля.
- `docs/runbooks/stage1-vps.md` — эксплуатационный runbook (установка, smoke,
  обновление, устранение неполадок, где лежат данные).

## Key flows

- Установка одной командой: `curl -fsSL <raw install.sh> | bash` → окружение →
  глобальный dsh → клон репо → синхронизация профиля → ключ (env или /dev/tty)
  → `dsh --profile balbes --dump-config` → инструкция smoke. Повторный запуск =
  обновление (git pull + пересинхронизация).
- Smoke: `dsh --profile balbes "<задача>"` → headless создаёт агента через ядро
  dsh-base, выполняет задачу с тулами, пишет финальный ответ в stdout, exit
  0/1. Штатная веб-морда не поднимается; процесс ничего не слушает.
- CI: на push/PR валидирует композицию профиля (без ключей и LLM).

## Boundaries & non-responsibilities

- dsh — зависимость, не форк: установленные `@deepseek-ai/*` не редактируются;
  надстройка общается с ядром только через штатные швы.
- Базовые бандлы профиля не кладутся в `dependencies` и не ставятся через pnpm:
  npm registry публикует сломанные устаревшие версии `@deepseek-ai/dsh-*`
  (например `dsh-headless@0.0.1-rc.1` с несуществующей зависимостью); бандлы
  резолвятся из mirror установленного dsh.
- Не входит: админка и свой host/HTTP-API, sdk-профиль как фундамент, каналы
  (telegram/A2A), память (Qdrant), самообучение, мультиюзерность, замена
  драйвера цикла, граф-конфиг.
- Секреты не попадают в git; CI работает без ключей.

## Tech & constraints

- Технологии: dsh 0.1.2-rc.1 (глобально), bash (установщик), YAML (профиль/
  патч/CI), GitHub Actions. Будущая надстройка — TypeScript; без Python.
- Node ≥ 22 (dsh использует `node:sqlite`); Ubuntu + apt; sudo для системного
  Node и глобального dsh.
- Профиль в репо — источник правды; синхронизация в `$DSH_HOME/profiles/balbes`
  выполняется заменой каталога целиком (иначе повторный `cp -R` вложил бы
  `balbes/balbes`).
- Установщик читает ключ с `/dev/tty` (работает внутри `curl | bash`), пустой
  ввод = пропуск; env `DEEPSEEK_API_KEY` отменяет запрос.
- Ключи в `$DSH_HOME/.credentials.yaml` — формат `version: 1` + `refs` +
  `records`, права `600`; чужие секции при записи не перезаписываются.

## Related canon

- OVERVIEW.md — цель, scope, сигналы успеха.
- GLOSSARY.md — термины (профиль, бандл, патч, host, headless и др.).
- CANON_CONTRACT.md — структура canon и шаблоны секций.
