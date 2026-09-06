# Architecture

## Summary

Один процесс dsh (модель B1): ядро и плагины-каналы живут в одном
Cordis-процессе; оркестрации нескольких процессов нет. Всё своё реализуется
механизмами dsh — профилем (`dsh.profile.bundles`), слоем патчей
(`cordis.patch.yml`) и собственными пакетами; установленные `@deepseek-ai/*`
не редактируются и ядро не обходится. Текущее состояние — Этап 1 выполнен
(разворачиваемое ядро), Этап 2 выполнен: профиль `balbes` = `dsh-base` +
собственный host-бандл `dsh-balbes-host` вместо headless; сервер-демон
под systemd с HTTP-админкой (JWT-авторизация, SPA «одна кнопка»). Штатная
веб-морда dsh не используется.

## System context

Внешние акторы и системы:

- VPS с Ubuntu (целевая — свежая LTS): хост, на котором живёт профиль `balbes`
  и данные dsh в `$DSH_HOME` (по умолчанию `~/.dsh`).
- Браузер владельца: открывает админку по `http://<IP>:${BALBES_PORT}`, ходит
  в `/api/*` с JWT (единственный origin: host раздаёт и SPA, и API).
- npm registry: источник глобального пакета `@deepseek-ai/dsh` и devDeps
  наших пакетов (registry-версии самих `@deepseek-ai/dsh-*` не используются).
- GitHub (`mdikarev/dsh-balbes-server`, ветка `main`): источник профиля и
  скриптов; `raw.githubusercontent.com` отдаёт install.sh для `curl | bash`;
  GitHub Actions — CI.
- API DeepSeek: модель для промптов; ключ приходит из
  `$DSH_HOME/.credentials.yaml` (env `DEEPSEEK_API_KEY`).
- dsh как установленный движок: его mirror (`$DSH_HOME/profiles/node_modules`)
  резолвит базовые бандлы; наш host копируется в `node_modules` профиля.

## Building blocks

- `profiles/balbes/` — профиль-манифест: `package.json` с
  `dsh.profile.bundles = ["@deepseek-ai/dsh-base", "dsh-balbes-host"]` и
  `patchReload: startup`; `cordis.patch.yml` = `[]`. В репозитории профиль
  живёт без `node_modules`.
- `@deepseek-ai/dsh-base` — бандл ядра: полный стандартный агентский набор
  (агентский цикл, тулы bash/fs/web/workflow/subagent/skill, скиллы, сессии,
  credentials, политики).
- `packages/bundles/dsh-balbes-host/` — собственный Cordis-бандл: патч-слой
  (`cordis.patch.yml`: persona, PTC-режим тулов, `code-runtime`, вставки
  плагинов) + плагины по экспортным подпутям: `startup` (app-слой CLI; без
  внешних зависимостей), `server` (HTTP на `node:http`, сервис `balbesHttp`:
  POST-роутинг `/api/*` с публичными/bearer-местами, лимит тела 1 МиБ, dispose
  по сигналу), `auth` (сервис `balbesAuth`: scrypt-проверка, JWT HS256
  issue/verify с чтением актуального секрета из файла на каждый вызов,
  rate-limit входа 5/30 мин по IP), `static` (раздача SPA с fallback
  `index.html` только на ENOENT-семейство), `api` (`/api/health`,
  `/api/prompt`; runner повторяет шов headless: `agents.create` →
  `followup` → `whenIdle` → `sessions.flush` → `AgentHandle.dispose` в finally).
- `packages/contracts/` — `dsh-balbes-contracts`: чистые TS-типы
  запросов/ответов API (импортируются SPA-клиентом; host держит структурные
  формы, соответствие проверяется REAL-тестами и typecheck).
- `packages/frontend/dsh-balbes-admin/` — React SPA (Vite): типизированный
  api-клиент (JWT в localStorage, 401 → logout), экраны Login/Main.
- `scripts/install.sh` — одно-командный установщик (`curl | bash`):
  `set -euo pipefail`, идемпотентен; окружение (Node ≥ 22 / pnpm / git /
  глобальный dsh), сборка workspace (`pnpm install` → `node scripts/link-core`
  → сборка пакетов), синк профиля + копия собранного host в его `node_modules`
  (реальный каталог — резолв `@deepseek-ai/*` подъёмом к mirror), развёртывание
  SPA в `$DSH_HOME/balbes/ui`, ключ DeepSeek в `.credentials.yaml` (600),
  генерация/печать учётных данных админки один раз (`scripts/admin-creds.mjs`),
  systemd-юнит `dsh-balbes` (enable + restart), health-проверка с ретраями
  (~120 c), флаг `--reset-admin-password` (ротация пароля и `jwtSecret`).
- `scripts/admin-creds.mjs` — генерация/сброс учётных данных админки через
  собранный `dsh-balbes-host/lib/core.js` (криптография в Node, не в bash).
- `scripts/link-core.mjs` — линковка зеркала `@deepseek-ai/*` в корневой
  `node_modules` для сборки/typecheck (следует симлинкам; nested и hoisted
  раскладки npm).
- `.github/workflows/ci.yml` — CI без LLM: Node 22, corepack pnpm, глобальный
  dsh, `pnpm install` → `link-core` → сборка → typecheck → unit-тесты →
  синк профиля + копия host → `--dump-config` → проверка отсутствия
  headless/web-app → `bash -n` → JSON-валидация манифеста.
