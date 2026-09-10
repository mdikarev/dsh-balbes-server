import { BotApiError, type BotClient } from "./bot.js";
import type { WorkspaceRef } from "./agentTask.js";
import type { Poller } from "./poller.js";
import type { TelegramStateData } from "./state.js";

/**
 * Telegram admin surface: the five bearer POST routes, the status mapping they
 * report, the polling runtime those routes drive and the boot restore the
 * plugin needs before polling may start.
 *
 * Everything here is injected — `http` seats, the settings scope, credentials,
 * the bot factory and the poller — so the whole admin surface is unit-testable
 * without a socket, a token or a state file. `index.ts` owns the assembly, the
 * state document and the chat machine; this module owns the wire contract.
 */

/**
 * Credentials ref under which the Telegram bot token is stored by the
 * `credentials` service ($DSH_HOME/.credentials.yaml). The token never leaves
 * the server and never lands in the settings document; the routes below read
 * only its presence, and the runtime resolves its value for the Bot client.
 * Re-exported from `index.ts`, which is where the plugin's public surface is.
 */
export const TELEGRAM_BOT_TOKEN_REF = "BALBES_TELEGRAM_BOT_TOKEN";

/** The response seat slice these routes write through. */
export interface ResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** The registration seat slice of the `balbesHttp` service. */
export interface HttpSeatLike {
  post(
    path: string,
    auth: "public" | "bearer",
    handler: (req: unknown, res: ResLike, body: unknown) => Promise<void> | void
  ): void;
}

/**
 * State of the Telegram channel as the admin API reports it (mirrors
 * `TelegramSettingsStatus` in `dsh-balbes-contracts`, which the plugin package
 * deliberately does not import — the profile composes both packages).
 * `not-configured` wins over `disabled`: an owner who removed the token sees
 * "не настроено" even though the stored setting is switched off.
 */
export type TelegramRuntimeState = "not-configured" | "disabled" | "connected" | "error";

export interface TelegramStatus {
  state: TelegramRuntimeState;
  tokenConfigured: boolean;
  enabled: boolean;
  /** Absent while no allowlist is configured. */
  allowedUserId?: number;
  /** `getMe` identity of the stored token, once known (never the token itself). */
  botUsername?: string;
  /** ISO 8601 timestamp of the last successful long poll. */
  lastPollAt?: string;
  /** Present only while `state === "error"`. */
  error?: { code: string; message: string };
}

/**
 * The `allowedUserId` key may be absent from a resolved section (an absent key
 * is dropped by the settings resolution), which is the same "no allowlist" as
 * an explicit `null`: consumers test `== null`.
 */
export interface TelegramSettingsSection {
  enabled: boolean;
  allowedUserId?: number | null;
}

export interface TelegramSettingsScopeLike {
  get(): TelegramSettingsSection;
  update(patch: object): Promise<void>;
  watch(callback: (next: TelegramSettingsSection, prev: TelegramSettingsSection) => void | Promise<void>): () => void;
}

