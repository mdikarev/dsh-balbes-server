import { defineConfig } from "vitest/config";

// On Node.js versions whose `module.builtinModules` lists `sqlite` only as
// `node:sqlite` (Node >= 24), vite-node 2.1.9 does not recognise the builtin:
// it strips the `node:` prefix and then misses `sqlite`, so the runner tries to
// load a file named `sqlite`. Serve `node:sqlite` from a tiny virtual module
// that loads it through `createRequire` (a native CJS require that bypasses
// Vite's resolver). Tests and source keep importing the plain `node:sqlite`
// specifier, and this also works unchanged on Node 22.
const VIRTUAL_ID = "\0balbes-memory:node-sqlite";
const IDS = new Set(["node:sqlite", "sqlite"]);

const SQLITE_SHIM = [
  'import { createRequire } from "node:module";',
  "const require = createRequire(import.meta.url);",
  'const sqlite = require("node:sqlite");',
  "export const DatabaseSync = sqlite.DatabaseSync;",
  "export const StatementSync = sqlite.StatementSync;",
  "export const backup = sqlite.backup;",
  "export const constants = sqlite.constants;"
].join("\n");

export default defineConfig({
  plugins: [
    {
      name: "balbes-memory:node-sqlite-shim",
      resolveId(id) {
        if (IDS.has(id)) return VIRTUAL_ID;
        return undefined;
      },
      load(id) {
        if (id === VIRTUAL_ID) return SQLITE_SHIM;
        return undefined;
      }
    }
  ]
});
