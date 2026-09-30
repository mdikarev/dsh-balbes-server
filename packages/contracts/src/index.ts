/** Empty POST request bodies are encoded as {} — see R-API-1. */

export interface HealthRequest {}
export interface HealthResponse {
  ok: true;
  version: string;
}

export interface LoginRequest {
  login: string;
  password: string;
}
export interface LoginResponse {
  token: string;
  expiresAt: string; // ISO 8601
}

export interface MeRequest {}
export interface MeResponse {
  login: string;
}

export interface PromptRequest {
  prompt: string;
}
export interface PromptResponse {
  text: string;
  reason?: {
    kind: string;
    code?: string;
    message?: string;
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiErrorBody["error"] };

/** GitHub source of a project created from a repository. */
export interface WorkspaceGitSource {
  provider: "github";
  /** Clean https URL without a token. */
  url: string;
  /** Default branch name. */
  branch: string;
  /** Resolved commit sha. */
  ref: string;
}

export interface WorkspaceProject {
  name: string;
  path: string;
  createdAt?: string; // ISO 8601; absent for hand-made dirs without a registry row
  /** Present only when the project was cloned from a git repository. */
  source?: WorkspaceGitSource;
}
export interface WorkspaceHome {
  path: string;
}

export interface WorkspaceListRequest {}
export interface WorkspaceListResponse {
  home: WorkspaceHome;
  projects: WorkspaceProject[];
}
export interface WorkspaceCreateRequest {
  name: string;
}
export interface WorkspaceCreateResponse {
  project: WorkspaceProject;
}
export interface WorkspaceDeleteRequest {
  name: string;
}
export interface WorkspaceDeleteResponse {}

export interface WorkspaceCreateFromGitRequest {
  url: string;
  name: string;
}
export interface WorkspaceCreateFromGitResponse {
  project: WorkspaceProject;
}

export interface GitStatusRequest {}
export interface GitStatusResponse {
  git: { tokenConfigured: boolean };
}
export interface GitSaveRequest {
  token: string;
}
export interface GitSaveResponse {
  git: { tokenConfigured: boolean };
}
export interface GitClearTokenRequest {}
export interface GitClearTokenResponse {
  git: { tokenConfigured: boolean };
}

/**
 * Suggested project slug from a GitHub https URL (UI prefill only; the server
 * validates whatever name is actually submitted). Null when the URL is not a
 * valid `https://github.com/<owner>/<repo>` URL.
 */
export function suggestProjectNameFromGitUrl(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/.exec(url);
  if (match === null) return null;
  const repo = match[2]!;
  return repo === "" ? null : repo;
}

export type WorkspaceScope = "home" | "project";

export interface WorkspaceTreeRequest {
  scope: WorkspaceScope;
  /** Project slug; required when scope === "project", absent for "home". */
  name?: string;
  /** Relative directory path inside the workspace root; "" means the root. */
  path: string;
}
export type WorkspaceTreeEntryKind = "dir" | "file" | "link";
export interface WorkspaceTreeEntry {
  name: string;
  kind: WorkspaceTreeEntryKind;
}
export interface WorkspaceTreeResponse {
  entries: WorkspaceTreeEntry[];
}

export type WorkspaceFileKind = "text" | "binary" | "link";
export type WorkspaceFileResult =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "binary"; size: number }
  | { kind: "link" };
export interface WorkspaceFileRequest {
  scope: WorkspaceScope;
  /** Проект-слаг; обязателен при scope === "project", отсутствует для "home". */
  name?: string;
  /** Относительный путь файла внутри корня воркспейса; "" недопустим. */
  path: string;
}
export interface WorkspaceFileResponse {
  file: WorkspaceFileResult;
}

export interface WorkspaceEventsRequest {}

/** Directory whose listing changed ("" = workspace root). */
export interface WorkspaceFsEvent {
  kind: "fs";
  scope: WorkspaceScope;
  name?: string;
  path: string;
}
/** Projects root changed: a project directory appeared/disappeared/was renamed. */
export interface WorkspaceListEvent {
  kind: "list";
}
export type WorkspaceEvent = WorkspaceFsEvent | WorkspaceListEvent;
export type ModelKind = "deepseek" | "preset" | "custom";

