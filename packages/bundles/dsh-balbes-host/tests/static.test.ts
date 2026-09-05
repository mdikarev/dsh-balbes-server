import { describe, expect, it, afterEach } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply as applyStatic } from "../src/static.js";
import type { StaticResult } from "../src/types.js";

type Serve = (pathname: string) => Promise<StaticResult | null>;

function bootUi(distDir: string): { serve: Serve; warns: string[] } {
  const warns: string[] = [];
  let serve: Serve | null = null;
  const http = {
    post: () => undefined,
    registerStatic: (fn: Serve) => {
      serve = fn;
    }
  };
  const ctx = {
    get: (key: string) => (key === "balbesHttp" ? http : undefined),
    logger: { warn: (m: string) => void warns.push(m) }
  };
  applyStatic(ctx, { uiDistDir: distDir });
  return { serve: serve as Serve, warns };
}

describe("static", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeUi(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "balbes-dist-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return dir;
  }

  it("serves index.html as text/html on /", async () => {
    const dir = await makeUi({ "index.html": "<h1>admin</h1>" });
    const { serve } = bootUi(dir);
    const r = await serve("/");
    expect(r?.status).toBe(200);
    expect(r?.type).toBe("text/html; charset=utf-8");
    expect((r?.body as Buffer).toString()).toContain("admin");
  });

  it("unknown extensionless paths fall back to index.html as text/html", async () => {
    const dir = await makeUi({ "index.html": "<h1>spa</h1>" });
    const { serve } = bootUi(dir);
    const r = await serve("/settings");
    expect(r?.status).toBe(200);
    expect(r?.type).toBe("text/html; charset=utf-8");
    expect((r?.body as Buffer).toString()).toContain("spa");
  });

  it("real files keep their own MIME by extension", async () => {
    const dir = await makeUi({ "index.html": "<h1>spa</h1>", "app.js": "console.log(1)" });
    const { serve } = bootUi(dir);
    const r = await serve("/app.js");
    expect(r?.status).toBe(200);
    expect(r?.type).toBe("text/javascript; charset=utf-8");
    expect((r?.body as Buffer).toString()).toContain("console.log");
  });

  it("unknown paths return null when no index.html exists", async () => {
    const dir = await makeUi({});
    const { serve } = bootUi(dir);
    expect(await serve("/anything")).toBeNull();
  });

  it("missing asset paths also fall back to index.html as text/html", async () => {
    const dir = await makeUi({ "index.html": "<h1>spa</h1>" });
    const { serve } = bootUi(dir);
    const r = await serve("/missing.js");
    expect(r?.status).toBe(200);
    expect(r?.type).toBe("text/html; charset=utf-8");
    expect((r?.body as Buffer).toString()).toContain("spa");
  });

  it("unreadable (EACCES) assets yield a miss, not a 200 index.html fallback", async () => {
    const dir = await makeUi({ "index.html": "<h1>spa</h1>", "blocked.js": "console.log(1)" });
    await chmod(join(dir, "blocked.js"), 0o000);
    const { serve } = bootUi(dir);
    // A permission error must surface as a miss (the dispatcher answers 404)
    // instead of being masked by the SPA fallback.
    expect(await serve("/blocked.js")).toBeNull();
    // A genuinely missing asset still gets the SPA fallback.
    const r = await serve("/missing.js");
    expect(r?.status).toBe(200);
    expect((r?.body as Buffer).toString()).toContain("spa");
  });
});
