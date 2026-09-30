import { describe, expect, it, vi } from "vitest";
import {
  createMemoryMetricsLedger,
  MAX_TOP_RECORDS,
  MAX_TRACKED_RECORDS,
  startMemoryMetrics
} from "../src/metrics.js";

describe("createMemoryMetricsLedger", () => {
  it("counts one record delivered by two paths in both paths", () => {
    const ledger = createMemoryMetricsLedger();
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["a"], omitted: 0, chars: 10 },
      map: { delivered: ["a"], omitted: 2, chars: 20 },
      push: { delivered: [], omitted: 0, chars: 0 },
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
      core: { delivered: ["a"], omitted: 0, chars: 1 },
      map: { delivered: [], omitted: 0, chars: 0 },
      push: { delivered: [], omitted: 0, chars: 0 },
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
      core: { delivered: ["a"], omitted: 0, chars: 1 },
      map: { delivered: [], omitted: 0, chars: 0 },
      push: { delivered: [], omitted: 0, chars: 0 }
    });
    const first = ledger.snapshot({ reset: true });
    expect(first.window.turns).toBe(1);
    expect(first.process.totals.turns).toBe(1);
    const second = ledger.snapshot();
    expect(second.window.turns).toBe(0);
    expect(second.window.deliveries).toBe(0);
    expect(second.topRecords).toEqual([]);
    expect(second.process.totals.turns).toBe(1);
  });

  it("stops tracking new ids beyond the cap and reports dropped", () => {
    const ledger = createMemoryMetricsLedger();
    const ids = Array.from({ length: MAX_TRACKED_RECORDS + 3 }, (_value, index) => "id" + index);
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ids, omitted: 0, chars: 1 },
      map: { delivered: [], omitted: 0, chars: 0 },
      push: { delivered: [], omitted: 0, chars: 0 }
    });
    ledger.recordRecall({ channel: "admin", scope: "global", outcome: "ok", latencyMs: 1, delivered: ids });
    const snap = ledger.snapshot({ top: 1000 });
    expect(snap.dropped).toBe(3);
    expect(snap.topRecords).toHaveLength(MAX_TOP_RECORDS);
    expect(snap.window.deliveries).toBe(MAX_TRACKED_RECORDS + 3);
  });

  it("sorts the top by hits and caps it by top", () => {
    const ledger = createMemoryMetricsLedger();
    for (let index = 0; index < 3; index++) {
      ledger.recordDelivery({
        channel: "admin",
        scope: "global",
        core: { delivered: ["hot"], omitted: 0, chars: 1 },
        map: { delivered: ["warm"], omitted: 0, chars: 1 },
        push: { delivered: [], omitted: 0, chars: 0 }
      });
    }
    ledger.recordDelivery({
      channel: "admin",
      scope: "global",
      core: { delivered: ["cold"], omitted: 0, chars: 1 },
      map: { delivered: [], omitted: 0, chars: 0 },
      push: { delivered: [], omitted: 0, chars: 0 }
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
      core: { delivered: ["a"], omitted: 0, chars: marker.length },
      map: { delivered: [], omitted: 0, chars: 0 },
      push: { delivered: [], omitted: 0, chars: 0 },
      records: { a: { type: "fact", scope: "global" } }
    });
    const serialized = JSON.stringify(ledger.snapshot());
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
        core: { delivered: ["a"], omitted: 0, chars: 1 },
        map: { delivered: [], omitted: 0, chars: 0 },
        push: { delivered: [], omitted: 0, chars: 0 }
      });
      service.dispose();
      expect(infos.join("\n")).toContain("key=w1");
      expect(infos.join("\n")).toContain("turns=1");
      expect(infos.join("\n")).toContain("deliveries=1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes on the interval without holding the process", () => {
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
