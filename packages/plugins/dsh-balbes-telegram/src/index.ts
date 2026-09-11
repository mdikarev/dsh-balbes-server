import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import {
  TELEGRAM_BOT_TOKEN_REF,
  bindRuntimeToSettings,
  createTelegramRuntime,
  pollerTimingOptions,
  registerTelegramRoutes,
  restoreTelegramBoot,
  type HttpSeatLike,
  type TelegramAdminDeps,
  type TelegramCredentialsLike,
  type TelegramSettingsScopeLike,
  type TelegramStatus
} from "./admin.js";
import {
  createAgentTaskRunner,
  workspaceRefKey,
  type AgentTaskDeps,
  type AgentTaskRunner,
  type WorkspaceRef
} from "./agentTask.js";
import { createBotClient, type BotClient } from "./bot.js";
import { createChatMachine, type ChatDeps, type ChatMachine, type WorkspaceFileResult, type WorkspaceTreeEntry } from "./chat.js";
import { createPoller } from "./poller.js";
import { TelegramState, type TelegramStateData } from "./state.js";
import { classify } from "./updates.js";

/**
 * Cordis function plugin bridging the balbes profile to the Telegram Bot API.
 *
 * `apply` is the assembly point of the whole channel: it registers the
 * `balbes-telegram` settings namespace, builds the state store, the workspace
 * aware agent runner, the polling runtime and the owner's chat machine, then
 * exposes the five bearer admin routes and restores the persisted state.
 *
 * Nothing here talks to Telegram until the owner stores a token and switches
 * the channel on; polling then starts and stops through settings commits and
 * admin calls, never through a plugin restart.
 */
export const name = "balbes-telegram";

/** Services this plugin depends on; the Loader injects them before apply. */
export const inject = [
  "balbesHttp",
  "settings",
  "credentials",
  "balbesWorkspaces",
  "balbesSessions",
  "agents",
  "sessions",
  "agentDefaultModel"
];

export { TELEGRAM_BOT_TOKEN_REF, type TelegramStatus };

/**
 * Plugin config. schemastery treats nullish input as absent unless a field is
 * marked `.required()`, so `dshHome: z.string()` is the optional field of the
 * brief's zod spelling; apply resolves it config -> $DSH_HOME -> ~/.dsh.
 *
 * `apiBase` defaults from `BALBES_TELEGRAM_API_BASE` when the environment
 * provides one (Task 12): a REAL-composition profile must be able to point the
 * whole channel at a local fake Bot API server, and that server's port is only
 * known at spawn time — a value a static `cordis.patch.yml` config cannot
 * carry. An explicit `config.apiBase` still wins.
 */