export interface TelegramCredentialsLike {
  describe(ref: string): Promise<{ configured: boolean; writable?: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

export interface TelegramAdminDeps {
  settingsScope: TelegramSettingsScopeLike;
  credentials: TelegramCredentialsLike;
  /** Current token VALUE, for the connection test only; undefined when unset. */
  resolveToken(): Promise<string | undefined>;
  botFactory(token: string): BotClient;
  poller: Poller;
  /** Extra runtime facts for the status body, never secret. */
  statusExtras(): Promise<{
    botUsername?: string;
    lastPollAt?: string;
    /** Last transition failure of the polling runtime, when it has one. */
    runtimeError?: { code: string; message: string };
  }>;
  /**
   * REQUEST a runtime reconciliation and return at once. The transition is
   * serialized inside the runtime and contains its own failures (they surface
   * through the status body), so a route never waits for a `stop()` that can take
   * as long as an in-flight long poll settles (T9-1): the response reports the
   * settings plus the current runtime snapshot, and a later `/status` shows where
   * the loop ended up.
   */
  applyRuntime(): void;
}

/** Stable, safe error codes (R-API-1 envelopes). */
const CODE_INTERNAL = "internal";
const CODE_INVALID_USER_ID = "invalid-user-id";
const CODE_INVALID_CONFIG = "invalid-config";
const CODE_NOT_CONFIGURED = "not-configured";
const CODE_INVALID_TOKEN = "invalid-token";
const CODE_TELEGRAM_ERROR = "telegram-error";

/** Reported when the bot is enabled but no loop is running. */
export const CODE_POLLING_NOT_RUNNING = "not-running";

const NOT_RUNNING_MESSAGE = "polling is not running";

/** Reported when a runtime transition itself failed. */
export const CODE_RUNTIME_ERROR = "runtime-error";

/** Poller timings handed to `createPoller`; keep in sync with poller.ts defaults. */
const DEFAULT_POLL_IDLE_MS = 300;
const DEFAULT_POLL_MAX_BACKOFF_MS = 30_000;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function send(res: ResLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
  res.end(payload);
}

function fail(res: ResLike, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

/** An R-API-1 request body is a JSON object; anything else carries no fields. */
function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Both timings are validated: `idleMs: 0` would spin the loop on the API and
 * `maxBackoffMs: 0` would retry a failing network with no pause at all
 * (task-9 carry-forward ruling). A value that is not a finite positive number
 * falls back to the poller's own documented default.
 */
export function pollerTimingOptions(
  overrides: { idleMs?: number; maxBackoffMs?: number } = {}
): { idleMs: number; maxBackoffMs: number } {
  const positiveOr = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    idleMs: positiveOr(overrides.idleMs, DEFAULT_POLL_IDLE_MS),
    maxBackoffMs: positiveOr(overrides.maxBackoffMs, DEFAULT_POLL_MAX_BACKOFF_MS)
  };
}

/**
 * Map the current settings, credential presence and poller into the wire
 * status. `lastError` is reported as a detail of an error STATE, never as the
 * detector of one: the poller keeps `lastError` until the next `start`, so
 * treating it as "currently broken" would show a permanent failure after a
 * single network blip (the poller's own contract says as much).
 */
export async function buildTelegramStatus(deps: TelegramAdminDeps): Promise<TelegramStatus> {
  const section = deps.settingsScope.get();
  const enabled = section.enabled === true;
  const allowedUserId = section.allowedUserId ?? undefined;
  const configured = (await deps.credentials.describe(TELEGRAM_BOT_TOKEN_REF)).configured;
  const extras = await deps.statusExtras();
  const poll = deps.poller.status();

  const status: TelegramStatus = { state: "error", tokenConfigured: configured, enabled };
  if (allowedUserId !== undefined) status.allowedUserId = allowedUserId;
  if (extras.botUsername !== undefined) status.botUsername = extras.botUsername;
  const lastPollAt = extras.lastPollAt ?? poll.lastPollAt;
  if (lastPollAt !== undefined) status.lastPollAt = lastPollAt;

  if (!configured) {
    status.state = "not-configured";
    return status;
  }
  if (!enabled) {
    status.state = "disabled";
    return status;
  }
  if (poll.state === "running") {
    status.state = "connected";
    return status;
  }
  status.error = poll.lastError ?? extras.runtimeError ?? { code: CODE_POLLING_NOT_RUNNING, message: NOT_RUNNING_MESSAGE };
  return status;
}

/**
 * Register the five bearer POST routes (R-API-1: POST only, `{error:{code,
 * message}}` on failure). No response body ever carries the token — the status
 * surface reports `tokenConfigured` and nothing else about the credential.
 */
export function registerTelegramRoutes(http: HttpSeatLike, deps: TelegramAdminDeps): void {
  /**
   * Kick the reconciliation without joining it. A transition may have to wait out
   * an in-flight `getUpdates` before it can stop the loop (~50s against a healthy
   * Telegram, minutes on a dead network), and an HTTP response must never be held
   * for that (T9-1). The runtime serializes transitions and records its own
   * failures, which the status body then reports.
   */
  const kickRuntime = (): void => deps.applyRuntime();

  http.post("/api/telegram/status", "bearer", async (_req, res) => {
    try {
      send(res, 200, { status: await buildTelegramStatus(deps) });
    } catch (error) {
      fail(res, 500, CODE_INTERNAL, reasonOf(error));
    }
  });

  http.post("/api/telegram/save", "bearer", async (_req, res, body) => {
    try {
      const input = asRecord(body);
      // An absent/empty/non-string token means "keep the stored one"; only a
      // non-empty string replaces it.
      const token = typeof input.token === "string" ? input.token.trim() : "";
      const hasUser = input.allowedUserId !== undefined;
      if (hasUser && !isPositiveInteger(input.allowedUserId)) {
        fail(res, 400, CODE_INVALID_USER_ID, "allowedUserId must be a positive integer");
        return;
      }
      const enabled = typeof input.enabled === "boolean" ? input.enabled : undefined;

      const section = deps.settingsScope.get();
      const configured = token !== "" || (await deps.credentials.describe(TELEGRAM_BOT_TOKEN_REF)).configured;
      const allowedUserId = hasUser ? input.allowedUserId : section.allowedUserId ?? undefined;
      // Enabling is refused as a WHOLE request: nothing is written, so a
      // refused save leaves both the settings and the credential untouched.
      if (enabled === true && (!configured || allowedUserId === undefined)) {
        fail(res, 400, CODE_INVALID_CONFIG, "store a bot token and a positive User ID before enabling the bot");
        return;
      }

      if (token !== "") await deps.credentials.set(TELEGRAM_BOT_TOKEN_REF, token);
      const patch: Record<string, unknown> = {};
      if (hasUser) patch.allowedUserId = allowedUserId;
      if (enabled !== undefined) patch.enabled = enabled;
      // A token-only save changes no setting; writing an empty patch would only
      // add an empty user section to the settings document.
      if (Object.keys(patch).length > 0) await deps.settingsScope.update(patch);
      kickRuntime();
      send(res, 200, { status: await buildTelegramStatus(deps) });
    } catch (error) {
      fail(res, 500, CODE_INTERNAL, reasonOf(error));
    }
  });

  // The connection test calls getMe and nothing else: it starts no polling,
  // stores nothing and changes no setting.
  http.post("/api/telegram/test", "bearer", async (_req, res) => {
    try {
      const token = await deps.resolveToken();
      if (token === undefined) {
        fail(res, 400, CODE_NOT_CONFIGURED, "bot token is not configured");
        return;
      }
      const me = await deps.botFactory(token).getMe();
      send(res, 200, { username: typeof me.username === "string" ? me.username : "" });
    } catch (error) {
      if (error instanceof BotApiError && (error.status === 401 || error.telegramCode === 401)) {
        fail(res, 400, CODE_INVALID_TOKEN, "telegram rejected the bot token");
        return;
      }
      // A Bot API error message is token-redacted by bot.ts; anything else is
      // reported generically so no unexpected string can leak to the client.
      fail(res, 502, CODE_TELEGRAM_ERROR, error instanceof BotApiError ? error.message : "getMe failed");
    }
  });

  http.post("/api/telegram/disable", "bearer", async (_req, res) => {
    try {
      await deps.settingsScope.update({ enabled: false });
      kickRuntime();
      send(res, 200, { status: await buildTelegramStatus(deps) });
    } catch (error) {
      fail(res, 500, CODE_INTERNAL, reasonOf(error));
    }
  });

  // Dropping the credential also switches the bot off: a stored "enabled" with
  // no token could never poll, and the settings would claim otherwise.
  http.post("/api/telegram/clear-token", "bearer", async (_req, res) => {
    try {
      await deps.credentials.unset(TELEGRAM_BOT_TOKEN_REF);
      await deps.settingsScope.update({ enabled: false });
      kickRuntime();
      send(res, 200, { status: await buildTelegramStatus(deps) });
    } catch (error) {
      fail(res, 500, CODE_INTERNAL, reasonOf(error));
    }
  });
}

/** The `project:<name>` state key prefix (see `workspaceRefKey`). */
const PROJECT_KEY_PREFIX = "project:";

/**
 * Convert the persisted `activeWorkspace` key back into a workspace reference,
 * re-checking existence against the live project list: `home` always exists,
 * `project:<name>` must still be listed, and anything else (a damaged key, a
 * workspace deleted while the server was down) resolves to `undefined` so the
 * caller clears it.
 */
export function workspaceRefFromKey(key: string, projectNames: readonly string[]): WorkspaceRef | undefined {
  if (key === "home") return { scope: "home" };
  if (!key.startsWith(PROJECT_KEY_PREFIX)) return undefined;
  const name = key.slice(PROJECT_KEY_PREFIX.length);
  if (name === "" || name.includes(":") || !projectNames.includes(name)) return undefined;
  return { scope: "project", name };
}

export interface TelegramBootDeps {
  /** Read the persisted document (damage is an error here, not a silent reset). */
  load(): Promise<TelegramStateData>;
  /**
   * The live project list, for re-checking the remembered workspace. Absent (or
   * failing) means the list cannot be read — which is NOT the same as "the
   * workspace is gone", so nothing is cleared in that case.
   */
  workspaces?: { list(): Promise<{ projects: Array<{ name: string }> }> };
  /** Hand the restored (or cleared) selection to the chat machine. */
  setActive(ref: WorkspaceRef | undefined): void;
  logger?: { warn(m: string): void };
}

export interface TelegramBootOutcome {
  /** The document the host should keep in memory (already repaired). */
  data: TelegramStateData;
  /** True when the remembered workspace was dropped and must be persisted. */
  clearedActive: boolean;
}

/**
 * Restore the persisted channel state at boot.
 *
 * The active workspace is re-validated against the live project list, and one
 * that no longer exists is REMOVED from the document — never stored as an empty
 * string, which the state store rejects. The session map is restored as-is: it
 * is the lazy `opts.sessionId` source of the first task per workspace, not
 * something the runner pre-loads. A damaged document or an unreadable project
 * list is a warning, not a failed boot.
 */
export async function restoreTelegramBoot(deps: TelegramBootDeps): Promise<TelegramBootOutcome> {
  let data: TelegramStateData;
  try {
    data = await deps.load();
  } catch (error) {
    // Damage is loud but never fatal: the admin routes must stay reachable even
    // when the state document cannot be read (state.ts refuses to reset it, so
    // the file keeps whatever it held until the next successful save).
    deps.logger?.warn(`dsh-balbes-telegram: boot restore failed: ${reasonOf(error)}; continuing with empty state`);
    return { data: { version: 1, sessions: {} }, clearedActive: false };
  }

  const key = data.activeWorkspace;
  if (key === undefined) return { data, clearedActive: false };

  let projectNames: string[];
  try {
    if (deps.workspaces === undefined) throw new Error("the balbesWorkspaces service is not available");
    projectNames = (await deps.workspaces.list()).projects.map((project) => project.name);
  } catch (error) {
    // A missing service or a transient listing failure must not destroy the
    // persisted selection: the chat starts with no active workspace, the key
    // survives and the next boot can still restore it.
    deps.logger?.warn(`dsh-balbes-telegram: boot restore could not list workspaces: ${reasonOf(error)}`);
    deps.setActive(undefined);
    return { data, clearedActive: false };
  }

  const ref = workspaceRefFromKey(key, projectNames);
  if (ref !== undefined) {
    deps.setActive(ref);
    return { data, clearedActive: false };
  }

  const { activeWorkspace: _dropped, ...rest } = data;
  deps.setActive(undefined);
  return { data: rest, clearedActive: true };
}

export interface TelegramRuntimeDeps {
  settingsScope: TelegramSettingsScopeLike;
  /** Resolve the stored bot token; undefined when none is configured. */
  resolveToken(): Promise<string | undefined>;
  /** Build a client for one token; a new token means a new client. */
  botFactory(token: string): BotClient;
  poller: Poller;
  /** Offset to resume from on the FIRST start of this process (boot restore). */
  initialOffset?(): number | undefined;
  logger?: { warn(m: string): void };
}

export interface TelegramRuntime {
  /**
   * Make the polling loop match the current settings and credential. Transitions
   * are serialized on one internal tail, so a `start` can never overtake the
   * `stop` that preceded it. Resolves when this transition has settled — which
   * may be as late as an in-flight long poll does (T9-1) — and never rejects.
   */
  apply(): Promise<void>;
  /** Resolves once every transition requested so far has settled. */
  settled(): Promise<void>;
  /** The client bound to the current token; throws while no token is stored. */
  bot(): BotClient;
  botUsername(): string | undefined;
  lastPollAt(): string | undefined;
  /** Last transition failure, reported through the status body. */
  lastError(): { code: string; message: string } | undefined;
  /** Settles when the in-flight identity refresh (if any) has finished. */
  botInfoSettled(): Promise<void>;
}

/**
 * The polling runtime: it owns the per-token Bot client indirection and keeps
 * the poller in step with the settings.
 *
 * The client is rebuilt whenever the stored token changes, so a replaced token
 * takes effect on the next transition without a plugin restart; the chat
 * machine holds a forwarding client (`bot()`) rather than an instance, which is
 * why every forwarding method must keep returning what the real one returned
 * (the chat keys its view snapshots by the `sendMessage` message id).
 *
 * Transitions are single-flight on one tail, and each one re-reads the settings
 * after every await. Two reconciles per settings commit are normal (the route
 * kick plus the settings watcher), and a transition parked in a `stop()` that
 * drains an in-flight long poll can be overtaken by a newer intent; without both
 * guards the older transition would resume and `start()` a loop the current
 * settings forbid — e.g. the owner disables the bot while an allowlist change is
 * still winding the loop down.
 */
export function createTelegramRuntime(deps: TelegramRuntimeDeps): TelegramRuntime {
  let client: BotClient | undefined;
  let clientToken: string | undefined;
  let username: string | undefined;
  /** The client and allowlist the running loop was started with. */
  let runningClient: BotClient | undefined;
  let runningAllowedUserId: number | undefined;
  /** The restored offset belongs to the first start only (the poller keeps it after). */
  let firstStart = true;
  let refresh: Promise<void> = Promise.resolve();
  /** Serialized transition tail; never rejects (see `transition`). */
  let tail: Promise<void> = Promise.resolve();
  /**
   * Bumped when a transition is REQUESTED, not when it starts running: a request
   * arriving while an earlier transition sits in a slow `stop()` invalidates that
   * transition at once, before it can act on a stale intent.
   */
  let generation = 0;
  let lastTransitionError: { code: string; message: string } | undefined;

  const warn = (message: string): void => deps.logger?.warn(`dsh-balbes-telegram: runtime: ${message}`);

  /** The settings intent a transition must still match when it acts. */
  interface Intent {
    enabled: boolean;
    allowedUserId: number | undefined;
  }

  function readIntent(): Intent {
    const section = deps.settingsScope.get();
    // An absent key is the same "no allowlist" as an explicit null.
    return { enabled: section.enabled === true, allowedUserId: section.allowedUserId ?? undefined };
  }

  function sameIntent(a: Intent, b: Intent): boolean {
    return a.enabled === b.enabled && a.allowedUserId === b.allowedUserId;
  }

  /** Resolve the token and (re)build the client when it changed. */
  async function currentClient(): Promise<BotClient | undefined> {
    const token = await deps.resolveToken();
    if (token === undefined) {
      client = undefined;
      clientToken = undefined;
      // The cached identity belongs to the token that is gone.
      username = undefined;
      return undefined;
    }
    if (client === undefined || clientToken !== token) {
      client = deps.botFactory(token);
      clientToken = token;
      username = undefined;
    }
    return client;
  }

  /**
   * Refresh the cached `getMe` identity in the background: the status endpoint
   * wants it, but neither a settings commit nor an HTTP request may wait for a
   * call that retries with 60s timeouts on a dead network.
   */
  function refreshIdentity(target: BotClient): void {
    refresh = target.getMe().then(
      (me) => {
        if (client === target && typeof me.username === "string") username = me.username;
      },
      (error: unknown) => {
        warn(`getMe failed: ${reasonOf(error)}`);
      }
    );
  }

  /** Stop the loop and forget what it was started with. */
  async function stopPolling(): Promise<void> {
    await deps.poller.stop();
    runningClient = undefined;
    runningAllowedUserId = undefined;
  }

  /** True while the loop runs for exactly this client and allowlist. */
  function isRunningFor(target: BotClient, allowedUserId: number): boolean {
    return (
      deps.poller.status().state === "running" && runningClient === target && runningAllowedUserId === allowedUserId
    );
  }

  /**
   * The settings no longer match what this transition was asked to do: queue a
   * fresh transition instead of acting on the stale intent. This is what makes
   * the guard independent of the settings watcher's delivery — the newest intent
   * always ends up applied.
   */
  function requeue(): void {
    warn("settings changed while a transition was in flight; reconciling again");
    void apply();
  }

  /** One transition; see {@link createTelegramRuntime} for the staleness rule. */
  async function runTransition(gen: number): Promise<void> {
    const intent = readIntent();
    // Resolve the token even while disabled: the runtime's client then matches
    // the stored credential as soon as one exists.
    const target = await currentClient();

    // A newer request decides now; it is already queued behind this one.
    if (gen !== generation) return;
    // The owner changed something while the credential was being read.
    if (!sameIntent(readIntent(), intent)) return requeue();

    if (!intent.enabled) return stopPolling();
    if (target === undefined) {
      warn("enabled without a configured bot token; polling stays off");
      return stopPolling();
    }
    if (intent.allowedUserId === undefined) {
      warn("enabled without an allowed user id; polling stays off");
      return stopPolling();
    }

    if (username === undefined) refreshIdentity(target);
    if (isRunningFor(target, intent.allowedUserId)) return;

    // `start` is a no-op while running, so a replaced token or allowlist takes
    // effect only after an awaited stop — which is exactly the window in which a
    // newer intent can arrive.
    await deps.poller.stop();
    if (gen !== generation) return;
    if (!sameIntent(readIntent(), intent)) return requeue();

    runningClient = target;
    runningAllowedUserId = intent.allowedUserId;
    const restored = firstStart ? deps.initialOffset?.() : undefined;
    firstStart = false;
    deps.poller.start({
      bot: target,
      allowedUserId: intent.allowedUserId,
      ...(restored !== undefined ? { offset: restored } : {})
    });
  }

  /**
   * Contain one transition's failure: the tail must stay resolvable (a route
   * kick is fire-and-forget) and the failure must be reportable, not swallowed.
   */
  async function transition(gen: number): Promise<void> {
    try {
      await runTransition(gen);
      lastTransitionError = undefined;
    } catch (error) {
      lastTransitionError = { code: CODE_RUNTIME_ERROR, message: reasonOf(error) };
      warn(`transition failed: ${reasonOf(error)}`);
    }
  }

  /** Request a transition; never rejects (see {@link transition}). */
  function apply(): Promise<void> {
    const gen = ++generation;
    const run = tail.then(() => transition(gen));
    tail = run;
    return run;
  }

  /** Wait until the tail stops growing: a transition may re-queue itself. */
  async function settled(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = tail;
      await seen;
    } while (seen !== tail);
  }

  return {
    apply,
    settled,
    bot(): BotClient {
      if (client === undefined) throw new Error("telegram bot client is not configured");
      return client;
    },
    botUsername: () => username,
    lastPollAt: () => deps.poller.status().lastPollAt,
    lastError: () => lastTransitionError,
    botInfoSettled: () => refresh
  };
}

/**
 * Wire the settings namespace to the polling runtime: every committed change
 * reconciles it. This is what makes a settings write from the SPA start or stop
 * polling without a plugin restart; the admin routes request the same reconcile
 * directly, so both paths are idempotent and indistinguishable.
 *
 * The callback RETURNS the reconcile promise: the settings service awaits each
 * observer invocation before starting the next one, so returning it serializes
 * commits on the settings side as well — a commit can never be observed halfway
 * through the previous one's transition. A rejection is contained and logged: a
 * settings observer must never take the writer down.
 */
export function bindRuntimeToSettings(
  settingsScope: Pick<TelegramSettingsScopeLike, "watch">,
  reconcile: () => Promise<void>,
  logger?: { warn(m: string): void }
): void {
  settingsScope.watch(() => {
    return reconcile().catch((error: unknown) => {
      logger?.warn(`dsh-balbes-telegram: runtime transition failed: ${reasonOf(error)}`);
    });
  });
}
