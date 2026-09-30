import type { MemoryProposal, MemoryRecord, MemoryScope } from "dsh-balbes-contracts";

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

/** Channel and live session serving the agent's current task: provenance and classifier route. */
export interface MemoryWriteContext {
  /** "admin" (POST /api/prompt) or "telegram". */
  channel: string;
  /** Live agent session; becomes part of originRef. */
  sessionId: string;
  /** Agent model selection for the classifier; without it classification is skipped. */
  selection?: { provider: string; model: string };
}

/** Structural write slice of balbesMemory; the agent writes only through it. */
export interface MemoryWriteSlice {
  save(draft: {
    scope: MemoryScope;
    type: MemoryRecord["type"];
    text: string;
    tags?: string[];
    pinned?: boolean;
    origin: "agent";
    originRef?: string | null;
  }): Promise<MemoryRecord>;
}

/** Структурный write-срез пути ревью: служебный ход пишет только через него. */
export interface MemoryProposalDraft {
  scope: MemoryScope;
  type: MemoryRecord["type"];
  text: string;
  tags?: string[];
  originRef?: string | null;
}

export interface MemoryProposalSlice {
  propose(draft: MemoryProposalDraft): Promise<MemoryProposal>;
  listProposals(filter?: {
    scope?: MemoryScope;
    status?: MemoryProposal["status"][];
    limit?: number;
  }): Promise<MemoryProposal[]>;
}

/** Срез, нужный входному дедупу: очередь плюс чтение истины. */
export interface MemoryExtractionSlice extends MemoryProposalSlice {
  list(filter?: MemoryReadFilter): Promise<MemoryRecord[]>;
}

/** Факты завершённой задачи, по которым решает гейт извлечения; текста задачи тут нет. */
export interface ExtractionTurnFacts {
  ok: boolean;
  toolCalls: number;
}

/**
 * Место извлечения одного агента (p10g): слой владеет write-поверхностью
 * служебного хода, канал — самим ходом (агент, очередь, отмена).
 */
export interface MemoryExtractionHandle {
  /** Дешёвый гейт: успешная задача, в которой агент работал. Без вызова модели. */
  qualifies(facts: ExtractionTurnFacts): boolean;
  /** Снять `remember`, зарегистрировать `propose_memory`, вернуть директиву. */
  begin(): { message: string };
  /** Вернуть поверхность задачи и записать счётчики. Идемпотентен. */
  end(): void;
}

/** Per-agent handle; prepare() рендерит блоки одного хода. */
export interface MemoryContextAttachment {
  prepare(taskText: string): Promise<void>;
  /** Есть только тогда, когда слой может извлекать (write-контекст + save + propose + listProposals). */
  extraction?: MemoryExtractionHandle;
}

export interface BalbesMemoryContextService {
  attach(agentCtx: unknown, scope: MemoryContextScope, write?: MemoryWriteContext): MemoryContextAttachment;
}

/** Тег уровня записи в метриках: "global" или "project:<name>". */
export type MemoryMetricsScopeTag = string;

/** Канал, обслуживший ход или запрос: "admin" (POST /api/prompt) или "telegram". */
export type MemoryMetricsChannel = string;

/** Минимум о записи для топ-выдачи метрик: текста памяти тут нет by design. */
export interface MemoryRecordRef {
  type: string;
  scope: MemoryMetricsScopeTag;
}

/** Событие доставки одного хода: id по путям, опущенные записи и размеры блоков. */
export interface MemoryDeliveryEvent {
  channel: MemoryMetricsChannel;
  scope: MemoryMetricsScopeTag;
  core: { delivered: string[]; omitted: number; chars: number };
  map: { delivered: string[]; omitted: number; chars: number };
  push: { delivered: string[]; omitted: number; chars: number };
  records?: Record<string, MemoryRecordRef>;
}

/** Событие одного вызова `recall`: исход, латентность и выданные записи. */
export interface MemoryRecallEvent {
  channel: MemoryMetricsChannel;
  scope: MemoryMetricsScopeTag;
  outcome: "ok" | "empty" | "failed";
  latencyMs: number;
  delivered?: string[];
  records?: Record<string, MemoryRecordRef>;
}

/** Куда доставка пишет сигнал; реализация решает, что с ним делать. */
export interface MemoryMetricsSink {
  recordDelivery(event: MemoryDeliveryEvent): void;
  recordRecall(event: MemoryRecallEvent): void;
}

export interface MemoryMetricsTotals {
  turns: number;
  deliveries: number;
}

export interface MemoryMetricsChannelTotals extends MemoryMetricsTotals {}

export interface MemoryMetricsRecordMetrics {
  id: string;
  type: string;
  scope: MemoryMetricsScopeTag;
  inCore: number;
  inMap: number;
  inPush: number;
  recallDelivered: number;
  recallQueries: number;
}

export interface MemoryMetricsSnapshot {
  schema: 1;
  process: { startedAt: string; totals: MemoryMetricsTotals };
  window: { startedAt: string; durationMs: number; turns: number; deliveries: number };
  byChannel: Record<string, MemoryMetricsChannelTotals>;
  byScope: Record<string, MemoryMetricsChannelTotals>;
  recall: { calls: number; empty: number; failed: number; latencyMs: { total: number; max: number } };
  unqueriedDelivered: number;
  dropped: number;
  topRecords: MemoryMetricsRecordMetrics[];
}

export interface MemoryMetricsLogger {
  info?(message: string): void;
  warn(message: string): void;
}

/** Сервис метрик: приём событий, снимок окна и освобождение таймера. */
export interface MemoryMetricsService extends MemoryMetricsSink {
  snapshot(options?: { reset?: boolean; top?: number }): MemoryMetricsSnapshot;
  dispose(): void;
}
