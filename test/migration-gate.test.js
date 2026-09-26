import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

function getParser() {
  const m = src.match(/function parseOpenclawVersion\(text\) \{[\s\S]*?\n\}/);
  assert.ok(m, "parseOpenclawVersion not found");
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\nreturn parseOpenclawVersion;`)();
}

test("parseOpenclawVersion extracts the release version from --version output", () => {
  const parse = getParser();
  assert.equal(parse("openclaw 2026.9.5"), "2026.9.5");
  assert.equal(parse("openclaw 2026.9.5 (abc123)\n"), "2026.9.5");
  assert.equal(parse("2026.3.8"), "2026.3.8");
  assert.equal(parse("openclaw 2026.9.1-beta.1"), "2026.9.1-beta.1");
  assert.equal(parse("garbage"), null);
  assert.equal(parse(""), null);
});

test("startup never runs doctor --fix automatically", () => {
  const start = src.indexOf("app.listen(PORT, HOST");
  const end = src.indexOf('server.on("upgrade"');
  assert.ok(start >= 0 && end > start);
  const bootWindow = src.slice(start, end);
  assert.doesNotMatch(bootWindow, /"doctor"/);
  assert.match(bootWindow, /await checkMigrationGate\(\)/);
});

test("gateway refuses to start while a migration is pending", () => {
  const idx = src.indexOf("async function startGateway");
  const window = src.slice(idx, idx + 400);
  assert.match(window, /if \(migrationRequired\) throw/);
  const boot = src.slice(src.indexOf("app.listen(PORT, HOST"));
  assert.match(boot, /if \(isConfigured\(\) && !migrationRequired\)/);
});

test("doctor --fix is an explicit operator action from the debug console", () => {
  assert.match(src, /"openclaw\.doctor\.fix",/);
  assert.match(src, /"migration\.acknowledge",/);
  const idx = src.indexOf('if (cmd === "openclaw.doctor.fix")');
  assert.ok(idx >= 0);
  const window = src.slice(idx, idx + 900);
  assert.match(window, /await stopGateway\(\)/);
  assert.match(window, /runMigrationDoctorFix\(\)/);
  assert.match(window, /completeMigration\(\)/);
  assert.match(src, /\["doctor", "--fix", "--non-interactive"\]/);
});

test("version marker lives in the state dir and is written after onboarding", () => {
  assert.match(src, /path\.join\(STATE_DIR, "\.wrapper-openclaw-version"\)/);
  const idx = src.indexOf("// Optional setup (only after successful onboarding).");
  const window = src.slice(idx, idx + 500);
  assert.match(window, /writeVersionMarker\(await detectOpenclawVersion\(\)\)/);
});

test("import re-evaluates the migration gate before restarting the gateway", () => {
  const idx = src.indexOf('app.post("/setup/import"');
  const window = src.slice(idx, idx + 3000);
  assert.match(window, /await checkMigrationGate\(\)/);
});

test("proxy returns 503 with migration instructions instead of starting the gateway", () => {
  assert.match(src, /Gateway not started: migration required/);
});
