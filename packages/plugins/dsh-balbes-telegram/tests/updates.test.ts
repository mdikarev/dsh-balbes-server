import { describe, expect, it } from "vitest";
import type { BotUpdate } from "../src/bot.js";
import { classify, isAuthorized, isCommand } from "../src/updates.js";

const OWNER = 7;

/** Private-chat text message from `fromId` with the given chat `type` and text. */
function mkMessage(fromId: number, chatType: string, text: string): BotUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: 10, type: chatType },
      from: { id: fromId },
      text
    }
  };
}

/** Callback query on a message in a chat of the given `type`, pressed by `fromId`. */
function mkCallback(fromId: number, chatType: string, data: string): BotUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: "cb-1",
      from: { id: fromId },
      message: { message_id: 10, chat: { id: 10, type: chatType } },
      data
    }
  };
}

/**
 * Telegram payloads arrive as unvalidated JSON, so tests that exercise
 * runtime robustness against a deliberately partial shape cross the type
 * boundary through unknown on purpose.
 */
function rawUpdate(shape: unknown): BotUpdate {
  return shape as BotUpdate;
}

describe("isAuthorized", () => {
  it("accepts a message from the allowed user in a private chat", () => {
    expect(isAuthorized(mkMessage(OWNER, "private", "hi"), OWNER)).toBe(true);
  });

  it("rejects a message from any other user even in a private chat", () => {
    expect(isAuthorized(mkMessage(OWNER + 1, "private", "hi"), OWNER)).toBe(false);
  });

  it("rejects messages from the allowed user in non-private chats", () => {
    expect(isAuthorized(mkMessage(OWNER, "group", "hi"), OWNER)).toBe(false);
    expect(isAuthorized(mkMessage(OWNER, "supergroup", "hi"), OWNER)).toBe(false);
    expect(isAuthorized(mkMessage(OWNER, "channel", "hi"), OWNER)).toBe(false);
  });

  it("rejects a message that carries no from user", () => {
    const update: BotUpdate = {
      update_id: 1,
      message: { message_id: 10, chat: { id: 10, type: "private" }, text: "hi" }
    };
    expect(isAuthorized(update, OWNER)).toBe(false);
  });

  it("rejects a message whose chat carries no type", () => {
    const update = rawUpdate({
      update_id: 1,
      message: { message_id: 10, chat: { id: 10 }, from: { id: OWNER }, text: "hi" }
    });
    expect(isAuthorized(update, OWNER)).toBe(false);
  });

  it("applies the same rule to callback queries: allowed user on a private chat", () => {
    expect(isAuthorized(mkCallback(OWNER, "private", "go"), OWNER)).toBe(true);
  });

  it("rejects a callback from any other user even on a private chat", () => {
    expect(isAuthorized(mkCallback(OWNER + 1, "private", "go"), OWNER)).toBe(false);
  });

  it("rejects callbacks on messages in non-private chats", () => {
    expect(isAuthorized(mkCallback(OWNER, "supergroup", "go"), OWNER)).toBe(false);
  });

  it("rejects a callback that carries no from user", () => {
    const update = rawUpdate({
      update_id: 1,
      callback_query: {
        id: "cb-1",
        message: { message_id: 10, chat: { id: 10, type: "private" } },
        data: "go"
      }
    });
    expect(isAuthorized(update, OWNER)).toBe(false);
  });

  it("rejects a callback with no attached message (no chat to verify)", () => {
    const update = rawUpdate({
      update_id: 1,
      callback_query: { id: "cb-1", from: { id: OWNER }, data: "go" }
    });
    expect(isAuthorized(update, OWNER)).toBe(false);
  });

  it("rejects an update carrying neither a message nor a callback", () => {
    const update: BotUpdate = { update_id: 1 };
    expect(isAuthorized(update, OWNER)).toBe(false);
  });
});

describe("classify", () => {
  it("reduces a text message to its message payload", () => {
    const update = mkMessage(OWNER, "private", "hello");
    expect(classify(update)).toEqual({ kind: "message", messageId: 10, chatId: 10, text: "hello" });
  });

  it("ignores messages without text (photos, stickers and the like)", () => {
    const update: BotUpdate = {
      update_id: 1,
      message: { message_id: 10, chat: { id: 10, type: "private" }, from: { id: OWNER } }
    };
    expect(classify(update)).toBeNull();
  });

  it("reduces a callback query with data to its callback payload", () => {
    const update = mkCallback(OWNER, "private", "go");
    expect(classify(update)).toEqual({
      kind: "callback",
      callbackQueryId: "cb-1",
      messageId: 10,
      chatId: 10,
      data: "go"
    });
  });

  it("ignores a callback query without data", () => {
    const update = rawUpdate({
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: OWNER },
        message: { message_id: 10, chat: { id: 10, type: "private" } }
      }
    });
    expect(classify(update)).toBeNull();
  });

  it("ignores a callback with no attached message (no ids to act on)", () => {
    const update = rawUpdate({
      update_id: 1,
      callback_query: { id: "cb-1", from: { id: OWNER }, data: "go" }
    });
    expect(classify(update)).toBeNull();
  });

  it("ignores updates carrying neither a message nor a callback (edit events and the like)", () => {
    const update: BotUpdate = { update_id: 1 };
    expect(classify(update)).toBeNull();
  });
});

describe("isCommand", () => {
  it("recognizes slash-prefixed commands", () => {
    expect(isCommand("/start")).toBe(true);
    expect(isCommand("/files")).toBe(true);
  });

  it("treats a slash inside a sentence as ordinary text", () => {
    expect(isCommand("привет /files")).toBe(false);
  });

  it("rejects empty and whitespace-only text", () => {
    expect(isCommand("")).toBe(false);
    expect(isCommand("   ")).toBe(false);
  });
});
