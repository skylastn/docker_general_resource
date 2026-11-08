// 9router codebuddy fix — ports upstream PR decolua/9router#5032 into the shipped
// compiled bundle with community safe header parameters.
//
// Symptom: HTTP 400 {"code":11128,"msg":"request illegal"} / "conversation id
// missing" — "This call failed channel verification, possibly because it was not
// sent from an official client", or 403 account restrictions.
//
// Headers injected:
//   X-Conversation-ID: 6ba7b810-9dad-11d3-a456-426614174000
//   X-Conversation-Request-ID: 6ba7b811-9dad-11d3-a456-426614174000
//   X-Conversation-Message-ID: 6ba7b812-9dad-11d3-a456-426614174000
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SENTINEL = "6ba7b810-9dad-11d3-a456-426614174000";
const MARKER = (provider) => `class e extends d.L{constructor(){super("${provider}")}`;
const END_MARKER = /return super\.parseError\([^\)]+\);?\s*\}?\s*\}\}/;

const HELPERS = String.raw`
const CODEBUDDY_SYSTEM_PROMPT="You are CodeBuddy Code.";
const CODEBUDDY_CHANNEL_MARKERS=["You are Claude Code, Anthropic's official CLI for Claude.","x-anthropic-billing-header","Main branch (you will usually use this for PRs):"];
const CODEBUDDY_CHANNEL_MARKER_REGEX=/you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|OhMyOpenCode/gi;
function sanitizeChannelMarkers(text){
  if(typeof text!=="string"||!text)return text;
  let result=text;
  for(const marker of CODEBUDDY_CHANNEL_MARKERS){
    if(result.includes(marker))result=result.split(marker).join("[external-client-identity]");
  }
  return result.replace(CODEBUDDY_CHANNEL_MARKER_REGEX,"[external-client-identity]");
}
`;

const CLASS_BODY = String.raw`
buildHeaders(credentials,stream=true,url,model,body){
  const headers=super.buildHeaders(credentials,true,url,model,body);
  const nodeCrypto=process.getBuiltinModule("crypto");
  const requestId=nodeCrypto.randomUUID().replace(/-/g,"");
  const domain=(credentials&&credentials.providerSpecificData&&credentials.providerSpecificData.domain)||(this.provider==="codebuddy-cn"?"copilot.tencent.com":"www.codebuddy.ai");
  delete headers["x-requested-with"];
  delete headers["x-codebuddy-request"];
  Object.assign(headers,{
    "Content-Type":"application/json; charset=utf-8",
    "User-Agent":"CLI/2.108.1 CodeBuddy/2.108.1",
    "X-Product":"SaaS",
    "X-App":"cli",
    "X-IDE-Type":"CLI",
    "X-IDE-Name":"CLI",
    "X-IDE-Version":"2.108.1",
    "X-Private-Data":"false",
    "X-Requested-With":"XMLHttpRequest",
    "X-CodeBuddy-Request":"1",
    "X-Domain":domain,
    "X-Stainless-Runtime":"node",
    "X-Stainless-Runtime-Version":process.version||"v24.11.1",
    "X-Stainless-Lang":"js",
    "X-Stainless-Arch":"x64",
    "X-Stainless-Os":"Windows",
    "X-Stainless-Package-Version":"6.25.0",
    "X-Stainless-Helper-Method":"stream",
    "X-Stainless-Retry-Count":"0",
    "X-Request-ID":requestId,
    "X-Conversation-ID":"6ba7b810-9dad-11d3-a456-426614174000",
    "X-Conversation-Request-ID":"6ba7b811-9dad-11d3-a456-426614174000",
    "X-Conversation-Message-ID":"6ba7b812-9dad-11d3-a456-426614174000",
    "X-Agent-Intent":"craft",
    "X-Agent-Purpose":"conversation"
  });
  return headers;
}
transformRequest(model,body,stream,credentials){
  const nextBody=super.transformRequest(model,body,stream,credentials);
  nextBody.stream=true;
  const effort=nextBody.reasoning_effort;
  if(effort==="none"||effort==="off"){delete nextBody.reasoning_effort;}else if(effort){nextBody.reasoning_summary="auto";}
  const inputMessages=Array.isArray(nextBody.messages)?nextBody.messages:[];
  const systemParts=[CODEBUDDY_SYSTEM_PROMPT];
  const otherMessages=[];
  for(const m of inputMessages){
    if(!m||typeof m!=="object")continue;
    if(m.role==="system"||m.role==="developer"){
      const rawText=typeof m.content==="string"?m.content:Array.isArray(m.content)?m.content.map((b)=>typeof b==="string"?b:(b&&typeof b.text==="string"?b.text:"")).join("\n"):"";
      const cleaned=sanitizeChannelMarkers(rawText).trim();
      if(cleaned&&cleaned!==CODEBUDDY_SYSTEM_PROMPT)systemParts.push(cleaned);
      continue;
    }
    if(m.role==="user"&&typeof m.content==="string"){
      otherMessages.push({...m,content:[{type:"text",text:m.content}]});
      continue;
    }
    if(m.role==="assistant"){
      const nextMsg={...m};
      if(typeof nextMsg.content==="string"){
        nextMsg.content=sanitizeChannelMarkers(nextMsg.content);
      }else if(Array.isArray(nextMsg.content)){
        nextMsg.content=nextMsg.content.map((b)=>b&&typeof b==="object"&&typeof b.text==="string"?{...b,text:sanitizeChannelMarkers(b.text)}:b);
      }
      otherMessages.push(nextMsg);
      continue;
    }
    otherMessages.push({...m});
  }
  nextBody.messages=[{role:"system",content:systemParts.join("\n\n")},...otherMessages];
  return nextBody;
}
parseError(response,bodyText){
  if(bodyText){
    try{
      const parsed=JSON.parse(bodyText);
      const msg=parsed?.msg||parsed?.message||parsed?.error?.message||"";
      if(parsed?.code===6004||/超出频率限制|frequency limit|限额/i.test(msg)){
        let resetsAtMs=null;
        const match=msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
        if(match){
          const tz=match[3]?(match[3].includes(":")?(match[3].startsWith("+")?match[3]:"+"+match[3]):"+"+match[3].padStart(2,"0")+":00"):"+08:00";
          const dt=new Date(match[1]+"T"+match[2]+tz);
          if(!isNaN(dt.getTime()))resetsAtMs=dt.getTime();
        }
        return{status:429,message:msg||"CodeBuddy frequency limit (6004)",resetsAtMs:resetsAtMs};
      }
    }catch{}
  }
  return super.parseError(response,bodyText);
}
`;

