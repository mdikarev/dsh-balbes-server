import type { MemoryScope } from "dsh-balbes-contracts";
import type { ClassifiedScope } from "./classify.js";
import type { MemoryContextScope } from "./types.js";

export function resolveWriteScope(
  scope: MemoryContextScope,
  classified: ClassifiedScope | undefined
): MemoryScope {
  if (scope.kind === "global") return { kind: "global" };
  return classified === "global" ? { kind: "global" } : { kind: "project", name: scope.name };
}
