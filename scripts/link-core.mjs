import { mkdirSync, readdirSync, symlinkSync, existsSync } from "node:fs";
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
  } catch { /* npm root недоступен — пробуем остальные */ }
  return list;
}

const src = candidates().find((c) => existsSync(c));
if (!src) {
  console.error("link-core: не найдено зеркало @deepseek-ai (нужен глобальный dsh или $DSH_HOME).");
  console.error("Установите: npm i -g @deepseek-ai/dsh  (CI делает это сам).");
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
mkdirSync(target, { recursive: true });
for (const name of readdirSync(src)) {
  const from = join(src, name);
  const to = join(target, name);
  if (!existsSync(to)) symlinkSync(from, to);
}
console.log(`link-core: @deepseek-ai связан из ${src}`);
