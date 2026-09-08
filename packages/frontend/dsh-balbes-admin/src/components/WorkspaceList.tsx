import { useEffect, useRef, useState } from "react";
import type { WorkspaceProject } from "dsh-balbes-contracts";
import type { WorkspaceRef } from "../workspaceRef";
import { refKey } from "../workspaceRef";

/** Width of the floating action menu, used to keep it inside the viewport. */
const MENU_WIDTH = 150;
const MENU_GAP = 4;

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
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (openMenu === null) return;
    const close = (): void => setOpenMenu(null);
    const onPointer = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) close();
    };
    // The menu floats above the list; re-anchor it or close it when the pane
    // scrolls under it or the viewport changes.
    const rows = rowsRef.current;
    rows?.addEventListener("scroll", close);
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      rows?.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [openMenu]);

  function openMenuFor(key: string, button: HTMLButtonElement): void {
    if (openMenu === key) {
      setOpenMenu(null);
      setMenuPos(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    setMenuPos({
      left: Math.max(rect.right - MENU_WIDTH, 8),
      top: rect.bottom + MENU_GAP
    });
    setOpenMenu(key);
  }

  const homeRef: WorkspaceRef = { scope: "home" };
  const menuProject =
    openMenu !== null ? projects.find((p) => refKey({ scope: "project", name: p.name }) === openMenu) : undefined;
  return (
    <div className="ws-pane ws-list-pane" ref={rootRef} data-testid="workspace-list-pane">
      <div className="ws-pane-header">
        <h2>Воркспейсы</h2>
        <button type="button" className="icon-btn ws-add" aria-label="Создать проект" data-testid="workspace-create-open" onClick={onCreate} disabled={busy}>
          +
        </button>
      </div>
      <ul className="ws-rows" ref={rowsRef}>
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
                  onClick={(e) => openMenuFor(key, e.currentTarget)}
                  disabled={busy}
                >
                  ⋮
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {projects.length === 0 && <p className="ws-empty">Проектов нет.</p>}
      {openMenu !== null && menuPos !== null && menuProject !== undefined && (
        <div className="ws-menu" data-testid={`ws-dropdown-${openMenu}`} style={{ left: menuPos.left, top: menuPos.top }}>
          <button
            type="button"
            className="ws-menu-item danger"
            data-testid={`ws-delete-${menuProject.name}`}
            onClick={() => {
              setOpenMenu(null);
              setMenuPos(null);
              onDelete(menuProject);
            }}
          >
            Удалить
          </button>
        </div>
      )}
    </div>
  );
}
