# Обновление движка dsh: 0.1.5-rc.2 → 0.1.7-rc.1

- Status: executing
- Date: 2026-09-23
- Инициатива: docs/canon/future_plans/p8-engine-upgrade.md
- Контекст: пин `scripts/engine-version.txt` стоял на `0.1.5-rc.2`, тогда как
  глобально установленный движок и его зеркало уже были `0.1.5-rc.3` (дрейф
  пин↔факт). Новейшая опубликованная версия `@deepseek-ai/dsh` — `0.1.7-rc.1`
  (dist-tag `next`; `latest` = `0.1.5-rc.3`, `alpha` = `0.1.7-alpha.2`).
  Владелец выбрал целевую — новейшую.

## Целевая версия

- CLI: `@deepseek-ai/dsh@0.1.7-rc.1` (канал `next`).
- Замыкание: пакеты `@deepseek-ai/dsh-*` в манифесте 0.1.7-rc.1 запинены точной
  версией `0.1.7-rc.1` (не `^`), поэтому «пин CLI не фиксирует замыкание» —
  риск прошлого апгрейда — здесь не воспроизводится.

## Проверки без локального запуска (машина владельца слабая)

Тяжёлые сборки/тесты локально не запускаются. Ниже — статическая сверка по типам
и патч-слоям 0.1.7-rc.1 (только чтение tarball'ов), плюс опора на CI.

- `system-prompt`: строка в `dsh-base/cordis.patch.yml` 0.1.7 использует
  `personaPrefix` — наш override в
  `packages/bundles/dsh-balbes-host/cordis.patch.yml` совместим.
- `agent-default-model`: в 0.1.7 всё ещё `model: deepseek-flash` — поведение
  дефолтной модели не изменилось (canon/runbook переклеены по версии).
- `session-persistence-jsonl`: поколенческая раскладка
  (`session.v<N>.jsonl.zstd`) сохраняется; тест `seams.test.ts` уже её покрывает.
- Набор инструментов: `dsh-tool-str-replace-editor` в базовой композиции
  отсутствует и в 0.1.7; ожидания `agentTask.real.test.ts` уже это учитывают.

## Изменения

- `scripts/engine-version.txt` — единственный пин, `0.1.7-rc.1`. CI
  (`.github/workflows/ci.yml`) и `scripts/install.sh` читают его оттуда.
- `docs/canon/API_CONTRACTS.md`, `docs/canon/ADMIN_UI.md` — version-метка
  дефолтной модели (через `canon-write`).
- `docs/runbooks/stage2-vps.md` — version-метка в smoke моделей.
- `docs/canon/future_plans/p8-engine-upgrade.md` + `INDEX.md` — статус
  `implementing`.

## Проверка на сервере (владелец)

1. Дождаться зелёного CI на `main` (job `validate` и job `real` —
   последний ставит запиненный движок и гоняет REAL-наборы).
2. `cd ~/dsh-balbes-server && git pull --ff-only`.
3. `sudo npm i -g "@deepseek-ai/dsh@$(cat scripts/engine-version.txt)"`.
4. `dsh --version` — должно совпасть с пином.
5. `bash scripts/install.sh` — рассинхрона версии в stderr быть не должно.
6. Smoke: `POST /api/health`, `POST /api/models/list` (ожидается
   `"model":"deepseek-flash"`), вход в админку, тестовый промпт, Telegram.

## Риски

- `0.1.7-rc.1` — pre-release канала `next`; прыжок идёт через 0.1.6. При красном
  CI или регрессии на сервере — откат.

## Откат

- Вернуть `scripts/engine-version.txt` на `0.1.5-rc.3` (фактически стоявшую) и
  выполнить `sudo npm i -g "@deepseek-ai/dsh@0.1.5-rc.3"`, затем `install.sh`.
