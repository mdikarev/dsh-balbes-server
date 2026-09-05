import type { IncomingMessage, ServerResponse } from "node:http";

export type HttpAuth = "public" | "bearer";
export type HttpHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;

export interface HttpSeat {
  method: "POST" | "GET";
  path: string;            // exact path, e.g. /api/prompt
  auth: HttpAuth;
  handler: HttpHandler;
}

export interface StaticResult {
  status: number;
  body: Buffer | string;
  type?: string;
}

export interface BalbesHttp {
  post(path: string, auth: HttpAuth, handler: HttpHandler): void;
  registerStatic(serve: (pathname: string) => Promise<StaticResult | null>): void;
}
