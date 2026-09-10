# Runbook Этапа 2: сервер `dsh-balbes` с админкой на VPS одной командой

## Цель

Runbook описывает развёртывание профиля dsh `balbes` как **сервера-демона с
админкой**: HTTP-сервер (systemd-юнит `dsh-balbes`) слушает порт и отдаёт
собранный SPA админки (`http://<IP>:8080`) с экраном логина, воркспейсами,
настройками моделей и Telegram-интеграцией. Вход — по логину/паролю,
сгенерированным при установке и напечатанным **один раз**; запросы к API —
через JWT. Все `/api/*` — POST (R-API-1). Telegram использует long polling,
работает только для одного разрешённого владельца в личном чате и не требует
входящего порта, webhook, домена или HTTPS endpoint.

Профиль `balbes` на Этапе 2 собирается из бандлов `@deepseek-ai/dsh-base` и
`dsh-balbes-host` (наш host: сервер + статика + auth + api + startup);
поверх них в профиль подключён плагин воркспейсов `dsh-balbes-workspaces`
(API `/api/workspaces/list|create|delete|tree|events`, bearer): список,
создание и удаление воркспейсов-проектов, чтение дерева каталогов
(`tree`) и push-канал их изменений (`events`), на котором админка
обновляет дерево без перезагрузки страницы. Также подключается плагин
`dsh-balbes-telegram`: long polling Bot API, настройки через админку,
workspace-aware задачи штатного dsh agent loop и чтение ограниченных
текстовых файлов. В профиль плагины вносятся патч-слоем
`profiles/balbes/cordis.patch.yml`, а собранный пакет копируется в
`node_modules` профиля рядом с host. Headless и веб-морда (`dsh-web-app`) в
профиль **не входят** — «мордой» теперь служит собственная админка host'а.

Критерий готовности этапа: по этому runbook'у сервер разворачивается на VPS и
проходит ручную проверку — список команд и ожидаемых результатов в разделе
«Ручная проверка (DoD, спека 9.4)» ниже. Источник профиля и скриптов —
репозиторий https://github.com/mdikarev/dsh-balbes-server, ветка `main`.

## Требования

- Ubuntu (установщик использует `apt`; целевая — свежая Ubuntu LTS) и
  пользователь с правами `sudo` — как в Этапе 1.
- `curl` (если нет: `sudo apt-get install -y curl`).
- Доступ в интернет: `raw.githubusercontent.com`, npm registry и API DeepSeek.
- Свободный TCP-порт `8080` (или другой, см. `BALBES_PORT` ниже); сервер
  слушает `0.0.0.0` — порт должен быть открыт в файрволе хоста (см.
  «Файрвол»), а для VPS за облачным файрволом (security group) — ещё и в
  панели провайдера.
- **Этап 1 выполнять не нужно**: установщик Этапа 2 сам ставит окружение
  (Node ≥ 22, pnpm, git), dsh, профиль и ключ. Если Этап 1 уже был выполнен на
  этой машине — повторный запуск установщика аккуратно обновит профиль до
  сервера (ключ в `$DSH_HOME/.credentials.yaml` при этом сохраняется).

## Установка одной командой

Установка выполняется скриптом `scripts/install.sh` из репозитория:

```bash
curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash
```

В ходе выполнения скрипт (как и в Этапе 1) интерактивно запросит DeepSeek API
key — запрос читается с терминала (`/dev/tty`) и работает даже внутри
конвейера `curl ... | bash`. Пустой ввод пропускает установку ключа. Чтобы не
вводить ключ вручную, экспортируйте его заранее (без `export` переменную
увидит только curl, а не bash, исполняющий скрипт):

```bash
export DEEPSEEK_API_KEY=sk-ваш-ключ
curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash
```

Скрипт идемпотентен: повторный запуск безопасен и работает как обновление
(см. раздел «Обновление»).

В конце установки скрипт печатает сводку: адрес админки
`http://<IP>:8080`, напоминание, где логин/пароль (они напечатаны чуть выше в
логе — **при первом** запуске), и команды smoke-проверки без браузера. Если
вы сохраняли лог установки в файл (`| tee install.log`) — удалите или
ограничьте доступ к нему после того, как сохраните пароль: в нём лежит
единственная копия пароля.

## Что делает установщик (по шагам)

1. **Окружение.** Если `node` ниже 22 или нет `npm` — подключает репозиторий
   NodeSource и ставит Node 22 LTS через `apt`; если нет pnpm — ставит его
   глобально через npm; если нет git — ставит `git` через `apt`.
2. **dsh.** Если команда `dsh` отсутствует — ставит глобально:
   `sudo npm i -g @deepseek-ai/dsh`.
3. **Репозиторий.** Клонирует https://github.com/mdikarev/dsh-balbes-server в
   `$HOME/dsh-balbes-server` (или в каталог из `$DSH_BALBES_REPO_DIR`); если
   клон уже есть — обновляет его через `git pull --ff-only`.
