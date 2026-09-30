import z from "@deepseek-ai/schemastery";
import { createMemoryContext, type MemoryContextLogger } from "./context.js";
import { DEFAULT_METRICS_INTERVAL_MS, startMemoryMetrics } from "./metrics.js";
import type { BalbesMemoryContextService, MemoryMetricsService } from "./types.js";

export const name = "balbes-memory-context";
export const Config = z.object({ intervalMs: z.number().required(false) });

interface CtxLike {
  provide(key: string, value: unknown): void;
  effect?(callback: () => (() => void) | void, label?: string): void;
  logger: MemoryContextLogger;
}

/**
 * Метрики — эффект процесса, а не агента: один сервис на сервер, интервал
 * сброса окна в журнал. Приоритет: конечное значение config.intervalMs, затем
 * конечное значение BALBES_MEMORY_METRICS_INTERVAL_MS; отсутствующее, пустое или
 * нечисловое (включая нефинитное вроде NaN/Infinity) значение конфига и
 * переменной даёт дефолт 15 минут. Таймер выключает только конечное значение
 * ≤ 0; снимок на сброс остаётся.
 */
export function apply(ctx: CtxLike, config: { intervalMs?: number }): void {
  const raw = process.env.BALBES_MEMORY_METRICS_INTERVAL_MS?.trim();
  const envInterval = raw ? Number(raw) : Number.NaN;
  const intervalMs =
    typeof config.intervalMs === "number" && Number.isFinite(config.intervalMs)
      ? config.intervalMs
      : Number.isFinite(envInterval)
        ? envInterval
        : DEFAULT_METRICS_INTERVAL_MS;
  const metrics: MemoryMetricsService = startMemoryMetrics({ intervalMs, logger: ctx.logger });
  const service: BalbesMemoryContextService = createMemoryContext(ctx.logger, metrics);
  ctx.provide("balbesMemoryContext", service);
  ctx.provide("balbesMemoryMetrics", metrics);
  ctx.effect?.(
    () => () => {
      metrics.dispose();
    },
    "balbesMemoryMetrics.dispose"
  );
}