export const Config = z.object({
  dshHome: z.string(),
  apiBase: z.string().default(process.env.BALBES_TELEGRAM_API_BASE ?? "https://api.telegram.org"),
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

/** Fallback display cut for one file; mirrors the Config schema default. */
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

interface SettingsLike {
  register(namespace: string, schema: unknown): TelegramSettingsScopeLike;
}

/**
 * The credentials service slice used here: the admin routes only need
 * presence/write/erase, while the polling runtime also resolves the VALUE.
 */
interface CredentialsServiceLike extends TelegramCredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>;
}

/**
 * Structural slice of the Task 4 `BalbesWorkspacesService` (the telegram
 * package never imports the workspaces plugin — the profile composes both), in
 * the chat machine's own shape: `root()` additionally feeds the agent runner.
 */
interface WorkspacesServiceLike {
  list(): Promise<{ home: { path: string }; projects: Array<{ name: string; path: string }> }>;
  root(scope: "home" | "project", name: string | undefined): Promise<string>;
  readDir(scope: "home" | "project", name: string | undefined, relPath: string): Promise<WorkspaceTreeEntry[]>;
  readFile(scope: "home" | "project", name: string | undefined, relPath: string): Promise<WorkspaceFileResult>;
}

/** The context slice the plugin uses (dsh's Context type is not imported here). */
interface PluginCtx {
  get(key: string): unknown;
  logger: { warn(message: string): void };
  effect?(execute: () => () => void, label?: string): unknown;
}

/**
 * Structural slice of the sessions registry service (`balbesSessions`, provided
 * by the composed `dsh-balbes-sessions` plugin): the telegram package never
 * imports that plugin — the profile composes both.
 */
interface SessionsRegistryLike {
  register(ref: WorkspaceRef, sessionId: string, channel: string): Promise<void>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `home` | `project:<имя>` -> ссылка на воркспейс (формат ключа из state). */
function refFromStateKey(key: string): WorkspaceRef | undefined {
  if (key === "home") return { scope: "home" };
  if (key.startsWith("project:")) {
    const name = key.slice("project:".length);
    return name === "" ? undefined : { scope: "project", name };
  }
  return undefined;
}

export function apply(ctx: PluginCtx, config: { dshHome?: string; apiBase?: string; maxFileBytes?: number }): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-telegram: balbesHttp service missing; routes not registered");
    return;
  }
  const settings = ctx.get("settings") as SettingsLike;
  const credentials = ctx.get("credentials") as CredentialsServiceLike;
  const workspaces = ctx.get("balbesWorkspaces") as WorkspacesServiceLike | undefined;
  const sessionsRegistry = ctx.get("balbesSessions") as SessionsRegistryLike | undefined;
  if (sessionsRegistry === undefined) {
    ctx.logger.warn("balbes-telegram: balbesSessions service is not available; sessions will not be listed in the admin");
  }

  // Registering the namespace is an effect: it makes the stored section
  // schema-valid and reachable by the settings UI from boot onward.
  const settingsScope = settings.register("balbes-telegram", telegramSettingsSchema);

  // Data home resolution matches auth/static/workspaces: config wins, then
  // $DSH_HOME, then the per-user default.
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const apiBase = config.apiBase;
  // The chat truncates what it displays with this ceiling (the workspaces
  // service reads with its own), so the configured value caps the visible text.
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const state = new TelegramState(TelegramState.defaultFile(dshHome));

  // Live view of $DSH_HOME/telegram-state.json. One in-memory document is
  // mutated by every writer (poll offset, active workspace, session mapping)
  // and flushed through one serialized chain: each save rewrites the whole
  // file, so two writers building their own snapshots concurrently would each
  // drop the other's field.
  let live: TelegramStateData = { version: 1, sessions: {} };
  let saveChain: Promise<void> = Promise.resolve();

  /** Queue a full write of the current live document; never rejects. */
  function persist(): void {
    const snapshot: TelegramStateData = {
      version: 1,
      sessions: { ...live.sessions },
      ...(live.activeWorkspace !== undefined ? { activeWorkspace: live.activeWorkspace } : {}),
      ...(live.offset !== undefined ? { offset: live.offset } : {})
    };
    saveChain = saveChain
      .then(() => state.save(snapshot))
      .catch((error: unknown) => {
        ctx.logger.warn(`balbes-telegram: state save failed: ${reasonOf(error)}`);
      });
  }

  const poller = createPoller(
    {
      onUpdate: async (update) => {
        // Authorization already happened in the poller: classification is the
        // only step left between a raw update and the chat machine.
        const classified = classify(update);
        if (classified === null) return;
        await (classified.kind === "message" ? chat.onMessage(classified) : chat.onCallback(classified));
      },
      onFatal: (error) => {
        // The poller owns the "error" state; this is the operator-facing trace.
        ctx.logger.warn(`balbes-telegram: polling stopped: ${error.message}`);
      },
      // Persist the ACKNOWLEDGED offset only. Deriving it from onUpdate would
      // regress it (a batch can end with unauthorized updates that are never
      // delivered) and re-deliver already-handled commands after a restart.
      // onAck is typed `void`: the write is queued, never awaited, and its
      // failure is contained by persist() rather than surfacing as an
      // unhandled rejection inside the poll loop.
      onAck: (offset) => {
        live.offset = offset;
        persist();
      }
    },
    pollerTimingOptions()
  );

  // Both the runtime and the `test` route need the credential's VALUE; the
  // routes otherwise only care about its presence.
  const resolveToken = async (): Promise<string | undefined> => {
    const resolved = await credentials.resolve(TELEGRAM_BOT_TOKEN_REF);
    const value = resolved?.value;
    // A blank stored value counts as "not configured": it would only produce
    // requests to /bot/getMe, which cannot succeed.
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  const botFactory = (token: string): BotClient => createBotClient({ token, ...(apiBase !== undefined ? { apiBase } : {}) });

  const runtime = createTelegramRuntime({
    settingsScope,
    resolveToken,
    botFactory,
    poller,
    // Read lazily: the boot restore lands before the first transition, and the
    // poller keeps its own offset from the first start onward.
    initialOffset: () => live.offset,
    logger: ctx.logger
  });

  // Per-token client indirection: every method forwards to the client bound to
  // the CURRENT token and returns its resolved value unchanged. The chat keys
  // its rendered views by the `sendMessage` message id, so dropping that value
  // would make a freshly sent list look stale; replacing the token therefore
  // never has to reach the chat machine.
  const chatBot: BotClient = {
    getMe: () => runtime.bot().getMe(),
    getUpdates: (opts) => runtime.bot().getUpdates(opts),
    sendMessage: (chatId, text, extra) => runtime.bot().sendMessage(chatId, text, extra),
    editMessageText: (chatId, messageId, text, extra) => runtime.bot().editMessageText(chatId, messageId, text, extra),
    answerCallbackQuery: (callbackQueryId, opts) => runtime.bot().answerCallbackQuery(callbackQueryId, opts)
  };

  const runnerWithSessions: AgentTaskRunner = (() => {
    // Both optional agent seams are read defensively (the loader may only exist
    // while the Loader plugin is composed); the runner itself is inert until the
    // first task.
    const loader = ctx.get("loader") as { await(): Promise<void> } | undefined;
    const defaultModel = ctx.get("agentDefaultModel") as { currentSelection(): { provider: string; model: string } } | undefined;
    const runner = createAgentTaskRunner({
      // The runner reads workspaces through its own (looser) slice; the object
      // is the same service the chat machine consumes above.
      workspaces: workspaces as unknown as AgentTaskDeps["workspaces"],
      agents: ctx.get("agents") as AgentTaskDeps["agents"],
      sessions: ctx.get("sessions") as AgentTaskDeps["sessions"],
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      ...(loader !== undefined ? { loader } : {}),
      logger: ctx.logger
    });
    return {
      run(ref, text, opts) {
        const key = workspaceRefKey(ref);
        // Lazy resume: the persisted session id is offered on the first task of
        // a workspace (the runner ignores it while it already holds a handle).
        const sessionId = opts?.sessionId ?? live.sessions[key];
        return runner.run(ref, text, sessionId === undefined ? undefined : { sessionId }).then(async (result) => {
          if (result.ok) {
            // An empty id is rejected by the state store's shape check and would
            // make every later save of the whole document fail: never store one.
            if (result.sessionId === "") {
              ctx.logger.warn("balbes-telegram: agent reported an empty session id; nothing persisted");
              return result;
            }
            live.sessions[key] = result.sessionId;
            persist();
            if (sessionsRegistry !== undefined) {
              // Витрина сессий воркспейса: сбой записи в реестр не меняет исход
              // задачи — регистрация логируется и остаётся best-effort.
              await sessionsRegistry
                .register(ref, result.sessionId, "telegram")
                .catch((error: unknown) =>
                  ctx.logger.warn(
                    `balbes-telegram: registering session ${result.sessionId} in the workspace registry failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  )
                );
            }
          }
          return result;
        });
      },
      async reset(ref) {
        await runner.reset(ref);
        // The session was disposed by the reset: keeping its id would make the
        // next task for this workspace resume a session that no longer exists.
        const key = workspaceRefKey(ref);
        if (key in live.sessions) {
          delete live.sessions[key];
          persist();
        }
      },
      sessionIdOf: (ref) => runner.sessionIdOf(ref),
      snapshot: () => runner.snapshot()
    };
  })();

  const chat: ChatMachine = createChatMachine({
    workspaces: workspaces as ChatDeps["workspaces"],
    runner: runnerWithSessions,
    bot: chatBot,
    maxFileBytes,
    onActiveChange: (ref) => {
      // An absent key is the only representation of "no workspace": the state
      // store rejects an empty string.
      if (ref === undefined) delete live.activeWorkspace;
      else live.activeWorkspace = workspaceRefKey(ref);
      persist();
    },
    logger: ctx.logger
  });

  const statusExtras = async (): Promise<{
    botUsername?: string;
    lastPollAt?: string;
    runtimeError?: { code: string; message: string };
  }> => {
    const extras: {
      botUsername?: string;
      lastPollAt?: string;
      runtimeError?: { code: string; message: string };
    } = {};
    const username = runtime.botUsername();
    const lastPollAt = runtime.lastPollAt();
    const runtimeError = runtime.lastError();
    if (username !== undefined) extras.botUsername = username;
    if (lastPollAt !== undefined) extras.lastPollAt = lastPollAt;
    if (runtimeError !== undefined) extras.runtimeError = runtimeError;
    return extras;
  };

  // Every transition waits for the boot restore: starting the poller without
  // the persisted offset would re-deliver updates this process already handled.
  // The runtime serializes transitions on one tail, so the joinable form below
  // and the kicked one used by the routes cannot interleave.
  let booted: Promise<void> = Promise.resolve();
  /** Joinable: the settings watcher returns this, which serializes commits. */
  const reconcile = async (): Promise<void> => {
    await booted;
    await runtime.apply();
  };
  /**
   * Fire-and-forget kick for the admin routes: a transition may have to wait out
   * an in-flight long poll before it can stop the loop, and an HTTP response must
   * not be held for that (T9-1). The runtime records its own failures (reported
   * through /status), and this explicit catch keeps an unexpected rejection from
   * becoming unhandled.
   */
  const requestRuntime = (): void => {
    void reconcile().catch((error: unknown) => {
      ctx.logger.warn(`balbes-telegram: runtime transition failed: ${reasonOf(error)}`);
    });
  };

  registerTelegramRoutes(http, {
    settingsScope,
    credentials,
    resolveToken,
    botFactory,
    poller,
    statusExtras,
    applyRuntime: requestRuntime
  } satisfies TelegramAdminDeps);

  // "Settings changes start/stop polling without a restart": a commit from the
  // settings UI reaches the same idempotent reconciliation the routes request.
  bindRuntimeToSettings(settingsScope, reconcile, ctx.logger);

  booted = restoreTelegramBoot({
    load: () => state.load(),
    // A missing service means "cannot list", never "no projects": the remembered
    // workspace must not be cleared just because the seam is unavailable.
    ...(workspaces !== undefined ? { workspaces } : {}),
    setActive: (ref: WorkspaceRef | undefined) => chat.setActiveWorkspace(ref),
    logger: ctx.logger
  })
    .then(async (outcome) => {
      live = outcome.data;
      // The remembered workspace was deleted while the server was down: persist
      // the removal instead of leaving a dangling key on disk.
      if (outcome.clearedActive) persist();
      // Sessions that already existed before this boot (or before the registry
      // was introduced) reach the admin through this idempotent upsert: a
      // repeated key is a no-op in the registry, so nothing is ever duplicated.
      if (sessionsRegistry !== undefined) {
        for (const [key, sessionId] of Object.entries(live.sessions)) {
          const ref = refFromStateKey(key);
          if (ref === undefined) {
            ctx.logger.warn(`balbes-telegram: cannot map state key "${key}" to a workspace; session not registered`);
            continue;
          }
          await sessionsRegistry.register(ref, sessionId, "telegram").catch((error: unknown) =>
            ctx.logger.warn(
              `balbes-telegram: syncing session ${sessionId} into the workspace registry failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          );
        }
      }
    })
    .catch((error: unknown) => {
      // Boot restore is best-effort by construction; keep `booted` resolvable so
      // every later transition (and every route) still runs.
      ctx.logger.warn(`balbes-telegram: boot restore failed: ${reasonOf(error)}`);
    });
  void reconcile().catch((error: unknown) => {
    ctx.logger.warn(`balbes-telegram: runtime start failed: ${reasonOf(error)}`);
  });

  // Disposal stops the loop and leaves no timer behind: the poller clears its
  // sleep timer when the loop is aborted. The wait for an in-flight getUpdates
  // is deliberately not awaited here — a disposal must not block on the network
  // (bot.ts retries with 60s timeouts, so `stop()` can take minutes on a dead
  // network; ctx.effect's disposer is only awaited while unloading).
  ctx.effect?.(() => () => {
    void poller.stop();
  }, "balbes-telegram:poller");
}
