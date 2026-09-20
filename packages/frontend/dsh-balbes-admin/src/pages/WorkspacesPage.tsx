import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AdminApi } from "../api/client";
import { suggestProjectNameFromGitUrl, type WorkspaceListResponse, type WorkspaceProject } from "dsh-balbes-contracts";
import WorkspaceList from "../components/WorkspaceList";
import FileTree from "../components/FileTree";
import Modal from "../components/Modal";
import WorkspaceRightPane from "../components/WorkspaceRightPane";
import { refKey, type WorkspaceRef } from "../workspaceRef";

const SELECTED_KEY = "balbes.selectedWorkspace";
const TREE_WIDTH_KEY = "balbes.treePaneWidth";

function readSelected(): WorkspaceRef | null {
  try {
    const raw = localStorage.getItem(SELECTED_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as WorkspaceRef;
    if (parsed !== null && typeof parsed === "object" && (parsed.scope === "home" || parsed.scope === "project")) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

interface WorkspacesPageProps {
  api: AdminApi;
}

export default function WorkspacesPage({ api }: WorkspacesPageProps) {
  const [data, setData] = useState<WorkspaceListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<WorkspaceRef | null>(readSelected);
  const [refreshKey, setRefreshKey] = useState(0);
  const [fileOpen, setFileOpen] = useState<{ id: number; refKey: string; path: string } | null>(null);
  const fileOpenSeq = useRef(0);
  const [modal, setModal] = useState<null | { type: "create" } | { type: "git-token" } | { type: "delete"; project: WorkspaceProject }>(null);
  const [name, setName] = useState("");
  const [gitConfigured, setGitConfigured] = useState<boolean | null>(null);
  const [createMode, setCreateMode] = useState<"empty" | "git">("empty");
  const [gitUrl, setGitUrl] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);
  // keep a stored width only when it is a sane finite pixel value (>= the drag
  // minimum of 220); anything else falls back to the CSS default (33%)
  const [treeWidth, setTreeWidth] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(TREE_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= 220 ? stored : null; // null = CSS default (33%)
  });
  const widthClamped = useRef(false);

  const refresh = useCallback(async (): Promise<WorkspaceListResponse> => {
    const next = await api.listWorkspaces();
    setData(next);
    return next;
  }, [api]);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "list failed");
    }
  }, [refresh]);

  // list events arrive outside any user gesture, so the refresh must not leak a
  // rejection: mirror the action handlers' banner discipline (clear, then try)
  const refreshFromEvent = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "refresh failed");
    }
  }, [refresh]);

  const loadGit = useCallback(async (): Promise<void> => {
    try {
      const res = await api.gitStatus();
      setGitConfigured(res.git.tokenConfigured);
    } catch {
      // keep the last known value; the list load already surfaces auth errors
    }
  }, [api]);

  useEffect(() => {
    void load();
    void loadGit();
  }, [load, loadGit]);

  // a stored width can exceed the current container (stale from a narrower
  // window or an edited value): clamp it down once the pane is laid out, never
  // again, so later user drags keep the full range. The 220 floor keeps a sane
  // minimum when the container is 0/negative (e.g. before layout).
  useLayoutEffect(() => {
    if (widthClamped.current) return;
    const container = pageRef.current;
    if (container === null) return;
    widthClamped.current = true;
    const bound = Math.max(container.clientWidth - 360, 220);
    setTreeWidth((w) => (w !== null && w > bound ? bound : w));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data === null]);

  // keep the selection valid: project rows can disappear on refresh/events
  useEffect(() => {
    if (data === null || selected === null) return;
    if (selected.scope === "project" && !data.projects.some((p) => p.name === selected.name)) {
      setSelected(null);
      localStorage.removeItem(SELECTED_KEY);
    }
  }, [data, selected]);

  // live workspace events: a list change refreshes the list (whose data effect
  // above then drops a vanished selection); an fs change under the selected
  // workspace bumps refreshKey (debounced) so FileTree re-reads its dirs.
  useEffect(() => {
    const flushTimer = { current: null as ReturnType<typeof setTimeout> | null };
    const unsubscribe = api.subscribeWorkspaceEvents((event) => {
      if (event.kind === "list") {
        void refreshFromEvent();
        return;
      }
      const matches =
        selected !== null &&
        event.scope === selected.scope &&
        (selected.scope === "home" || event.name === selected.name);
      if (!matches) return;
      if (flushTimer.current === null) {
        flushTimer.current = setTimeout(() => {
          flushTimer.current = null;
          setRefreshKey((k) => k + 1);
        }, 300);
      }
    });
    return () => {
      unsubscribe();
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    };
  }, [api, refreshFromEvent, selected]);

  const select = useCallback((ref: WorkspaceRef): void => {
    setSelected(ref);
    localStorage.setItem(SELECTED_KEY, JSON.stringify(ref));
  }, []);

  async function handleCreate(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res =
        createMode === "git"
          ? await api.createWorkspaceFromGit({ url: gitUrl.trim(), name: trimmed })
          : await api.createWorkspace(trimmed);
      setName("");
      setGitUrl("");
      setCreateMode("empty");
      setModal(null);
      const fresh = await refresh();
      const created = fresh.projects.find((p) => p.name === res.project.name);
      if (created !== undefined) select({ scope: "project", name: created.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveGitToken(): Promise<void> {
    if (tokenInput.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.gitSave(tokenInput.trim());
      setGitConfigured(res.git.tokenConfigured);
      setTokenInput("");
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "token save failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearGitToken(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.gitClearToken();
      setGitConfigured(res.git.tokenConfigured);
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "token clear failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (modal === null || modal.type !== "delete" || busy) return;
    setBusy(true);
    setError(null);
    const project = modal.project;
    try {
      await api.deleteWorkspace(project.name);
      setModal(null);
      if (selected !== null && selected.scope === "project" && selected.name === project.name) {
        setSelected(null);
        localStorage.removeItem(SELECTED_KEY);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  if (data === null) {
    return (
      <div className="workspaces-page" data-testid="workspaces-page">
        <div className="ws-center-state">
          {error !== null ? (
            <>
              <p className="form-error" role="alert" data-testid="workspace-load-error">
                Не удалось загрузить воркспейсы: {error}
              </p>
              <button type="button" className="btn" onClick={() => void load()} data-testid="workspace-load-retry">
                Повторить
              </button>
            </>
          ) : (
            <p className="ws-placeholder">Загрузка…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="workspaces-page" data-testid="workspaces-page" ref={pageRef}>
      {error !== null && (
        <p className="form-error ws-error-banner" role="alert" data-testid="workspace-action-error">
          Не удалось: {error}
        </p>
      )}
      <div className="ws-panes">
        <WorkspaceList
          homePath={data.home.path}
          projects={data.projects}
          selected={selected}
          busy={busy}
          gitConfigured={gitConfigured}
          onSelect={select}
          onCreate={() => setModal({ type: "create" })}
          onOpenGit={() => setModal({ type: "git-token" })}
          onDelete={(p) => setModal({ type: "delete", project: p })}
        />
        <div
          className="ws-tree-shell"
          style={treeWidth === null ? undefined : ({ "--tree-w": `${treeWidth}px` } as React.CSSProperties)}
        >
          <FileTree
            api={api}
            workspace={selected}
            refreshKey={refreshKey}
            onOpenFile={(path) => {
              if (selected === null) return;
              fileOpenSeq.current += 1;
              setFileOpen({ id: fileOpenSeq.current, refKey: refKey(selected), path });
            }}
          />
        </div>
        <div className="ws-splitter" data-testid="ws-splitter" onPointerDown={startResize} />
        <WorkspaceRightPane api={api} workspace={selected} fileOpen={fileOpen} />
      </div>
      {modal !== null && modal.type === "create" && (
        <Modal title="Создать проект" onClose={() => setModal(null)}>
          <form onSubmit={(event) => { event.preventDefault(); void handleCreate(); }}>
            <div className="ws-mode-toggle">
              <button type="button" className={createMode === "empty" ? "btn" : "btn-ghost"} data-testid="workspace-create-mode-empty" onClick={() => setCreateMode("empty")}>
                Пустой проект
              </button>
              <button type="button" className={createMode === "git" ? "btn" : "btn-ghost"} data-testid="workspace-create-mode-git" onClick={() => setCreateMode("git")}>
                Из GitHub
              </button>
            </div>
            {createMode === "git" && (
              <input
                data-testid="workspace-git-url"
                className="ws-name-input"
                value={gitUrl}
                onChange={(event) => {
                  const next = event.target.value;
                  setGitUrl(next);
                  const suggested = suggestProjectNameFromGitUrl(next);
                  if (suggested !== null) setName(suggested);
                }}
                placeholder="https://github.com/owner/repo"
                aria-label="URL репозитория GitHub"
              />
            )}
            <input
              data-testid="workspace-name-input"
              className="ws-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="имя проекта (a-z, 0-9, . _ -)"
              aria-label="Имя нового проекта"
              autoFocus={createMode === "empty"}
            />
            {createMode === "git" && (
              <p className="ws-hint">
                {gitConfigured === true ? "Токен задан — приватные репозитории доступны." : "Без токена доступны только публичные репозитории."}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)} data-testid="workspace-create-cancel">
                Отмена
              </button>
              <button
                type="submit"
                className="btn"
                disabled={busy || name.trim() === "" || (createMode === "git" && gitUrl.trim() === "")}
                data-testid="workspace-create-submit"
              >
                {busy ? (createMode === "git" ? "Клонирование…" : "Создаётся…") : createMode === "git" ? "Клонировать" : "Создать"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal !== null && modal.type === "git-token" && (
        <Modal title="Git-доступ" onClose={() => setModal(null)}>
          <p className="ws-modal-text">GitHub-токен для приватных репозиториев. Значение не показывается после сохранения.</p>
          <input
            data-testid="git-token-input"
            className="ws-name-input"
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="github_pat_… / ghp_…"
            aria-label="GitHub-токен"
          />
          <div className="modal-actions">
            {gitConfigured === true && (
              <button type="button" className="btn-danger" disabled={busy} onClick={() => void clearGitToken()} data-testid="git-token-clear">
                Забыть токен
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={() => setModal(null)} data-testid="git-token-cancel">
              Отмена
            </button>
            <button type="button" className="btn" disabled={busy || tokenInput.trim() === ""} onClick={() => void saveGitToken()} data-testid="git-token-save">
              Сохранить
            </button>
          </div>
        </Modal>
      )}
      {modal !== null && modal.type === "delete" && (
        <Modal title="Удалить проект" onClose={() => setModal(null)}>
          <p className="ws-modal-text">
            Удалить проект <code>{modal.project.name}</code>? Каталог {modal.project.path} будет удалён безвозвратно.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setModal(null)} data-testid="workspace-delete-cancel">
              Отмена
            </button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => void confirmDelete()} data-testid={`workspace-delete-${modal.project.name}`}>
              {busy ? "Удаляется…" : "Удалить"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );

  function startResize(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    const container = pageRef.current;
    if (container === null) return;
    const startX = e.clientX;
    const startW = treeWidth ?? Math.round(container.clientWidth / 3);
    let lastW = startW;
    const onMove = (ev: PointerEvent): void => {
      const maxW = container.clientWidth - 360; // room for the list pane and a void minimum
      lastW = Math.min(Math.max(startW + (ev.clientX - startX), 220), Math.max(maxW, 220));
      setTreeWidth(lastW);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(TREE_WIDTH_KEY, String(lastW));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
}
