# Паритет поверхности инструментов Telegram-агента — дизайн

- Status: approved design
- Date: 2026-09-11
- Базируется на: `docs/superpowers/specs/2026-09-10-telegram-integration-design.md`,
  `docs/superpowers/specs/2026-09-11-telegram-control-surface-design.md`

## Цель

Снять границу поверхности инструментов у агентских задач Telegram-канала:
задача должна иметь ровно те же возможности, что и Web-агент того же
процесса — те же инструменты, тот же доступ к файловой системе и сети, тот
же набор подсистем (навыки, делегирование, jobs), без per-agent
allow-фильтра и без read-containment-guard.

Владелец — единственный пользователь канала; риск indirect prompt injection
на unattended-канале принят осознанно (вариант «паритет»).

## Решения и границы

Согласовано с владельцем:

| Вопрос | Решение |
|---|---|
| Уровень доступа Telegram-агента | Полный паритет с Web-агентом |
| Агентский allow-фильтр поверхности | Удаляется |
| Read-containment guard | Удаляется |
| Процессный sandbox | Не меняется: `DSH_PERMISSION_MODE ?? workspace-write` + `ask` |
| `danger-full-access` | Не берём |

«Паритет» технически означает: в `setup` агентской сессии остаётся только
установка живого выбора модели (`installModelSelection`), а
`tools.restrict`/`tools.guard` не регистрируются вовсе. Агент видит ровно
то, что регистрирует композиция процесса, за вычетом reserved `run_code`
PTC-транспорта.

Границы:

- Изменение касается **только** Telegram-задач. Админский одноразовый
  `/api/prompt` (`runPrompt`) уже создаёт агента без ограничений и не
  меняется.
- Процессный sandbox и политика approval не меняются. Следствие: `ask` без
  интерактивного отвечающего в Telegram отказывает (fail-closed) для
  гейтованных операций; запись остаётся ограниченной sandbox-политикой,
  чтение — нет.
- Новых HTTP-ручек нет.

Не входит:

- Home-context (глобальные `AGENTS.md`/`self.md`/`skills/` дома агента) —
  отдельная SP2 и плагин `dsh-balbes-home`.
- Долговременная память и самообучение — будущая инициатива.
- Интерактивный approval-answerer в Telegram (inline-кнопки) — возможность
  на будущее, не обязательство.
- Переход процесса на `danger-full-access`.

## Архитектура

### Поверхность инструментов

`packages/plugins/dsh-balbes-telegram/src/agentTask.ts`.

`composeAgentSetup()` упрощается до установки живого выбора модели: вызовы
`restrictToolSurface(tools)` и `tools.guard(...)` удаляются. Функция
остаётся именованным швом и точкой тестирования model-selection.

Удаляемый мёртвый код:

- `KEPT_TOOL_NAMES`, `FALLBACK_DENIED_TOOL_NAMES`;
- `restrictToolSurface`, интерфейс `ToolsSurface`;
- `READ_PATH_ARG_BY_TOOL`, `GuardExecLike`, `rootEscapes`;
- неиспользуемые импорты `realpathSync` (`node:fs`) и `resolve, sep`
  (`node:path`);
- doc-комментарий «WHAT IS CONTAINED / WHAT IS NOT CONTAINED» заменяется
  короткой заметкой: поверхность — дефолт процесса, отдельный барьер не
  навешивается.

`PROGRESS_TARGET_ARG` (белый список аргумента для прогресс-карточки) не
затрагивается.

`AgentSetupOptions.root` становится неиспользуемым и удаляется; сигнатура —
`composeAgentSetup(agentCtx, { selection })`. `acquireHandle` передаёт
только `selection`.

### Результирующая поверхность

`read`, `read_image`, `write`, `edit`, `glob`, `grep`, `web_search`,
`web_fetch`, `skill`, `bash` (на не-windows; на windows `pwsh`),
`job_list`/`job_output`/`job_kill`, `subagent`, `subagent_fork`, `workflow`,
`ralph`, `send_message`, `interrupt_agent`, `list_agents`, `exit_plan_mode`,
todo/goal — то есть всё, что регистрирует композиция.

