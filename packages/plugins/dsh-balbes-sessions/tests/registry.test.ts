import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceSessionsRegistry,
  assertRegistryShape,
  refKey,
  registryFile
} from "../src/registry.js";

/**
 * Scheduling seam for the concurrency regression below. It is NOT a fake: the
 * real read still runs and settles exactly as it would, the wrapper only lets a
 * test park one chosen read so two concurrent loads can be ordered
 * deterministically instead of by luck. No read behaves differently from the
 * real `readFile` unless a test explicitly arms the gate.
 */
const readGate = vi.hoisted(() => {
  let armedPath: string | null = null;
  let markHeld: (() => void) | null = null;
  let released: Promise<void> = Promise.resolve();
  return {
    /** Park the next read of `path`, exposing when it is parked and how to release it. */
    arm(path: string): { held: Promise<void>; release: () => void } {
      armedPath = path;
      let held!: () => void;
      let release!: () => void;
      const parked = new Promise<void>((resolve) => (held = resolve));
      released = new Promise<void>((resolve) => (release = resolve));
      markHeld = held;
      return { held: parked, release };
    },
    /** Called by the wrapper once the real read settled, before it is returned. */
    async park(path: string): Promise<void> {
      if (armedPath === null || armedPath !== path) return;
      armedPath = null;
      const held = markHeld;
      markHeld = null;
      held?.();
      await released;
    }
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (path: string, options?: BufferEncoding): Promise<string> => {
      let value: string | undefined;
      let failure: unknown;
      try {
        value = (options === undefined
          ? await actual.readFile(path)
          : await actual.readFile(path, options)) as unknown as string;
      } catch (error) {
        failure = error;
      }
      await readGate.park(path);
      if (failure !== undefined) throw failure;
      return value as string;
    }) as unknown as typeof actual.readFile
  };
});

/**
 * Settle no later than `ms`: gives a load that does NOT memoize the in-flight
 * read time to finish on its own, while a memoizing one shares the parked read
 * and can only finish after the gate is released.
 */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ws-sessions-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("refKey", () => {
  it("uses the telegram key format", () => {
    expect(refKey({ scope: "home" })).toBe("home");
    expect(refKey({ scope: "project", name: "alpha" })).toBe("project:alpha");
  });
});

describe("assertRegistryShape", () => {
  it("normalizes a valid document and drops unknown fields", () => {
    const data = assertRegistryShape(
      {
        version: 1,
        extra: "ignored",
        workspaces: {
          home: [{ sessionId: "s-1", channel: "telegram", note: "dropped" }]
        }
      },
      "file.json"
    );
    expect(data).toEqual({ version: 1, workspaces: { home: [{ sessionId: "s-1", channel: "telegram" }] } });
  });

  it("deduplicates repeated session ids, keeping the first", () => {
    const data = assertRegistryShape(
      {
        version: 1,
        workspaces: {
          "project:a": [
            { sessionId: "s-1", channel: "telegram" },
            { sessionId: "s-1", channel: "admin" }
          ]
        }
      },
      "file.json"
    );
    expect(data.workspaces["project:a"]).toEqual([{ sessionId: "s-1", channel: "telegram" }]);
  });

  it("rejects damage and foreign documents, naming the file", () => {
    expect(() => assertRegistryShape({ version: 2, workspaces: {} }, "file.json")).toThrow(/file\.json/);
    expect(() => assertRegistryShape({ version: 1 }, "file.json")).toThrow(/workspaces/);
    expect(() => assertRegistryShape({ version: 1, workspaces: { home: {} } }, "file.json")).toThrow(/non-array/);
    expect(() => assertRegistryShape({ version: 1, workspaces: { home: [{ sessionId: "", channel: "telegram" }] } }, "file.json")).toThrow(/session id/);
    expect(() => assertRegistryShape({ version: 1, workspaces: { home: [{ sessionId: "s", channel: "Telegram!" }] } }, "file.json")).toThrow(/channel/);
  });
});

describe("WorkspaceSessionsRegistry", () => {
  it("reads a missing file as empty and an unreadable one as an error", async () => {
    const file = join(dir, "workspace-sessions.json");
    const registry = new WorkspaceSessionsRegistry(file);
    expect(await registry.list({ scope: "home" })).toEqual([]);

    await writeFile(file, "{not json", "utf8");
    const broken = new WorkspaceSessionsRegistry(file);
    await expect(broken.list({ scope: "home" })).rejects.toThrow(/not valid JSON/);
  });

  it("does not cache a failed load as empty", async () => {
    const file = join(dir, "workspace-sessions.json");
    await writeFile(file, "{not json", "utf8");
    const registry = new WorkspaceSessionsRegistry(file);
    await expect(registry.list({ scope: "home" })).rejects.toThrow();

    await writeFile(
      file,
      JSON.stringify({ version: 1, workspaces: { home: [{ sessionId: "s-1", channel: "telegram" }] } }),
      "utf8"
    );
    expect(await registry.list({ scope: "home" })).toEqual([{ sessionId: "s-1", channel: "telegram" }]);
  });

  it("registers idempotently, writes 600, and separates workspaces", async () => {
    const file = join(dir, "workspace-sessions.json");
    const registry = new WorkspaceSessionsRegistry(file);
    await registry.register({ scope: "project", name: "alpha" }, "s-1", "telegram");
    await registry.register({ scope: "project", name: "alpha" }, "s-1", "telegram");
    await registry.register({ scope: "project", name: "alpha" }, "s-2", "telegram");
    await registry.register({ scope: "home" }, "s-home", "telegram");

    expect(await registry.list({ scope: "project", name: "alpha" })).toEqual([
      { sessionId: "s-1", channel: "telegram" },
      { sessionId: "s-2", channel: "telegram" }
    ]);
    expect(await registry.list({ scope: "home" })).toEqual([{ sessionId: "s-home", channel: "telegram" }]);

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { version: number };
    expect(onDisk.version).toBe(1);
  });

  it("refuses an invalid channel instead of writing it", async () => {
    const file = join(dir, "workspace-sessions.json");
    const registry = new WorkspaceSessionsRegistry(file);
    await expect(registry.register({ scope: "home" }, "s-1", "Bad Channel")).rejects.toThrow(/channel/);
    expect(await registry.list({ scope: "home" })).toEqual([]);
  });

  it("never lets a parked first read drop an already registered session", async () => {
    const file = join(dir, "workspace-sessions.json");
    const registry = new WorkspaceSessionsRegistry(file);

    // A cold registry's first load takes its snapshot now (no file yet) but is
    // parked before that snapshot can be applied.
    const gate = readGate.arm(file);
    const listing = registry.list({ scope: "home" });
    await gate.held;

    const first = registry.register({ scope: "home" }, "s-1", "telegram");
    await settledWithin(first, 250);
    gate.release();
    await Promise.all([listing, first]);

    await registry.register({ scope: "home" }, "s-2", "telegram");

    // Append-only: s-1 was registered and must never disappear. Reading through a
    // fresh instance asserts the on-disk document, not just in-memory state.
    expect(await new WorkspaceSessionsRegistry(file).list({ scope: "home" })).toEqual([
      { sessionId: "s-1", channel: "telegram" },
      { sessionId: "s-2", channel: "telegram" }
    ]);
  });
});
