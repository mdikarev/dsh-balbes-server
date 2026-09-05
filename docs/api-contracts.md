# API-контракты dsh-balbes-server

Правила: **R-API-1** — все запросы к `/api/*` только POST; JSON тело/ответ;
ошибки — `{error:{code,message}}`. Типы-контракты — `dsh-balbes-contracts`
(`packages/contracts/src/index.ts`); при расхождении реестра и типов побеждают
типы (компилятор), реестр правится в том же изменении.

## Шаблон контракта

### <id> — <название>
- method: POST
- path: /api/<domain>/<action>
- auth: public | bearer
- request:  <поля, типы, обязательность>
- response: <успех: поля, типы>
- errors:   <HTTP-коды и смысл>
- notes:    <что делает, побочные эффекты, будущие изменения>
- schema:   (пока пусто; zod/JSON Schema — при росте API)

## Контракты

### health — проверка живости
- method: POST
- path: /api/health
- auth: public
- request: `{}`
- response: `{ok: true, version: string}`
- errors: — (500 при внутренней ошибке)
- notes: используется systemd/установщиком; данных не отдаёт.

### auth.login — вход владельца
- method: POST
- path: /api/auth/login
- auth: public
- request: `{login: string, password: string}`
- response: `{token: string, expiresAt: string(ISO)}`
- errors: 400 (нет полей), 401 (неверные учётные данные), 429 (лимит попыток по IP)
- notes: выдаёт JWT HS256 (24 ч); rate-limit 5 промахов / 30 мин по IP.

### auth.me — валидация токена
- method: POST
- path: /api/auth/me
- auth: bearer
- request: `{}`
- response: `{login: string}`
- errors: 401 (нет/битый/просроченный токен)
- notes: SPA решает при загрузке: логин или основная страница.

### prompt — тестовый промпт в LLM
- method: POST
- path: /api/prompt
- auth: bearer
- request: `{prompt: string (непустой)}`
- response: `{text: string, reason?: {kind: string, code?: string, message?: string}}`
- errors: 400 (нет/пустой prompt), 401, 502 (reason.kind === "error")
- notes: свежий агент на запрос (граница этапа 2), сессия персистится
  (`sessions.flush`); стриминг — следующий этап.
