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

export interface WorkspaceProject {
  name: string;
  path: string;
  createdAt?: string; // ISO 8601; absent for hand-made dirs without a registry row
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
export type ModelKind = "deepseek" | "custom";

export interface ModelConnection {
  routeId: string;
  kind: ModelKind;
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

