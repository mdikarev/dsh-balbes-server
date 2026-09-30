# Удаление отклонённых предложений памяти (p10f) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** отказ владельца удаляет строку предложения из `memory_proposals` вместо пометки `rejected`; ответ ручки остаётся `{proposal}` со синтезированным `status: "rejected"`, легаси-строки `rejected` убирает миграция v3.

**Architecture:** решение принимает сервис `balbesMemory` (`proposals.ts`): `reject` делает `DELETE … WHERE id=? AND status='proposed'` и возвращает состояние строки **до** удаления с дорешёнными полями; гонка остаётся отсечённой на уровне SQL (0 changes → `invalid-status`), а повторный отказ даёт `not-found`, потому что строки больше нет. Схема таблицы не меняется — меняется только достижимое множество значений `status`: `proposed` и `accepted`; накопленные `rejected` удаляет миграция v3 (данные, не DDL).

**Tech Stack:** TypeScript (strict, ESM), `node:sqlite` (`DatabaseSync`), Cordis-плагины dsh, vitest, pnpm workspaces; React (админка) — только тесты, код страницы не меняется. Новых зависимостей нет.

**Spec:** правки канона уже внесены (canon-first): `docs/canon/API_CONTRACTS.md` → `memory.review/reject` и `memory.review/list`; `docs/canon/ARCHITECTURE.md` → «Ревью и автономия записи (p10f)» и «Миграции и жизненный цикл»; `docs/canon/ADMIN_UI.md` → «Очередь ревью». Дизайн согласован владельцем в сессии (вариант: жёсткое удаление только строк-предложений, ответ `{proposal}` со синтезированным `rejected`, легаси чистит миграция).

## Global Constraints

- Меняется только поведение **отказа предложения**. `approve`, `propose`, дедуп, доставка p10c, метрики p10h и таблица `memories` не меняются.
- Тип `MemoryProposalStatus` и фильтр `status: [...]` остаются как есть: `"rejected"` — валидное значение фильтра, просто новые строки в нём не появляются.
- Ответ `memory.review/reject` остаётся `{proposal: MemoryProposal}` (тип `MemoryReviewRejectResponse` в `dsh-balbes-contracts` не меняется), поэтому фронтенд-код и API-клиент не правятся.
- Схема `memory_proposals` и её индексы не меняются; миграция v3 — только данные (`DELETE … WHERE status='rejected'`), идемпотентная, `proposed`/`accepted` не трогает.
- Порядок ошибок отказа сохраняется: нет строки → `not-found` (404); строка есть, но уже не `proposed` → `invalid-status` (400); гонка между чтением и удалением → `invalid-status` (0 changes).
- Удаление выполняется ОДНИМ statement с условием `status='proposed'`, чтобы гонка не могла удалить уже принятую строку.
- Приватность: текст предложения в логах не появляется, счётчики чистки логируются без текста.
- Тесты: unit — `packages/plugins/dsh-balbes-memory/tests/`; REAL — за гейтом `RUN_REAL=1` **и** `dsh` в PATH; UI — vitest + Testing Library. Каждая задача заканчивается зелёными тестами и коммитом.
- Окружение этого sandbox: `pnpm` работает только как `COREPACK_HOME="$PWD/.corepack-cache" pnpm …`; фокусированный прогон — package-local бинарём, позиционные аргументы vitest — это ПУТИ, не regex.
- `docs/runbooks/stage2-vps.md` обновляется в той же задаче, что и функциональная правка серверного контракта (Task 5).

---

## File Structure

