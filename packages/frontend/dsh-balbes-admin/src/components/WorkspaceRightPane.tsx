import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceSessionInfo } from "dsh-balbes-contracts";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";
import SessionsTab from "./SessionsTab";
import SessionTranscript from "./SessionTranscript";

interface SessionTab {
  id: string;
  sessionId: string;
  title: string | null;
}

interface WorkspaceRightPaneProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
}

function sessionLabel(title: string | null): string {
  return title?.trim() ? title : "Без заголовка";
}

/**
 * Правая зона страницы «Проекты»: таб «Сессии» и динамические табы открытых
 * сессий. Клик по строке сессии открывает (или фокусирует) её таб, «×» закрывает
 * таб и переводит фокус на соседний. Смена воркспейса сбрасывает набор сессионных
 * табов и возвращает активным таб «Сессии». Кнопка «Обновить» поднимает reloadKey,
 * на который реагирует активный таб.
 */
export default function WorkspaceRightPane({ api, workspace }: WorkspaceRightPaneProps) {
  const [active, setActive] = useState("sessions");
  const [reloadKey, setReloadKey] = useState(0);
  const [sessionTabs, setSessionTabs] = useState<SessionTab[]>([]);
  const lastWorkspace = useRef<WorkspaceRef | null>(null);

  useEffect(() => {
    if (!isSameRef(lastWorkspace.current, workspace)) {
      lastWorkspace.current = workspace;
      setSessionTabs([]);
      setActive("sessions");
    }
  }, [workspace]);

  const openSession = useCallback((session: WorkspaceSessionInfo): void => {
    const id = `session:${session.id}`;
    setSessionTabs((tabs) => (tabs.some((tab) => tab.id === id) ? tabs : [...tabs, { id, sessionId: session.id, title: session.title }]));
    setActive(id);
  }, []);

  const closeSession = useCallback(
    (id: string): void => {
      const index = sessionTabs.findIndex((tab) => tab.id === id);
      const next = sessionTabs.filter((tab) => tab.id !== id);
      setSessionTabs(next);
      if (active === id) setActive(next[Math.max(0, index - 1)]?.id ?? "sessions");
    },
    [sessionTabs, active]
  );

  const openTab = sessionTabs.find((tab) => tab.id === active);
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
        {sessionTabs.map((tab) => {
          const selected = tab.id === active;
          const label = sessionLabel(tab.title);
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
                title={`${label} · ${tab.sessionId}`}
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
                onClick={() => closeSession(tab.id)}
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
          <SessionTranscript api={api} workspace={workspace} sessionId={openTab.sessionId} reloadKey={reloadKey} />
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
