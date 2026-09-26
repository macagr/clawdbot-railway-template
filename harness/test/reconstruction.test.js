import test from "node:test";
import assert from "node:assert/strict";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK, npcDecision } from "./fixtures/packets.js";

test("reconstruction: wiping specialist sessions between turns changes nothing about the next turn's inputs or commit", async () => {
  const second = directorPacket({ turn_summary: "second", npc_intents: [{ npc: "npc_a", intent: "wait", acting_on: ["fact_b", "fact_a"], emotional_register: "still", speech_acts: [{ act: "waits" }], must_not_reveal: ["fact_b"] }], fact_proposals: [], knowledge_events: [], state_deltas: { scene: { clock_advance: 1 } }, mind_deltas: [] });
  const make = () => makeRunner({ responses: { director: [directorPacket(), second], novelist: [NOVELIST_PROSE, "⟦say npc_a⟧“Well.”⟦/say⟧"], editor: [EDITOR_OK, EDITOR_OK] } });
  const a = make(), b = make();
  try {
    await a.runner.run({ text: "one", eventId: "e1" });
    await b.runner.run({ text: "one", eventId: "e1" });
    // b loses every specialist session (cache) before turn two
    b.sessions.resetAll("test wipe");
    const keysA = a.store.sessions().specialists, keysB = b.store.sessions().specialists;
    assert.notEqual(keysA.director.session_key, keysB.director.session_key);
    const ra = await a.runner.run({ text: "two", eventId: "e2" });
    const rb = await b.runner.run({ text: "two", eventId: "e2" });
    const dA = a.fake.calls.filter((c) => c.role === "director").at(-1), dB = b.fake.calls.filter((c) => c.role === "director").at(-1);
    assert.equal(dA.user, dB.user, "Director receives identical explicit context regardless of session history");
    assert.equal(ra.output, rb.output);
    assert.deepEqual(a.store.facts(), b.store.facts());
    assert.deepEqual(a.store.mind("npc_a"), b.store.mind("npc_a"));
    assert.equal(a.store.meta().revision, b.store.meta().revision);
  } finally { a.cleanup(); b.cleanup(); }
});

test("NPC decision calls are fresh: only the NPC's own mind and holdings, delta applied at commit", async () => {
  const packet = directorPacket({ npc_decision_requests: ["npc_a"] });
  const r = makeRunner({ responses: { director: [packet], npc: [npcDecision()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.equal(res.turn.status, "committed");
    const npcCall = r.fake.calls.find((c) => c.role === "npc");
    assert.match(npcCall.user, /fact_b: <GROUP_A> plans/);
    assert.doesNotMatch(npcCall.user, /Who owns <LOCATION_B>/);
    assert.equal(res.turn.packet.npc_intents[0].decision_source, "npc_call");
    assert.equal(res.turn.packet.npc_intents[0].intent, "press once, then wait");
    assert.equal(r.store.mind("npc_a").suspicions.length, 1);
    assert.ok(!("rationale" in res.turn.packet.npc_intents[0]));
    const novelistCall = r.fake.calls.find((c) => c.role === "novelist");
    assert.doesNotMatch(novelistCall.user, /private/, "rationale never reaches the Novelist");
  } finally { r.cleanup(); }
});

test("NPC decision citing unheld facts is rejected and the Director intent is kept", async () => {
  const packet = directorPacket({ npc_decision_requests: ["npc_a"] });
  const bad = npcDecision({ acting_on: ["fact_c"] });
  const r = makeRunner({ responses: { director: [packet], npc: [bad, bad], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.equal(res.turn.status, "committed");
    assert.equal(res.turn.packet.npc_intents[0].intent, "gauge whether <PC_ID> is observant");
    assert.equal(r.store.mind("npc_a").suspicions.length, 0);
  } finally { r.cleanup(); }
});
