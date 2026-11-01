const http = require("node:http");

const PORT = parseInt(process.env.PORT || "8086", 10);
const HOST = "0.0.0.0";
const ROUTER_BASE = process.env.ROUTER_BASE || "http://127.0.0.1:20128";
const ROUTER_KEY = process.env.ROUTER_KEY || "";

const SUPPORTED_MODELS = [
  { id: "muse-chat", object: "model", created: 1793202441, owned_by: "muse" },
  { id: "muse-image", object: "model", created: 1793202441, owned_by: "muse" },
  { id: "muse-video", object: "model", created: 1793202441, owned_by: "muse" }
];

// Sequential Mutex Queue for Muse Web single-session stability
let lockChain = Promise.resolve();

function acquireLock() {
  let release;
  const p = new Promise(resolve => { release = resolve; });
  const currentLock = lockChain.then(() => release);
  lockChain = lockChain.then(() => p);
  return currentLock;
}

function resolveUpstreamModel(inputModel) {
  const m = String(inputModel || "").toLowerCase().replace(/^(muse\/|muse-web\/)/, "");
  if (m.includes("image")) return "muse-web/muse-image";
  if (m.includes("video")) return "muse-web/muse-video";
  return "muse-web/muse-chat";
}

function extractToolCalls(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/```json\s*(\{[\s\S]*?"tool_calls"[\s\S]*?\})\s*```/) ||
                text.match(/(\{[\s\S]*?"tool_calls"\s*:\s*\[[\s\S]*?\][\s\S]*?\})/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
        return parsed.tool_calls.map((tc, idx) => ({
          id: tc.id || `call_${idx}_${Date.now()}`,
          type: "function",
          function: {
            name: tc.name || tc.function?.name || "",
            arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || tc.function?.arguments || {})
          }
        }));
      }
    } catch {}
  }
  return null;
}

// Prune long message histories for web client textarea sanity
function pruneMessages(messages, maxChars = 32000, maxRecent = 12) {
  if (!Array.isArray(messages) || messages.length <= 1) return messages;

  const systemMsgs = messages.filter(m => m.role === "system" || m.role === "developer");
  const nonSystem = messages.filter(m => m.role !== "system" && m.role !== "developer");

  const recent = nonSystem.slice(-maxRecent);
  let result = [...systemMsgs, ...recent];

  let totalLen = result.reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : 500), 0);
  while (totalLen > maxChars && recent.length > 2) {
    recent.shift();
    result = [...systemMsgs, ...recent];
    totalLen = result.reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : 500), 0);
  }

  return result;
}

async function handleChatCompletions(req, res) {
  let bodyBuffer = "";
  for await (const chunk of req) {
    bodyBuffer += chunk;
  }

  let body = {};
  try {
    body = JSON.parse(bodyBuffer);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
    return;
  }

  const requestedModel = body.model || "muse-chat";
  const upstreamModel = resolveUpstreamModel(requestedModel);
  const isStreaming = body.stream === true;
  const tools = body.tools || body.functions;
  const hasTools = Array.isArray(tools) && tools.length > 0;

  // Prune history for web UI
  let rawMessages = Array.isArray(body.messages) ? body.messages : [];
  let messages = pruneMessages(rawMessages);

  // Emulate tool calling if requested
  if (hasTools) {
    const toolPrompt = `\n\n[AVAILABLE TOOLS]\nYou have access to the following tools:\n${JSON.stringify(tools, null, 2)}\n\nIf you need to call a tool, respond ONLY with a JSON object in this format:\n{\n  "tool_calls": [\n    {\n      "id": "call_1",\n      "type": "function",\n      "name": "tool_name",\n      "arguments": { "arg": "value" }\n    }\n  ]\n}`;
    if (messages.length > 0) {
      const lastMsg = { ...messages[messages.length - 1] };
      if (typeof lastMsg.content === "string") {
        lastMsg.content += toolPrompt;
      }
      messages[messages.length - 1] = lastMsg;
    }
  }

  const payload = {
    ...body,
    model: upstreamModel,
    messages
  };
  delete payload.tools;
  delete payload.functions;
  delete payload.tool_choice;

  const url = `${ROUTER_BASE}/v1/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${ROUTER_KEY}`
  };

  const releaseLock = await acquireLock();

  try {
    const upstreamRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!upstreamRes.ok) {
      const errorText = await upstreamRes.text();
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: errorText || "Upstream Muse Web error",
          type: "server_error",
          code: "upstream_error"
        }
      }));
      return;
    }

    if (isStreaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        let text = decoder.decode(value, { stream: true });
        text = text.replace(/"model":"muse-web\/[^"]+"/g, `"model":"${requestedModel}"`);
        res.write(text);
      }
      res.end();
    } else {
      const data = await upstreamRes.json();
      data.model = requestedModel;

      if (hasTools && data.choices?.[0]?.message?.content) {
        const toolCalls = extractToolCalls(data.choices[0].message.content);
        if (toolCalls) {
          data.choices[0].message.tool_calls = toolCalls;
          data.choices[0].finish_reason = "tool_calls";
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    }
  } catch (err) {
    console.error("[Muse Bridge] Error:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: err.message || "Failed to contact upstream Muse Web",
        type: "server_error",
        code: "upstream_error"
      }
    }));
  } finally {
    releaseLock();
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "muse-bridge", version: "1.0.1" }));
    return;
  }

  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: SUPPORTED_MODELS }));
    return;
  }

  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    handleChatCompletions(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not Found", code: "not_found" } }));
});

server.listen(PORT, HOST, () => {
  console.log(`[Muse Bridge] Listening on http://${HOST}:${PORT}`);
  console.log(`[Muse Bridge] Accessible from Docker via http://host.docker.internal:${PORT}/v1`);
});
