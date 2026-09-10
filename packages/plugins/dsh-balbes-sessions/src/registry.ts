import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Одна ссылка на воркспейс: дом агента или проект. */
export type WorkspaceRef = { scope: "home" } | { scope: "project"; name: string };

/** Одна запись реестра: сессия и канал, который её создал. */
export interface WorkspaceSessionEntry {
  sessionId: string;
  channel: string;
}

/** Документ реестра целиком. */
export interface RegistryData {
  version: 1;
  workspaces: Record<string, WorkspaceSessionEntry[]>;
}

/** Каналы — короткие слаг-имена: "telegram" сейчас, "admin"/"web" позже. */
const CHANNEL_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Ключ воркспейса — тот же формат, что использует telegram (`home`/`project:<имя>`). */
export function refKey(ref: WorkspaceRef): string {
  return ref.scope === "home" ? "home" : `project:${ref.name}`;
}

/** `$DSH_HOME/workspace-sessions.json`. */
export function registryFile(dshHome: string): string {
  return join(dshHome, "workspace-sessions.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Проверка формы и нормализация: документ читается только по известным полям,
 * неизвестные отбрасываются, повторные sessionId внутри воркспейса — первое
 * вхождение. Повреждённый или чужой файл — ошибка с именем файла: молчаливый
 * сброс потерял бы принадлежность сессий.
 */
export function assertRegistryShape(value: unknown, file: string): RegistryData {
  const invalid = (why: string): Error => new Error(`workspace sessions registry ${file} ${why}`);
  if (!isPlainObject(value)) throw invalid("is not a JSON object");
  if (value.version !== 1) throw invalid("has an unsupported version");
  if (!isPlainObject(value.workspaces)) throw invalid("misses the workspaces map");
  const workspaces: Record<string, WorkspaceSessionEntry[]> = {};
  for (const [key, rawEntries] of Object.entries(value.workspaces)) {
    if (key === "") throw invalid("has an empty workspace key");
    if (!Array.isArray(rawEntries)) throw invalid(`has a non-array entry list for key ${key}`);
    const entries: WorkspaceSessionEntry[] = [];
    const seen = new Set<string>();
    for (const raw of rawEntries) {
      if (!isPlainObject(raw)) throw invalid(`has a non-object entry for key ${key}`);
      const sessionId = raw.sessionId;
      const channel = raw.channel;
      if (typeof sessionId !== "string" || sessionId === "") throw invalid(`has an invalid session id for key ${key}`);
      if (typeof channel !== "string" || !CHANNEL_RE.test(channel)) {
        throw invalid(`has an invalid channel for key ${key}`);
      }
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      entries.push({ sessionId, channel });
    }
    workspaces[key] = entries;
  }
  return { version: 1, workspaces };
}

/** Одна запись при записи: та же проверка, что и при чтении. */
function assertEntry(sessionId: string, channel: string, file: string): WorkspaceSessionEntry {
  const data = assertRegistryShape(
    { version: 1, workspaces: { entry: [{ sessionId, channel }] } },
    file
  );
  const entry = data.workspaces.entry?.[0];
  if (entry === undefined) throw new Error(`workspace sessions registry ${file} rejected an entry`);
  return entry;
}

/** Чтение файла: отсутствие — пустой документ, повреждение — ошибка. */
export async function readRegistryFile(file: string): Promise<RegistryData> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    // ENOENT — единственный код, означающий «ещё ничего не писали»; EACCES и
    // EISDIR обязаны всплыть, а не обнулить реестр.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: {} };
    throw new Error(
      `workspace sessions registry ${file} unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`workspace sessions registry ${file} is not valid JSON`);
  }
  return assertRegistryShape(parsed, file);
}

/**
 * Атомарное хранилище реестра: один экземпляр владеет одним файлом, запись
 * сериализуется внутри экземпляра, каждый записанный документ проходит
 * проверку формы ДО записи. Неудачная загрузка не кэшируется: следующий вызов
 * перечитает файл.
 */
export class WorkspaceSessionsRegistry {
  private state: RegistryData | null = null;
  private loading: Promise<RegistryData> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  static defaultFile(dshHome: string): string {
    return registryFile(dshHome);
  }

  /** Записи воркспейса в порядке добавления (копии, не ссылки на состояние). */
  async list(ref: WorkspaceRef): Promise<WorkspaceSessionEntry[]> {
    const state = await this.load();
    return (state.workspaces[refKey(ref)] ?? []).map((entry) => ({ ...entry }));
  }

  /** Добавить сессию в воркспейс; повторный вызов с тем же id ничего не меняет. */
  async register(ref: WorkspaceRef, sessionId: string, channel: string): Promise<void> {
    const entry = assertEntry(sessionId, channel, this.file);
    const run = this.queue.then(() => this.registerLocked(ref, entry));
    // последовательность не должна ломаться отвергнутой записью
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async registerLocked(ref: WorkspaceRef, entry: WorkspaceSessionEntry): Promise<void> {
    const state = await this.load();
    const key = refKey(ref);
    const entries = state.workspaces[key] ?? [];
    if (entries.some((existing) => existing.sessionId === entry.sessionId)) return;
    const next: RegistryData = {
      version: 1,
      workspaces: { ...state.workspaces, [key]: [...entries, entry] }
    };
    await this.save(next);
    this.state = next;
  }

  private async load(): Promise<RegistryData> {
    if (this.state !== null) return this.state;
    // Одна идущая загрузка на экземпляр. Без этой мемоизации два параллельных
    // вызова читают файл независимо, и снимок, снятый раньше, но разрешившийся
    // позже, затирает более новый: `register` считает `next` от `this.state` и
    // пишет документ целиком, поэтому затёртое состояние уносит уже
    // зарегистрированную сессию с диска — нарушение append-only.
    this.loading ??= readRegistryFile(this.file);
    try {
      this.state = await this.loading;
      return this.state;
    } finally {
      // Неудачная загрузка не кэшируется: следующий вызов перечитает файл.
      this.loading = null;
    }
  }

  private async save(next: RegistryData): Promise<void> {
    const data = assertRegistryShape(next, this.file);
    // Уникальный tmp на запись: немьютексеченные цепочки writeFile -> chmod ->
    // rename не должны делить один tmp-путь.
    const tmp = `${this.file}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
}
