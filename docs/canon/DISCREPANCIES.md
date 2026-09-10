# Discrepancies

## How to use

Здесь фиксируются расхождения между canon (`docs/canon/`) и кодом/доками вне
canon. Запись заводится при обнаружении расхождения; резолюция — через
`canon-audit`: либо canon правится (docs_stale), либо код приводится к canon
(code_stale), либо решение откладывается (pending). Ни одна сторона не
выбирается молча.

## Open

На данный момент открытых расхождений нет.

## Resolved

### D-001: ARCHITECTURE.md утверждал пустой cordis.patch.yml профиля (фактически — insert balbes-workspaces)
- **status:** resolved
- **decision:** docs_stale
- **canon_paths:** docs/canon/ARCHITECTURE.md, docs/canon/GLOSSARY.md
- **code_paths:** profiles/balbes/cordis.patch.yml
- **evidence:** ARCHITECTURE.md «Building blocks» (профиль-манифест): `cordis.patch.yml` = `[]` — противоречит фактическому
  profiles/balbes/cordis.patch.yml, который содержит insert `balbes-workspaces` (с коммита 844d3d3), и собственным
  утверждениям ARCHITECTURE.md / GLOSSARY.md («подключается insert-записью в патч профиля»). Canon сам себе
  противоречит, код опровергает «пустой патч».
- **finding_ids:** F-001

### D-002: Canon описывал поверхность `telegram.*` по черновику дизайна, а не по поставленной реализации
- **status:** resolved
- **decision:** docs_stale
- **canon_paths:** docs/canon/API_CONTRACTS.md, docs/canon/ARCHITECTURE.md, docs/canon/GLOSSARY.md, docs/canon/ADMIN_UI.md, docs/canon/OVERVIEW.md
- **code_paths:** packages/contracts/src/index.ts, packages/plugins/dsh-balbes-telegram/src/admin.ts, packages/plugins/dsh-balbes-telegram/src/agentTask.ts
- **evidence:** `API_CONTRACTS.md` (блоки `telegram.*`) описывал плоскую форму статуса `{enabled, configured, connected, botUsername?, allowedUserId?, lastPollAt?, error?: string}`
  и `telegram.test` как `{ok:true, botUsername}` с `409 not-configured` / `502 telegram-unavailable`, тогда как контракты (`TelegramSettingsStatus`, `TelegramTestResponse`) и ручки
  отдают `{status:{state, tokenConfigured, enabled, allowedUserId?, botUsername?, lastPollAt?, error?:{code,message}}}` и `{username}` с `400 not-configured` / `400 invalid-token` /
  `502 telegram-error`; `save` описан как обязательные `allowedUserId`/`enabled` и как вызов `getMe` с синхронным рестартом polling, хотя отсутствующее поле сохраняет прежнее значение,
  Bot API в `save` не вызывается (username обновляется фоновым `getMe`), а переход runtime сериализован и асинхронен. Дополнительно канон не отражал containment-границу канала
  (урезанная поверхность инструментов агентской задачи: только файлы воркспейса и планирование) и файл состояния `$DSH_HOME/telegram-state.json`. Сам канон объявляет типы
  `dsh-balbes-contracts` компиляторным SoT форм и требует правки реестра в том же изменении — поэтому stale-сторона здесь canon (`docs_stale`), вопрос владельцу не требовался.
- **finding_ids:** F-002

## Template for new entries

<!--
  ### D-001: <short title>
- **status:** open | resolved
- **decision:** pending | docs_stale | code_stale
- **canon_paths:** ...
- **code_paths:** ...
- **evidence:** ...
- **finding_ids:** ...
- **coding_agent_prompt:** |
  What to study; what diverges; questions to clarify with the user.
-->
