import z from "@deepseek-ai/schemastery";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { BalbesHttp, StaticResult } from "./types.js";

export const name = "balbes-static";
export const inject = ["balbesHttp"];
export const Config = z.object({
  uiDistDir: z.string(),
  dshHome: z.string()
});

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

export function apply(ctx: {
  config: { uiDistDir?: string; dshHome?: string };
  get(key: string): BalbesHttp;
  logger: { warn(m: string): void };
}): void {
  const dshHome = ctx.config.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? ".", ".dsh");
  const distRoot = resolve(ctx.config.uiDistDir ?? join(dshHome, "balbes", "ui"));
  const http = ctx.get("balbesHttp");

  http.registerStatic(async (pathname) => {
    let target: string;
    try {
      target = resolve(join(distRoot, normalize(pathname).replace(/^[/\\]+/, "")));
    } catch {
      return { status: 403, body: "forbidden", type: "text/plain" };
    }
    if (target !== distRoot && !target.startsWith(distRoot + sep)) {
      return { status: 403, body: "forbidden", type: "text/plain" };
    }
    let file = pathname === "/" ? join(distRoot, "index.html") : target;
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      if (pathname === "/") return null;
      // SPA fallback: serve index.html (with its text/html MIME) for unknown paths.
      file = join(distRoot, "index.html");
      try {
        data = await readFile(file);
      } catch {
        return null;
      }
    }
    const type = MIME[extname(file)] ?? "application/octet-stream";
    return { status: 200, body: data, type };
  });
  ctx.logger.warn(`balbes-static: serving ${distRoot}`);
}
