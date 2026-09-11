import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
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
    // Nested layout (npm's classic global layout): the mirror lives under the
    // dsh package's own node_modules.
    list.push(join(g, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
    // Hoisted layout: npm placed the @deepseek-ai/* packages next to dsh
    // itself, directly under the global @deepseek-ai scope. The nested probe
    // above then misses, so this fallback keeps fresh VPS/CI installs working
    // before any profile boot has created the $DSH_HOME/profiles mirror.
    list.push(join(g, "@deepseek-ai"));
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

// link(name [, from]) — make target/name point at the mirror entry (or at an
// explicit source path, used below for the dsh CLI itself, which lives outside
// the mirror).
function link(name, from = join(src, name)) {
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

// Only directory entries are linked (files like .DS_Store are skipped). The
// mirror entries are themselves symlinks to the global dsh install, so the
// test must FOLLOW symlinks (statSync): with lstatSync every entry would
// read as a symlink, not a directory, and nothing would ever be linked on a
// fresh checkout. A package is linked as a whole directory and never
// recursed into.
for (const name of readdirSync(src)) {
  let isDir = false;
  try {
    isDir = statSync(join(src, name)).isDirectory();
  } catch { /* dangling entry; nothing to link */ }
  if (!isDir) continue;
  link(name);
}

// npm's nested global layout mirrors only what dsh itself depends on: that
// node_modules holds every dsh-* package but NOT dsh, because the CLI root is
// the directory one level ABOVE it. Linking the mirror entries alone therefore
// leaves the workspace without @deepseek-ai/dsh, and REAL suites that resolve
// @deepseek-ai/dsh/package.json to locate the install anchor (e.g.
// packages/bundles/dsh-balbes-host/tests/seams.test.ts) die with "Cannot find
// module" on a fresh runner, where no $DSH_HOME/profiles mirror exists yet and
// this nested candidate is the only one available.
if (!existsSync(join(target, "dsh"))) {
  const isCliRoot = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "@deepseek-ai/dsh";
    } catch { /* no readable package.json here: not the CLI root */ }
    return false;
  };
  // For the nested layout the CLI root is <X> of "<X>/node_modules/@deepseek-ai";
  // for any other candidate fall back to the global install path.
  let cli = null;
  const nestedRoot = resolve(src, "..", "..");
  if (isCliRoot(nestedRoot)) cli = nestedRoot;
  else {
    try {
      const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
      const globalDsh = join(g, "@deepseek-ai", "dsh");
      if (existsSync(globalDsh)) cli = globalDsh;
    } catch { /* npm root is unavailable; reported below */ }
  }
  if (cli === null) {
    // Not fatal on purpose: some CI jobs run without the REAL suites, which are
    // the only ones that need the CLI package itself.
    console.error("link-core: WARNING: could not find the dsh CLI package to link as @deepseek-ai/dsh.");
    console.error("link-core: REAL suites that resolve @deepseek-ai/dsh will fail.");
  } else {
    link("dsh", cli);
  }
}
console.log(`link-core: linked @deepseek-ai from ${src}`);
