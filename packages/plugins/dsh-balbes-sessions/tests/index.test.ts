import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name, inject } from "../src/index.js";
import { SessionQueryError } from "@deepseek-ai/dsh-session-query";
import { userMessage } from "./fixtures/events.js";

interface Seat {
  path: string;
  auth: string;
  handler(req: unknown, res: unknown, body: unknown): Promise<void> | void;
}

interface ResLike {
  writeHead(status: number): void;
  end(body?: string): void;
}

/** Ответ ручки в память: статус + распарсенный JSON (как в telegram-тестах). */
function makeRes(): { res: ResLike; read(): { status: number; json: unknown; raw: string } } {
  const box = { status: 0, raw: "" };
  return {
    res: {
      writeHead(status: number) {
        box.status = status;
      },
      end(body?: string) {
        box.raw = String(body ?? "");
      }
    },
    read: () => ({ status: box.status, raw: box.raw, json: JSON.parse(box.raw) as unknown })
  };
}

const PROJECTS = [{ name: "alpha", path: "/h/projects/alpha" }];

interface HarnessOptions {
  projects?: unknown;
  observations?: unknown[];
  queryThrows?: boolean;
  log?: unknown;
  title?: unknown;
  readThrows?: unknown;
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sessions-plugin-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function harness(options: HarnessOptions = {}): {
  seats: Seat[];
  provided: Map<string, unknown>;
  call(path: string, body: unknown): Promise<{ status: number; json: unknown; raw: string }>;
} {
  const seats: Seat[] = [];
  const provided = new Map<string, unknown>();
  const ctx = {
    get(key: string): unknown {
      if (key === "balbesHttp") {
        return {
          post(path: string, auth: string, handler: Seat["handler"]) {
            seats.push({ path, auth, handler });
          }
        };
      }
      if (key === "balbesWorkspaces") {
        return {
          list: async () => ({ home: { path: join(home, "agent") }, projects: options.projects ?? PROJECTS })
        };
      }
      if (key === "sessionQuery") {
        return {
          readTitleSnapshots: async (ids: readonly string[]) => {
            if (options.queryThrows === true) throw new Error("persistence listing failed");
            const all = (options.observations ?? []) as Array<{ sessionId: string; status: string; value?: unknown }>;
            return all.filter((o) => ids.includes(o.sessionId));
          },
          readSession: async (_id: string) => {
            if (options.readThrows !== undefined) throw options.readThrows;
            return options.log;
          },
          readTitle: async (_id: string) => options.title
        };
      }
      return undefined;
    },
    provide(key: string, value: unknown): void {
      provided.set(key, value);
    },
    logger: { warn(_m: string): void {} }
  };
  apply(ctx, { dshHome: home });
  return {
    seats,
    provided,
    async call(path, body) {
      const seat = seats.find((s) => s.path === path);
      if (seat === undefined) throw new Error(`no seat for ${path}`);
      const { res, read } = makeRes();
      await seat.handler({}, res, body);
      return read();
    }
  };
}

describe("balbes-sessions plugin", () => {
  it("exposes name/inject/apply contract", () => {
    expect(name).toBe("balbes-sessions");
    expect(inject).toEqual(["balbesHttp", "balbesWorkspaces", "sessionQuery"]);
  });

  it("registers one bearer route and provides balbesSessions", () => {
    const h = harness();
    expect(h.seats.map((s) => [s.path, s.auth])).toEqual([
      ["/api/sessions/list", "bearer"],
      ["/api/sessions/read", "bearer"]
    ]);
    const service = h.provided.get("balbesSessions") as { register?: unknown; list?: unknown };
    expect(typeof service.register).toBe("function");
    expect(typeof service.list).toBe("function");
  });

  it("rejects a malformed body with 400 bad-request", async () => {
    const h = harness();
    expect((await h.call("/api/sessions/list", [])).status).toBe(400);
    // `null` — не объект: без явной проверки разбор тела падал бы TypeError вместо 400.
    expect((await h.call("/api/sessions/list", null)).status).toBe(400);
    expect((await h.call("/api/sessions/list", { scope: "galaxy" })).status).toBe(400);
    expect((await h.call("/api/sessions/list", { scope: "project" })).status).toBe(400);
    const home = await h.call("/api/sessions/list", { scope: "home", name: "alpha" });
    expect(home.status).toBe(400);
    expect((home.json as { error?: { code?: string } }).error?.code).toBe("bad-request");
  });

  it("returns 404 for an unknown project", async () => {
    const h = harness();
    const res = await h.call("/api/sessions/list", { scope: "project", name: "nope" });
    expect(res.status).toBe(404);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe("not-found");
  });

  it("returns an empty list for a workspace with no registry entries", async () => {
    const h = harness();
    const res = await h.call("/api/sessions/list", { scope: "project", name: "alpha" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ sessions: [] });
  });

  it("maps titles and creation times, drops unknown ids and sorts newest first", async () => {
    const h = harness({
      observations: [
        {
          sessionId: "s-old",
          status: "fulfilled",
          value: { session: { createdAt: 1_700_000_000_000 }, title: { title: "старая задача" } }
        },
        {
          sessionId: "s-new",
          status: "fulfilled",
          value: { session: { createdAt: 1_700_000_100_000 } }
        },
        { sessionId: "s-gone", status: "rejected", reason: new Error("no such session") }
      ]
    });
    const service = h.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await service.register({ scope: "project", name: "alpha" }, "s-old", "telegram");
    await service.register({ scope: "project", name: "alpha" }, "s-new", "telegram");
    await service.register({ scope: "project", name: "alpha" }, "s-gone", "telegram");

    const res = await h.call("/api/sessions/list", { scope: "project", name: "alpha" });
    expect(res.status, res.raw).toBe(200);
    expect(res.json).toEqual({
      sessions: [
        { id: "s-new", title: null, channel: "telegram", createdAt: new Date(1_700_000_100_000).toISOString() },
        { id: "s-old", title: "старая задача", channel: "telegram", createdAt: new Date(1_700_000_000_000).toISOString() }
      ]
    });
  });

  it("serves the home workspace and reports engine failure as 500", async () => {
    const ok = harness();
    const okService = ok.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await okService.register({ scope: "home" }, "s-home", "telegram");
    expect((await ok.call("/api/sessions/list", { scope: "home" })).json).toEqual({ sessions: [] });

    const broken = harness({ queryThrows: true });
    const brokenService = broken.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await brokenService.register({ scope: "home" }, "s-home", "telegram");
    const res = await broken.call("/api/sessions/list", { scope: "home" });
    expect(res.status).toBe(500);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe("internal");
  });

  it("reports a damaged registry file as 500 instead of an empty list", async () => {
    const h = harness();
    await writeFile(join(home, "workspace-sessions.json"), "{not json", "utf8");
    const res = await h.call("/api/sessions/list", { scope: "home" });
    expect(res.status).toBe(500);
    expect((res.json as { error?: { message?: string } }).error?.message).toMatch(/not valid JSON/);
  });

  it("writes the registry to $DSH_HOME with 600", async () => {
    const h = harness();
    const service = h.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await service.register({ scope: "project", name: "alpha" }, "s-1", "telegram");
    const file = join(home, "workspace-sessions.json");
    const raw = await readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      workspaces: { "project:alpha": [{ sessionId: "s-1", channel: "telegram" }] }
    });
    // Имя кейса обещает 600 — проверяем режим, а не только путь и содержимое.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("serves a workspace session transcript and 404s an unregistered session", async () => {
    const h = harness({
      log: { session: { id: "s-1", createdAt: 1_700_000_000_000 }, events: [userMessage(0, "привет")] },
      title: { title: "задача" }
    });
    const service = h.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await service.register({ scope: "project", name: "alpha" }, "s-1", "telegram");

    const res = await h.call("/api/sessions/read", { scope: "project", name: "alpha", sessionId: "s-1" });
    expect(res.status, res.raw).toBe(200);
    expect(res.json).toEqual({
      session: { id: "s-1", title: "задача", channel: "telegram", createdAt: new Date(1_700_000_000_000).toISOString() },
      messages: [
        { seq: 0, time: new Date(1_700_000_000_000).toISOString(), role: "user", kind: "message", text: "привет", inContext: true }
      ]
    });

    const foreign = await h.call("/api/sessions/read", { scope: "project", name: "alpha", sessionId: "s-2" });
    expect(foreign.status).toBe(404);
    expect((foreign.json as { error?: { code?: string } }).error?.code).toBe("not-found");
  });