| Файл | Ответственность |
|---|---|
| `packages/plugins/dsh-balbes-memory/src/proposals.ts` (modify) | `reject` удаляет строку одним statement и возвращает дорешённый снимок |
| `packages/plugins/dsh-balbes-memory/src/schema.ts` (modify) | Миграция v3: удаление легаси-строк `rejected`; запись в `MIGRATIONS` |
| `packages/plugins/dsh-balbes-memory/tests/proposals.test.ts` (modify) | Юниты отказа: удаление, синтез ответа, повтор, чужая строка, неприкосновенность `memories` |
| `packages/plugins/dsh-balbes-memory/tests/schema.test.ts` (modify) | Юниты миграции v3: легаси `rejected` удаляется, `accepted`/`proposed` остаются, идемпотентность |
| `packages/plugins/dsh-balbes-memory-admin/tests/integration.test.ts` (modify) | REAL: `review/reject` → 200 `{proposal}` со `status: "rejected"`; `review/list` со `status: ["rejected"]` пуст; `memories` не изменился |
| `packages/frontend/dsh-balbes-admin/tests/MemoryReviewQueue.test.tsx` (modify) | UI: «решённые» = только принятые; отклонённая строка после отказа исчезает; повторный отказ (`not-found`) показывается как перезагрузка |
| `docs/runbooks/stage2-vps.md` (modify) | Серверный smoke: отказ удаляет предложение, очередь решённых пуста |

Код страницы `MemoryReviewQueue.tsx` и API-клиент не меняются: тип ответа сохранён, а строка после отказа и так исчезает при перечитывании очереди.

---

### Task 1: отказ удаляет строку предложения

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory/src/proposals.ts:249-262`
- Test: `packages/plugins/dsh-balbes-memory/tests/proposals.test.ts`

**Interfaces:**
- Consumes: `decideProposal`/`load` уже существуют в `proposals.ts`; `MemoryError` из `./errors.js`.
- Produces (для Tasks 2–5): `ProposalStore.reject(id: string): Promise<MemoryProposal>` с новым поведением — строка удалена, возвращён снимок до удаления с `status: "rejected"`, `decidedAt` = момент отказа, `decidedBy: "owner"`, `decidedEdit: false`, `memoryId: null`.

- [ ] **Step 1: Обновить падающие unit-тесты сервиса**

В `packages/plugins/dsh-balbes-memory/tests/proposals.test.ts` заменить кейс «keeps the audit row on rejection without creating a record» (сейчас строки 226–234) на проверку удаления и добавить соседние. Точный текст:

```ts
  it("deletes the row on rejection and returns the pre-decision snapshot", async () => {
    const { service } = createStore();
    const proposal = await service.propose(proposalDraft);
    const decided = await service.reject(proposal.id);
    // Снимок описывает строку ДО удаления с дорешёнными полями.
    expect(decided).toMatchObject({
      id: proposal.id,
      scope: proposal.scope,
      type: proposal.type,
      text: proposal.text,
      tags: proposal.tags,
      origin: proposal.origin,
      originRef: proposal.originRef,
      proposedAt: proposal.proposedAt,
      status: "rejected",
      decidedBy: "owner",
      decidedEdit: false,
      memoryId: null
    });
    expect(decided.decidedAt).not.toBeNull();
    // Строки больше нет ни в общем списке, ни по id, ни под фильтром rejected.
    expect(await service.getProposal(proposal.id)).toBeUndefined();
    expect(await service.listProposals({ status: ["rejected"] })).toEqual([]);
    expect((await service.listProposals({})).map((entry) => entry.id)).not.toContain(proposal.id);
    // Истина не тронута: запись не создавалась.
    expect(service.list()).toEqual([]);
  });

  it("answers not-found on a second rejection and invalid-status on a decided row", async () => {
    const { service } = createStore();
    const proposal = await service.propose(proposalDraft);
    await service.reject(proposal.id);
    await expect(service.reject(proposal.id)).rejects.toMatchObject({ code: "not-found" });
    const accepted = await service.propose({ ...proposalDraft, text: "keep me", type: "note" });
    await service.approve(accepted.id);
    await expect(service.reject(accepted.id)).rejects.toMatchObject({ code: "invalid-status" });
    await expect(service.reject("nope")).rejects.toMatchObject({ code: "not-found" });
  });
