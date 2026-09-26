import test from "node:test";
import assert from "node:assert/strict";
import { tempCampaign } from "./helpers.js";
import { loadCatalog } from "../src/knowledge/catalog.js";
import {
  actorHolds, permittedView, applyKnowledgeEvent, applyResolutionEvent, newFact, unheldAmong,
  proposeCandidate, promoteCandidate, abandonCandidate, LedgerError, retractFact,
} from "../src/knowledge/ledger.js";
import { materializeKnowledgeEvent, materializeResolutionEvent, partitionByDelay, dueEvents } from "../src/knowledge/events.js";

function env(store) { return { actors: store.actors(), catalog: loadCatalog(store) }; }

test("individual holdings: actor holds only what the ledger says", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const facts = store.facts(), e = env(store);
    assert.equal(actorHolds(facts, "pc_fixture", "fact_a", e), true);
    assert.equal(actorHolds(facts, "npc_a", "fact_a", e), false);
    assert.equal(actorHolds(facts, "npc_a", "fact_b", e), true);
    assert.equal(actorHolds(facts, "pc_fixture", "fact_b", e), false, "gm_only fact with no holding");
    assert.equal(actorHolds(facts, "npc_a", "nope", e), false);
  } finally { cleanup(); }
});

test("group holdings never imply member knowledge; scope rules grant access", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const facts = store.facts(), e = env(store);
    // npc_a is an 'officer' of group_a and scope_a lists role officer -> access
    assert.equal(actorHolds(facts, "npc_a", "fact_d", e), true);
    // npc_b is not in group_a; holds its own FALSE version instead
    assert.equal(actorHolds(facts, "npc_b", "fact_d", e), true);
    const view = permittedView(facts, ["npc_b", "pc_fixture"], e);
    assert.equal(view.npc_b[0].version, "false");
    assert.match(view.npc_b[0].content, /believes the debt is real/);
    assert.equal(view.pc_fixture.some((v) => v.fact === "fact_d"), false);
    // a member without the scope role gets nothing from the group holding
    const actors = structuredClone(e.actors);
    actors.actors.npc_b.groups = [{ group: "group_a", role: "runner" }];
    const facts2 = facts.map((f) => (f.id === "fact_d" ? { ...f, holdings: f.holdings.filter((h) => h.holder.type === "group") } : f));
    assert.equal(actorHolds(facts2, "npc_b", "fact_d", { ...e, actors }), false);
  } finally { cleanup(); }
});

test("permitted view exposes no truth status and no hidden facts", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const view = permittedView(store.facts(), ["pc_fixture"], env(store));
    assert.deepEqual(view.pc_fixture.map((v) => v.fact), ["fact_a"]);
    assert.ok(!("truth" in view.pc_fixture[0]));
    assert.deepEqual(unheldAmong(store.facts(), "pc_fixture", ["fact_a", "fact_b", "fact_c"], env(store)), ["fact_b", "fact_c"]);
  } finally { cleanup(); }
});

test("knowledge events are the only way holdings change; failed or disbelieved transfers leave provenance only", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const e = env(store);
    const base = { id: "ev_1", turn: "t1", kind: "transmit", fact: "fact_a", from: { type: "actor", id: "pc_fixture" }, to: { type: "actor", id: "npc_a" }, channel: "face_to_face", delay: 0, fidelity: "accurate", evidence: "testimony", succeeded: true, believed: true, confidence: "medium" };
    let facts = applyKnowledgeEvent(store.facts(), base);
    assert.equal(actorHolds(facts, "npc_a", "fact_a", e), true);
    facts = applyKnowledgeEvent(store.facts(), { ...base, id: "ev_2", succeeded: false });
    assert.equal(actorHolds(facts, "npc_a", "fact_a", e), false);
    assert.ok(facts.find((f) => f.id === "fact_a").provenance.includes("ev_2"));
    facts = applyKnowledgeEvent(store.facts(), { ...base, id: "ev_3", believed: false });
    assert.equal(actorHolds(facts, "npc_a", "fact_a", e), false);
    // distorted transfer gives a distorted holding with the variant text
    facts = applyKnowledgeEvent(store.facts(), { ...base, id: "ev_4", fidelity: "distorted", variant: "a different marking", to: { type: "actor", id: "npc_b" } });
    const v = permittedView(facts, ["npc_b"], e).npc_b.find((x) => x.fact === "fact_a");
    assert.equal(v.version, "distorted");
    assert.equal(v.content, "a different marking");
    // a later accurate transfer upgrades; a later worse one does not downgrade
    facts = applyKnowledgeEvent(facts, { ...base, id: "ev_5", to: { type: "actor", id: "npc_b" } });
    assert.equal(permittedView(facts, ["npc_b"], e).npc_b.find((x) => x.fact === "fact_a").version, "accurate");
    facts = applyKnowledgeEvent(facts, { ...base, id: "ev_6", fidelity: "partial", confidence: "low", to: { type: "actor", id: "npc_b" } });
    assert.equal(permittedView(facts, ["npc_b"], e).npc_b.find((x) => x.fact === "fact_a").version, "accurate");
    assert.throws(() => applyKnowledgeEvent(facts, { ...base, id: "ev_7", fact: "missing" }), LedgerError);
  } finally { cleanup(); }
});

