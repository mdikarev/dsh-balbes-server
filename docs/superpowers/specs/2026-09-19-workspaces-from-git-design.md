# Создание воркспейсов из GitHub — дизайн

- Status: draft design (на ревью владельца)
- Date: 2026-09-19
- Базируется на: `docs/canon/future_plans/p7-workspaces-from-git.md`, `docs/canon/future_plans/p0-agent-workspaces.md`

## Цель

Дать владельцу заводить проект-воркспейс не только как пустой каталог, но и из
существующего git-репозитория (первый провайдер — GitHub). Результат —
обычный проект `$DSH_HOME/projects/<имя>/` с записью в `projects.json`,
такой же управляемый владельцем воркспейс, как созданный «с нуля»: правила и
файлы внутри, доступные для ручного редактирования. Приватные репозитории
поддерживаются одним GitHub-токеном, который хранится на сервере и никогда не
попадает в воркспейс, логи или ответы API.

## Решения и границы

Согласовано с владельцем:

| Вопрос | Решение |
|---|---|
| Объём первой версии | Публичные + приватные GitHub-репозитории, ветка по умолчанию |
| Приватные репы | Один PAT (classic или fine-grained `Contents: Read-only`), хранится в `$DSH_HOME/.credentials.yaml` |
| Управление токеном | Отдельная секция «Git-доступ» на странице «Проекты»; ref `BALBES_GITHUB_TOKEN` |
| Имя проекта | Выводится из URL и редактируется в форме; коллизия → 409, без перезаписи |
| Связь с источником | В `projects.json` пишется необязательный `source: {provider, url, branch, ref}` |
| Глубина клона | Полный обычный клон (вся история) |
| Размещение кода | Отдельный плагин `dsh-balbes-git` (сервис `balbesGit`) + ручка создания в `dsh-balbes-workspaces` |

Зафиксированные границы:

- Принимается только `https://github.com/<owner>/<repo>` — без userinfo,
  query и fragment. Другие хосты и `http` отклоняются: это защита от SSRF и от
  отправки сохранённого токена на чужой хост.
- Только ветка по умолчанию. Выбор ветки/тега/коммита, подкаталог monorepo —
  follow-up.
- Submodules не инициализируются, Git LFS не подтягивается (остаются
  указатели). Поведение документируется, отдельного предупреждения в UI нет.
- Синхронизация после создания (pull/fetch/upstream), коммиты/push/PR и работа
  агента с историей git не входят — остаются отдельными направлениями p7.
- Операция синхронна в рамках HTTP-запроса (клон до 120 c). Прогресс-статус,
  переживающий рестарт, и фоновая очередь задач не входят.
- Хостинги кроме GitHub не входят: расширение возможно через ту же модель
  (git-URL + креденшелы) без отдельного понятия «хостинг».

## Архитектура

### 1. Новый плагин `packages/plugins/dsh-balbes-git`

Function-plugin (named exports, без default export), как остальные плагины
набора:

- `name = "balbes-git"`;
- `inject = ["balbesHttp", "credentials"]`;
- `Config = z.object({ dshHome: z.string().optional(), gitTimeoutMs: z.number().optional() })`.

Плагин резолвит `dshHome` так же, как `dsh-balbes-workspaces` (config →
`process.env.DSH_HOME` → `$HOME/.dsh`), отдаёт сервис `balbesGit` и
регистрирует ручки `/api/git/*`. Доменное ядро — `src/git.ts`
(разбор/валидация URL, запуск `git`, санитизация ошибок), `src/credentials.ts`
(ref и структурный срез сервиса `credentials`), `src/service.ts` (фасад
`balbesGit`), `src/index.ts` (ручки).

### 2. Сервис `balbesGit`

```ts
interface GithubSource {
  provider: "github";
  host: "github.com";
  owner: string;
  repo: string;
  url: string; // чистый https-URL без токена
}
interface BalbesGitService {
  status(): Promise<{ tokenConfigured: boolean }>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  inspect(url: string): GithubSource;          // синхронная чистая валидация
  clone(source: GithubSource, destDir: string, opts?: { timeoutMs?: number }):
    Promise<{ branch: string; ref: string }>;
}
```

`inspect` валидирует URL (схема `https`, хост ровно `github.com`, путь
`/<owner>/<repo>` с необязательным `.git`, отсутствие userinfo/query/fragment,
slug-имена без `..` и control-символов) и возвращает чистый источник.

`clone` сам достаёт токен из `credentials` (если задан), выполняет клон в
несуществующий/пустой `destDir`, затем `git symbolic-ref --short HEAD` и
`git rev-parse HEAD`. Клоны сериализуются в процессе (concurrency 1), чтобы
несколько одновременных клонов не конкурировали за диск и сеть; таймаут по
умолчанию 120 000 мс.

