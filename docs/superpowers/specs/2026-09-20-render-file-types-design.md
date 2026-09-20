# Рендер файлов по типу в админке — дизайн

- Status: approved design
- Date: 2026-09-20
- Инициатива: `docs/canon/future_plans/p4-render-file-types.md`

## Цель

Владелец читает файл воркспейса в админке так, как он задуман: markdown — как
отрендеренный документ (с переключением на исходник), код — с подсветкой
синтаксиса. Инициатива p3 дала read-only чтение как моноширинного текста; этот
шаг добавляет отображение по типу, не покидая файловый таб и не меняя серверный
контракт чтения.

## Решения и границы

- **Целиком на клиенте.** Тип отображения определяется поверх уже прочитанного
  `WorkspaceFileResult` формы `text`. Ручка `workspaces.file`, домен
  `readWorkspaceFile` и типы `dsh-balbes-contracts` не меняются.
- **Markdown — `react-markdown` + `remark-gfm`.** GFM: таблицы, списки,
  task-list, ссылки, fenced code. Сырой HTML не рендерится (штатное поведение
  `react-markdown`), URL санитизируются встроенным `urlTransform` — скрипты и
  `javascript:`-ссылки не исполняются. `dangerouslySetInnerHTML` не
  используется.
- **Подсветка — `rehype-highlight` + `highlight.js` (common-набор).** Один
  движок для fenced code внутри markdown и для standalone-файлов. Неизвестный
  язык рендерится как plain-код (без подсветки), как и раньше.
- **Определение языка — по расширению пути.** Карта `.ts/.tsx → typescript`,
  `.js/.jsx → javascript`, `.json`, `.py`, `.go`, `.rs`, `.sh → bash`,
  `.yml/.yaml`, `.css`, `.html/.xml`, `.sql`, `.toml → ini`, `.c/.h`,
  `.cpp`, `.java`, `.cs`, `.php`, `.rb`, `.diff/.patch`,
  `Dockerfile → bash`, `Makefile → makefile` и т.п. (только языки из
  `highlight.js/common`; `dockerfile` в common нет). Для файлов без расширения — shebang
  (`#!/usr/bin/env python`, `#!/bin/bash`, …). Неизвестный тип — plain
  `<pre>`.
- **Markdown-расширения:** `.md`, `.markdown` (регистр не важен). `.mdx`
  исключён (JSX-семантика вне границ).
- **Переключатель «Просмотр / Исходник»** — только для markdown; по умолчанию
  «Просмотр». Выбор UI-локальный, не персистируется, сбрасывается при смене таба
  (файловый таб получает `key`, `mode` живёт в `FileView`).
- **Ссылки и изображения.** Ссылки — `<a target="_blank" rel="noopener
  noreferrer">`; изображения — `<img loading="lazy" referrerPolicy="no-referrer">`.
  Клик не читает файлы сервера; контеймент воркспейса не затрагивается.
- **Обрезание, пустой, бинарный, симлинк** — прежние состояния и пометки p3 без
  изменений; при `truncated` рендер выполняется по обрезанному тексту (пометка
  остаётся).
- **Большие markdown** в пределах лимита 256 КиБ рендерятся как есть; отдельного
  порога/пагинации нет.
- Вне границ: редактирование/сохранение/создание/скачивание, рендер бинарных
  форматов (изображения, PDF), пагинация и живое обновление, тема подсветки,
  экспорт/печать, оглавление, персистенция режима, markdown-рендер на сервере.

## Архитектура (SPA)

- `src/fileRender.ts` (новый) — чистая логика: `detectFileRenderKind(path,
  content)` → `"markdown" | "code" | "plain"`, `languageForPath(path)`, карты
  `LANGUAGE_BY_EXTENSION`/`MARKDOWN_EXTENSIONS`, shebang-детект. Тестируется
  юнит-тестами без DOM.