### Прогресс-карточка

Белый список `PROGRESS_TARGET_ARG` остаётся узким: для инструментов вне него
карточка показывает только имя, без аргумента. Это не ограничение
возможностей и в объём работы не входит.

## Последствия и риски

- Агент может читать любые OS-доступные файлы, включая
  `$DSH_HOME/.credentials.yaml` и `admin-auth.json`, и отправлять данные
  наружу через `bash`/`web_fetch`. Это принято решением владельца.
- `bash` на Linux-VPS работает confined-but-read-anywhere (Landlock/bwrap,
  readOnly на корень); на macOS dev-хосте может отказывать
  (`no sandbox backend is usable`) — ровно как у Web-агента.
- Запись вне writable-root контролируется sandbox-политикой и approval; при
  `ask` без отвечающего операция отказывает, а не зависает.
- Откат — revert коммита; канон, тесты и runbook правятся в том же коммите.

## Тесты

- `packages/plugins/dsh-balbes-telegram/tests/agentTask.test.ts` —
  hermetic-блок `composeAgentSetup tool surface` переписывается: проверяем,
  что `tools.restrict` и `tools.guard` не вызываются; удаляются кейсы
  fallback-deny и проверки таблицы путей. Тесты model-selection сохраняются.
- `packages/plugins/dsh-balbes-telegram/tests/agentTask.real.test.ts` —
  REAL-композиция: `KEPT_TOOLS`/`DENIED_TOOLS` и проверка «surface ровно из
  одиннадцати» заменяются проверкой паритета с `DEPLOYMENT_TOOLS`; тест
  отсутствия `bash`/`web_fetch`/`skill` заменяется тестом их присутствия и
  вызываемости через `tools.get(name, agent)`; хелпер `startEgressBait`
  удаляется вместе с egress-проверкой.
- `packages/plugins/dsh-balbes-telegram/tests/integration.test.ts` —
  сценарий containment через композицию переписывается в нейтральную
  проверку доставки ответа владельцу; фикстуры, требующие секретов в
  транскрипте, убираются.
- `packages/bundles/dsh-balbes-host/tests/seams.test.ts` — ассерты швов dsh
  не меняются (они документируют поведение движка); обновляются только
  комментарии, утверждающие, что Telegram-канал удаляет `bash`.

## Канон и документация

Правится через `canon-write` (канон-файлы вручную не редактируются):

- `docs/canon/ARCHITECTURE.md` §211–214: границы канала (allow-фильтр,
  read-guard, запрет `web_fetch`) переписываются под паритет.
- `docs/canon/OVERVIEW.md` §79–80: формулировка об ограниченной
  поверхности задачи переписывается под паритет.

Runbook:

- `docs/runbooks/stage2-vps.md` (абзац «ограниченный набор инструментов»,
  строки ~299–342): текст о недоступности
  shell/`skill`/`web_fetch` и containment-границе канала обновляется в том
  же коммите.

## Верификация (DoD)

- `pnpm typecheck`, `pnpm lint`, `pnpm test` — включая REAL-набор
  `agentTask.real.test.ts`.
- На VPS после `install.sh`: задача в Telegram, которая вызывает `bash` и
  `web_fetch` (например, чтение файла вне воркспейса), выполняется и
  возвращает результат; задача, читающая файл внутри воркспейса, работает
  как раньше.
- Негативный контроль: запись вне writable-root не проходит молча — при
  гейтованной операции приходит sandbox/approval-отказ.

## Вне scope

- SP2: home-context — конфиг `agent-instructions.dshHome` и
  `skill-filesystem.customSkillDirs` на дом агента + плагин
  `dsh-balbes-home` для `self.md`/`notes`.
- SP3: память и самообучение.
