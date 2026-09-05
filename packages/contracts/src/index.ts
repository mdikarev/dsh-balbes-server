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
