import z from "@deepseek-ai/schemastery";
import { registerMemoryRoutes, type HttpSeatLike, type MemoryServiceLike, type MetricsLike } from "./routes.js";

export const name = "balbes-memory-admin";

/**
 * balbesHttp is the only injected service. The balbesMemory store and the
 * balbesMemoryMetrics sink are read lazily per request, so this plugin applies
 * regardless of the other plugins' load order and answers 503 (instead of a
 * generic 404) when either service is missing.
 */
export const inject = ["balbesHttp"];

export const Config = z.object({});

interface CtxLike {
  get(key: string): unknown;
  logger: { warn(message: string): void; info?(message: string): void };
}

export function apply(ctx: CtxLike, _config: unknown): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-memory-admin: balbesHttp service missing; routes not registered");
    return;
  }
  registerMemoryRoutes(
    http,
    () => ctx.get("balbesMemory") as MemoryServiceLike | undefined,
    ctx.logger,
    () => ctx.get("balbesMemoryMetrics") as MetricsLike | undefined
  );
}
