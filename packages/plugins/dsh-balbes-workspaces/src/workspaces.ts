import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, rename, stat, writeFile, chmod, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Structural slice of the workspace contract (see dsh-balbes-contracts). */
export interface WorkspaceProject {
  name: string;
  path: string;
  createdAt?: string;
}
export interface WorkspaceHome {
  path: string;
}

export type WorkspaceErrorCode = "invalid-name" | "name-exists" | "not-found" | "registry-invalid" | "invalid-path";
export class WorkspaceError extends Error {
  constructor(public code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}
export function workspaceError(code: WorkspaceErrorCode, message: string): WorkspaceError {
  return new WorkspaceError(code, message);
}

export const PROJECT_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

/** Registry index shape: metadata only, never the source of truth. */
export interface RegistryData {
  version: 1;
  projects: Record<string, { createdAt: string }>;
}

export function validateProjectName(name: string): boolean {
  return typeof name === "string" && name.length > 0 && name.length <= 64 && PROJECT_NAME_RE.test(name) && !name.includes("..");
}

export function homeDir(dshHome: string): string {
  return join(dshHome, "agent");
}
export function projectsRoot(dshHome: string): string {
  return join(dshHome, "projects");
}
export function registryFile(dshHome: string): string {
  return join(dshHome, "projects.json");
}

/**
 * Starter files provisioned into a fresh agent home. Provisioning is strictly
 * additive: files that already exist (owner edits included) are never touched.
 * Contents are English starter templates for the owner to extend; the home
 * files are global context, active for every session.
 */
const AGENTS_STARTER = [
  "# Agent home rules",
  "",
  "Auto-created by the server on first start. This file belongs to the owner:",
  "edit it by hand; the server never overwrites it. AGENTS.md, self.md, and the",
  "skills/ files are the agent home's global context, active for every session",
  "and every project.",
  "",
  "Baseline rules:",
  "- Never read or expose secrets: `$DSH_HOME/.credentials.yaml`, `$DSH_HOME/admin-auth.json`,",
  "  and any key files.",
  "- Irreversible operations (deleting workspaces, overwriting files) only after",
  "  explicit owner confirmation.",
  "- Do not leave `$DSH_HOME` without the owner's permission.",
  "",
  "Starter templates (uncomment and extend):",
  "<!-- - Verify outcomes, not just code: facts, paths, side effects. -->",
  "<!-- - Keep replies concise and grounded. -->",
  ""
].join("\n");

const SELF_STARTER = [
  "# About",
  "",
  "Draft: auto-created by the server on first start; the owner fills it in and",
  "the server never overwrites it. The agent home injects this file into the",
  "system prompt for every session, so write it as the agent's short",
  "self-description.",
  "",
  "Draft fields:",
  '- Name: (e.g. "balbes")',
  "- Role: the owner's personal agent on the dsh-balbes server",
  "- Language: Russian",
  "- Style: concise and factual; verify claims, do not invent",
  "- Boundaries: see AGENTS.md - secrets, irreversible operations, leaving $DSH_HOME",
  ""
].join("\n");

/**
 * Starter text written by older releases to `skills/README.md`. Captured here
 * byte-for-byte so the one-time migration can recognise an untouched starter
 * file; anything else is an owner edit and must never be touched.
 */
const OLD_SKILLS_README_STARTER = [
  "# skills/",
  "",
  "Directory for agent skills (later stages). Format and wiring to be defined.",
  ""
].join("\n");

/**
 * Starter README for a skills directory (home and project alike). Written
 * WITHOUT a `.md` extension so the skill provider never tries to parse it as a
 * skill (no frontmatter -> warning on every scan).
 */
const SKILLS_README_STARTER = [
  "# skills/",
  "",
  "Agent skills live here. A skill is a directory `<name>/SKILL.md` or a flat",
  "file `<name>.md`; both begin with YAML frontmatter carrying `name` and",
  "`description`:",
  "",
  "---",
  "name: my-skill",
  "description: What the skill does and when to use it.",
  "---",
  "",
  "Home skills in `$DSH_HOME/agent/skills/` are global: every project sees them.",
  "Project skills in `<project>/.dsh/skills/` are local to that project; a skill",
  "with the same name shadows the home one.",
  ""
].join("\n");

/** Write a file only when it does not exist yet; owner content is never touched. */
async function provisionFile(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
}

/**
 * One-time migration: drop `skills/README.md` only when it is still exactly the
 * old starter. Missing file is fine; an owner-edited file is left in place.
 */
async function removeLegacySkillsReadme(skillsDir: string): Promise<void> {
  const legacy = join(skillsDir, "README.md");
  try {
    if ((await readFile(legacy, "utf8")) !== OLD_SKILLS_README_STARTER) return;
    await unlink(legacy);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing legacy file is fine; a README.md that is a directory is an
    // owner choice too — leave it in place instead of failing the whole home.
    if (code !== "ENOENT" && code !== "EISDIR") throw error;
  }
}

/** The home always exists: mkdir -p, then provision missing starter files, idempotent. */
export async function ensureHome(dshHome: string): Promise<string> {
  const dir = homeDir(dshHome);
  await mkdir(dir, { recursive: true });
  const skillsDir = join(dir, "skills");
  await mkdir(skillsDir, { recursive: true });
  await provisionFile(join(dir, "AGENTS.md"), AGENTS_STARTER);
  await provisionFile(join(dir, "self.md"), SELF_STARTER);
  await provisionFile(join(skillsDir, "README"), SKILLS_README_STARTER);
  await removeLegacySkillsReadme(skillsDir);
  return dir;
}

function emptyRegistry(): RegistryData {
  return { version: 1, projects: {} };
}

export async function readRegistry(dshHome: string): Promise<RegistryData> {
  const file = registryFile(dshHome);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw workspaceError("registry-invalid", `registry ${file} unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw workspaceError("registry-invalid", `registry ${file} is not valid JSON`);
  }
  const record = parsed as { version?: unknown; projects?: unknown };
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    record.version !== 1 ||
    typeof record.projects !== "object" ||
    record.projects === null
  ) {
    throw workspaceError("registry-invalid", `registry ${file} misses required fields`);
  }
  const projects: Record<string, { createdAt: string }> = {};
  for (const [name, meta] of Object.entries(record.projects as Record<string, unknown>)) {
    const m = meta as { createdAt?: unknown };
    if (typeof m?.createdAt === "string") projects[name] = { createdAt: m.createdAt };
  }
  return { version: 1, projects };
}

export async function writeRegistry(dshHome: string, data: RegistryData): Promise<void> {
  const file = registryFile(dshHome);
  // Unique tmp per write: registry writes are un-mutexed async
  // writeFile -> chmod -> rename chains, and concurrent create/delete/list
  // prunes must never share one tmp path (a pid-only suffix lets one chain's
  // rename steal the other's tmp mid-flight -> spurious ENOENT).
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (error) {
    // best-effort cleanup of the tmp on failure (rename failure, aborted write, ...)
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Keep only rows whose project directory still exists. */
async function reconcileRegistry(dshHome: string, data: RegistryData): Promise<RegistryData> {
  const root = projectsRoot(dshHome);
  const next: RegistryData = { version: 1, projects: {} };
  for (const [name, meta] of Object.entries(data.projects)) {
    try {
      const s = await stat(join(root, name));
      if (s.isDirectory()) next.projects[name] = meta;
    } catch {
      // row orphaned: drop it
    }
  }
  return next;
}

function isHidden(entry: string): boolean {
  return entry.startsWith(".");
}

/** Scan the projects root. Returns [] when the root does not exist yet. */
async function scanProjectDirs(dshHome: string): Promise<string[]> {
  const root = projectsRoot(dshHome);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = entries
    .filter((e) => e.isDirectory() && !isHidden(e.name))
    .map((e) => e.name)
    .sort();
  return names;
}

function withOptionalCreatedAt(name: string, path: string, createdAt?: string): WorkspaceProject {
  return createdAt === undefined ? { name, path } : { name, path, createdAt };
}

export async function listWorkspaces(dshHome: string): Promise<{ home: WorkspaceHome; projects: WorkspaceProject[] }> {
  const home = await ensureHome(dshHome);
  const reg = await readRegistry(dshHome);
  const names = await scanProjectDirs(dshHome);
  // Reconcile: rows whose directory vanished are cleaned from the FILE too
  // (spec: вычищаются при list), not just hidden from this response.
  const present = new Set(names);
  let changed = false;
  const cleaned: RegistryData = { version: 1, projects: {} };
  for (const [name, meta] of Object.entries(reg.projects)) {
    if (present.has(name)) cleaned.projects[name] = meta;
    else changed = true;
  }
  if (changed) await writeRegistry(dshHome, cleaned);
  const projects = names.map((name) => {
    const row = cleaned.projects[name];
    return withOptionalCreatedAt(name, join(projectsRoot(dshHome), name), row?.createdAt);
  });
  return { home: { path: home }, projects };
}

export async function createProject(dshHome: string, name: string): Promise<WorkspaceProject> {
  if (!validateProjectName(name)) {
    throw workspaceError("invalid-name", `invalid project name: ${name}`);
  }
  const root = projectsRoot(dshHome);
  const target = resolve(root, name);
  // containment: the resolved path must live directly under the projects root
  if (target !== join(root, name) || !target.startsWith(root + sep)) {
    throw workspaceError("invalid-name", `project name escapes the projects root: ${name}`);
  }
  const reg = await readRegistry(dshHome);
  const reconciled = await reconcileRegistry(dshHome, reg);
  // The projects root may not exist yet on a fresh home: ensure it before the leaf mkdir.
  await mkdir(root, { recursive: true });
  try {
    await mkdir(target, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw workspaceError("name-exists", `project already exists: ${name}`);
    }
    throw error;
  }
  const skillsDir = join(target, ".dsh", "skills");
  await mkdir(skillsDir, { recursive: true });
  await provisionFile(join(skillsDir, "README"), SKILLS_README_STARTER);
  const createdAt = new Date().toISOString();
  reconciled.projects[name] = { createdAt };
  await writeRegistry(dshHome, reconciled);
  return withOptionalCreatedAt(name, target, createdAt);
}

export async function deleteProject(dshHome: string, name: string): Promise<void> {
  if (typeof name !== "string" || name === "" || name === "." || name === ".." || name.includes("/") || name.includes(sep) || isHidden(name)) {
    throw workspaceError("invalid-name", `invalid project name: ${name}`);
  }
  const root = projectsRoot(dshHome);
  const target = resolve(root, name);
  if (target !== join(root, name) || !target.startsWith(root + sep)) {
    throw workspaceError("invalid-name", `project name escapes the projects root: ${name}`);
  }
  try {
    const s = await stat(target);
    if (!s.isDirectory()) throw workspaceError("not-found", `project not found: ${name}`);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    // Only a missing directory means not-found; real stat errors (EACCES, ...)
    // must surface as 500, mirroring readRegistry's ENOENT-only mapping.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw workspaceError("not-found", `project not found: ${name}`);
  }
  await rm(target, { recursive: true, force: true });
  const reg = await readRegistry(dshHome);
  if (reg.projects[name] !== undefined) {
    delete reg.projects[name];
    await writeRegistry(dshHome, reg);
  }
}