### 3. Поток `create-from-git` в `dsh-balbes-workspaces`

`inject` остаётся `["balbesHttp"]`; сервис читается строгим
`ctx.get("balbesGit")` в момент запроса (опциональная зависимость, поэтому
существующие фикстуры и тесты воркспейсов без git-плагина не ломаются). Если
сервиса нет — `503 git-unavailable`.

Порядок шагов:

1. `git = ctx.get("balbesGit")`; нет → `git-unavailable`.
2. `source = git.inspect(url)` → иначе `400 invalid-url`.
3. `validateProjectName(name)` → иначе `400 invalid-name`.
4. Быстрая проверка коллизии: `stat(<target>)` существует → `409
   name-exists`. Контеймент пути — как у `createProject`.
5. Temp-каталог `<projects>/.balbes-clone-<uuid>` (dot-имя, сканером не
   виден; от него `toChangeEvent` возвращает `null`).
6. `git.clone(source, temp)` — ошибки транслируются в коды (см. таблицу).
7. `rename(temp, <target>)` — имя резервируется в самом конце, поэтому
   каталог проекта не виден в списке, пока идёт клон. Если имя заняли за время
   клона, `rename` падает `EEXIST/ENOTEMPTY` → `409 name-exists` (клоны
   сериализованы, поэтому это редкая гонка, а не постоянный сценарий).
8. Идемпотентный `<target>/.dsh/skills/README` (`wx`, существующий файл из
   репозитория не трогается).
9. Строка реестра с `createdAt: now` и `source`.
10. Возврат `{project}`.

При любой ошибке: `rm(temp, {recursive,force})`; реестр не пишется, целевой
каталог не создаётся. Stale-temp `.balbes-clone-*` вычищаются при старте
плагина (на старте живых клонов быть не может). Жёсткий крах во время клона
оставляет только скрытый temp, который убирается на следующем старте; ни
видимого проекта, ни записи в реестре не появляется. UI обновляет список по
ответу ручки; отдельная публикация в change hub не нужна (наблюдатель увидит
появление целевого каталога).

### 4. Реестр `projects.json`

Версия остаётся `1`. У строки проекта появляется необязательное поле
`source: {provider: "github", url: string, branch: string, ref: string}`.
`readRegistry` читает отсутствующее поле как раньше и отбрасывает строки
`source` с нестроковыми/неизвестными полями; `writeRegistry` не меняется.
`listWorkspaces` отдаёт `source` в ответе, когда он есть.

## API-контракты

Все запросы — POST (R-API-1), тело/ответ JSON, ошибки
`{error:{code,message}}`.

| Ручка | Запрос | Ответ | Ошибки |
|---|---|---|---|
| `/api/git/status` | `{}` | `{git:{tokenConfigured:boolean}}` | 401 |
| `/api/git/save` | `{token:string}` | `{git:{tokenConfigured:true}}` | 400 `invalid-token`, 401 |
| `/api/git/clear-token` | `{}` | `{git:{tokenConfigured:false}}` | 401 |
| `/api/workspaces/create-from-git` | `{url:string, name:string}` | `{project}` | 400 `invalid-url`, 400 `invalid-name`, 401 `auth-required`, 409 `name-exists`, 502 `clone-failed`, 503 `git-unavailable`, 504 `clone-timeout` |

Контракты в `dsh-balbes-contracts`: `GitStatusRequest/Response`,
`GitSaveRequest/Response`, `GitClearTokenRequest/Response`,
`WorkspaceGitSource`, `WorkspaceCreateFromGitRequest/Response`; у
`WorkspaceProject` добавляется необязательное `source?`.

Вывод имени проекта для префилла в UI — общая чистая функция
`suggestProjectNameFromGitUrl(url)` в `dsh-balbes-contracts` (один источник
истины; сервер лишь валидирует уже присланное имя). `balbesGit.inspect` тоже
строит `suggestedName` через неё.

Отображение ошибок клона:

- `auth-required` (401) — клон не удался, токен не задан, и `stderr` git
  указывает на аутентификацию/ненайденный репозиторий (`could not read
  Username`, `Authentication failed`, `repository not found`); текст
  подсказывает задать GitHub-токен. GitHub отдаёт 404 и для несуществующей, и
  для приватной без доступа репы, поэтому это лучшая доступная эвристика.
- прочие сбои без токена (сеть, DNS) — `clone-failed`, а не `auth-required`.
- `clone-timeout` (504) — `git` убит по таймауту.
- `clone-failed` (502) — прочие сбои; безопасный текст без токена и без
  `stderr` целиком.

## Креденшелы и безопасность

