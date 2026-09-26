import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { openMemoryDatabase } from "./schema.js";
import { createMemoryService } from "./service.js";

export const name = "balbes-memory";

export const Config = z.object({
  dshHome: z.string().required(false),
  memoryPath: z.string().required(false)
});

interface CtxLike {
  provide(key: string, value: unknown): void;
  effect(callback: () => (() => void) | void, label?: string): void;
  logger: { warn(message: string): void };
}

interface MemoryConfig {
  dshHome?: string;
  memoryPath?: string;
}

/**
 * Host-side memory store. Opens the SQLite database, migrates it, and provides
 * the balbesMemory service. On any open/migration failure it logs and provides
 * nothing, so the rest of the server keeps running.
 */
export async function apply(ctx: CtxLike, config: MemoryConfig): Promise<void> {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const dbPath = config.memoryPath ?? join(dshHome, "storages", "memory.sqlite");
  let db;
  try {
    db = await openMemoryDatabase(dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn("balbes-memory: failed to open " + dbPath + ": " + message);
    return;
  }
  ctx.provide("balbesMemory", createMemoryService(db));
  ctx.effect(() => () => {
    db.close();
  }, "balbesMemory.close");
}
