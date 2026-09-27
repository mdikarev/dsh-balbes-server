import type { MemoryRecord, MemoryScope } from "dsh-balbes-contracts";

export type { MemoryRecord, MemoryScope } from "dsh-balbes-contracts";

/** Уровень, для которого включается доставка: дом (global) или один проект. */
export type MemoryContextScope = { kind: "global" } | { kind: "project"; name: string };

/** Read-only срез фильтра сервиса balbesMemory, нужный этому слою. */
export interface MemoryReadFilter {
  scopes?: MemoryScope[];
  type?: MemoryRecord["type"];
  tag?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemorySearchHit {
  record: MemoryRecord;
  rank: number;
}

/** Read-only структурный срез p10a: слой никогда не пишет. */
export interface BalbesMemoryReadSlice {
  list(filter?: MemoryReadFilter): Promise<MemoryRecord[]>;
  search(request: { query: string; filter?: MemoryReadFilter; limit?: number }): Promise<MemorySearchHit[]>;
  count(filter?: MemoryReadFilter): Promise<number>;
}

/** Per-agent handle; prepare() рендерит блоки одного хода. */
export interface MemoryContextAttachment {
  prepare(taskText: string): Promise<void>;
}

export interface BalbesMemoryContextService {
  attach(agentCtx: unknown, scope: MemoryContextScope): MemoryContextAttachment;
}