4. **Сборка workspace.** В клоне репозитория: `pnpm install` и
   `pnpm -r --if-present run build` — собираются `dsh-balbes-contracts`
   (типы), `dsh-balbes-host` (tsc) и SPA админки `dsh-balbes-admin`
   (vite → `packages/frontend/dsh-balbes-admin/dist`). Сборка идёт **до**
   рестарта сервиса: если она падает, установщик выходит с ошибкой, а уже
   работающий сервис не трогается.
5. **Профиль.** Синхронизирует `profiles/balbes` из репозитория в
   `$DSH_HOME/profiles/balbes` (замена каталога целиком; профиль в репо —
   источник правды).
6. **Host в профиль.** Собранный бандл копируется реальным каталогом в
   `$DSH_HOME/profiles/balbes/node_modules/dsh-balbes-host` (из него
   выкидываются `src/`, `tests/`, `lib/types`, `tsconfig.json`). Тем же
   способом туда копируются собранные плагины `dsh-balbes-workspaces`,
   `dsh-balbes-models` и `dsh-balbes-telegram`. Импорты
   `@deepseek-ai/*` резолвятся подъёмом к зеркалу
   `$DSH_HOME/profiles/node_modules` (механика Этапа 1).
7. **SPA.** Собранный дистрибутив админки копируется в
   `$DSH_HOME/balbes/ui` (старый каталог удаляется целиком).
8. **Ключ API.** Если `DEEPSEEK_API_KEY` не задан в окружении — запрашивает
   ключ интерактивно и записывает в `$DSH_HOME/.credentials.yaml` (права
   `600`), по правилам Этапа 1: существующий файл и чужие записи не
   перезаписываются.
9. **Проверка композиции.** `dsh --profile balbes --dump-config`; падение
   считается ошибкой установки.
10. **Учётная запись администратора.** `scripts/admin-creds.mjs ensure`
    создаёт `$DSH_HOME/admin-auth.json` (права `600`, один раз): случайный
    логин вида `balbes-<8 hex-символов>`, scrypt-хэш пароля, `jwtSecret` и
    `createdAt`. Логин и пароль печатаются **один раз**:
    ```
    Admin credentials generated (stored hashed, printed once):
      login:    balbes-1a2b3c4d
      password: <случайный пароль>
    ```
    При повторном запуске файл не перезаписывается, пароль не печатается —
    только `Admin login (unchanged): <login>` и подсказка про сброс пароля.
11. **systemd.** Пишет юнит `/etc/systemd/system/dsh-balbes.service`
    (описание в разделе «Проверка демона») и выполняет
    `systemctl daemon-reload` + `systemctl enable` + `systemctl restart`.
    Рестарт происходит на **каждом** запуске установщика: после обновления
    демон сразу поднимается на новом коде, ручной рестарт не нужен.
12. **Health и финал.** `POST http://127.0.0.1:<порт>/api/health` должен
    вернуть `{"ok":true,...}`; иначе установка считается неудачной
    (диагностика — в «Устранении неполадок»). Затем печатается итоговая
    сводка с адресом админки и smoke-командами.

Переменные окружения, которые учитывает установщик:

- `DEEPSEEK_API_KEY` — ключ DeepSeek (иначе интерактивный ввод);
- `DSH_HOME` — каталог данных dsh (по умолчанию `$HOME/.dsh`);
- `DSH_BALBES_REPO_DIR` — каталог клона репозитория (по умолчанию
  `$HOME/dsh-balbes-server`);
- `BALBES_PORT` — порт сервера (по умолчанию `8080`); прописывается в юнит и
  используется health-проверкой и сводкой.

## Файрвол

Порт, на котором слушает сервер (по умолчанию `8080`), должен быть открыт в
файрволе хоста. Если ufw ещё не включён — сначала разрешите SSH, чтобы не
потерять доступ, затем порт админки, затем включите ufw:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 8080/tcp        # или порт из BALBES_PORT
sudo ufw enable                # только если ufw ещё не активен
sudo ufw status verbose        # ожидается: 8080/tcp ALLOW
```

Если порт менялся (`BALBES_PORT`), откройте именно его. Для VPS за облачным
файрволом (security group) добавьте правило и там.

## Доступ

Админка открывается в браузере по адресу из сводки установки:
`http://<IP>:8080` (IP — первый адрес `hostname -I`; посмотреть вручную:
`hostname -I | awk '{print $1}'`). Собранный SPA отдаёт сам сервер.

Страница — экран входа («balbes admin»). Логин и пароль — из лога установки
(строки `login:` / `password:` выше блока сводки). После входа — рабочая
зона с сайдбаром: **«Тестовая страница»** (промпт `Напиши 'ok' и больше
ничего` и кнопка **«Отправить тестовый промпт»**: ответ реальной модели
появляется над кнопкой), **«Проекты»** — страница воркспейсов (smoke —
в подразделе ниже), **«Модели»** — подключения моделей и дефолтная модель, и
**«Telegram»** — настройка бота (раздел «Настройка Telegram через админку»
ниже). JWT хранится в localStorage и при перезагрузке страницы
проверяется через `POST /api/auth/me` — повторный вход не требуется, пока
токен жив (24 часа).

