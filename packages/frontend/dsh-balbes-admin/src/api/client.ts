import type {
  HealthResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  PromptRequest,
  PromptResponse,
  ApiErrorBody
} from "dsh-balbes-contracts";

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
    onUnauthorized: (cb) => { listeners.add(cb); }
  };
}
