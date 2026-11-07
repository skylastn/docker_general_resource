#!/usr/bin/env node

/**
 * WorkBuddy AI -> 9router OpenAI-Compatible Local Bridge Service
 *
 * Exposes:
 *   POST /v1/chat/completions
 *   GET  /v1/models
 *   GET  /health
 */

const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execSync, exec } = require("node:child_process");

const PORT = parseInt(process.env.PORT || "8087", 10);
const HOST = "0.0.0.0";

function getPlatformMachineId() {
  if (process.env.CLIENT_INFO_MACHINE_ID) return process.env.CLIENT_INFO_MACHINE_ID;
  try {
    const out = execSync("ioreg -d2 -c IOPlatformExpertDevice", { encoding: "utf8" });
    const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  } catch (e) {}
  return crypto.randomUUID();
}

const WORKBUDDY_APP = "/Applications/WorkBuddy AI.app";
const ELECTRON_BIN = path.join(WORKBUDDY_APP, "Contents/MacOS/Electron");
const CODEBUDDY_CLI = path.join(
  WORKBUDDY_APP,
  "Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
);

const SUPPORTED_MODELS = [
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-sg",
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "hy4free",
  "hy4std",
  "hy4",
  "hy3",
  "default-model",
  "max-model",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "grok-4.7",
  "gemini-3.8-flash",
  "minimax-m3.1-flash",
  "kimi-k3.1-pro",
  "kimi-k3.1-pro-highspeed",
  "kimi-k3",
  "fast-model",
  "balanced-model",
  "primary-model",
  "hy4-preview"
];

function resolveModelId(modelInput) {
  if (!modelInput) return "deepseek-v4.1-flash";
  let m = modelInput.toLowerCase().replace(/^(workbuddy\/|wb\/)+/g, "");
  if (SUPPORTED_MODELS.includes(m)) return m;
  if (m.includes("hy4") && m.includes("std")) return "hy4std";
  if (m.includes("hy4")) return "hy4free";
  if (m.includes("hy3")) return "hy3";
  if (m.includes("max")) return "max-model";
  if (m.includes("default") || m === "auto") return "default-model";
  if (m.includes("deepseek")) return "deepseek-v4.1-flash";
  if (m.includes("glm") && m.includes("flash")) return "glm-5.3-flash";
  if (m.includes("glm")) return "glm-5.3";
  if (m.includes("minimax")) return "minimax-m3.1-flash";
  if (m.includes("fast")) return "fast-model";
  if (m.includes("balanced")) return "balanced-model";
  if (m.includes("primary")) return "primary-model";
  return "deepseek-v4.1-flash";
}

// 1. Discover Sidecar socket dynamically
function findSidecarSocket() {
  const tmp = os.tmpdir();
  try {
    const entries = fs.readdirSync(tmp, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && ent.name.startsWith("wb-")) {
        const subDirs = fs.readdirSync(path.join(tmp, ent.name), { withFileTypes: true });
        for (const sub of subDirs) {
          if (sub.isDirectory()) {
            const pidFile = path.join(tmp, ent.name, sub.name, "sidecar.pid");
            if (fs.existsSync(pidFile)) {
              let data;
              try {
                data = JSON.parse(fs.readFileSync(pidFile, "utf8"));
              } catch (e) {
                continue;
              }
              try {
                process.kill(data.pid, 0);
              } catch (err) {
                try { fs.unlinkSync(pidFile); } catch (e) {}
                continue;
              }
              const sockPath = path.join(tmp, ent.name, sub.name, `sidecar-${data.controlPipeUuid}.sock`);
              if (fs.existsSync(sockPath)) {
                return { socketPath: sockPath, pid: data.pid };
              }
            }
          }
        }
      }
    }
  } catch (e) {}
  return null;
}

