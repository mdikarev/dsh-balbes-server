import type {
  HealthResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  PromptRequest,
  PromptResponse,
  ApiErrorBody,
  WorkspaceListResponse,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResponse,
  WorkspaceEvent,
  WorkspaceScope,
  WorkspaceTreeRequest,
  WorkspaceTreeResponse,
  ModelsListResponse,
  ModelsSaveRequest,
  ModelsSaveResponse,
  ModelsDeleteRequest,
  ModelsDeleteResponse,
  ModelsDefaultRequest,
  ModelsDefaultResponse,
  ModelsCatalogRequest,
  ModelsCatalogResponse
} from "dsh-balbes-contracts";
import { createSseParser } from "./sse";

export const TOKEN_KEY = "balbes.authToken";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const stored = token ?? localStorage.getItem(TOKEN_KEY);
  if (stored) headers.authorization = `Bearer ${stored}`;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  if (!res.ok) {
    let errorBody: ApiErrorBody | null = null;
    try { errorBody = (await res.json()) as ApiErrorBody; } catch { /* not json */ }
    throw new ApiError(res.status, errorBody?.error.code ?? "http", errorBody?.error.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

export interface AdminApi {
  health(): Promise<HealthResponse>;
  login(login: string, password: string): Promise<LoginResponse>;
  me(): Promise<MeResponse>;
  prompt(text: string): Promise<PromptResponse>;
  listWorkspaces(): Promise<WorkspaceListResponse>;
  createWorkspace(name: string): Promise<WorkspaceCreateResponse>;
  deleteWorkspace(name: string): Promise<WorkspaceDeleteResponse>;
  readWorkspaceDir(scope: WorkspaceScope, name: string | undefined, path: string): Promise<WorkspaceTreeResponse>;
  listModels(): Promise<ModelsListResponse>;
  saveModel(req: ModelsSaveRequest): Promise<ModelsSaveResponse>;
  deleteModel(routeId: string): Promise<ModelsDeleteResponse>;
  setDefaultModel(provider: string, model: string): Promise<ModelsDefaultResponse>;
  /** Engine model catalog for a provider (deepseek route id or preset id). */
  catalogModels(provider: string): Promise<ModelsCatalogResponse>;
  subscribeWorkspaceEvents(cb: (e: WorkspaceEvent) => void): () => void;
  onUnauthorized(cb: () => void): void;
}

export function createApiClient(): AdminApi {
  const listeners = new Set<() => void>();
  const notify401 = (): void => {
    localStorage.removeItem(TOKEN_KEY);
    for (const cb of listeners) cb();
  };
  const guard = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) notify401();
      throw error;
    }
  };
  const eventListeners = new Set<(e: WorkspaceEvent) => void>();
  let eventController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const EVENT_RETRY_MS = 1500;

  const openEventStream = (): void => {
    if (eventController !== null || eventListeners.size === 0) return;
    const controller = new AbortController();
    eventController = controller;
    void (async () => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const stored = localStorage.getItem(TOKEN_KEY);
      if (stored !== null) headers.authorization = `Bearer ${stored}`;
      let retry = true; // reconnect on network/EOF failures and transient HTTP errors (5xx)
      try {
        const res = await fetch("/api/workspaces/events", {
          method: "POST",
          headers,
          body: "{}",
          signal: controller.signal
        });
        if (!res.ok) {
          retry = res.status >= 500; // 4xx is permanent (401 handled below); 5xx is transient
          if (res.status === 401) notify401();
          throw new ApiError(res.status, "events", `events stream failed: ${res.status}`);
        }
        if (res.body === null) throw new Error("events stream has no body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const onData = (data: string): void => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data) as WorkspaceEvent;
          } catch {
            return;
          }
          for (const fn of eventListeners) {
            try {
              fn(parsed as WorkspaceEvent);
            } catch {
              // one throwing listener must not abort the read loop for the rest
            }
          }
        };
        const feed = createSseParser(onData);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          feed(decoder.decode(value, { stream: true }));
        }
      } catch {
        // aborted by unsubscribe or network error: handled below
      } finally {
        eventController = null;
        if (eventListeners.size > 0 && retry && !controller.signal.aborted) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            openEventStream();
          }, EVENT_RETRY_MS);
        }
      }
    })();
  };
  return {
    health: () => request<HealthResponse>("/api/health", {}),
    login: async (login, password) => {
      const res = await guard(request<LoginResponse>("/api/auth/login", { login, password } satisfies LoginRequest));
      // persist the session token; a later 401 clears it via notify401
      localStorage.setItem(TOKEN_KEY, res.token);
      return res;
    },
    me: () => guard(request<MeResponse>("/api/auth/me", {})),
    prompt: (text) => guard(request<PromptResponse>("/api/prompt", { prompt: text } satisfies PromptRequest)),
    listWorkspaces: () => guard(request<WorkspaceListResponse>("/api/workspaces/list", {})),
    createWorkspace: (name) => guard(request<WorkspaceCreateResponse>("/api/workspaces/create", { name } satisfies WorkspaceCreateRequest)),
    deleteWorkspace: (name) => guard(request<WorkspaceDeleteResponse>("/api/workspaces/delete", { name } satisfies WorkspaceDeleteRequest)),
    readWorkspaceDir: (scope, name, path) => {
      const body: WorkspaceTreeRequest = name === undefined ? { scope, path } : { scope, name, path };
      return guard(request<WorkspaceTreeResponse>("/api/workspaces/tree", body));
    },
    listModels: () => guard(request<ModelsListResponse>("/api/models/list", {})),
    saveModel: (req) => guard(request<ModelsSaveResponse>("/api/models/save", req satisfies ModelsSaveRequest)),
    deleteModel: (routeId) => guard(request<ModelsDeleteResponse>("/api/models/delete", { routeId } satisfies ModelsDeleteRequest)),
    setDefaultModel: (provider, model) => guard(request<ModelsDefaultResponse>("/api/models/default", { provider, model } satisfies ModelsDefaultRequest)),
    catalogModels: (provider) =>
      guard(request<ModelsCatalogResponse>("/api/models/catalog", { provider } satisfies ModelsCatalogRequest)),
    subscribeWorkspaceEvents: (cb) => {
      eventListeners.add(cb);
      openEventStream();
      let alive = true;
      return () => {
        if (!alive) return;
        alive = false;
        eventListeners.delete(cb);
        if (eventListeners.size === 0) {
          eventController?.abort();
          eventController = null;
          if (reconnectTimer !== null) clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      };
    },
    onUnauthorized: (cb) => { listeners.add(cb); }
  };
}
