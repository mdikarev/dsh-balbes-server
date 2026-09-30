import { useCallback, useEffect, useState } from "react";
import { ApiError, type AdminApi } from "../api/client";
import type { MemoryAutonomyPolicy, MemoryProposal, MemoryType, WorkspaceProject } from "dsh-balbes-contracts";
import Modal from "../components/Modal";
import {
  MEMORY_TYPES,
  TYPE_LABELS,
  formatTime,
  levelKey,
  levelLabel,
  parseScope,
  parseTags,
  type LevelSelection
} from "./memoryShared";

const STATUS_LABELS: Record<MemoryProposal["status"], string> = {
  proposed: "ожидает",
  accepted: "принято",
  rejected: "отклонено"
};

function policyLine(policy: MemoryAutonomyPolicy): string {
  const immediate = policy.immediate.map((source) => (source === "owner" ? "владелец" : "явный remember")).join(" и ");
  const review = policy.review.map((source) => (source === "pipeline" ? "предложения пайплайна" : source)).join(", ");
  const auto = policy.autoApprove === "none" ? " Автоодобрения нет." : "";
  return "Политика: " + immediate + " пишут сразу; " + review + " — через ревью." + auto;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "secret-detected") return "текст похож на секрет — правка отклонена";
    if (error.code === "invalid-status") return "Предложение уже решено — очередь обновлена";
    if (error.code === "memory-unavailable") return "Память недоступна";
    return error.message;
  }
  return error instanceof Error ? error.message : "неизвестная ошибка";
}

