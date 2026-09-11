# Глобальный контекст дома агента — дизайн

- Status: approved design
- Date: 2026-09-12
- Базируется на: `docs/superpowers/specs/2026-09-11-telegram-tool-surface-parity-design.md`,
  `docs/canon/future_plans/p0-agent-workspaces.md` (наполнение дома),
  `docs/superpowers/specs/2026-09-10-telegram-integration-design.md`

## Цель

Сделать дом агента `$DSH_HOME/agent/` источником глобального контекста по
умолчанию: его правила (`AGENTS.md`), самоописание (`self.md`) и скиллы
(`skills/`) действуют во всех воркспейсах; у проектов появляются собственные
скиллы. Владелец редактирует файлы дома напрямую, изменения подхватываются без
переустановки.

## Решения и границы

Согласовано с владельцем:

| Вопрос | Решение |
|---|---|
| Где глобальные правила | `agent/AGENTS.md` через `agent-instructions.dshHome` |
| Где глобальные скиллы | `agent/skills` через `skill-filesystem.customSkillDirs` |
| Как подключён `self.md` | Секция системного промпта, плагин `dsh-balbes-home` |
| Per-workspace скиллы | `<project>/.dsh/skills` (нативный project-корень) |
| Домашний `agent/.dsh/skills` | Не заводим: дом покрыт глобальным `agent/skills` |
| `notes/` и память | Не в этой спеке |

Границы:

- «Глобально по умолчанию» = уровень процесса: глобальный контекст дома видят
  все агенты процесса (Telegram-задачи и админский тестовый промпт).
- Память и самообучение — отдельная будущая инициатива; `dsh-balbes-home`
  проектируется как её будущий дом, но сама память здесь не реализуется.
- Проектные правила (`<project>/AGENTS.md`) уже работают штатной цепочкой
  инструкций; ничего не меняем, только документируем.
- Новых HTTP-ручек нет.

## Архитектура

### Плагин `packages/plugins/dsh-balbes-home`

Функциональный Cordis-плагин по штатному шаблону репозитория (`name`/`inject`/
`Config`/`apply`, без default-export):

- `name = "balbes-home"`
- `inject = ["systemPrompt"]`
- `Config = z.object({ dshHome: z.string().optional() })`

`apply(ctx, config)` делает ровно одно:

1. Разрешает дом: `dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh")`;
   файл самоописания — `join(dshHome, "agent", "self.md")`.
2. Берёт `ctx.systemPrompt`; если сервиса нет — `ctx.logger.warn` и выход (как
   `balbes-workspaces` при отсутствии `balbesHttp`).
3. Регистрирует секцию `ctx.systemPrompt.section({...})`:
   - `name: "balbes:self"`
   - `order: 100` — после deployment-persona (`0`), до plan-policy (`500`)
   - `text: () => renderSelf()`, синхронный провайдер (контракт `PromptSection.text`)

`renderSelf()`:

- читает `self.md` с кэшем по `mtimeMs` (`statSync` + `readFileSync`; файл
  мелкий, читается заново только при изменении);
- любое отсутствие/ошибка чтения → пустая строка (секция ничего не добавляет);
- экранирует `{{` → `{ {`: `renderPrompt` интерполирует строгие `{{variable}}`
  и бросает на неизвестном имени, а `self.md` пишет владелец и может содержать
  любые символы;
- оборачивает содержимое коротким заголовком `## Agent self-description (from the agent home)`.

Плагин не читает `AGENTS.md` и не управляет скиллами — этим занимаются нативные
швы ниже.

### Конфиг нативных швов (`packages/bundles/dsh-balbes-host/cordis.patch.yml`)

Добавляются два override базовых строк (whole-config replacement, поэтому
`maxBytes` у инструкций повторяется):

```yaml
- id: agent-instructions
  config:
    maxBytes: 65536
    dshHome: !!js (process.env.DSH_HOME ?? (process.env.HOME + "/.dsh")) + "/agent"

- id: skill-filesystem
  config:
    customSkillDirs: !!js [(process.env.DSH_HOME ?? (process.env.HOME + "/.dsh")) + "/agent/skills"]
```

`agent-instructions` читает ровно один user-global файл `<dshHome>/AGENTS.md`;
дедуп по absolutePath (проверено в исходнике) исключает двойной рендер, когда
домашняя сессия дополнительно видит тот же файл в проектной цепочке.

### Провижн воркспейсов (`packages/plugins/dsh-balbes-workspaces`)

- `ensureHome`: вместо `agent/skills/README.md` создаётся `agent/skills/README`
  (без `.md`) — провайдер скиллов не пытается распарсить его как скилл без
  frontmatter и не пишет warning на каждом скане.
