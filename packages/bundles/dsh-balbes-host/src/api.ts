import z from "@deepseek-ai/schemastery";
import type { BalbesHttp } from "./types.js";
import { runPrompt, type PromptOutcome } from "./runner.js";

export const name = "balbes-api";
export const inject = ["balbesHttp", "agents", "agentDefaultModel", "sessions"];
export const Config = z.object({ version: z.string().default("0.1.0") });

export function apply(ctx: {
  get(key: string): unknown;
  logger: { warn(m: string): void };
}, config: { version: string }): void {
  const http = ctx.get("balbesHttp") as BalbesHttp;
  if (http === undefined) {
    ctx.logger.warn("balbes-api: balbesHttp service missing; routes not registered");
    return;
  }
  const agentCtx = ctx as never;
  const version = config.version;

  http.post("/api/health", "public", async (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version }));
  });

  http.post("/api/prompt", "bearer", async (_req, res, body) => {
    const b = body as { prompt?: unknown };
    if (typeof b.prompt !== "string" || b.prompt.trim() === "") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "bad-request", message: "prompt required" } }));
      return;
    }
    let outcome: PromptOutcome;
    try {
      outcome = await runPrompt(agentCtx, b.prompt);
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          text: "",
          reason: {
            kind: "error",
            code: "prompt-failed",
            message: error instanceof Error ? error.message : String(error)
          }
        })
      );
      return;
    }
    const status = outcome.reason?.kind === "error" ? 502 : 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(outcome));
  });
}
