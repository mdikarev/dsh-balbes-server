import type { WorkspaceFileResult } from "./file.js";
import { readWorkspaceFile } from "./file.js";
import type { TreeEntry, WorkspaceScope } from "./tree.js";
import { readWorkspaceDir, workspaceBase } from "./tree.js";
import type { WorkspaceHome, WorkspaceProject } from "./workspaces.js";
import { listWorkspaces } from "./workspaces.js";

/**
 * ctx service facade over the workspace domain functions for one resolved data
 * home. Provided as "balbesWorkspaces" so later stages (telegram chat, admin)
 * can list/read workspaces without an HTTP loopback.
 */
export interface BalbesWorkspacesService {
  list(): Promise<{ home: WorkspaceHome; projects: WorkspaceProject[] }>;
  root(scope: WorkspaceScope, name: string | undefined): Promise<string>;
  readDir(scope: WorkspaceScope, name: string | undefined, relPath: string): Promise<TreeEntry[]>;
  readFile(scope: WorkspaceScope, name: string | undefined, relPath: string): Promise<WorkspaceFileResult>;
}

export function createWorkspacesService(dshHome: string): BalbesWorkspacesService {
  return {
    list: () => listWorkspaces(dshHome),
    root: (scope, name) => workspaceBase(dshHome, scope, name),
    readDir: (scope, name, relPath) => readWorkspaceDir(dshHome, scope, name, relPath),
    readFile: (scope, name, relPath) => readWorkspaceFile(dshHome, scope, name, relPath)
  };
}