- `docs/runbooks/stage1-vps.md`, `docs/runbooks/stage2-vps.md` —
  эксплуатационные runbook'и (установка, smoke, обновление, DoD, неполадки).

## Key flows

- Установка одной командой: `curl -fsSL <raw install.sh> | bash` → окружение →
  глобальный dsh → клон репо → сборка workspace (install → link-core → build)
  → синк профиля → копия host → SPA в `$DSH_HOME/balbes/ui` → ключ
  (env или /dev/tty) → композиция (`--dump-config`) → генерация/печать
  учётных данных админки (один раз) → systemd enable+restart → health
  (ретраи) → сводка. Повторный запуск = обновление (сервис перезапускается,
  креды не меняются).
- Вход и промпт: браузер `POST /api/auth/login` {login,password} → JWT →
  SPA хранит токен в localStorage и шлёт `Authorization: Bearer`;
  `POST /api/prompt` → сервер через реестр ядра создаёт свежего агента
  (`agents.create`), отправляет промпт (`followup`), ждёт `whenIdle`, делает
  `sessions.flush` (сессия персистится — задел на чат), в `finally`
  `AgentHandle.dispose()` (агент не копится в долгоживущем процессе); ответ —
  финальный текст ассистента.
- Сброс пароля: `scripts/install.sh --reset-admin-password` → новый пароль и
  НОВЫЙ `jwtSecret` записываются атомарно (600); guard читает секрет на каждый
  вызов — выданные токены становятся недействительными сразу, владелец входит
  заново.
- CI: на push/PR валидирует сборку, типы, тесты и композицию профиля без
  ключей и LLM; REAL-тесты (LLM как HTTP-stub, `RUN_REAL=1`) гоняются локально.

## Boundaries & non-responsibilities

- dsh — зависимость, не форк: установленные `@deepseek-ai/*` не редактируются;
  надстройка общается с ядром только через штатные швы (сервисы/события,
  патчи Loader). `dsh-web-app`/`dsh-client-ui-*` и headless в профиль не
  входят (headless — исторический smoke-инструмент этапа 1).
- `@deepseek-ai/*` не тянутся из registry (версии битые): резолв — зеркало
  установленного dsh (линковка в корневой workspace через `link-core` и копия
  host в `node_modules` профиля); pnpm link/абсолютные пути не используются.
- Не входит (следующие этапы): список сессий и чат с удержанием `sessionId`,
  ключи/runs/скиллы в UI, HTTPS/TLS и домен, потоковая доставка (SSE/WS),
  каналы (telegram/A2A), память (Qdrant), самообучение, мультиюзерность,
  замена драйвера цикла, граф-конфиг.
- Секреты не попадают в git; CI работает без ключей; автотесты в модель не
  ходят (R-TEST-1).

## Tech & constraints

- Технологии: dsh 0.1.2-rc.1 (глобально), TypeScript (strict, ESM) — наши
  пакеты, bash (установщик), YAML (профиль/патч/CI), React+Vite (SPA),
  GitHub Actions. Без Python.
- Node ≥ 22 (dsh использует `node:sqlite`); Ubuntu + apt; sudo для системного
  Node и глобального dsh.
- Правила API: R-API-1 — все запросы к `/api/*` только POST; ошибки —
  `{error:{code,message}}`; контракты-типы в `dsh-balbes-contracts`
  (+ реестр `docs/api-contracts.md`).
- Авторизация: пароль — только scrypt-хэш (N=2^17, r=8, p=1) в
  `$DSH_HOME/admin-auth.json` (600, поля login/passwordHash/jwtSecret/
  createdAt); JWT HS256, TTL 24 ч; guard читает файл на каждый verify/issue
  (ротация `jwtSecret` действует без рестарта); rate-limit входа 5/30 мин по IP.
- HTTP без TLS (граница этапа; пароль/токен идут открыто — защита от
  случайных клиентов, TLS — следующий этап); один origin: host раздаёт API и
  SPA; статика — из `$DSH_HOME/balbes/ui` (`BALBES_UI_DIST`).
- systemd-юнит `dsh-balbes`: `Restart=on-failure`, `RestartSec=3`,
  `TimeoutStopSec=20`; hardening: `NoNewPrivileges`, `PrivateTmp`,
  `ProtectSystem=full` + `ReadWritePaths`, `RestrictSUIDSGID`,
  `ProtectKernel*` (без `ProtectHome=read-only`/`SystemCallFilter` — ломают
  тулы агента).
- Профиль в репо — источник правды; синхронизация в `$DSH_HOME/profiles/balbes`
  выполняется заменой каталога целиком, после чего в его `node_modules`
  копируется собранный host (порядок: синк → копия).
- Плагины — функциональные: именованные экспорты `name`/`inject`/`Config`/
  `apply` (Cordis вызывает `apply(ctx, config)`); регистрации — эффекты;
  комментарии/код — английские.

## Related canon

- OVERVIEW.md — цель, scope, сигналы успеха.
- GLOSSARY.md — термины (профиль, бандл, патч, host, headless и др.).
- CANON_CONTRACT.md — структура canon и шаблоны секций.
