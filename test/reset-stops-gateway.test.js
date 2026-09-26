import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("reset handler stops gateway before deleting config", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const idx = src.indexOf('app.post("/setup/api/reset"');
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 900);
  // stopGateway() sends SIGTERM and waits for the child to exit before config is deleted.
  assert.match(window, /await stopGateway\(\)/);
  assert.ok(window.indexOf("await stopGateway()") < window.indexOf("fs.rmSync"));
});
