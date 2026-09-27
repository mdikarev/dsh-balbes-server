import type { BalbesMemoryContextService } from "./types.js";

export interface MemoryContextLogger {
  warn(message: string): void;
  info?(message: string): void;
}

export function createMemoryContext(_logger: MemoryContextLogger): BalbesMemoryContextService {
  return { attach: () => ({ prepare: async () => {} }) };
}
