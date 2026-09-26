import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Guards for CLI/config differences between OpenClaw 2026.3.8 and 2026.9.5.
const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("CLI entry defaults to the official image launcher", () => {
  assert.match(src, /OPENCLAW_ENTRY\?\.trim\(\) \|\| "\/app\/openclaw\.mjs"/);
  assert.doesNotMatch(src, /\/openclaw\/dist\/entry\.js/);
});

test("logs uses --limit (the --tail flag was removed)", () => {
  assert.match(src, /\["logs", "--limit", String\(lines\)\]/);
  assert.doesNotMatch(src, /"--tail"/);
});

test("channel availability is probed via `plugins list --json`, not `channels add --help`", () => {
  assert.match(src, /\["plugins", "list", "--json"\]/);
  assert.doesNotMatch(src, /"channels", "add", "--help"/);
});

test("channel probe fails open (attempt config when the probe itself fails)", () => {
  const idx = src.indexOf("async function detectChannelPlugins");
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 700);
  assert.match(window, /probeFailed \|\|/);
});

test("wrapper binds dual-stack by default (Railway private networking can be IPv6-only)", () => {
  assert.match(src, /const HOST = process\.env\.HOST\?\.trim\(\) \|\| "::"/);
  assert.match(src, /app\.listen\(PORT, HOST,/);
  assert.doesNotMatch(src, /app\.listen\(PORT, "0\.0\.0\.0"/);
});

test("gateway readiness uses the unauthenticated /healthz probe", () => {
  const idx = src.indexOf("async function waitForGatewayReady");
  const window = src.slice(idx, idx + 600);
  assert.match(window, /\$\{GATEWAY_TARGET\}\/healthz/);
});

test("gateway.publicOrigin is written from OPENCLAW_PUBLIC_ORIGIN when set", () => {
  assert.match(src, /process\.env\.OPENCLAW_PUBLIC_ORIGIN/);
  assert.match(src, /\["gateway\.publicOrigin", PUBLIC_ORIGIN\]/);
});