  it("rejects a read without a sessionId and an unknown project", async () => {
    const h = harness();
    expect((await h.call("/api/sessions/read", { scope: "project", name: "alpha" })).status).toBe(400);
    expect((await h.call("/api/sessions/read", { scope: "project", name: "nope", sessionId: "s-1" })).status).toBe(404);
  });

  it("maps an unknown engine session to 404 and another engine failure to 500", async () => {
    const missing = harness({
      readThrows: new SessionQueryError("no such session", "SESSION_QUERY_SESSION_NOT_FOUND")
    });
    const missingService = missing.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await missingService.register({ scope: "project", name: "alpha" }, "s-1", "telegram");
    const notFound = await missing.call("/api/sessions/read", { scope: "project", name: "alpha", sessionId: "s-1" });
    expect(notFound.status).toBe(404);

    const broken = harness({ readThrows: new Error("replay failed") });
    const brokenService = broken.provided.get("balbesSessions") as {
      register(ref: unknown, sessionId: string, channel: string): Promise<void>;
    };
    await brokenService.register({ scope: "project", name: "alpha" }, "s-1", "telegram");
    const res = await broken.call("/api/sessions/read", { scope: "project", name: "alpha", sessionId: "s-1" });
    expect(res.status).toBe(500);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe("internal");
  });
});