- Одноразовая миграция: если `agent/skills/README.md` существует и его
  содержимое точно равно старому `SKILLS_README_STARTER`, файл удаляется;
  изменённый владельцем файл не трогается.
- `createProject`: после создания каталога проекта идемпотентно создаётся
  `<project>/.dsh/skills/README` (тот же стартер).
- `SKILLS_README_STARTER` переписывается: формат скилла (каталог `<name>/SKILL.md`
  или плоский `<name>.md` с frontmatter `name`/`description`), что домашние
  скиллы глобальны, а проектные локальны.

### Композиция и установка

- `profiles/balbes/cordis.patch.yml`: insert строки `balbes-home` (без config —
  плагин сам разрешает `DSH_HOME`, как `balbes-workspaces`).
- `scripts/install.sh`: новая функция `copy_home_into_profile` по образцу
  `copy_sessions_into_profile` (копирует `packages/plugins/dsh-balbes-home` в
  `$DSH_HOME/profiles/balbes/node_modules/dsh-balbes-home`; `lib` — да,
  `src`/`tests`/`tsconfig` — нет).
- Сборка нового пакета — автоматически: `pnpm-workspace.yaml` уже включает
  `packages/plugins/*`.

## Слои и порядок

- **Инструкции:** `agent/AGENTS.md` (user-global) рендерится первым, затем
  проектная цепочка от корня проекта к `cwd`; более конкретный файл главнее.
- **Самоописание:** секция `balbes:self` в системном промпте на порядке `100`.
- **Скиллы:** ранги провайдера — project-dsh `<project>/.dsh/skills` (100),
  custom `agent/skills` (300), user-dsh `$DSH_HOME/skills` (400). Проектный
  скилл с тем же именем затеняет домашний.

## Деградация и ошибки

- `self.md` отсутствует, пуст или нечитаем → секция пустая, падений нет.
- Нет сервиса `systemPrompt` → warning, плагин не регистрирует ничего.
- `{{` в тексте владельца экранируется и не ломает сборку промпта.
- `DSH_HOME` не задан → используется `~/.dsh`; несогласованность с другими
  плагинами невозможна, потому что все они разрешают дом одинаково.

## Тесты

- `packages/plugins/dsh-balbes-home/tests/index.test.ts` — юнит: секция
  зарегистрирована с именем `balbes:self` и порядком `100`; `text` отдаёт
  содержимое `self.md`; отсутствие файла → `""`; `{{` экранируется; отсутствие
  `systemPrompt` → warning и никакой регистрации.
- `packages/plugins/dsh-balbes-home/tests/home.real.test.ts` + fixture
  `tests/fixtures/balbes-home-profile/{cordis.patch.yml,package.json}` —
  REAL-композиция (по CONTRIBUTING): бут тестового `cordis.yml` через Loader/app;
  в собранном системном промпте присутствует содержимое `self.md`.
- `packages/plugins/dsh-balbes-workspaces/tests/workspaces.test.ts` — `ensureHome`
  создаёт `skills/README`; `createProject` создаёт `.dsh/skills/README`;
  миграция удаляет только точное совпадение со стартером.

## Канон и документация

Через `canon-write` (канон-файлы вручную не редактируются):

- `docs/canon/ARCHITECTURE.md` — дом как источник глобального контекста,
  `<project>/.dsh/skills`, секция `self.md`.
- `docs/canon/OVERVIEW.md`, `docs/canon/GLOSSARY.md` — состав дома и глобальные
  правила/скиллы перестают быть «будущим шагом».
- `docs/canon/future_plans/p0-agent-workspaces.md` — наполнение дома помечается
  absorbed через `canon-future-plan` (самостоятельной правкой статус не меняем).

Runbook: `docs/runbooks/stage2-vps.md` — как владельцу пользоваться `agent/AGENTS.md`,
`agent/self.md`, `agent/skills/` и `<project>/.dsh/skills`, и как это видно из Telegram.

## Верификация (DoD)

- Локально bounded: repo `typecheck` + дефолтные тесты с
  `--workspace-concurrency=1`; REAL-наборы — на Linux VPS (на 8 GB dev-хосте
  repo-wide `RUN_REAL=1` не запускается, см. addendum плана SP1).
- Серверный smoke после `install.sh`: правка `agent/AGENTS.md` влияет на
  Telegram-задачу; правка `agent/self.md` меняет самоописание агента; скилл
  `agent/skills/<name>/SKILL.md` появляется в каталоге скиллов; скилл в
  `<project>/.dsh/skills` виден только в этом проекте.

## Вне scope

- `notes/` и долговременная память/самообучение.
- Per-workspace правила-файлы (штатная цепочка инструкций уже их покрывает).
- Скиллы Web-поверхности/других каналов.
- Управление домом из админки (владелец правит файлы напрямую).