```

Существующий тест «answers invalid-status on repeated decisions» (строки 236–244) теперь проверяет устаревшее поведение: убрать из него строки `await expect(service.reject(proposal.id)).rejects.toMatchObject({ code: "invalid-status" });` (повторный отказ стал `not-found`, это покрывает новый кейс выше) и оставить проверки `approve`/`reject("nope")`.

Если в файле есть локальный хелпер `createStore()` с другим именем, использовать существующий (посмотреть начало файла) — сигнатуру хелпера не менять.

- [ ] **Step 2: Прогнать тесты — убедиться, что падают**

Run: `cd packages/plugins/dsh-balbes-memory && ./node_modules/.bin/vitest run tests/proposals.test.ts`
Expected: FAIL — `decided.status` пока `"rejected"`, но `getProposal` находит строку (ожидался `undefined`), а повторный отказ даёт `invalid-status`, не `not-found`.

- [ ] **Step 3: Реализовать удаление в `reject`**

Заменить тело `reject` в `packages/plugins/dsh-balbes-memory/src/proposals.ts` (сейчас строки 249–262):

```ts
  async function reject(id: string): Promise<MemoryProposal> {
    const proposal = load(id);
    if (proposal === undefined) throw new MemoryError("not-found", "proposal not found: " + id);
    if (proposal.status !== "proposed") {
      throw new MemoryError("invalid-status", "proposal is already " + proposal.status + ": " + id);
    }
    // Отказ — решение, а не состояние: строка удаляется одним statement с
    // условием status='proposed', поэтому гонка не может снести принятую строку.
    const result = deleteProposal.run(id);
    if (Number(result.changes) !== 1) {
      throw new MemoryError("invalid-status", "proposal was decided concurrently: " + id);
    }
    // Ответ описывает удалённую строку: снимок до решения плюс его результат.
    return {
      ...proposal,
      status: "rejected",
      decidedAt: new Date().toISOString(),
      decidedBy: "owner",
      decidedEdit: false,
      memoryId: null
    };
  }
```

Рядом с `decideProposal` объявить statement (там же, где готовятся остальные prepared statements файла — рядом с `decideProposal`):

```ts
  const deleteProposal = db.prepare("DELETE FROM memory_proposals WHERE id = ? AND status = 'proposed'");
```

`decidedAt` для снимка берётся из того же `new Date().toISOString()`, что и раньше; отдельного UPDATE больше нет, поэтому время решения нигде не сохраняется — это и есть удаление аудита по канону.

Проверить, что `decideProposal` больше не используется только для `rejected`: если после правки он вызывается лишь из `approve` (`run("accepted", …)`), сузить его вызовы нельзя (это тот же statement) — оставить как есть.

- [ ] **Step 4: Прогнать тесты — убедиться, что проходят**

Run: `cd packages/plugins/dsh-balbes-memory && ./node_modules/.bin/vitest run tests/proposals.test.ts`
Expected: PASS — новые кейсы и все существующие кейсы `propose`/`approve`.

- [ ] **Step 5: Прогнать весь пакет и типы**

Run: `cd packages/plugins/dsh-balbes-memory && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: PASS; возможен падения в `service.test.ts`/`schema.test.ts`, если там есть кейсы про rejected-строки — если да, обновить их в этой же задаче (поведение удаления — часть этой задачи) и указать в отчёте.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/dsh-balbes-memory/src/proposals.ts packages/plugins/dsh-balbes-memory/tests/proposals.test.ts
git commit -m "feat(memory): delete the proposal row on rejection (p10f)"
```

---

### Task 2: миграция v3 чистит легаси-отклонённые

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory/src/schema.ts` (блок `MIGRATIONS`, сейчас строки 83–85)
- Test: `packages/plugins/dsh-balbes-memory/tests/schema.test.ts`

**Interfaces:**
- Consumes: `Migration`/`MIGRATIONS`/`latestVersion` из `./schema.js`.
- Produces (для Task 5): `MIGRATIONS` с версией 3; после `migrate(db)` в таблице не остаётся строк `status='rejected'`, `user_version = 3`.

- [ ] **Step 1: Написать падающий тест миграции**

Добавить в `packages/plugins/dsh-balbes-memory/tests/schema.test.ts` (использовать существующие хелперы файла для создания БД и вставки предложений; если хелпера нет — вставлять прямым SQL, как в соседних кейсах):

