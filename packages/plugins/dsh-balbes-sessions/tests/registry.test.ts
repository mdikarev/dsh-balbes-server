import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceSessionsRegistry,
  assertRegistryShape,
  refKey,
  registryFile
} from "../src/registry.js";

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
});
