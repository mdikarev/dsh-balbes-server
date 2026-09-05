import { createServer } from "node:http";

function ssePayload(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * OpenAI-compatible chat-completions stub for the REAL composition test.
 * @deepseek-ai/dsh-llm-deepseek always streams: its adapter parses the
 * response body as an SSE event stream and aborts without a trailing
 * `data: [DONE]` sentinel, so a plain JSON response never reaches the
 * agent. Emit a minimal streaming completion instead:
 *   role delta -> text delta -> finish -> [DONE]
 * Every request is recorded in `calls` ({ path, body }).
 */
export function startStubLlm({ text = "ok" } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ path: req.url, body: JSON.parse(raw || "{}") });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      const chunks = [
        { id: "stub-1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        { id: "stub-1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
        { id: "stub-1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "stub-1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      ];
      res.end(chunks.map(ssePayload).join("") + "data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, calls, close: () => server.close() });
    });
  });
}
