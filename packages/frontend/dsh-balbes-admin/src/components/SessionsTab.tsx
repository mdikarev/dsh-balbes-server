import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";

interface SessionsTabProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
  reloadKey: number;
}

/** Таб «Сессии»: список сессий воркспейса (наполняется в задаче 10). */
export default function SessionsTab(_props: SessionsTabProps) {
  return <p className="ws-placeholder" data-testid="sessions-loading">Загрузка…</p>;
}
