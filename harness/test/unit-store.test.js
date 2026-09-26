import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempCampaign } from "./helpers.js";
import { CampaignStore } from "../src/state/store.js";
import { writeJson } from "../src/lib/fsx.js";

test("init creates seeded state and runtime files, idempotently", () => {
  const { dir, store, cleanup } = tempCampaign();
  try {
    assert.equal(store.meta().revision, 0);
    assert.equal(store.scene().location, "location_a");
    assert.equal(store.facts().length, 4);
    assert.ok(store.mind("npc_a"));
    assert.equal(store.craft("npc:npc_a").non_evidential, true);
    // Re-init must not overwrite.
    store.commit({ "state/scene.json": { ...store.scene(), summary: "changed" } });
    const again = CampaignStore.init(dir);
    assert.equal(again.scene().summary, "changed");
  } finally { cleanup(); }
});

test("manifest defaults are applied and validated", () => {
  const { store, cleanup } = tempCampaign();
  try {
    assert.equal(store.manifest.context.recent_turns, 4);
    assert.equal(store.manifest.context.recent_prose_turns, 2);
    assert.equal(store.manifest.form.decay, 0.7);
    assert.ok(store.manifest.form.dimensions.ending.includes("silence"));
    assert.equal(store.manifest.editor.max_revisions, 1);
  } finally { cleanup(); }
});

test("commit is all-or-nothing and refuses paths outside state/runtime", () => {
  const { store, cleanup } = tempCampaign();
  try {
    assert.throws(() => store.commit({ "canon/operational.md": "x" }), /refusing/);
    store.commit({ "state/scene.json": { ...store.scene(), time: "later" }, "runtime/recent-play.md": "hello" });
    assert.equal(store.scene().time, "later");
    assert.equal(store.recentPlay(), "hello");
    assert.ok(!fs.existsSync(store.journalPath()));
  } finally { cleanup(); }
});

test("interrupted commit is rolled forward from the journal on open", () => {
  const { dir, store, cleanup } = tempCampaign();
  try {
    const journal = { at: "t", base: dir, entries: { "state/scene.json": JSON.stringify({ ...store.scene(), time: "recovered" }) } };
    writeJson(store.journalPath(), journal);
    const reopened = new CampaignStore(dir);
    assert.equal(reopened.scene().time, "recovered");
    assert.ok(!fs.existsSync(path.join(dir, "runtime", "commit-journal.json")));
  } finally { cleanup(); }
});

test("readers validate against schemas so corrupt state is reported, not silently used", () => {
  const { store, cleanup } = tempCampaign();
  try {
    writeJson(store.statePath("scene.json"), { scene_id: "x" });
    assert.throws(() => store.scene(), /scene/);
  } finally { cleanup(); }
});
