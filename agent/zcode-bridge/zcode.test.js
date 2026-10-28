const assert = require("node:assert/strict");
const { resolveModelId } = require("./server.js");

assert.equal(resolveModelId("glm-5.3-flash"), "GLM-5.3-Flash");
assert.equal(resolveModelId("glm-5.3"), "GLM-5.3-Flash");
assert.equal(resolveModelId("GLM-5.3"), "GLM-5.3-Flash");
assert.equal(resolveModelId("zcode/glm-5.3-flash"), "GLM-5.3-Flash");
assert.equal(resolveModelId("glm-5.2"), "GLM-5.2");
assert.equal(resolveModelId("glm-5-turbo"), "GLM-5-Turbo");
assert.equal(resolveModelId(""), "GLM-5.3-Flash");

console.log("zcode resolveModelId: OK");