```ts
  it("migration v3 drops legacy rejected proposals and keeps the rest", () => {
    const db = openMemoryDb(); // существующий хелпер файла
    // Легаси-состояние: БД на v2 со всеми тремя статусами.
    db.exec(
      "INSERT INTO memory_proposals (id, scope_kind, scope_name, type, text, tags, origin, origin_ref, status, proposed_at, decided_at, decided_by, decided_edit, memory_id) VALUES " +
        "('legacy-rejected','global',NULL,'note','old reject','[]','agent',NULL,'rejected','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z','owner',0,NULL)," +
        "('legacy-accepted','global',NULL,'note','kept','[]','agent',NULL,'accepted','2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z','owner',0,'m-1')," +
        "('live','global',NULL,'note','pending','[]','agent',NULL,'proposed','2026-09-01T00:00:00.000Z',NULL,NULL,0,NULL)"
    );
    db.exec("PRAGMA user_version = 2");
    migrate(db);
    const ids = db.prepare("SELECT id, status FROM memory_proposals ORDER BY id").all();
    expect(ids).toEqual([
      { id: "legacy-accepted", status: "accepted" },
      { id: "live", status: "proposed" }
    ]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    // Идемпотентность: повторный прогон ничего не ломает и ничего не удаляет.
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_proposals").get()).toEqual({ n: 2 });
  });
```

Точные имена колонок обязаны совпадать с `DDL_V2` в `src/schema.ts` — прочитать перед вставкой (в примере выше `proposed_at`, `decided_at`, `decided_by`, `decided_edit`, `memory_id`, `origin_ref`, `scope_kind`, `scope_name`).

- [ ] **Step 2: Прогнать тест — убедиться, что падает**

Run: `cd packages/plugins/dsh-balbes-memory && ./node_modules/.bin/vitest run tests/schema.test.ts`
Expected: FAIL — `user_version` остаётся 2, а `legacy-rejected` остаётся в таблице.

- [ ] **Step 3: Добавить миграцию v3**

В `packages/plugins/dsh-balbes-memory/src/schema.ts` после `DDL_V2` добавить:

```ts
/**
 * v3 (p10f): отказ больше не оставляет строку, поэтому накопленные `rejected`
 * удаляются. Это данные, не схема: DDL и индексы `memory_proposals` не меняются,
 * идемпотентный повтор на чистой таблице не находит ничего.
 */
export const DDL_V3 = "DELETE FROM memory_proposals WHERE status = 'rejected'";
```

и расширить список:

```ts
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: (db) => db.exec(DDL_V1) },
  { version: 2, up: (db) => db.exec(DDL_V2) },
  { version: 3, up: (db) => db.exec(DDL_V3) }
];
```

**As-built отклонения (внесены по итогам ревью, коммит `a190f18`):**

- v3 — не голый `db.exec`, а хелпер `purgeLegacyRejectedProposals`: он сначала
  проверяет наличие ОБЕИХ таблиц (`memories` и `memory_proposals`) в
  `sqlite_master` и при отсутствии любой возвращает 0, оставляя отказ
  пост-миграционному `validateMemorySchema` (иначе битая база на v1/v2 падала
  сырой ошибкой SQLite вместо `MemoryError`);
- `Migration.up` теперь может возвращать число изменённых строк, `migrate`
  возвращает `{version, changes}`, `openMemoryDatabase` — `{db, changes}`, а
  плагин печатает одну строку `info` со счётчиком удалённых легаси-строк
  (требование канона «количество удалённых строк логируется»);
- тесты версий/вызовов обновлены механически (`LATEST_VERSION` 2 → 3,
  `openMemoryDatabase(...).db`).

- [ ] **Step 4: Прогнать тесты — убедиться, что проходят**

Run: `cd packages/plugins/dsh-balbes-memory && ./node_modules/.bin/vitest run tests/schema.test.ts`
Expected: PASS — новый кейс и существующие кейсы версий/валидации схемы. Если существующий тест жёстко ждёт `LATEST === 2` или перечисляет миграции, обновить ожидание до 3 и указать это в отчёте.

- [ ] **Step 5: Прогнать весь пакет и типы**

Run: `cd packages/plugins/dsh-balbes-memory && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/dsh-balbes-memory/src/schema.ts packages/plugins/dsh-balbes-memory/tests/schema.test.ts
git commit -m "feat(memory): drop legacy rejected proposals in migration v3 (p10f)"
```

---

### Task 3: REAL-проверка отказа на живой композиции

**Files:**
- Modify: `packages/plugins/dsh-balbes-memory-admin/tests/integration.test.ts` (кейс «rejects a proposal, keeps it out of memory and refuses secrets», строка ~280)
- Test: тот же файл

