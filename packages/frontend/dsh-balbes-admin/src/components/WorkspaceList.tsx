import { useEffect, useRef, useState } from "react";
import type { WorkspaceProject } from "dsh-balbes-contracts";
import type { WorkspaceRef } from "../workspaceRef";
import { refKey } from "../workspaceRef";

interface WorkspaceListProps {
  homePath: string;
  projects: WorkspaceProject[];
  selected: WorkspaceRef | null;
  busy: boolean;
  onSelect(ref: WorkspaceRef): void;
  onCreate(): void;
  onDelete(p: WorkspaceProject): void;
}

/** Pinned agent home + projects, each row with a ⋮ action menu (delete today). */
export default function WorkspaceList({ homePath, projects, selected, busy, onSelect, onCreate, onDelete }: WorkspaceListProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openMenu === null) return;
    const onPointer = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [openMenu]);

  const homeRef: WorkspaceRef = { scope: "home" };
  return (
    <div className="ws-pane ws-list-pane" ref={rootRef} data-testid="workspace-list-pane">
      <div className="ws-pane-header">
        <h2>Воркспейсы</h2>
        <button type="button" className="icon-btn ws-add" aria-label="Создать проект" data-testid="workspace-create-open" onClick={onCreate} disabled={busy}>
          +
        </button>
      </div>
      <ul className="ws-rows">
        <li className="ws-row-wrap" data-testid="ws-row-wrap-home">
          <button
            type="button"
            className={refKey(homeRef) === (selected !== null ? refKey(selected) : "") ? "ws-row active" : "ws-row"}
            data-testid="ws-row-home"
            onClick={() => onSelect(homeRef)}
          >
            <span className="ws-row-main">
              <code>Дом агента</code>
              <span className="ws-row-path">{homePath}</span>
            </span>
          </button>
          <span className="chip">зарезервирован</span>
        </li>
        {projects.map((p) => {
          const ref: WorkspaceRef = { scope: "project", name: p.name };
          const key = refKey(ref);
          const active = key === (selected !== null ? refKey(selected) : "");
          return (
            <li className="ws-row-wrap" key={p.name} data-testid={`ws-row-wrap-${key}`}>
              <button type="button" className={active ? "ws-row active" : "ws-row"} data-testid={`ws-row-${key}`} onClick={() => onSelect(ref)}>
                <span className="ws-row-main">
                  <code>{p.name}</code>
                  <span className="ws-row-path">{p.path}</span>
                </span>
              </button>
              <div className="ws-row-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Действия для «${p.name}»`}
                  aria-expanded={openMenu === key}
                  data-testid={`ws-menu-${key}`}
                  onClick={() => setOpenMenu(openMenu === key ? null : key)}
                  disabled={busy}
                >
                  ⋮
                </button>
                {openMenu === key && (
                  <div className="ws-menu" data-testid={`ws-dropdown-${key}`}>
                    <button
                      type="button"
                      className="ws-menu-item danger"
                      data-testid={`ws-delete-${p.name}`}
                      onClick={() => {
                        setOpenMenu(null);
                        onDelete(p);
                      }}
                    >
                      Удалить
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {projects.length === 0 && <p className="ws-empty">Проектов нет.</p>}
    </div>
  );
}
