import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminApi } from "../api/client";
import type { ModelConnection, ModelsListResponse, ModelsSaveRequest } from "dsh-balbes-contracts";
import Modal from "../components/Modal";

const DEFAULT_SEP = "|";

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

type Editor =
  | { mode: "add" } // new OpenAI-compatible connection (custom kind)
  | { mode: "edit"; connection: ModelConnection } // custom connection being edited
  | { mode: "key"; connection: ModelConnection }; // pinned deepseek key change

interface ModelsPageProps {
  api: AdminApi;
}

/**
 * «Модели» page: model provider connections (pinned DeepSeek + OpenAI-compatible
 * custom routes), their API keys, and the global default model. Layout mirrors
 * WorkspacesPage: same modal/banner/error idioms, Russian copy, data-testids.
 */
export default function ModelsPage({ api }: ModelsPageProps) {
  const [data, setData] = useState<ModelsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // connection add/edit/key editor + its form state
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelDraft, setModelDraft] = useState("");

  // delete confirmation
  const [confirming, setConfirming] = useState<ModelConnection | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // per-card ⋮ menu (custom connections only)
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const cardsRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (): Promise<ModelsListResponse> => {
    const next = await api.listModels();
    setData(next);
    return next;
  }, [api]);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await refresh();
    } catch (err) {
      setError(errMessage(err, "list failed"));
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  // close the ⋮ menu on any pointer press outside the cards area
  useEffect(() => {
    if (menuFor === null) return;
    const close = (e: PointerEvent): void => {
      if (cardsRef.current !== null && !cardsRef.current.contains(e.target as Node)) setMenuFor(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuFor]);

  function openAddEditor(): void {
    setMenuFor(null);
    setName("");
    setBaseURL("");
    setKey("");
    setClearKey(false);
    setModels([]);
    setModelDraft("");
    setEditorError(null);
    setEditor({ mode: "add" });
  }

  function openEditEditor(connection: ModelConnection): void {
    setName(connection.displayName);
    setBaseURL(connection.baseURL ?? "");
    setKey("");
    setClearKey(false);
    setModels([...connection.models]);
    setModelDraft("");
    setEditorError(null);
    setMenuFor(null);
    setEditor({ mode: "edit", connection });
  }

  function openKeyEditor(connection: ModelConnection): void {
    setKey("");
    setEditorError(null);
    setEditor({ mode: "key", connection });
  }

  function closeEditor(): void {
    if (busy) return;
    setEditor(null);
    setEditorError(null);
  }

  function openDeleteConfirm(connection: ModelConnection): void {
    setMenuFor(null);
    setDeleteError(null);
    setConfirming(connection);
  }

  function closeDeleteConfirm(): void {
    if (busy) return;
    setConfirming(null);
    setDeleteError(null);
  }

  function addModelDraft(): void {
    const id = modelDraft.trim();
    if (id === "" || models.includes(id)) return;
    setModels([...models, id]);
    setModelDraft("");
  }

  function formValid(): boolean {
    if (editor === null) return false;
    if (editor.mode === "key") return key.trim() !== "";
    return name.trim() !== "" && baseURL.trim() !== "" && models.length > 0;
  }

  /** Assemble the save request; key semantics mirror the API contract:
   *  absent = keep the stored key, string = set it, explicit null = clear it. */
  function buildSaveRequest(): ModelsSaveRequest {
    if (editor === null) throw new Error("no editor");
    if (editor.mode === "key") {
      return { kind: "deepseek", key: key.trim() };
    }
    const req: ModelsSaveRequest = {
      kind: "custom",
      displayName: name.trim(),
      baseURL: baseURL.trim(),
      models: [...models]
    };
    if (editor.mode === "edit") req.routeId = editor.connection.routeId;
    if (editor.mode === "edit" && clearKey) req.key = null;
    else if (key.trim() !== "") req.key = key.trim();
    return req;
  }

  async function handleEditorSubmit(): Promise<void> {
    if (editor === null || busy || !formValid()) return;
    setBusy(true);
    setEditorError(null);
    try {
      await api.saveModel(buildSaveRequest());
      setEditor(null);
      try {
        await refresh();
      } catch (err) {
        setError(errMessage(err, "refresh failed"));
      }
    } catch (err) {
      setEditorError(errMessage(err, "save failed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleDefaultChange(value: string): Promise<void> {
    if (busy) return;
    const sep = value.indexOf(DEFAULT_SEP);
    if (sep <= 0 || sep === value.length - 1) return;
    const provider = value.slice(0, sep);
    const model = value.slice(sep + 1);
    setBusy(true);
    setError(null);
    try {
      await api.setDefaultModel(provider, model);
      try {
        await refresh();
      } catch (err) {
        setError(errMessage(err, "refresh failed"));
      }
    } catch (err) {
      setError(errMessage(err, "set default failed"));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (confirming === null || busy) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api.deleteModel(confirming.routeId);
      setConfirming(null);
      try {
        await refresh();
      } catch (err) {
        setError(errMessage(err, "refresh failed"));
      }
    } catch (err) {
      // 400 reserved / 409 default-in-use and friends: no optimistic removal
      setDeleteError(errMessage(err, "delete failed"));
    } finally {
      setBusy(false);
    }
  }

  const deepseek = data?.connections.find((c) => c.routeId === "deepseek-official");
  const customs = data?.connections.filter((c) => c.kind === "custom") ?? [];
  const currentDefault = data === null ? "" : data.default.provider + DEFAULT_SEP + data.default.model;

  const editorTitle =
    editor === null
      ? ""
      : editor.mode === "add"
        ? "Добавить подключение"
        : editor.mode === "edit"
          ? "Изменить подключение"
          : "Ключ: " + editor.connection.displayName;
  const submitLabel = editor === null ? "" : editor.mode === "add" ? "Добавить" : "Сохранить";
  const submitBusyLabel = editor === null ? "" : editor.mode === "add" ? "Добавляется…" : "Сохраняется…";

  return (
    <div className="models-page" data-testid="models-page">
      {data === null ? (
        <div className="ws-center-state">
          {error !== null ? (
            <>
              <p className="form-error" role="alert" data-testid="models-load-error">
                Не удалось загрузить подключения: {error}
              </p>
              <button type="button" className="btn" onClick={() => void load()} data-testid="models-retry">
                Повторить
              </button>
            </>
          ) : (
            <p className="ws-placeholder">Загрузка…</p>
          )}
        </div>
      ) : (
        <>
          {error !== null && (
            <p className="form-error models-banner" role="alert" data-testid="models-action-error">
              Не удалось: {error}
            </p>
          )}
          <div className="models-toolbar">
            <div className="models-default">
              <span>Дефолтная модель</span>
              <select
                className="models-select"
                data-testid="default-model-select"
                value={currentDefault}
                disabled={busy}
                aria-label="Дефолтная модель"
                onChange={(e) => void handleDefaultChange(e.target.value)}
              >
                {data.connections.map((connection) => (
                  <optgroup key={connection.routeId} label={connection.displayName}>
                    {connection.models.map((model) => (
                      <option key={model} value={connection.routeId + DEFAULT_SEP + model}>
                        {model}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <button type="button" className="btn models-add" onClick={openAddEditor} disabled={busy} data-testid="models-add">
              + Добавить
            </button>
          </div>

          <div className="models-cards" ref={cardsRef}>
            {deepseek !== undefined && (
              <div className="models-card pinned" data-testid={"model-connection:" + deepseek.routeId}>
                <div className="mc-head">
                  <b className="mc-name">{deepseek.displayName}</b>
                  <span className="mc-pin">закреплено</span>
                </div>
                <p className="mc-line">
                  Ключ API: <code>{deepseek.hasKey ? "••••" : "не задан"}</code>
                </p>
                <div className="mc-actions">
                  <button type="button" className="btn-ghost" onClick={() => openKeyEditor(deepseek)} disabled={busy}>
                    Изменить ключ
                  </button>
                </div>
              </div>
            )}
            {customs.length === 0 ? (
              <p className="models-empty" data-testid="models-empty">
                Добавьте провайдера с ключом
              </p>
            ) : (
              customs.map((connection) => {
                const menuOpen = menuFor === connection.routeId;
                return (
                  <div className="models-card" key={connection.routeId} data-testid={"model-connection:" + connection.routeId}>
                    <div className="mc-head">
                      <div className="mc-id">
                        <b className="mc-name">{connection.displayName}</b>
                        <code className="mc-route">{connection.routeId}</code>
                      </div>
                      <button
                        type="button"
                        className="icon-btn mc-menu-btn"
                        aria-label={"Действия для «" + connection.displayName + "»"}
                        aria-expanded={menuOpen}
                        data-testid={"model-menu-" + connection.routeId}
                        onClick={() => setMenuFor(menuOpen ? null : connection.routeId)}
                        disabled={busy}
                      >
                        ⋮
                      </button>
                    </div>
                    {connection.baseURL !== undefined && (
                      <p className="mc-line">
                        Base URL: <code>{connection.baseURL}</code>
                      </p>
                    )}
                    <p className="mc-line">
                      Ключ API: <code>{connection.hasKey ? "••••" : "не задан"}</code>
                    </p>
                    <div className="mc-chips">
                      {connection.models.map((model) => (
                        <span className="mc-chip" key={model}>
                          {model}
                        </span>
                      ))}
                    </div>
                    {menuOpen && (
                      <div className="mc-menu" data-testid={"model-dropdown-" + connection.routeId}>
                        <button
                          type="button"
                          className="mc-menu-item"
                          data-testid={"model-menu-edit-" + connection.routeId}
                          onClick={() => openEditEditor(connection)}
                        >
                          Изменить
                        </button>
                        <button
                          type="button"
                          className="mc-menu-item danger"
                          data-testid={"model-menu-delete-" + connection.routeId}
                          onClick={() => openDeleteConfirm(connection)}
                        >
                          Удалить
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {editor !== null && (
        <Modal title={editorTitle} onClose={closeEditor}>
          <form
            data-testid="model-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleEditorSubmit();
            }}
          >
            {editorError !== null && (
              <p className="form-error" role="alert" data-testid="connection-errors">
                Не удалось: {editorError}
              </p>
            )}
            {editor.mode === "key" ? (
              <label className="form-field">
                <span>Ключ API</span>
                <input
                  type="password"
                  className="form-input"
                  data-testid="key-input"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-…"
                  autoFocus
                />
                <span className="form-hint">
                  Ключ сохраняется в защищённом хранилище и никогда не показывается в интерфейсе.
                </span>
              </label>
            ) : (
              <>
                <label className="form-field">
                  <span>Отображаемое имя</span>
                  <input
                    type="text"
                    className="form-input"
                    data-testid="model-name-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="например, My Gateway"
                    autoFocus
                  />
                </label>
                <label className="form-field">
                  <span>Base URL</span>
                  <input
                    type="text"
                    className="form-input"
                    data-testid="model-url-input"
                    value={baseURL}
                    onChange={(e) => setBaseURL(e.target.value)}
                    placeholder="https://api.example.com/v1"
                  />
                </label>
                <label className="form-field">
                  <span>Ключ API</span>
                  <input
                    type="password"
                    className="form-input"
                    data-testid="key-input"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={
                      editor.mode === "edit" && editor.connection.hasKey
                        ? "•••• (пусто — оставить текущий)"
                        : "sk-…"
                    }
                  />
                </label>
                {editor.mode === "edit" && editor.connection.hasKey && (
                  <label className="form-check">
                    <input
                      type="checkbox"
                      data-testid="model-clear-key"
                      checked={clearKey}
                      onChange={(e) => setClearKey(e.target.checked)}
                    />
                    <span>Очистить ключ</span>
                  </label>
                )}
                <div className="form-field">
                  <span>Модели (минимум одна)</span>
                  <div className="mc-model-add">
                    <input
                      type="text"
                      className="form-input"
                      data-testid="model-models-input"
                      value={modelDraft}
                      onChange={(e) => setModelDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addModelDraft();
                        }
                      }}
                      placeholder="id модели, например gpt-4o-mini"
                      aria-label="Модель (id)"
                    />
                    <button type="button" className="btn-ghost" data-testid="model-models-add" onClick={addModelDraft}>
                      Добавить
                    </button>
                  </div>
                  {models.length > 0 && (
                    <div className="mc-chips">
                      {models.map((model) => (
                        <span className="mc-chip removable" key={model}>
                          {model}
                          <button
                            type="button"
                            className="icon-btn mc-chip-remove"
                            aria-label={"Убрать модель " + model}
                            data-testid={"model-chip-remove-" + model}
                            onClick={() => setModels(models.filter((m) => m !== model))}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={closeEditor} data-testid="model-form-cancel" disabled={busy}>
                Отмена
              </button>
              <button type="submit" className="btn" disabled={busy || !formValid()} data-testid="model-form-submit">
                {busy ? submitBusyLabel : submitLabel}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {confirming !== null && (
        <Modal title="Удалить подключение" onClose={closeDeleteConfirm}>
          <div data-testid="model-delete-confirm">
            {deleteError !== null && (
              <p className="form-error" role="alert" data-testid="connection-errors">
                Не удалось: {deleteError}
              </p>
            )}
            <p className="ws-modal-text">
              Удалить подключение <b>{confirming.displayName}</b> (роут <code>{confirming.routeId}</code>)? Его модели станут
              недоступны для запросов.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={closeDeleteConfirm} data-testid="model-delete-cancel" disabled={busy}>
                Отмена
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => void confirmDelete()}
                disabled={busy}
                data-testid={"model-delete-" + confirming.routeId}
              >
                {busy ? "Удаляется…" : "Удалить"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
