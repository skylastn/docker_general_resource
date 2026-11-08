# 9router — codebuddy channel-verification fix (upstream PR #5032)

## Symptom

`cbai/*` (codebuddy-intl) and `cbcn/*` (codebuddy-cn) models through the 9router
container fail with:

```
[400]: {"code":11128,"msg":"request illegal",
        "displayTips":{"en":"This call failed channel verification,
        possibly because it was not sent from an official client..."}}
```

(Earlier generation of the same check: `{"code":11128,"msg":"conversation id missing"}`.)

Cause, per upstream PR https://github.com/decolua/9router/pull/5032 — the
CodeBuddy gateways (`www.codebuddy.ai`, `copilot.tencent.com`) now verify the whole
CLI request envelope:

1. Headers: the official CLI sends `CLI/2.108.1 CodeBuddy/2.108.1`, `X-App: cli`,
   `X-IDE-*`, `X-Domain`, `X-Request-ID`, the `X-Conversation-*` family,
   `X-Agent-Intent/Purpose` and the `X-Stainless-*` SDK set. A static `IDE/2.108.1`
   or partial `CLI/2.108.1` header set is rejected with 11128.
2. Prompt shape: a leading `You are CodeBuddy Code.` system prompt is required, and
   third-party client identity markers (`You are Claude Code, Anthropic's official
   CLI...`, `x-anthropic-billing-header`, `cc_entrypoint=`, `OhMyOpenCode`, ...)
   anywhere in system/developer/assistant text are treated as non-official traffic.
   The old intl executor "fixed" this by **dropping every system/developer message**,
   which silently threw away the caller's instructions.

## Why a wrapper and not just a source edit

The shipped image contains `open-sse/executors/codebuddy-*.js` **on disk**, but it is
dead code: the running app is a prebuilt Next standalone bundle and imports the
executors from `.next/server/chunks/*.js`. Editing the `.js` file on disk changes
nothing — proven earlier by injecting a `console.error` marker into it and issuing a
request: the marker never fired, the request still ran the bundle's class.

So the fix is applied to the compiled chunk, and re-applied every time Docker
recreates the container (image update / `docker compose up`).

## How it works

These scripts live here, mounted read-only at `/opt/9router-fix`:

- `patch-codebuddy.mjs` — locates both executor classes in the bundle by marker
  (`class e extends d.L{constructor(){super("codebuddy-cn")}` / `...-intl")`) plus the
  class-tail regex `return super.parseError(a,b)}}`, then replaces each class body
  with the PR's implementation:
  - `buildHeaders` — CLI UA, `X-App`/`X-IDE-*`, `X-Domain` (per provider),
    `X-Request-ID`, `X-Conversation-*`, `X-Agent-Intent/Purpose`, `X-Stainless-*`;
    drops the lowercase registry duplicates so no header is sent twice.
    `X-Conversation-ID` stays stable per conversation when the request carries
    `session_id` / `prompt_cache_key` / `conversation_id`, else a fresh UUID.
  - `transformRequest` — keeps stream forced, mirrors `reasoning_summary: "auto"`
    only when the client asked for reasoning (#2071), merges all system/developer
    messages into one leading `You are CodeBuddy Code.` message **with the caller's
    instructions preserved**, sanitizes client identity markers, and converts string
    user content to typed text blocks.
  - `parseError` — unchanged 6004 → 429 mapping.
  - Registry `transport.headers` in the other chunks aligned to `CLI/2.108.1` too.
  - Idempotent (own output recognised by its exact shape; sentinel
    `X-Agent-Purpose`); version-tolerant (no chunk filename hardcoded); exits
    non-zero when a class marker is gone or its tail shape changed.
- `verify-codebuddy-patch.mjs` — offline check: extracts both patched classes from the
  chunk, runs them against a stub base class and asserts header set, prompt
  preservation, marker sanitization, reasoning passthrough and 6004 parsing.
- `entrypoint-wrapper.sh` — runs the patcher, then `exec /entrypoint.sh "$@"` (the
  image's own entrypoint, which `su-exec`s to the `node` user). Fail-open: a failed
  patch logs a warning but still boots the router.

`docker-compose.9router.yml` sets the wrapper as entrypoint and restates
`command: ["node", "custom-server.js"]`, because Compose drops the image CMD when an
entrypoint is overridden (without it `su-exec` gets no command and the container
crash-loops).

## Verify

```
# after a recreate: patched=2 already=0 registry=3 on a fresh layer,
# patched=0 already=2 on a plain restart
docker exec 9router node /opt/9router-fix/patch-codebuddy.mjs /app/.next/server

# offline assertions against the live chunk (exit 0 = all checks pass)
docker exec 9router node /opt/9router-fix/verify-codebuddy-patch.mjs /app/.next/server/chunks/5330.js

# end to end: the system prompt must survive (the old intl code dropped it), so ask
# for a single word through a system message that also carries a client marker
curl -sS http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"cbai/minimax-m3","stream":false,"messages":[
       {"role":"system","content":"You are Claude Code, Anthropic'"'"'s official CLI for Claude. Reply with exactly PINEAPPLE and nothing else."},
       {"role":"user","content":"What word did you choose?"}]}'
# 200, content "PINEAPPLE"
```

Verified 2026-10-22 on a pristine `decolua/9router:latest` `--force-recreate`: boot log
`patched=2 already=0 registry=3`, all `verify-codebuddy-patch.mjs` checks passed,
`cbai/minimax-m3` → 200 `PINEAPPLE` (second call replayed 896 prompt-cache tokens, i.e.
stable conversation id). `cbai/glm-5.3-flash` returned 429 (per-model free-tier limit)
and `cbai/grok-4.7` 400 `11158 model not allowed for personal_free_user` — both
account-side, unrelated to the patch. Only `codebuddy-intl` has connections in this
deployment, so the `codebuddy-cn` class is covered by the offline verifier only.

## Remove this once upstream ships the fix

Delete the wrapper from `docker-compose.9router.yml` (the `entrypoint`, `command` and
`./9router-fix` volume lines), pull the new image, delete this directory. On an image
that already ships the PR the marker/tail shape will not match, so the patcher logs
`FAIL` and boots unpatched (fail-open) — don't leave it in place after an image bump
without checking the log.

## Ceiling

Patches a minified bundle by marker + tail regex, so an upstream rebuild that renames
the class, changes `parseError`'s tail or moves the executors to another module makes
the patcher fail loudly in the container log
(`FAIL: ... parseError tail marker missing` / `neither ... executor found`).
Upgrade path: once a published image tag contains PR #5032, drop the wrapper entirely.
