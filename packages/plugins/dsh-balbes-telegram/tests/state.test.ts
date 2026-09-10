import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TelegramState, type TelegramStateData } from "../src/state.js";

let home: string;
let file: string;
let state: TelegramState;

/** Plant raw file contents at the state path (as an externally damaged file). */
async function writeRaw(contents: string): Promise<void> {
  await writeFile(file, contents);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "telegram-state-"));
  file = TelegramState.defaultFile(home);
  state = new TelegramState(file);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("TelegramState.defaultFile", () => {
  it("places telegram-state.json under the given dsh home", () => {
    expect(TelegramState.defaultFile("/srv/dsh")).toBe(join("/srv/dsh", "telegram-state.json"));
  });
});

describe("TelegramState.load on a missing file", () => {
  it("returns the default empty state when the file does not exist", async () => {
    expect(await state.load()).toEqual({ version: 1, sessions: {} });
  });
});

describe("TelegramState.save", () => {
  it("writes the file with mode 600 and valid JSON", async () => {
    const data: TelegramStateData = { version: 1, sessions: { home: "sess-1" }, activeWorkspace: "home", offset: 42 };

    await state.save(data);

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(data);
  });

  it("leaves no temporary file behind", async () => {
    await state.save({ version: 1, sessions: {} });

    expect((await readdir(home)).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("creates the file even when a previous file existed", async () => {
    await state.save({ version: 1, sessions: { home: "sess-1" } });
    await state.save({ version: 1, sessions: { home: "sess-2" }, offset: 7 });

    expect(await state.load()).toEqual({ version: 1, sessions: { home: "sess-2" }, offset: 7 });
  });

  it("rejects and leaves no temporary file when the target directory is missing", async () => {
    const orphan = new TelegramState(join(home, "missing-dir", "telegram-state.json"));

    await expect(orphan.save({ version: 1, sessions: {} })).rejects.toThrow();
    expect(await readdir(home)).toEqual([]);
  });
});

describe("TelegramState round-trip", () => {
  it("returns exactly what was saved", async () => {
    const data: TelegramStateData = {
      version: 1,
      activeWorkspace: "project:balbes",
      sessions: { home: "sess-home", "project:balbes": "sess-project" },
      offset: 1234
    };

    await state.save(data);

    expect(await state.load()).toEqual(data);
  });

  it("keeps an omitted optional field omitted", async () => {
    await state.save({ version: 1, sessions: {} });

    const loaded = await state.load();
    expect(loaded.activeWorkspace).toBeUndefined();
    expect(loaded.offset).toBeUndefined();
  });
});

describe("TelegramState.load shape validation", () => {
  it("rejects corrupted JSON with the file name", async () => {
    await writeRaw("{ not json");

    await expect(state.load()).rejects.toThrow(file);
  });

  it("rejects a foreign version with the file name", async () => {
    await writeRaw(JSON.stringify({ version: 2, sessions: {} }));

    await expect(state.load()).rejects.toThrow(file);
  });

  it("rejects a missing version with the file name", async () => {
    await writeRaw(JSON.stringify({ sessions: {} }));

    await expect(state.load()).rejects.toThrow(file);
  });

  it("rejects a non-object document with the file name", async () => {
    await writeRaw(JSON.stringify([1, 2, 3]));

    await expect(state.load()).rejects.toThrow(file);
  });

  it("rejects sessions that are not an object with the file name", async () => {
    await writeRaw(JSON.stringify({ version: 1, sessions: "home=sess-1" }));

    await expect(state.load()).rejects.toThrow(file);
  });

  it("rejects sessions that are an array with the file name", async () => {
    await writeRaw(JSON.stringify({ version: 1, sessions: ["sess-1"] }));

    await expect(state.load()).rejects.toThrow(file);
  });

  it("rejects a non-string session id with the file name", async () => {
    await writeRaw(JSON.stringify({ version: 1, sessions: { home: 7 } }));

    await expect(state.load()).rejects.toThrow(file);
  });

  it("rejects a non-string activeWorkspace with the file name", async () => {
    await writeRaw(JSON.stringify({ version: 1, sessions: {}, activeWorkspace: 7 }));

    await expect(state.load()).rejects.toThrow(file);
  });

  it("rejects an offset that is not a positive integer with the file name", async () => {
    for (const offset of [0, -1, 1.5, "12"]) {
      await writeRaw(JSON.stringify({ version: 1, sessions: {}, offset }));

      await expect(state.load()).rejects.toThrow(file);
    }
  });

  it("rejects an unreadable path with the file name instead of resetting", async () => {
    await mkdir(file);

    await expect(state.load()).rejects.toThrow(file);
  });

  it("ignores unknown fields and keeps only the known ones", async () => {
    await writeRaw(JSON.stringify({ version: 1, sessions: { home: "sess-1" }, legacyFlag: true }));

    expect(await state.load()).toEqual({ version: 1, sessions: { home: "sess-1" } });
  });
});

describe("TelegramState data contract", () => {
  it("has no token field (compile-time: adding one breaks the expect-error below)", () => {
    // The bot token lives in the credentials service and never in this file.
    // If a `token` field is ever added to TelegramStateData, the directive
    // below becomes unused and `tsc -p tsconfig.json` (which includes tests/)
    // fails — the contract is enforced at compile time, not at runtime.
    // @ts-expect-error state data deliberately has no token field
    const illegal: TelegramStateData = { version: 1, sessions: {}, token: "123:abc" };

    expect(illegal.version).toBe(1);
  });
});
