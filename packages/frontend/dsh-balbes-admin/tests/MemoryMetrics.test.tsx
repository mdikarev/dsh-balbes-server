import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MemoryMetrics from "../src/pages/MemoryMetrics";
import { ApiError, type AdminApi } from "../src/api/client";
import type { MemoryMetricsSnapshot } from "dsh-balbes-contracts";

afterEach(cleanup);

const METRICS: MemoryMetricsSnapshot = {
  schema: 1,
  process: { startedAt: "2026-10-01T00:00:00.000Z", totals: { turns: 42, deliveries: 7 } },
  window: { startedAt: "2026-10-01T00:30:00.000Z", durationMs: 15 * 60 * 1000, turns: 5, deliveries: 2 },
  byChannel: {
    admin: { turns: 3, deliveries: 1 },
    telegram: { turns: 2, deliveries: 1 }
  },
  byScope: {
    global: { turns: 4, deliveries: 2 },
    "project:alpha": { turns: 1, deliveries: 0 }
  },
  recall: { calls: 4, empty: 1, failed: 1, latencyMs: { total: 40, max: 12000 } },
  unqueriedDelivered: 3,
  dropped: 0,
  topRecords: [
    { id: "m-1", type: "note", scope: "global", inCore: 2, inMap: 1, inPush: 0, recallDelivered: 1, recallQueries: 1 },
    { id: "m-2", type: "fact", scope: "project:alpha", inCore: 0, inMap: 0, inPush: 1, recallDelivered: 0, recallQueries: 0 }
  ]
};

function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    memoryMetrics: vi.fn(async () => ({ metrics: METRICS })),
    ...overrides
  } as unknown as AdminApi;
}

