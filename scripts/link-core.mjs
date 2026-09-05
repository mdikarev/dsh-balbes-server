import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "node_modules", "@deepseek-ai");

function candidates() {
  const list = [];
  if (process.env.DSH_HOME) list.push(join(process.env.DSH_HOME, "profiles", "node_modules", "@deepseek-ai"));
  if (process.env.HOME) list.push(join(process.env.HOME, ".dsh", "profiles", "node_modules", "@deepseek-ai"));
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    list.push(join(g, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
  } catch { /* npm root is unavailable, try the remaining candidates */ }
  return list;
}

const src = candidates().find((c) => existsSync(c));
if (!src) {
  console.error("link-core: no @deepseek-ai mirror found (a global dsh install or $DSH_HOME is required).");
  console.error("Install it with: npm i -g @deepseek-ai/dsh  (CI installs it itself).");
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
mkdirSync(target, { recursive: true });

// link(name) — make target/name point at mirror/name.
function link(name) {
  const from = join(src, name);
  const to = join(target, name);
  let stat = null;
  try {
    stat = lstatSync(to);
  } catch { /* destination does not exist yet */ }
  if (stat === null) {
    symlinkSync(from, to);
    return;
  }
  // A real file or directory that we did not create is left alone; only a
  // symlink is ours to manage. A stale or broken symlink (pointing anywhere
  // other than the current mirror entry) is replaced.
  if (!stat.isSymbolicLink()) return;
  if (readlinkSync(to) !== from) {
    unlinkSync(to);
    symlinkSync(from, to);
  }
}

for (const name of readdirSync(src)) {
  link(name);
}
console.log(`link-core: linked @deepseek-ai from ${src}`);
