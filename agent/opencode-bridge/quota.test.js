const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(__dirname + "/server.js", "utf8");
const quota = source.match(/function sendQuotaResponse\(res\) \{[\s\S]*?\n\}/)[0];
const send = vm.runInNewContext(`const QUOTA_MESSAGE = "quota"; ${quota}; sendQuotaResponse`);
for (const stream of [false, true]) {
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  send(res, stream);
  assert.equal(res.status, 429);
  assert.equal(JSON.parse(res.body).error.code, "free_usage_limit_reached");
}
console.log("quota responses: OK");
