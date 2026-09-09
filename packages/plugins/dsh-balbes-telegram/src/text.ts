/**
 * Plain-text helpers for replies the bot sends to Telegram.
 *
 * Agent output is delivered as plain text (no parse_mode), so it must both
 * fit the API's single-message cap and be safe to send verbatim:
 * `splitMessage` cuts long text at newline boundaries (hard-cutting over-long
 * words) and `sanitizeReply` removes bytes that are not plain-text safe.
 * Both are pure string functions — no I/O, no network.
 */

/** Telegram's hard cap on characters in one text message. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Split `text` into chunks of at most `limit` characters (default the
 * Telegram cap). Cuts prefer newline boundaries so messages end on a line
 * break; a piece with no newline inside the window (e.g. a single over-long
 * word) is hard-cut at the limit. Chunks are contiguous, non-empty slices of
 * the input in order, so joining them with "" reproduces the source exactly.
 * Empty input yields no chunks.
 */
export function splitMessage(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
  // A limit below 1 would never shrink the remainder; clamp so the loop
  // always makes progress (per-character chunks at worst).
  const chunkLimit = Math.max(1, limit);
  const chunks: string[] = [];
  let rest = text;

  while (rest.length > chunkLimit) {
    const window = rest.slice(0, chunkLimit);
    const breakAt = window.lastIndexOf("\n");
    if (breakAt !== -1) {
      // Cut right after the newline: the chunk ends on a line boundary.
      chunks.push(rest.slice(0, breakAt + 1));
      rest = rest.slice(breakAt + 1);
    } else {
      chunks.push(window);
      rest = rest.slice(chunkLimit);
    }
  }

  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}

/**
 * Make `text` safe to send as a plain-text Telegram message: NUL characters
 * are stripped and every carriage return (CRLF or a lone CR) becomes a line
 * feed, so line endings are uniformly LF. Everything else passes through
 * untouched.
 */
export function sanitizeReply(text: string): string {
  return text.replace(/\0/g, "").replace(/\r\n?/g, "\n");
}
