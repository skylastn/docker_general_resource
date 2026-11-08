#!/bin/sh
# Re-applies the codebuddy channel-verification fix (upstream PR decolua/9router#5032,
# HTTP 400 / code 11128 "request illegal") after every container start.
# The image ships the buggy compiled bundle and Docker recreates the writable layer
# on image update, so the patch must be re-run at boot (idempotent).
node /opt/9router-fix/patch-codebuddy.mjs /app/.next/server \
  || echo "[9router-fix] WARN: codebuddy patch failed, continuing unpatched"
exec /entrypoint.sh "$@"