**Interfaces:**
- Consumes: Tasks 1–2 (удаление + миграция); фикстур-профиль `tests/fixtures/balbes-memory-admin-profile` уже поднимает `dsh-balbes-memory` и `dsh-balbes-memory-admin`.
- Produces: доказательство, что на живом сервере отказ удаляет строку, `review/list` со `status: ["rejected"]` пуст, `memories` не изменился.

- [ ] **Step 1: Дописать REAL-ассерты**

В кейсе «rejects a proposal, keeps it out of memory and refuses secrets» после существующего отказа добавить (имена переменных взять из текущего кейса — там уже есть `base`, `token` и ответ на `propose`):

```ts
      // p10f: отказ удаляет строку — аудита нет, повторный отказ not-found.
      const rejectedList = await postJson(
        base + "/api/memory/review/list",
        { status: ["rejected"] },
        token
      );
      expect(rejectedList.status, rejectedList.raw).toBe(200);
      expect((rejectedList.json as { proposals: unknown[] }).proposals).toEqual([]);

      // Повторный отказ: строки больше нет.
      const secondReject = await api("/api/memory/review/reject", { id });
      expect(secondReject.status, secondReject.raw).toBe(404);
      expect((secondReject.json as { error: { code: string } }).error.code).toBe("not-found");
```

Точные адаптации к существующему коду этого кейса (обязательно прочитать кейс целиком):

1. Второй ассерт (`const decided = await api("/api/memory/review/list", { status: ["rejected"] });` и `…some(…).toBe(true)`) сейчас ждёт, что отклонённая строка лежит как аудит — **заменить** на ожидание пустого списка:
   ```ts
   const decided = await api("/api/memory/review/list", { status: ["rejected"] });
   expect((decided.json as { proposals: MemoryProposal[] }).proposals).toEqual([]);
   ```
2. Блок `const pendingQueue …` (проверка, что очередь ожидающих не содержит отклонённое) сохранить как есть — поведение не изменилось.
3. Ассерт «не попало в истину» уже есть в кейсе (`const listed = await api("/api/memory/list", { query: marker }); … toEqual([])`) — не дублировать, оставить.
4. Хелпер кейса называется `api(path, body)` и возвращает `{status, json, raw}`, а маркер — локальная переменная `marker` (строка ~281); пример выше с `postJson`/`base`/`token` — подсказка формы, привести к фактическому хелперу.

- [ ] **Step 2: Прогнать REAL-тест**

Run: `cd packages/plugins/dsh-balbes-memory-admin && RUN_REAL=1 ./node_modules/.bin/vitest run tests/integration.test.ts`
Expected: PASS при `dsh` в PATH (проверить `which dsh`); без `dsh` — набор пропущен. Не ослаблять ассерты, чтобы «прошло»: REAL обязан исполниться.

- [ ] **Step 3: Прогнать пакет и типы**

Run: `cd packages/plugins/dsh-balbes-memory-admin && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: PASS (без `RUN_REAL` интеграционный набор пропущен).

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/dsh-balbes-memory-admin/tests/integration.test.ts
git commit -m "test(memory): prove rejection removes the proposal over the real API (p10f)"
```

---

### Task 4: UI-тесты очереди под новое поведение

**Files:**
- Modify: `packages/frontend/dsh-balbes-admin/src/pages/MemoryReviewQueue.tsx:78`
- Modify: `packages/frontend/dsh-balbes-admin/tests/MemoryReviewQueue.test.tsx`
- Test: тот же тест-файл

**Interfaces:**
- Consumes: неизменённый API-клиент (`rejectMemoryReview` возвращает `{proposal}`).
- Produces: запрос «решённых» ровно со `status: ["accepted"]` (отклонённых строк в таблице нет — канон `API_CONTRACTS.md`), тесты «решённые = только принятые» и исчезновение строки после отказа.

- [ ] **Step 1: Сузить фильтр «решённых» в странице**

В `packages/frontend/dsh-balbes-admin/src/pages/MemoryReviewQueue.tsx:78` заменить

```ts
        ...(showDecided ? { status: ["accepted", "rejected"] as MemoryProposal["status"][] } : {})
```

