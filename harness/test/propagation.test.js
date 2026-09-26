import test from "node:test";
import assert from "node:assert/strict";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";
import { rulesPass, filterProposals } from "../src/propagation/propagation.js";
import { loadCatalog } from "../src/knowledge/catalog.js";
import { actorHolds, permittedView } from "../src/knowledge/ledger.js";
import { makeCounterIdGen } from "../src/lib/ids.js";

function env(store) { return { actors: store.actors(), catalog: loadCatalog(store) }; }

test("no implicit knowledge gain: a turn without events leaves holdings unchanged", async () => {
  const r = makeRunner({ responses: { director: [directorPacket({ knowledge_events: [], fact_proposals: [] })], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    await r.runner.run({ text: "x", eventId: "e" });
    const e = env(r.store);
    assert.equal(actorHolds(r.store.facts(), "npc_a", "fact_a", e), false, "npc_a was present but nothing was transmitted");
  } finally { r.cleanup(); }
});

test("delayed transfer applies only when the scene clock reaches applies_at", async () => {
  const p1 = directorPacket({ knowledge_events: [{ kind: "transmit", fact: "fact_a", from: { type: "actor", id: "pc_fixture" }, to: { type: "actor", id: "npc_b" }, channel: "channel_rumor" }], fact_proposals: [], mind_deltas: [] });
  const p2 = directorPacket({ knowledge_events: [], fact_proposals: [], mind_deltas: [], state_deltas: { scene: { clock_advance: 1 } } });
  const p3 = directorPacket({ knowledge_events: [], fact_proposals: [], mind_deltas: [], state_deltas: { scene: { clock_advance: 1 } } });
  const r = makeRunner({ responses: { director: [p1, p2, p3], novelist: [NOVELIST_PROSE, NOVELIST_PROSE, NOVELIST_PROSE], editor: [EDITOR_OK, EDITOR_OK, EDITOR_OK] } });
  try {
    await r.runner.run({ text: "a", eventId: "e1" });
    const e = env(r.store);
    assert.equal(r.store.pendingEvents().length, 1);
    assert.equal(actorHolds(r.store.facts(), "npc_b", "fact_a", e), false, "rumor takes 2 clock units");
    await r.runner.run({ text: "b", eventId: "e2" });
    assert.equal(actorHolds(r.store.facts(), "npc_b", "fact_a", e), false);
    await r.runner.run({ text: "c", eventId: "e3" });
    assert.equal(actorHolds(r.store.facts(), "npc_b", "fact_a", e), true);
    const v = permittedView(r.store.facts(), ["npc_b"], e).npc_b.find((x) => x.fact === "fact_a");
    assert.equal(v.version, "distorted", "rumor channel fidelity");
    assert.equal(v.confidence, "low");
    assert.equal(r.store.pendingEvents().length, 0);
  } finally { r.cleanup(); }
});

test("failed delivery and disbelief leave no holding; distortion carries a variant", async () => {
  const p = directorPacket({ fact_proposals: [], mind_deltas: [], knowledge_events: [
    { kind: "transmit", fact: "fact_a", from: { type: "actor", id: "pc_fixture" }, to: { type: "actor", id: "npc_b" }, channel: "face_to_face", succeeded: false },
    { kind: "transmit", fact: "fact_c", from: { type: "actor", id: "pc_fixture" }, to: { type: "actor", id: "npc_a" }, channel: "face_to_face", believed: false },
    { kind: "transmit", fact: "fact_a", from: { type: "actor", id: "pc_fixture" }, to: { type: "actor", id: "npc_a" }, channel: "face_to_face", fidelity: "distorted", variant: "a scratch, not a marking" },
  ] });
  const r = makeRunner({ responses: { director: [p], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    await r.runner.run({ text: "x", eventId: "e" });
    const e = env(r.store), facts = r.store.facts();
    assert.equal(actorHolds(facts, "npc_b", "fact_a", e), false);
    assert.equal(actorHolds(facts, "npc_a", "fact_c", e), false);
    const v = permittedView(facts, ["npc_a"], e).npc_a.find((x) => x.fact === "fact_a");
    assert.equal(v.content, "a scratch, not a marking");
    assert.equal(r.store.events().knowledge.length, 3, "all outcomes are recorded as events");
  } finally { r.cleanup(); }
});

test("scene-end rules pass: catalog rule sends tagged facts to a scoped group holding, never to individuals", async () => {
  const p = directorPacket({ fact_proposals: [{ ref: "new:incident", content: "an incident at <LOCATION_A>", tags: ["public_incident"] }], knowledge_events: [{ kind: "observe", fact: "new:incident", to: { type: "actor", id: "pc_fixture" }, channel: "face_to_face" }], mind_deltas: [], state_deltas: { scene: { scene_end: true, clock_advance: 1 } } });
  const r = makeRunner({ responses: { director: [p], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    await r.runner.run({ text: "x", eventId: "e" });
    const facts = r.store.facts();
    const incident = facts.find((f) => f.content.includes("incident"));
    const pending = r.store.pendingEvents();
    assert.equal(pending.length, 1, "rule delay 1 schedules it");
    assert.equal(pending[0].to.type, "group");
    assert.match(pending[0].note, /rule_public_to_group_a/);
    assert.equal(actorHolds(facts, "npc_a", incident.id, env(r.store)), false, "not yet");
    assert.notEqual(r.store.scene().scene_id, "scene_seed", "scene rolled over");
    const keys = r.store.sessions().specialists;
    assert.ok(Object.values(keys).every((k) => k.turns === 0), "specialist sessions reset at scene end");
  } finally { r.cleanup(); }
});

test("rulesPass is pure and skips targets that already hold the fact", () => {
  const r = makeRunner();
  try {
    const catalog = loadCatalog(r.store), actors = r.store.actors();
    const facts = r.store.facts();
    const ev = rulesPass({ facts, changedFactIds: ["fact_a"], catalog, actors, turnId: "t", clock: 0, idGen: makeCounterIdGen() });
    assert.equal(ev.length, 1);
    const held = facts.map((f) => (f.id === "fact_a" ? { ...f, holdings: [...f.holdings, { holder: { type: "group", id: "group_a", scope: "scope_a" }, version: "accurate", confidence: "high", evidence: "documentary", via: "x" }] } : f));
    assert.equal(rulesPass({ facts: held, changedFactIds: ["fact_a"], catalog, actors, turnId: "t", clock: 0, idGen: makeCounterIdGen() }).length, 0);
  } finally { r.cleanup(); }
});

test("model-assisted proposals are filtered: unknown channels/actors/facts and channel access are enforced", () => {
  const r = makeRunner();
  try {
    const catalog = loadCatalog(r.store), actors = r.store.actors(), facts = r.store.facts();
    const { kept, dropped } = filterProposals([
      { kind: "transmit", fact: "fact_a", from: { type: "actor", id: "npc_a" }, to: { type: "actor", id: "npc_b" }, channel: "channel_a" },
      { kind: "transmit", fact: "fact_a", from: { type: "actor", id: "npc_b" }, to: { type: "actor", id: "npc_a" }, channel: "channel_report" },
      { kind: "transmit", fact: "nope", to: { type: "actor", id: "npc_b" }, channel: "channel_a" },
      { kind: "transmit", fact: "fact_a", to: { type: "actor", id: "ghost" }, channel: "channel_a" },
      { kind: "transmit", fact: "fact_a", to: { type: "actor", id: "npc_b" }, channel: "carrier_pigeon" },
    ], { facts, catalog, actors });
    assert.equal(kept.length, 1);
    assert.deepEqual(dropped.map((d) => d.reason), ["source lacks channel access", "unknown fact", "unknown recipient", "unknown channel"]);
  } finally { r.cleanup(); }
});