async function ensureLiveSidecarSocket() {
  let sidecarInfo = findSidecarSocket();
  if (sidecarInfo) return sidecarInfo;

  console.log("[WorkerManager] Sidecar socket not active, auto-waking WorkBuddy AI daemon...");
  try {
    execSync('open -a "/Applications/WorkBuddy AI.app"');
  } catch (e) {}

  const hasCliclick = fs.existsSync("/opt/homebrew/bin/cliclick");
  const wakeCmd = hasCliclick
    ? `/usr/bin/osascript -e 'tell application "WorkBuddy AI" to activate' && sleep 0.4 && /opt/homebrew/bin/cliclick c:735,750 t:"ping" kp:return`
    : `/usr/bin/osascript -e 'tell application "WorkBuddy AI" to activate' -e 'delay 0.5' -e 'tell application "System Events" to keystroke "ping"' -e 'tell application "System Events" to key code 36'`;

  try {
    exec(wakeCmd, () => {});
  } catch (e) {}

  const start = Date.now();
  while (Date.now() - start < 12000) {
    await new Promise((r) => setTimeout(r, 400));
    sidecarInfo = findSidecarSocket();
    if (sidecarInfo) {
      console.log(`[WorkerManager] WorkBuddy sidecar is ready (pid=${sidecarInfo.pid})`);
      return sidecarInfo;
    }
  }

  throw new Error(
    "WorkBuddy AI sidecar socket not found after wake attempt. Please ensure WorkBuddy AI application is open and logged in."
  );
}

// 2. Call Sidecar JSON-RPC
function callSidecar(socketPath, method, params = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`Sidecar timeout calling ${method}`));
    }, timeoutMs);

    const id = Math.floor(Math.random() * 1000000);
    client.on("connect", () => {
      client.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

    client.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(timer);
            client.end();
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
            return;
          }
        } catch (e) {}
      }
    });

    client.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// 3. Worker Manager
class WorkerManager {
  constructor() {
    this.worker = null;
    this.launchPromise = null;
  }

  async ensureWorker() {
    if (this.worker && (await this.pingWorker(this.worker))) {
      return this.worker;
    }
    if (this.launchPromise) {
      return this.launchPromise;
    }
    this.launchPromise = this.spawnWorker().finally(() => {
      this.launchPromise = null;
    });
    return this.launchPromise;
  }

  async pingWorker(worker) {
    if (!worker || !worker.pid || !worker.port) return false;
    try {
      await httpPostJson(worker.port, "/health", {});
      return true;
    } catch (e) {
      return false;
    }
  }

  async spawnWorker() {
    let sidecarInfo = findSidecarSocket();
    if (!sidecarInfo) {
      sidecarInfo = await ensureLiveSidecarSocket();
    }

    const sessionId = "wb-bridge-" + crypto.randomUUID().slice(0, 8);
    console.log(`[WorkerManager] Spawning worker session via sidecar: ${sessionId}`);

    const res = await callSidecar(sidecarInfo.socketPath, "session.create", {
      sessionId,
      command: ELECTRON_BIN,
      args: [
        CODEBUDDY_CLI,
        "--serve",
        "--no-session-persistence",
        "--setting-sources",
        "user",
        "--settings",
        JSON.stringify({ sandbox: { allowUnsandboxedCommands: false } }),
        "--strict-mcp-config"
      ],
      cwd: "/tmp",
      port: 0,
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        WORKBUDDY_IS_PACKAGED: "1",
        WORKBUDDY_APP_PATH: path.join(WORKBUDDY_APP, "Contents/Resources/app.asar"),
        WORKBUDDY_CONFIG_DIR: path.join(os.homedir(), ".workbuddy-ai"),
        WORKBUDDY_DATA_FOLDER_NAME: ".workbuddy-ai",
        WORKBUDDY_USER_DATA_DIR: path.join(os.homedir(), ".workbuddy-ai", "app"),
        CODEBUDDY_CONFIG_DIR: path.join(os.homedir(), ".workbuddy-ai"),
        CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1",
        CODEBUDDY_FORCE_HEADLESS_BUNDLE: "1",
        CLIENT_INFO_MACHINE_ID: getPlatformMachineId()
      }
    });

    const acpEndpoint = res.acpEndpoint;
    const url = new URL(acpEndpoint);
    const port = parseInt(url.port, 10);
    console.log(`[WorkerManager] Worker spawned (PID=${res.pid}, port=${port})`);

    const conn = await httpPostJson(port, "/api/v1/acp/connect", {}, { "X-CodeBuddy-Request": "1" });
    const connectionId = conn.connectionId;
    await rpcPost(port, connectionId, "initialize", { protocolVersion: 1 }, 1);

    this.worker = {
      port,
      pid: res.pid,
      sessionId,
      connectionId
    };
    return this.worker;
  }
}

const workerManager = new WorkerManager();

