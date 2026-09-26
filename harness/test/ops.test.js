import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";
import { validateCampaign, reconstructCheck, exportState, importState, repairLock, scanGenericTree } from "../src/ops/tools.js";
import { HARNESS_ROOT, FIXTURE_DIR } from "./helpers.js";
import { writeJson } from "../src/lib/fsx.js";

test("validate reports corrupt state and cross-reference problems; clean campaign is ok", async () => {
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    assert.equal(validateCampaign(r.store).ok, true);
    await r.runner.run({ text: "x", eventId: "e" });
    assert.equal(validateCampaign(r.store).ok, true);
    const facts = r.store.facts();
    facts[0].holdings.push({ holder: { type: "actor", id: "ghost" }, version: "accurate", confidence: "low", evidence: "hearsay", via: "x" });
    writeJson(r.store.statePath("facts.json"), { facts });
    const v = validateCampaign(r.store);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /unknown actor ghost/.test(p)));
  } finally { r.cleanup(); }
});

test("reconstruct-check: identical Director inputs after wiping sessions; committed packets still valid", async () => {
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    await r.runner.run({ text: "x", eventId: "e" });
    const c = reconstructCheck(r.store, r.sessions);
    assert.equal(c.ok, true);
    assert.equal(c.identical, true);
    assert.ok(c.sessions_reset >= 1);
  } finally { r.cleanup(); }
});

test("export/import state round trip requires confirmation and restores turns", async () => {
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    await r.runner.run({ text: "x", eventId: "e" });
    const out = path.join(r.dir, "export.json");
    const ex = exportState(r.store, out);
    assert.equal(ex.turns, 1);
    r.store.commit({ "state/scene.json": { ...r.store.scene(), time: "changed" } });
    assert.throws(() => importState(r.store, out, { confirm: "nope" }), /confirm/);
    importState(r.store, out, { confirm: "campaign_fixture" });
    assert.notEqual(r.store.scene().time, "changed");
    assert.equal(r.store.listTurnIds().length, 1);
  } finally { r.cleanup(); }
});

test("repair-lock refuses fresh locks without --force", () => {
  const r = makeRunner();
  try {
    assert.equal(repairLock(r.store, {}).released, false);
    const lock = r.store.lock(); lock.acquire("stuck");
    assert.equal(repairLock(r.store, {}).released, false);
    assert.equal(repairLock(r.store, { force: true }).released, true);
  } finally { r.cleanup(); }
});

test("generic tree contains no campaign denylist tokens and no placeholder-free campaign names", () => {
  const roots = ["src", "prompts", "schemas", "config", "docs", "bin", "scripts"].map((d) => path.join(HARNESS_ROOT, d));
  const r = scanGenericTree(roots, path.join(FIXTURE_DIR, "denylist.txt"));
  assert.equal(r.ok, true, JSON.stringify(r.hits));
  // The scanner itself works: plant a token in a temp tree.
  const tmp = fs.mkdtempSync(path.join(path.dirname(HARNESS_ROOT), "leak-"));
  fs.writeFileSync(path.join(tmp, "x.md"), "welcome to Fixturetown");
  const bad = scanGenericTree([tmp], path.join(FIXTURE_DIR, "denylist.txt"));
  assert.equal(bad.ok, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
