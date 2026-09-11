# Обновление движка dsh: 0.1.2-rc.1 → 0.1.5-rc.2

- Status: executing
- Date: 2026-09-11
- Контекст: CI-job `real` не был зелёным ни разу с момента появления (10 сентября): на свежем раннере `npm i -g @deepseek-ai/dsh` без пина ставил `latest`, который уехал с 0.1.2-rc.1 на 0.1.5-rc.1. Владелец решил не пинить старую версию, а мигрировать на новую.

## Целевая версия

- CLI: `@deepseek-ai/dsh@0.1.5-rc.2` (dist-tag `next`; `latest` = 0.1.5-rc.1).
- Локально уже установлен CLI 0.1.5-rc.1, и его зависимость-замыкание (вся логика: `dsh-base`, `dsh-session`, `dsh-system-prompt`, `dsh-tools`, …) — **0.1.5-rc.2**. Пинить будем `0.1.5-rc.2`; финальное подтверждение даст CI на чистом раннере.

## Что уже проверено (дискавери, факты)

- Сборка и типы: `pnpm -r run build` и `pnpm -r run typecheck` — exit 0, ноль ошибок TS.
- Юнит-наборы: contracts 5, models 49, workspaces 50, sessions 18, telegram 374, admin 127, host 30 — **653 passed / 0 failed / 37 skipped**.
- REAL: sessions 3/3 ✓; host 13/14; telegram 12/14.
- Локальное зеркало `~/.dsh/profiles/node_modules/@deepseek-ai/*` отслеживает глобальную установку (0.1.5-rc.2), репозиторий резолвит её.

## Поломки и их причины

### P1. Персона в системном промпте больше не применяется (host bundle patch)

`packages/bundles/dsh-balbes-host/cordis.patch.yml` переопределяет строку base-профиля по id:
```yaml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
```
В 0.1.5 у строки `system-prompt` (`@deepseek-ai/dsh-system-prompt`) config другой: `includeHarnessIdentity?`, `includeRuntimeContext?`, **`personaPrefix?`**, `personaSuffix?`, `toolOrder?` (см. `lib/types/index.d.ts:163-184`). Ключ `persona` не читается → деплой молча получает дефолтный промпт движка. Подстановка `{{variable}}` в 0.1.5 **строгая**: неизвестная/пустая ссылка бросает ошибку при сборке промпта.
Наблюдение: telegram REAL `tests/integration.test.ts:899` — ожидалось «Your working directory is» / корень воркспейса, получен дефолтный промпт.

### P2. Логи сессий стали поколенческими (host seams test)

`@deepseek-ai/dsh-session-persistence-jsonl` 0.1.5: `generationLogFilename(version, compression)` — «version zero retains the original suffix-only name; every later generation carries a lowercase numeric `vN` component»; есть `generationLogPath`/`logPath`. Тест `packages/bundles/dsh-balbes-host/tests/seams.test.ts:775-777` ищет файл по `/session\.jsonl(\.zstd)?$/` → не находит (`expected undefined to be defined`). Это ровно падение CI run 30/31.

### P3. Движок больше не регистрирует `str_replace_editor`

`packages/plugins/dsh-balbes-telegram/tests/agentTask.real.test.ts:492-495` ожидает в наборе деплоя `["bash","read","write","edit","str_replace_editor",…]`; в 0.1.5 пакет `dsh-tool-str-replace-editor` существует, но в наборе не появляется (23 других инструмента есть). Нужно привести ожидания к фактическому реестру 0.1.5 и заново подтвердить security-инвариант ограниченной поверхности (плагин telegram ограничивает набор инструментов workspace-задач).

### Не поломки (проверено)

- `tools.mode`: в 0.1.5 это режим презентации `native|ptc|both` (`dsh-tools/lib/types/index.d.ts:450-470`), ровно как описано в нашем `README.md:123` → наш override `mode: !!js process.env.DSH_TOOLS_MODE` остаётся корректным.

## Задачи

- **A. Композиция + host seams test.** Перевести персону на новый ключ (проверив, что `{{model}}`/`{{cwd}}` валидны в строгом интерполяторе 0.1.5, иначе — на поддерживаемые переменные и объяснить в отчёте); решить и обосновать, оставляем ли `includeHarnessIdentity` по умолчанию. Обновить в `seams.test.ts` обнаружение файла лога под поколенческую раскладку, сохранив смысл проверки (flush персистит, dispose файл не удаляет, resume видит историю) и обновив комментарии-факты. Проверка: host REAL (seams+integration) зелёный; telegram scenario 1 (персона) — в задаче B.
- **B. Набор инструментов в telegram.** Обновить ожидания `agentTask.real.test.ts` под реестр 0.1.5 и заново подтвердить, что ограничение поверхности для workspace-задач не ослаблено (перечень запрещённых/разрешённых инструментов сверить с фактическим реестром). Проверка: telegram REAL (agentTask.real + integration) зелёный, включая сценарий 1.
- **C. Версия: пины и ссылки.** Пин `@deepseek-ai/dsh@0.1.5-rc.2` в `.github/workflows/ci.yml` (оба job'а), `scripts/install.sh` (не трогая логику «уже установлен — не переустанавливаем»), `docs/runbooks/stage1-vps.md`, `docs/runbooks/stage2-vps.md`; через `canon-write` обновить версии в каноне (`ARCHITECTURE.md:251`, `OVERVIEW.md:134` и всё, где версия названа); обновить пометки «dsh 0.1.2-rc.1 seam fact» в коде/тестах на версию, против которой факты фактически проверены (0.1.5-rc.2), не меняя самих утверждений там, где тесты остаются зелёными.
- **D. Финальная проверка и CI.** Полный гейт + все REAL локально; пуш (с согласия владельца); CI зелёный на `validate` и `real`.

## Риски

- Пин CLI не фиксирует замыкание зависимостей (`^0.1.5-rc.2` может подтянуть rc.3) — та же болезнь, что привела к этому инциденту; в отчёте зафиксировать, при желании позже закрыть npm-overrides.
- Пометки seam-фактов в тестах ценны как «проверено против версии X»: менять их можно только там, где соответствующий тест реально прогнан на новой версии.
