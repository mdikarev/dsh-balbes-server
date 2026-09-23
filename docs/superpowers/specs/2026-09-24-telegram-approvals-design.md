# Апрувы из Telegram — дизайн

- Status: approved design
- Date: 2026-09-24
- Инициатива: `docs/canon/future_plans/p9-telegram-approvals.md`

## Цель

Telegram-канал становится интерактивным для approval: когда гейтованная операция
штатного пути инструментов (tool pipeline, sandbox-эскалация bash) при политике
`ask` уходит в waterfall `approval/request`, канал сам присылает владельцу запрос
на подтверждение, а владелец даёт **одноразовое** решение прямо в чате кнопкой.
Исход возвращается в штатном словаре dsh (`allowed-once` / `rejected` /
`cancelled` / `unavailable`) — канал не изобретает собственную семантику решения
и не трогает dsh-ядро: answerer компонуется на стандартном шве
`@deepseek-ai/dsh-user-approval`.

Сегодня у канала нет своего answerer'а, поэтому запрос резолвится `unavailable` и
задача падает fail-closed. Эта инициатива заменяет «отвечает отсутствие
отвечающего» на «отвечает владелец», сохраняя fail-closed при неответе.

## Решения и границы

- **Подход к регистрации — agent-scoped listener через `setup`.** Слушатель
  `approval/request` вешается на `agentCtx` там же, где `installModelSelection`
  вешает `agent/request`. Шов диспатчит `approval/request` тем же
  `scopeTarget(agent, agent)`, что и `agent/request`, поэтому механика уже
  доказана существующим кодом. Владение агентами автоматическое, listener живёт
  ровно столько, сколько scope агента.
- **Несколько параллельных запросов.** У каждого запроса свой короткий id, своё
  сообщение и своя pending-запись. Воркспейсы/агенты независимы; незакрытый
  запрос одного не блокирует другие.
- **Только inline-кнопки.** «✅ Разрешить один раз» / «⛔ Отклонить». Нажатие
  закрывает ровно тот запрос, к которому привязано сообщение; текстовых команд
  `/approve` нет, эвристики по тексту нет.
- **Тайм-аут — константа 5 минут.** Настраиваемости и админского тумблера нет.
- **Семантика исходов.** Нажатие «разрешить» → `allowed-once`; «отклонить» →
  `rejected`; тайм-аут (вопрос доставлен, ответа нет) → `rejected`;
  недоставка вопроса (Telegram `sendMessage` упал, владелец/токен недоступны) →
  `unavailable`; прерывание (`/stop`, abort сигнала инструмента) → `cancelled`.
- **Всегда включено,** когда включён канал. Approval — это безопасность,
  выключать нечего; настроек и правок админки/API нет.
- **Что видит владелец:** имя инструмента, `reason`, метка воркспейса и эхо
  задачи (обрезанное). Аргументов инструмента в запросе шва нет by construction,
  поэтому аргументы и секреты не показываются.
- **Живой прогресс отражает ожидание.** Пока запрос висит, карточка задачи и
  меню-карточка показывают строку «⏳ ждёт подтверждения: <tool>». `/stop`
  отзывает запрос: сообщение-запрос редактируется в «отменено», кнопки снимаются.
- **Состояние pending — только in-memory.** Durable-хранилища нет: turn не
  переживает рестарт, а запрос валиден только внутри открытого turn'а. Нажатие по
  неизвестному (после рестарта) id отвечает «Устарело» и ничего не меняет.
- **Один бот, один владелец.** Мультиботовость/группы/несколько пользователей —
  вне границ (это снятая инициатива p6).

Вне границ: изменение или обход dsh-ядра; новые виды гейтов сверх штатного
approval; постоянные/сессионные гранты («разрешить всегда»); веб-UI approval;
другие каналы; streaming.

## Архитектура

### Модуль `packages/plugins/dsh-balbes-telegram/src/approvals.ts`

Новый модуль владеет только логикой approval-запросов канала: сборкой
сообщения, реестром pending, гонкой исходов и разбором callback-кода.

```ts
interface ApprovalGateDeps {
  bot: BotClient;                         // тот же per-token indirection, что у чата
  ownerChatId(): number | undefined;      // живой allowed user ID; undefined => unavailable
  timeoutMs: number;                      // константа 5 минут (в тестах инъекция)
  workspaceLabel(ref: WorkspaceRef): string;
  taskText(ref: WorkspaceRef): string | undefined; // эхо задачи из runner.progress
  logger?: { warn(m: string): void };
  now?(): number;                         // тесты
  newId?(): string;                       // тесты (8 hex)
}

interface ApprovalGate {
  attach(agentCtx: unknown, ref: WorkspaceRef): void;
  handles(data: string): boolean;         // data.startsWith("ap:")
  onCallback(update: ClassifiedUpdate & { kind: "callback" }): Promise<string | undefined>;
  pendingFor(ref: WorkspaceRef): { toolName: string } | undefined; // при нескольких — самый свежий
  withdrawAll(): void;
}
```

