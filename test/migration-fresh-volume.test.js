import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Evaluate the real hasMeaningfulState + decideMigration against temp directories.
const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

function getGate() {
  const owned = src.match(/const WRAPPER_OWNED_STATE_ENTRIES = new Set\(\[[^\]]*\]\);/);
  const has = src.match(/function hasMeaningfulState\(stateDir\) \{[\s\S]*?\n\}/);
  const decide = src.match(/function decideMigration\(\{ current, recorded, hasState \}\) \{[\s\S]*?\n\}/);
  assert.ok(owned && has && decide, "gate helpers not found");
  // eslint-disable-next-line no-new-func
  return new Function("fs", "path", `${owned[0]}\n${has[0]}\n${decide[0]}\nreturn { hasMeaningfulState, decideMigration };`)(fs, path);
}

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-"));
}

const CURRENT = "2026.9.5";

test("fresh volume first boot: empty state dir -> fresh (no migration, marker initialized)", () => {
  const { hasMeaningfulState, decideMigration } = getGate();
  const dir = tmpState();
  assert.equal(hasMeaningfulState(dir), false);
  assert.equal(decideMigration({ current: CURRENT, recorded: null, hasState: false }), "fresh");
});

test("fresh volume: wrapper-owned files and empty dirs do not count as state", () => {
  const { hasMeaningfulState, decideMigration } = getGate();
  const dir = tmpState();
  // What the wrapper itself creates before the gate runs on a brand-new volume.
  fs.mkdirSync(path.join(dir, "credentials"));
  fs.mkdirSync(path.join(dir, "logs"));
  fs.writeFileSync(path.join(dir, "gateway.token"), "a".repeat(64));
  assert.equal(hasMeaningfulState(dir), false);
  assert.equal(decideMigration({ current: CURRENT, recorded: null, hasState: hasMeaningfulState(dir) }), "fresh");
});

test("missing state dir is fresh", () => {
  const { hasMeaningfulState } = getGate();
  assert.equal(hasMeaningfulState(path.join(tmpState(), "does-not-exist")), false);
});

test("existing install without marker (e.g. 2026.3.8 volume) -> migrate", () => {
  const { hasMeaningfulState, decideMigration } = getGate();
  const dir = tmpState();
  fs.writeFileSync(path.join(dir, "openclaw.json"), "{}");
  assert.equal(hasMeaningfulState(dir), true);
  assert.equal(decideMigration({ current: CURRENT, recorded: null, hasState: true }), "migrate");
});

test("reset-setup leftovers without marker (no config, but credentials/db present) -> migrate", () => {
  const { hasMeaningfulState, decideMigration } = getGate();
  for (const make of [
    (d) => fs.writeFileSync(path.join(d, "credentials", "x.json"), "{}", { flag: "w" }),
    (d) => fs.writeFileSync(path.join(d, "state.db"), ""),
    (d) => fs.writeFileSync(path.join(d, "openclaw.json.bak-2026"), "{}"),
    (d) => fs.writeFileSync(path.join(d, ".env"), "X=1"),
    (d) => { fs.mkdirSync(path.join(d, "sessions")); fs.writeFileSync(path.join(d, "sessions", "s.json"), "{}"); },
  ]) {
    const dir = tmpState();
    fs.mkdirSync(path.join(dir, "credentials"));
    make(dir);
    assert.equal(hasMeaningfulState(dir), true, `expected meaningful state in ${fs.readdirSync(dir)}`);
    assert.equal(decideMigration({ current: CURRENT, recorded: null, hasState: true }), "migrate");
  }
});

test("marker differs from running version -> migrate, regardless of state contents", () => {
  const { decideMigration } = getGate();
  assert.equal(decideMigration({ current: CURRENT, recorded: "2026.3.8", hasState: true }), "migrate");
  assert.equal(decideMigration({ current: CURRENT, recorded: "2026.3.8", hasState: false }), "migrate");
});

test("marker matches running version -> ok", () => {
  const { decideMigration } = getGate();
  assert.equal(decideMigration({ current: CURRENT, recorded: CURRENT, hasState: true }), "ok");
  assert.equal(decideMigration({ current: CURRENT, recorded: CURRENT, hasState: false }), "ok");
});

test("checkMigrationGate initializes the marker only in the fresh case", () => {
  const idx = src.indexOf("async function checkMigrationGate");
  const window = src.slice(idx, idx + 1500);
  assert.match(window, /decision === "fresh"[\s\S]*writeVersionMarker\(current\)/);
  // The migrate branch must not write the marker.
  const migrateBranch = window.slice(window.indexOf("} else {"));
  assert.doesNotMatch(migrateBranch, /writeVersionMarker/);
});

test("onboarding is blocked while a migration is pending", () => {
  const idx = src.indexOf('app.post("/setup/api/run"');
  const window = src.slice(idx, idx + 900);
  assert.match(window, /if \(migrationRequired\)[\s\S]*respondJson\(409/);
});
