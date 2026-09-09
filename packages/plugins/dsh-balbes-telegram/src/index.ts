import z from "@deepseek-ai/schemastery";
import { join } from "node:path";

/**
 * Cordis function plugin bridging the balbes profile to the Telegram Bot API.
 *
 * This scaffold pins the plugin contract (name/inject/Config/apply) and owns
 * the `balbes-telegram` settings namespace; the Bot API client, polling loop,
 * chat state and the /api/telegram/* admin routes are wired by later tasks on
 * top of what apply resolves here.
 */
export const name = "balbes-telegram";

/** Services this plugin depends on; the Loader injects them before apply. */
export const inject = ["balbesHttp", "settings", "credentials", "balbesWorkspaces", "agents", "sessions"];

/**
 * Credentials ref under which the Telegram bot token is stored by the
 * `credentials` service ($DSH_HOME/.credentials.yaml). The token never leaves
 * the server and never lands in the settings document.
 */
export const TELEGRAM_BOT_TOKEN_REF = "BALBES_TELEGRAM_BOT_TOKEN";

/**
 * Plugin config. schemastery treats nullish input as absent unless a field is
 * marked `.required()`, so `dshHome: z.string()` is the optional field of the
 * brief's zod spelling; apply resolves it config -> $DSH_HOME -> ~/.dsh.
 */
export const Config = z.object({
  dshHome: z.string(),
  apiBase: z.string().default("https://api.telegram.org"),
  maxFileBytes: z.number().default(256 * 1024)
});

/**
 * Schema of the `balbes-telegram` settings namespace, registered in apply.
 * Written in the schemastery 3.x grammar pinned by dsh 0.1.2-rc.1 for the
 * brief's zod expression: `enabled: z.boolean().default(false)` is verbatim;
 * `allowedUserId: z.number().int().min(1).nullable().default(null)` maps to
 * `z.natural().min(1)` (natural enforces the integer) unioned with
 * `z.const(null)` (the explicit "no allowlist" value). Absent and null
 * resolve to the same no-allowlist state; consumers read it as
 * `number | null | undefined`.
 */
export const telegramSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  allowedUserId: z.union([z.natural().min(1), z.const(null)]).default(null)
});

interface HttpSeatLike {
  post(path: string, auth: "public" | "bearer", handler: (req: unknown, res: unknown, body: unknown) => Promise<void> | void): void;
}
interface SettingsScopeLike {
  get(): unknown;
}
interface SettingsLike {
  register(namespace: string, schema: unknown): SettingsScopeLike;
}

export function apply(ctx: {
  get(key: string): unknown;
  logger: { warn(message: string): void };
}, config: { dshHome?: string; apiBase?: string; maxFileBytes?: number }): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-telegram: balbesHttp service missing; routes not registered");
    return;
  }
  const settings = ctx.get("settings") as SettingsLike;

  // Registering the namespace is an effect: it makes the stored section
  // schema-valid and reachable by the settings UI from boot onward.
  // The returned scope is closed over here for the admin routes and polling
  // loop that later tasks attach to `http`.
  const settingsScope = settings.register("balbes-telegram", telegramSettingsSchema);

  // Data home resolution matches auth/static/workspaces: config wins, then
  // $DSH_HOME, then the per-user default. Later tasks build the chat state
  // (telegram-state.json) and workspace session cwd from it.
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");

  void settingsScope;
  void dshHome;
}
