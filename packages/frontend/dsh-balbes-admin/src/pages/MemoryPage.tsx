import { useCallback, useEffect, useState } from "react";
import { ApiError, type AdminApi } from "../api/client";
import type { MemoryRecord, MemoryType, WorkspaceProject } from "dsh-balbes-contracts";
import Modal from "../components/Modal";
import MemoryReviewQueue from "./MemoryReviewQueue";
import {
  MEMORY_TYPES,
  TYPE_LABELS,
  formatTime,
  levelKey,
  levelLabel,
  parseScope,
  parseTags,
  type MemoryLevel as Level,
  type LevelSelection
} from "./memoryShared";

const ORIGIN_LABELS: Record<MemoryRecord["origin"], string> = {
  owner: "владелец",
  agent: "агент"
};

type Editor = { mode: "create" } | { mode: "edit"; record: MemoryRecord };

function secretRule(message: string): string {
  const match = /"([^"]*)"\s*$/.exec(message);
  return match?.[1] ?? message;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "secret-detected") {
      return `текст похож на секрет (${secretRule(error.message)}) — запись отклонена`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "неизвестная ошибка";
}

export default function MemoryPage({ api }: { api: AdminApi }) {
  const [tab, setTab] = useState<"records" | "review">("records");
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingCountCapped, setPendingCountCapped] = useState(false);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [level, setLevel] = useState<LevelSelection>({ kind: "global" });
  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MemoryType | "all">("all");
  const [tag, setTag] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [toDelete, setToDelete] = useState<MemoryRecord | null>(null);
  const [formType, setFormType] = useState<MemoryType>("note");
  const [formLevel, setFormLevel] = useState<Level>({ kind: "global" });
  const [formText, setFormText] = useState("");
  const [formTags, setFormTags] = useState("");
  const [formPinned, setFormPinned] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const res = await api.listMemory({
        // «Все» sends no scope at all, so the server lists every level
        ...(level.kind === "all" ? {} : { scope: level }),
        ...(type === "all" ? {} : { type }),
        ...(tag.trim() === "" ? {} : { tag: tag.trim() }),
        ...(pinnedOnly ? { pinned: true } : {}),
        ...(query.trim() === "" ? {} : { query: query.trim() })
      });
      setRecords(res.records);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [api, level, type, tag, pinnedOnly, query]);

  const refreshPendingCount = useCallback(async (): Promise<void> => {
    try {
      // No scope, no type, no tag: this is the total, not the current view.
      // The store caps a page at `maxListLimit` (500), so ask for the maximum
      // and let the badge say "500+" when the page comes back full.
      const res = await api.listMemoryReview({ limit: 500 });
      setPendingCount(res.proposals.length);
      setPendingCountCapped(res.proposals.length >= 500);
    } catch {
      // The queue tab surfaces the real error; a stale badge is not worth an alert.
    }
  }, [api]);

  useEffect(() => { void refreshPendingCount(); }, [refreshPendingCount]);

  useEffect(() => {
    let cancelled = false;
    void api
      .listWorkspaces()
      .then((res) => { if (!cancelled) { setProjects(res.projects); setProjectsLoaded(true); } })
      .catch(() => { if (!cancelled) setProjectsLoaded(true); });
    return () => { cancelled = true; };
  }, [api]);

  // keep the selected project valid; fall back to the home level when it vanishes
  useEffect(() => {
    if (!projectsLoaded || level.kind !== "project") return;
    if (!projects.some((project) => project.name === level.name)) setLevel({ kind: "global" });
  }, [projectsLoaded, projects, level]);

  // reload on level/filter change; debounce only the free-text query
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, query === "" ? 0 : 300);
    return () => clearTimeout(timer);
  }, [load, query]);

  function openCreate(): void {
    setFormType("note");
    setFormLevel(level.kind === "all" ? { kind: "global" } : level);
    setFormText("");
    setFormTags("");
    setFormPinned(false);
    setFormError(null);
    setEditor({ mode: "create" });
  }

  function openEdit(record: MemoryRecord): void {
    setFormType(record.type);
    setFormText(record.text);
    setFormTags(record.tags.join(", "));
    setFormPinned(record.pinned);
    setFormError(null);
    setEditor({ mode: "edit", record });
  }

  function openDelete(record: MemoryRecord): void {
    setDeleteError(null);
    setToDelete(record);
  }

  function closeDelete(): void {
    setDeleteError(null);
    setToDelete(null);
  }

  async function saveEditor(): Promise<void> {
    if (editor === null || busy) return;
    if (formText.trim() === "") {
      setFormError("Текст не может быть пустым");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      if (editor.mode === "create") {
        // a concrete view level is immutable context; «Все» picks the scope in the modal
        await api.saveMemory({ scope: level.kind === "all" ? formLevel : level, type: formType, text: formText, tags: parseTags(formTags), pinned: formPinned });
      } else {
        await api.saveMemory({ id: editor.record.id, type: formType, text: formText, tags: parseTags(formTags), pinned: formPinned });
      }
      setEditor(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // the record was deleted by another actor: close the editor and refresh
        setEditor(null);
        await load();
      } else {
        setFormError(messageOf(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (toDelete === null || busy) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api.deleteMemory(toDelete.id);
      closeDelete();
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // the record was deleted by another actor: close the modal and refresh
        closeDelete();
        await load();
      } else {
        setDeleteError(messageOf(error));
      }
    } finally {
      setBusy(false);
    }
  }

  const filtersActive = query.trim() !== "" || type !== "all" || tag.trim() !== "" || pinnedOnly;

  return (
    <div className="memory-page" data-testid="memory-page">
      <div className="memory-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "records"}
          className={tab === "records" ? "memory-tab memory-tab-active" : "memory-tab"}
          data-testid="memory-tab-records"
          onClick={() => setTab("records")}
        >
          Записи
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "review"}
          className={tab === "review" ? "memory-tab memory-tab-active" : "memory-tab"}
          data-testid="memory-tab-review"
          onClick={() => setTab("review")}
        >
          Очередь ревью
          {pendingCount > 0 && (
            <span className="memory-tab-count" data-testid="memory-tab-review-count">{pendingCountCapped ? "500+" : pendingCount}</span>
          )}
        </button>
      </div>

      {tab === "review" ? (
        <MemoryReviewQueue api={api} onDecided={refreshPendingCount} />
      ) : (
        <>
      <div className="memory-toolbar">
        <select
          className="memory-level"
          aria-label="Уровень памяти"
          data-testid="memory-level"
          value={levelKey(level)}
          onChange={(event) => {
            const value = event.target.value;
            setLevel(value === "all" ? { kind: "all" } : parseScope(value));
          }}
        >
          <option value="global">Дом</option>
          {projects.map((project) => (
            <option key={project.name} value={"project:" + project.name}>{project.name}</option>
          ))}
          <option value="all">Все</option>
        </select>

        <input
          className="ws-name-input memory-search"
          aria-label="Поиск по тексту"
          data-testid="memory-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Поиск по тексту..."
        />

        <select
          className="memory-type-filter"
          aria-label="Тип"
          data-testid="memory-type-filter"
          value={type}
          onChange={(event) => setType(event.target.value as MemoryType | "all")}
        >
          <option value="all">Все типы</option>
          {MEMORY_TYPES.map((value) => (
            <option key={value} value={value}>{TYPE_LABELS[value]}</option>
          ))}
        </select>

        <input
          className="ws-name-input memory-tag-filter"
          aria-label="Тег"
          data-testid="memory-tag-filter"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder="тег"
        />

        <label className="memory-pinned-toggle">
          <input
            type="checkbox"
            data-testid="memory-pinned-only"
            checked={pinnedOnly}
            onChange={(event) => setPinnedOnly(event.target.checked)}
          />
          Только пиннутые
        </label>

        <button type="button" className="btn" onClick={openCreate} data-testid="memory-add">+ Добавить запись</button>
        <button type="button" className="btn-ghost" onClick={() => void load()} data-testid="memory-refresh">Обновить</button>
      </div>

      {records === null ? (
        <div className="ws-center-state">
          {loadError !== null ? (
            <>
              <p className="form-error" role="alert" data-testid="memory-load-error">{loadError}</p>
              <button type="button" className="btn" onClick={() => void load()} data-testid="memory-load-retry">Повторить</button>
            </>
          ) : (
            <p className="ws-placeholder">Загрузка...</p>
          )}
        </div>
      ) : loadError !== null ? (
        <div className="ws-center-state">
          <p className="form-error" role="alert" data-testid="memory-load-error">{loadError}</p>
          <button type="button" className="btn" onClick={() => void load()} data-testid="memory-load-retry">Повторить</button>
        </div>
      ) : records.length === 0 ? (
        filtersActive ? (
          <p className="ws-placeholder" data-testid="memory-no-results">Ничего не найдено</p>
        ) : (
          <p className="ws-placeholder" data-testid="memory-empty">Память пуста - добавьте первую запись</p>
        )
      ) : (
        <ul className="memory-list" data-testid="memory-list">
          {records.map((record) => (
            <li className="memory-row" key={record.id} data-testid={"memory-row:" + record.id}>
              <div className="memory-row-head">
                <span className="memory-type">{TYPE_LABELS[record.type]}</span>
                <span className="memory-level-badge" title="Уровень" data-testid="memory-row-level">{levelLabel(record.scope)}</span>
                {record.pinned && <span className="memory-pin" title="пиннуто">★</span>}
                <span className="memory-provenance">{ORIGIN_LABELS[record.origin]} · {formatTime(record.updatedAt)}</span>
                <span className="memory-row-actions">
                  <button type="button" className="btn-ghost" onClick={() => openEdit(record)} data-testid={"memory-edit:" + record.id}>Изменить</button>
                  <button type="button" className="btn-danger" onClick={() => openDelete(record)} data-testid={"memory-delete:" + record.id}>Удалить</button>
                </span>
              </div>
              <p className="memory-row-text">{record.text}</p>
              {record.tags.length > 0 && (
                <div className="memory-tags">
                  {record.tags.map((value) => <span className="memory-tag" key={value}>{value}</span>)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editor !== null && (
        <Modal title={editor.mode === "create" ? "Добавить запись" : "Изменить запись"} onClose={() => setEditor(null)}>
          {editor.mode === "edit" ? (
            // the edited record's own level, never the current filter/view
            <p className="memory-scope-line">
              Уровень: <b>{levelLabel(editor.record.scope)}</b> (не меняется)
            </p>
          ) : level.kind === "all" ? (
            // «Все» is a view mode: the new record's level is chosen here
            <select
              className="memory-type-select"
              aria-label="Уровень записи"
              data-testid="memory-form-level"
              value={levelKey(formLevel)}
              onChange={(event) => setFormLevel(parseScope(event.target.value))}
            >
              <option value="global">Дом</option>
              {projects.map((project) => (
                <option key={project.name} value={"project:" + project.name}>{project.name}</option>
              ))}
            </select>
          ) : (
            <p className="memory-scope-line">
              Уровень: <b>{levelLabel(level)}</b>
            </p>
          )}
          <select
            className="memory-type-select"
            aria-label="Тип записи"
            data-testid="memory-form-type"
            value={formType}
            onChange={(event) => setFormType(event.target.value as MemoryType)}
          >
            {MEMORY_TYPES.map((value) => <option key={value} value={value}>{TYPE_LABELS[value]}</option>)}
          </select>
          <textarea
            className="memory-form-text"
            aria-label="Текст записи"
            data-testid="memory-form-text"
            value={formText}
            onChange={(event) => setFormText(event.target.value)}
            rows={5}
          />
          <input
            className="ws-name-input"
            aria-label="Теги"
            data-testid="memory-form-tags"
            value={formTags}
            onChange={(event) => setFormTags(event.target.value)}
            placeholder="теги через запятую"
          />
          <label className="memory-pinned-toggle">
            <input
              type="checkbox"
              data-testid="memory-form-pinned"
              checked={formPinned}
              onChange={(event) => setFormPinned(event.target.checked)}
            />
            Пиннуть
          </label>
          {formError !== null && <p className="form-error" role="alert" data-testid="memory-form-error">{formError}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setEditor(null)} data-testid="memory-form-cancel">Отмена</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void saveEditor()} data-testid="memory-form-save">{busy ? "Сохраняется..." : "Сохранить"}</button>
          </div>
        </Modal>
      )}

      {toDelete !== null && (
        <Modal title="Удалить запись" onClose={closeDelete}>
          <p className="ws-modal-text">Удалить запись «{toDelete.text.slice(0, 80)}» безвозвратно?</p>
          {deleteError !== null && (
            <p className="form-error" role="alert" data-testid="memory-delete-error">{deleteError}</p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={closeDelete} data-testid="memory-delete-cancel">Отмена</button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => void confirmDelete()} data-testid="memory-delete-confirm">{busy ? "Удаляется..." : "Удалить"}</button>
          </div>
        </Modal>
      )}
        </>
      )}
    </div>
  );
}
