#!/usr/bin/env node

/**
 * ZCode -> 9router OpenAI-Compatible Local Bridge Service
 * 
 * Exposes:
 *   POST /v1/chat/completions
 *   GET  /v1/models
 *   GET  /health
 */

const http = require("node:http");
const crypto = require("node:crypto");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = "0.0.0.0";
const DB_PATH = path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const WORKSPACE_DIR = "/tmp/zcode-bridge-workspace";
try { fs.mkdirSync(WORKSPACE_DIR, { recursive: true }); } catch {}

// 1. Resolve ZCode credentials
function getDecryptedJwtToken() {
  const user = os.userInfo().username;
  const secret = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${user}`;
  const key = crypto.createHash("sha256").update(secret).digest();

  const credPath = path.join(os.homedir(), ".zcode", "v2", "credentials.json");
  if (!fs.existsSync(credPath)) {
    throw new Error(`Credentials file not found at ${credPath}`);
  }

  const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
  const rawToken = creds["zcodejwttoken"];
  if (!rawToken) {
    throw new Error("No zcodejwttoken found in credentials.json");
  }

  if (!rawToken.startsWith("enc:v1:")) {
    return rawToken;
  }

  const [ivB64, tagB64, dataB64] = rawToken.slice(7).split(".");
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const data = Buffer.from(dataB64, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

let jwtToken = "";
if (require.main === module) {
  try {
    jwtToken = getDecryptedJwtToken();
    console.log("[Bridge] ZCode JWT token decrypted successfully.");
  } catch (err) {
    console.error("[Bridge] Failed to decrypt ZCode credentials:", err.message);
    process.exit(1);
  }
}

// 2. Manage ZCode App Server process
let appProcess = null;
let reqSeq = 1;
const pendingRequests = new Map();
let isInitialized = false;

function startAppServer() {
  console.log("[Bridge] Launching zcode app-server...");
  isInitialized = false;
  pendingRequests.clear();
  
  appProcess = spawn("node", ["/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs", "app-server"], {
    env: {
      ...process.env,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json",
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(os.homedir(), ".zcode", "v2", "provider_config.json")
    }
  });

  let stdoutBuffer = "";
  appProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleServerMessage(msg);
      } catch (e) {
        console.warn("[Bridge] JSON parse err:", line.slice(0, 80));
      }
    }
  });

  appProcess.stderr.on("data", () => {});

  appProcess.on("close", (code) => {
    console.warn(`[Bridge] zcode app-server exited with code ${code}. Restarting in 2s...`);
    isInitialized = false;
    setTimeout(startAppServer, 2000);
  });

  // Handshake sequence
  setTimeout(() => {
    sendServerRequest("provider/updateAccountConfig", {
      revision: "account:manual-1",
      basedOnZCodeBuiltinRevision: "zcode-builtin:33:8f54ff88821cb0f70c213894cd6e3434966f570e74b53e061aa19778f79fab1c",
      providers: {
        "account:zai-start-plan": {
          builtinModelIds: ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"],
          access: { type: "zhipu-account", entitled: true }
        }
      },
      states: {
        "account:zai-start-plan": {
          availability: "available",
          entitled: true,
          current: true
        }
      }
    }).catch(e => console.error("[Bridge] updateAccountConfig err:", e.message));
  }, 400);
}

function sendServerRequest(method, params, timeoutMs = 15000) {
  const id = `req_${reqSeq++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`sendServerRequest timed out for ${method}`));
      }
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (res) => { clearTimeout(timer); resolve(res); },
      reject: (err) => { clearTimeout(timer); reject(err); },
      method
    });
    const payload = JSON.stringify({ id, method, params });
    if (appProcess && appProcess.stdin.writable) {
      appProcess.stdin.write(payload + "\n");
    } else {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(new Error("App server not running"));
    }
  });
}

function handleServerMessage(msg) {
  if (msg.method === "session/requestRuntimePreferences") {
    if (appProcess && appProcess.stdin.writable) {
      appProcess.stdin.write(JSON.stringify({
        id: msg.id,
        result: {
          nativeSearchEnhancementsEnabled: false,
          toolSearchMode: "off",
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true
        }
      }) + "\n");
    }
    return;
  }

  if (msg.method === "interaction/requestProviderRuntimeHeaders") {
    if (appProcess && appProcess.stdin.writable) {
      appProcess.stdin.write(JSON.stringify({
        id: msg.id,
        result: {
          headersApplied: true,
          requestAuth: { apiKey: jwtToken }
        }
      }) + "\n");
    }
    return;
  }

  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve, reject, method } = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    if (msg.error) {
      reject(msg.error);
    } else {
      resolve(msg.result);
      if (method === "provider/updateAccountConfig") {
        sendServerRequest("provider/refreshRegistry", { reason: "account-updated" })
          .then(() => {
            console.log("[Bridge] App server ready!");
            isInitialized = true;
          })
          .catch((e) => console.error("[Bridge] Init error:", e.message));
      }
    }
    return;
  }
}

function resolveModelId(targetModel) {
  const m = (targetModel || "").toLowerCase();
  if (m.includes("5.2")) return "GLM-5.2";
  if (m.includes("turbo")) return "GLM-5-Turbo";
  return "GLM-5.3-Flash";
}