describe("MemoryMetrics", () => {
  it("renders the window summary and the process totals as separate numbers", async () => {
    render(<MemoryMetrics api={makeApi()} />);
    expect(await screen.findByTestId("memory-metrics-window")).toBeTruthy();
    expect(screen.getByTestId("memory-metrics-window-turns").textContent).toBe("5");
    expect(screen.getByTestId("memory-metrics-window-deliveries").textContent).toBe("2");
    // process totals are cumulative and must not be confused with the window
    expect(screen.getByTestId("memory-metrics-process-turns").textContent).toBe("42");
    expect(screen.getByTestId("memory-metrics-process-deliveries").textContent).toBe("7");
  });

  it("derives the average recall latency from total/calls and shows the max", async () => {
    render(<MemoryMetrics api={makeApi()} />);
    expect(await screen.findByTestId("memory-metrics-recall-latency")).toBeTruthy();
    expect(screen.getByTestId("memory-metrics-recall-calls").textContent).toBe("4");
    expect(screen.getByTestId("memory-metrics-recall-empty").textContent).toBe("1");
    expect(screen.getByTestId("memory-metrics-recall-failed").textContent).toBe("1");
    expect(screen.getByTestId("memory-metrics-recall-latency").textContent).toBe("10.0 / 12 с");
  });

  it("shows the miss counters", async () => {
    render(<MemoryMetrics api={makeApi()} />);
    expect(await screen.findByTestId("memory-metrics-unqueried")).toBeTruthy();
    expect(screen.getByTestId("memory-metrics-unqueried").textContent).toBe("3");
    expect(screen.getByTestId("memory-metrics-dropped").textContent).toBe("0");
  });

  it("labels channels and scope tags in owner-facing Russian", async () => {
    render(<MemoryMetrics api={makeApi()} />);
    expect(await screen.findByTestId("memory-metrics-channel:admin")).toBeTruthy();
    expect(screen.getByTestId("memory-metrics-channel:admin").textContent).toContain("админка");
    expect(screen.getByTestId("memory-metrics-channel:telegram").textContent).toContain("Telegram");
    expect(screen.getByTestId("memory-metrics-scope:global").textContent).toContain("Дом");
    expect(screen.getByTestId("memory-metrics-scope:project:alpha").textContent).toContain("alpha");
  });

  it("renders the top records with type labels and hit counters", async () => {
    render(<MemoryMetrics api={makeApi()} />);
    const row = await screen.findByTestId("memory-metrics-row:m-1");
    expect(row.textContent).toContain("заметка");
    expect(row.textContent).toContain("m-1");
    expect(screen.getByTestId("memory-metrics-row:m-2").textContent).toContain("факт");
  });

  it("opens a record on demand instead of linking it unconditionally", async () => {
    const onOpenRecord = vi.fn();
    render(<MemoryMetrics api={makeApi()} onOpenRecord={onOpenRecord} />);
    fireEvent.click(await screen.findByTestId("memory-metrics-open:m-2"));
    expect(onOpenRecord).toHaveBeenCalledWith("m-2");
  });

  it("keeps ids as plain text when the owner has nowhere to jump", async () => {
    render(<MemoryMetrics api={makeApi()} />);
    expect(await screen.findByTestId("memory-metrics-row:m-1")).toBeTruthy();
    expect(screen.queryByTestId("memory-metrics-open:m-1")).toBeNull();
  });

  it("resets the window only after the confirmation modal", async () => {
    const memoryMetrics = vi.fn(async () => ({ metrics: METRICS }));
    render(<MemoryMetrics api={makeApi({ memoryMetrics } as Partial<AdminApi>)} />);
    fireEvent.click(await screen.findByTestId("memory-metrics-reset"));
    expect(memoryMetrics).toHaveBeenCalledTimes(1); // the mount load only

    fireEvent.click(screen.getByTestId("memory-metrics-reset-cancel"));
    expect(memoryMetrics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("memory-metrics-reset"));
    fireEvent.click(screen.getByTestId("memory-metrics-reset-confirm"));
    await waitFor(() => expect(memoryMetrics).toHaveBeenCalledWith({ reset: true }));
    expect((await screen.findByTestId("memory-metrics-notice")).textContent).toContain("тоталы процесса");
  });

  it("explains the documented 503 degradation instead of showing a retry", async () => {
    const api = makeApi({
      memoryMetrics: vi.fn(async () => { throw new ApiError(503, "metrics-unavailable", "memory metrics are not available"); })
    } as Partial<AdminApi>);
    render(<MemoryMetrics api={api} />);
    expect(await screen.findByTestId("memory-metrics-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("memory-metrics-retry")).toBeNull();
    expect(screen.getByTestId("memory-metrics").textContent).toContain("Записи");
  });

  it("shows a retry for a real read failure and recovers on the next call", async () => {
    const memoryMetrics = vi.fn()
      .mockRejectedValueOnce(new ApiError(500, "http", "boom"))
      .mockResolvedValueOnce({ metrics: METRICS });
    render(<MemoryMetrics api={makeApi({ memoryMetrics } as Partial<AdminApi>)} />);
    expect(await screen.findByTestId("memory-metrics-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("memory-metrics-retry"));
    expect(await screen.findByTestId("memory-metrics-window-turns")).toBeTruthy();
  });

  it("names an empty window a signal rather than a failure", async () => {
    const empty: MemoryMetricsSnapshot = {
      ...METRICS,
      window: { startedAt: METRICS.window.startedAt, durationMs: 60000, turns: 0, deliveries: 0 },
      recall: { calls: 0, empty: 0, failed: 0, latencyMs: { total: 0, max: 0 } },
      byChannel: {},
      byScope: {},
      topRecords: []
    };
    render(<MemoryMetrics api={makeApi({ memoryMetrics: vi.fn(async () => ({ metrics: empty })) } as Partial<AdminApi>)} />);
    expect(await screen.findByTestId("memory-metrics-empty")).toBeTruthy();
    expect(screen.getByTestId("memory-metrics-top-empty")).toBeTruthy();
    expect(screen.getByTestId("memory-metrics-recall-latency").textContent).toBe("—");
  });
});
