# Дизайн: выбор провайдера — пресеты каталога движка (Модели v2)

- Дата: 2026-09-09
- Статус: черновик на ревью (v2 поверх спеки
  docs/superpowers/specs/2026-09-09-models-settings-design.md)
- Тип: расширение функциональности «Модели» (раздел v1 реализован и смержен)
- Порядок по canon: спека → canon-write → go-ahead → реализация (TDD, REAL) →
  canon-audit

## 1. Цель и границы

В разделе «Модели» появляется **выбор провайдера из каталога движка dsh
(pi-ai)**: у таких провайдеров официальный URL и протокол уже известны —
подключение создаётся выбором провайдера + вставкой ключа (+ списком id
моделей, которые вводит владелец), без указания кастомного URL. Кастомный URL
(«Свой URL») и закреплённый DeepSeek официальный остаются как в v1.

**Вне границ**: авто-fetch моделей с /v1/models; несколько официальных
подключений к одному провайдеру (только через «Свой URL»); управление
reasoningEffort; изменения каталога движка (каталог — версия движка).

## 2. Решения (подтверждены владельцем в брейншторме)

1. Источник пресетов — **встроенный каталог pi-ai движка** (39 провайдеров в
   dsh 0.1.2-rc.1): подключение создаётся роутом по каталоговому id.
2. Набор в UI: **OpenAI, Anthropic, OpenRouter, Groq, Google, Mistral, xAI,
   Together, Cerebras, Fireworks, OpenCode** + пункт «Свой URL» (custom).
   DeepSeek официальный — отдельная закреплённая карточка (kind deepseek).
3. Модели пресета — **ввод вручную** (>=1 id), как у «Своего URL».
4. Роут пресета: id == каталоговый id провайдера; в settings-конфиг пишем
   только {displayName?, apiKeyEnv, models:[{id}]}; официальные baseURL/протокол
   движок подставляет из каталога. Опциональный baseURL = override «свой URL».
   Один официальный роут на провайдера (коллизия имени = 409 route-exists).
5. Список selectable пресетов — отображаемые данные (id + русские названия) в
   dsh-balbes-contracts; сервер валидирует providerId по нему: 400
   invalid-provider до движка.
6. REAL-проверка: каждый allowlisted id присутствует в runtime-каталоге
   (защита от дрейфа при апгрейде движка).

## 3. Модель и домен (дельта к v1)

- connection.kind: "deepseek" | **"preset"** | "custom".
- Пресет: {routeId(==providerId), kind:"preset", providerId, displayName,
  baseURL?, hasKey, models: string[], isDefault}.
- Роут в llm-pi-ai для пресета: {displayName?, apiKeyEnv, models:[{id}]},
  + baseURL только при override. api НЕ указываем (каталог даёт протокол).
- Ключ-реф: refNameForRoute(routeId) в .credentials.yaml (как v1).
- Пресет-allowlist (display-данные): map providerId -> RU label.

## 4. API (дельта к v1, R-API-1, POST, bearer)

- models.save {kind:"preset", provider: <catalogId>, displayName?, baseURL?,
  key?, models[]} -> {connection}; ошибки как v1 + 400 invalid-provider
  (provider вне allowlist); 409 route-exists при занятом routeId (в т.ч. уже
  существующий роут с тем же id).
- models.list: пресеты с kind:"preset" и providerId; deepseek/custom без
  изменений.
- models.delete/default: без изменений (пресет удаляется как обычный роут;
  default-in-use/reserved семантика прежняя).

## 5. UI (дельта к v1)

- Модалка «+ Добавить»: селект «Провайдер»: пресеты (русские названия) +
  «Свой URL». Выбор пресета показывает: ключ, модели (>=1), инфо «официальный
  URL (по умолчанию)» с переключателем «свой URL» -> поле baseURL.
  DeepSeek официальный — по-прежнему отдельная карточка с «Изменить ключ».
- Карточки пресетов: название провайдера, «официальный URL» / baseURL при
  override, ключ-статус, чипы моделей, ⋮ Изменить/Удалить.
- Дефолт-модель: как v1 (группы по подключениям; у пресета — введённые id).

## 6. Ошибки/безопасность/тесты (дельта)

- Секреты не возвращаются (v1 паттерн). Ошибки {error:{code,message}}; коды
  стабильны.
- Unit: валидация allowlist/providerId, сборка конфига роута пресета
  (без api/baseURL), маппинг list.
- REAL: save пресета (openai, фейк-ключ, модель) -> 200 + роут в settings.yaml
  + ref в .credentials.yaml; повторный save того же id -> 409 route-exists;
  invalid provider -> 400 invalid-provider; assertion allowlist ⊆ runtime
  каталога (ctx.llm.listProviders).

## 7. Canon и синхронные правки

- canon-write: API_CONTRACTS/ADMIN_UI/OVERVIEW/GLOSSARY (выполняется в
  начале цикла, коммит docs(canon)).
- Реализация — те же пакеты: contracts (allowlist+типы), плагин dsh-balbes-models,
  SPA ModelsPage, REAL-тесты; установщик/CI не меняются (пакет тот же).
- Завершение: canon-audit по теме «модели/провайдеры».