async function handleChatCompletion(req, res, messages, model, stream) {
  if (!isInitialized) {
    const start = Date.now();
    while (!isInitialized && Date.now() - start < 8000) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (!isInitialized) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "ZCode bridge not ready yet", type: "server_error" } }));
      return;
    }
  }

  let systemPrompt = "";
  const conversationLines = [];

  for (const m of messages) {
    if (m.role === "system") {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      systemPrompt += (systemPrompt ? "\n" : "") + content;
    } else {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      conversationLines.push(`${m.role.toUpperCase()}: ${content}`);
    }
  }

  let prompt = "";
  if (systemPrompt) {
    prompt += `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n`;
  }
  if (conversationLines.length > 0) {
    prompt += conversationLines.join("\n\n");
  } else {
    prompt += "Halo";
  }

  const completionId = `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const targetModelId = resolveModelId(model);
  const sessionId = `sess_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const startTimeMs = Date.now();
  let fullText = "";
  let headersSent = false;

  try {
    // 1. Create isolated session with tools disabled
    await sendServerRequest("session/create", {
      sessionId,
      workspace: {
        workspacePath: WORKSPACE_DIR,
        workspaceKey: WORKSPACE_DIR
      },
      model: {
        providerId: "account:zai-start-plan",
        modelId: targetModelId,
        options: { reasoningLevel: "max" }
      },
      thoughtLevel: "max",
      toolAllowlist: []
    }, 10000);

    if (res.destroyed) return;

    // 2. Send prompt
    await sendServerRequest("session/send", {
      sessionId,
      content: prompt
    }, 15000);

    // 3. Poll SQLite for assistant output until step-finish
    const timeoutAt = Date.now() + 45000;
    while (Date.now() < timeoutAt) {
      if (res.destroyed) break;
      await new Promise(r => setTimeout(r, 200));
      try {
        const db = new DatabaseSync(DB_PATH, { readOnly: true });
        const msgRow = db.prepare(
          "SELECT id, data FROM message WHERE session_id = ? AND time_created >= ? AND data LIKE '%\"role\":\"assistant\"%' ORDER BY time_created DESC LIMIT 1;"
        ).get(sessionId, startTimeMs - 500);

        if (msgRow) {
          try {
            const rowData = JSON.parse(msgRow.data || "{}");
            if (rowData.error) {
              const errObj = rowData.error.data || rowData.error;
              db.close();
              throw new Error(errObj.message || "Upstream model error");
            }
          } catch (e) {
            if (e.message.includes("Upstream model error") || e.message.includes("model_request")) {
              db.close();
              throw e;
            }
          }

          const parts = db.prepare(
            "SELECT sequence, data FROM part WHERE message_id = ? ORDER BY sequence ASC;"
          ).all(msgRow.id);

          let isFinished = false;
          for (const p of parts) {
            try {
              const d = JSON.parse(p.data);
              if (d.type === "text" && d.text) {
                if (d.text.length > fullText.length) {
                  const delta = d.text.slice(fullText.length);
                  fullText = d.text;
                  if (stream) {
                    if (!headersSent && !res.headersSent) {
                      res.writeHead(200, {
                        "Content-Type": "text/event-stream; charset=utf-8",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive"
                      });
                      headersSent = true;
                    }
                    const chunk = {
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
                    };
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  }
                }
              }
              if (d.type === "step-finish") {
                isFinished = true;
              }
            } catch {}
          }
          db.close();
          if (isFinished) break;
        } else {
          db.close();
        }
      } catch (err) {
        if (err.message.includes("Upstream model error") || err.message.includes("model_request")) {
          throw err;
        }
      }
    }

    if (res.destroyed) return;

    if (!fullText) {
      throw new Error("No response generated from upstream ZCode model");
    }

    if (stream) {
      if (!headersSent && !res.headersSent) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        });
        headersSent = true;
      }
      const finalChunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
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
        model,
        choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: fullText.length, total_tokens: fullText.length }
      }));
    }
  } catch (err) {
    console.error("[Bridge] Error during completion:", err.message || err);
    if (!headersSent && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message || "Internal error", type: "server_error" } }));
    } else {
      res.end();
    }
  } finally {
    sendServerRequest("session/stop", { sessionId }).catch(() => {});
    sendServerRequest("session/close", { sessionId }).catch(() => {});
  }
}

// 3. HTTP Server
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health" || url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      ready: isInitialized
    }));
    return;
  }

  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "glm-5.3-flash", object: "model", owned_by: "zcode" },
        { id: "glm-5.3", object: "model", owned_by: "zcode" },
        { id: "GLM-5.3-Flash", object: "model", owned_by: "zcode" },
        { id: "GLM-5.2", object: "model", owned_by: "zcode" },
        { id: "GLM-5-Turbo", object: "model", owned_by: "zcode" }
      ]
    }));
    return;
  }

  if ((url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const json = JSON.parse(body || "{}");
        const messages = json.messages || [];
        const model = json.model || "glm-5.3-flash";
        const stream = Boolean(json.stream);
        handleChatCompletion(req, res, messages, model, stream);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `Not Found: ${url.pathname}` } }));
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[Bridge] ZCode Bridge listening on http://${HOST}:${PORT}`);
    console.log(`[Bridge] Accessible from Docker via http://host.docker.internal:${PORT}/v1/chat/completions`);
    startAppServer();
  });
}

module.exports = {
  resolveModelId
};
