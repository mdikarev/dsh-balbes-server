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
