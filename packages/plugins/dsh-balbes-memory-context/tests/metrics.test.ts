import { describe, expect, it, vi } from "vitest";
import {
  createMemoryMetricsLedger,
  DEFAULT_TOP_RECORDS,
  MAX_TOP_RECORDS,
  MAX_TRACKED_RECORDS,
  startMemoryMetrics
} from "../src/metrics.js";
import type { MemoryMetricsChannel } from "../src/types.js";

describe("createMemoryMetricsLedger", () => {
  it("counts one record delivered by two paths in both paths", () => {
    const ledger = createMemoryMetricsLedger();
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["a"], chars: 10 },
      map: { delivered: ["a"], chars: 20 },
      push: { delivered: [], chars: 0 },
      records: { a: { type: "fact", scope: "global" } }
    });
    const snap = ledger.snapshot();
    expect(snap.window.turns).toBe(1);
    expect(snap.window.deliveries).toBe(2);
    expect(snap.byChannel.admin).toEqual({ turns: 1, deliveries: 2 });
    expect(snap.byScope.global).toEqual({ turns: 1, deliveries: 2 });
    expect(snap.topRecords).toEqual([
      {
        id: "a",
        type: "fact",
        scope: "global",
        inCore: 1,
        inMap: 1,
        inPush: 0,
        recallDelivered: 0,
        recallQueries: 0
      }
    ]);
    expect(snap.unqueriedDelivered).toBe(1);
  });

  it("counts recall queries per call and separates empty from failed", () => {
    const ledger = createMemoryMetricsLedger();
    const base = { channel: "telegram", scope: "project:proj" };
    ledger.recordRecall({ ...base, outcome: "ok", latencyMs: 4, delivered: ["a", "b"] });
    ledger.recordRecall({ ...base, outcome: "ok", latencyMs: 6, delivered: ["a"] });
    ledger.recordRecall({ ...base, outcome: "empty", latencyMs: 2 });
    ledger.recordRecall({ ...base, outcome: "failed", latencyMs: 8 });
    const snap = ledger.snapshot();
    expect(snap.recall).toEqual({ calls: 4, empty: 1, failed: 1, latencyMs: { total: 20, max: 8 } });
    const a = snap.topRecords.find((record) => record.id === "a");
    expect(a?.recallQueries).toBe(2);
    expect(a?.recallDelivered).toBe(2);
  });

  it("keeps a record out of unqueriedDelivered once recall returned it", () => {
    const ledger = createMemoryMetricsLedger();
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["a"], chars: 1 },
      map: { delivered: [], chars: 0 },
      push: { delivered: [], chars: 0 },
      records: { a: { type: "note", scope: "global" } }
    });
    ledger.recordRecall({ channel: "admin", scope: "global", outcome: "ok", latencyMs: 1, delivered: ["a"] });
    expect(ledger.snapshot().unqueriedDelivered).toBe(0);
  });

  it("closes the window on reset while keeping the process totals", () => {
    const ledger = createMemoryMetricsLedger({ now: () => 1_000 });
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["a"], chars: 1 },
      map: { delivered: [], chars: 0 },
      push: { delivered: [], chars: 0 }
    });
    const first = ledger.snapshot({ reset: true });
    expect(first.window.turns).toBe(1);
    expect(first.unqueriedDelivered).toBe(1);
    expect(first.process.totals.turns).toBe(1);
    const second = ledger.snapshot();
    expect(second.window.turns).toBe(0);
    expect(second.window.deliveries).toBe(0);
    expect(second.topRecords).toEqual([]);
    expect(second.unqueriedDelivered).toBe(0);
    expect(second.process.totals.turns).toBe(1);
  });

  it("stops tracking new ids beyond the cap and reports dropped", () => {
    const ledger = createMemoryMetricsLedger();
    const ids = Array.from({ length: MAX_TRACKED_RECORDS + 3 }, (_value, index) => "id" + index);
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ids, chars: 1 },
      map: { delivered: [], chars: 0 },
      push: { delivered: [], chars: 0 }
    });
    ledger.recordRecall({ channel: "admin", scope: "global", outcome: "ok", latencyMs: 1, delivered: ids });
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["id0"], chars: 1 },
      map: { delivered: [], chars: 0 },
      push: { delivered: [], chars: 0 }
    });
    const snap = ledger.snapshot({ top: 1000 });
    expect(snap.dropped).toBe(3);
    expect(snap.topRecords).toHaveLength(MAX_TOP_RECORDS);
    expect(snap.window.deliveries).toBe(MAX_TRACKED_RECORDS + 4);
    const kept = snap.topRecords.find((record) => record.id === "id0");
    expect(kept?.inCore).toBe(2);
  });

  it("caps the dropped set at the tracked-record limit", () => {
    const ledger = createMemoryMetricsLedger();
    const ids = Array.from({ length: 2 * MAX_TRACKED_RECORDS + 5 }, (_value, index) => "id" + index);
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ids, chars: 1 },
      map: { delivered: [], chars: 0 },
      push: { delivered: [], chars: 0 }
    });
    expect(ledger.snapshot().dropped).toBe(MAX_TRACKED_RECORDS);
    // Вторая волна уникальных id сверх потолка не растит dropped дальше.
    const more = Array.from({ length: 2 * MAX_TRACKED_RECORDS }, (_value, index) => "more" + index);
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: more, chars: 1 },
      map: { delivered: [], chars: 0 },
      push: { delivered: [], chars: 0 }
    });
    expect(ledger.snapshot().dropped).toBe(MAX_TRACKED_RECORDS);
  });

  it("returns at most the default top when no top is given", () => {
    const ledger = createMemoryMetricsLedger();
    const ids = Array.from({ length: DEFAULT_TOP_RECORDS + 5 }, (_value, index) => "r" + index);
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ids, chars: 1 },
      map: { delivered: [], chars: 0 },
      push: { delivered: [], chars: 0 }
    });
    expect(ledger.snapshot().topRecords).toHaveLength(DEFAULT_TOP_RECORDS);
  });

  it("counts a repeated id once per recall call", () => {
    const ledger = createMemoryMetricsLedger();
    ledger.recordRecall({
      channel: "admin",
      scope: "global",
      outcome: "ok",
      latencyMs: 1,
      delivered: ["a", "a", "a"]
    });
    const snap = ledger.snapshot();
    expect(snap.recall.calls).toBe(1);
    expect(snap.topRecords).toEqual([
      {
        id: "a",
        type: "unknown",
        scope: "unknown",
        inCore: 0,
        inMap: 0,
        inPush: 0,
        recallDelivered: 1,
        recallQueries: 1
      }
    ]);
  });

  it("never throws on a malformed event", () => {
    const ledger = createMemoryMetricsLedger();
    expect(() => ledger.recordDelivery(undefined as never)).not.toThrow();
    expect(() => ledger.recordDelivery({ channel: "admin", scope: "global" } as never)).not.toThrow();
    expect(() => ledger.recordRecall({ channel: "admin", scope: "global", outcome: "ok" } as never)).not.toThrow();
    expect(() =>
      ledger.recordRecall({ channel: "admin", scope: "global", outcome: "ok", latencyMs: Number.NaN } as never)
    ).not.toThrow();
    expect(ledger.snapshot().window.turns).toBe(2);
  });

  it("keeps two channels separate in byChannel with their own counts", () => {
    const ledger = createMemoryMetricsLedger();
    const admin: MemoryMetricsChannel = "admin";
    const telegram: MemoryMetricsChannel = "telegram";
    ledger.recordDelivery({
      channel: admin,
      scope: "global",
      core: { delivered: ["a"], chars: 1 },
      map: { delivered: [], chars: 0 },
      push: { delivered: [], chars: 0 }
    });
    ledger.recordDelivery({
      channel: telegram,
      scope: "project:proj",
      core: { delivered: ["b", "c"], chars: 1 },
      map: { delivered: ["d"], chars: 1 },
      push: { delivered: [], chars: 0 }
    });
    const snap = ledger.snapshot();
    expect(Object.keys(snap.byChannel).sort()).toEqual([admin, telegram]);
    expect(snap.byChannel[admin]).toEqual({ turns: 1, deliveries: 1 });
    expect(snap.byChannel[telegram]).toEqual({ turns: 1, deliveries: 3 });
  });

  it("sorts the top by hits and caps it by top", () => {
    const ledger = createMemoryMetricsLedger();
    for (let index = 0; index < 3; index++) {
      ledger.recordDelivery({
        channel: "admin",
        scope: "global",
        core: { delivered: ["hot"], chars: 1 },
        map: { delivered: ["warm"], chars: 1 },
        push: { delivered: [], chars: 0 }
      });
    }
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["cold"], chars: 1 },
      map: { delivered: [], chars: 0 },
      push: { delivered: [], chars: 0 }
    });
    const snap = ledger.snapshot({ top: 2 });
    expect(snap.topRecords.map((record) => record.id)).toEqual(["hot", "warm"]);
  });

  it("never carries memory text or originRef into the snapshot", () => {
    const ledger = createMemoryMetricsLedger();
    const marker = "metrics-secret-marker-7f31";
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["a"], chars: marker.length },
      map: { delivered: [], chars: 0 },
      push: { delivered: [], chars: 0 },
      records: { a: { type: "fact", scope: "global" } }
    });
    const snap = ledger.snapshot();
    expect(Object.keys(snap).sort()).toEqual([
      "byChannel",
      "byScope",
      "dropped",
      "process",
      "recall",
      "schema",
      "topRecords",
      "unqueriedDelivered",
      "window"
    ]);
    expect(snap.topRecords.map((record) => Object.keys(record).sort())[0]).toEqual([
      "id",
      "inCore",
      "inMap",
      "inPush",
      "recallDelivered",
      "recallQueries",
      "scope",
      "type"
    ]);
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("originRef");
  });
});

