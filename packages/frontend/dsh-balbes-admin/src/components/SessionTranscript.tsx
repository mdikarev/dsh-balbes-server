import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionsReadResponse, TranscriptEntry } from "dsh-balbes-contracts";
import type { AdminApi } from "../api/client";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";
import { formatCreatedAt } from "../format";

interface SessionTranscriptProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
  sessionId: string;
  reloadKey: number;
}

function label(entry: TranscriptEntry): string {
  if (entry.kind === "tool-call") return `Вызов инструмента: ${entry.toolName ?? "—"}`;
  if (entry.kind === "tool-result") return entry.isError === true ? "Результат инструмента (ошибка)" : "Результат инструмента";
  if (entry.kind === "context") {
    if (entry.form !== undefined) return `Контекст: ${entry.form}`;
    return entry.role === "system" ? "Системный промпт" : "Служебный контекст";
  }
  return entry.role === "assistant" ? "Модель" : entry.role === "system" ? "Система" : "Владелец";
}

export default function SessionTranscript({ api, workspace, sessionId, reloadKey }: SessionTranscriptProps) {
  const [data, setData] = useState<SessionsReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastWorkspace = useRef<WorkspaceRef | null>(null);
  const generation = useRef(0);
  const loadSeq = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<void> => {
    if (workspace === null) return;
    const myGen = generation.current;
    const mySeq = ++loadSeq.current;
    const stale = (): boolean => generation.current !== myGen || loadSeq.current !== mySeq;
    // сброс на старте каждого запроса: смена сессии или reload не должны
    // показывать транскрипт прошлой сессии, пока новая читается
    setData(null);
    setError(null);
    try {
      const res = await api.readSession(workspace.scope, workspace.name, sessionId);
      if (!stale()) setData(res);
    } catch (err) {
      if (!stale()) {
        setData(null);
        setError(err instanceof Error ? err.message : "session read failed");
      }
    }
  }, [api, workspace, sessionId]);

  useEffect(() => {
    if (!isSameRef(lastWorkspace.current, workspace)) {
      lastWorkspace.current = workspace;
      generation.current += 1;
      setData(null);
      setError(null);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, sessionId, reloadKey]);

  useEffect(() => {
    if (bodyRef.current !== null) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [data]);

  if (workspace === null) return null;

  if (error !== null) {
    return (
      <p className="form-error ws-tab-error" role="alert" data-testid="session-transcript-error">
        Не удалось загрузить диалог: {error}{" "}
        <button type="button" className="btn-ghost" data-testid="session-transcript-retry" onClick={() => void load()}>
          Повторить
        </button>
      </p>
    );
  }
  if (data === null) return <p className="ws-placeholder" data-testid="session-transcript-loading">Загрузка…</p>;
  if (data.messages.length === 0) return <p className="ws-placeholder" data-testid="session-transcript-empty">Сессия без сообщений</p>;

  return (
    <div className="ws-transcript" data-testid="session-transcript" ref={bodyRef}>
      {data.messages.map((entry, index) => (
        <div className="ws-transcript-entry" data-testid={`session-entry-${index}`} key={`${entry.seq}-${index}`}>
          <div className="ws-transcript-head">
            <span>{label(entry)}</span>
            <span className="ws-transcript-time">{formatCreatedAt(entry.time)}</span>
            {entry.inContext ? null : <span className="ws-transcript-shadowed">не в контексте</span>}
          </div>
          {entry.kind === "message" ? (
            <p className="ws-transcript-text">{entry.text}</p>
          ) : (
            <details className="ws-transcript-details">
              <summary>подробнее</summary>
              <pre className="ws-transcript-pre">{entry.detail ?? entry.text}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