export default function MemoryReviewQueue({
  api,
  onDecided
}: {
  api: AdminApi;
  /**
   * Fired after a successful owner decision so the tab shell can refresh its
   * pending counter. It deliberately reports NO number: this component's load is
   * filter-dependent (the level selector defaults to «Дом»), and a filtered count
   * must never reach a badge that canon defines as «счётчик ожидающих предложений».
   */
  onDecided?: () => void;
}) {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [level, setLevel] = useState<LevelSelection>({ kind: "global" });
  const [type, setType] = useState<MemoryType | "all">("all");
  const [tag, setTag] = useState("");
  const [showDecided, setShowDecided] = useState(false);
  const [proposals, setProposals] = useState<MemoryProposal[] | null>(null);
  const [policy, setPolicy] = useState<MemoryAutonomyPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MemoryProposal | null>(null);
  const [toReject, setToReject] = useState<MemoryProposal | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formType, setFormType] = useState<MemoryType>("note");
  const [formText, setFormText] = useState("");
  const [formTags, setFormTags] = useState("");
  const [formPinned, setFormPinned] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    setNotice(null);
    try {
      const res = await api.listMemoryReview({
        ...(level.kind === "all" ? {} : { scope: level }),
        ...(type === "all" ? {} : { type }),
        ...(tag.trim() === "" ? {} : { tag: tag.trim() }),
        // Отклонённых предложений в таблице не бывает: отказ удаляет строку,
        // поэтому «решённые» — это только принятые.
        ...(showDecided ? { status: ["accepted"] as MemoryProposal["status"][] } : {})
      });
      setProposals(res.proposals);
      setPolicy(res.policy);
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [api, level, type, tag, showDecided]);

  useEffect(() => {
    let cancelled = false;
    void api
      .listWorkspaces()
      .then((res) => { if (!cancelled) setProjects(res.projects); })
      .catch(() => { /* the level falls back to «Дом» */ });
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (level.kind !== "project") return;
    if (!projects.some((project) => project.name === level.name)) setLevel({ kind: "global" });
  }, [projects, level]);

  useEffect(() => { void load(); }, [load]);

  function openApprove(entry: MemoryProposal): void {
    setFormType(entry.type);
    setFormText(entry.text);
    setFormTags(entry.tags.join(", "));
    setFormPinned(false);
    setFormError(null);
    setEditing(entry);
  }

  async function confirmApprove(): Promise<void> {
    if (editing === null || busy) return;
    if (formText.trim() === "") { setFormError("Текст не может быть пустым"); return; }
    // Send only what changed: the server derives decidedEdit from the diff.
    const tags = parseTags(formTags);
    const patch: { id: string; type?: MemoryType; text?: string; tags?: string[]; pinned?: boolean } = { id: editing.id };
    if (formType !== editing.type) patch.type = formType;
    if (formText.trim() !== editing.text) patch.text = formText;
    if (tags.join(",") !== editing.tags.join(",")) patch.tags = tags;
    if (formPinned) patch.pinned = true;

    setBusy(true);
    setFormError(null);
    try {
      await api.approveMemoryReview(patch);
      onDecided?.();
      setEditing(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.code === "invalid-status")) {
        setEditing(null);
        await load();
        // The proposal was decided elsewhere: show the refreshed queue and, for a
        // stale decision, say so (canon: invalid-status — message plus reload).
        if (error.code === "invalid-status") setNotice(messageOf(error));
      } else {
        setFormError(messageOf(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmReject(): Promise<void> {
    if (toReject === null || busy) return;
    setBusy(true);
    try {
      await api.rejectMemoryReview({ id: toReject.id });
      onDecided?.();
      setToReject(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.code === "invalid-status")) {
        setToReject(null);
        await load();
        if (error.code === "invalid-status") setNotice(messageOf(error));
      } else {
        setLoadError(messageOf(error));
      }
    } finally {
      setBusy(false);
    }
  }

  const filtersActive = type !== "all" || tag.trim() !== "";

  return (
    <div className="memory-review" data-testid="memory-review">
      {policy !== null && (
        <p className="memory-review-policy" data-testid="memory-review-policy">{policyLine(policy)}</p>
      )}

      {notice !== null && (
        <p className="memory-review-notice" role="alert" data-testid="memory-review-notice">{notice}</p>
      )}

      <div className="memory-toolbar">
        <select
          className="memory-level"
          aria-label="Уровень предложения"
          data-testid="memory-review-level"
          value={levelKey(level)}
          onChange={(event) => {
            const value = event.target.value;
            setLevel(value === "all" ? { kind: "all" } : parseScope(value));
          }}
        >
          <option value="global">Дом</option>
          {projects.map((project) => (
            <option key={project.name} value={"project:" + project.name}>{project.name}</option>
          ))}
          <option value="all">Все</option>
        </select>

        <select
          className="memory-type-filter"
          aria-label="Тип предложения"
          data-testid="memory-review-type"
          value={type}
          onChange={(event) => setType(event.target.value as MemoryType | "all")}
        >
          <option value="all">Все типы</option>
          {MEMORY_TYPES.map((value) => <option key={value} value={value}>{TYPE_LABELS[value]}</option>)}
        </select>

        <input
          className="ws-name-input memory-tag-filter"
          aria-label="Тег предложения"
          data-testid="memory-review-tag"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder="тег"
        />

        <label className="memory-pinned-toggle">
          <input
            type="checkbox"
            data-testid="memory-review-decided-toggle"
            checked={showDecided}
            onChange={(event) => setShowDecided(event.target.checked)}
          />
          Показать решённые
        </label>

        <button type="button" className="btn-ghost" onClick={() => void load()} data-testid="memory-review-refresh">Обновить</button>
      </div>

      {proposals === null ? (
        <div className="ws-center-state">
          {loadError !== null ? (
            <>
              <p className="form-error" role="alert" data-testid="memory-review-load-error">{loadError}</p>
              <button type="button" className="btn" onClick={() => void load()} data-testid="memory-review-retry">Повторить</button>
            </>
          ) : (
            <p className="ws-placeholder">Загрузка...</p>
          )}
        </div>
      ) : loadError !== null ? (
        <div className="ws-center-state">
          <p className="form-error" role="alert" data-testid="memory-review-load-error">{loadError}</p>
          <button type="button" className="btn" onClick={() => void load()} data-testid="memory-review-retry">Повторить</button>
        </div>
      ) : proposals.length === 0 ? (
        <p className="ws-placeholder" data-testid={showDecided || filtersActive ? "memory-review-no-results" : "memory-review-empty"}>
          {showDecided ? "Решённых предложений нет" : filtersActive ? "Ничего не найдено" : "Очередь пуста"}
        </p>
      ) : (
        <ul className="memory-list" data-testid="memory-review-list">
          {proposals.map((entry) => (
            <li className="memory-row" key={entry.id} data-testid={"memory-review-row:" + entry.id}>
              <div className="memory-row-head">
                <span className="memory-type">{TYPE_LABELS[entry.type]}</span>
                <span className="memory-level-badge" data-testid="memory-review-row-level">{levelLabel(entry.scope)}</span>
                <span
                  className={"memory-review-status memory-review-status-" + entry.status}
                  data-testid={"memory-review-status:" + entry.id}
                >
                  {STATUS_LABELS[entry.status]}
                  {entry.decidedEdit ? " с правкой" : ""}
                </span>
                <span className="memory-provenance">
                  предложено пайплайном · {entry.originRef ?? "без источника"} · {formatTime(entry.proposedAt)}
                  {entry.decidedAt !== null && " · решено " + formatTime(entry.decidedAt)}
                </span>
                {entry.status === "proposed" && (
                  <span className="memory-row-actions">
                    <button type="button" className="btn" onClick={() => openApprove(entry)} data-testid={"memory-review-approve:" + entry.id}>Одобрить</button>
                    <button type="button" className="btn-danger" onClick={() => setToReject(entry)} data-testid={"memory-review-reject:" + entry.id}>Отклонить</button>
                  </span>
                )}
              </div>
              <p className="memory-row-text">{entry.text}</p>
              {entry.tags.length > 0 && (
                <div className="memory-tags">
                  {entry.tags.map((value) => <span className="memory-tag" key={value}>{value}</span>)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing !== null && (
        <Modal title="Одобрить предложение" onClose={() => setEditing(null)}>
          <p className="memory-scope-line">Уровень: <b>{levelLabel(editing.scope)}</b> (задаёт предложение)</p>
          <p className="memory-scope-line">Источник: <b>{editing.originRef ?? "не указан"}</b></p>
          <select
            className="memory-type-select"
            aria-label="Тип записи"
            data-testid="memory-review-form-type"
            value={formType}
            onChange={(event) => setFormType(event.target.value as MemoryType)}
          >
            {MEMORY_TYPES.map((value) => <option key={value} value={value}>{TYPE_LABELS[value]}</option>)}
          </select>
          <textarea
            className="memory-form-text"
            aria-label="Текст записи"
            data-testid="memory-review-form-text"
            value={formText}
            onChange={(event) => setFormText(event.target.value)}
            rows={5}
          />
          <input
            className="ws-name-input"
            aria-label="Теги"
            data-testid="memory-review-form-tags"
            value={formTags}
            onChange={(event) => setFormTags(event.target.value)}
            placeholder="теги через запятую"
          />
          <label className="memory-pinned-toggle">
            <input
              type="checkbox"
              data-testid="memory-review-form-pinned"
              checked={formPinned}
              onChange={(event) => setFormPinned(event.target.checked)}
            />
            Пиннуть
          </label>
          {formError !== null && <p className="form-error" role="alert" data-testid="memory-review-form-error">{formError}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setEditing(null)} data-testid="memory-review-form-cancel">Отмена</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void confirmApprove()} data-testid="memory-review-form-approve">{busy ? "Одобряется..." : "Одобрить"}</button>
          </div>
        </Modal>
      )}

      {toReject !== null && (
        <Modal title="Отклонить предложение" onClose={() => setToReject(null)}>
          <p className="ws-modal-text">Отклонить предложение «{toReject.text.slice(0, 80)}»? Оно не станет записью памяти.</p>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setToReject(null)} data-testid="memory-review-reject-cancel">Отмена</button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => void confirmReject()} data-testid="memory-review-reject-confirm">{busy ? "Отклоняется..." : "Отклонить"}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
