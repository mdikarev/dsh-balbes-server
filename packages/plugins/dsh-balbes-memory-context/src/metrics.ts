import type {
  MemoryDeliveryEvent,
  MemoryMetricsChannelTotals,
  MemoryMetricsLogger,
  MemoryMetricsRecordMetrics,
  MemoryMetricsService,
  MemoryMetricsSnapshot,
  MemoryMetricsTotals,
  MemoryRecallEvent,
  MemoryRecordRef
} from "./types.js";

export const METRICS_SCHEMA = 1;
export const DEFAULT_METRICS_INTERVAL_MS = 900_000;
export const MAX_TRACKED_RECORDS = 512;
export const DEFAULT_TOP_RECORDS = 20;
export const MAX_TOP_RECORDS = 100;
const LOG_TOP_RECORDS = 5;

interface WindowCounters extends MemoryMetricsTotals {
  startedAt: number;
}

interface WindowRecall {
  calls: number;
  empty: number;
  failed: number;
  latencyTotal: number;
  latencyMax: number;
}

interface TrackedRecord {
  ref: MemoryRecordRef;
  inCore: number;
  inMap: number;
  inPush: number;
  recallDelivered: number;
  recallQueries: number;
}

interface WindowState {
  window: WindowCounters;
  byChannel: Map<string, MemoryMetricsChannelTotals>;
  byScope: Map<string, MemoryMetricsChannelTotals>;
  records: Map<string, TrackedRecord>;
  recall: WindowRecall;
  /** id, которые не влезли в cap: множество — один id считается один раз за окно. */
  dropped: Set<string>;
  /** id, выданные recall в этом окне: отличает попадание от балласта. */
  recalled: Set<string>;
}

