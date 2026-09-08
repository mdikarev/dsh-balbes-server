import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceTreeEntry } from "dsh-balbes-contracts";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";

interface FileTreeProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
  refreshKey: number;
}

const ROOT = "";

function joinRel(dir: string, name: string): string {
  return dir === ROOT ? name : `${dir}/${name}`;
}

function dirIdOf(dir: string): string {
  return dir === ROOT ? "root" : dir.replace(/\//g, "_");
}

/**
 * Lazy directory tree keyed by relative dir path ("" = workspace root): the
 * root loads when a workspace is selected; each dir's children load on first
 * expand. `refreshKey` bumps re-read every expanded dir (used after fs events).
 */
export default function FileTree({ api, workspace, refreshKey }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Map<string, WorkspaceTreeEntry[]>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const lastWorkspace = useRef<WorkspaceRef | null>(null);
  const seq = useRef(0);

  const loadDir = useCallback(
    async (dir: string) => {
      if (workspace === null) return;
      const mySeq = ++seq.current;
      setLoading((s) => new Set(s).add(dir));
      setErrors((m) => {
        const next = new Map(m);
        next.delete(dir);
        return next;
      });
      try {
        const res = await api.readWorkspaceDir(workspace.scope, workspace.name, dir);
        if (mySeq !== seq.current) return; // superseded by a newer load
        setCache((m) => new Map(m).set(dir, res.entries));
      } catch (err) {
        if (mySeq !== seq.current) return;
        setErrors((m) => new Map(m).set(dir, err instanceof Error ? err.message : "load failed"));
      } finally {
        setLoading((s) => {
          const next = new Set(s);
          next.delete(dir);
          return next;
        });
      }
    },
    [api, workspace]
  );

  // workspace switch: full reset
  useEffect(() => {
    if (!isSameRef(lastWorkspace.current, workspace)) {
      lastWorkspace.current = workspace;
      setExpanded(new Set());
      setCache(new Map());
      setErrors(new Map());
    }
  }, [workspace]);

  // (re)load the root when the selection or refreshKey changes
  useEffect(() => {
    if (workspace === null) return;
    void loadDir(ROOT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, refreshKey]);

  // on refreshKey bumps only, re-read every expanded dir (external changes).
  // `expanded` is deliberately omitted from deps: on a workspace switch the
  // reset effect above clears it in the same commit, and this effect must not
  // fire for stale expansion state against the new workspace.
  useEffect(() => {
    if (workspace === null) return;
    for (const dir of expanded) void loadDir(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const toggle = (dir: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void loadDir(dir);
      }
      return next;
    });
  };

  if (workspace === null) {
    return (
      <div className="ws-pane ws-tree-pane" data-testid="tree-pane">
        <div className="ws-pane-header"><h2>Содержимое</h2></div>
        <p className="ws-placeholder" data-testid="tree-prompt">Выберите воркспейс</p>
      </div>
    );
  }

  const rootEntries = cache.get(ROOT);
  const rootError = errors.get(ROOT);
  const rootLoaded = rootEntries !== undefined || rootError !== undefined;

  return (
    <div className="ws-pane ws-tree-pane" data-testid="tree-pane">
      <div className="ws-pane-header">
        <h2>{workspace.scope === "home" ? "Дом агента" : workspace.name}</h2>
      </div>
      <div className="ws-tree">
        {!rootLoaded && <p className="ws-placeholder">Загрузка…</p>}
        {rootLoaded && rootEntries !== undefined && rootEntries.length === 0 && (
          <p className="ws-placeholder" data-testid="tree-empty">Каталог пуст</p>
        )}
        {rootError !== undefined && (
          <p className="form-error" data-testid="tree-load-error">
            {rootError}{" "}
            <button type="button" className="btn-ghost" onClick={() => void loadDir(ROOT)}>
              Повторить
            </button>
          </p>
        )}
        {rootEntries !== undefined &&
          rootEntries
            .filter((e) => e.kind === "dir")
            .map((d) => (
              <DirRow
                key={d.name}
                dir={joinRel(ROOT, d.name)}
                depth={0}
                expanded={expanded}
                cache={cache}
                errors={errors}
                loading={loading}
                onToggle={toggle}
              />
            ))}
        {rootEntries !== undefined &&
          rootEntries
            .filter((e) => e.kind !== "dir")
            .map((e) => <LeafRow key={e.name} entry={e} depth={0} />)}
      </div>
    </div>
  );
}

interface DirRowProps {
  dir: string;
  depth: number;
  expanded: Set<string>;
  cache: Map<string, WorkspaceTreeEntry[]>;
  errors: Map<string, string>;
  loading: Set<string>;
  onToggle(dir: string): void;
}

function DirRow({ dir, depth, expanded, cache, errors, loading, onToggle }: DirRowProps) {
  const name = dir.split("/").pop() ?? dir;
  const open = expanded.has(dir);
  const children = cache.get(dir);
  const hasChildren = children !== undefined && children.length > 0;
  const id = dirIdOf(dir);
  return (
    <div className="ws-tree-branch">
      <button
        type="button"
        className="ws-tree-row"
        data-testid={`tree-dir-${id}`}
        aria-expanded={open}
        onClick={() => onToggle(dir)}
        style={{ paddingLeft: 10 + depth * 14 }}
      >
        <span className={open ? "ws-caret open" : "ws-caret"}>▸</span>
        <span className="ws-dir">{name}</span>
        {loading.has(dir) && <span className="ws-file">…</span>}
      </button>
      {open && children !== undefined && children.length === 0 && (
        <p className="ws-tree-empty-note" data-testid={`tree-empty-${id}`}>Каталог пуст</p>
      )}
      {open && hasChildren &&
        children
          .filter((c) => c.kind === "dir")
          .map((c) => <DirRow key={c.name} dir={joinRel(dir, c.name)} depth={depth + 1} expanded={expanded} cache={cache} errors={errors} loading={loading} onToggle={onToggle} />)}
      {open && hasChildren &&
        children
          .filter((c) => c.kind !== "dir")
          .map((c) => <LeafRow key={c.name} entry={c} depth={depth + 1} />)}
      {open && errors.has(dir) && (
        <p className="form-error">
          {errors.get(dir)}{" "}
          <button type="button" className="btn-ghost" onClick={() => onToggle(dir)}>
            Повторить
          </button>
        </p>
      )}
    </div>
  );
}

function LeafRow({ entry, depth }: { entry: WorkspaceTreeEntry; depth: number }) {
  return (
    <span className="ws-leaf" style={{ paddingLeft: 10 + depth * 14 }}>
      <span className="ws-file">
        {entry.name}
        {entry.kind === "link" ? " →" : ""}
      </span>
    </span>
  );
}