Неверный пароль → ошибка 401; после 5 неудачных попыток с одного IP вход
блокируется на 30 минут (429).

### Страница «Проекты» (три панели)

В сайдбаре выберите **«Проекты»** (группа «Работа»). Страница — три панели:
слева список воркспейсов, в середине дерево каталогов выбранного
воркспейса, справа пустая панель-заглушка (зарезервирована под будущие
рабочие области).

Список (панель «Воркспейсы»): вверху закреплён **«Дом агента»** (без меню
действий), ниже — проекты; у каждого проекта справа кнопка «⋮» с меню
действий (сегодня — «Удалить»); «+» над списком открывает модалку создания
проекта. Ожидается: клик по строке подсвечивает её, выбор переживает
перезагрузку страницы (localStorage). На свежем сервере дерево «Дома
агента» содержит стартовые файлы `AGENTS.md`, `self.md` и каталог `skills/`
(сервер создаёт их один раз при первом старте).

Дерево: пока воркспейс не выбран, средняя панель показывает «Выберите
воркспейс»; после выбора (дом или проект) появляется дерево корня —
каталоги раскрываются кликом, содержимое читается лениво, по одному
каталогу (`/api/workspaces/tree`). Для пустого проекта ожидается «Каталог
пуст» вместо списка.

Живое обновление: создайте файл на сервере, не трогая страницу —
`touch "$DSH_HOME/projects/<имя проекта>/x.txt"` — ожидается появление
`x.txt` в дереве в течение пары секунд **без перезагрузки страницы**
(страница подписана на `/api/workspaces/events`; тот же канал обновляет
список при создании/удалении проектов и дерево «Дома агента» —
`$DSH_HOME/agent/`).

## Настройка Telegram через админку

Откройте админку и войдите обычными учётными данными. В сайдбаре выберите
**«Telegram»** — страница с карточкой статуса и формой: поля **«Токен бота»**
и **«User ID»**, чекбокс **«Включить бота»** и кнопки **«Проверить
подключение»**, **«Сохранить»**, **«Отключить»**, **«Удалить токен»**. Всё
настраивается из этой формы: рестарт сервиса не нужен, настройки применяются
на лету.

1. Создайте бота через BotFather и скопируйте bot token.
2. Узнайте свой числовой Telegram User ID через доверенного Telegram-бота.
3. Вставьте token и User ID в форму. Пустое поле означает «оставить как есть»,
   а не «очистить»: пустой токен сохраняет текущий токен, пустой User ID —
   текущий id (заменить User ID можно только другим положительным числом,
   сбросить его из формы нельзя). Сам токен в интерфейсе не показывается
   никогда — при сохранённом токене карточка печатает `Токен: ••••`.
4. Нажмите **«Сохранить»**. Сохранение с включённым ботом требует, чтобы был
   сохранён токен **и** положительный User ID: `{"enabled":true}` без токена
   или без User ID сервер отклоняет целиком — `400 invalid-config`, при этом
   не записывается ни токен, ни настройки. Нечисловой или нулевой User ID —
   `400 invalid-user-id` (в форме это видно раньше: кнопка «Сохранить»
   заблокирована, если введён неположительный id или включён бот без id).
5. Нажмите **«Проверить подключение»**. Кнопка проверяет **сохранённый**
   токен одним вызовом `getMe` и больше ничего: ничего не сохраняет, не
   включает и не меняет статус. Ожидается строка
   `Подключение работает: @имя_бота`. Поэтому порядок такой: сначала
   «Сохранить» токен, потом проверять (введённый, но не сохранённый токен не
   проверяется). Если токена ещё нет — `400 not-configured`, неверный токен —
   `400 invalid-token`, недоступный Telegram — `502 telegram-error`.
6. Включите чекбокс «Включить бота» и сохраните — long polling стартует **без
   рестарта сервиса**. Карточка статуса показывает **«подключено»**, а через
   несколько секунд — и `Последний успешный опрос`. Если сразу после
   сохранения статус ещё не «подключено», это нормально: цикл стартует фоном,
   а статус страница перечитывает на каждой операции.
7. В личном чате с ботом отправьте `/start` — ожидается приветствие
   «Привет! Я агент твоего сервера.» и кнопка **«Воркспейсы»**; нажмите её и
   выберите `Дом агента` или проект — ожидается `Выбран: …`. Любая другая
   команда тоже отвечает корневым меню: команды агенту не уходят.
8. Отправьте текстовую задачу; ожидается «Задача принята…», затем финальный
   ответ штатного dsh agent loop (длинный ответ приходит несколькими
   сообщениями). Кнопка **«Файлы»** открывает дерево выбранного воркспейса:
   каталоги раскрываются кликом, текстовые файлы показываются постранично.
   Бинарные файлы и симлинки не открываются. **«Сбросить контекст»** завершает
   текущую сессию воркспейса — следующая задача начнётся с чистого контекста.

