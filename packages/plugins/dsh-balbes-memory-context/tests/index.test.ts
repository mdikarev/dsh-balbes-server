import { describe, expect, it, vi } from "vitest";
import { apply, name, Config } from "../src/index.js";

interface Effect {
  callback: () => (() => void) | void;
  label?: string | undefined;
}

interface Seats {
  provided: Map<string, unknown>;
  infos: string[];
  warnings: string[];
  effects: Effect[];
}

function ctx(seats: Seats): unknown {
  return {
    provide(key: string, value: unknown) {
      seats.provided.set(key, value);
    },
    effect(callback: () => (() => void) | void, label?: string) {
      seats.effects.push({ callback, label });
    },
    logger: {
      warn: (message: string) => seats.warnings.push(message),
      info: (message: string) => seats.infos.push(message)
    }
  };
}

function seats(): Seats {
  return { provided: new Map(), infos: [], warnings: [], effects: [] };
}

function metricsSeat(taken: Seats): { recordDelivery(event: unknown): void; dispose(): void } {
  return taken.provided.get("balbesMemoryMetrics") as {
    recordDelivery(event: unknown): void;
    dispose(): void;
  };
}

function snapshotLines(taken: Seats): string[] {
  return taken.infos.filter((line) => line.startsWith("balbes-memory-context: metrics key=server"));
}

function deliveryEvent(): unknown {
  return {
    channel: "admin",
    scope: "global",
    core: { delivered: ["a"], omitted: 0, chars: 1 },
    map: { delivered: [], omitted: 0, chars: 0 },
    push: { delivered: [], omitted: 0, chars: 0 }
  };
}

/** Deletes the env var first, runs `run`, then restores the previous value in `finally`. */
function withEnvInterval(value: string | undefined, run: () => void): void {
  const previous = process.env.BALBES_MEMORY_METRICS_INTERVAL_MS;
  delete process.env.BALBES_MEMORY_METRICS_INTERVAL_MS;
  try {
    if (value !== undefined) process.env.BALBES_MEMORY_METRICS_INTERVAL_MS = value;
    run();
  } finally {
    if (previous === undefined) delete process.env.BALBES_MEMORY_METRICS_INTERVAL_MS;
    else process.env.BALBES_MEMORY_METRICS_INTERVAL_MS = previous;
  }
}

describe("balbes-memory-context plugin", () => {
  it("exposes the functional plugin contract", () => {
    expect(name).toBe("balbes-memory-context");
    expect(Config).toBeDefined();
    expect(Config({})).toEqual({});
  });

  it("provides balbesMemoryContext and balbesMemoryMetrics on apply", () => {
    const taken = seats();
    apply(ctx(taken) as never, {});
    const context = taken.provided.get("balbesMemoryContext") as { attach?: unknown } | undefined;
    expect(typeof context?.attach).toBe("function");
    const metrics = taken.provided.get("balbesMemoryMetrics") as {
      recordDelivery?: unknown;
      snapshot?: unknown;
      dispose?: unknown;
    } | undefined;
    expect(typeof metrics?.recordDelivery).toBe("function");
    expect(typeof metrics?.snapshot).toBe("function");
    expect(typeof metrics?.dispose).toBe("function");
  });

  it("registers a teardown that disposes the metrics window", () => {
    const taken = seats();
    apply(ctx(taken) as never, { intervalMs: 0 });
    const registered = taken.effects.find((entry) => entry.label === "balbesMemoryMetrics.dispose");
    expect(registered).toBeDefined();
    const disposer = registered?.callback();
    expect(typeof disposer).toBe("function");
    metricsSeat(taken).recordDelivery(deliveryEvent());
    (disposer as () => void)();
    expect(snapshotLines(taken)).toHaveLength(1);
    expect(snapshotLines(taken)[0]).toContain("turns=1");
    (disposer as () => void)();
    expect(snapshotLines(taken)).toHaveLength(1);
  });

  it("logs the window snapshot on disposal and closes the timer", () => {
    vi.useFakeTimers();
    try {
      const taken = seats();
      apply(ctx(taken) as never, { intervalMs: 0 });
      const metrics = metricsSeat(taken);
      metrics.recordDelivery(deliveryEvent());
      metrics.dispose();
      expect(taken.infos.join("\n")).toContain("balbes-memory-context: metrics key=server");
      expect(taken.infos.join("\n")).toContain("turns=1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes once per configured interval and stops after dispose", () => {
    vi.useFakeTimers();
    try {
      const taken = seats();
      apply(ctx(taken) as never, { intervalMs: 1000 });
      const metrics = metricsSeat(taken);
      expect(snapshotLines(taken)).toHaveLength(0);
      vi.advanceTimersByTime(1000);
      expect(snapshotLines(taken)).toHaveLength(1);
      metrics.dispose();
      expect(snapshotLines(taken)).toHaveLength(2);
      vi.advanceTimersByTime(10_000);
      expect(snapshotLines(taken)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a finite env interval when config does not set one", () => {
    withEnvInterval("2000", () => {
      vi.useFakeTimers();
      try {
        const taken = seats();
        apply(ctx(taken) as never, {});
        const metrics = metricsSeat(taken);
        vi.advanceTimersByTime(1999);
        expect(snapshotLines(taken)).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(snapshotLines(taken)).toHaveLength(1);
        metrics.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("falls back to the 15-minute default when the env value is not numeric", () => {
    withEnvInterval("not-a-number", () => {
      vi.useFakeTimers();
      try {
        const taken = seats();
        apply(ctx(taken) as never, {});
        const metrics = metricsSeat(taken);
        vi.advanceTimersByTime(899_999);
        expect(snapshotLines(taken)).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(snapshotLines(taken)).toHaveLength(1);
        metrics.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("treats a blank env value as not configured and keeps the default", () => {
    withEnvInterval("", () => {
      vi.useFakeTimers();
      try {
        const taken = seats();
        apply(ctx(taken) as never, {});
        const metrics = metricsSeat(taken);
        vi.advanceTimersByTime(899_999);
        expect(snapshotLines(taken)).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(snapshotLines(taken)).toHaveLength(1);
        metrics.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
