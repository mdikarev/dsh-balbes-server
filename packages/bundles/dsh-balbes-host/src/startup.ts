/** Stable plugin name. */
export const name = "balbes-startup";
/** cmdlineArgs is provided by the launcher (dsh); this plugin starts after it. */
export const inject = ["cmdlineArgs"];

const USAGE = `dsh --profile balbes — balbes server: HTTP admin (auth + test prompt).
No task arguments are accepted.

Examples:
  dsh --profile balbes           start the admin server (daemon)
`;

/**
 * Profile app layer: parses the CLI without external dependencies (commander is
 * not resolvable from the package copied into the profile — see preflight R-2).
 * Without arguments it does nothing: the server keeps the process alive itself (spec 9.1).
 */
export function apply(ctx: {
  get(key: string): unknown;
  logger: { warn(m: string): void };
}): void {
  const cmdline = ctx.get("cmdlineArgs") as { args: string[] } | undefined;
  const exit = ctx.get("appExit") as ((code: number) => void) | undefined;
  const args = cmdline?.args ?? [];
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(USAGE);
    exit?.(0);
    return;
  }
  if (args.length > 0) {
    process.stderr.write(`error: balbes takes no task arguments (got: ${args.join(" ")})\n\n${USAGE}`);
    exit?.(1);
  }
}
