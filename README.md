# dsh-balbes-server

Серверная дистрибуция [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
на собственном VPS: один процесс dsh со своей админкой — **без штатной веб-морды dsh**.
dsh используется как зависимость (не форк): всё своё реализуется профилем, патч-слоем и
собственными пакетами поверх стандартных механизмов dsh.

## Что это и что умеет сейчас

- **Профиль `balbes`** = ядро `@deepseek-ai/dsh-base` + собственный host-бандл
  `dsh-balbes-host` + плагин воркспейсов `dsh-balbes-workspaces`
  (headless из ранних этапов убран).
- **Сервер-демон** (systemd): `dsh --profile balbes` поднимает HTTP-админку и держит процесс.
- **Админка** (`dsh-balbes-admin`, React + Vite): вход по логину/паролю (JWT); экраны —
  тестовая страница («Отправить тестовый промпт» → ответ модели) и страница «Проекты»
  (воркспейсы: дом агента отдельной секцией + список/создание/удаление проектов).
- **Воркспейсы на сервере**: дом агента `$DSH_HOME/agent/` (зарезервирован, авто-создаётся
  при старте) и проекты `$DSH_HOME/projects/<имя>/`; каталог — источник правды, реестр-индекс
  `$DSH_HOME/projects.json` (600). Управление — API `/api/workspaces/list|create|delete`
  (bearer) и страница «Проекты» в админке.
- **Авторизация**: логин/пароль генерируются при установке один раз (пароль хранится только
  scrypt-хэшем), JWT HS256 (24 ч), лимит попыток входа 5/30 мин по IP. Все запросы к `/api/*` —
  только POST (правило R-API-1); кроме `login` и `health` каждый хендлер требует валидный токен.
- **Задел на рост**: API-контракты типизированы (`dsh-balbes-contracts` + реестр в
  canon — секция `docs/canon/API_CONTRACTS.md`), шов в ядро повторяет агентский цикл dsh — следующие этапы
  (сессии/чат в воркспейсах, git/ключи, наполнение дома, каналы Telegram/A2A и т.д.)
  добавляются поверх того же host'а.

Текущая дорожная карта и детальные границы — в `docs/canon/`; дизайн и планы этапов —
в `docs/superpowers/specs/` и `docs/superpowers/plans/`.

## Требования

- VPS с **Ubuntu** (22.04/24.04), пользователь с **sudo** (установка от root тоже работает).
- Доступ в интернет (npm registry, GitHub) на время установки/обновления.
- Ключ модели **DeepSeek API** (понадобится для реальных ответов).

## Установка (одна команда)

```bash
curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash
```

Что делает установщик (идемпотентно, повторный запуск = обновление):

1. Ставит окружение: Node ≥ 22 (NodeSource), pnpm, git, глобальный `@deepseek-ai/dsh`.
2. Клонирует/обновляет репозиторий в `~/dsh-balbes-server`.
3. Собирает workspace (host, плагин воркспейсов, контракты, SPA).
4. Синхронизирует профиль `balbes` в `$DSH_HOME/profiles/balbes` и кладёт собранные host
   и плагин воркспейсов в его `node_modules`; SPA — в `$DSH_HOME/balbes/ui`.
5. Принимает ключ DeepSeek (интерактивно; пусто = пропустить) в `$DSH_HOME/.credentials.yaml` (600).
6. Генерирует учётные данные админки **один раз** и печатает их (**сохраните пароль**).
7. Ставит и запускает systemd-юнит `dsh-balbes` (автозапуск, переживает reboot).
8. Проверяет сервис по `POST /api/health` (до ~120 с на холодный старт).

Ключ можно передать без интерактива:

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
```

## Настройки (окружение)

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | каталог данных dsh |
| `BALBES_PORT` | `8080` | порт HTTP-сервера |
| `BALBES_UI_DIST` | `$DSH_HOME/balbes/ui` | каталог собранной админки |
| `DSH_TOOLS_MODE` | (не задана) | режим инструментов (native/ptc) |
| `DEEPSEEK_API_KEY` | — | ключ модели (пишется в `.credentials.yaml`) |

> Граница текущего этапа: доступ по `http://IP:8080` (HTTP, без TLS — защита паролем/токеном,
> TLS — следующий этап).

## Где лежат данные (в `$DSH_HOME`)

- `profiles/balbes/` — установленный профиль (включая собранные host и плагин
  воркспейсов в его `node_modules`);
- `agent/` — дом агента (зарезервированный воркспейс; создаётся автоматически);
- `projects/` — проекты-воркспейсы (`projects/<имя>/` — каталог проекта);
- `projects.json` — реестр-индекс воркспейсов (600; только метаданные `createdAt`,
  источник правды — каталоги на диске);
- `.credentials.yaml` — ключ модели (600);
- `admin-auth.json` — логин, scrypt-хэш пароля, `jwtSecret` (600; открытого пароля там нет);
- `balbes/ui` — собранная админка;
- сессии/настройки dsh — штатные каталоги dsh.

## Структура репозитория

```
packages/
  bundles/dsh-balbes-host/   # Cordis-бандл: патч-слой + плагины startup/server/auth/static/api
  plugins/dsh-balbes-workspaces/ # плагин воркспейсов (дом агента + проекты, API /api/workspaces/*)
  contracts/                 # dsh-balbes-contracts — типы API-контрактов
  frontend/dsh-balbes-admin/ # React SPA (Vite)
profiles/balbes/             # манифест профиля (источник правды — репозиторий)
scripts/
  install.sh                 # установщик одной командой (curl|bash)
  admin-creds.mjs            # генерация/сброс учётных данных админки
  link-core.mjs              # линковка зеркала @deepseek-ai для сборки/typecheck
docs/
  canon/                     # канон (архитектура, глоссарий, контракты API — источник истины)
  runbooks/                  # эксплуатационные runbook'и (установка, DoD, неполадки)
  superpowers/               # спеки и планы этапов
```

## Документация

- `docs/runbooks/stage1-vps.md`, `docs/runbooks/stage2-vps.md` — установка, проверки DoD,
  устранение неполадок.
- `docs/canon/API_CONTRACTS.md` — контракты API (реестр ручек `/api/*`).
- `docs/canon/future_plans/` — направленные инициативы будущего (статусы draft/absorbed).
- `docs/canon/` — архитектура, термины, зафиксированные решения.
- `docs/superpowers/specs/` — продуктовые спеки (MVP; воркспейсы).
- `docs/superpowers/plans/` — планы реализации этапов (воркспейсы и др.).
