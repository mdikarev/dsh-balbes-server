/**
 * In-process probe plugin for the REAL integration suite.
 *
 * The loader mounts this module as one include entry of the booted base tree
 * (its `name` in the boot patch list is this file's absolute path), so its
 * plugin context can resolve the dsh core services exactly like the
 * headless-runner entry does. `apply` captures that context on a global so
 * the vitest process (which boots the tree) can drive `runPrompt` on it and
 * then observe `ctx.get("agents").list()` — a spawned CLI child could never
 * expose the live agent registry.
 *
 * A global is used (not module exports) because the loader imports this file
 * by absolute URL while vitest imports it by relative path; the two module
 * registries must not disagree on which instance owns the captured context.
 */
export const name = "balbes-runprobe";
export const inject = ["agentDefaultModel", "agents", "sessions"];

const GLOBAL_KEY = "__balbesRunProbeCtx__";

export function apply(ctx) {
  globalThis[GLOBAL_KEY] = ctx;
}
