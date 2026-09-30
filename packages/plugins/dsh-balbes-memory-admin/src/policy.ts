import type { MemoryAutonomyPolicy } from "dsh-balbes-contracts";

/**
 * The v1 autonomy policy, served to the owner instead of being hardcoded in the
 * UI. It describes behaviour that is enforced structurally: `save` (owner) and
 * `remember` write truth immediately, `propose` always stages, and there is no
 * auto-approval path at all.
 */
export const MEMORY_AUTONOMY_POLICY: MemoryAutonomyPolicy = {
  immediate: ["owner", "remember"],
  review: ["pipeline"],
  autoApprove: "none"
};
