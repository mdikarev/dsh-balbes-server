import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceSessionInfo } from "dsh-balbes-contracts";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef, refKey } from "../workspaceRef";
import { formatCreatedAt } from "../format";
import SessionsTab from "./SessionsTab";
import SessionTranscript from "./SessionTranscript";
import FileView from "./FileView";

interface SessionTab {
  kind: "session";
  id: string;
  sessionId: string;
  title: string | null;
  channel: string;
  createdAt: string;
  /** refKey воркспейса, в котором таб открыт. */
  refKey: string;
}
interface FileTab {
  kind: "file";
  id: string;
  path: string;
  refKey: string;
}
type Tab = SessionTab | FileTab;

/** Одноразовый запрос «открой файл» из страницы: дерево живёт в соседней колонке. */
export interface FileOpenRequest {
  id: number;
  refKey: string;
  path: string;
}

interface WorkspaceRightPaneProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
  fileOpen?: FileOpenRequest | null;
}

function sessionLabel(title: string | null): string {
  return title?.trim() ? title : "Без заголовка";
}

function fileLabel(path: string): string {
  return path.split("/").pop() ?? path;
}

export default function WorkspaceRightPane({ api, workspace, fileOpen = null }: WorkspaceRightPaneProps) {
  const [active, setActive] = useState("sessions");
  const [reloadKey, setReloadKey] = useState(0);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const lastWorkspace = useRef<WorkspaceRef | null>(null);

  useEffect(() => {
    if (!isSameRef(lastWorkspace.current, workspace)) {
      lastWorkspace.current = workspace;
      setTabs([]);
      setActive("sessions");
    }
  }, [workspace]);

  const openSession = useCallback(
    (session: WorkspaceSessionInfo): void => {
      if (workspace === null) return;
      const id = `session:${session.id}`;
      const key = refKey(workspace);
      setTabs((tabs) =>
        tabs.some((tab) => tab.id === id)
          ? tabs
          : [
              ...tabs,
              {
                kind: "session",
                id,
                sessionId: session.id,
                title: session.title,
                channel: session.channel,
                createdAt: session.createdAt,
                refKey: key
              }
            ]
      );
      setActive(id);
    },
    [workspace]
  );

  const openFile = useCallback(
    (path: string): void => {
      if (workspace === null) return;
      const key = refKey(workspace);
      const id = `file:${key}:${path}`;
      setTabs((tabs) => (tabs.some((tab) => tab.id === id) ? tabs : [...tabs, { kind: "file", id, path, refKey: key }]));
      setActive(id);
    },
    [workspace]
  );

  // Запрос приходит от страницы, пока дерево в соседней колонке: новый id
  // открывает/фокусирует таб, чужой refKey игнорируется.
  useEffect(() => {
    if (fileOpen === null || workspace === null) return;
    if (fileOpen.refKey !== refKey(workspace)) return;
    openFile(fileOpen.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileOpen]);

  const closeTab = useCallback(
    (id: string): void => {
      const index = tabs.findIndex((tab) => tab.id === id);
      const next = tabs.filter((tab) => tab.id !== id);
      setTabs(next);
      if (active === id) setActive(index === 0 ? "sessions" : (next[index - 1]?.id ?? "sessions"));
    },
    [tabs, active]
  );

  const currentRefKey = workspace === null ? null : refKey(workspace);
  const visibleTabs = currentRefKey === null ? [] : tabs.filter((tab) => tab.refKey === currentRefKey);
  const openTab = visibleTabs.find((tab) => tab.id === active);
  const panelId = `ws-tabpanel-${active}`;

  return (
    <div className="ws-pane ws-right-pane" data-testid="ws-right-pane">
      <div className="ws-tabstrip" role="tablist" aria-label="Содержимое воркспейса" data-testid="ws-tabs">
        <button
          type="button"
          role="tab"
          id="ws-tab-sessions"
          aria-selected={active === "sessions"}
          aria-controls="ws-tabpanel-sessions"
          className={active === "sessions" ? "ws-tab active" : "ws-tab"}
          data-testid="ws-tab-sessions"
          onClick={() => {
            setActive("sessions");
            setReloadKey((key) => key + 1);
          }}
        >
          Сессии
        </button>
        {visibleTabs.map((tab) => {
          const selected = tab.id === active;
          const label = tab.kind === "file" ? fileLabel(tab.path) : sessionLabel(tab.title);
          const title =
            tab.kind === "file" ? tab.path : `${label} · ${tab.channel} · ${formatCreatedAt(tab.createdAt)}`;
          return (
            <span className={selected ? "ws-tab-group active" : "ws-tab-group"} key={tab.id}>
              <button
                type="button"
                role="tab"
                id={`ws-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`ws-tabpanel-${tab.id}`}
                className={selected ? "ws-tab active" : "ws-tab"}
                data-testid={`ws-tab-${tab.id}`}
                title={title}
                onClick={() => {
                  setActive(tab.id);
                  setReloadKey((key) => key + 1);
                }}
              >
                {label}
              </button>
              <button
                type="button"
                className="ws-tab-close"
                aria-label={`Закрыть ${label}`}
                data-testid={`ws-tab-close-${tab.id}`}
                onClick={() => closeTab(tab.id)}
              >
                ×
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className="btn-ghost ws-tabstrip-refresh"
          data-testid="ws-refresh"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          Обновить
        </button>
      </div>
      <div
        className="ws-tabpanel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`ws-tab-${active}`}
        data-testid="ws-tabpanel"
      >
        {workspace === null ? (
          <p className="ws-placeholder" data-testid="right-pane-prompt">
            Выберите воркспейс
          </p>
        ) : openTab !== undefined ? (
          openTab.kind === "file" ? (
            <FileView key={openTab.id} api={api} workspace={workspace} path={openTab.path} reloadKey={reloadKey} />
          ) : (
            <SessionTranscript api={api} workspace={workspace} sessionId={openTab.sessionId} reloadKey={reloadKey} />
          )
        ) : (
          <SessionsTab
            api={api}
            workspace={workspace}
            reloadKey={reloadKey}
            activeSessionId={active.startsWith("session:") ? active.slice("session:".length) : null}
            onOpenSession={openSession}
          />
        )}
      </div>
    </div>
  );
}
