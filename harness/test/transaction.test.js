import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";
import { ModelError } from "../src/models/adapter.js";
import { actorHolds } from "../src/knowledge/ledger.js";
import { loadCatalog } from "../src/knowledge/catalog.js";

function ok() { return { director: [directorPacket()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] }; }

test("golden turn: received -> delivered, state committed once, output rendered without markup", async () => {
  const r = makeRunner({ responses: ok() });
  try {
    const res = await r.runner.run({ text: "I keep working on the car.", eventId: "evt_1", transport: "cli" });
    assert.equal(res.turn.status, "committed");
    assert.equal(res.turn.revision_committed, 1);
    assert.doesNotMatch(res.output, /⟦/);
    assert.match(res.output, /“You remembered it.”/);
    assert.match(res.output, /\(\( <NPC_A> is waiting for an answer\. \)\)/);
    const store = r.store;
    assert.equal(store.meta().revision, 1);
    assert.equal(store.scene().clock, 1);
    assert.equal(store.scene().present.join(","), "pc_fixture,npc_a");
    const facts = store.facts();
    const asked = facts.find((f) => f.content.includes("asked <PC_ID>"));
    assert.ok(asked, "new fact created");
    assert.equal(asked.persistence, "provisional");
    assert.equal(asked.truth.authorial, "undecided");
    const env = { actors: store.actors(), catalog: loadCatalog(store) };
    assert.equal(actorHolds(facts, "npc_a", "fact_a", env), true, "observe event applied");
    assert.equal(actorHolds(facts, "npc_a", asked.id, env), true);
    assert.equal(store.mind("npc_a").intentions[0].status, "active");
    assert.equal(store.relationships().edges["npc_a>pc_fixture"].stance, "assessing");
    assert.equal(store.unresolved().items.length, 1);
    assert.equal(store.dirty().entries.length, 1);
    assert.match(store.recentPlay(), /You remembered it/);
    assert.equal(store.formLedger().history.length, 1);
    assert.ok(store.usage().calls.length >= 3, "director, novelist, editor metered");
    const d = r.runner.markDelivered(res.turn.turn_id, { transport: "cli", messageIds: ["m1"] });
    assert.equal(d.status, "delivered");
    assert.deepEqual(d.delivery.message_ids, ["m1"]);
    // Editor ran in 'scene' presentation (selected mode)
    assert.ok(res.turn.editor);
  } finally { r.cleanup(); }
});

test("duplicate event ids never create duplicate canonical turns; redelivery returns stored output", async () => {
  const r = makeRunner({ responses: ok() });
  try {
    const a = await r.runner.run({ text: "x", eventId: "evt_dup" });
    const b = await r.runner.run({ text: "x", eventId: "evt_dup" });
    assert.equal(b.reused, true);
    assert.equal(b.output, a.output);
    assert.equal(r.store.meta().revision, 1);
    assert.equal(r.fake.calls.filter((c) => c.role === "director").length, 1);
  } finally { r.cleanup(); }
});

test("model failure before commit mutates nothing and reports a failed turn", async () => {
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [new ModelError("provider down", { code: "http-503" }), new ModelError("still down", { code: "http-503" }), new ModelError("fallback down", { code: "http-503" })] } });
  try {
    const before = JSON.stringify([r.store.facts(), r.store.scene(), r.store.meta(), r.store.mind("npc_a")]);
    const res = await r.runner.run({ text: "x", eventId: "evt_fail" });
    assert.equal(res.failed, true);
    assert.equal(res.turn.status, "failed");
    assert.match(res.output, /Nothing was recorded/);
    assert.equal(JSON.stringify([r.store.facts(), r.store.scene(), r.store.meta(), r.store.mind("npc_a")]), before);
    assert.equal(r.store.dirty().entries.length, 0);
    // same event id may be retried after a failure
    r.fake.enqueue("director", directorPacket()); r.fake.enqueue("novelist", NOVELIST_PROSE); r.fake.enqueue("editor", EDITOR_OK);
    const again = await r.runner.run({ text: "x", eventId: "evt_fail" });
    assert.equal(again.turn.status, "committed");
  } finally { r.cleanup(); }
});

