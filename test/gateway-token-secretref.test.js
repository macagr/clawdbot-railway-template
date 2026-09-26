import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("gateway.auth.token is written as an env SecretRef, never the plaintext token", () => {
  assert.match(src, /const GATEWAY_TOKEN_REF = \{ source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" \}/);
  assert.match(src, /"gateway\.auth\.token", JSON\.stringify\(GATEWAY_TOKEN_REF\)/);
  assert.doesNotMatch(src, /"gateway\.auth\.token", OPENCLAW_GATEWAY_TOKEN/);
  assert.doesNotMatch(src, /"gateway\.remote\.token", OPENCLAW_GATEWAY_TOKEN/);
});

test("gateway.remote.token is removed (CLI reads OPENCLAW_GATEWAY_TOKEN from env)", () => {
  assert.match(src, /\["config", "unset", "gateway\.remote\.token"\]/);
});

test("boot only rewrites the config when the token is still plaintext", () => {
  const idx = src.indexOf("app.listen(PORT, HOST");
  const window = src.slice(idx, src.indexOf('server.on("upgrade"'));
  assert.match(window, /if \(!\(await gatewayTokenIsRef\(\)\)\)/);
  // No unconditional config writes during normal startup.
  assert.doesNotMatch(window, /runCmd\(OPENCLAW_NODE, clawArgs\(\["config", "set"/);
});

test("setup still writes gateway.trustedProxies", () => {
  assert.match(src, /"gateway\.trustedProxies", JSON\.stringify\(\["127\.0\.0\.1"\]\)/);
});