/**
 * Display data mirroring the engine pi-ai catalog provider ids (dsh 0.2.0-rc.2);
 * server keeps its own copy for validation (packages/plugins/dsh-balbes-models);
 * re-sync on engine upgrades.
 */
export const MODEL_PROVIDER_PRESETS: ReadonlyArray<{ providerId: string; label: string }> = [
  { providerId: "openai", label: "OpenAI" },
  { providerId: "anthropic", label: "Anthropic (Claude)" },
  { providerId: "openrouter", label: "OpenRouter" },
  { providerId: "groq", label: "Groq" },
  { providerId: "google", label: "Google (Gemini)" },
  { providerId: "mistral", label: "Mistral" },
  { providerId: "xai", label: "xAI (Grok)" },
  { providerId: "together", label: "Together" },
  { providerId: "cerebras", label: "Cerebras" },
  { providerId: "fireworks", label: "Fireworks" },
  { providerId: "opencode", label: "OpenCode" },
];

export interface ModelConnection {
  routeId: string;
  kind: ModelKind;
  /** Only for kind "preset"; equals routeId. */
  providerId?: string;
  displayName: string;
  baseURL?: string;
  hasKey: boolean;
  models: string[];
  isDefault: boolean;
}

export interface ModelsListRequest {}
export interface ModelsListResponse {
  connections: ModelConnection[];
  default: { provider: string; model: string };
}

export interface ModelsSaveRequest {
  routeId?: string;
  kind: ModelKind;
  /** Only for kind "preset"; catalog provider route id (== routeId). */
  provider?: string;
  displayName?: string;
  baseURL?: string;
  /** null clears the stored key; absent keeps it unchanged. */
  key?: string | null;
  models?: string[];
}
export interface ModelsSaveResponse {
  connection: ModelConnection;
}

export interface ModelsDeleteRequest {
  routeId: string;
}
export interface ModelsDeleteResponse {}

export interface ModelsDefaultRequest {
  provider: string;
  model: string;
}
export interface ModelsDefaultResponse {
  default: { provider: string; model: string };
}

/** Catalog model entry. */
export interface ModelOption {
  id: string;
  name?: string;
}

/** Connection route id: "deepseek-official" or a preset catalog id. */
export interface ModelsCatalogRequest {
  provider: string;
}

export interface ModelsCatalogResponse {
  provider: string;
  models: ModelOption[];
}

// Telegram settings surface — no secret ever leaves the server, tokenConfigured only
export type TelegramState = "not-configured" | "disabled" | "connected" | "error";

export interface TelegramSettingsStatus {
  state: TelegramState;
  /** Token presence is reported as a boolean; the token itself never appears in responses. */
  tokenConfigured: boolean;
  enabled: boolean;
  /** Answer streaming in the chat; an absent settings key resolves to true. */
  streamAnswers: boolean;
  /** Allowed Telegram user id; absent = no allowlist. */
  allowedUserId?: number;
  botUsername?: string;
  lastPollAt?: string; // ISO 8601
  /** R-API-1 error envelope shape; present only when state === "error". */
  error?: { code: string; message: string };
}

export interface TelegramStatusRequest {}
export interface TelegramStatusResponse {
  status: TelegramSettingsStatus;
}

export interface TelegramSaveRequest {
  /** Bot token to store; absent = keep unchanged (never echoed back). */
  token?: string;
  allowedUserId?: number;
  enabled?: boolean;
  /** Answer streaming in the chat; absent = keep the stored value. */
  streamAnswers?: boolean;
}
export interface TelegramSaveResponse {
  status: TelegramSettingsStatus;
}

export interface TelegramDisableRequest {}
export interface TelegramDisableResponse {
  status: TelegramSettingsStatus;
}

export interface TelegramClearTokenRequest {}
export interface TelegramClearTokenResponse {
  status: TelegramSettingsStatus;
}

export interface TelegramTestRequest {}
export interface TelegramTestResponse {
  username: string;
}

// Workspace sessions surface — read-only list of the sessions bound to a workspace
export interface WorkspaceSessionInfo {
  id: string;
  /** Заголовок сессии из её лога; null, когда события title в логе нет. */
  title: string | null;
  /** Канал, создавший сессию: сейчас "telegram"; строка — форма не ломается на новых. */
  channel: string;
  createdAt: string; // ISO 8601
}

