# dsh-balbes-server

Серверная дистрибуция [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
на собственном VPS: один процесс dsh со своей админкой — **без штатной веб-морды dsh**.
dsh используется как зависимость (не форк): всё своё реализуется профилем, патч-слоем и
собственными пакетами поверх стандартных механизмов dsh.

## Что это и что умеет сейчас

- **Профиль `balbes`** = ядро `@deepseek-ai/dsh-base` + собственный host-бандл
  `dsh-balbes-host` + девять отдельных плагинов: воркспейсы
  (`dsh-balbes-workspaces`), git-доступ (`dsh-balbes-git`), модели
  (`dsh-balbes-models`), сессии (`dsh-balbes-sessions`), глобальный контекст дома
  (`dsh-balbes-home`), память (`dsh-balbes-memory`, `-context`, `-admin`) и
  Telegram-канал (`dsh-balbes-telegram`). Версия движка зафиксирована пином
  `scripts/engine-version.txt`.
- **Сервер-демон** (systemd): `dsh --profile balbes` поднимает HTTP-админку и держит процесс.
- **Админка** (`dsh-balbes-admin`, React + Vite): вход по логину/паролю (JWT);
  live-экраны — «Проекты», «Модели», «Telegram» и «Память»; пункты «Скиллы»,
  «Агенты», «Команды» и «Настройки» показаны заглушками. Отдельной страницы
  тестового промпта нет: промпт-поверхность — ручка `POST /api/prompt`
  (проверка — curl с JWT).
- **Воркспейсы на сервере**: дом агента `$DSH_HOME/agent/` (глобальные правила
  `AGENTS.md`, секция системного промпта `self.md`, глобальные скиллы) и проекты
  `$DSH_HOME/projects/<имя>/`; каталог — источник правды, реестр-индекс
  `$DSH_HOME/projects.json` (600). Управление — API
  `/api/workspaces/list|create|create-from-git|delete|tree|file|events` (bearer) и
  страница «Проекты»: список воркспейсов, дерево каталога и правая зона табов
  («Сессии» плюс динамические табы открытых сессий и файлов). Диалог сессии
  читается целиком, файлы рендерятся по типу — Markdown и код с подсветкой.
- **Telegram-канал**: задачи в воркспейсах (новые сессии и возврат к прежним),
  выбор воркспейса и модели прямо в чате, гейтованные операции с одноразовым
  подтверждением владельца.
- **Память** (сервис `balbesMemory`): долговременное знание с двумя уровнями
  (дом и проект), типами и тегами, поиском по FTS5. Доставка в модель — ядро
  закреплённых записей и карта в системном промпте, релевантный push в
  runtime-контекст, полный текст — инструментом `recall`; явная запись —
  инструментом `remember`. Владелец видит и правит память в админке, а
  предложенные пайплайном записи проходят ревью: вкладка «Очередь ревью» на
  странице «Память» — одобрение (при необходимости с правкой) или отклонение,
  политика автономии показана владельцу.
- **Авторизация**: логин/пароль генерируются при установке один раз (пароль хранится только
  scrypt-хэшем), JWT HS256 (24 ч), лимит попыток входа 5/30 мин по IP. Все запросы к `/api/*` —
  только POST (правило R-API-1); кроме `login` и `health` каждый хендлер требует валидный токен.
- **Задел на рост**: API-контракты типизированы (`dsh-balbes-contracts` + реестр
  `docs/canon/API_CONTRACTS.md`). Дальше по дорожной карте — компактизация памяти
  (p10d), автоизвлечение знания из задач (p10g), метрики попаданий (p10h),
  потоковая доставка ответа (p11), наблюдаемость сервера (p12), межпроектный
  список дел (p13).

Текущая дорожная карта и детальные границы — в `docs/canon/`; дизайн и планы этапов —
в `docs/superpowers/specs/` и `docs/superpowers/plans/`.

## Требования

- VPS с **Ubuntu** (22.04/24.04), пользователь с **sudo** (установка от root тоже работает).
- Доступ в интернет (npm registry, GitHub) на время установки/обновления.
- Ключ модели **DeepSeek API** — понадобится для реальных ответов; задаётся после установки в админке, раздел «Модели».

## Установка (одна команда)

```bash
curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash
```

Что делает установщик (идемпотентно, повторный запуск = обновление):

1. Ставит окружение: Node ≥ 22 (NodeSource), pnpm, git, глобальный `@deepseek-ai/dsh`.
2. Клонирует/обновляет репозиторий в `~/dsh-balbes-server`.
3. Собирает workspace: host-бандл, девять плагинов, контракты и SPA.
4. Синхронизирует профиль `balbes` в `$DSH_HOME/profiles/balbes`, кладёт собранные
   host и все плагины в его `node_modules`, SPA — в `$DSH_HOME/balbes/ui`.
   Настройки движка из профильного `cordis.patch.yml` при обновлении сохраняются.
5. Ключ DeepSeek **не запрашивает**: если задан `DEEPSEEK_API_KEY`, пишет его в `$DSH_HOME/.credentials.yaml` (600); иначе ключ задаётся после установки в админке, раздел «Модели».
6. Генерирует учётные данные админки **один раз** и печатает их (**сохраните пароль**).
7. Ставит и запускает systemd-юнит `dsh-balbes` (автозапуск, переживает reboot).
8. Проверяет сервис по `POST /api/health` (до ~120 с на холодный старт).

Ключ можно необязательно передать заранее (например, для автоматизации):

```bash
DEEPSEEK_API_KEY="sk-..." curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash
```

Откройте файрвол, если включён ufw:

```bash
sudo ufw allow 8080/tcp
```

## Команды

Управление сервисом:

```bash
systemctl status dsh-balbes        # состояние
systemctl restart dsh-balbes       # ручной перезапуск
journalctl -u dsh-balbes -n 50     # логи
```

Обновление — повторный запуск установщика (та же команда установки): `git pull` → пересборка →
перезапуск сервиса. Логин/пароль не меняются.

Сброс пароля админки (заодно ротирует JWT-секрет — **все выданные токены становятся
недействительными**, в браузере потребуется вход заново):

```bash
bash ~/dsh-balbes-server/scripts/install.sh --reset-admin-password
```

Smoke по API (без браузера):

```bash
# health (публичный)
curl -sS -X POST http://127.0.0.1:8080/api/health

# вход → токен (подставьте логин/пароль из вывода установщика)
TOKEN=$(curl -fsS -X POST http://127.0.0.1:8080/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"login":"<LOGIN>","password":"<PASSWORD>"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")

# тестовый промпт (реальный вызов модели)
curl -sS -X POST http://127.0.0.1:8080/api/prompt \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"prompt":"Напиши ok и больше ничего"}'

# воркспейсы: список → создать → удалить
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/list -H "authorization: Bearer $TOKEN"
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/create \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"my-project"}'
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/delete \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"my-project"}'

# память: список → создать → удалить
curl -sS -X POST http://127.0.0.1:8080/api/memory/list -H "authorization: Bearer $TOKEN"
curl -sS -X POST http://127.0.0.1:8080/api/memory/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":{"kind":"global"},"type":"note","text":"smoke note","tags":["smoke"]}'
curl -sS -X POST http://127.0.0.1:8080/api/memory/delete \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"id":"<id>"}'
```

Полный смоук памяти — включая ревью предложенных записей (предложить → очередь
и политика → одобрить с правкой → повторное решение отклоняется) — в
`docs/runbooks/stage2-vps.md`.

## Настройки (окружение)

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | каталог данных dsh |
| `BALBES_PORT` | `8080` | порт HTTP-сервера |
| `BALBES_UI_DIST` | `$DSH_HOME/balbes/ui` | каталог собранной админки |
| `DSH_TOOLS_MODE` | (не задана) | режим инструментов (native/ptc) |
| `DEEPSEEK_API_KEY` | — | необязательный ключ модели для неинтерактивной установки (пишется в `.credentials.yaml`); иначе — в админке, раздел «Модели» |

> Граница текущего этапа: доступ по `http://IP:8080` (HTTP, без TLS — защита паролем/токеном,
> TLS — следующий этап).

## Где лежат данные (в `$DSH_HOME`)

- `profiles/balbes/` — установленный профиль: собранные host и все плагины в его
  `node_modules`, настройки движка в `cordis.patch.yml` (ими управляют админка и
  Telegram — вручную не редактируйте);
- `profiles/node_modules/` — зеркало-симлинки на установку dsh (`@deepseek-ai/*`);
- `admin-auth.json` — логин, scrypt-хэш пароля, `jwtSecret`, `createdAt` (600;
  открытого пароля там нет);
- `.credentials.yaml` — ключи API, включая ключ модели (600);
- `agent/` — дом агента: `AGENTS.md`, `self.md`, `skills/` (создаётся
  автоматически; правки владельца не перезаписываются);
- `projects/` — проекты-воркспейсы (`projects/<имя>/` — каталог проекта);
- `projects.json` — реестр-индекс воркспейсов (600; только метаданные `createdAt`,
  источник правды — каталоги на диске);
- `workspace-sessions.json` — реестр сессий воркспейсов (600): «воркспейс →
  `sessionId` + канал»; заголовки берутся из логов сессий `sessions/`;
- `telegram-state.json` — состояние Telegram-канала (600): offset long polling,
  выбранный воркспейс, id сессий и архив; токен бота лежит не здесь, а в
  `.credentials.yaml`;
- `storages/memory.sqlite` — долговременная память (SQLite, WAL). Перед миграцией
  схемы рядом создаётся бэкап `memory.sqlite.bak-v<прежняя версия>`; на свежей БД
  апгрейда нет, поэтому бэкапа не будет — это не ошибка;
- `balbes/ui/` — собранная админка, которую раздаёт сервер;
- `settings.yaml.imported` — легаси-документ dsh ≤ 0.1.5, не источник истины;
- сессии/настройки dsh — штатные каталоги dsh.

## Структура репозитория

```
packages/
  bundles/dsh-balbes-host/          # Cordis-бандл: патч-слой + плагины startup/server/auth/static/api
  plugins/dsh-balbes-workspaces/    # воркспейсы: дом агента и проекты (/api/workspaces/*)
  plugins/dsh-balbes-git/           # git-доступ: токен и создание проекта из GitHub
  plugins/dsh-balbes-models/        # модели: каталог, настройки, модель по умолчанию
  plugins/dsh-balbes-sessions/      # реестр сессий воркспейсов (/api/sessions/*)
  plugins/dsh-balbes-home/          # глобальный контекст дома агента
  plugins/dsh-balbes-memory/        # память: SQLite-хранилище и сервис balbesMemory
  plugins/dsh-balbes-memory-context/ # доставка памяти в модель: ядро, карта, push, recall, remember
  plugins/dsh-balbes-memory-admin/  # ручки памяти и очереди ревью (/api/memory/*)
  plugins/dsh-balbes-telegram/      # Telegram-канал: сессии, апрувы, команды
  contracts/                        # dsh-balbes-contracts — типы API-контрактов
  frontend/dsh-balbes-admin/        # React SPA (Vite)
profiles/balbes/                    # манифест профиля (источник правды — репозиторий)
scripts/
  install.sh                        # установщик одной командой (curl|bash)
  admin-creds.mjs                   # генерация/сброс учётных данных админки
  link-core.mjs                     # линковка зеркала @deepseek-ai для сборки/typecheck
docs/
  canon/                            # канон (архитектура, глоссарий, контракты API — источник истины)
  runbooks/                         # эксплуатационные runbook'и (установка, DoD, неполадки)
  superpowers/                      # спеки и планы этапов
```

## Документация

- `docs/runbooks/stage1-vps.md`, `docs/runbooks/stage2-vps.md` — установка, проверки DoD,
  устранение неполадок.
- `docs/canon/API_CONTRACTS.md` — контракты API (реестр ручек `/api/*`).
- `docs/canon/future_plans/` — направленные инициативы будущего (статусы draft/absorbed).
- `docs/canon/ADMIN_UI.md` — экраны админки и их поведение.
- `docs/canon/` — архитектура, термины, зафиксированные решения.
- `docs/superpowers/specs/` — продуктовые спеки (MVP; воркспейсы).
- `docs/superpowers/plans/` — планы реализации этапов (воркспейсы и др.).