- `src/components/MarkdownView.tsx` (новый) — `react-markdown` + `remark-gfm`
  + `rehype-highlight`, кастомные `a`/`img`. Компонент без собственного
  состояния: получает `content`.
- `src/components/CodeView.tsx` (новый) — `highlight.js` для standalone-кода;
  подсветка отключена, если язык не из `common`, тогда тот же `<pre>`.
- `src/components/FileView.tsx` — после загрузки: markdown → тулбар
  «Просмотр/Исходник» + `MarkdownView` либо текущий `<pre>`; код → `CodeView`;
  прочее → текущий `<pre>`. Состояния загрузки/ошибки/пусто/бинарный/симлинк/
  truncated не меняются.
- `src/components/WorkspaceRightPane.tsx` — файловому табу задаётся
  `key={tab.id}`, чтобы режим и данные были локальны табу.
- `src/styles.css` — типографика `.ws-markdown` (заголовки/списки/таблицы/цитаты/
  код), тулбар режима и тёмная тема подсветки под токены админки.
- Зависимости `dsh-balbes-admin`: `react-markdown`, `remark-gfm`,
  `rehype-highlight`, `highlight.js`; `pnpm-lock.yaml` обновляется.

## Канон (canon-first)

- `ADMIN_UI.md` — режимы отображения `FileView`, переключатель, безопасность.
- `ARCHITECTURE.md` — клиентский слой рендера и поток просмотра файла.
- `GLOSSARY.md` — «рендер файла по типу», «подсветка синтаксиса», «режим
  просмотра markdown».
- `OVERVIEW.md` — заметное владельцу поведение.
- `API_CONTRACTS.md` — без изменений (контракт чтения не меняется).
- `future_plans/p4-render-file-types.md` — `draft` → `implementing` →
  `absorbed`; `INDEX.md` синхронизируется.

## Рунбук и установщик

- `scripts/install.sh` не меняется: новых автозагрузок/пакетов сервера нет, SPA
  собирается тем же шагом; `pnpm install` на сервере поставит новые клиентские
  зависимости и пересоберёт SPA.
- `docs/runbooks/stage2-vps.md` — в UI-smoke добавить проверку рендера: `.md`
  показывается документом и переключается на исходник, `.ts/.py` — с подсветкой,
  неизвестный тип — моноширинный фолбэк; API-smoke `workspaces.file` не
  меняется.

## Тесты и проверки (TDD)

1. `fileRender.test.ts` (новый): расширения → markdown/code/plain; shebang;
   регистр; неизвестный тип; файлы без расширения (`Dockerfile`, `Makefile`).
2. `FileView.test.tsx`: markdown рендерится структурно (заголовок/список/
   таблица), переключатель «Исходник» показывает `<pre>`; код с подсветкой
   (`hljs`-классы); неизвестный тип — plain; сырой HTML не попадает в DOM;
   `javascript:`-ссылка не становится `href`; существующие состояния без
   регрессий.
3. `client.test.ts` и прочие существующие тесты — без изменений (контракт не
   тронут).
4. Прогон: `pnpm --filter dsh-balbes-admin typecheck`, `... test`,
   `... build`; корневой `pnpm typecheck`/`pnpm test`.

## Риски

- Вес SPA растёт на markdown+подсветку (ориентир ~200–300 КБ gzip); выбран
  common-набор `highlight.js`, не shiki/полный набор — компромисс веса и
  качества.
- Синхронный рендер/подсветка на 256 КиБ может подтормаживать; при необходимости
  — отдельный шаг (порог/async), сейчас приемлемо.
- Remote-изображения в markdown делают браузерные запросы; `no-referrer`,
  single-user. Сырой HTML не исполняется.
- `react-markdown` v10 ESM-only — уже поддержано Vite/Vitest.

## Отложено (не в этом шаге)

- Редактирование/сохранение/скачивание, рендер изображений/PDF, пагинация и
  живое обновление, тема подсветки и настройка, оглавление/экспорт/печать,
  персистенция режима просмотра.
