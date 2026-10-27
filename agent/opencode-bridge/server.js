const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PORT = 8085;
const OPENCODE_PORT = 4199;
const OPENCODE_BASE = `http://127.0.0.1:${OPENCODE_PORT}`;

let opencodeProcess = null;
let isReady = false;
let isShuttingDown = false;

// Quota tracking & circuit breaker
let lastQuotaExhaustedAt = 0;
const QUOTA_COOLDOWN_MS = 60 * 1000; // 60s cooldown before retrying upstream

const QUOTA_MESSAGE = "⚠️ [OpenCode Free]: Kuota model gratis OpenCode di upstream telah mencapai batas limit (Free usage limit reached). Silakan switch ke provider lain (misalnya ZCode: `zcode/glm-5.3-flash`) atau tunggu beberapa saat.";

// Active pending requests mapped by sessionId
const activeRequests = new Map();

const SUPPORTED_MODELS = [
  "glm-5.3-flash-free",
  "deepseek-v4.1-flash-free",
  "mimo-v2.6-flash-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3.5-super-vl-free",
  "flint-40b-free",
  "big-pickle",
  "beam-free"
];

function resolveModelId(modelInput) {
  if (!modelInput) return "glm-5.3-flash-free";
  let m = modelInput.toLowerCase().replace(/^(opencode-local\/|opencode\/|oc\/)/, "");
  if (!m.endsWith("-free") && SUPPORTED_MODELS.includes(m + "-free")) {
    m = m + "-free";
  }
  if (SUPPORTED_MODELS.includes(m)) {
    return m;
  }
  // Fallbacks
  if (m.includes("deepseek")) return "deepseek-v4.1-flash-free";
  if (m.includes("mimo")) return "mimo-v2.6-flash-free";
  if (m.includes("nemotron")) return "nemotron-3-ultra-free";
  return "glm-5.3-flash-free";
}

function notifyQuotaExhausted(reason) {
  console.warn(`[OpenCode Bridge] Quota exhausted detected: ${reason}`);
  lastQuotaExhaustedAt = Date.now();
  for (const [sId, item] of activeRequests.entries()) {
    try {
      item.abortController.abort(new Error("QUOTA_EXHAUSTED"));
    } catch {}
  }
}

// Background SSE event listener to catch session errors immediately
async function startEventListener() {
  while (!isShuttingDown) {
    try {
      const res = await fetch(`${OPENCODE_BASE}/event`);
      if (!res.ok) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        for (const line of text.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              const ev = JSON.parse(line.slice(6));
              const errorText = JSON.stringify(ev);
              if (
                errorText.includes("Free usage limit reached") ||
                errorText.includes("FreeUsageLimitError") ||
                (ev.syncEvent?.data?.error?.statusCode === 429)
              ) {
                notifyQuotaExhausted("SSE Event 429 / FreeUsageLimitError");
              }
            } catch {}
          }
        }
      }
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function startOpenCodeServer() {
  console.log(`[OpenCode Bridge] Launching opencode serve on port ${OPENCODE_PORT}...`);
  isReady = false;

  opencodeProcess = spawn(process.env.OPENCODE_BIN || "/opt/homebrew/bin/opencode", [
    "serve",
    "--port", String(OPENCODE_PORT),
    "--hostname", "127.0.0.1",
    "--print-logs",
    "--log-level", "INFO"
  ], {
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: ""
    }
  });

  opencodeProcess.stdout.on("data", (d) => {
    const text = d.toString();
    if (text.includes("opencode server listening")) {
      console.log(`[OpenCode Bridge] opencode serve is ready on 127.0.0.1:${OPENCODE_PORT}`);
      isReady = true;
      startEventListener().catch(() => {});
    }
  });

  opencodeProcess.stderr.on("data", (d) => {
    const text = d.toString();
    if (
      text.includes("Free usage limit reached") ||
      text.includes("FreeUsageLimitError")
    ) {
      notifyQuotaExhausted("Stderr FreeUsageLimitError");
    }
  });

  opencodeProcess.on("close", (code) => {
    if (isShuttingDown) return;
    console.warn(`[OpenCode Bridge] opencode serve exited with code ${code}. Restarting in 2s...`);
    isReady = false;
    setTimeout(startOpenCodeServer, 2000);
  });
}

