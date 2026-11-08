// Offline verification for the codebuddy 11128 patch (PR decolua/9router#5032)
// and safe conversation headers.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const arg = process.argv[2];
let file = arg;
if (arg && statSync(arg).isDirectory()) {
  file = null;
  for (const entry of readdirSync(arg)) {
    if (!entry.endsWith(".js")) continue;
    const p = join(arg, entry);
    if (readFileSync(p, "utf8").includes('super("codebuddy-intl")')) {
      file = p;
      break;
    }
  }
  if (!file) {
    console.error(`FAIL: no chunk under ${arg} contains the codebuddy executors`);
    process.exit(1);
  }
}
file = file || "/app/.next/server/chunks/5330.js";
if (!existsSync(file)) {
  console.error(`FAIL: ${file} not found`);
  process.exit(1);
}

const src = readFileSync(file, "utf8");
const END = /return super\.parseError\(response,bodyText\);\s*\}\s*\}/;

function extract(provider, from = 0) {
  const marker = `class e extends d.L{constructor(){super("${provider}")}\nbuildHeaders(credentials`;
  const start = src.indexOf(marker, from);
  if (start < 0) throw new Error(`${provider}: patched class not found (patch not applied?)`);
  const helpers = src.lastIndexOf("const CODEBUDDY_SYSTEM_PROMPT=", start);
  if (helpers < 0) throw new Error(`${provider}: helper block not found`);
  const endMatch = END.exec(src.slice(start));
  if (!endMatch) throw new Error(`${provider}: class tail not found`);
  const end = start + endMatch.index + endMatch[0].length;
  return { code: src.slice(helpers, end), end };
}

const cn = extract("codebuddy-cn");
const intl = extract("codebuddy-intl", cn.end);

class StubBase {
  constructor(provider) {
    this.provider = provider;
    this.config = { headers: { "Content-Type": "application/json", "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1", "X-IDE-Type": "IDE", "x-requested-with": "XMLHttpRequest", "x-codebuddy-request": "1", Authorization: "Bearer tok" } };
  }
  buildHeaders(credentials) {
    return { ...this.config.headers };
  }
  transformRequest(model, body) {
    return JSON.parse(JSON.stringify(body));
  }
  parseError() {
    return { status: 500 };
  }
}

function load(extracted) {
  const factory = new Function("d", `${extracted.code}\nreturn e;`);
  return factory({ L: StubBase });
}

const Cn = load(cn);
const Intl = load(intl);

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${extra === undefined ? "" : ` -> ${JSON.stringify(extra)}`}`);
  }
}

console.log("headers (codebuddy-cn)");
const cnExec = new Cn();
const cnH = cnExec.buildHeaders({ accessToken: "tok-cn" }, true, "https://copilot.tencent.com/v2/chat/completions", "glm-5.2", {});
check("User-Agent CLI", cnH["User-Agent"] === "CLI/2.108.1 CodeBuddy/2.108.1", cnH["User-Agent"]);
check("X-App cli", cnH["X-App"] === "cli", cnH["X-App"]);
check("X-IDE-Type/Name CLI", cnH["X-IDE-Type"] === "CLI" && cnH["X-IDE-Name"] === "CLI", [cnH["X-IDE-Type"], cnH["X-IDE-Name"]]);
check("X-IDE-Version", cnH["X-IDE-Version"] === "2.108.1", cnH["X-IDE-Version"]);
check("X-Domain cn", cnH["X-Domain"] === "copilot.tencent.com", cnH["X-Domain"]);
check("X-Request-ID hex32", /^[0-9a-f]{32}$/.test(cnH["X-Request-ID"]), cnH["X-Request-ID"]);
check("X-Conversation-ID uuid", cnH["X-Conversation-ID"] === "6ba7b810-9dad-11d3-a456-426614174000", cnH["X-Conversation-ID"]);
check("X-Conversation-Request-ID uuid", cnH["X-Conversation-Request-ID"] === "6ba7b811-9dad-11d3-a456-426614174000", cnH["X-Conversation-Request-ID"]);
check("X-Conversation-Message-ID uuid", cnH["X-Conversation-Message-ID"] === "6ba7b812-9dad-11d3-a456-426614174000", cnH["X-Conversation-Message-ID"]);
check("X-Agent-Intent/Purpose", cnH["X-Agent-Intent"] === "craft" && cnH["X-Agent-Purpose"] === "conversation", [cnH["X-Agent-Intent"], cnH["X-Agent-Purpose"]]);
check("X-Stainless-Lang js", cnH["X-Stainless-Lang"] === "js", cnH["X-Stainless-Lang"]);
check("auth header preserved", cnH.Authorization === "Bearer tok", cnH.Authorization);
check("no lowercase dup keys", !("x-requested-with" in cnH) && !("x-codebuddy-request" in cnH), Object.keys(cnH));

console.log("headers (codebuddy-intl)");
const intlExec = new Intl();
const intlH = intlExec.buildHeaders({ accessToken: "tok-intl" }, true, "https://www.codebuddy.ai/v2/chat/completions", "glm-5.2", {});
check("provider intl", intlExec.provider === "codebuddy-intl", intlExec.provider);
check("X-Domain intl", intlH["X-Domain"] === "www.codebuddy.ai", intlH["X-Domain"]);
check("User-Agent CLI", intlH["User-Agent"] === "CLI/2.108.1 CodeBuddy/2.108.1", intlH["User-Agent"]);
check("X-Agent-Purpose", intlH["X-Agent-Purpose"] === "conversation", intlH["X-Agent-Purpose"]);

console.log("transformRequest (intl)");
const out = intlExec.transformRequest(
  "glm-5.2",
  {
    messages: [
      { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude.\nAlways reply in JSON." },
      { role: "developer", content: "Follow strict schema rules." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "I am running with cc_entrypoint=cli" },
    ],
  },
  true,
  {}
);
check("first message is system", out.messages[0].role === "system", out.messages[0].role);
check("leading CodeBuddy prompt", out.messages[0].content.startsWith("You are CodeBuddy Code."), out.messages[0].content.slice(0, 60));
check("caller system instruction preserved", out.messages[0].content.includes("Always reply in JSON."), out.messages[0].content);
check("developer instruction preserved", out.messages[0].content.includes("Follow strict schema rules."), out.messages[0].content);
check("Claude Code marker stripped", !out.messages[0].content.includes("You are Claude Code"), out.messages[0].content);
check("single system message", out.messages.filter((m) => m.role === "system").length === 1, out.messages.map((m) => m.role));
check("no developer role left", !out.messages.some((m) => m.role === "developer"), out.messages.map((m) => m.role));
check("user content typed blocks", JSON.stringify(out.messages[1]) === JSON.stringify({ role: "user", content: [{ type: "text", text: "hello" }] }), out.messages[1]);
check("assistant marker sanitized", out.messages[2].content.includes("[external-client-identity]") && !out.messages[2].content.includes("cc_entrypoint=cli"), out.messages[2].content);
check("stream forced", out.stream === true, out.stream);

console.log("parseError 6004");
const parsed = intlExec.parseError({ status: 400 }, JSON.stringify({ code: 6004, msg: "usage exceeds frequency limit, reset at 2026-10-22 20:21:38 UTC+8" }));
check("mapped to 429", parsed.status === 429, parsed.status);
check("reset time parsed", parsed.resetsAtMs === Date.parse("2026-10-22T20:21:38+08:00"), parsed.resetsAtMs);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