export interface SessionsListRequest {
  scope: WorkspaceScope;
  /** Проект-слаг; обязателен для scope === "project", отсутствует для "home". */
  name?: string;
}
export interface SessionsListResponse {
  sessions: WorkspaceSessionInfo[];
}

// Session transcript surface — one workspace session's dialogue
export type TranscriptRole = "user" | "assistant" | "system" | "developer" | "tool";
export type TranscriptKind = "message" | "tool-call" | "tool-result" | "context";

export interface TranscriptEntry {
  seq: number;
  time: string; // ISO 8601
  role: TranscriptRole;
  kind: TranscriptKind;
  /** Видимое тело; "" для строк, у которых тело в detail. */
  text: string;
  /** Техническое тело свёрнутой строки (аргументы, результат, служебный текст). */
  detail?: string;
  /** kind === "tool-call". */
  toolName?: string;
  /** kind === "context": producer ContextForm (dsh 0.1.7-rc.1), когда объявлен. */
  form?: string;
  /** kind === "tool-result". */
  isError?: boolean;
  /** Событие входит в текущую модельную поверхность. */
  inContext: boolean;
}

export interface SessionsReadRequest {
  scope: WorkspaceScope;
  /** Проект-слаг; обязателен для scope === "project", отсутствует для "home". */
  name?: string;
  sessionId: string;
}
export interface SessionsReadResponse {
  session: WorkspaceSessionInfo;
  messages: TranscriptEntry[];
}

// Memory surface - owner-facing long-term memory (store is p10a, admin is p10b)
export type MemoryType = "fact" | "preference" | "decision" | "note";
export type MemoryScope = { kind: "global" } | { kind: "project"; name: string };
export type MemoryOrigin = "owner" | "agent";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags: string[];
  pinned: boolean;
  origin: MemoryOrigin;
  originRef: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface MemoryListRequest {
  scope?: MemoryScope;
  type?: MemoryType;
  tag?: string;
  pinned?: boolean;
  /** Non-blank value switches the server to FTS search. */
  query?: string;
  limit?: number;
  offset?: number;
}
export interface MemoryListResponse {
  records: MemoryRecord[];
}

export interface MemorySaveRequest {
  /** Present = update; absent = create. */
  id?: string;
  /** Required on create; rejected on update (scope is immutable). */
  scope?: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  pinned?: boolean;
}
export interface MemorySaveResponse {
  record: MemoryRecord;
}

export interface MemoryDeleteRequest {
  id: string;
}
export interface MemoryDeleteResponse {
  deleted: boolean;
}

// Memory review surface - staged proposals and owner autonomy (p10f)
export type MemoryProposalStatus = "proposed" | "accepted" | "rejected";

export interface MemoryProposal {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags: string[];
  origin: MemoryOrigin;
  originRef: string | null;
  status: MemoryProposalStatus;
  proposedAt: string; // ISO 8601
  decidedAt: string | null; // ISO 8601
  decidedBy: string | null; // v1: always "owner"
  decidedEdit: boolean;
  memoryId: string | null;
}

export interface MemoryAutonomyPolicy {
  /** Sources whose writes are truth immediately. */
  immediate: Array<"owner" | "remember">;
  /** Sources whose writes are staged for review. */
  review: Array<"pipeline">;
  /** There is no auto-approval path in v1. */
  autoApprove: "none";
}

export interface MemoryProposeRequest {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  tags?: string[];
  originRef?: string;
}
export interface MemoryProposeResponse {
  proposal: MemoryProposal;
}

export interface MemoryReviewListRequest {
  scope?: MemoryScope;
  type?: MemoryType;
  tag?: string;
  /** Absent = only `proposed`; an explicit list widens the queue to decided rows. */
  status?: MemoryProposalStatus[];
  limit?: number;
  offset?: number;
}
export interface MemoryReviewListResponse {
  proposals: MemoryProposal[];
  policy: MemoryAutonomyPolicy;
}

export interface MemoryReviewApproveRequest {
  id: string;
  type?: MemoryType;
  text?: string;
  tags?: string[];
  pinned?: boolean;
}
export interface MemoryReviewApproveResponse {
  proposal: MemoryProposal;
  record: MemoryRecord;
}

export interface MemoryReviewRejectRequest {
  id: string;
}
export interface MemoryReviewRejectResponse {
  proposal: MemoryProposal;
}