function httpPostJson(port, path, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers
        }
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            resolve(b);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function rpcPost(port, connectionId, method, params = {}, reqId = 1) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      jsonrpc: "2.0",
      id: reqId,
      method,
      params
    });
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(data),
      "X-CodeBuddy-Request": "1",
      "acp-connection-id": connectionId
    };

    let raw = "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/v1/acp",
        method: "POST",
        headers
      },
      (res) => {
        res.on("data", (c) => (raw += c.toString()));
        res.on("end", () => {
          for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(trimmed.slice(6));
                if (parsed.result !== undefined || parsed.error !== undefined) {
                  if (parsed.error) {
                    reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                  } else {
                    resolve(parsed.result);
                  }
                  return;
                }
              } catch (e) {}
            }
          }
          resolve(raw);
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// 4. Handle Chat Completion
async function handleChatCompletion(req, res, body) {
  const reqStart = Date.now();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON in request body" } }));
    return;
  }

  const modelId = resolveModelId(payload.model);
  const stream = Boolean(payload.stream);
  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);

  const messages = payload.messages || [];
  console.log(
    `[Bridge] ▶ INCOMING [${completionId}] model=${modelId} stream=${stream} msgs=${messages.length} tools=${(payload.tools || []).length}`
  );

  let worker;
  try {
    worker = await workerManager.ensureWorker();
  } catch (err) {
    console.error(`[Bridge] Worker unavailable: ${err.message}`);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `WorkBuddy worker unavailable: ${err.message}`,
          type: "service_unavailable",
          code: "workbuddy_unavailable"
        }
      })
    );
    return;
  }

  // Format messages & trim if conversation is very long for speed
  let systemPrompt = "";
  const conversationLines = [];

  for (const m of messages) {
    if (m.role === "system") {
      const sysContent = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      systemPrompt += (systemPrompt ? "\n\n" : "") + sysContent;
    } else {
      const role = (m.role || "user").toUpperCase();
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      conversationLines.push(`${role}: ${content}`);
    }
  }

  let promptBody = "";
  if (conversationLines.length > 50) {
    const trimmed = [
      ...conversationLines.slice(0, 2),
      `\n[... ${conversationLines.length - 42} older messages omitted for speed ...]\n`,
      ...conversationLines.slice(-40)
    ];
    promptBody = trimmed.join("\n\n");
  } else {
    promptBody = conversationLines.length > 0 ? conversationLines.join("\n\n") : "Halo";
  }

  let promptText = systemPrompt ? `${systemPrompt}\n\n${promptBody}` : promptBody;
  promptText = promptText.trim() || "Halo";

  // Reuse worker connectionId & create session directly
  const connectionId = worker.connectionId;
  let sessionId;
  try {
    const sess = await rpcPost(worker.port, connectionId, "session/new", { cwd: "/tmp", mcpServers: [] }, 2);
    sessionId = sess.sessionId;
    await rpcPost(worker.port, connectionId, "session/set_mode", { sessionId, modeId: "bypassPermissions" }, 3);
    await rpcPost(worker.port, connectionId, "session/set_model", { sessionId, modelId }, 4);
  } catch (err) {
    console.error(`[Bridge] [${completionId}] Failed setting up ACP session:`, err.message);
    workerManager.worker = null;
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `ACP session error: ${err.message}` } }));
    return;
  }

  const promptReqId = 99;
  const promptData = JSON.stringify({
    jsonrpc: "2.0",
    id: promptReqId,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: promptText }]
    }
  });

  const promptHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Content-Length": Buffer.byteLength(promptData),
    "X-CodeBuddy-Request": "1",
    "acp-connection-id": connectionId
  };

  let accumulatedContent = "";
  let accumulatedThinking = "";
  let usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };

  let isFinished = false;

  const finish = () => {
    if (isFinished) return;
    isFinished = true;
    const elapsed = Date.now() - reqStart;
    console.log(
      `[Bridge] ✔ FINISHED [${completionId}] model=${modelId} elapsed=${elapsed}ms tokens=${usage.completion_tokens}`
    );

    if (stream) {
      try {
        res.write(
          `data: ${JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
      } catch (e) {}
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: completionId,
          object: "chat.completion",
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: accumulatedContent,
                ...(accumulatedThinking
                  ? { reasoning_content: accumulatedThinking }
                  : {})
              },
              finish_reason: "stop"
            }
          ],
          usage
        })
      );
    }
    if (!promptReq.destroyed) {
      promptReq.destroy();
    }
  };

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders?.();

    // Initial role chunk immediately
    res.write(
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      })}\n\n`
    );
  }

  const promptReq = http.request(
    {
      hostname: "127.0.0.1",
      port: worker.port,
      path: "/api/v1/acp",
      method: "POST",
      headers: promptHeaders
    },
    (upstreamRes) => {
      let buffer = "";

      upstreamRes.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(trimmed.slice(6));

            // Check if final prompt result arrived
            if (data.id === promptReqId && data.result !== undefined) {
              const u = data.result?._meta?.usage;
              if (u) {
                usage.prompt_tokens = u.prompt_tokens || usage.prompt_tokens;
                usage.completion_tokens = u.completion_tokens || usage.completion_tokens;
                usage.total_tokens = u.total_tokens || usage.total_tokens;
              }
              finish();
              return;
            }

            if (data.method === "session/update") {
              const update = data.params?.update;
              const updateType = update?.sessionUpdate;

              // 1. Thought chunk
              if (updateType === "agent_thought_chunk") {
                const thought = update.content?.text;
                if (thought) {
                  accumulatedThinking += thought;
                  if (stream) {
                    res.write(
                      `data: ${JSON.stringify({
                        id: completionId,
                        object: "chat.completion.chunk",
                        created,
                        model: modelId,
                        choices: [
                          {
                            index: 0,
                            delta: { reasoning_content: thought },
                            finish_reason: null
                          }
                        ]
                      })}\n\n`
                    );
                  }
                }
              }

              // 2. Message chunk
              if (updateType === "agent_message_chunk") {
                const text = update.content?.text;
                if (text) {
                  accumulatedContent += text;
                  if (stream) {
                    res.write(
                      `data: ${JSON.stringify({
                        id: completionId,
                        object: "chat.completion.chunk",
                        created,
                        model: modelId,
                        choices: [
                          {
                            index: 0,
                            delta: { content: text },
                            finish_reason: null
                          }
                        ]
                      })}\n\n`
                    );
                  }
                }
              }

              // 3. Usage update
              if (updateType === "usage_update") {
                const u = update._meta?.usage;
                if (u) {
                  usage.prompt_tokens = u.prompt_tokens || usage.prompt_tokens;
                  usage.completion_tokens = u.completion_tokens || usage.completion_tokens;
                  usage.total_tokens = u.total_tokens || usage.total_tokens;
                }
              }
            }
          } catch (e) {}
        }
      });

      upstreamRes.on("end", () => {
        finish();
      });
    }
  );

  promptReq.on("error", (err) => {
    console.error(`[Bridge] [${completionId}] Upstream prompt error:`, err);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `WorkBuddy upstream communication error: ${err.message}`,
            type: "upstream_error"
          }
        })
      );
    } else {
      finish();
    }
  });

  req.on("close", () => {
    if (!promptReq.destroyed) {
      promptReq.destroy();
    }
  });

  promptReq.write(promptData);
  promptReq.end();
}

