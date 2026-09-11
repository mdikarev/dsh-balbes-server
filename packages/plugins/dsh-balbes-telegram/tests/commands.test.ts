import { describe, expect, it } from "vitest";
import { TELEGRAM_COMMANDS, parseCommand } from "../src/commands.js";

describe("command table", () => {
  it("is a Telegram-valid list and names exactly the routed commands", () => {
    expect(TELEGRAM_COMMANDS.map((c) => c.command)).toEqual(["menu", "status", "ws", "model", "reset", "stop", "help"]);
    for (const entry of TELEGRAM_COMMANDS) {
      expect(entry.command).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe("parseCommand", () => {
  it("routes every registered command, including /start as menu", () => {
    expect(parseCommand("/menu")).toBe("menu");
    expect(parseCommand("/start")).toBe("menu");
    expect(parseCommand("/ws")).toBe("ws");
    expect(parseCommand("/model")).toBe("model");
    expect(parseCommand("/reset")).toBe("reset");
    expect(parseCommand("/stop")).toBe("stop");
    expect(parseCommand("/status")).toBe("status");
    expect(parseCommand("/help")).toBe("help");
  });

  it("strips the bot mention, ignores case and surrounding spaces", () => {
    expect(parseCommand("  /Menu@balbes_test_bot ")).toBe("menu");
    expect(parseCommand("/MODEL")).toBe("model");
  });

  it("reports unknown commands and leaves plain text alone", () => {
    expect(parseCommand("/foo")).toBe("unknown");
    expect(parseCommand("/")).toBe("unknown");
    expect(parseCommand("Воркспейсы")).toBeUndefined();
    expect(parseCommand("почини /etc/hosts в проекте")).toBeUndefined();
  });
});
