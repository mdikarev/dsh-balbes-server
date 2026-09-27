import z from "@deepseek-ai/schemastery";
import { createMemoryContext, type MemoryContextLogger } from "./context.js";
import type { BalbesMemoryContextService } from "./types.js";

export const name = "balbes-memory-context";
export const Config = z.object({});

interface CtxLike {
  provide(key: string, value: unknown): void;
  logger: MemoryContextLogger;
}

export function apply(ctx: CtxLike, _config: unknown): void {
  const service: BalbesMemoryContextService = createMemoryContext(ctx.logger);
  ctx.provide("balbesMemoryContext", service);
}