Кнопки формы и состояния карточки:

- **«Отключить»** — выключает бота (`enabled: false`), **токен сохраняется**;
  входящие update больше не обрабатываются.
- **«Удалить токен»** (через подтверждение в модалке) — удаляет токен из
  хранилища и выключает бота: состояние становится **«не настроено»**.
- Состояния: **«не настроено»** (токена нет), **«выключено»** (токен есть, бот
  выключен), **«подключено»** (цикл опроса работает), **«ошибка»** (включено,
  но цикл не работает — рядом строка `Ошибка бота: …`).

Что происходит с polling при отключении: состояние в `/api/telegram/status`
меняется **сразу** (оно читается из настроек), а сам цикл опроса дожидается
уже начатого `getUpdates` и только потом встаёт — до ~50 с при живом Telegram
и до ~180 с при мёртвой сети (повторы по таймауту). Это не зависание: ручки
отвечают, не дожидаясь остановки, поэтому «выключено» в статусе сразу после
нажатия — ожидаемое поведение.

Просмотр файлов в чате ограничен настройкой `maxFileBytes` плагина (по
умолчанию 256 КиБ): это предел **отображения** файла в Telegram, а не
ограничение доступа агента — агент читает файлы воркспейса как обычно.

Входящие сообщения из групп и от другого User ID игнорируются молча, без
раскрытия списка воркспейсов.

Служебная переменная окружения `BALBES_TELEGRAM_API_BASE` задаёт базовый адрес
Bot API и существует только для тестов (указывает на локальный фейковый Bot
API): на сервере она не задаётся — ни в юните, ни в профиле — и менять её не
нужно.

## Smoke без браузера (curl + JWT)

Команды — блок «Smoke without a browser» из итоговой сводки установщика
(`print_admin_summary` в `scripts/install.sh`), здесь — с корректным
извлечением токена из JSON-ответа логина. Логин и пароль подставьте из лога
установки. Ответ `POST /api/auth/login` — JSON
`{"token": ..., "expiresAt": ...}`; для запросов нужен только `token`:

```bash
# 1) Публичный health-чек
curl -fsS -X POST http://127.0.0.1:8080/api/health
# ожидается: {"ok":true,"version":"0.1.0"}

# 2) Логин: получаем JWT
RESP=$(curl -fsS -X POST http://127.0.0.1:8080/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"login":"balbes-1a2b3c4d","password":"ВАШ-ПАРОЛЬ-ИЗ-ЛОГА"}')
# ожидается: {"token":"eyJ...","expiresAt":"..."}
TOKEN=$(printf '%s' "$RESP" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

# 3) Тестовый промпт с JWT (нужен настроенный ключ DeepSeek)
curl -fsS -X POST http://127.0.0.1:8080/api/prompt \
  -H "authorization: Bearer $TOKEN" \
  -d '{"prompt":"Напиши ok"}'
# ожидается: HTTP 200, JSON вида {"text":"ok","reason":{"kind":"completed"}}
```

```bash
# воркспейсы (bearer; подставьте TOKEN из входа выше)
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/list \
  -H "authorization: Bearer $TOKEN"
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/create \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"my-project"}'
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/delete \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"my-project"}'
```

Модели: список подключений и дефолтная модель — `POST /api/models/list`
(bearer). Полный smoke — REAL-тест пакета `dsh-balbes-models`; с настроенным
ключом DeepSeek ожидается подключение `deepseek-official`:

```bash
# models.list (JWT из входа)
curl -sS -X POST http://127.0.0.1:8080/api/models/list \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
# ожидается: {"connections":[{"routeId":"deepseek-official","kind":"deepseek","hasKey":true,...}],
#             "default":{"provider":"deepseek-official","model":"deepseek-v4-flash"}}
```

```bash
# models.catalog (JWT из входа; каталог движка по провайдеру)
curl -sS -X POST http://127.0.0.1:8080/api/models/catalog \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"provider":"deepseek-official"}'
# ожидается: models содержит deepseek-v4-flash, deepseek-v4-pro,
#             deepseek-v4-flash-vision-exp (3)
curl -sS -X POST http://127.0.0.1:8080/api/models/catalog \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"provider":"openai"}'
# ожидается: непустой список models
```

Дерево и события (в сводку установщика не входят — их полный smoke — в
REAL-тесте `dsh-balbes-workspaces`). Создайте проект `alpha` и проверьте
чтение каталогов (`/api/workspaces/tree`) и защиту каналов:

