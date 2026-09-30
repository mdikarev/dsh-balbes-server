import z from "@deepseek-ai/schemastery";
import { createMemoryContext, type MemoryContextLogger } from "./context.js";
import { DEFAULT_METRICS_INTERVAL_MS, startMemoryMetrics } from "./metrics.js";
import type { BalbesMemoryContextService, MemoryMetricsService } from "./types.js";

export const name = "balbes-memory-context";
export const Config = z.object({ intervalMs: z.number().required(false) });

interface CtxLike {
  provide(key: string, value: unknown): void;
  logger: MemoryContextLogger;
}

/**
 * Метрики — эффект процесса, а не агента: один сервис на сервер, интервал
 * сброса окна в журнал. Нечисловой/неположительный интервал выключает таймер,
 * но снимок на сброс остаётся.
 */
export function apply(ctx: CtxLike, config: { intervalMs?: number }): void {
  const envInterval = Number(process.env.BALBES_MEMORY_METRICS_INTERVAL_MS);
  const intervalMs =
    typeof config.intervalMs === "number"
      ? config.intervalMs
      : Number.isFinite(envInterval) && process.env.BALBES_MEMORY_METRICS_INTERVAL_MS !== undefined
        ? envInterval
        : DEFAULT_METRICS_INTERVAL_MS;
  const metrics: MemoryMetricsService = startMemoryMetrics({ intervalMs, logger: ctx.logger });
  const service: BalbesMemoryContextService = createMemoryContext(ctx.logger, metrics);
  ctx.provide("balbesMemoryContext", service);
  ctx.provide("balbesMemoryMetrics", metrics);
}
