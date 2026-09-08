import type { WorkspaceScope } from "dsh-balbes-contracts";

export interface WorkspaceRef {
  scope: WorkspaceScope;
  name?: string;
}

export function refKey(ref: WorkspaceRef): string {
  return ref.scope === "home" ? "home" : `project:${ref.name ?? ""}`;
}

export function isSameRef(a: WorkspaceRef | null, b: WorkspaceRef | null): boolean {
  if (a === null || b === null) return a === b;
  return refKey(a) === refKey(b);
}