```bash
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/create \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"alpha"}' -w '\nHTTP %{http_code}\n'
#    ожидается: {"project":{"name":"alpha",...}} и HTTP 200

# корень проекта: пустой у нового проекта
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/tree \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":"project","name":"alpha","path":""}' -w '\nHTTP %{http_code}\n'
#    ожидается: {"entries":[]} и HTTP 200

# попытка выйти за корень воркспейса (traversal)
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/tree \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":"project","name":"alpha","path":"../.."}' -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 400 {"error":{"code":"invalid-path",...}}

# несуществующий каталог
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/tree \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scope":"project","name":"alpha","path":"no-such-dir"}' -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 404 {"error":{"code":"not-found",...}}

# без токена: tree и events обязаны отвечать 401
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/tree \
  -H 'content-type: application/json' \
  -d '{"scope":"project","name":"alpha","path":""}' -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 401
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/events \
  -H 'content-type: application/json' -d '{}' -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 401

curl -sS -X POST http://127.0.0.1:8080/api/workspaces/delete \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"alpha"}'
#    ожидается: {}
```

Полный smoke потока событий — REAL-тест пакета `dsh-balbes-workspaces`
(`RUN_REAL=1 pnpm --filter dsh-balbes-workspaces test`, нужен `dsh` на PATH).
Вручную: откройте поток в соседнем терминале и держите открытым:

```bash
curl -N -X POST http://127.0.0.1:8080/api/workspaces/events \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
```

Блок выше удалил проект `alpha` — создайте его заново (в основном терминале;
поток в соседнем при этом остаётся открытым):

```bash
curl -sS -X POST http://127.0.0.1:8080/api/workspaces/create \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"alpha"}' -w '\nHTTP %{http_code}\n'
#    ожидается: {"project":{"name":"alpha",...}} и HTTP 200
```

Затем создайте файл под проектом — `touch "$DSH_HOME/projects/alpha/x.txt"`:
ожидается кадр `data: {"kind":"fs","scope":"project","name":"alpha","path":""}`.
Соединение сервер не закрывает: heartbeat `: ping` — каждые 25 с. Получив кадр,
остановите поток в соседнем терминале (Ctrl-C).

Telegram: пять ручек `/api/telegram/*` (все — bearer, все отвечают JSON); в сводку
установщика входит строка `/api/telegram/status` — ожидаемый ответ на свежем
сервере тот же, что у первого curl ниже:
`{"status":{"state":"not-configured","tokenConfigured":false,"enabled":false}}`.
Полный smoke Telegram-канала — REAL-тест пакета `dsh-balbes-telegram`
(`integration.test.ts`), ниже — то, что можно проверить на живом сервере:

```bash
# статус на свежем сервере (токена ещё нет)
curl -sS -X POST http://127.0.0.1:8080/api/telegram/status \
  -H "authorization: Bearer $TOKEN" -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 200
#    {"status":{"state":"not-configured","tokenConfigured":false,"enabled":false}}

# включить без токена и User ID: 400, НИЧЕГО не записывается
curl -sS -X POST http://127.0.0.1:8080/api/telegram/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"enabled":true}' -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 400
#    {"error":{"code":"invalid-config","message":"store a bot token and a positive User ID before enabling the bot"}}

# неположительный User ID (0, отрицательный, null) — тоже 400
curl -sS -X POST http://127.0.0.1:8080/api/telegram/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"allowedUserId":0}' -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 400
#    {"error":{"code":"invalid-user-id","message":"allowedUserId must be a positive integer"}}

# тест подключения без сохранённого токена
curl -sS -X POST http://127.0.0.1:8080/api/telegram/test \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{}' -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 400
#    {"error":{"code":"not-configured","message":"bot token is not configured"}}

# сохраняем токен и User ID, бот пока выключен
curl -sS -X POST http://127.0.0.1:8080/api/telegram/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"token":"123456:ВАШ-ТОКЕН","allowedUserId":123456789,"enabled":false}' \
  -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 200
#    {"status":{"state":"disabled","tokenConfigured":true,"enabled":false,"allowedUserId":123456789}}

# тест подключения с сохранённым токеном (getMe; ничего не сохраняет и не включает)
curl -sS -X POST http://127.0.0.1:8080/api/telegram/test \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{}' -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 200 {"username":"имя_бота"} (имя без @)
#    неверный токен → HTTP 400 {"error":{"code":"invalid-token",...}}
#    Telegram ответил иначе/недоступен → HTTP 502
#    {"error":{"code":"telegram-error","message":"…"}} (текст ошибки Telegram,
#    токен в нём вырезан; без ответа от Telegram — "getMe failed")

# включаем бота (токен и User ID уже сохранены)
curl -sS -X POST http://127.0.0.1:8080/api/telegram/save \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"enabled":true}' -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 200; "state" становится "connected", когда цикл опроса
#    действительно поднялся (обычно сразу, иногда через пару секунд), плюс
#    "botUsername" после фонового getMe и "lastPollAt" после первого опроса:
#    {"status":{"state":"connected","tokenConfigured":true,"enabled":true,
#               "allowedUserId":123456789,"botUsername":"имя_бота","lastPollAt":"2026-…"}}

# отключаем бота: токен ОСТАЁТСЯ
curl -sS -X POST http://127.0.0.1:8080/api/telegram/disable \
  -H "authorization: Bearer $TOKEN" -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 200
#    {"status":{"state":"disabled","tokenConfigured":true,"enabled":false,"allowedUserId":123456789}}
#    (состояние меняется сразу; сам цикл опроса дожидается текущего getUpdates —
#     до ~50 с при живом Telegram, до ~180 с при мёртвой сети)

# удаляем токен: бот выключается, состояние "не настроено"
curl -sS -X POST http://127.0.0.1:8080/api/telegram/clear-token \
  -H "authorization: Bearer $TOKEN" -w '\nHTTP %{http_code}\n'
#    ожидается: HTTP 200
#    {"status":{"state":"not-configured","tokenConfigured":false,"enabled":false,"allowedUserId":123456789}}

# без токена все пять ручек обязаны отвечать 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/telegram/status
#    ожидается: 401
```

