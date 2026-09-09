import { describe, expect, it } from "vitest";
import { TELEGRAM_MESSAGE_LIMIT, sanitizeReply, splitMessage } from "../src/text.js";

/**
 * 249 lines of 39 characters plus a trailing newline, finished by one
 * 40-character line: exactly 10_000 characters with a newline every 40.
 */
function longLineText(): string {
  return "a".repeat(39).concat("\n").repeat(249) + "a".repeat(40);
}

describe("splitMessage", () => {
  it("keeps a short text in a single chunk", () => {
    expect(splitMessage("short text")).toEqual(["short text"]);
  });

  it("keeps text that exactly fills the limit in a single chunk", () => {
    const text = "x".repeat(TELEGRAM_MESSAGE_LIMIT);
    expect(splitMessage(text)).toEqual([text]);
  });

  it("splits a long newline-delimited text into non-empty chunks within the limit", () => {
    const text = longLineText();
    expect(text.length).toBe(10_000);

    const chunks = splitMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    // Chunks are contiguous slices, so joining reproduces the source exactly.
    expect(chunks.join("")).toBe(text);
  });

  it("hard-splits a single word longer than the limit without losing content", () => {
    const word = "w".repeat(10_000);

    const chunks = splitMessage(word);

    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    expect(chunks.join("")).toBe(word);
  });

  it("honours a custom limit below the Telegram default", () => {
    const text = "c".repeat(9).concat("\n").repeat(11) + "c".repeat(9);
    const chunks = splitMessage(text, 20);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("returns no chunks for an empty text", () => {
    expect(splitMessage("")).toEqual([]);
  });

  it("clamps a non-positive limit to 1 so splitting still terminates", () => {
    expect(splitMessage("ab", 0)).toEqual(["a", "b"]);
    expect(splitMessage("ab", -3)).toEqual(["a", "b"]);
  });
});

describe("sanitizeReply", () => {
  it("strips NUL characters", () => {
    expect(sanitizeReply("a\0b\0c")).toBe("abc");
    expect(sanitizeReply("\0\0")).toBe("");
  });

  it("normalizes CRLF line endings to a single LF", () => {
    expect(sanitizeReply("one\r\ntwo")).toBe("one\ntwo");
    expect(sanitizeReply("a\r\n\r\nb")).toBe("a\n\nb");
  });

  it("normalizes a lone carriage return to a line feed", () => {
    expect(sanitizeReply("lone\rreturn")).toBe("lone\nreturn");
  });

  it("leaves already plain text untouched", () => {
    const text = "plain text, newlines\nand utf-8 ✓ stay as-is";
    expect(sanitizeReply(text)).toBe(text);
  });
});
