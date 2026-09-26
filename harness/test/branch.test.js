import test from "node:test";
import assert from "node:assert/strict";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";
import { createBranch, listBranches, discardBranch, promoteBranch, exportBranch, switchToMain, BranchError } from "../src/branch/branch.js";
import { CampaignStore } from "../src/state/store.js";
import { buildSavePacket } from "../src/persistence/save.js";

async function turn(r, i) {
  r.fake.enqueue("director", directorPacket({ fact_proposals: [{ ref: "new:f", content: `branch fact ${i}` }], knowledge_events: [], mind_deltas: [{ actor: "npc_a", suspicions_add: [{ hypothesis: `suspicion ${i}`, confidence: "low" }] }] }));
  r.fake.enqueue("novelist", NOVELIST_PROSE); r.fake.enqueue("editor", EDITOR_OK);
  return r.runner.run({ text: `t${i}`, eventId: `e${i}` });
}

test("branch: isolated provisional state; main untouched; discard requires confirmation; no leakage back", async () => {
  const r = makeRunner();
  try {
    await turn(r, 0);
    const mainRev = r.store.meta().revision;
    const mainFacts = r.store.facts().length;
    const b = createBranch(r.store, { id: "what_if", label: "alternate", at: r.clock.iso() });
    assert.equal(b.base_revision, mainRev);
    // reopen store on the branch
    const branchStore = new CampaignStore(r.dir, { clock: r.clock });
    assert.equal(branchStore.branch, "what_if");
    r.runner.store = branchStore; r.sessions.store = branchStore; r.store = branchStore;
    await turn(r, 1);
    assert.equal(branchStore.meta().revision, mainRev + 1);
    assert.equal(branchStore.facts().length, mainFacts + 1);
    assert.equal(branchStore.mind("npc_a").suspicions.length, 2);
    const main = new CampaignStore(r.dir, { clock: r.clock, branch: null });
    // explicit main view (active-branch still set, so pass branch: null via switch)
    switchToMain(r.dir);
    const mainView = new CampaignStore(r.dir, { clock: r.clock });
    assert.equal(mainView.branch, null);
    assert.equal(mainView.meta().revision, mainRev, "main revision unchanged");
    assert.equal(mainView.facts().length, mainFacts);
    assert.equal(mainView.mind("npc_a").suspicions.length, 1);
    assert.throws(() => buildSavePacket(branchStore, { at: r.clock.iso() }), /branch/);
    assert.throws(() => discardBranch(r.dir, "what_if", { confirm: "nope" }), BranchError);
    const d = discardBranch(r.dir, "what_if", { confirm: "what_if" });
    assert.equal(d.status, "discarded");
    assert.equal(listBranches(r.dir)[0].status, "discarded");
    assert.equal(mainView.facts().length, mainFacts);
    void main;
  } finally { r.cleanup(); }
});

test("branch export and promote: promote only when main has not advanced; backup kept", async () => {
  const r = makeRunner();
  try {
    await turn(r, 0);
    createBranch(r.store, { id: "b1", at: r.clock.iso() });
    const bs = new CampaignStore(r.dir, { clock: r.clock });
    r.runner.store = bs; r.sessions.store = bs; r.store = bs;
    await turn(r, 1);
    const ex = exportBranch(r.dir, "b1", { at: r.clock.iso() });
    assert.equal(ex.turns, 2);
    assert.throws(() => promoteBranch(r.dir, "b1", { confirm: "x", clock: r.clock }), /confirmation/);
    const p = promoteBranch(r.dir, "b1", { confirm: "b1", clock: r.clock });
    assert.equal(p.status, "promoted");
    const main = new CampaignStore(r.dir, { clock: r.clock });
    assert.equal(main.branch, null);
    assert.equal(main.meta().revision, 2);
    assert.equal(main.facts().length, 6);
    assert.equal(main.dirty().entries.length, 2, "branch turns are unsaved on main");
    // a second promote of a diverged branch fails
    createBranch(main, { id: "b2", at: r.clock.iso() });
    const bs2 = new CampaignStore(r.dir, { clock: r.clock });
    r.runner.store = bs2; r.sessions.store = bs2; r.store = bs2;
    await turn(r, 2);
    switchToMain(r.dir);
    const m2 = new CampaignStore(r.dir, { clock: r.clock });
    r.runner.store = m2; r.sessions.store = m2; r.store = m2;
    await turn(r, 3); // main advances
    assert.throws(() => promoteBranch(r.dir, "b2", { confirm: "b2", clock: r.clock }), /advanced/);
  } finally { r.cleanup(); }
});