Порядок в блоке соответствует состояниям: `not-configured` → `disabled` →
`connected`. Строка `tokenConfigured` — единственное, что API сообщает о
токене; сам токен не возвращается ни в одном ответе. Поле `botUsername`
заполняется фоновым `getMe`, поэтому появляется не мгновенно и может ещё
присутствовать в ответе на `disable`/`clear-token` (имя сбрасывается вместе с
токеном в фоне) — ориентируйтесь на `state` и `tokenConfigured`.

Если на шаге 2 вместо токена пришла ошибка — проверьте, что в
`-d '{"login":...,"password":...}'` подставлены именно те значения, что
напечатаны в логе установки, и что файл `$DSH_HOME/admin-auth.json`
существует (см. «Битый или удалённый admin-auth.json»).

Требуется настроенный ключ модели: `/api/prompt` гоняет запрос через
реальную модель DeepSeek (ключ — в `$DSH_HOME/.credentials.yaml`). Без ключа
ответ — HTTP 502 с `reason.kind="error"` (см. «Нет ключа модели»).

## Обновление

Обновление — повторный запуск установщика: он подтянет репозиторий
(`git pull --ff-only`), пересоберёт workspace, пересинхронизирует профиль,
обновит host и SPA на диске. Ключ API при запросе пропускается (Enter).
Пароль администратора при этом **не меняется**: `admin-auth.json` уже
существует, поэтому печатается только `Admin login (unchanged): <login>`;
данные сессий dsh не трогаются.

```bash
curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash
curl -fsS -X POST http://127.0.0.1:8080/api/health   # {"ok":true,...}
```

Установщик **перезапускает сервис на каждом запуске** (`systemctl restart`
в шаге 11), поэтому после обновления демон сразу работает на новом коде —
ручной `systemctl restart dsh-balbes` не нужен. Перезапускайте юнит вручную
только если меняли что-то руками (конфигурацию юнита, файлы окружения и т.п.),
см. «Устранение неполадок».

## Сброс пароля

Пароль хранится только в виде scrypt-хэша — восстановить его нельзя, только
сгенерировать новый:

```bash
bash ~/dsh-balbes-server/scripts/install.sh --reset-admin-password
```

Ожидаемый вывод:

```
Password reset for login: balbes-1a2b3c4d
  new password (printed once): <новый пароль>
```

Логин при сбросе сохраняется, а `jwtSecret` ротируется: вместе с новым
паролем (scrypt-хэшем) в файл атомарно записывается новый секрет подписи.
Поэтому старый пароль сразу перестаёт подходить, и **ранее выданные JWT сразу
становятся недействительными** (файл перечитывается при каждой выдаче и
проверке токена и при каждом входе — рестарт не нужен). Команда требует уже
выполненной установки: она читает существующий `$DSH_HOME/admin-auth.json` и
собранный host. После сброса войдите в админку с новым паролем.

## Проверка демона