function iso(timestamp: number): string {
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function freshWindow(now: number): WindowState {
  return {
    window: { startedAt: now, turns: 0, deliveries: 0 },
    byChannel: new Map(),
    byScope: new Map(),
    records: new Map(),
    recall: { calls: 0, empty: 0, failed: 0, latencyTotal: 0, latencyMax: 0 },
    dropped: new Set(),
    recalled: new Set()
  };
}

function bump(map: Map<string, MemoryMetricsChannelTotals>, key: string, deliveries: number): void {
  const current = map.get(key) ?? { turns: 0, deliveries: 0 };
  current.turns += 1;
  current.deliveries += deliveries;
  map.set(key, current);
}

function toRecord(map: Map<string, MemoryMetricsChannelTotals>): Record<string, MemoryMetricsChannelTotals> {
  const out: Record<string, MemoryMetricsChannelTotals> = {};
  for (const [key, value] of map) out[key] = { turns: value.turns, deliveries: value.deliveries };
  return out;
}

function clampCount(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

export function createMemoryMetricsLedger(options: { now?: () => number } = {}): MemoryMetricsService {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const processTotals: MemoryMetricsTotals = { turns: 0, deliveries: 0 };
  let state = freshWindow(startedAt);

  const track = (id: string, ref: MemoryRecordRef | undefined, blank: TrackedRecord): TrackedRecord => {
    const existing = state.records.get(id);
    if (existing !== undefined) {
      if (ref !== undefined && (existing.ref.type === "" || existing.ref.type === "unknown")) existing.ref = ref;
      return existing;
    }
    if (state.records.size >= MAX_TRACKED_RECORDS) {
      state.dropped.add(id);
      return blank;
    }
    const seeded: TrackedRecord = ref === undefined ? blank : { ...blank, ref };
    state.records.set(id, seeded);
    return seeded;
  };

  const onDelivered = (id: string, path: "inCore" | "inMap" | "inPush", records: Record<string, MemoryRecordRef> | undefined): void => {
    const tracked = track(id, records?.[id], { ref: { type: "unknown", scope: "unknown" }, inCore: 0, inMap: 0, inPush: 0, recallDelivered: 0, recallQueries: 0 });
    tracked[path] += 1;
  };

  const recordDelivery = (event: MemoryDeliveryEvent): void => {
    const deliveries = event.core.delivered.length + event.map.delivered.length + event.push.delivered.length;
    state.window.turns += 1;
    state.window.deliveries += deliveries;
    processTotals.turns += 1;
    processTotals.deliveries += deliveries;
    bump(state.byChannel, event.channel, deliveries);
    bump(state.byScope, event.scope, deliveries);
    for (const id of event.core.delivered) onDelivered(id, "inCore", event.records);
    for (const id of event.map.delivered) onDelivered(id, "inMap", event.records);
    for (const id of event.push.delivered) onDelivered(id, "inPush", event.records);
  };

  const recordRecall = (event: MemoryRecallEvent): void => {
    state.recall.calls += 1;
    if (event.outcome === "empty") state.recall.empty += 1;
    if (event.outcome === "failed") state.recall.failed += 1;
    if (Number.isFinite(event.latencyMs) && event.latencyMs >= 0) {
      state.recall.latencyTotal += event.latencyMs;
      if (event.latencyMs > state.recall.latencyMax) state.recall.latencyMax = event.latencyMs;
    }
    for (const id of event.delivered ?? []) {
      const tracked = track(id, event.records?.[id], { ref: { type: "unknown", scope: "unknown" }, inCore: 0, inMap: 0, inPush: 0, recallDelivered: 0, recallQueries: 0 });
      tracked.recallDelivered += 1;
      tracked.recallQueries += 1;
      state.recalled.add(id);
    }
  };

  const snapshot = (options?: { reset?: boolean; top?: number }): MemoryMetricsSnapshot => {
    const closed = state;
    const top = clampCount(options?.top, DEFAULT_TOP_RECORDS, MAX_TOP_RECORDS);
    const topRecords = [...closed.records.entries()]
      .map(([id, tracked]) => ({
        id,
        type: tracked.ref.type,
        scope: tracked.ref.scope,
        inCore: tracked.inCore,
        inMap: tracked.inMap,
        inPush: tracked.inPush,
        recallDelivered: tracked.recallDelivered,
        recallQueries: tracked.recallQueries
      }))
      .sort((left, right) => {
        const leftHits = left.inCore + left.inMap + left.inPush;
        const rightHits = right.inCore + right.inMap + right.inPush;
        if (rightHits !== leftHits) return rightHits - leftHits;
        if (right.recallQueries !== left.recallQueries) return right.recallQueries - left.recallQueries;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })
      .slice(0, top);
    let unqueriedDelivered = 0;
    for (const [id, tracked] of closed.records) {
      if (tracked.inCore + tracked.inMap + tracked.inPush > 0 && !closed.recalled.has(id)) unqueriedDelivered += 1;
    }
    const endedAt = now();
    const value: MemoryMetricsSnapshot = {
      schema: METRICS_SCHEMA,
      process: { startedAt: iso(startedAt), totals: { ...processTotals } },
      window: {
        startedAt: iso(closed.window.startedAt),
        durationMs: Math.max(0, endedAt - closed.window.startedAt),
        turns: closed.window.turns,
        deliveries: closed.window.deliveries
      },
      byChannel: toRecord(closed.byChannel),
      byScope: toRecord(closed.byScope),
      recall: {
        calls: closed.recall.calls,
        empty: closed.recall.empty,
        failed: closed.recall.failed,
        latencyMs: { total: closed.recall.latencyTotal, max: closed.recall.latencyMax }
      },
      unqueriedDelivered,
      dropped: closed.dropped.size,
      topRecords
    };
    if (options?.reset === true) state = freshWindow(endedAt);
    return value;
  };

  return { recordDelivery, recordRecall, snapshot, dispose: () => {} };
}

export interface MemoryMetricsOptions {
  intervalMs?: number;
  now?: () => number;
  logger?: MemoryMetricsLogger;
  /** Пометка источника строки журнала; на сервере — "server". */
  windowKey?: string;
}

function logSnapshot(logger: MemoryMetricsLogger | undefined, snapshot: MemoryMetricsSnapshot, windowKey: string): void {
  if (logger?.info === undefined) return;
  const seconds = Math.round(snapshot.window.durationMs / 1000);
  const top = snapshot.topRecords
    .slice(0, LOG_TOP_RECORDS)
    .map((record) => record.id + ":" + (record.inCore + record.inMap + record.inPush) + "/" + record.recallQueries)
    .join(",");
  logger.info(
    "balbes-memory-context: metrics key=" + windowKey +
      " window=" + seconds + "s" +
      " turns=" + snapshot.window.turns +
      " deliveries=" + snapshot.window.deliveries +
      " recall=" + snapshot.recall.calls + "/" + snapshot.recall.empty + "/" + snapshot.recall.failed +
      " unqueried=" + snapshot.unqueriedDelivered +
      " dropped=" + snapshot.dropped +
      (top === "" ? "" : " top=" + top)
  );
}

/**
 * Сервис метрик с интервальным сбросом окна в журнал. Таймер `unref()`:
 * фоновый снимок не держит процесс при остановке сервера. `dispose()`
 * идемпотентен и всегда пишет финальный снимок последнего окна.
 */
export function startMemoryMetrics(options: MemoryMetricsOptions = {}): MemoryMetricsService {
  const logger = options.logger;
  const ledger = createMemoryMetricsLedger(options.now === undefined ? {} : { now: options.now });
  const windowKey = options.windowKey ?? "server";
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const flush = (): void => {
    logSnapshot(logger, ledger.snapshot({ reset: true }), windowKey);
  };
  const intervalMs = options.intervalMs ?? DEFAULT_METRICS_INTERVAL_MS;
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    timer = setInterval(() => {
      try {
        flush();
      } catch (error) {
        logger?.warn("balbes-memory-context: metrics flush failed: " + (error instanceof Error ? error.message : String(error)));
      }
    }, intervalMs);
    timer.unref?.();
  }
  return {
    recordDelivery: (event) => {
      try {
        ledger.recordDelivery(event);
      } catch (error) {
        logger?.warn("balbes-memory-context: delivery metrics failed: " + (error instanceof Error ? error.message : String(error)));
      }
    },
    recordRecall: (event) => {
      try {
        ledger.recordRecall(event);
      } catch (error) {
        logger?.warn("balbes-memory-context: recall metrics failed: " + (error instanceof Error ? error.message : String(error)));
      }
    },
    snapshot: (snapshotOptions) => ledger.snapshot(snapshotOptions),
    dispose: () => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      try {
        flush();
      } catch (error) {
        logger?.warn("balbes-memory-context: metrics flush failed: " + (error instanceof Error ? error.message : String(error)));
      }
    }
  };
}
