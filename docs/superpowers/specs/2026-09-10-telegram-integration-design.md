# Telegram-интеграция с воркспейсами — дизайн

- Status: approved design
- Date: 2026-09-10

## Цель

Дать единственному владельцу сервера возможность работать с агентом через
Telegram: выбирать воркспейс кнопками, ставить задачи агенту в контексте
выбранного воркспейса и просматривать дерево/текстовые файлы. Telegram должен
настраиваться из существующей JWT-админки и работать через long polling без
webhook, публичного HTTPS endpoint или отдельного systemd-процесса.

## Решения и границы

- Интеграция живёт внутри единственного dsh/Cordis-процесса как отдельный
  функциональный плагин `dsh-balbes-telegram`.
- Доступ имеет один числовой Telegram User ID, настраиваемый в админке.
- Разрешаются только update из private chat. Групповые чаты и другие User ID
  игнорируются без раскрытия состояния сервера.
- Bot token хранится через `ctx.credentials` в
  `$DSH_HOME/.credentials.yaml`; в API, логах и state-файле token не
  возвращается.
- User ID и enabled хранятся в settings. Изменение настроек запускает или
  останавливает polling без рестарта.
- Telegram использует штатный dsh agent loop. Собственный loop рассуждений,
  вызова LLM или инструментов не создаётся.
- В первом варианте поддерживаются persistent dsh-сессии, отдельные для
  каждого workspace, задачи с чтением/изменением файлов выбранного корня,
  inline-выбор workspace и lazy-навигация по дереву с просмотром ограниченных
  текстовых файлов.
- Скачивание бинарных файлов, список сессий в админке, streaming-ответы,
  группы пользователей и другие каналы не входят в MVP.

## Архитектура

### Плагин Telegram

`packages/plugins/dsh-balbes-telegram` предоставляет сервис Telegram и
регистрирует API настроек через `balbesHttp`. Плагин:

- запускает один long-polling loop на процесс;
- вызывает Bot API `getUpdates`, `getMe`, `sendMessage` и операции
  редактирования сообщений через внешний HTTPS API;
- применяет retry/backoff для временных сетевых ошибок;
- отменяет polling через `AbortController` при Cordis dispose;
- не читает `$DSH_HOME` напрямую и не вызывает собственный HTTP API по loopback;
- использует `balbesWorkspaces` и общий `AgentTaskService`.

Телефон не соединяется с сервером напрямую: Telegram-клиент общается с
облаком Telegram, а сервер — с Telegram Bot API.

### AgentTaskService

Сервис является общей границей workspace-aware задач. Он принимает ссылку
`home` или `project:<slug>` и текст задачи, затем:

1. разрешает ссылку через `balbesWorkspaces`;
2. проверяет containment по лексическому пути и realpath, не принимает
   traversal/внешние symlink;
3. создаёт или возобновляет штатную dsh session;
4. передаёт агенту `meta.cwd` корня выбранного workspace;
5. отправляет user message через `followup`;
6. ждёт `whenIdle`, делает `sessions.flush` и извлекает финальный ответ;
7. сериализует задачи одного workspace;
8. возвращает ответ каналу.

Текущий одношаговый `/api/prompt` сохраняет совместимость. Его runner может
быть постепенно переведён на общий сервис, но Telegram не должен дублировать
агентский lifecycle.

До завершения реализации обязательны containment-тесты реальных dsh tools.
Если штатный `cwd` не препятствует абсолютным путям, `..` или shell-выходу,
нужно добавить guard на соответствующем штатном seam. Простого указания
`meta.cwd` недостаточно как доказательства изоляции.

### Workspace domain

`balbesWorkspaces` расширяется внутренними функциями:

- безопасное разрешение workspace reference в корень;
- чтение одного каталога;
- чтение text-файла с лимитом байт;
- определение binary/нечитаемого файла;
- отказ для symlink при открытии и любого выхода за корень.

