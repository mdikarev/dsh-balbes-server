import { useCallback, useEffect, useState } from "react";
import type { AdminApi } from "../api/client";
import type { TelegramSaveRequest, TelegramSettingsStatus, TelegramState } from "dsh-balbes-contracts";
import Modal from "../components/Modal";

/** Russian labels for the four wire states (design spec §Админка). */
const STATE_LABELS: Record<TelegramState, string> = {
  "not-configured": "не настроено",
  disabled: "выключено",
  connected: "подключено",
  error: "ошибка"
};

/** Placeholders carry no secret: a stored token is only ever a mask. */
const KEEP_TOKEN_PLACEHOLDER = "•••• (пусто — оставить текущий)";
const NEW_TOKEN_PLACEHOLDER = "123456:ABC…";

/** Shown for a value the server has not reported yet. */
const DASH = "—";

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Human-readable poll timestamp; falls back to the raw value if unparsable. */
function formatPollTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ru-RU");
}

interface TelegramPageProps {
  api: AdminApi;
}

/**
 * «Telegram» page: the bot token, the allowlisted user id and the enabled
 * toggle, plus the live status card (state badge, bot username, last successful
 * poll, safe error message). Mirrors ModelsPage idioms: single role="alert"
 * banner, busy-locked buttons, Russian copy, data-testids.
 *
 * Two server-side rules shape the flow:
 * - the token is write-only: an empty field means "keep the stored one" and no
 *   response ever carries the value, so only the mask is rendered;
 * - a successful mutation may answer with a state the background runtime
 *   transition has not reached yet (T11-7), so every operation re-reads
 *   /api/telegram/status instead of trusting the response body.
 */
