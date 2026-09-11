import { createServer } from "node:http";

/**
 * Local fake Telegram Bot API server for the REAL-composition suite.
 *
 * The plugin's `Config.apiBase` (fed from `BALBES_TELEGRAM_API_BASE`) points
 * the whole channel at this server, so the spawned dsh process performs its
 * real HTTP polling and its real sendMessage/editMessageText calls against a
 * loopback socket instead of api.telegram.org. Everything it answers is a
 * valid Telegram envelope (`{ok:true,result:…}` / `{ok:false,error_code,
 * description}`), so `bot.ts` parses it exactly like the real API.
 *
 * Routes: `POST /bot<token>/<method>`.
 *  - `getMe` -> the fake bot identity (id/is_bot/username).
 *  - `getUpdates` -> LONG POLL: the request is held open until an update is
 *    enqueued (or `pollHoldMs` elapses), then the deliverable batch is
 *    answered. Standard Telegram offset semantics: an update whose
 *    `update_id` is below the requested `offset` is never delivered (and stays
 *    queued, so a test can prove a restored offset suppresses re-delivery).
 *    A SECOND concurrent long poll is answered with Telegram's real conflict
 *    envelope (`409 Conflict: terminated by other getUpdates request`) and is
 *    recorded in `outbound`, so a duplicate-poller regression fails the
 *    owner-visibility assertions loudly instead of being masked by an instant
 *    empty batch.
 *  - `sendMessage` -> a Message with a fresh `message_id` (the chat machine
 *    keys its view snapshots by it, so callbacks in a test must reuse it).
 *  - `editMessageText` -> the edited Message; `answerCallbackQuery` -> `true`.
 *  - `setMyCommands` / `setChatMenuButton` -> `true` (the bot's command list
 *    and its menu button; the payload is recorded in `outbound`).
 *  - any OTHER method -> `{ok:false, error_code:404, description:"Not Found"}`
 *    (an unimplemented method must never look like a success, or the suite
 *    would silently accept a call the real API would reject).
 * Every non-getUpdates call is recorded in `outbound` as
 * `{method, body, result}` (or `{method, body, error}` for a non-ok envelope);
 * every request (getUpdates included) is recorded in `requests` as
 * `{method, token, body}`.
 *
 * Test control surface:
 *   port, url, outbound, requests,
 *   enqueueUpdate(update, {updateId}), enqueueMessage({...}),
 *   enqueueCallback({...}), pendingUpdates(), getUpdatesRequests(),
 *   reset(), close()
 */

