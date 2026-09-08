import z from "@deepseek-ai/schemastery";

export const name = "balbes-models";
export const inject = ["balbesHttp"];
export const Config = z.object({});

export function apply(ctx: { get(key: string): unknown; logger: { warn(m: string): void } }, _config: unknown): void {
  const http = ctx.get("balbesHttp") as { post(..._args: unknown[]): void } | undefined;
  if (http === undefined) ctx.logger.warn("balbes-models: balbesHttp service missing; routes not registered");
}
