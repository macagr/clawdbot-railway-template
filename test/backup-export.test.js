import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

function getFilter() {
  const m = src.match(/function isExcludedFromBackup\(p\) \{[\s\S]*?\n\}/);
  assert.ok(m, "isExcludedFromBackup not found");
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\nreturn isExcludedFromBackup;`)();
}

test("backup export excludes log directories but keeps state and workspace", () => {
  const excluded = getFilter();
  assert.equal(excluded(".openclaw/logs"), true);
  assert.equal(excluded(".openclaw/logs/gateway.log"), true);
  assert.equal(excluded("workspace/logs/x.log"), true);
  assert.equal(excluded(".openclaw/openclaw.json"), false);
  assert.equal(excluded(".openclaw/credentials/foo.json"), false);
  assert.equal(excluded("workspace/skills/logs.md"), false);
  assert.equal(excluded(".openclaw"), false);
  assert.equal(excluded("workspace"), false);
});

test("export wires the filter into tar.c", () => {
  const idx = src.indexOf('app.get("/setup/export"');
  const window = src.slice(idx, idx + 2500);
  assert.match(window, /filter: \(p\) => !isExcludedFromBackup\(p\)/);
});

test("setup UI warns that backups contain secrets", () => {
  assert.match(src, /Backups contain secrets/);
});

test("setup output redacts config/verify output before returning it", () => {
  assert.match(src, /\[discord verify\][^\n]*\$\{redactSecrets\(get\.output\)/);
  assert.match(src, /\$\{prefix\}\$\{redactSecrets\(onboard\.output\)\}/);
});
