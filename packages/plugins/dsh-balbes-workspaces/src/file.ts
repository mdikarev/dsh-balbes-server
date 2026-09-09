import { lstat, open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { workspaceError } from "./workspaces.js";
import { isRealWithin, isValidRelPath, workspaceBase, type WorkspaceScope } from "./tree.js";

export type WorkspaceFileKind = "text" | "binary" | "link";
export type WorkspaceFileResult =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "binary"; size: number }
  | { kind: "link" };

/** Default read ceiling for one text payload. */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
/** Any NUL byte inside the first 8 KiB marks the payload binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * Read one file inside a workspace under the same containment rules as
 * readWorkspaceDir: lexical containment, final-entry symlinks reported without
 * dereferencing, realpath containment for intermediate symlinks, and a bounded
 * read that never modifies the file. Reads are strictly read-only.
 */
export async function readWorkspaceFile(
  dshHome: string,
  scope: WorkspaceScope,
  name: string | undefined,
  relPath: string,
  opts?: { maxBytes?: number }
): Promise<WorkspaceFileResult> {
  if (!isValidRelPath(relPath)) throw workspaceError("invalid-path", `invalid relative path: ${relPath}`);
  const base = await workspaceBase(dshHome, scope, name);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw workspaceError("invalid-path", `path escapes the workspace root: ${relPath}`);
  }
  // A final-component symlink is reported as a link and never dereferenced,
  // so its content stays unreadable no matter where it points.
  let st;
  try {
    st = await lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw workspaceError("not-found", `file not found: ${relPath}`);
    }
    throw error;
  }
  if (st.isSymbolicLink()) return { kind: "link" };
  // realpath containment: an intermediate symlink must not pull the read outside
  let realOk = false;
  try {
    realOk = await isRealWithin(base, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw workspaceError("not-found", `file not found: ${relPath}`);
    }
    throw error;
  }
  if (!realOk) throw workspaceError("not-found", `file is outside the workspace: ${relPath}`);

  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const handle = await open(target, "r");
  try {
    const fileStat = await handle.stat();
    // maxBytes + 1: the extra byte is the truncation sentinel, so a full buffer
    // proves the file holds more than maxBytes without a second seek.
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const sniffed = buffer.subarray(0, Math.min(filled, BINARY_SNIFF_BYTES));
    if (sniffed.includes(0)) return { kind: "binary", size: fileStat.size };
    const truncated = fileStat.size > maxBytes;
    // Truncated payloads cut at the limit; the sentinel byte is never decoded.
    return {
      kind: "text",
      content: buffer.subarray(0, truncated ? maxBytes : filled).toString("utf8"),
      truncated
    };
  } finally {
    await handle.close();
  }
}
