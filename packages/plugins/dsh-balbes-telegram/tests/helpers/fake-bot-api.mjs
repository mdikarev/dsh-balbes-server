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
 *  - `sendMessage` -> a Message with a fresh `message_id` (the chat machine
 *    keys its view snapshots by it, so callbacks in a test must reuse it).
 *  - `editMessageText` / `answerCallbackQuery` -> the real result shapes.
 *  - every other method -> `true`.
 * Every non-getUpdates call is recorded in `outbound` as `{method, body,
 * result}`; every request (getUpdates included) is recorded in `requests` as
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

export function startFakeBotApi({ pollHoldMs = DEFAULT_HOLD_MS, username = "balbes_test_bot", botId = 1 } = {}) {
  /** Queued-but-undelivered updates, oldest first. */
  let pending = [];
  let nextUpdateId = 1;
  let nextMessageId = 1000;
  let nextCallbackId = 0;
  let holding = false;
  const outbound = [];
  const requests = [];
  /** Held long polls: {offset, res, timer, done, finish}. */
  const waiters = new Set();

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

  /** Answer every held long poll that now has something to deliver. */
  function flushWaiters() {
    for (const waiter of [...waiters]) {
      if (available(waiter.offset).length > 0) waiter.finish();
    }
  }

  function handleGetUpdates(res, body) {
    const offset = typeof body.offset === "number" ? body.offset : undefined;
    if (holding) {
      // Two concurrent long polls would make the batch split nondeterministic.
      send(res, 200, { ok: true, result: [] });
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
        waiters.delete(waiter);
        if (waiters.size === 0) holding = false;
        send(res, 200, { ok: true, result: takeBatch(offset) });
      }
    };
    holding = true;
    waiter.timer = setTimeout(waiter.finish, pollHoldMs);
    waiters.add(waiter);
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
        chat: { id: body.chat_id, type: "private" },
        text: typeof body.text === "string" ? body.text : ""
      };
    } else if (method === "editMessageText") {
      result = {
        message_id: body.message_id,
        date: nowSeconds(),
        chat: { id: body.chat_id, type: "private" },
        text: typeof body.text === "string" ? body.text : ""
      };
    } else {
      result = true;
    }
    outbound.push({ method, body, result });
    send(res, 200, { ok: true, result });
  }

  const server = createServer((req, res) => {
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
    flushWaiters();
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

  /**
   * Answer every held long poll with an empty batch and forget the waiters.
   * Used when a client process goes away (reset/close): the sockets may already
   * be dead, so a write failure must never surface here.
   */
  function releaseAll() {
    for (const waiter of [...waiters]) {
      waiter.done = true;
      clearTimeout(waiter.timer);
      try {
        send(waiter.res, 200, { ok: true, result: [] });
      } catch {
        // the client is gone; nothing to answer
      }
    }
    waiters.clear();
    holding = false;
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        username,
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