export default function TelegramPage({ api }: TelegramPageProps) {
  const [status, setStatus] = useState<TelegramSettingsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // form state; the token field is never prefilled and never echoed back
  const [token, setToken] = useState("");
  const [userId, setUserId] = useState("");
  const [enabled, setEnabled] = useState(false);

  const [testUsername, setTestUsername] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  /**
   * Re-read the status. `syncForm` also pulls the enabled flag and empties the
   * inputs, so the form reflects what the server actually stored — used on the
   * first load and after every state-changing operation, never after the
   * non-mutating connection test (that would discard what the user typed).
   */
  const refresh = useCallback(async (syncForm: boolean): Promise<TelegramSettingsStatus> => {
    const res = await api.telegramStatus();
    setStatus(res.status);
    if (syncForm) {
      setEnabled(res.status.enabled);
      setToken("");
      setUserId("");
    }
    return res.status;
  }, [api]);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      await refresh(true);
    } catch (err) {
      setLoadError(errMessage(err, "status failed"));
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  /** User ID as typed: empty means "not sent" (T11-5: never a null field). */
  function typedUserId(): number | undefined {
    const raw = userId.trim();
    if (!/^\d+$/.test(raw)) return undefined;
    const value = Number(raw);
    return value > 0 ? value : undefined;
  }

  const userIdInvalid = userId.trim() !== "" && typedUserId() === undefined;

  /** Enabling needs an allowlist entry: the typed one or an already stored one. */
  function formValid(): boolean {
    if (status === null || userIdInvalid) return false;
    if (enabled && typedUserId() === undefined && status.allowedUserId === undefined) return false;
    return true;
  }

  /**
   * Assemble the save request. An empty token keeps the stored credential and an
   * empty User ID keeps the stored allowlist entry, so both fields are omitted
   * rather than sent empty or null (the server rejects a non-positive id with
   * 400 invalid-user-id).
   */
  function buildSaveRequest(): TelegramSaveRequest {
    const req: TelegramSaveRequest = { enabled };
    const nextToken = token.trim();
    if (nextToken !== "") req.token = nextToken;
    const nextUserId = typedUserId();
    if (nextUserId !== undefined) req.allowedUserId = nextUserId;
    return req;
  }

  /**
   * Run a state-changing call, then re-read the status (T11-7). Returns whether
   * the operation itself succeeded; a failed refresh is reported on its own.
   * Every operation invalidates a previously shown connection-test result, so a
   * stale «Подключение работает» line never outlives the state it described.
   */
  async function run(action: () => Promise<unknown>, fallback: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setTestUsername(null);
    let ok = false;
    try {
      await action();
      ok = true;
    } catch (err) {
      setError(errMessage(err, fallback));
    }
    if (ok) {
      try {
        await refresh(true);
      } catch (err) {
        setError(errMessage(err, "refresh failed"));
      }
    }
    setBusy(false);
    return ok;
  }

  async function handleSave(): Promise<void> {
    if (!formValid()) return;
    await run(() => api.telegramSave(buildSaveRequest()), "save failed");
  }

  async function handleDisable(): Promise<void> {
    await run(() => api.telegramDisable(), "disable failed");
  }

  /** The connection test mutates nothing, so it leaves the form untouched. */
  async function handleTest(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setTestUsername(null);
    try {
      const res = await api.telegramTest();
      setTestUsername(res.username);
      try {
        await refresh(false);
      } catch (err) {
        setError(errMessage(err, "refresh failed"));
      }
    } catch (err) {
      setError(errMessage(err, "test failed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleClearToken(): Promise<void> {
    const ok = await run(() => api.telegramClearToken(), "clear token failed");
    if (ok) setConfirmingClear(false);
  }

  const validationHint =
    status === null
      ? null
      : userIdInvalid
        ? "User ID должен быть положительным целым числом"
        : enabled && typedUserId() === undefined && status.allowedUserId === undefined
          ? "Укажите User ID, чтобы включить бота"
          : null;

  const errorBanner =
    error === null ? null : (
      <p className="form-error telegram-banner" role="alert" data-testid="telegram-error">
        Не удалось: {error}
      </p>
    );

  return (
    <div className="telegram-page" data-testid="telegram-page">
      {status === null ? (
        <div className="ws-center-state">
          {loadError !== null ? (
            <>
              <p className="form-error" role="alert" data-testid="telegram-load-error">
                Не удалось загрузить статус: {loadError}
              </p>
              <button type="button" className="btn" onClick={() => void load()} data-testid="telegram-retry">
                Повторить
              </button>
            </>
          ) : (
            <p className="ws-placeholder">Загрузка…</p>
          )}
        </div>
      ) : (
        <>
          {errorBanner !== null && !confirmingClear && errorBanner}

          <div className="telegram-card" data-testid="telegram-status-card">
            <div className="tg-head">
              <b className="tg-title">Telegram-бот</b>
              <span className={"telegram-badge state-" + status.state} data-testid="telegram-state">
                {STATE_LABELS[status.state]}
              </span>
            </div>
            <p className="mc-line" data-testid="telegram-bot">
              Бот: {status.botUsername !== undefined ? "@" + status.botUsername : DASH}
            </p>
            <p className="mc-line" data-testid="telegram-last-poll">
              Последний успешный опрос: {status.lastPollAt !== undefined ? formatPollTime(status.lastPollAt) : DASH}
            </p>
            <p className="mc-line" data-testid="telegram-token-state">
              Токен: <code>{status.tokenConfigured ? "••••" : "не задан"}</code>
            </p>
            {/* Descriptive state detail, deliberately not role="alert": the
                actionable banner stays the page's single alert region. */}
            {status.error !== undefined && (
              <p className="form-error telegram-status-error" data-testid="telegram-status-error">
                Ошибка бота: {status.error.message}
              </p>
            )}
          </div>

          <form
            className="telegram-form"
            data-testid="telegram-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSave();
            }}
          >
            <label className="form-field">
              <span>Токен бота</span>
              <input
                type="password"
                className="form-input"
                data-testid="telegram-token-input"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={status.tokenConfigured ? KEEP_TOKEN_PLACEHOLDER : NEW_TOKEN_PLACEHOLDER}
                autoComplete="off"
              />
              <span className="form-hint">
                Токен хранится в защищённом хранилище и никогда не показывается в интерфейсе. Пустое поле оставляет текущий
                токен.
              </span>
            </label>

            <label className="form-field">
              <span>User ID</span>
              <input
                type="number"
                min={1}
                className="form-input"
                data-testid="telegram-user-id-input"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder={status.allowedUserId !== undefined ? String(status.allowedUserId) : ""}
              />
              <span className="form-hint">
                Числовой id пользователя Telegram, которому разрешено писать боту. Пустое поле оставляет текущий id.
              </span>
            </label>

            <label className="form-check">
              <input
                type="checkbox"
                data-testid="telegram-enabled-input"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>Включить бота</span>
            </label>

            {validationHint !== null && (
              <p className="form-hint telegram-hint" data-testid="telegram-validation-hint">
                {validationHint}
              </p>
            )}

            <div className="telegram-actions">
              <button
                type="button"
                className="btn-ghost"
                data-testid="telegram-test"
                onClick={() => void handleTest()}
                disabled={busy}
              >
                Проверить подключение
              </button>
              <button
                type="submit"
                className="btn"
                data-testid="telegram-save"
                disabled={busy || !formValid()}
              >
                {busy ? "Сохраняется…" : "Сохранить"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                data-testid="telegram-disable"
                onClick={() => void handleDisable()}
                disabled={busy}
              >
                Отключить
              </button>
              <button
                type="button"
                className="btn-danger"
                data-testid="telegram-clear-token"
                onClick={() => {
                  setError(null);
                  setConfirmingClear(true);
                }}
                disabled={busy}
              >
                Удалить токен
              </button>
            </div>

            {testUsername !== null && (
              <p className="telegram-test-ok" data-testid="telegram-test-result">
                Подключение работает: {testUsername !== "" ? "@" + testUsername : "бот не сообщил имя"}
              </p>
            )}
          </form>
        </>
      )}

      {confirmingClear && (
        <Modal
          title="Удалить токен"
          onClose={() => {
            if (busy) return;
            setConfirmingClear(false);
            setError(null);
          }}
        >
          <div data-testid="telegram-clear-confirm">
            {errorBanner}
            <p className="ws-modal-text">
              Удалить токен бота? Бот будет выключен, пока не сохраните новый токен.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-ghost"
                data-testid="telegram-clear-cancel"
                onClick={() => {
                  setConfirmingClear(false);
                  setError(null);
                }}
                disabled={busy}
              >
                Отмена
              </button>
              <button
                type="button"
                className="btn-danger"
                data-testid="telegram-clear-submit"
                onClick={() => void handleClearToken()}
                disabled={busy}
              >
                {busy ? "Удаляется…" : "Удалить"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
