/**
 * Authorization and classification of Telegram Bot API updates.
 *
 * Both entry points are pure (no I/O, no network): the polling loop and the
 * chat handler feed raw updates in and act on what comes out. The contract
 * between them is strict — authorization is checked BEFORE classification:
 *
 *   if (!isAuthorized(update, allowedUserId)) return; // drop, no state
 *   const classified = classify(update);              // only once authorized
 *
 * An unauthorized update is therefore never classified, so no code path can
 * observe anything about a foreign user's message. Allowlisting is by
 * `from.id` AND `chat.type === "private"`; callback data and paths are never
 * treated as trusted input anywhere in this module.
 */

import type { BotUpdate } from "./bot.js";

/**
 * An authorized, actionable update reduced to the fields the chat flow needs.
 * `kind` discriminates between a chat text message and an inline-keyboard
 * callback query; everything else the API may attach is dropped.
 */
export type ClassifiedUpdate =
  | { kind: "message"; messageId: number; chatId: number; text: string }
  | { kind: "callback"; callbackQueryId: string; messageId: number; chatId: number; data: string };

/**
 * True only when the update's author is the allowlisted user AND the update
 * happened in a private chat. A message/callback with no `from` or no private
 * chat (`group`/`supergroup`/`channel`, missing chat, no attached message) is
 * never authorized — a foreign or anonymous update must not be processed.
 */
export function isAuthorized(update: BotUpdate, allowedUserId: number): boolean {
  const { message, callback_query: callbackQuery } = update;

  if (message !== undefined) {
    return message.from?.id === allowedUserId && message.chat?.type === "private";
  }
  if (callbackQuery !== undefined) {
    return callbackQuery.from?.id === allowedUserId && callbackQuery.message?.chat?.type === "private";
  }
  return false;
}

/**
 * Reduce an update to its actionable payload, or null when there is nothing to
 * act on: a message without text (photo, sticker, ...), a callback without
 * data or without an attached message, an update that is neither (edit events
 * and the like). Null is the "ignore silently" signal for the caller.
 */
export function classify(update: BotUpdate): ClassifiedUpdate | null {
  const { message, callback_query: callbackQuery } = update;

  if (message !== undefined && message.text !== undefined) {
    return { kind: "message", messageId: message.message_id, chatId: message.chat.id, text: message.text };
  }
  if (callbackQuery !== undefined && callbackQuery.data !== undefined && callbackQuery.message !== undefined) {
    return {
      kind: "callback",
      callbackQueryId: callbackQuery.id,
      messageId: callbackQuery.message.message_id,
      chatId: callbackQuery.message.chat.id,
      data: callbackQuery.data
    };
  }
  return null;
}

/** True when the text starts with a slash, i.e. looks like a bot command. */
export function isCommand(text: string): boolean {
  return text.startsWith("/");
}
