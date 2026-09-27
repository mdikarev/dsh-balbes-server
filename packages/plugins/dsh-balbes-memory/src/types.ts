import type { MemoryOrigin, MemoryRecord, MemoryScope, MemoryType } from "dsh-balbes-contracts";

export type { MemoryOrigin, MemoryRecord, MemoryScope, MemoryType } from "dsh-balbes-contracts";

export interface MemoryDraft {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  pinned?: boolean;
  origin: MemoryOrigin;
  originRef?: string | null;
}

export interface MemoryPatch {
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
  originRef?: string | null;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  scopes?: MemoryScope[];
  type?: MemoryType;
  tag?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchRequest {
  query: string;
  filter?: MemoryFilter;
  limit?: number;
}

export interface SearchHit {
  record: MemoryRecord;
  rank: number;
}

export interface BalbesMemoryService {
  save(draft: MemoryDraft): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  update(id: string, patch: MemoryPatch): Promise<MemoryRecord>;
  delete(id: string): Promise<boolean>;
  list(filter?: MemoryFilter): Promise<MemoryRecord[]>;
  search(request: SearchRequest): Promise<SearchHit[]>;
  count(filter?: MemoryFilter): Promise<number>;
}

export const MEMORY_TYPES = ["fact", "preference", "decision", "note"] as const;
export const MEMORY_ORIGINS = ["owner", "agent"] as const;

export const LIMITS = {
  maxTextBytes: 8192,
  maxTags: 32,
  maxTagLength: 32,
  maxOriginRefLength: 512,
  maxScopeNameLength: 64,
  defaultSearchLimit: 20,
  maxSearchLimit: 100,
  defaultListLimit: 100,
  maxListLimit: 500
} as const;