Юнит `/etc/systemd/system/dsh-balbes.service`: сервис от имени пользователя,
который запускал установку; `ExecStart` — глобальный `dsh --profile balbes`;
переменные `DSH_HOME`, `BALBES_PORT`, `BALBES_UI_DIST`; `Restart=on-failure`;
basic hardening (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem`,
`ReadWritePaths=$DSH_HOME`); `WantedBy=multi-user.target` с
`After/Wants=network-online.target`.

```bash
systemctl status dsh-balbes        # active (running), enabled
systemctl is-enabled dsh-balbes    # enabled
systemctl is-active dsh-balbes     # active
```

Демон поднимается при загрузке: переживает reboot VPS. После
`sudo reboot` и возврата по SSH:

```bash
systemctl is-active dsh-balbes     # active (может понадобиться пара секунд
                                   # после появления сети: юнит ждёт network-online)
curl -fsS -X POST http://127.0.0.1:8080/api/health   # {"ok":true,...}
```

## Ручная проверка (DoD, спека 9.4)

Список — ровно критерии готовности Этапа 2 (спека 9.4). Раздел самодостаточен:
команды и ожидаемые результаты ниже; выполняется на VPS после установки
(пункты 3–4 и 6–7 используют команды разделов «Доступ»/«Smoke без браузера»/
«Обновление»/«Сброс пароля»).

```bash
# 1. Демон и reboot
systemctl is-enabled dsh-balbes && systemctl is-active dsh-balbes
#    ожидается: enabled, active
sudo reboot   # после возврата:
systemctl is-active dsh-balbes
#    ожидается: active — демон пережил reboot

# 2. Админка и отсутствие штатной морды
curl -fsS -X POST http://127.0.0.1:8080/api/health
#    ожидается: {"ok":true,"version":"0.1.0"}
ps aux | grep -i dsh | grep -v grep
#    ожидается: один процесс сервера (dsh --profile balbes); процессов
#    dsh-web-app / headless нет
dsh --profile balbes --dump-config | grep -E 'dsh-web-app|dsh-headless'
#    ожидается: пусто (grep ничего не нашёл)
```

3. **Вход.** В браузере `http://<IP>:8080`: логин/пароль из лога установки →
   страница с тестовым промптом; неверный пароль → ошибка 401. Либо curl:
   команда (2) из «Smoke без браузера» → `{"token":...}`.
4. **Кнопка / curl.** Кнопка **«Отправить тестовый промпт»** — ответ реальной
   модели над кнопкой; либо curl-команда (3) из «Smoke без браузера» →
   HTTP 200, `{"text":...,"reason":{"kind":"completed"}}`. Перезагрузка
   страницы с токеном не требует повторного входа (`/api/auth/me`).
5. **401 без токена** (проверено curl'ом «из интернета» — с другого хоста по
   `http://<IP>:8080`, если открыт файрвол):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/prompt -H 'content-type: application/json' -d '{"prompt":"x"}'   # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/auth/me                                                          # 401
#    health и login при этом открыты (см. п. 2 и 3)
```

6. **Обновление.** Повторный `install.sh` (команда из «Обновления»):
   установщик сам перезапускает сервис; логин и пароль не меняются
   (`Admin login (unchanged): ...`), данные сессий целы.
7. **Сброс пароля.** `bash ~/dsh-balbes-server/scripts/install.sh
   --reset-admin-password` → новый пароль в логе; вход по старому → 401, по
   новому → успех.
8. **Секреты не в git.** В клоне репозитория и в репозитории на GitHub нет
   `admin-auth.json` / `.credentials.yaml`; на сервере они с правами 600:

```bash
cd ~/dsh-balbes-server
git ls-files | grep -E 'admin-auth\.json|\.credentials\.yaml'   # пусто
ls -l "$HOME/.dsh/admin-auth.json" "$HOME/.dsh/.credentials.yaml"   # -rw------- (600)
```

9. **CI зелёный** — GitHub Actions на ветке `main`:
   https://github.com/mdikarev/dsh-balbes-server/actions (job `validate`:
   typecheck, тесты, сборка, композиция профиля без LLM, `bash -n` скриптов).
10. **Контракты.** SPA админки импортирует типы из `dsh-balbes-contracts`, и
    имена полей совпадают с host'ом: `/api/auth/login`
    `{login,password}` → `{token,expiresAt}`, `/api/prompt` `{prompt}` →
    `{text,reason}`, `/api/health` → `{ok:true,...}`. Проверка — typecheck:

```bash
cd ~/dsh-balbes-server && pnpm -r --if-present run typecheck   # exit 0
```

## Устранение неполадок

### Сервис не стартует или падает

Установщик при неудачном health-чеке печатает предупреждение
`health check failed`; первый шаг диагностики — статус и логи юнита:

```bash
systemctl status dsh-balbes
sudo journalctl -u dsh-balbes -n 50
```

Типичные причины: порт занят (см. ниже), `dsh` не найден по `ExecStart`
(переустановите глобально: `sudo npm i -g @deepseek-ai/dsh` и повторите
установщик), неверный `DSH_HOME` (юнит пишется со значениями на момент
установки — при другом `DSH_HOME` повторите установку с
`export DSH_HOME=...` перед запуском). После ручной правки юнита —
`sudo systemctl daemon-reload && sudo systemctl restart dsh-balbes`.

### Health не отвечает

Сервис активен, но `POST /api/health` не даёт `{"ok":true,...}` — проверьте,
что слушатель на месте и отвечает:

```bash
sudo ss -ltnp | grep 8080        # ожидается: LISTEN на 0.0.0.0:8080 процессом dsh
curl -fsS -X POST http://127.0.0.1:8080/api/health
```

Если `ss` пуст — юнит не поднялся (см. предыдущий пункт). Если порт слушает
другой процесс — см. следующий пункт.

### Порт занят

В логах — `EADDRINUSE`, юнит падает в цикле рестарта. Порт задаётся
переменной `BALBES_PORT` **на момент установки** и фиксируется в юните.
Освободите порт или переустановите на другой:

```bash
export BALBES_PORT=8081
curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash
sudo ufw allow 8081/tcp
# админка: http://<IP>:8081; health: POST http://127.0.0.1:8081/api/health
```

### Битый или удалённый `admin-auth.json`

Файл `$DSH_HOME/admin-auth.json` — не валидный JSON, отсутствует или имеет
неверную форму (например, вручную отредактирован без `jwtSecret`). При старте
в логах юнита — предупреждение `balbes-auth: admin auth file ... unusable
(missing, unreadable, or invalid shape); auth unavailable until the file is
valid`; защищённые маршруты (`/api/prompt`, `/api/auth/me`) отвечают 401, вход
по паролю — 401 (сервер «закрывается», но не падает: каждая попытка входа
перечитывает файл и пишет в лог причину).

Восстановление — пересоздать файл установщиком (он сгенерирует новый логин и
пароль и напечатает их один раз):

```bash
curl -fsSL https://raw.githubusercontent.com/mdikarev/dsh-balbes-server/main/scripts/install.sh | bash
```

Свежие логин/пароль — в логе (блок «Admin credentials generated»). Старые
логин/пароль при этом перестают работать (файл целиком пересоздан, `jwtSecret`
новый — и старые JWT тоже недействительны). Файл перечитывается на каждом
входе, поэтому после восстановления отдельный рестарт не обязателен —
установщик всё равно перезапускает сервис (шаг 11).

### Нет ключа модели

Кнопка/curl `/api/prompt` отвечают ошибкой (HTTP 502, `reason.kind="error"`,
или ошибка провайдера в админке) — сервер не может сходить в DeepSeek.
Ключ лежит в `$DSH_HOME/.credentials.yaml` (секция `refs`, имя
`DEEPSEEK_API_KEY`, права `600`) — порядок действий как в Этапе 1 (раздел
«Ключ не принят»). После правки перезапустите сервис:

```bash
sudo systemctl restart dsh-balbes
curl -fsS -X POST http://127.0.0.1:8080/api/prompt -H "authorization: Bearer $TOKEN" -d '{"prompt":"Напиши ok"}'
```

### 401 на защищённых маршрутах

`POST /api/prompt` и `POST /api/auth/me` без валидного JWT обязаны отвечать
401 — это нормальная работа защиты (проверка DoD, п. 5). Если 401 приходит с
валидными кредами на логине — проверьте значения из лога и не упёрлись ли вы
в rate-limit (5 неудач / 30 мин с IP → 429). Если токен перестал подходить
после перезапуска/сброса — просто войдите заново (JWT живёт до 24 ч).

## Где лежат данные

Все данные сервера находятся в каталоге `$DSH_HOME` (по умолчанию `~/.dsh`):

- `profiles/balbes/` — профиль: манифест (`package.json` с
  `dsh.profile.bundles`) и `node_modules/` — копии собранных пакетов,
  которыми пользуется демон: `dsh-balbes-host/` (host-бандл),
  `dsh-balbes-workspaces/` (плагин воркспейсов),
  `dsh-balbes-models/` (плагин моделей) и
  `dsh-balbes-telegram/` (плагин Telegram);
- `profiles/node_modules/` — зеркало-симлинки на установку dsh
  (`@deepseek-ai/*`), откуда резолвятся базовые бандлы;
- `admin-auth.json` — учётка администратора: логин, scrypt-хэш пароля,
  `jwtSecret`, `createdAt` (права `600`);
- `.credentials.yaml` — ключи API, включая `DEEPSEEK_API_KEY` (права `600`);
- `agent/` — зарезервированный домашний каталог агента (создаётся
  автоматически при первом обращении к API воркспейсов); при первом старте
  сервер кладёт в него стартовые файлы `AGENTS.md`, `self.md` и каталог
  `skills/` с `README.md` (только если их нет — правки владельца не
  перезаписываются);
- `projects/` — каталог проектов-воркспейсов: один подкаталог на проект,
  создаётся и удаляется только через API воркспейсов;
- `projects.json` — реестр воркспейсов (права `600`): метаданные строк
  (`createdAt` по имени проекта), не источник истины — строки, чей каталог
  удалён вручную, вычищаются при `list`;
- `telegram-state.json` — состояние Telegram-канала (права `600`, пишется
  атомарно): offset long polling, выбранный в чате воркспейс и id сессий
  агента по воркспейсам. Токен бота здесь **не хранится** — он лежит в
  `.credentials.yaml`. Повреждённый файл не сбрасывается молча: сервер
  поднимается с пустым состоянием и пишет предупреждение в лог юнита, файл
  остаётся как был до первой успешной записи;
- `balbes/ui/` — собранный SPA админки, который раздаёт сервер;
- `settings.yaml` — настройки dsh, включая секцию `balbes-telegram`
  (`enabled`, `allowedUserId`), которой управляет страница «Telegram», и
  сессии агента.

Всё это — секреты и локальное состояние: они не коммитятся в репозиторий и
больше нигде не хранятся. Профиль воспроизводим из репозитория, но
`admin-auth.json` и `.credentials.yaml` при удалении `$DSH_HOME` теряются
безвозвратно: после переустановки сгенерируются новый логин/пароль, а ключ
придётся ввести заново.
