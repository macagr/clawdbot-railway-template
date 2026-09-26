import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("ws upgrade handler does not enforce Basic auth (browsers can't send headers)", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const idx = src.indexOf('server.on("upgrade"');
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 700);

  // Regression guard for issue #162: do not destroy browser websocket connections
  // due to missing Authorization: Basic.
  assert.doesNotMatch(window, /WebSocket password protection/);
  assert.doesNotMatch(window, /scheme === "Basic"/);
  assert.doesNotMatch(window, /WWW-Authenticate/);
});

test("Basic auth is scoped to /setup: no dashboard-wide Basic auth on the proxy path", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /requireDashboardAuth/);
  assert.match(src, /app\.use\(guardSetupPrefix, async \(req, res\)/);
  // The proxy handler and the setup guard are the only middleware on the catch-all.
  assert.doesNotMatch(src, /realm="OpenClaw Dashboard"/);
});

test("gateway Bearer replaces Basic/missing Authorization but keeps a client Bearer", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const m = src.match(/function gatewayAuthHeaderFor\(existing\) \{[\s\S]*?\n\}/);
  assert.ok(m);
  // eslint-disable-next-line no-new-func
  const fn = new Function("OPENCLAW_GATEWAY_TOKEN", `${m[0]}\nreturn gatewayAuthHeaderFor;`)("tok");
  assert.equal(fn(undefined), "Bearer tok");
  assert.equal(fn(""), "Bearer tok");
  assert.equal(fn("Basic dXNlcjpwdw=="), "Bearer tok");
  assert.equal(fn("Bearer mine"), "Bearer mine");
  assert.equal(fn("bearer mine"), "bearer mine");
});
