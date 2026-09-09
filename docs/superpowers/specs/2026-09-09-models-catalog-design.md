# Дизайн: каталог моделей из движка (Модели v3)

- Дата: 2026-09-09
- Статус: черновик на ревью (поверх спеки v1/v2)
- Порядок по canon: спека → canon-write → go-ahead → реализация (TDD, REAL) → canon-audit

## 1. Цель и границы

Списки моделей берутся из рантайм-каталога движка, а не хардкодятся/вводятся
вручную: DeepSeek официальный — каталог dsh-llm-deepseek (сейчас 3 модели:
deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp), пресеты —
builtin-каталог pi-ai по allowlist провайдеров. UI выбирает модели из каталога
(с поиском), ручной ввод остаётся fallback'ом и для «Своего URL» (custom —
каталога нет).

**Вне границ**: редактор каталога/моделей провайдера в UI; кэш/refresh
каталога по расписанию; разбиение гигантских каталогов (openrouter 333) —
поиск на клиенте; проверка «живости» конкретной модели запросом.

## 2. Решения (подтверждены владельцем)

1. Авто из каталога движка + fallback (вариант A).
2. Сервер читает каталог в рантайме (require "@earendil-works/pi-ai/providers/all"
   из зеркала профиля; deepseek-official — каталог pi-ai "deepseek" == каталогу
   dsh-llm-deepseek, 3 id). Провайдер вне allowlist -> каталог не отдаём.
3. Новый эндпоинт models.catalog {provider} -> {models:[{id,name?}]}; provider — routeId подключения ("deepseek-official" или id пресета).
4. У подключения хранятся выбранные модели (chosen) — как раньше; каталог
   служит источником выбора и показывает актуальный список у deepseek-official.
5. fallback: если рантайм-каталог недоступен — pinned DEEPSEEK_OFFICIAL_MODELS
   (обновляется до 3 id) и ручной ввод.

## 3. Домен/API (дельта)

- models.catalog: request {provider:string}; response {provider, models:
  [{id, name?}]} для allowlist-провайдеров (deepseek + 11 пресетов);
  custom/'Свой URL' -> 400 invalid-provider (каталога нет); неизвестный -> 400.
  R-API-1 POST bearer.
- deepseek-official в models.list: models = каталог движка (3) через тот же
  каталог-ридер, fallback pinned.
- Контракты: ModelsCatalogRequest/Response, ModelOption {id, name?}.

## 4. UI (дельта)

- В форме пресета/DeepSeek: поле «модели» заменяется пикером из models.catalog
  (список с фильтром-поиском по id, добавление чипами, минимум одна); при
  недоступности каталога — прежний ручной ввод (чипы). «Свой URL» — ручной
  ввод как раньше.
- Карточка DeepSeek: модели = каталог (3).

## 5. Тесты

- Unit: каталог-ридер (мок require/путь): allowlist, deepseek 3 id, ошибки;
  ручка catalog (fake services + fake reader); fallback pinned.
- REAL: models.catalog {provider:"deepseek-official"} -> 3 id (flash/pro/vision-exp);
  {provider:"openai"} -> непустой список; {provider:"custom-url-имя"} -> 400.
  deepseek официальный models.list содержит vision-exp.
- SPA: пикер (выбор из каталога, поиск, чипы, fallback manual).

## 6. Canon

- canon-write v3: API_CONTRACTS (models.catalog; источники моделей), ADMIN_UI
  (пикер), при необходимости OVERVIEW/GLOSSARY.
