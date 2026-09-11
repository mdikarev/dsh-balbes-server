import { useState, type ReactNode } from "react";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import SessionsTab from "./SessionsTab";

/** Один таб правой панели: id, подпись и рендер содержимого. */
export interface RightPaneTab {
  id: string;
  label: string;
  render: (reloadKey: number) => ReactNode;
}

interface WorkspaceRightPaneProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
}

/**
 * Правая зона страницы «Проекты»: плашка табов сверху и панель активного таба.
 * Табы описаны данными — следующий таб добавляется одной записью в TAB_DEFS.
 * Кнопка «Обновить» — общая для панели: она поднимает reloadKey, на который
 * реагирует активный таб.
 */
export default function WorkspaceRightPane({ api, workspace }: WorkspaceRightPaneProps) {
  const [active, setActive] = useState("sessions");
  const [reloadKey, setReloadKey] = useState(0);

  const tabs: RightPaneTab[] = [
    {
      id: "sessions",
      label: "Сессии",
      render: (key) => <SessionsTab api={api} workspace={workspace} reloadKey={key} />
    }
  ];
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  if (current === undefined) return null;

  return (
    <div className="ws-pane ws-right-pane" data-testid="ws-right-pane">
      <div className="ws-tabstrip" role="tablist" aria-label="Содержимое воркспейса" data-testid="ws-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`ws-tab-${tab.id}`}
            aria-selected={tab.id === current.id}
            aria-controls={`ws-tabpanel-${tab.id}`}
            className={tab.id === current.id ? "ws-tab active" : "ws-tab"}
            data-testid={`ws-tab-${tab.id}`}
            onClick={() => {
              setActive(tab.id);
              setReloadKey((key) => key + 1);
            }}
          >
            {tab.label}
          </button>
        ))}
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
        id={`ws-tabpanel-${current.id}`}
        aria-labelledby={`ws-tab-${current.id}`}
        data-testid="ws-tabpanel"
      >
        {workspace === null ? (
          <p className="ws-placeholder" data-testid="right-pane-prompt">
            Выберите воркспейс
          </p>
        ) : (
          current.render(reloadKey)
        )}
      </div>
    </div>
  );
}