HTTP-ручки админки и Telegram используют эти функции, поэтому containment
правила не дублируются в каналах.

## Состояние

В отдельном атомарном state-файле `$DSH_HOME` хранятся только нечувствительные
данные:

- `activeWorkspace` для разрешённого владельца;
- mapping `workspaceRef -> dsh sessionId`;
- последний обработанный Telegram update ID/offset;
- статус незавершённой задачи, если он нужен для безопасного восстановления.

Права файла — `600`; token в него не записывается.

В памяти находятся polling handle и активные agent handles. Задачи одного
workspace выполняются последовательно. Переключение workspace не удаляет его
контекст. Кнопка «Сбросить контекст» явно завершает текущую session, а новая
задача создаёт чистый контекст.

После рестарта offset и active workspace восстанавливаются. Возобновление
сессии выполняется только через подтверждённый API установленной версии dsh
(`agents.resume` или эквивалентный штатный seam). Незавершённая задача не
повторяется автоматически без подтверждённой семантики resume; владелец
получает уведомление о прерванной задаче.

## Telegram UX

### Выбор workspace

`/start` или кнопка «Воркспейсы» показывает inline-список:

- «Дом агента»;
- проекты;
- pagination для большого списка.

После выбора бот показывает текущий workspace. Callback содержит только
короткую операцию/идентификатор; сервер при каждом callback заново проверяет
существование и доступность workspace.

### Задачи

Обычное текстовое сообщение отправляется текущей session выбранного workspace.
Бот сначала отвечает «Задача принята», затем отправляет финальный ответ. Ответы
длиннее лимита Telegram разбиваются. Markdown/HTML от агента экранируется или
отправляется plain text.

### Файлы

«Файлы» открывает корень workspace. Каталоги раскрываются лениво кнопками.
Файл открывается как plain text с ограничением размера и постраничным выводом
при превышении лимита Telegram. Binary, нечитаемые и symlink-записи
показываются как метаданные и не открываются. Произвольной загрузки файлов в
MVP нет.

### Состояния и ошибки

- нет выбранного workspace: кнопка выбора и понятная подсказка;
- workspace удалён: старый выбор сбрасывается;
- занятая session: задача ставится в bounded FIFO-очередь workspace (до 3
  ожидающих задач); при заполнении бот отказывает с безопасным уведомлением;
  активная задача не дублируется;
- ошибка агента: безопасный текст без stack trace;
- ошибка Telegram: retry для временной ошибки, остановка и статус ошибки для
  `401 Unauthorized`;
- неавторизованный update: игнорируется без деталей.

## Админка и API

В SPA добавляется раздел «Telegram» в текущем dev-tool стиле:

- token password field с маской `••••`;
- числовой Telegram User ID;
- enabled toggle;
- статусы `не настроено`, `выключено`, `подключено`, `ошибка`;
- bot username, last successful poll и безопасная последняя ошибка;
- кнопки «Проверить подключение», «Сохранить», «Отключить», «Удалить токен»;
- подтверждение удаления token.

Настройки применяются без рестарта. Новые bearer POST-контракты:

```text
POST /api/telegram/status
POST /api/telegram/save
POST /api/telegram/test
POST /api/telegram/disable
POST /api/telegram/clear-token
```

`save` принимает `token?`, `allowedUserId`, `enabled`; отсутствие token
оставляет старый. `test` вызывает `getMe`, но не включает polling и не меняет
настройки. `disable` останавливает polling, сохраняя token. `clear-token`
удаляет secret через credentials и автоматически выключает polling. Ни один
ответ не содержит token.

Включение без token или положительного User ID даёт 400. Ошибки наружу имеют
стандартную форму `{error:{code,message}}`; чувствительные детали не
возвращаются.

## Безопасность

- Авторизация update: allowlisted `from.id` и `chat.type === "private"`.
- Callback и file path никогда не считаются доверенными; они валидируются
  заново на сервере.
