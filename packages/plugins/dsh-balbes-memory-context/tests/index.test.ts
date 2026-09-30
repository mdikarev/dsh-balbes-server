import { describe, expect, it, vi } from "vitest";
import { apply, name, Config } from "../src/index.js";

interface Seats {
  provided: Map<string, unknown>;
  infos: string[];
  warnings: string[];
}

function ctx(seats: Seats): unknown {
  return {
    provide(key: string, value: unknown) {
      seats.provided.set(key, value);
    },
    logger: {
      warn: (message: string) => seats.warnings.push(message),
      info: (message: string) => seats.infos.push(message)
    }
  };
}

function seats(): Seats {
  return { provided: new Map(), infos: [], warnings: [] };
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

  it("logs the window snapshot on disposal and closes the timer", () => {
    vi.useFakeTimers();
    try {
      const taken = seats();
      apply(ctx(taken) as never, { intervalMs: 0 });
      const metrics = taken.provided.get("balbesMemoryMetrics") as {
        recordDelivery(event: unknown): void;
        dispose(): void;
      };
      metrics.recordDelivery({
        channel: "admin",
        scope: "global",
        core: { delivered: ["a"], omitted: 0, chars: 1 },
        map: { delivered: [], omitted: 0, chars: 0 },
        push: { delivered: [], omitted: 0, chars: 0 }
      });
      metrics.dispose();
      expect(taken.infos.join("\n")).toContain("balbes-memory-context: metrics key=server");
      expect(taken.infos.join("\n")).toContain("turns=1");
    } finally {
      vi.useRealTimers();
    }
  });
});
