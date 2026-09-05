// Admin credentials lifecycle for the balbes server.
// Usage: node scripts/admin-creds.mjs ensure|reset --core <core.js> [--home <dshHome>]
// ensure: создаёт $DSH_HOME/admin-auth.json один раз (0600); если файл уже есть —
//         ничего не меняет. Печатает JSON {login, password?, created}.
// reset:  новый пароль (хэш), логин/jwtSecret не трогаются. Печатает {login, password}.
import { existsSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

function usage() {
  console.error("usage: admin-creds.mjs ensure|reset --core <core.js> [--home <dir>]");
  process.exit(2);
}
const args = process.argv.slice(2);
const cmd = args[0];
const opts = { core: "", home: process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh") };
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--core") opts.core = args[++i] ?? "";
  else if (args[i] === "--home") opts.home = args[++i] ?? "";
}
if ((cmd !== "ensure" && cmd !== "reset") || !opts.core) usage();

const core = await import(pathToFileURL(opts.core).href);
const file = join(opts.home, "admin-auth.json");
const tmp = `${file}.tmp.${process.pid}`;
const writeJson = async (obj) => {
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
};

if (cmd === "ensure") {
  if (existsSync(file)) {
    const auth = JSON.parse(await readFile(file, "utf8"));
    console.log(JSON.stringify({ login: auth.login, created: false }));
  } else {
    const creds = await core.createAdminAuth();
    await writeJson({
      login: creds.login,
      passwordHash: creds.passwordHash,
      jwtSecret: creds.jwtSecret,
      createdAt: creds.createdAt
    });
    console.log(JSON.stringify({ login: creds.login, password: creds.plaintextPassword, created: true }));
  }
} else {
  if (!existsSync(file)) {
    console.error("admin auth file missing:", file);
    process.exit(1);
  }
  const auth = JSON.parse(await readFile(file, "utf8"));
  const password = randomBytes(18).toString("base64url");
  auth.passwordHash = await core.hashPassword(password);
  auth.createdAt = new Date().toISOString();
  await writeJson(auth);
  console.log(JSON.stringify({ login: auth.login, password }));
}