/** Long-poll hold: shorter than the plugin's 50s timeout, long enough to observe. */
const DEFAULT_HOLD_MS = 700;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body))
  });
  res.end(body);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function startFakeBotApi({
  pollHoldMs = DEFAULT_HOLD_MS,
  username = "balbes_test_bot",
  botId = 1,
  groupChatId
} = {}) {
  /** Queued-but-undelivered updates, oldest first. */
  let pending = [];
  let nextUpdateId = 1;
  let nextMessageId = 1000;
  let nextCallbackId = 0;
  /** The long poll currently held open, or undefined. */
  let held;
  const outbound = [];
  const requests = [];

  /** The chat type the real API would report for a chat id. */
  function chatTypeOf(chatId) {
    return groupChatId !== undefined && chatId === groupChatId ? "group" : "private";
  }

  /** Updates this request's offset would deliver, without consuming them. */
  function available(offset) {
    return offset === undefined ? pending : pending.filter((update) => update.update_id >= offset);
  }

  /** Consume and return the deliverable batch for one offset. */
  function takeBatch(offset) {
    const batch = available(offset);
    if (batch.length > 0) {
      const delivered = new Set(batch.map((update) => update.update_id));
      pending = pending.filter((update) => !delivered.has(update.update_id));
    }
    return batch;
  }

  /** Answer the held long poll if it now has something to deliver. */
  function flushHeld() {
    if (held !== undefined && !held.done && available(held.offset).length > 0) held.finish();
  }

  /**
   * Forget the held long poll: `answer` sends it an empty batch first (used when
   * this run is being reset/closed), otherwise the response is simply dropped
   * because the client is already gone.
   */
  function dropHeld(answer) {
    if (held === undefined || held.done) return;
    held.done = true;
    clearTimeout(held.timer);
    if (answer) {
      try {
        send(held.res, 200, { ok: true, result: [] });
      } catch {
        // the client is gone; nothing to answer
      }
    }
    held = undefined;
  }

  /** Answer the held long poll with an empty batch (reset/close). */
  function releaseAll() {
    dropHeld(true);
  }

  function handleGetUpdates(res, body) {
    const offset = typeof body.offset === "number" ? body.offset : undefined;
    if (held !== undefined && !held.done) {
      // A second concurrent long poll: Telegram refuses it. Recorded as an
      // owner-visible call on purpose — a duplicate poller must not pass
      // unnoticed.
      const error = { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" };
      outbound.push({ method: "getUpdates", body, error });
      send(res, 409, error);
      return;
    }
    const immediate = takeBatch(offset);
    if (immediate.length > 0) {
      send(res, 200, { ok: true, result: immediate });
      return;
    }
    const waiter = {
      offset,
      res,
      timer: undefined,
      done: false,
      finish: () => {
        if (waiter.done) return;
        waiter.done = true;
        clearTimeout(waiter.timer);
        if (held === waiter) held = undefined;
        try {
          send(res, 200, { ok: true, result: takeBatch(offset) });
        } catch {
          // The client died between the timer and the write (a killed dsh
          // process): the batch stays delivered, nobody is there to read it.
        }
      }
    };
    held = waiter;
    waiter.timer = setTimeout(waiter.finish, pollHoldMs);
    // A client that goes away ends its long poll (real Telegram does the same);
    // without this, a stale held poll would make the next boot's first poll
    // look like a conflict.
    res.on("close", () => {
      if (held === waiter && !waiter.done) dropHeld(false);
    });
  }

  function handleMethod(method, body, res) {
    if (method === "getUpdates") {
      handleGetUpdates(res, body);
      return;
    }
    let result;
    if (method === "getMe") {
      result = { id: botId, is_bot: true, first_name: "Balbes Test", username };
    } else if (method === "sendMessage") {
      result = {
        message_id: nextMessageId++,
        date: nowSeconds(),
        chat: { id: body.chat_id, type: chatTypeOf(body.chat_id) },
        text: typeof body.text === "string" ? body.text : ""
      };
    } else if (method === "editMessageText") {
      result = {
        message_id: body.message_id,
        date: nowSeconds(),
        chat: { id: body.chat_id, type: chatTypeOf(body.chat_id) },
        text: typeof body.text === "string" ? body.text : ""
      };
    } else if (method === "setMyCommands") {
      result = true;
    } else if (method === "setChatMenuButton") {
      result = true;
    } else if (method === "answerCallbackQuery") {
      result = true;
    } else {
      const error = { ok: false, error_code: 404, description: `Not Found: method not implemented by the fake: ${method}` };
      outbound.push({ method, body, error });
      send(res, 404, error);
      return;
    }
    outbound.push({ method, body, result });
    send(res, 200, { ok: true, result });
  }

  const server = createServer((req, res) => {
    // A socket that dies mid-flight (the spawned dsh is killed with a long poll
    // held open) must never surface as an unhandled stream error in the TEST
    // process; the fake only records what the plugin sent.
    res.on("error", () => {});
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw === "" ? "{}" : raw);
      } catch {
        body = {};
      }
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? "");
      if (match === null) {
        send(res, 404, { ok: false, error_code: 404, description: "Not Found" });
        return;
      }
      const token = match[1];
      const method = match[2];
      // `token` never lands in `outbound`; it is kept only in `requests` so a
      // test can assert WHICH credential the plugin used and when it stopped.
      requests.push({ method, token, body });
      handleMethod(method, body, res);
    });
  });

  /** Queue one raw update; `updateId` defaults to the next free id. */
  function enqueueUpdate(update, opts = {}) {
    const updateId = opts.updateId ?? nextUpdateId++;
    if (opts.updateId !== undefined) nextUpdateId = Math.max(nextUpdateId, updateId + 1);
    const entry = { update_id: updateId, ...update };
    pending.push(entry);
    pending.sort((a, b) => a.update_id - b.update_id);
    flushHeld();
    return entry;
  }

  /** Queue one text message update in the given chat. */
  function enqueueMessage({ fromId, text, chatId, chatType = "private", messageId, updateId } = {}) {
    const update = {
      message: {
        message_id: messageId ?? nextMessageId++,
        date: nowSeconds(),
        chat: { id: chatId ?? fromId, type: chatType },
        from: { id: fromId, is_bot: false, first_name: "Owner" },
        text
      }
    };
    return enqueueUpdate(update, updateId === undefined ? {} : { updateId });
  }

  /**
   * Queue one inline-keyboard callback. `messageId` must be the id of the
   * message whose buttons the owner pressed: the chat machine resolves the
   * pressed row through the snapshot it stored for that message id.
   */
  function enqueueCallback({ fromId, data, messageId, chatId, chatType = "private", updateId } = {}) {
    const update = {
      callback_query: {
        id: `cb-${nextCallbackId++}`,
        from: { id: fromId, is_bot: false, first_name: "Owner" },
        message: { message_id: messageId, chat: { id: chatId ?? fromId, type: chatType } },
        data
      }
    };
    return enqueueUpdate(update, updateId === undefined ? {} : { updateId });
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        username,
        groupChatId,
        outbound,
        requests,
        enqueueUpdate,
        enqueueMessage,
        enqueueCallback,
        pendingUpdates() {
          return [...pending];
        },
        getUpdatesRequests() {
          return requests.filter((request) => request.method === "getUpdates");
        },
        /**
         * Drop recordings and queued/held state between two boots on one home.
         * The update/message id spaces stay monotonic: real Telegram never
         * rewinds `update_id`, and rewinding would make the fake hand out ids
         * below a restored offset (i.e. hide a resume bug behind the harness).
         */
        reset() {
          releaseAll();
          pending = [];
          outbound.length = 0;
          requests.length = 0;
        },
        close() {
          releaseAll();
          server.closeAllConnections?.();
          server.close();
        }
      });
    });
  });
}
