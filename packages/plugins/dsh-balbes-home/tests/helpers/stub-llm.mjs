// keep in sync with packages/bundles/dsh-balbes-host/tests/helpers/stub-llm.mjs
// (intended to be a verbatim copy: the telegram REAL suite must not depend on a
// sibling package's test tree, and a divergence here would silently change what
// the scripted agent turns see).
import { createServer } from "node:http";

function ssePayload(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * One chat-completion chunk: id/object/created/model framing, one delta, an
 * optional finish_reason, and optional usage. The DeepSeek adapter reads the
 * delta fields (role/content/tool_calls) and defers finish + usage until the
 * `[DONE]` sentinel.
 */
function chunk({ delta, finish_reason = null, usage } = {}) {
  const payload = {
    id: "stub-1",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "stub",
    choices: [{ index: 0, delta, finish_reason }]
  };
  if (usage !== undefined) payload.usage = usage;
  return payload;
}

const ROLE_CHUNK = chunk({ delta: { role: "assistant" } });
const USAGE_CHUNK = chunk({
  delta: {},
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});

/**
 * SSE chunks for one scripted response entry. `entry.toolCall` (single-call
 * form) and `entry.toolCalls` (list form) emit one `delta.tool_calls` chunk
 * per call with the SAME name/arguments JSON the real tool expects, then
 * finish_reason "tool_calls"; `entry.text` emits the content delta and
 * finish_reason "stop" as the plain-text stub always did.
 */
function chunksFor(entry) {
  const text = entry.text;
  const calls = entry.toolCalls ?? (entry.toolCall !== undefined ? [entry.toolCall] : undefined);
  const chunks = [ROLE_CHUNK];
  if (calls !== undefined) {
    chunks.push(
      chunk({
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: `call_stub${index === 0 ? "" : `_${index}`}`,
            type: "function",
            function: { name: call.name, arguments: call.arguments }
          }))
        },
        finish_reason: "tool_calls"
      })
    );
  } else if (typeof text === "string") {
    chunks.push(chunk({ delta: { content: text } }), chunk({ delta: {}, finish_reason: "stop" }));
  } else {
    throw new Error(`startStubLlm: script entry must carry text or toolCall/toolCalls, got ${JSON.stringify(entry)}`);
  }
  chunks.push(USAGE_CHUNK);
  return chunks;
}

/**
 * OpenAI-compatible chat-completions stub for the REAL composition tests.
 * @deepseek-ai/dsh-llm-deepseek always streams: its adapter parses the
 * response body as an SSE event stream and aborts without a trailing
 * `data: [DONE]` sentinel, so a plain JSON response never reaches the
 * agent. Emit a minimal streaming completion instead:
 *   role delta -> (content delta | tool_calls delta) -> finish -> [DONE]
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
        res.end(chunksFor(entry).map(ssePayload).join("") + "data: [DONE]\n\n");
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
