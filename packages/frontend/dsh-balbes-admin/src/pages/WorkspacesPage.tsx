import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminApi } from "../api/client";
import type { WorkspaceListResponse } from "dsh-balbes-contracts";
import WorkspaceList from "../components/WorkspaceList";
import FileTree from "../components/FileTree";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";

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
  const pageRef = useRef<HTMLDivElement>(null);
  const [treeWidth, setTreeWidth] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(TREE_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null; // null = CSS default (33%)
  });

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

  useEffect(() => {
    void load();
  }, [load]);

  // keep the selection valid: project rows can disappear on refresh/events
  useEffect(() => {
    if (data === null || selected === null) return;
    if (selected.scope === "project" && !data.projects.some((p) => p.name === selected.name)) {
      setSelected(null);
      localStorage.removeItem(SELECTED_KEY);
    }
  }, [data, selected]);

  const select = useCallback((ref: WorkspaceRef): void => {
    setSelected(ref);
    localStorage.setItem(SELECTED_KEY, JSON.stringify(ref));
  }, []);

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
      <WorkspaceList
        homePath={data.home.path}
        projects={data.projects}
        selected={selected}
        busy={busy}
        onSelect={select}
        onCreate={() => {/* modal wiring lands in Task 11 */}}
        onDelete={() => {/* modal wiring lands in Task 11 */}}
      />
      <div
        className="ws-tree-shell"
        style={treeWidth === null ? undefined : ({ "--tree-w": `${treeWidth}px` } as React.CSSProperties)}
      >
        <FileTree api={api} workspace={selected} refreshKey={refreshKey} />
      </div>
      <div className="ws-splitter" data-testid="ws-splitter" onPointerDown={startResize} />
      <div className="ws-pane ws-void-pane" data-testid="ws-void-pane" />
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
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(TREE_WIDTH_KEY, String(lastW));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
}