test("truth changes only via resolution events; undecided means unresolved", () => {
  const { store, cleanup } = tempCampaign();
  try {
    assert.throws(() => newFact({ id: "f_x", content: "x", turn: "t", revision: 1, truth: { status: "true", authorial: "undecided" } }), /undecided/);
    let facts = applyResolutionEvent(store.facts(), { id: "r1", turn: "t2", fact: "fact_c", to_status: "true", authorial: "decided", visibility: "gm_only", cause: "author decided" });
    const c = facts.find((f) => f.id === "fact_c");
    assert.deepEqual(c.truth, { status: "true", authorial: "decided", visibility: "gm_only" });
    assert.equal(c.holdings.length, 0, "deciding hidden truth grants nobody a holding");
    assert.throws(() => applyResolutionEvent(facts, { id: "r2", turn: "t", fact: "fact_c", to_status: "false", authorial: "undecided", visibility: "public", cause: "x" }), /undecided/);
  } finally { cleanup(); }
});

test("candidates are explicit and non-canonical; promotion emits a resolution event", () => {
  const { store, cleanup } = tempCampaign();
  try {
    let cands = proposeCandidate(store.candidates(), { id: "cand_1", fact: "fact_c", proposal: "<GROUP_A> owns it", proposed_status: "true", turn: "t1" });
    assert.equal(store.facts().find((f) => f.id === "fact_c").truth.authorial, "undecided", "proposing changes nothing");
    const { event, candidates } = promoteCandidate(cands, "cand_1", { eventId: "r_p", turn: "t3", visibility: "gm_only" });
    assert.equal(event.candidate, "cand_1");
    assert.equal(candidates[0].status, "promoted");
    const facts = applyResolutionEvent(store.facts(), event);
    assert.equal(facts.find((f) => f.id === "fact_c").truth.status, "true");
    assert.throws(() => promoteCandidate(candidates, "cand_1", { eventId: "r2", turn: "t" }), /promoted/);
    const ab = abandonCandidate(proposeCandidate([], { id: "cand_2", fact: "fact_c", proposal: "p", turn: "t" }), "cand_2", "t");
    assert.equal(ab[0].status, "abandoned");
    assert.throws(() => promoteCandidate(proposeCandidate([], { id: "cand_3", fact: "fact_c", proposal: "no status", turn: "t" }), "cand_3", { eventId: "r", turn: "t" }), /proposed status/);
  } finally { cleanup(); }
});

test("materialize events from proposals using catalog defaults; delays schedule instead of apply", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const catalog = loadCatalog(store);
    const resolve = (r) => (r.startsWith("new:") ? "fact_new" : r);
    const ev = materializeKnowledgeEvent({ kind: "transmit", fact: "fact_a", from: { type: "actor", id: "pc_fixture" }, to: { type: "actor", id: "npc_b" }, channel: "channel_rumor" }, { id: "k1", turn: "t", catalog, resolveFactRef: resolve, clock: 5 });
    assert.equal(ev.delay, 2);
    assert.equal(ev.fidelity, "distorted");
    assert.equal(ev.evidence, "hearsay");
    assert.equal(ev.confidence, "low");
    assert.equal(ev.applies_at, 7);
    const { now, later } = partitionByDelay([ev, { ...ev, id: "k2", delay: 0 }]);
    assert.equal(now.length, 1); assert.equal(later.length, 1);
    assert.deepEqual(dueEvents([ev], 6).due, []);
    assert.equal(dueEvents([ev], 7).due.length, 1);
    assert.throws(() => materializeKnowledgeEvent({ kind: "transmit", fact: "fact_a", to: { type: "actor", id: "npc_b" }, channel: "no_such" }, { id: "k", turn: "t", catalog, resolveFactRef: resolve }), /unknown channel/);
    const r = materializeResolutionEvent({ fact: "fact_c", to_status: "disputed", cause: "two witnesses disagree" }, { id: "r1", turn: "t", resolveFactRef: resolve, currentFact: store.facts()[2] });
    assert.equal(r.from_status, "unresolved");
    assert.equal(r.authorial, "decided");
    const facts = retractFact(store.facts(), "fact_a", "x");
    assert.equal(actorHolds(facts, "pc_fixture", "fact_a", { actors: store.actors(), catalog }), false);
  } finally { cleanup(); }
});
