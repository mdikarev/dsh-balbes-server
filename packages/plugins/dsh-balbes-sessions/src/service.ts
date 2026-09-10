import { WorkspaceSessionsRegistry, type WorkspaceRef, type WorkspaceSessionEntry } from "./registry.js";

/**
 * Фасад домена для других плагинов: единственный способ записи в реестр.
 * Предоставляется как "balbesSessions".
 */
export interface BalbesSessionsService {
  register(ref: WorkspaceRef, sessionId: string, channel: string): Promise<void>;
  list(ref: WorkspaceRef): Promise<WorkspaceSessionEntry[]>;
}

export function createSessionsService(registry: WorkspaceSessionsRegistry): BalbesSessionsService {
  return {
    register: (ref, sessionId, channel) => registry.register(ref, sessionId, channel),
    list: (ref) => registry.list(ref)
  };
}