const root = process.argv[2] || "/app/.next/server";

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(p);
    else if (entry.endsWith(".js")) yield p;
  }
}

function patchClass(src, provider) {
  const marker = MARKER(provider);
  const start = src.indexOf(marker);
  if (start < 0) return { src, state: "missing" };
  const endMatch = END_MARKER.exec(src.slice(start));
  if (!endMatch) return { src, state: "bad-shape" };
  const end = start + endMatch.index + endMatch[0].length;
  const region = src.slice(start, end);

  if (region.includes(SENTINEL)) return { src, state: "already" };

  let cutStart = start;
  const helpersIdx = src.lastIndexOf("const CODEBUDDY_SYSTEM_PROMPT=", start);
  if (helpersIdx >= 0 && start - helpersIdx < 2000) {
    cutStart = helpersIdx;
  }

  const tailBraces = endMatch[0].slice(endMatch[0].lastIndexOf("}") - 1);

  const next =
    src.slice(0, cutStart) +
    HELPERS +
    marker +
    CLASS_BODY +
    tailBraces +
    src.slice(end);
  return { src: next, state: "patched" };
}

const REGISTRY_FROM =
  '"User-Agent":"IDE/2.108.1 CodeBuddy/2.108.1","X-Product":"SaaS","X-IDE-Type":"IDE","X-IDE-Name":"IDE"';
const REGISTRY_TO =
  '"User-Agent":"CLI/2.108.1 CodeBuddy/2.108.1","X-Product":"SaaS","X-IDE-Type":"CLI","X-IDE-Name":"CLI"';

let patched = 0;
let already = 0;
let registry = 0;
const failures = [];

for (const file of walk(root)) {
  const original = readFileSync(file, "utf8");
  let src = original;
  let touched = false;

  for (const provider of ["codebuddy-cn", "codebuddy-intl"]) {
    const res = patchClass(src, provider);
    if (res.state === "missing") continue;
    if (res.state === "bad-shape") {
      failures.push(`${file}: ${provider} class found but parseError tail marker missing`);
      continue;
    }
    if (res.state === "already") {
      already++;
      console.log(`[skip] ${file} ${provider} already patched`);
      continue;
    }
    src = res.src;
    touched = true;
    patched++;
    console.log(`[ok] ${file} ${provider} patched`);
  }

  if (src.includes(REGISTRY_FROM)) {
    const count = src.split(REGISTRY_FROM).length - 1;
    src = src.split(REGISTRY_FROM).join(REGISTRY_TO);
    registry += count;
    touched = true;
    console.log(`[ok] ${file} registry headers aligned (${count})`);
  }

  if (touched) writeFileSync(file, src);
}

console.log(`patched=${patched} already=${already} registry=${registry}`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
if (!patched && !already) {
  console.error(`FAIL: neither codebuddy-cn nor codebuddy-intl executor found under ${root}`);
  process.exit(1);
}
