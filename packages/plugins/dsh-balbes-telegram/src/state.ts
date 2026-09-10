import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Non-sensitive Telegram channel state, persisted at
 * `$DSH_HOME/telegram-state.json`.
 *
 * The file holds exactly three things: the last processed `update_id`, the
 * active workspace reference ("home" | "project:<name>", see
 * `workspaceRefKey`) and the workspace-key -> dsh sessionId map. It is NOT a
 * credential store: the bot token lives in the credentials service
 * (`$DSH_HOME/.credentials.yaml`) and has no field here by construction, so no
 * code path can persist it through this store.
 */
export interface TelegramStateData {
  version: 1;
  /** "home" | "project:<name>" — the workspace the chat is currently bound to. */
  activeWorkspace?: string;
  /** Workspace key -> dsh sessionId, for resuming sessions after a restart. */
  sessions: Record<string, string>;
  /** Last processed Telegram update_id (long polling offset). */
  offset?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict shape check on load, in the `parseAdminAuth` style: a damaged or
 * foreign file is an error naming the file, never a silent reset — silently
 * rewriting would drop the session map (and with it every conversation) on a
 * single bad parse, and would hide real damage until it is unrecoverable.
 */
function parseState(raw: string, file: string): TelegramStateData {
  const invalid = (detail: string): Error => new Error(`telegram state file ${file} ${detail}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("is not valid JSON");
  }
  if (!isPlainObject(parsed)) throw invalid("misses required fields");
  const record = parsed as { version?: unknown; activeWorkspace?: unknown; sessions?: unknown; offset?: unknown };
  if (record.version !== 1 || !isPlainObject(record.sessions)) throw invalid("misses required fields");
  const sessions: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.sessions)) {
    if (typeof value !== "string") throw invalid(`has a non-string session id for key ${key}`);
    sessions[key] = value;
  }
  const data: TelegramStateData = { version: 1, sessions };
  if (record.activeWorkspace !== undefined) {
    if (typeof record.activeWorkspace !== "string") throw invalid("has an invalid activeWorkspace");
    data.activeWorkspace = record.activeWorkspace;
  }
  if (record.offset !== undefined) {
    // A Telegram update_id is always positive, so 0/negatives/fractions are
    // damage, not a legitimate "no updates yet" marker (that is the absent field).
    if (typeof record.offset !== "number" || !Number.isInteger(record.offset) || record.offset <= 0) {
      throw invalid("has an invalid offset");
    }
    data.offset = record.offset;
  }
  return data;
}

/**
 * Atomic JSON store for {@link TelegramStateData}. One instance owns one file;
 * callers serialize their own writes (this store keeps no lock), and each
 * write is durable-or-absent through tmp + rename.
 */
export class TelegramState {
  constructor(private readonly file: string) {}

  /** `$DSH_HOME/telegram-state.json` for the given data home. */
  static defaultFile(dshHome: string): string {
    return join(dshHome, "telegram-state.json");
  }

  /** Read the state; a missing file is the empty default, damage is an error. */
  async load(): Promise<TelegramStateData> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      // ENOENT is the only code that means "nothing written yet"; EACCES,
      // EISDIR and the like must surface instead of resetting the state.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: {} };
      throw new Error(`telegram state file ${this.file} unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseState(raw, this.file);
  }

  /** Write the whole state atomically, owner-only (mode 600). */
  async save(next: TelegramStateData): Promise<void> {
    // Unique tmp per write (same reasoning as workspaces' writeRegistry):
    // un-mutexed writeFile -> chmod -> rename chains must never share one tmp
    // path, or one chain's rename steals the other's tmp mid-flight.
    const tmp = `${this.file}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    } catch (error) {
      // best-effort cleanup of the tmp on failure (rename failure, aborted write, ...)
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }
}