- Ref `BALBES_GITHUB_TOKEN` в `$DSH_HOME/.credentials.yaml` через
  `ctx.credentials` (`describe/set/unset/resolve`), как у моделей и Telegram.
- Токен передаётся git через окружение и
  `-c credential.helper='!f(){ echo username=x-access-token; echo "password=$BALBES_GIT_TOKEN"; }; f'`
  с `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`; в argv значения нет.
- Клонируется чистый URL, поэтому `.git/config` (remote `origin`) не
  содержит токена. Дополнительно после клона remote проверяется/переписывается
  на чистый URL.
- `stderr` и текст ошибок санитизируются: значение токена вырезается перед
  логированием и возвратом; токен не появляется в ответах никогда (только
  `tokenConfigured`).
- В приложении-логах git-процесс запускается с ограниченным набором env; токен
  не наследуется другими процессами плагина.

## UI (`packages/frontend/dsh-balbes-admin`)

- `api/client.ts`: `gitStatus()`, `gitSave(token)`, `gitClearToken()`,
  `createWorkspaceFromGit({url,name})`.
- Страница «Проекты», левая панель: компактная секция **«Git-доступ»** со
  статусом («токен задан» / «не задан») и кнопками «Задать/Заменить токен» и
  «Забыть токен» (ввод в `Modal`, тип поля — password).
- Модалка создания: переключатель **«Пустой проект» / «Из GitHub»**.
  - «Пустой проект» — текущее поле имени.
  - «Из GitHub» — поле URL и поле имени (выводится из URL, редактируется),
    подсказка про приватные репы и статус токена, индикатор «Клонирование…»,
    inline-ошибка. На `409 name-exists` владелец меняет имя.
- После успеха список обновляется, новый проект выбирается.

## Тестирование

- Юнит (`dsh-balbes-git`): разбор/валидация URL (чужие хосты, `http`,
  userinfo/query/fragment, битые slug), вывод имени, редакция токена в
  сообщениях об ошибке, `status/save/clear` на фейковых credentials, ручки
  `/api/git/*` на фейковом http-seat.
- Реальный git без сети: локальный bare-репозиторий, клон через `runGit` по
  `file://`, проверка файлов, чистого remote и отсутствия токена.
- Юнит (`dsh-balbes-workspaces`): `create-from-git` с фейковым `balbesGit` —
  коллизия `name-exists`, уборка temp/target при сбое, запись `source` в
  реестр, `503 git-unavailable`.
- REAL-композиция: boot тест-профиля с `dsh-balbes-git`; `/api/git/*`;
  `create-from-git` со стабом `git` в PATH (фейковый клон) — проект, реестр,
  коллизия, уборка при сбое, отсутствие токена в ответах/на диске. Плюс
  `503 git-unavailable` для профиля только с воркспейсами.
- Прогон: `pnpm typecheck`, `pnpm lint`, `pnpm test`, сборка.

## Canon и операционное сопровождение

`canon-write` (в том же изменении, что код):

- `ARCHITECTURE.md` — блок `dsh-balbes-git`, место git-операции, хранение
  git-креденшелов, связь с песочницей/approval (серверный доверенный код, но
  контеймент токена).
- `GLOSSARY.md` — «создание воркспейса из репозитория», «git-источник»,
  «git-креденшелы».
- `API_CONTRACTS.md` — четыре ручки и `WorkspaceProject.source`.
- `ADMIN_UI.md` — секция «Git-доступ» и режим «Из GitHub» в модалке.
- `OVERVIEW.md` — создание из GitHub как альтернатива пустому каталогу.
- `p7-workspaces-from-git.md` → absorbed; снятие git-пункта из Out of scope
  `p0-agent-workspaces.md`; статус в `future_plans/INDEX.md`.
- `docs/runbooks/stage2-vps.md` — git в зависимостях сервера, smoke ручек
  `/api/git/*` и `create-from-git`, обновление/установка.

Композиция и доставка на VPS (в том же изменении):

- `profiles/balbes/cordis.patch.yml` — insert `balbes-git`.
- `scripts/install.sh` — `copy_git_into_profile` по образцу
  `copy_workspaces_into_profile`, вызов из основного потока, обновление
  шапки-комментария.
- `.github/workflows/ci.yml` — копирование плагина в тест-профиль и job
  тестов `dsh-balbes-git`.

## Вне scope / follow-up p7

- Выбор произвольной ветки/тега/коммита и подкаталог monorepo.
- Submodules, Git LFS.
- Синхронизация после создания, коммиты/push/PR.
- Фоновая очередь с прогресс-статусом и переживанием рестарта.
- GitLab и прочие хостинги; несколько рабочих копий; мультиарендность.
- Лимит размера репозитория сверх таймаута (отдельное решение по квотам диска).
