import { useCallback, useEffect, useState } from "react";
import { ApiError, type AdminApi } from "../api/client";
import type { MemoryMetricsSnapshot, MemoryType } from "dsh-balbes-contracts";
import Modal from "../components/Modal";
import { TYPE_LABELS, formatTime, levelLabel, parseScope } from "./memoryShared";

const CHANNEL_LABELS: Record<string, string> = {
  admin: "админка",
  telegram: "Telegram"
};

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/** Scope tag is the scope of the turn or `recall`, not the record's own scope. */
function scopeLabel(tag: string): string {
  return tag === "global" || tag.startsWith("project:") ? levelLabel(parseScope(tag)) : tag;
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type as MemoryType] ?? type;
}

function count(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("ru-RU") : "—";
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин ${seconds} с`;
  return `${seconds} с`;
}

function formatLatency(recall: MemoryMetricsSnapshot["recall"]): string {
  if (recall.calls === 0) return "—";
  const average = recall.latencyMs.total / recall.calls;
  return `${average.toFixed(1)} / ${formatDuration(recall.latencyMs.max)}`;
}

type LoadError = { kind: "unavailable" } | { kind: "error"; message: string };

/**
 * Read-only view over the `memory.metrics` snapshot (p10i).
 *
 * It displays what p10h already aggregated and computes nothing: no hit is
 * inferred here, and the snapshot never carries memory text. The only derived
 * number is the average `recall` latency, which is `total / calls` of the
 * documented fields.
 */
export default function MemoryMetrics({
  api,
  onOpenRecord
}: {
  api: AdminApi;
  /** Jumps to the record's row on the «Записи» tab; absent = ids are plain text. */
  onOpenRecord?: (id: string) => void;
}) {
  const [metrics, setMetrics] = useState<MemoryMetricsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const res = await api.memoryMetrics({});
      setMetrics(res.metrics);
      setNotice(null);
    } catch (error) {
      // 503 is the documented "metrics service is not composed" degradation, not an outage
      if (error instanceof ApiError && error.code === "metrics-unavailable") {
        setLoadError({ kind: "unavailable" });
      } else {
        setLoadError({ kind: "error", message: error instanceof ApiError ? error.message : "неизвестная ошибка" });
      }
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function confirmReset(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setLoadError(null);
    try {
      const res = await api.memoryMetrics({ reset: true });
      setMetrics(res.metrics);
      setResetOpen(false);
      // the closed window is what the owner sees; process totals did not move
      setNotice("Окно закрыто. Накопительные тоталы процесса сохранились.");
    } catch (error) {
      setResetOpen(false);
      setLoadError({ kind: "error", message: error instanceof ApiError ? error.message : "неизвестная ошибка" });
    } finally {
      setBusy(false);
    }
  }

  const toolbar = (
    <div className="memory-metrics-toolbar">
      <p className="memory-metrics-hint">
        Снимок окна наблюдения доставки памяти: счётчики и попадания, без текста записей.
      </p>
      <button type="button" className="btn-ghost" disabled={busy} onClick={() => void load()} data-testid="memory-metrics-refresh">
        Обновить
      </button>
      <button
        type="button"
        className="btn-ghost"
        disabled={busy || metrics === null}
        onClick={() => setResetOpen(true)}
        data-testid="memory-metrics-reset"
      >
        Сбросить окно
      </button>
    </div>
  );

  if (loadError !== null) {
    return (
      <div className="memory-metrics" data-testid="memory-metrics">
        {toolbar}
        {loadError.kind === "unavailable" ? (
          <p className="memory-banner" role="status" data-testid="memory-metrics-unavailable">
            Сервис метрик не собран в этом профиле: снимок недоступен. Доставка памяти работает как обычно —
            вкладки «Записи» и «Очередь ревью» не затронуты.
          </p>
        ) : (
          <>
            <p className="form-error" role="alert" data-testid="memory-metrics-error">
              Не удалось прочитать метрики: {loadError.message}
            </p>
            <div>
              <button type="button" className="btn-ghost" onClick={() => void load()} data-testid="memory-metrics-retry">
                Повторить
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (loading || metrics === null) {
    return (
      <div className="memory-metrics" data-testid="memory-metrics">
        {toolbar}
        <p className="memory-metrics-note" data-testid="memory-metrics-loading">Загрузка…</p>
      </div>
    );
  }

  const windowEmpty = metrics.window.turns === 0 && metrics.window.deliveries === 0 && metrics.recall.calls === 0;
  const channelRows = Object.entries(metrics.byChannel);
  const scopeRows = Object.entries(metrics.byScope);

  return (
    <div className="memory-metrics" data-testid="memory-metrics">
      {toolbar}
      {notice !== null && (
        <p className="memory-banner" role="status" data-testid="memory-metrics-notice">{notice}</p>
      )}

      <div className="memory-metrics-grid">
        <section className="memory-metrics-card" aria-labelledby="memory-metrics-window-title">
          <h3 id="memory-metrics-window-title">Окно</h3>
          <dl className="memory-metrics-facts" data-testid="memory-metrics-window">
            <dt>начало</dt><dd>{formatTime(metrics.window.startedAt)}</dd>
            <dt>длительность</dt><dd>{formatDuration(metrics.window.durationMs)}</dd>
            <dt>ходы</dt><dd data-testid="memory-metrics-window-turns">{count(metrics.window.turns)}</dd>
            <dt>доставки</dt><dd data-testid="memory-metrics-window-deliveries">{count(metrics.window.deliveries)}</dd>
          </dl>
        </section>

        <section className="memory-metrics-card" aria-labelledby="memory-metrics-process-title">
          <h3 id="memory-metrics-process-title">Процесс</h3>
          <dl className="memory-metrics-facts" data-testid="memory-metrics-process">
            <dt>запущен</dt><dd>{formatTime(metrics.process.startedAt)}</dd>
            <dt>ходы</dt><dd data-testid="memory-metrics-process-turns">{count(metrics.process.totals.turns)}</dd>
            <dt>доставки</dt><dd data-testid="memory-metrics-process-deliveries">{count(metrics.process.totals.deliveries)}</dd>
          </dl>
        </section>

        <section className="memory-metrics-card" aria-labelledby="memory-metrics-recall-title">
          <h3 id="memory-metrics-recall-title">Recall</h3>
          <dl className="memory-metrics-facts" data-testid="memory-metrics-recall">
            <dt>вызовы</dt><dd data-testid="memory-metrics-recall-calls">{count(metrics.recall.calls)}</dd>
            <dt>пустые</dt><dd data-testid="memory-metrics-recall-empty">{count(metrics.recall.empty)}</dd>
            <dt>ошибки</dt><dd data-testid="memory-metrics-recall-failed">{count(metrics.recall.failed)}</dd>
            <dt>латентность, средняя / макс</dt><dd data-testid="memory-metrics-recall-latency">{formatLatency(metrics.recall)}</dd>
          </dl>
        </section>

        <section className="memory-metrics-card" aria-labelledby="memory-metrics-misses-title">
          <h3 id="memory-metrics-misses-title">Промахи</h3>
          <dl className="memory-metrics-facts" data-testid="memory-metrics-misses">
            <dt>доставлено, но не запрошено</dt>
            <dd data-testid="memory-metrics-unqueried">{count(metrics.unqueriedDelivered)}</dd>
            <dt>сброшено сверх потолка id</dt>
            <dd data-testid="memory-metrics-dropped">{count(metrics.dropped)}</dd>
          </dl>
        </section>
      </div>

      {windowEmpty && (
        <p className="memory-metrics-note" data-testid="memory-metrics-empty">
          За окно ещё не было ни ходов, ни доставок, ни вызовов recall: нулевые счётчики — это сигнал, а не сбой.
        </p>
      )}

      <p className="memory-metrics-note">
        Попадание — запись доставлена в контекст или выдана recall. Промах — пустой recall (пробел в памяти) и
        запись, доставленная и ни разу не запрошенная за окно (балласт). Ошибка хранилища — деградация, а не
        промах. Снимок не содержит текста памяти.
      </p>

      <section aria-labelledby="memory-metrics-channels-title">
        <h3 id="memory-metrics-channels-title" className="memory-metrics-heading">По каналам</h3>
        {channelRows.length === 0 ? (
          <p className="memory-metrics-note" data-testid="memory-metrics-channels-empty">За окно ходов не было.</p>
        ) : (
          <table className="memory-metrics-table" data-testid="memory-metrics-channels">
            <thead>
              <tr><th scope="col">канал</th><th scope="col">ходы</th><th scope="col">доставки</th></tr>
            </thead>
            <tbody>
              {channelRows.map(([channel, totals]) => (
                <tr key={channel} data-testid={"memory-metrics-channel:" + channel}>
                  <td>{channelLabel(channel)}</td>
                  <td>{count(totals.turns)}</td>
                  <td>{count(totals.deliveries)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="memory-metrics-scopes-title">
        <h3 id="memory-metrics-scopes-title" className="memory-metrics-heading">По уровням</h3>
        {scopeRows.length === 0 ? (
          <p className="memory-metrics-note" data-testid="memory-metrics-scopes-empty">За окно ходов не было.</p>
        ) : (
          <table className="memory-metrics-table" data-testid="memory-metrics-scopes">
            <thead>
              <tr><th scope="col">уровень</th><th scope="col">ходы</th><th scope="col">доставки</th></tr>
            </thead>
            <tbody>
              {scopeRows.map(([tag, totals]) => (
                <tr key={tag} data-testid={"memory-metrics-scope:" + tag}>
                  <td>{scopeLabel(tag)}</td>
                  <td>{count(totals.turns)}</td>
                  <td>{count(totals.deliveries)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="memory-metrics-top-title">
        <h3 id="memory-metrics-top-title" className="memory-metrics-heading">Топ записей по попаданиям</h3>
        {metrics.topRecords.length === 0 ? (
          <p className="memory-metrics-note" data-testid="memory-metrics-top-empty">
            За окно ни одна запись не доставлялась и не выдавалась recall.
          </p>
        ) : (
          <table className="memory-metrics-table" data-testid="memory-metrics-top">
            <thead>
              <tr>
                <th scope="col">запись</th>
                <th scope="col">тип</th>
                <th scope="col">уровень</th>
                <th scope="col">ядро</th>
                <th scope="col">карта</th>
                <th scope="col">push</th>
                <th scope="col">recall</th>
              </tr>
            </thead>
            <tbody>
              {metrics.topRecords.map((record) => (
                <tr key={record.id} data-testid={"memory-metrics-row:" + record.id}>
                  <td>
                    {onOpenRecord ? (
                      <button
                        type="button"
                        className="memory-metrics-id"
                        onClick={() => onOpenRecord(record.id)}
                        data-testid={"memory-metrics-open:" + record.id}
                        title="Открыть запись во вкладке «Записи»"
                      >
                        {record.id}
                      </button>
                    ) : (
                      <span className="memory-metrics-id-text">{record.id}</span>
                    )}
                  </td>
                  <td>{typeLabel(record.type)}</td>
                  <td>{scopeLabel(record.scope)}</td>
                  <td>{count(record.inCore)}</td>
                  <td>{count(record.inMap)}</td>
                  <td>{count(record.inPush)}</td>
                  <td>{count(record.recallDelivered)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="memory-metrics-note">
          recall-счётчик совпадает с доставкой: запись, выданная в N вызовах recall, получает N в обоих счётчиках.
        </p>
      </section>

      {resetOpen && (
        <Modal title="Сбросить окно метрик" onClose={() => setResetOpen(false)}>
          <p className="ws-modal-text">
            Закроется текущее окно наблюдения: счётчики окна обнулятся и начнётся новое. Накопительные тоталы
            процесса сохранятся, история окна никуда не пишется.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={() => setResetOpen(false)} data-testid="memory-metrics-reset-cancel">
              Отмена
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void confirmReset()} data-testid="memory-metrics-reset-confirm">
              {busy ? "Сбрасывается..." : "Сбросить окно"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
