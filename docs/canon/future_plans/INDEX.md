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
| 5 | Рендер файлов по типу: Markdown и подсветка кода | absorbed | p4-render-file-types.md |
| 6 | Сессии воркспейса из Telegram: новые и возврат к старым | absorbed | p5-telegram-sessions.md |
| 7 | Создание воркспейсов из GitHub | absorbed | p7-workspaces-from-git.md |
| 8 | Обновление движка dsh до актуальной версии | absorbed | p8-engine-upgrade.md |
| 9 | Апрувы из Telegram: канал запрашивает, владелец даёт | draft | p9-telegram-approvals.md |
| 10 | Система памяти Балбеса | draft | p10-memory-system.md |
| 11 | Потоковая доставка ответа модели (streaming) | draft | p11-answer-streaming.md |
| 12 | Наблюдаемость сервера: метрики, версия и диагностика | draft | p12-observability.md |

Базовый слой (воркспейсы) реализован; витрина сессий воркспейса (p1), просмотр
сессий в админке (p2) и просмотр файлов в админке (p3) реализованы и
абсорбированы, а создание сессии из админки и чат владельцем не планируются.
Отложенное расширение просмотра файлов (p3) — рендер по типу: markdown-превью и
подсветка синтаксиса — инициатива p4 абсорбирована в живые секции canon.
Управление сессиями
воркспейса из Telegram (создание новых и возврат к старым) — инициатива p5
абсорбирована в живые секции canon;
инициатива p6 (несколько ботов: разные владельцы и доступ) снята решением
владельца и в реестре не значится;
создание проекта-воркспейса из git-репозитория (GitHub первым, прочие хостинги —
расширение) — инициатива p7 абсорбирована в живые секции canon.
Поверх базового слоя строятся каналы, память и самообучение — они оформляются
отдельными инициативами. Наполнение дома по глобальному контексту (правила
`agent/AGENTS.md`, `agent/self.md`, `agent/skills/`, `<project>/.dsh/skills`)
абсорбировано в живые секции canon; вне глобального контекста остаются
`notes/` и память. Подъём самого движка dsh до актуальной версии (единый пин
`scripts/engine-version.txt`; `install.sh` сам поднимает движок до пина) —
инициатива p8 абсорбирована в живые секции canon: пин `0.1.7-rc.1`, обновление
прошло и работает (CI и сервер).
Интерактивное подтверждение гейтованных операций из Telegram (канал запрашивает
approval у владельца, владелец даёт одноразовое решение) — черновик p9.
Долговременная память агента (уровни знания, источники записи, retrieval,
жизненный цикл, контроль владельца; canon-названное направление — Qdrant) —
черновик p10; самообучение остаётся отдельной инициативой.
Потоковая доставка ответа модели (живой текст ответа в админке и, в допустимой
мере, в Telegram; карточка прогресса остаётся индикатором хода, а не streaming) —
черновик p11.
Наблюдаемость сервера (детальный health, метрики задач и каналов, видимое
расхождение версии движка с пином, политика логов и диагностика) — черновик p12.