- Workspace containment проверяется до запуска агента и до чтения файла.
- Symlink не разыменовываются для Telegram file view.
- Token хранится только через credentials, не логируется и не попадает в
  state/API response.
- Логи не содержат текст сообщений, содержимое файлов или секреты.
- Админские Telegram API защищены существующим JWT.

## Тестирование

### Unit

- parsing Telegram updates;
- allowlist/private-chat checks;
- callback validation and pagination;
- workspace/file navigation;
- text/binary/oversized file handling;
- polling offset, timeout, retry and dispose;
- masking and secret non-disclosure;
- settings transitions disabled/enabled/cleared.

### REAL composition

Тестовый профиль загружает Telegram-плагин, fake Telegram Bot API подменяет
только внешнюю сеть, а LLM остаётся HTTP-stub. Сценарий проходит сохранение
настроек, `getMe`, `/start`, выбор workspace, задачу, ответ и file view.
Проверяются разные session IDs для двух workspace, выбранный `cwd` и shutdown.

### Containment/security

Проверяются traversal, абсолютные пути, symlink, попытка обратиться из
`project-a` в `project-b` или `$DSH_HOME`, другой user ID, group chat,
устаревший callback и отсутствие token в логах/state/response.

## Эксплуатация

Runbook `docs/runbooks/stage2-vps.md` должен описывать:

1. создание бота через BotFather;
2. получение User ID;
3. ввод token и User ID в админке;
4. `getMe`/включение polling;
5. smoke `/start`, выбор workspace, task и file view;
6. проверку отказа для group chat и другого User ID;
7. отключение и удаление token;
8. восстановление после обновления и рестарта systemd.

Наличие или отсутствие Telegram-настроек не должно влиять на запуск HTTP,
админки, моделей и workspace API.

## Критерии готовности

MVP готов, когда владелец без shell-команд может настроить Telegram в админке,
в личном чате выбрать дом или проект, отправить задачу штатному dsh agent loop,
получить результат с workspace `cwd`, переключиться на другой workspace без
потери контекста, просмотреть дерево и ограниченный text-файл, а после рестарта
продолжить работу с сохранённым состоянием. Неавторизованные пользователи и
групповые чаты не получают список workspace или содержимое файлов.

## Открытые технические проверки до реализации

- точное наличие и семантика `agents.resume` в установленной версии dsh;
- фактическое containment-поведение штатных fs/bash/code tools при `meta.cwd`;
- способ graceful cancellation активного dsh AgentHandle;
- совместимость Bot API client с зависимостями профиля без нарушения правил
  резолва `@deepseek-ai/*`.

Эти пункты являются проверками реализации, а не незаполненными продуктовыми
решениями; они не меняют согласованный scope.

## Связанные документы

- `docs/canon/OVERVIEW.md`
- `docs/canon/ARCHITECTURE.md`
- `docs/canon/API_CONTRACTS.md`
- `docs/canon/ADMIN_UI.md`
- `docs/runbooks/stage2-vps.md`
- `packages/bundles/dsh-balbes-host/src/runner.ts`
- `packages/plugins/dsh-balbes-workspaces/`

## Не входит в этот этап

- реализация кода;
- webhook;
- отдельный Telegram worker/systemd unit;
- многопользовательский доступ и роли;
- скачивание бинарных файлов;
- A2A и другие каналы;
- streaming-ответы модели;
- git, память и самообучение.

## Self-review

- Placeholder scan: незаполненных продуктовых `TBD`/`TODO` нет.
- Consistency: Telegram всегда описан как in-process plugin, long polling и
  private-chat single-user канал; token настраивается только через админку.
- Scope: документ ограничен одним Telegram-каналом и текущим single-user
  профилем; отдельные каналы и multi-user исключены.
- Ambiguities: `agents.resume`, cancellation и фактический tool containment
  выделены как проверяемые технические seams до реализации, без подмены их
  самодельным agent loop.
