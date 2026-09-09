import { readdir, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homeDir, projectsRoot, validateProjectName, workspaceError } from "./workspaces.js";

export type WorkspaceScope = "home" | "project";
export interface TreeEntry {
  name: string;
  kind: "dir" | "file" | "link";
}

const INVALID = /[\\\0]/;

/** Parent dir of a watch/rel path; "" when there is none. Accepts / and \ (a trailing
 *  slash marks an empty final segment, so "src/" maps to its parent "src"). */
export function relDirOf(rel: string): string {
  const norm = rel.replace(/[\\/]+/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? "" : norm.slice(0, idx);
}

/** "" (root) or segments without "", ".", "..", "/", "\", NUL. */
export function isValidRelPath(relPath: string): boolean {
  if (typeof relPath !== "string" || relPath.startsWith("/") || INVALID.test(relPath)) return false;
  if (relPath === "") return true;
  return relPath.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** Realpath containment: true when the resolved target sits at or under the resolved root. */
export async function isRealWithin(root: string, target: string): Promise<boolean> {
  const realRoot = await realpath(root);
  const realTarget = await realpath(target);
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep);
}

/** Resolve + validate the workspace root for the given scope. */
export async function workspaceBase(
  dshHome: string,
  scope: WorkspaceScope,
  name: string | undefined
): Promise<string> {
  if (scope === "home") return homeDir(dshHome);
  if (scope === "project") {
    if (name === undefined || !validateProjectName(name)) {
      throw workspaceError("invalid-name", `invalid project name: ${name ?? ""}`);
    }
    const base = resolve(projectsRoot(dshHome), name);
    // containment: direct child of the projects root
    if (base !== join(projectsRoot(dshHome), name) || !base.startsWith(projectsRoot(dshHome) + sep)) {
      throw workspaceError("invalid-name", `project name escapes the projects root: ${name}`);
    }
    return base;
  }
  throw workspaceError("invalid-path", `unknown scope: ${String(scope)}`);
}

function classify(dirent: Dirent): TreeEntry["kind"] {
  if (dirent.isDirectory()) return "dir";
  if (dirent.isSymbolicLink()) return "link";
  return "file";
}

/** Children of one directory inside a workspace; never escapes the root. */
export async function readWorkspaceDir(
  dshHome: string,
  scope: WorkspaceScope,
  name: string | undefined,
  relPath: string
): Promise<TreeEntry[]> {
  if (!isValidRelPath(relPath)) throw workspaceError("invalid-path", `invalid relative path: ${relPath}`);
  const base = await workspaceBase(dshHome, scope, name);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw workspaceError("invalid-path", `path escapes the workspace root: ${relPath}`);
  }
  // realpath containment: refuse to read dirs reached through an escaping symlink
  let realOk = false;
  try {
    realOk = await isRealWithin(base, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw workspaceError("not-found", `directory not found: ${relPath}`);
    }
    throw error;
  }
  if (!realOk) throw workspaceError("not-found", `directory is outside the workspace: ${relPath}`);
  // ENOTDIR: relPath resolved to a regular file (a dir was replaced by a
  // same-named file, or a direct path-to-file request) — treat like ENOENT
  let dirents: Dirent[];
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw workspaceError("not-found", `directory not found: ${relPath}`);
    }
    throw error;
  }
  const entries: TreeEntry[] = dirents.map((d) => ({ name: d.name, kind: classify(d) }));
  const byKind = (a: TreeEntry, b: TreeEntry): number => {
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (a.kind !== "dir" && b.kind === "dir") return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };
  return entries.sort(byKind);
}
