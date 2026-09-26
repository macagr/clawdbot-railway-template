import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("stopGateway waits for the child to exit and escalates to SIGKILL", () => {
  const idx = src.indexOf("async function stopGateway");
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 1200);
  assert.match(window, /proc\.once\("exit"/);
  assert.match(window, /proc\.kill\("SIGKILL"\)/);
  assert.match(window, /proc\.kill\("SIGTERM"\)/);
});

test("restartGateway awaits stopGateway instead of a fixed sleep", () => {
  const idx = src.indexOf("async function restartGateway");
  const window = src.slice(idx, idx + 200);
  assert.match(window, /await stopGateway\(\)/);
  assert.doesNotMatch(window, /sleep\(750\)/);
});

test("no code path stops the gateway with a bare kill + sleep anymore", () => {
  assert.doesNotMatch(src, /gatewayProc\.kill\("SIGTERM"\)/);
});

test("SIGTERM and SIGINT wait for the gateway to exit before the wrapper exits", () => {
  const idx = src.indexOf("async function shutdown(signal)");
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 900);
  assert.match(window, /await stopGateway\(8_000\)/);
  assert.match(src, /process\.on\("SIGTERM", \(\) => shutdown\("SIGTERM"\)\)/);
  assert.match(src, /process\.on\("SIGINT", \(\) => shutdown\("SIGINT"\)\)/);
});
