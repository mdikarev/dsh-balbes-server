# Future plans

## How to use
<!-- Draft initiatives for the future shape of the system. Not behavioral SoT.
     Not development tasks, checklists, or coding_agent_prompt storage.
     After implementation, absorb outcomes into living canon sections. -->

## Status vocabulary
<!-- draft | refining | implementing | absorbed (projects may add local labels; do not turn this into a task tracker) -->

## Initiatives
<!-- Table of initiative files and statuses. Zero rows is valid. -->

| # | Initiative | Status | File |
| --- | --- | --- | --- |
| 1 | Воркспейсы на сервере: дом агента и проекты | absorbed | p0-agent-workspaces.md |
| 2 | Сессии и чат в воркспейсе | absorbed | p1-workspace-sessions-chat.md |
| 3 | Просмотр сессий в админке | absorbed | p2-session-view.md |
| 4 | Просмотр файлов в админке | implementing | p3-file-view.md |

Базовый слой (воркспейсы) реализован; витрина сессий воркспейса (p1) и просмотр
сессий в админке (p2) реализованы и абсорбированы, а создание сессии из админки
и чат владельцем не планируются. Просмотр файлов (p3) переведён в implementing:
утверждённый дизайн закрыл открытые вопросы, живые секции обновлены до кода.
Поверх базового слоя строятся каналы, память и самообучение — они оформляются
отдельными инициативами. Наполнение дома по глобальному контексту (правила
`agent/AGENTS.md`, `agent/self.md`, `agent/skills/`, `<project>/.dsh/skills`)
абсорбировано в живые секции canon; вне глобального контекста остаются
`notes/` и память.