test("malformed Director JSON is retried once, then validation errors are fed back once; second failure fails the turn cleanly", async () => {
  const bad = directorPacket({ npc_intents: [{ npc: "npc_a", intent: "i", acting_on: ["fact_a"], emotional_register: "e", speech_acts: [], must_not_reveal: [] }], knowledge_events: [] });
  const r = makeRunner({ responses: { director: ["not json at all", bad, directorPacket()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    const res = await r.runner.run({ text: "x", eventId: "e1" });
    assert.equal(res.turn.status, "committed");
    const dcalls = r.fake.calls.filter((c) => c.role === "director");
    assert.equal(dcalls.length, 3);
    assert.match(dcalls[1].user, /previous reply was rejected/);
    assert.match(dcalls[2].user, /rejected by deterministic validation[\s\S]*not-held/);
  } finally { r.cleanup(); }
  const r2 = makeRunner({ responses: { director: [bad, bad], novelist: [NOVELIST_PROSE] } });
  try {
    const res = await r2.runner.run({ text: "x", eventId: "e2" });
    assert.equal(res.turn.status, "failed");
    assert.match(res.turn.error, /not-held/);
    assert.equal(r2.store.meta().revision, 0);
  } finally { r2.cleanup(); }
});

test("Novelist violations are bounced once with the issues; PC dialogue never reaches the player", async () => {
  const pcVoiced = "⟦say pc_fixture⟧“I know why.”⟦/say⟧ ⟦say npc_a⟧“Do you.”⟦/say⟧";
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [pcVoiced, NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.equal(res.turn.status, "committed");
    assert.doesNotMatch(res.output, /I know why/);
    assert.match(r.fake.calls.filter((c) => c.role === "novelist")[1].user, /pc-dialogue/);
  } finally { r.cleanup(); }
});

test("lock: a second concurrent turn is refused; restart abandons incomplete turns", async () => {
  const r = makeRunner({ responses: ok() });
  try {
    const lock = r.store.lock();
    assert.equal(lock.acquire("test"), true);
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.equal(res.refused, true);
    lock.release();
    // simulate a crash mid-turn: a planned turn on disk
    r.store.saveTurn({ turn_id: "campaign_fixture-000099", event_id: "crash", status: "planned", revision_base: 0, started_at: r.clock.iso(), transport: "cli", input: { text: "x" } });
    assert.deepEqual(r.runner.recoverIncomplete(), ["campaign_fixture-000099"]);
    assert.equal(r.store.turn("campaign_fixture-000099").status, "abandoned");
  } finally { r.cleanup(); }
});

test("budget cap refuses a turn before any model call", async () => {
  const r = makeRunner({ responses: ok() });
  try {
    const u = r.store.usage();
    u.totals.by_day[r.clock.iso().slice(0, 10)] = 999;
    r.store.saveUsage(u);
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.equal(res.failed, true);
    assert.match(res.output, /Budget cap reached \(per_day\)/);
    assert.equal(r.fake.calls.length, 0);
  } finally { r.cleanup(); }
});

test("committed but undelivered turns are listed for redelivery; delivery is idempotent", async () => {
  const r = makeRunner({ responses: ok() });
  try {
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.deepEqual(r.runner.undelivered().map((t) => t.turn_id), [res.turn.turn_id]);
    r.runner.markDelivered(res.turn.turn_id, { transport: "discord", messageIds: ["a"] });
    r.runner.markDelivered(res.turn.turn_id, { transport: "discord", messageIds: ["b"] });
    assert.deepEqual(r.runner.undelivered(), []);
    assert.equal(r.store.turn(res.turn.turn_id).delivery.attempts, 2);
    assert.ok(fs.existsSync(r.store.turnPath(res.turn.turn_id)));
  } finally { r.cleanup(); }
});
