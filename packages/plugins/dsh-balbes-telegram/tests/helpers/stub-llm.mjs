// keep in sync with packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs
// (intended to be a verbatim copy: the telegram REAL suite must not depend on a
// sibling package's test tree, and a divergence here would silently change what
// the scripted agent turns see).
import { createServer } from "node:http";

function ssePayload(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * dsh 0.1.7-rc.1 seam fact: @deepseek-ai/dsh-llm-deepseek streams the DeepSeek
 * Messages (Anthropic-style) SSE protocol, NOT OpenAI chat-completions:
 * message_start -> content_block_start/delta/stop -> message_delta ->
 * message_stop. There is no `data: [DONE]` sentinel, and every frame's JSON
 * must carry a string `type` (the parser rejects anything else as a type
 * mismatch).
 */
function messageStart() {
  return {
    type: "message_start",
    message: { id: "stub-1", type: "message", role: "assistant", usage: {} }
  };
}

/** Text response: one text block, end_turn, message_stop. */
function textFrames(text) {
  return [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" }
  ];
}

/** One tool_use block per call; the arguments arrive as input_json_delta. */
function toolFrames(calls) {
  const frames = [];
  calls.forEach((call, index) => {
    frames.push({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: `call_stub${index === 0 ? "" : `_${index}`}`,
        name: call.name,
        input: {}
      }
    });
    frames.push({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: call.arguments }
    });
    frames.push({ type: "content_block_stop", index });
  });
  frames.push({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
  frames.push({ type: "message_stop" });
  return frames;
}

/**
 * Frames for one scripted response entry. `entry.toolCall` (single-call form)
 * and `entry.toolCalls` (list form) emit one `tool_use` block per call with the
 * SAME name/arguments JSON the real tool expects, then stop_reason "tool_use";
 * `entry.text` emits one text block and stop_reason "end_turn".
 */
function framesFor(entry) {
  const text = entry.text;
  const calls = entry.toolCalls ?? (entry.toolCall !== undefined ? [entry.toolCall] : undefined);
  if (calls !== undefined) {
    if (calls.length === 0) throw new Error("startStubLlm: toolCalls must not be empty");
    return [messageStart(), ...toolFrames(calls)];
  }
  if (typeof text === "string") return [messageStart(), ...textFrames(text)];
  throw new Error(`startStubLlm: script entry must carry text or toolCall/toolCalls, got ${JSON.stringify(entry)}`);
}

/**
 * DeepSeek Messages (Anthropic-style) SSE stub for the REAL composition tests.
 * @deepseek-ai/dsh-llm-deepseek sends `POST <baseURL>/v1/messages` with
 * `stream: true` and always parses the response body as that SSE stream, so a
 * plain JSON response never reaches the agent. Emit a minimal streaming
 * completion instead:
 *   message_start -> content_block_start -> content_block_delta ->
 *   content_block_stop -> message_delta(stop_reason) -> message_stop
 * Every request is recorded in `calls` ({ path, body }).
 *
 * Backward-compatible `script` extension: when `script` (an ordered list of
 * per-request responses) is absent the helper behaves exactly as before —
 * every request answers with the single `text`. When present, each request
 * consumes the next entry round-robin: `{ toolCall: { name, arguments } }`
 * (or `{ toolCalls: [...] }` for several calls in one assistant message)
 * makes the engine believe the model called a tool, `{ text }` closes the
 * conversation with a plain assistant message. `setScript` swaps the
 * sequence and resets the cursor, so one stub serves many agent runs.
 * `setDelay` (milliseconds) delays every response, so a test can observe an
 * agent while a turn is mid-request (cancel / dispose-busy semantics).
 */
export function startStubLlm({ text = "ok", script } = {}) {
  const calls = [];
  let entries = script === undefined ? null : [...script];
  let cursor = 0;
  let delayMs = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ path: req.url, body: JSON.parse(raw || "{}") });
      const respond = () => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        const entry = entries === null ? { text } : entries[cursor++ % entries.length];
        res.end(framesFor(entry).map(ssePayload).join(""));
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        calls,
        close: () => server.close(),
        setScript(nextScript) {
          entries = nextScript === undefined ? null : [...nextScript];
          cursor = 0;
        },
        setDelay(ms) {
          delayMs = ms;
        }
      });
    });
  });
}