Pending-запись:

```ts
interface PendingApproval {
  id: string;                 // 8 hex, входит в callback_data
  ref: WorkspaceRef;
  chatId: number;
  messageId: number | undefined;
  toolName: string;
  reason: string | undefined;
  resolve(outcome: ApprovalOutcome): void;
  dispose(): void;            // снять abort-listener и таймер
}
```

Реестр — `Map<string, PendingApproval>`. Мягкий потолок одновременных pending
(32): лишний запрос сразу `unavailable`.

### Поток запроса и ответа

1. Инструмент с гейтом `ask` вызывает `ctx.approval.request(...)`;
   сервис пишет `approval/asked` и диспатчит `approval/request` в scope агента.
2. Agent-scoped listener, повешенный в `setup`, получает `(request, next)`.
   Если канал не может спросить (нет enabled/allowlist/токена или потолок
   pending) — возвращает `next()`; в остальных случаях отвечает сам.
3. Gate строит карточку (tool, reason, workspace, эхо задачи) и шлёт владельцу
   сообщение с `reply_markup` из двух кнопок `ap:<id>:y` / `ap:<id>:n`.
4. Сбой отправки → `unavailable` (это честное «канала нет», а не «владелец
   отказал»).
5. Запись попадает в реестр; исход определяется гонкой трёх событий: нажатие
   кнопки, `request.signal.abort`, тайм-аут.
6. Callback проходит через поллер → `classify` → маршрутизатор `index.ts`.
   Код `ap:` уходит в gate ДО машины чата; иначе — в чат, как сейчас.
7. Gate проверяет `chatId` и `messageId`, первый ответ побеждает, редактирует
   сообщение-запрос в исход, снимает кнопки и отвечает на callback
   (`answerCallbackQuery`).
8. Сервис пишет `approval/decided`; инструмент едет или получает отказ.

### Callback-протокол

| `callback_data` | Действие |
| --- | --- |
| `ap:<id>:y` | разрешить один раз → `allowed-once` |
| `ap:<id>:n` | отклонить → `rejected` |

`id` — 8 hex-символов, payload ~11 байт, с большим запасом ниже лимита Telegram
(64). Индекс-снапшоты машины чата не используются: реестр pending — собственный,
ключ — сам id, а не номер строки в сообщении.

### Маппинг исходов

| Событие | Исход | Сообщение-запрос |
| --- | --- | --- |
| «Разрешить один раз» | `allowed-once` | «✅ Разрешено» |
| «Отклонить» | `rejected` | «⛔ Отклонено» |
| Тайм-аут 5 мин | `rejected` | «⌛ Истёк тайм-аут» |
| `request.signal` abort / `/stop` | `cancelled` | «⏹ Отменено» |
| Недоставка вопроса | `unavailable` | (сообщения нет) |
| Повторное/позднее нажатие | без изменений | без изменений; callback-ответ «Уже решено» |
| Нажатие по неизвестному id | без изменений | callback-ответ «Устарело» |

### Тайм-аут, отмена, выгрузка

- Listener вешает слушателя на `request.signal`: abort → сообщение правится в
  «Отменено», запись удаляется, возврат `cancelled`.
- `/stop` → `runner.cancel` → `agent.cancel({kind:"user"}, {keepInbox:true})` →
  сигнал инструмента абортится → тот же путь.
- `withdrawAll()` при выгрузке плагина/остановке канала: все pending закрываются
  `cancelled`, сообщения гасятся best-effort.
- Poller остановлен/канал выключен, пока запрос висит: callback прийти не может →
  срабатывает тайм-аут. Вечно висящих кнопок не остаётся.

### Живой прогресс

- `progressCard` получает необязательное `waitingFor?: string` и рисует строку
  `⏳ ждёт подтверждения: <tool>`; тик карточки берёт значение из
  `gate.pendingFor(ref)`.
- Та же строка добавляется в «Задача:» меню-карточки активного воркспейса.
- После закрытия запроса pending исчезает: следующий тик (≤3.5с) убирает строку,
  а квитанция её уже не показывает.

### Безопасность

- Callback'и уже отфильтрованы поллером (`isAuthorized`: allowed user ID + только
  private chat). Gate дополнительно проверяет `chatId` и `messageId` — чужое
  сообщение/чат не закроет запрос.
- Первый ответ побеждает; повторное/позднее нажатие ничего не меняет.
- Аргументов инструмента в запросе нет; `reason` и эхо задачи проходят через
  `sanitizeReply`, схлопывание переводов строк и лимит (~300 символов).
