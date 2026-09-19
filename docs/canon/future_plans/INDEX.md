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
| 4 | Просмотр файлов в админке | absorbed | p3-file-view.md |
| 5 | Рендер файлов по типу: Markdown и подсветка кода | draft | p4-render-file-types.md |
| 6 | Сессии воркспейса из Telegram: новые и возврат к старым | absorbed | p5-telegram-sessions.md |
| 7 | Несколько ботов: разные владельцы и доступ | draft | p6-multi-bot-access.md |
| 8 | Создание воркспейсов из GitHub | draft | p7-workspaces-from-git.md |

Базовый слой (воркспейсы) реализован; витрина сессий воркспейса (p1), просмотр
сессий в админке (p2) и просмотр файлов в админке (p3) реализованы и
абсорбированы, а создание сессии из админки и чат владельцем не планируются.
Отложенное расширение просмотра файлов (p3) — рендер по типу: markdown-превью и
подсветка синтаксиса — оформлено черновиком p4. Управление сессиями
воркспейса из Telegram (создание новых и возврат к старым) — инициатива p5
абсорбирована в живые секции canon;
несколько ботов с разными владельцами и разграничением доступа — черновик p6;
создание проекта-воркспейса из git-репозитория (GitHub первым, прочие хостинги —
расширение) — черновик p7.
Поверх базового слоя строятся каналы, память и самообучение — они оформляются
отдельными инициативами. Наполнение дома по глобальному контексту (правила
`agent/AGENTS.md`, `agent/self.md`, `agent/skills/`, `<project>/.dsh/skills`)
абсорбировано в живые секции canon; вне глобального контекста остаются
`notes/` и память.