// Check readiness
async function waitForReady(maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${OPENCODE_BASE}/global/health`);
      if (res.ok) {
        isReady = true;
        return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// Helper to send quota exhausted response to client
function sendQuotaResponse(res) {
  res.writeHead(429, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: {
      message: QUOTA_MESSAGE,
      type: "rate_limit_error",
      code: "free_usage_limit_reached"
    }
  }));
}

// Forward chat completion
async function handleChatCompletion(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
    return;
  }

  const modelId = resolveModelId(payload.model);
  const stream = Boolean(payload.stream);
  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);

  // 1. Check Circuit Breaker for Quota Exhaustion
  const elapsedSinceQuota = Date.now() - lastQuotaExhaustedAt;
  if (elapsedSinceQuota < QUOTA_COOLDOWN_MS) {
    console.log(`[OpenCode Bridge] Fast-rejecting request due to active quota cooldown (${Math.round((QUOTA_COOLDOWN_MS - elapsedSinceQuota)/1000)}s remaining)`);
    sendQuotaResponse(res, stream, completionId, created, modelId);
    return;
  }

  const ready = await waitForReady();
  if (!ready) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "OpenCode backend not ready" } }));
    return;
  }

  const messages = payload.messages || [];

  // Split system and user prompts
  let systemPrompt = "";
  const conversationLines = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemPrompt += (systemPrompt ? "\n" : "") + (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    } else {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      conversationLines.push(`${m.role.toUpperCase()}: ${content}`);
    }
  }

  const promptText = conversationLines.length > 0 ? conversationLines.join("\n\n") : "Halo";

  let sessionId = null;
  const abortController = new AbortController();

  try {
    // 1. Create temporary session
    const sRes = await fetch(`${OPENCODE_BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { id: modelId, providerID: "opencode" }
      }),
      signal: AbortSignal.timeout(6000)
    });

    if (!sRes.ok) {
      const errText = await sRes.text();
      if (errText.includes("Free usage limit reached")) {
        notifyQuotaExhausted("Session creation limit");
        sendQuotaResponse(res, stream, completionId, created, modelId);
        return;
      }
      throw new Error(`Failed to create opencode session: ${sRes.status} ${errText}`);
    }

    const sessionData = await sRes.json();
    sessionId = sessionData.id;

    // Track active request
    activeRequests.set(sessionId, { abortController, res, stream, completionId, created, modelId });

    // 2. Send message
    const msgPayload = {
      model: { providerID: "opencode", modelID: modelId },
      parts: [{ type: "text", text: promptText }]
    };
    if (systemPrompt) {
      msgPayload.system = systemPrompt;
    }

    const mRes = await fetch(`${OPENCODE_BASE}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msgPayload),
      signal: abortController.signal
    });

    if (!mRes.ok) {
      const errText = await mRes.text();
      if (errText.includes("Free usage limit reached") || mRes.status === 429) {
        notifyQuotaExhausted("Message endpoint 429");
        sendQuotaResponse(res, stream, completionId, created, modelId);
        return;
      }
      throw new Error(`Failed to send message: ${mRes.status} ${errText}`);
    }

    const resData = await mRes.json();
    const upstreamError = resData.info?.error || resData.error;
    if (upstreamError) {
      const detail = JSON.stringify(upstreamError);
      if (/FreeUsageLimitError|Free usage limit reached|rate.limit|quota|429/i.test(detail)) {
        notifyQuotaExhausted("Message response quota error");
        sendQuotaResponse(res);
        return;
      }
      throw new Error(`OpenCode upstream error: ${detail}`);
    }
    const parts = resData.parts || [];
    const textPart = parts.find(p => p.type === "text") || { text: "" };
    const replyText = textPart.text || "";

    const finishPart = parts.find(p => p.type === "step-finish");
    const tokenInfo = finishPart?.tokens || { input: 0, output: replyText.length, total: replyText.length };

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      const chunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta: { content: replyText }, finish_reason: null }]
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);

      const finalChunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: completionId,
        object: "chat.completion",
        created,
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: replyText
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: tokenInfo.input || 0,
          completion_tokens: tokenInfo.output || replyText.length,
          total_tokens: tokenInfo.total || replyText.length
        }
      }));
    }
  } catch (err) {
    const isQuotaError =
      err?.message === "QUOTA_EXHAUSTED" ||
      String(err?.message || "").includes("Free usage limit reached");

    if (isQuotaError) {
      console.warn("[OpenCode Bridge] Handling caught quota error for client");
      sendQuotaResponse(res, stream, completionId, created, modelId);
      return;
    }

    console.error("[OpenCode Bridge] Request error:", err.message);
    if (!res.headersSent) {
      const isTimeout = err.name === "TimeoutError" || String(err.message).includes("timed out");
      const status = isTimeout ? 504 : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: isTimeout
            ? "OpenCode upstream timed out. Server sibuk atau sedang throttling."
            : (err.message || "Internal error")
        }
      }));
    } else {
      res.end();
    }
  } finally {
    if (sessionId) {
      activeRequests.delete(sessionId);
      fetch(`${OPENCODE_BASE}/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
    }
  }
}

// HTTP Server
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      ready: isReady,
      quotaExhausted: (Date.now() - lastQuotaExhaustedAt < QUOTA_COOLDOWN_MS)
    }));
    return;
  }

  if (req.url === "/v1/models" || req.url === "/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: SUPPORTED_MODELS.map(id => ({
        id,
        object: "model",
        created: 1792850000,
        owned_by: "opencode-local"
      }))
    }));
    return;
  }

  if ((req.url === "/v1/chat/completions" || req.url === "/chat/completions") && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => handleChatCompletion(req, res, body));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `Not found: ${req.url}` } }));
});

startOpenCodeServer();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[OpenCode Bridge] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[OpenCode Bridge] Accessible from Docker via http://host.docker.internal:${PORT}/v1`);
});

process.on("SIGINT", () => {
  isShuttingDown = true;
  if (opencodeProcess) opencodeProcess.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  isShuttingDown = true;
  if (opencodeProcess) opencodeProcess.kill();
  process.exit(0);
});
