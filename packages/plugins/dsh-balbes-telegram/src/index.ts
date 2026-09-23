import z from "@deepseek-ai/schemastery";
import { AsyncResource } from "node:async_hooks";
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
  type TelegramSettingsSection,
  type TelegramStatus
} from "./admin.js";
import { createApprovalGate, type ApprovalAgentCtxLike, type ApprovalGate } from "./approvals.js";
import {
  createAgentTaskRunner,
  workspaceRefKey,
  type AgentTaskDeps,
  type AgentTaskRunner,
  type WorkspaceRef
} from "./agentTask.js";
import { createBotClient, type BotClient } from "./bot.js";
import {
  createChatMachine,
  refLabel,
  type ChannelSessionRow,
  type ChatDeps,
  type ChatMachine,
  type SessionsSlice,
  type WorkspaceFileResult,
  type WorkspaceTreeEntry
} from "./chat.js";
import { TELEGRAM_COMMANDS } from "./commands.js";
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

/**
 * Services this plugin depends on; the Loader injects them before apply.
 *
 * `balbesModels` is provided by the dsh-balbes-models plugin (the same
 * list/current/saveDefault slice the chat consumes) and `balbesSessions` by the
 * dsh-balbes-sessions plugin (the workspace session registry the channel
 * registers its sessions in). Every name here is REQUIRED by Cordis: a profile
 * that composes this channel must also compose both plugins — as the
 * deployable `balbes` profile does — or this entry stays pending and the
 * profile boot fails.
 */
export const inject = [
  "balbesHttp",
  "settings",
  "credentials",
  "balbesWorkspaces",
  "balbesSessions",
  "agents",
  "sessions",
  "agentDefaultModel",
  "balbesModels"
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
  maxFileBytes: z.number().default(256 * 1024),
  // dsh 0.1.7-rc.1 settings: an entry's form is projected from the Volatile
  // fields of its Config, and settings.update(entryId, patch) writes them. These
  // two ARE the `balbes-telegram` settings section the admin page edits; the
  // `telegramSettingsSchema` below mirrors them for the older register seam.
  enabled: z.boolean().default(false).volatile(),
  allowedUserId: z.union([z.natural().min(1), z.const(null)]).default(null).volatile()
});

/**
 * Schema of the `balbes-telegram` settings namespace, registered in apply.
 * Written in the schemastery 3.x grammar pinned by dsh 0.1.5-rc.2 for the
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

/**
 * The settings seam across the engine versions this plugin supports:
 *  - dsh <= 0.1.5: `register(ns, schema)` returned a per-namespace scope;
 *  - dsh 0.1.7-rc.1: namespaces are profile entry ids and the methods are
 *    `update(ns, patch)`; the live values live in this plugin's own Config.
 * `createSettingsScope` prefers `register` when present (unit fakes, older
 * engine) and otherwise binds the `balbes-telegram` entry's Config references.
 */
interface SettingsLike {
  register?(namespace: string, schema: unknown): TelegramSettingsScopeLike;
  update?(namespace: string, patch: object, expectedRevision?: number): Promise<void>;
}

/** The Config reference slice the 0.1.7 settings scope reads. */
interface TelegramConfigLike {
  dshHome?: string;
  apiBase?: string;
  maxFileBytes?: number;
  enabled?: { get(): boolean };
  allowedUserId?: { get(): number | null | undefined };
}

const SETTINGS_ENTRY_ID = "balbes-telegram";

/**
 * Captured at module evaluation (boot), where no HMR transaction is active.
 * dsh 0.1.7 wraps config writes in `hmr.runExclusive`, which uses an
 * AsyncLocalStorage to reject nested transactions. A settings watcher runs
 * inside that transaction, so anything it starts (the poller loop) would
 * inherit the store and every later `configEditor.edit` from the poller would
 * fail with "HMR transactions cannot be nested". Running the watcher callback
 * in this module-scope resource keeps the poller outside the transaction.
 */
