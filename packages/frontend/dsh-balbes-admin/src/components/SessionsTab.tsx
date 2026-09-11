import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceSessionInfo } from "dsh-balbes-contracts";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";

interface SessionsTabProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
  /** Счётчик внешних обновлений (кнопка «Обновить», клик по табу). */
  reloadKey: number;
}

/**
 * Время создания сессии: ru-RU, с ISO в качестве честного fallback. Пустая
 * (или пробельная) строка — отсутствие времени, и тогда показывается заглушка:
 * пустая ячейка читалась бы как сломанная вёрстка.
 */
function formatCreatedAt(iso: string): string {
  if (iso.trim() === "") return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ru-RU");
}

/**
 * Таб «Сессии»: список сессий выбранного воркспейса. Загрузка идёт при выборе
 * воркспейса, при смене reloadKey и по кнопке «Повторить» после ошибки. Ответы
 * защищены от гонок тем же приёмом «поколение + счётчик запроса», что в
 * FileTree: ответ прошлого воркспейса не применяется.
 */
export default function SessionsTab({ api, workspace, reloadKey }: SessionsTabProps) {
  const [sessions, setSessions] = useState<WorkspaceSessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastWorkspace = useRef<WorkspaceRef | null>(null);
  const generation = useRef(0);
  const loadSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (workspace === null) return;
    const myGen = generation.current;
    const mySeq = ++loadSeq.current;
    const stale = (): boolean => generation.current !== myGen || loadSeq.current !== mySeq;
    setError(null);
    try {
      const res = await api.listSessions(workspace.scope, workspace.name);
      if (!stale()) setSessions(res.sessions);
    } catch (err) {
      if (!stale()) {
        setSessions(null);
        setError(err instanceof Error ? err.message : "sessions failed");
      }
    }
  }, [api, workspace]);

  // смена воркспейса: полный сброс, включая отмену ответов прошлого воркспейса
  useEffect(() => {
    if (!isSameRef(lastWorkspace.current, workspace)) {
      lastWorkspace.current = workspace;
      generation.current += 1;
      setSessions(null);
      setError(null);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, reloadKey]);

  if (workspace === null) return null;

  if (error !== null) {
    return (
      <p className="form-error ws-tab-error" role="alert" data-testid="sessions-error">
        Не удалось загрузить сессии: {error}{" "}
        <button type="button" className="btn-ghost" data-testid="sessions-retry" onClick={() => void load()}>
          Повторить
        </button>
      </p>
    );
  }
  if (sessions === null) {
    return <p className="ws-placeholder" data-testid="sessions-loading">Загрузка…</p>;
  }
  if (sessions.length === 0) {
    return <p className="ws-placeholder" data-testid="sessions-empty">Сессий пока нет</p>;
  }
  return (
    <ul className="ws-rows ws-session-rows" data-testid="sessions-list">
      {sessions.map((session) => (
        <li key={session.id} className="ws-session-row" data-testid={`session-row-${session.id}`}>
          <span className="ws-session-title">{session.title?.trim() ? session.title : "Без заголовка"}</span>
          <span className="ws-session-meta">
            <span className="ws-session-channel">{session.channel}</span>
            <span className="ws-session-time">{formatCreatedAt(session.createdAt)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