// 5. HTTP Router
const server = http.createServer(async (req, res) => {
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

  // GET /health
  if (pathname === "/health" || pathname === "/") {
    const sidecarInfo = findSidecarSocket();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        sidecar: Boolean(sidecarInfo),
        workerReady: Boolean(workerManager.worker),
        workerPid: workerManager.worker?.pid || null,
        workerPort: workerManager.worker?.port || null
      })
    );
    return;
  }

  // GET /v1/models
  if (pathname === "/v1/models" || pathname === "/models") {
    const list = SUPPORTED_MODELS.map((m) => ({
      id: m,
      object: "model",
      created: 1714500000,
      owned_by: "workbuddy",
      permission: [],
      root: m,
      parent: null
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: list }));
    return;
  }

  // POST /v1/chat/completions
  if (
    pathname === "/v1/chat/completions" ||
    pathname === "/chat/completions"
  ) {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      handleChatCompletion(req, res, body).catch((err) => {
        console.error("[Bridge] Unhandled error:", err);
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
  console.log(`[WorkBuddy Bridge] Listening on http://${HOST}:${PORT}`);
  // Prewarm worker on boot
  workerManager.ensureWorker().catch((err) => {
    console.warn(`[WorkBuddy Bridge] Initial worker prewarm warning: ${err.message}`);
  });
});