const settingsWatchScope = new AsyncResource("balbes-telegram-settings-watch");

/** Read a live Volatile reference, tolerating a plain/absent value (unit fakes). */
function configRefValue<T>(ref: { get(): T } | undefined, fallback: T): T {
  return ref !== undefined && typeof ref.get === "function" ? ref.get() : fallback;
}

/**
 * Bind the `balbes-telegram` settings entry. dsh 0.1.7-rc.1 replaced the
 * per-namespace `register` with entry-id addressing, so the scope reads this
 * plugin's live Config references and writes through `settings.update`.
 */
function createSettingsScope(ctx: PluginCtx, settings: SettingsLike, config: TelegramConfigLike): TelegramSettingsScopeLike {
  if (typeof settings.register === "function") return settings.register(SETTINGS_ENTRY_ID, telegramSettingsSchema);
  const read = (): TelegramSettingsSection => ({
    enabled: configRefValue(config.enabled, false),
    allowedUserId: configRefValue(config.allowedUserId, null) ?? null
  });
  const update = settings.update?.bind(settings);
  if (update === undefined) {
    ctx.logger.warn("balbes-telegram: settings service has neither register nor update; settings are inert");
    return { get: read, update: async () => {}, watch: () => () => {} };
  }
  return {
    get: read,
    update: (patch: object) => update(SETTINGS_ENTRY_ID, patch),
    watch: (callback) => {
      let previous = read();
      const listener = (): void => {
        const next = read();
        const before = previous;
        previous = next;
        settingsWatchScope.runInAsyncScope(() => {
          void callback(next, before);
        });
      };
      ctx.on?.("app-boot/config-reload", listener);
      return () => {
        ctx.off?.("app-boot/config-reload", listener);
      };
    }
  };
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
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Structural slice of the sessions registry service (`balbesSessions`, provided
 * by the composed `dsh-balbes-sessions` plugin): the telegram package never
 * imports that plugin — the profile composes both.
 */
interface SessionsRegistryLike {
  register(ref: WorkspaceRef, sessionId: string, channel: string): Promise<void>;
  list(ref: WorkspaceRef): Promise<Array<{ sessionId: string; channel: string }>>;
}

/**
 * One title snapshot of the engine's `sessionQuery.readTitleSnapshots`, kept as
 * the engine's own discriminated union so the `value` payload is only reachable
 * on a fulfilled observation (no non-null assertions).
 */
type TitleObservationLike =
  | {
      sessionId: string;
      status: "fulfilled";
      value: { session: { createdAt: number }; title?: { title: string } };
    }
  | { sessionId: string; status: "rejected"; reason?: unknown };

/** Structural slice of the OPTIONAL engine seam that supplies titles/createdAt. */
interface SessionQueryLike {
  readTitleSnapshots(ids: readonly string[]): Promise<TitleObservationLike[]>;
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

export function apply(ctx: PluginCtx, config: TelegramConfigLike): void {
  const http = ctx.get("balbesHttp") as HttpSeatLike | undefined;
  if (http === undefined) {
    ctx.logger.warn("balbes-telegram: balbesHttp service missing; routes not registered");
    return;
  }
  const settings = ctx.get("settings") as SettingsLike;
  const credentials = ctx.get("credentials") as CredentialsServiceLike;
  const workspaces = ctx.get("balbesWorkspaces") as WorkspacesServiceLike | undefined;
  // The models plugin's service, whose members are exactly the chat's `models`
  // slice. `inject` above makes that service MANDATORY (Cordis 4 has no
  // optional inject): a profile that composes this channel must also compose
  // the models plugin, and dropping the `balbesModels` entry from `inject`
  // breaks the channel instead of degrading it. This read is therefore the
  // chat's defensive slice and nothing more — an absent service here means the
  // composition is already broken, not that a models-less profile is supported.
  const balbesModels = ctx.get("balbesModels") as ChatDeps["models"] | undefined;
  const sessionsRegistry = ctx.get("balbesSessions") as SessionsRegistryLike | undefined;
  // Optional by design: an absent engine degrades the catalog (no titles, no
  // timestamps) instead of making the whole channel mandatory on it.
  const sessionQuery = ctx.get("sessionQuery") as SessionQueryLike | undefined;
  if (sessionsRegistry === undefined) {
    ctx.logger.warn("balbes-telegram: balbesSessions service is not available; sessions will not be listed in the admin");
  }

  // Registering the namespace is an effect: it makes the stored section
  // schema-valid and reachable by the settings UI from boot onward.
  const settingsScope = createSettingsScope(ctx, settings, config);

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
      ...(live.offset !== undefined ? { offset: live.offset } : {}),
      ...(live.archived !== undefined && Object.keys(live.archived).length > 0 ? { archived: live.archived } : {})
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
        // only step left between a raw update and its handler.
        const classified = classify(update);
        if (classified === null) return;
        // Approval callbacks own the `ap:` namespace: the gate decides them and
        // answers the query itself, so they never reach the chat machine.
        if (classified.kind === "callback" && gate !== undefined && gate.handles(classified.data)) {
          await gate.onCallback(classified);
          return;
        }
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
    answerCallbackQuery: (callbackQueryId, opts) => runtime.bot().answerCallbackQuery(callbackQueryId, opts),
    setMyCommands: (commands) => runtime.bot().setMyCommands(commands),
    setChatMenuButton: (button) => runtime.bot().setChatMenuButton(button)
  };

  // Both optional agent seams are read defensively (the loader may only exist
  // while the Loader plugin is composed); the runner itself is inert until the
  // first task.
  const loader = ctx.get("loader") as { await(): Promise<void> } | undefined;
  const defaultModel = ctx.get("agentDefaultModel") as { currentSelection(): { provider: string; model: string } } | undefined;
  // Declared before the runner so its per-agent setup can reach the gate, then
  // assigned right after they are both built: the two are mutually recursive
  // (the gate needs the runner's progress, the runner needs the gate to attach).
  let gate: ApprovalGate | undefined;
  const runner = createAgentTaskRunner({
    // The runner reads workspaces through its own (looser) slice; the object
    // is the same service the chat machine consumes above.
    workspaces: workspaces as unknown as AgentTaskDeps["workspaces"],
    agents: ctx.get("agents") as AgentTaskDeps["agents"],
    sessions: ctx.get("sessions") as AgentTaskDeps["sessions"],
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(loader !== undefined ? { loader } : {}),
    approvals: {
      attach: (agentCtx, ref) => {
        gate?.attach(agentCtx as ApprovalAgentCtxLike, ref);
      }
    },
    logger: ctx.logger
  });

  gate = createApprovalGate({
    bot: chatBot,
    // Only a live, allowlisted channel may be asked to approve: a disabled bot
    // (or one without an allowlist) leaves the request to dsh's own default.
    ownerChatId: () => {
      const section = settingsScope.get();
      return section.enabled ? section.allowedUserId ?? undefined : undefined;
    },
    workspaceLabel: refLabel,
    taskText: (ref) => runner.progress(ref).taskText,
    logger: ctx.logger
  });

  /** Detach the live handle and make sessionId the workspace's active session. */
  async function selectSession(ref: WorkspaceRef, sessionId: string): Promise<void> {
    await runner.reset(ref);
    live.sessions[workspaceRefKey(ref)] = sessionId;
    persist();
  }

  /** Hide a session from the active list; archiving the active one also detaches it. */
  async function archiveSession(ref: WorkspaceRef, sessionId: string): Promise<void> {
    const key = workspaceRefKey(ref);
    const current = live.archived?.[key] ?? [];
    if (!current.includes(sessionId)) {
      live.archived = { ...(live.archived ?? {}), [key]: [...current, sessionId] };
    }
    if (live.sessions[key] === sessionId) {
      await runner.reset(ref);
      delete live.sessions[key];
    }
    persist();
  }

  /** Return a session to the active list; the active id is untouched. */
  async function unarchiveSession(ref: WorkspaceRef, sessionId: string): Promise<void> {
    const key = workspaceRefKey(ref);
    const current = live.archived?.[key];
    if (current === undefined) return;
    const next = current.filter((id) => id !== sessionId);
    const archived = { ...(live.archived ?? {}) };
    if (next.length === 0) delete archived[key];
    else archived[key] = next;
    live.archived = archived;
    persist();
  }

  /** The channel's session catalog: registry (telegram) joined with engine titles. */
  async function listChannelSessions(ref: WorkspaceRef): Promise<ChannelSessionRow[]> {
    const key = workspaceRefKey(ref);
    const entries = sessionsRegistry === undefined ? [] : await sessionsRegistry.list(ref);
    const telegram = entries.filter((entry) => entry.channel === "telegram");
    const archived = new Set(live.archived?.[key] ?? []);
    const activeId = live.sessions[key];
    const rows: ChannelSessionRow[] = [];
    let observations: TitleObservationLike[] | undefined;
    if (sessionQuery !== undefined && telegram.length > 0) {
      try {
        observations = await sessionQuery.readTitleSnapshots(telegram.map((entry) => entry.sessionId));
      } catch (error) {
        // A failed catalog read is not a per-row rejection: the engine is
        // unreachable, so NOTHING can be proven available. Fall through to the
        // degraded catalog below instead of marking every row unavailable.
        ctx.logger.warn(`balbes-telegram: reading session titles failed: ${reasonOf(error)}`);
      }
    }
    if (observations !== undefined) {
      const byId = new Map(observations.map((observation) => [observation.sessionId, observation]));
      for (const entry of telegram) {
        const observation = byId.get(entry.sessionId);
        if (observation !== undefined && observation.status === "fulfilled") {
          rows.push({
            id: entry.sessionId,
            title: observation.value.title?.title ?? null,
            createdAt: new Date(observation.value.session.createdAt).toISOString(),
            available: true,
            archived: archived.has(entry.sessionId),
            active: entry.sessionId === activeId
          });
        } else {
          rows.push({
            id: entry.sessionId,
            title: null,
            createdAt: null,
            available: false,
            archived: archived.has(entry.sessionId),
            active: entry.sessionId === activeId
          });
        }
      }
      // Total order: dated rows newest-first, undated (unavailable) rows last.
      // Array.prototype.sort is stable, so equal keys keep their registry order.
      rows.sort((a, b) => {
        if (a.createdAt === null && b.createdAt === null) return 0;
        if (a.createdAt === null) return 1;
        if (b.createdAt === null) return -1;
        if (a.createdAt === b.createdAt) return 0;
        return a.createdAt < b.createdAt ? 1 : -1;
      });
    } else {
      // DEGRADED catalog: the optional engine seam is absent, the registry has
      // no telegram entries, or readTitleSnapshots THREW (see the catch above).
      // Titles and timestamps are unknown, every row is offered as available in
      // registry-reversed order (newest registered first), and the archived and
      // active flags still apply.
      for (const entry of telegram) {
        rows.push({
          id: entry.sessionId,
          title: null,
          createdAt: null,
          available: true,
          archived: archived.has(entry.sessionId),
          active: entry.sessionId === activeId
        });
      }
      rows.reverse();
    }
    return rows;
  }

  const runnerWithSessions: AgentTaskRunner = {
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
          return result;
        }
        // A cancelled run keeps its session (the stop's own copy promises
        // «Контекст сохранён»), but its TaskResult carries no id — a rejected
        // result has no sessionId field. Read it from the live handle and
        // persist it: otherwise a workspace whose FIRST task was stopped has
        // no mapping on disk, and a restart before any successful task starts
        // a fresh session, which contradicts the answer the owner just got.
        if (result.code === "cancelled") {
          const sessionId = runner.sessionIdOf(ref);
          // The same empty-id guard as above, for the same reason.
          if (sessionId !== undefined && sessionId !== "" && live.sessions[key] !== sessionId) {
            live.sessions[key] = sessionId;
            persist();
          }
          // The spec's invariant — «создал сессию для воркспейса ⇒ она в
          // реестре» — holds on this path too: a stop KEEPS the session (the
          // receipt promises «Контекст сохранён»), so a workspace whose FIRST
          // run was stopped must still show up in the admin's «Сессии» tab.
          // Without this the mapping lands in telegram-state.json and nowhere
          // else, and the session stays invisible until some later successful
          // task happens to re-register it. Same contract as the successful
          // path above: an empty id is never registered (the registry rejects
          // it) and a registry failure is logged without changing the task
          // outcome. The registry dedupes by id, so a repeat stop is a no-op.
          if (sessionId !== undefined && sessionId !== "" && sessionsRegistry !== undefined) {
            await sessionsRegistry
              .register(ref, sessionId, "telegram")
              .catch((error: unknown) =>
                ctx.logger.warn(
                  `balbes-telegram: registering session ${sessionId} in the workspace registry failed: ${
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
    cancel: (ref) => runner.cancel(ref),
    progress: (ref) => runner.progress(ref),
    sessionIdOf: (ref) => runner.sessionIdOf(ref) ?? live.sessions[workspaceRefKey(ref)],
    snapshot: () => runner.snapshot()
  };

  const channelSessions: SessionsSlice = {
    list: listChannelSessions,
    select: selectSession,
    archive: archiveSession,
    unarchive: unarchiveSession
  };

  const chat: ChatMachine = createChatMachine({
    workspaces: workspaces as ChatDeps["workspaces"],
    runner: runnerWithSessions,
    bot: chatBot,
    maxFileBytes,
    ...(balbesModels !== undefined ? { models: balbesModels } : {}),
    // The catalog is exposed only when its source (the registry) is composed;
    // absent, the chat falls back to "list unavailable" instead of failing.
    ...(sessionsRegistry !== undefined ? { sessions: channelSessions } : {}),
    // The gate is always composed, so the live and menu cards can show a
    // pending request; it never changes which callbacks the chat handles.
    approvals: gate,
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

  /**
   * Push the command list and the native «Меню» button to Telegram.
   *
   * Best-effort by design: the chat works without them (the owner can still
   * type every command), so a rejected call must never take polling down — it
   * only records a warning. Idempotent: the same table is pushed on every
   * successful transition, and Telegram keeps the last write.
   */
  async function registerCommands(): Promise<void> {
    let client: BotClient;
    try {
      client = runtime.bot();
    } catch {
      return; // no token stored yet: nothing to register against
    }
    try {
      await client.setMyCommands(
        TELEGRAM_COMMANDS.map((spec) => ({ command: spec.command, description: spec.description }))
      );
      await client.setChatMenuButton();
    } catch (error) {
      // bot.ts masks the token in every error it raises, so this line names the
      // failure without leaking the credential.
      ctx.logger.warn(`balbes-telegram: command registration failed: ${reasonOf(error)}`);
    }
  }

  /** Joinable: the settings watcher returns this, which serializes commits. */
  const reconcile = async (): Promise<void> => {
    await booted;
    await runtime.apply();
    // The list belongs to a live channel: registering on a transition that
    // leaves the loop OFF (no token, disabled, no allowlist) would make an
    // admin path that does not poll call Telegram — and the settings watcher
    // awaits this promise, so that call would be charged to the SPA's commit.
    // Canon says it plainly: registered «на каждом успешном старте polling».
    if (poller.status().state === "running") await registerCommands();
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
    // Withdraw every open approval first: disposal settles each pending request
    // as cancelled and clears its timer, so nothing is left waiting on a
    // callback that can no longer arrive.
    gate?.withdrawAll();
    void poller.stop();
  }, "balbes-telegram:poller");
}
