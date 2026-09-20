import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFileResponse } from "dsh-balbes-contracts";
import type { AdminApi } from "../api/client";
import { detectFileRenderKind, languageForPath } from "../fileRender";
import type { WorkspaceRef } from "../workspaceRef";
import { isSameRef } from "../workspaceRef";
import CodeView from "./CodeView";
import MarkdownView from "./MarkdownView";

interface FileViewProps {
  api: AdminApi;
  workspace: WorkspaceRef | null;
  path: string;
  reloadKey: number;
}

export default function FileView({ api, workspace, path, reloadKey }: FileViewProps) {
  const [data, setData] = useState<WorkspaceFileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [markdownSource, setMarkdownSource] = useState(false);
  const lastWorkspace = useRef<WorkspaceRef | null>(null);
  const generation = useRef(0);
  const loadSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (workspace === null) return;
    const myGen = generation.current;
    const mySeq = ++loadSeq.current;
    const stale = (): boolean => generation.current !== myGen || loadSeq.current !== mySeq;
    setData(null);
    setError(null);
    try {
      const res = await api.readWorkspaceFile(workspace.scope, workspace.name, path);
      if (!stale()) setData(res);
    } catch (err) {
      if (!stale()) {
        setData(null);
        setError(err instanceof Error ? err.message : "file read failed");
      }
    }
  }, [api, workspace, path]);

  useEffect(() => {
    if (!isSameRef(lastWorkspace.current, workspace)) {
      lastWorkspace.current = workspace;
      generation.current += 1;
      setData(null);
      setError(null);
    }
  }, [workspace]);

  useEffect(() => {
    setMarkdownSource(false);
  }, [workspace, path]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, path, reloadKey]);

  if (workspace === null) return null;

  if (error !== null) {
    return (
      <p className="form-error ws-tab-error" role="alert" data-testid="file-error">
        Не удалось открыть файл: {error}{" "}
        <button type="button" className="btn-ghost" data-testid="file-retry" onClick={() => void load()}>
          Повторить
        </button>
      </p>
    );
  }
  if (data === null) return <p className="ws-placeholder" data-testid="file-loading">Загрузка…</p>;

  const file = data.file;
  if (file.kind === "binary") {
    return (
      <p className="ws-placeholder" data-testid="file-binary">
        Это бинарный файл ({file.size} байт) — просмотр недоступен
      </p>
    );
  }
  if (file.kind === "link") {
    return (
      <p className="ws-placeholder" data-testid="file-link">
        Символические ссылки не открываются
      </p>
    );
  }
  if (file.content === "") {
    return <p className="ws-placeholder" data-testid="file-empty">Файл пуст</p>;
  }
  const renderKind = detectFileRenderKind(path, file.content);
  const language = languageForPath(path);
  return (
    <div className="ws-file-view" data-testid="file-view">
      {file.truncated && (
        <p className="ws-file-note" data-testid="file-truncated">
          Файл показан не полностью (лимит 256 КиБ)
        </p>
      )}
      {renderKind === "markdown" && (
        <div className="ws-file-toolbar" role="group" aria-label="Режим просмотра" data-testid="file-mode-toggle">
          <button
            type="button"
            className={markdownSource ? "btn-ghost" : "btn-ghost active"}
            aria-pressed={!markdownSource}
            data-testid="file-mode-preview"
            onClick={() => setMarkdownSource(false)}
          >
            Просмотр
          </button>
          <button
            type="button"
            className={markdownSource ? "btn-ghost active" : "btn-ghost"}
            aria-pressed={markdownSource}
            data-testid="file-mode-source"
            onClick={() => setMarkdownSource(true)}
          >
            Исходник
          </button>
        </div>
      )}
      {renderKind === "markdown" && !markdownSource ? (
        <MarkdownView content={file.content} />
      ) : renderKind === "code" && language !== null ? (
        <CodeView content={file.content} language={language} />
      ) : (
        <pre className="ws-file-content" data-testid="file-content">{file.content}</pre>
      )}
    </div>
  );
}
