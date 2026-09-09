import { describe, expect, it, beforeEach } from "vitest";
import { apply, name, inject, Config, telegramSettingsSchema, TELEGRAM_BOT_TOKEN_REF } from "../src/index.js";

interface Seat {
  path: string;
  auth: string;
  handler(req: unknown, res: unknown, body: unknown): Promise<void> | void;
}

/** Fake of the settings seam: records every register call and hands out a
 *  stub scope, mirroring the namespace registration shape apply relies on. */
class FakeSettings {
  readonly calls: Array<{ namespace: string; schema: unknown }> = [];
  register(namespace: string, schema: unknown): { get(): unknown } {
    this.calls.push({ namespace, schema });
    return { get: () => ({}) };
  }
}

class FakeCredentials {
  refs = new Map<string, string>();
  async describe(ref: string) { return { configured: this.refs.has(ref), writable: true }; }
  async set(ref: string, value: string) { this.refs.set(ref, value); }
  async unset(ref: string) { this.refs.delete(ref); }
}

let seats: Seat[];
let http: { post(path: string, auth: string, handler: Seat["handler"]): void };
let settings: FakeSettings;
let credentials: FakeCredentials;

function makeCtx(): {
  get(key: string): unknown;
  logger: { warn(message: string): void };
} {
  return {
    get(key: string): unknown {
      return key === "balbesHttp" ? http
        : key === "settings" ? settings
        : key === "credentials" ? credentials
        : undefined;
    },
    logger: { warn(_message: string): void {} }
  };
}

beforeEach(() => {
  seats = [];
  http = {
    post(path: string, auth: string, handler: Seat["handler"]) {
      seats.push({ path, auth, handler });
    }
  };
  settings = new FakeSettings();
  credentials = new FakeCredentials();
});

describe("balbes-telegram plugin", () => {
  it("exposes the name/inject/Config/apply contract", () => {
    expect(name).toBe("balbes-telegram");
    expect(inject).toEqual(expect.arrayContaining(["balbesHttp", "settings", "credentials"]));
    expect(typeof Config).toBe("function");
    expect(typeof apply).toBe("function");
  });

  it("pins the bot token credentials ref", () => {
    expect(TELEGRAM_BOT_TOKEN_REF).toBe("BALBES_TELEGRAM_BOT_TOKEN");
  });

  it("registers the balbes-telegram settings namespace at apply time", () => {
    const warns: string[] = [];
    const ctx = {
      ...makeCtx(),
      logger: { warn(message: string) { warns.push(message); } }
    };
    apply(ctx, {});
    expect(warns).toEqual([]);
    expect(settings.calls).toHaveLength(1);
    expect(settings.calls[0]!.namespace).toBe("balbes-telegram");
    expect(settings.calls[0]!.schema).toBe(telegramSettingsSchema);
  });

  it("registers the exact settings schema semantics (enabled default, positive-int or null allowlist)", () => {
    const ctx = makeCtx();
    apply(ctx, {});
    const schema = settings.calls[0]!.schema as (data?: unknown) => unknown;
    // defaults: disabled, no allowlist
    expect(schema({})).toMatchObject({ enabled: false });
    // an explicit positive user id is kept
    expect(schema({ enabled: true, allowedUserId: 5 })).toMatchObject({ enabled: true, allowedUserId: 5 });
    // null means "no allowlist"
    expect(schema({ allowedUserId: null })).toMatchObject({ allowedUserId: null });
    // zero and non-integers are rejected (z.natural() enforces the integer)
    expect(() => schema({ allowedUserId: 0 })).toThrow();
    expect(() => schema({ allowedUserId: 1.5 })).toThrow();
  });

  it("warns without crashing when balbesHttp is absent", () => {
    const warns: string[] = [];
    const ctx = {
      get(key: string): unknown {
        return key === "settings" ? settings : undefined;
      },
      logger: { warn(message: string) { warns.push(message); } }
    };
    expect(() => apply(ctx, {})).not.toThrow();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("balbesHttp");
    // the early return mirrors the models plugin: no namespace registration
    expect(settings.calls).toHaveLength(0);
    expect(seats).toHaveLength(0);
  });
});
