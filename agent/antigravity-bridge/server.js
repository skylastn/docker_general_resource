#!/usr/bin/env node

/**
 * Antigravity ACP Worker -> 9router OpenAI-Compatible Local Bridge Service
 *
 * Exposes:
 *   POST /v1/chat/completions
 *   GET  /v1/models
 *   GET  /health
 */

const http = require("node:http");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const PORT = parseInt(process.env.PORT || "8089", 10);
const HOST = "0.0.0.0";
const AGY_BIN = "/Users/skydeveloper/.local/bin/agy";

const SUPPORTED_MODELS = [
  "gemini-4-argon-medium",
  "gemini-4-argon-high",
  "gemini-4-argon-low",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-high",
  "gpt-oss-120b-medium"
];

function resolveModelId(input) {
  if (!input) return "gemini-3.8-flash-medium";
  let m = input.toLowerCase().replace(/^(antigravity\/|agy\/)+/g, "");
  if (SUPPORTED_MODELS.includes(m)) return m;
  if (m.includes("opus")) return "claude-opus-5-5-medium";
  if (m.includes("sonnet")) return "claude-sonnet-5-5-medium";
  if (m.includes("argon")) return "gemini-4-argon-medium";
  if (m.includes("flash")) return "gemini-3.8-flash-medium";
  if (m.includes("gpt")) return "gpt-oss-120b-medium";
  return "gemini-3.8-flash-medium";
}

class AcpWorker {
  constructor() {
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.pendingRequests = new Map();
    this.activeStreams = new Map();
    this.reqId = 1;
    this.isReady = false;
    this.startPromise = null;
  }

  ensureReady() {
    if (this.isReady && this.child && !this.child.killed) {
      return Promise.resolve();
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      this.child = spawn(AGY_BIN, ["acp", "--dangerously-skip-permissions", "--stdio"]);

      this.child.stdout.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (true) {
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) break;
          const headerStr = this.buffer.slice(0, headerEnd).toString("utf8");
          const match = headerStr.match(/Content-Length:\s*(\d+)/i);
          if (!match) break;
          const len = parseInt(match[1], 10);
          const bodyStart = headerEnd + 4;
          if (this.buffer.length < bodyStart + len) break;
          const body = JSON.parse(this.buffer.slice(bodyStart, bodyStart + len).toString("utf8"));
          this.buffer = this.buffer.slice(bodyStart + len);
          this.handleAcpMessage(body);
        }
      });

      this.child.stderr.on("data", () => {});
      this.child.on("close", () => {
        this.isReady = false;
        this.child = null;
      });

      this.send({
        jsonrpc: "2.0",
        id: this.reqId++,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} }
      }).then(() => {
        this.isReady = true;
        resolve();
      }).catch(reject);
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  send(msg) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error("ACP child not running"));
      const id = msg.id;
      this.pendingRequests.set(id, { resolve, reject });
      const str = JSON.stringify(msg);
      this.child.stdin.write(`Content-Length: ${Buffer.byteLength(str)}\r\n\r\n${str}`);
    });
  }

  handleAcpMessage(body) {
    if (body.id && this.pendingRequests.has(body.id)) {
      const { resolve, reject } = this.pendingRequests.get(body.id);
      this.pendingRequests.delete(body.id);
      if (body.error) reject(new Error(body.error.message || JSON.stringify(body.error)));
      else resolve(body.result);
      return;
    }

    if (body.method === "session/update") {
      const sessionId = body.params?.sessionId;
      const update = body.params?.update;
      const handler = this.activeStreams.get(sessionId);
      if (handler) {
        handler(update);
      }
    }
  }

  async runPrompt(sessionId, promptText, onUpdate) {
    if (onUpdate) {
      this.activeStreams.set(sessionId, onUpdate);
    }
    try {
      const res = await this.send({
        jsonrpc: "2.0",
        id: this.reqId++,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: promptText }]
        }
      });
      return res;
    } finally {
      this.activeStreams.delete(sessionId);
    }
  }
}

const worker = new AcpWorker();

async function handleChatCompletion(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON in request body" } }));
    return;
  }

  const model = resolveModelId(payload.model);
  const stream = Boolean(payload.stream);
  const messages = payload.messages || [];

  let prompt = "";
  for (const m of messages) {
    const role = (m.role || "user").toUpperCase();
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    prompt += `${role}: ${content}\n\n`;
  }
  prompt = prompt.trim() || "Halo";

  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);

  try {
    await worker.ensureReady();
  } catch (err) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Antigravity ACP unavailable: " + err.message } }));
    return;
  }

  let session;
  try {
    session = await worker.send({
      jsonrpc: "2.0",
      id: worker.reqId++,
      method: "session/new",
      params: { cwd: "/tmp", mcpServers: [] }
    });
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Failed creating session: " + err.message } }));
    return;
  }

  const sessionId = session.sessionId;

  // Set Model
  try {
    await worker.send({
      jsonrpc: "2.0",
      id: worker.reqId++,
      method: "session/set_config_option",
      params: { sessionId, configId: "model", value: model }
    });
  } catch (e) {}

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    res.write(`data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
    })}\n\n`);

    try {
      await worker.runPrompt(sessionId, prompt, (update) => {
        if (update?.sessionUpdate === "agent_message_chunk") {
          const text = update.content?.text;
          if (text) {
            res.write(`data: ${JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
            })}\n\n`);
          }
        }
      });
    } catch (e) {}

    res.write(`data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();

  } else {
    let accumulated = "";
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    try {
      const promptRes = await worker.runPrompt(sessionId, prompt, (update) => {
        if (update?.sessionUpdate === "agent_message_chunk") {
          const text = update.content?.text;
          if (text) accumulated += text;
        }
      });
      if (promptRes?.usage) {
        usage = promptRes.usage;
      }
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message } }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: completionId,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: accumulated.trim() },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: usage.inputTokens || 0,
        completion_tokens: usage.outputTokens || 0,
        total_tokens: usage.totalTokens || 0
      }
    }));
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/health" || pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", cli: AGY_BIN, workerReady: worker.isReady }));
    return;
  }

  if (pathname === "/v1/models" || pathname === "/models") {
    const list = SUPPORTED_MODELS.map(m => ({
      id: m,
      object: "model",
      created: 1714500000,
      owned_by: "antigravity"
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: list }));
    return;
  }

  if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
      return;
    }
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      handleChatCompletion(req, res, body).catch(err => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: err.message } }));
        }
      });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
});

server.listen(PORT, HOST, () => {
  console.log(`[Antigravity ACP Bridge] Listening on http://${HOST}:${PORT}`);
  worker.ensureReady().catch(() => {});
});