describe("startMemoryMetrics", () => {
  it("logs a window snapshot on reset with the given key", () => {
    vi.useFakeTimers();
    try {
      const infos: string[] = [];
      const service = startMemoryMetrics({
        intervalMs: 0,
        windowKey: "w1",
        logger: { info: (message) => infos.push(message), warn: () => {} }
      });
      service.recordDelivery({
        channel: "admin",
        scope: "global",
        core: { delivered: ["a"], chars: 1 },
        map: { delivered: [], chars: 0 },
        push: { delivered: [], chars: 0 }
      });
      service.dispose();
      expect(infos.join("\n")).toContain("key=w1");
      expect(infos.join("\n")).toContain("turns=1");
      expect(infos.join("\n")).toContain("deliveries=1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes on the interval", () => {
    vi.useFakeTimers();
    try {
      const infos: string[] = [];
      const service = startMemoryMetrics({
        intervalMs: 1_000,
        logger: { info: (message) => infos.push(message), warn: () => {} }
      });
      vi.advanceTimersByTime(1_000);
      expect(infos.length).toBe(1);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs the summed block characters and the recall latency", () => {
    vi.useFakeTimers();
    try {
      const infos: string[] = [];
      const service = startMemoryMetrics({
        intervalMs: 1_000,
        logger: { info: (message) => infos.push(message), warn: () => {} }
      });
      service.recordDelivery({
        channel: "admin",
        scope: "global",
        core: { delivered: ["a"], chars: 10 },
        map: { delivered: ["b"], chars: 20 },
        push: { delivered: ["c"], chars: 5 }
      });
      service.recordRecall({ channel: "admin", scope: "global", outcome: "ok", latencyMs: 4 });
      service.recordRecall({ channel: "admin", scope: "global", outcome: "empty", latencyMs: 9 });
      vi.advanceTimersByTime(1_000);
      service.dispose();
      expect(infos[0]).toContain("chars=35");
      expect(infos[0]).toContain("latency=13/9");
      expect(infos[1]).toContain("chars=0");
      expect(infos[1]).toContain("latency=0/0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("unrefs the interval handle and creates no timer for unusable intervals", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const unref = vi.fn();
      setIntervalSpy.mockReturnValue({ unref } as never);
      const service = startMemoryMetrics({
        intervalMs: 60_000,
        logger: { info: () => {}, warn: () => {} }
      });
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
      service.dispose();

      setIntervalSpy.mockClear();
      for (const intervalMs of [0, Number.NaN, -1]) {
        const skipped = startMemoryMetrics({ intervalMs, logger: { info: () => {}, warn: () => {} } });
        skipped.dispose();
      }
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("does not log on dispose twice", () => {
    const infos: string[] = [];
    const service = startMemoryMetrics({
      intervalMs: 0,
      logger: { info: (message) => infos.push(message), warn: () => {} }
    });
    service.dispose();
    service.dispose();
    expect(infos).toHaveLength(1);
  });
});