на

```ts
        // Отклонённых предложений в таблице не бывает: отказ удаляет строку,
        // поэтому «решённые» — это только принятые.
        ...(showDecided ? { status: ["accepted"] as MemoryProposal["status"][] } : {})
```

Заодно удалить ставший мёртвым ярлык `rejected: "отклонено"` из карты статусов (строка ~19), если после этого он нигде не читается (проверить grep'ом по файлу); если читается (например, для старых строк, пришедших из API), оставить и сказать в отчёте.

- [ ] **Step 2: Обновить тесты очереди**

В `packages/frontend/dsh-balbes-admin/tests/MemoryReviewQueue.test.tsx`:

1. Кейс «shows decided proposals with their verdict when the toggle is on» (строки ~102–110) сейчас подсовывает `status: "rejected"` и ждёт фильтр `["accepted", "rejected"]`. Привести к новому контракту: мок `listMemoryReview` возвращает **только принятые** записи, ожидание фильтра — `{ status: ["accepted"] }`, строки «отклонено» в разметке быть не должно:

```ts
  it("shows only accepted decisions when the toggle is on", async () => {
    const decided = proposal({ id: "p-2", status: "accepted", decidedAt: "2026-09-30T02:00:00.000Z", decidedBy: "owner" });
    listMemoryReview.mockImplementation(async (req: { status?: string[] }) =>
      req.status === undefined ? { proposals: [], policy: POLICY } : { proposals: [decided], policy: POLICY }
    );
    render(<MemoryReviewQueue ... />); // сохранить существующий рендер кейса
    fireEvent.click(screen.getByTestId("memory-review-decided-toggle"));
    expect(await screen.findByText(/kept knowledge/)).toBeTruthy(); // текст мока-предложения
    expect(api.listMemoryReview).toHaveBeenCalledWith(expect.objectContaining({ status: ["accepted"] }));
    expect(screen.queryByText("отклонено")).toBeNull();
  });
```

Существующие имена мока/рендера/текста взять из файла (в примере выше — заглушки-подсказки, а не готовый код: привести к фактическим идентификаторам кейса).

2. Кейс «rejects after confirmation and refreshes the queue» дополнить проверкой, что строка исчезает после перечитывания: второй ответ `listMemoryReview` без отклонённого предложения, затем `await waitFor(() => expect(screen.queryByTestId("memory-review-row:p-1")).toBeNull())` — точный `data-testid` строки взять из `MemoryReviewQueue.tsx` (если строки без testid, использовать текст предложения).

- [ ] **Step 3: Прогнать UI-тесты — убедиться, что проходят**

Run: `cd packages/frontend/dsh-balbes-admin && ./node_modules/.bin/vitest run tests/MemoryReviewQueue.test.tsx`
Expected: PASS. Если до правки Step 1 кейс падал на `status: ["accepted","rejected"]`, это был ожидаемый RED.

- [ ] **Step 4: Прогнать весь фронтенд-пакет и типы**

Run: `cd packages/frontend/dsh-balbes-admin && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/dsh-balbes-admin/src/pages/MemoryReviewQueue.tsx packages/frontend/dsh-balbes-admin/tests/MemoryReviewQueue.test.tsx
git commit -m "fix(admin): show only accepted decisions in the review queue (p10f)"
```

---

### Task 5: runbook, repo-wide проверки и canon-audit

**Files:**
- Modify: `docs/runbooks/stage2-vps.md` (блок «Память: ревью предложенных записей (p10f)», строки ~649–730)
- Test: repo-wide `typecheck`/`test`

**Interfaces:**
- Consumes: поведение Tasks 1–3 (`review/reject` удаляет строку).
- Produces: серверную инструкцию проверки и закрытый аудит канона.

- [ ] **Step 1: Дописать runbook**

В `docs/runbooks/stage2-vps.md` в блоке ревью памяти (~строка 693, после проверки одобрения) добавить шаг с отказом и обновить ожидания существующих шагов:

```bash
# Отказ удаляет предложение: аудита нет, повторный отказ — not-found
curl -fsS -X POST http://127.0.0.1:8080/api/memory/review/reject \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"id":"<proposal-id>"}'
# ожидается: {"proposal":{...,"status":"rejected","decidedAt":"...","decidedBy":"owner"}}
#   — это снимок строки ДО удаления
curl -fsS -X POST http://127.0.0.1:8080/api/memory/review/list \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"status":["rejected"]}'
# ожидается: {"proposals":[],"policy":{...}} — отклонённых строк в таблице нет
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/memory/review/reject \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"id":"<proposal-id>"}'
# ожидается: 404 (not-found)
```

Также в шаге «Показать решённые» существующего блока ревью (там, где очередь перечитывается со статусами решённых) заменить перечисление статусов на `["accepted"]` и ожидание «в решённых только принятые»; в тексте блока отметить, что отказ необратим.

- [ ] **Step 2: Repo-wide проверки**

Run: `COREPACK_HOME="$PWD/.corepack-cache" pnpm typecheck`
Expected: PASS по всем пакетам.

Run: `COREPACK_HOME="$PWD/.corepack-cache" pnpm -r --workspace-concurrency=1 --if-present run test`
Expected: PASS; REAL-наборы пропущены без `RUN_REAL`. (Форма `pnpm test --workspace-concurrency=1` из корневого скрипта пробрасывает флаг в vitest и падает — это известное свойство репозитория, не регрессия.)

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/stage2-vps.md
git commit -m "docs(runbook): verify proposal rejection deletes the row (p10f)"
```

- [ ] **Step 4: Закрыть через `canon-audit`**

Вызвать скилл `canon-audit` по теме «отказ предложения памяти (p10f)»: сверить канон (`API_CONTRACTS.md` `memory.review/reject`/`list`, `ARCHITECTURE.md` жизненный цикл + миграции v3, `ADMIN_UI.md` очередь ревью) с кодом, прогнать `doc-canon validate --json`, пересобрать `doc-canon check`/`index`/`code-index` и убедиться, что открытых `conflict`/`drift` нет. Новых инициатив в `future_plans/` не заводить: это правка существующего p10f.

- [ ] **Step 5: Commit (если аудит правил канон)**

```bash
git add docs/canon
git commit -m "docs(canon): close the rejection-deletes-row audit (p10f)"
```

---

## Self-Review

**1. Покрытие требований**

| Требование владельца/канона | Задача |
|---|---|
| «Отклонённые записи удалялись из базы» | Task 1 (жёсткое удаление строки), Task 2 (легаси), Task 3 (REAL) |
| «Только предложения, `memories` не трогать» | Task 1 (`service.list()` пуст после отказа), Task 3 (REAL-ассерт) |
| Ответ ручки сохраняется (`{proposal}` со синтезом) | Task 1 + канон уже поправлен; фронт не меняется |
| Легаси-строки | Task 2 (миграция v3, идемпотентная) |
| Повторный отказ и гонка | Task 1 (`not-found` / `invalid-status`), Task 3 (REAL 404) |
| UI: «решённые» = только принятые, исчезновение строки | Task 4 (`MemoryReviewQueue.tsx:78` + тесты) |
| Канон (canon-first) | уже закоммичен (`1cd3d6c`, `7f5838d`), закрытие — Task 5 |
| Серверная проверка | Task 5 (runbook + repo-wide) |

**2. Скан плейсхолдеров**

Плейсхолдеров-«TBD» нет. В Task 3 и Task 4 есть пометки вида «взять фактический идентификатор из файла» — это осознанные якоря к существующему тесту (имена моков/маркеров отличаются от примера), а не пропущенные требования; исполнитель обязан прочитать соседний код, а не выдумывать имена.

**3. Согласованность типов**

- `reject(id): Promise<MemoryProposal>` — сигнатура не меняется, меняется содержимое ответа (Task 1).
- `MemoryReviewRejectResponse.proposal` — без правок contracts, поэтому UI-клиент и страница не трогаются (Task 4 правит только тесты).
- `MIGRATIONS` — элемент `{ version: 3, up }` (Task 2), `latestVersion` становится 3; тесты, ожидающие 2, обновляются в той же задаче.
- `status: "rejected"` остаётся валидным `MemoryProposalStatus` (используется в синтезе ответа и в фильтре), но не встречается в БД после Task 2.
