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
  /** Суммарные символы блоков ядра/карты/push за окно — только для строки журнала. */
  chars: number;
  /** id, которые не влезли в cap: множество — один id считается один раз за окно. */
  dropped: Set<string>;
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
    chars: 0,
    dropped: new Set()
  };
}

/** Запись без известного ref: тип и scope остаются "unknown". */
function blankRecord(): TrackedRecord {
  return {
    ref: { type: "unknown", scope: "unknown" },
    inCore: 0,
    inMap: 0,
    inPush: 0,
    recallDelivered: 0,
    recallQueries: 0
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

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/** Размер блока в символах; мусор считается нулём, событие остаётся валидным. */
function charCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Карта ref-ов записи; мусорные элементы отбрасываются — событие остаётся валидным. */
function asRefMap(value: unknown): Record<string, MemoryRecordRef> | undefined {
  const source = asRecord(value);
  if (source === undefined) return undefined;
  const refs: Record<string, MemoryRecordRef> = {};
  for (const [id, raw] of Object.entries(source)) {
    const ref = asRecord(raw);
    if (ref !== undefined) refs[id] = { type: asString(ref.type), scope: asString(ref.scope) };
  }
  return refs;
}

export function createMemoryMetricsLedger(
  options: { now?: () => number } = {}
): MemoryMetricsService & { windowChars(): number } {
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
    const tracked = track(id, records?.[id], blankRecord());
    tracked[path] += 1;
  };

  const recordDelivery = (event: MemoryDeliveryEvent): void => {
    const source = asRecord(event);
    const core = asRecord(source?.core);
    const mapBlock = asRecord(source?.map);
    const push = asRecord(source?.push);
    const coreIds = asIdList(core?.delivered);
    const mapIds = asIdList(mapBlock?.delivered);
    const pushIds = asIdList(push?.delivered);
    const records = asRefMap(source?.records);
    const deliveries = coreIds.length + mapIds.length + pushIds.length;
    state.window.turns += 1;
    state.window.deliveries += deliveries;
    state.chars += charCount(core?.chars) + charCount(mapBlock?.chars) + charCount(push?.chars);
    processTotals.turns += 1;
    processTotals.deliveries += deliveries;
    bump(state.byChannel, asString(source?.channel), deliveries);
    bump(state.byScope, asString(source?.scope), deliveries);
    for (const id of coreIds) onDelivered(id, "inCore", records);
    for (const id of mapIds) onDelivered(id, "inMap", records);
    for (const id of pushIds) onDelivered(id, "inPush", records);
  };

  const recordRecall = (event: MemoryRecallEvent): void => {
    const source = asRecord(event);
    state.recall.calls += 1;
    const outcome = asString(source?.outcome);
    if (outcome === "empty") state.recall.empty += 1;
    if (outcome === "failed") state.recall.failed += 1;
    const latencyMs = source?.latencyMs;
    if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
      state.recall.latencyTotal += latencyMs;
      if (latencyMs > state.recall.latencyMax) state.recall.latencyMax = latencyMs;
    }
    const records = asRefMap(source?.records);
    // Один вызов recall = один инкремент на уникальный id, порядок не важен.
    for (const id of new Set(asIdList(source?.delivered))) {
      const tracked = track(id, records?.[id], blankRecord());
      tracked.recallDelivered += 1;
      tracked.recallQueries += 1;
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
    for (const tracked of closed.records.values()) {
      if (tracked.inCore + tracked.inMap + tracked.inPush > 0 && tracked.recallQueries === 0) unqueriedDelivered += 1;
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

  return { recordDelivery, recordRecall, snapshot, windowChars: () => state.chars, dispose: () => {} };
}

export interface MemoryMetricsOptions {
  intervalMs?: number;
  now?: () => number;
  logger?: MemoryMetricsLogger;
  /** Пометка источника строки журнала; на сервере — "server". */
  windowKey?: string;
}

function logSnapshot(logger: MemoryMetricsLogger | undefined, snapshot: MemoryMetricsSnapshot, windowKey: string, chars: number): void {
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
      " chars=" + chars +
      " recall=" + snapshot.recall.calls + "/" + snapshot.recall.empty + "/" + snapshot.recall.failed +
      " latency=" + snapshot.recall.latencyMs.total + "/" + snapshot.recall.latencyMs.max +
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
    // The character total belongs to the window being closed, so read it
    // before the snapshot resets the window.
    const chars = ledger.windowChars();
    logSnapshot(logger, ledger.snapshot({ reset: true }), windowKey, chars);
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
