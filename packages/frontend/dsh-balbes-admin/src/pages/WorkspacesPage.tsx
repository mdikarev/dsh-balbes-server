import { useCallback, useEffect, useState } from "react";
import type { AdminApi } from "../api/client";
import type { WorkspaceListResponse, WorkspaceProject } from "dsh-balbes-contracts";

interface WorkspacesPageProps {
  api: AdminApi;
}

function formatDate(iso?: string): string {
  return iso === undefined ? "—" : new Date(iso).toLocaleString("ru-RU");
}

/**
 * Workspaces page: the reserved agent home shown as its own section, then the
 * project list with a create form and confirm-gated delete per project.
 */
export default function WorkspacesPage({ api }: WorkspacesPageProps) {
  const [data, setData] = useState<WorkspaceListResponse | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setData(await api.listWorkspaces());
  }, [api]);

  // load = refresh with the failure surfaced in state; used on mount and by the
  // retry button so an initial load failure shows an error instead of a spinner.
  const load = useCallback(async () => {
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

  async function handleCreate(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createWorkspace(trimmed);
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(project: WorkspaceProject): Promise<void> {
    const ok = window.confirm(`Удалить проект «${project.name}»? Каталог ${project.path} будет удалён безвозвратно.`);
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteWorkspace(project.name);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  }

  if (data === null) {
    return (
      <div className="page">
        <h1>Воркспейсы</h1>
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
          <p className="lead">Загрузка…</p>
        )}
      </div>
    );
  }

  return (
    <div className="page" data-testid="workspaces-page">
      <h1>Воркспейсы</h1>
      <p className="lead">Дом агента и проекты на сервере — каталоги в $DSH_HOME.</p>

      <section className="ws-section">
        <h2>Дом агента</h2>
        <div className="card ws-home-card">
          <code data-testid="workspace-home-path">{data.home.path}</code>
          <span className="chip">зарезервирован</span>
        </div>
      </section>

      <section className="ws-section">
        <h2>Проекты</h2>
        {error !== null && (
          <p className="form-error" role="alert" data-testid="workspace-error">
            {error}
          </p>
        )}
        <form
          className="ws-create"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <input
            data-testid="workspace-name-input"
            className="ws-name-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="имя проекта (a-z, 0-9, . _ -)"
            aria-label="Имя нового проекта"
          />
          <button type="submit" className="btn" disabled={busy} data-testid="workspace-create-submit">
            {busy ? "Создаётся…" : "Создать проект"}
          </button>
        </form>

        {data.projects.length === 0 ? (
          <p className="ws-empty">Проектов пока нет.</p>
        ) : (
          <ul className="ws-list">
            {data.projects.map((project) => (
              <li className="card ws-project" key={project.name} data-testid={`workspace-project-${project.name}`}>
                <div className="ws-project-main">
                  <code className="ws-project-name">{project.name}</code>
                  <code className="ws-project-path">{project.path}</code>
                </div>
                <span className="ws-project-date">{formatDate(project.createdAt)}</span>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => void handleDelete(project)}
                  disabled={busy}
                  data-testid={`workspace-delete-${project.name}`}
                >
                  Удалить
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