- Реестр pending — in-memory; durable-состояния и осиротевших кнопок нет.

### Сборка в `index.ts`/`agentTask.ts`

- `createAgentTaskRunner` получает в `deps` опциональный
  `approvals?: { attach(agentCtx, ref): void }`.
- В `setup` агента, рядом с `composeAgentSetup`, вызывается
  `deps.approvals?.attach(agentCtx, ref)`. `ref` протягивается в
  `acquireHandle`.
- Циклическая зависимость «gate нужен runner'у для attach, runner нужен gate для
  taskText» разрывается поздним связыванием: gate создаётся после runner, а
  runner получает тонкий делегат `{ attach: (ctx, ref) => gate?.attach(ctx, ref) }`.
- В `index.ts` маршрутизатор `onUpdate` получает ветку: callback с кодом `ap:`
  → `gate.onCallback`, иначе — как сейчас.

## Тесты

- `tests/approvals.test.ts` (новый): карточка запроса; allow/reject;
  тайм-аут → `rejected`; abort → `cancelled`; сбой `sendMessage` →
  `unavailable`; повторное/позднее нажатие; containment по chatId/messageId;
  неизвестный id → «устарело»; потолок pending; `withdrawAll`. Фейковый
  `BotClient`, инъекция тайм-аута/часов/id.
- `tests/cards.test.ts`: рендер approval-карточки и строки
  `⏳ ждёт подтверждения` в `progressCard`/`menuCard`.
- `tests/agentTask.test.ts`: `setup` вешает approval-listener (фейковый
  `agentCtx` фиксирует `on`).
- `tests/index.test.ts`: callback `ap:` уходит в gate, прочие — в чат.
- **REAL-композиция** `tests/integration.test.ts`: новый сценарий — стаб-LLM
  эмитит `bash` с `sandbox_permissions` + `justification` (детерминированно
  вызывает `ctx.approval.request` в `dsh-tool-bash`); fake Bot API получает
  сообщение с кнопками `ap:`; тест шлёт авторизованный callback и проверяет, что
  команда реально прошла, а сообщение-запрос отредактировано в исход. Плюс
  reject-ветка. Тайм-аут/abort в REAL не гоняются (5 минут не ждём) — они покрыты
  unit-тестами.

## Canon и документация

Canon-first: живые секции обновляются через `canon-write`, после существенных
правок — пауза на подтверждение до кода; закрытие — `canon-audit`.

- `ARCHITECTURE.md` — Telegram-канал: approval-answerer, путь запроса и ответа,
  тайм-аут, fail-closed при отсутствии ответа; уточнение безусловного
  «гейтованная операция без интерактивного отвечающего отклоняется» для канала.
- `GLOSSARY.md` — термины «approval-answerer канала» и «approval-запрос в
  Telegram»; уточнение статьи «Telegram-канал».
- `OVERVIEW.md` — состав Telegram-канала: запрос подтверждений у владельца.
- `API_CONTRACTS.md` / `ADMIN_UI.md` — новых ручек/настроек нет (always-on,
  константа), правки вероятно не требуются; подтвердить на `canon-audit`.
- `docs/canon/future_plans/p9-telegram-approvals.md` + `future_plans/INDEX.md` —
  статус draft → implementing, после закрытия → absorbed.

## Раскатка и проверка

- Пуш в `origin/main` — только с явного «go» владельца.
- На VPS: повторный `scripts/install.sh` (git pull --ff-only, ребилд, sync
  профиля, копирование плагина, SPA, рестарт).
- Runbook `docs/runbooks/stage2-vps.md` обновляется в том же коммите, что и
  функциональность: smoke-шаг approval — задача, вызывающая sandbox-эскалацию;
  в Telegram приходит запрос с кнопками; нажатие «Разрешить один раз» пропускает
  команду, сообщение помечается «Разрешено»; «Отклонить» даёт отказ инструменту.
- Новых HTTP/SPA-поверхностей нет, поэтому API/UI smoke не меняется.

## Риски

- **Ложное владение.** Agent-scoped listener теоретически может получить запрос
  субагента, если scopes родитель-ребёнок связаны. Это скорее желаемое поведение
  (вся задача — владельца), но проверить в реализации и покрыть тестом.
- **Двойной ответ/редактирование.** Повторный callback и поздний tick карточки не
  должны перетирать исход: первый ответ побеждает, `answerCallbackQuery` для
  повторного, сообщение-запрос после закрытия не редактируется тиком задачи
  (разные messageId).
- **Недоставка при смене токена/владельца mid-wait.** Уже доставленный запрос
  ждёт до тайм-аута; новые не доставляются → `unavailable`. Это осознанно.
