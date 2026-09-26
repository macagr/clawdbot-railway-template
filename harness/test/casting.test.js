import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";
import { loadCastingConfig, castActor, chooseAxes, axisUsage } from "../src/casting/casting.js";
import { resolveVoiceCard } from "../src/voices/voices.js";

test("casting chooses least-used axis values, honours constraints and archetypes, and yields unique ids", () => {
  const r = makeRunner();
  try {
    const cfg = loadCastingConfig(r.store);
    let actors = r.store.actors();
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      const c = castActor(cfg, actors, { ref: `new:x${i}`, role: "clerk", groups: [{ group: "group_a", role: "runner" }], constraints: { age_band: "old", archetype: "functionary" } }, { rng: () => 0.1 });
      assert.equal(c.actor.axes.age_band, "old");
      assert.equal(c.actor.axes.register, "formal");
      assert.ok(!seen.has(c.actor.id), `duplicate id ${c.actor.id}`);
      seen.add(c.actor.id);
      assert.ok(cfg.names.pools.pool_a.some((n) => c.actor.display_name.startsWith(n)), "group constraint selects pool_a");
      assert.equal(c.card.style_only, true);
      assert.equal(c.mind.actor, c.actor.id);
      assert.equal(c.craft.non_evidential, true);
      actors = { actors: { ...actors.actors, [c.actor.id]: c.actor } };
    }
    const usage = axisUsage(actors, cfg.axes);
    const rhythmCounts = Object.values(usage.rhythm);
    assert.ok(Math.max(...rhythmCounts) - Math.min(...rhythmCounts) <= 1, "spread across values");
    assert.deepEqual(Object.keys(chooseAxes(cfg, actors, { rng: () => 0.9 })).sort(), Object.keys(cfg.axes).sort());
  } finally { r.cleanup(); }
});

test("casting through a turn: actor, generated card, mind and craft exist only after commit", async () => {
  const p = directorPacket({
    scene: { location: "location_a", present: ["pc_fixture", "npc_a", "new:clerk"], beats: ["a clerk appears"] },
    state_deltas: { scene: { clock_advance: 1 }, actors: [{ op: "cast", casting_request: { ref: "new:clerk", role: "a clerk at the counter", returning: true, constraints: { age_band: "young" } } }] },
    knowledge_events: [], fact_proposals: [], mind_deltas: [],
  });
  const castingFields = { rhythm: "halting", examples: ["“Next, please. No, you.”"], does_not_sound_like: ["<NPC_A>"] };
  const failing = makeRunner({ responses: { director: [p], casting: [castingFields], novelist: [new Error("novelist down"), new Error("down"), new Error("down")] } });
  try {
    const res = await failing.runner.run({ text: "x", eventId: "e" });
    assert.equal(res.turn.status, "failed");
    assert.equal(Object.keys(failing.store.actors().actors).length, 4, "no actor added on failure");
    assert.ok(!fs.existsSync(`${failing.store.stateRoot}/voices`) || fs.readdirSync(`${failing.store.stateRoot}/voices`).length === 0);
  } finally { failing.cleanup(); }
  const r = makeRunner({ responses: { director: [p], casting: [castingFields], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.equal(res.turn.status, "committed");
    const actors = r.store.actors().actors;
    const cast = Object.values(actors).find((a) => a.generated);
    assert.ok(cast);
    assert.equal(cast.tier, "minor");
    assert.equal(cast.axes.age_band, "young");
    assert.ok(r.store.scene().present.includes(cast.id), "new: ref mapped to the real id");
    const card = resolveVoiceCard(r.store, cast.id);
    assert.equal(card.rhythm, "halting");
    assert.equal(card.style_only, true);
    assert.ok(r.store.mind(cast.id));
    assert.equal(r.store.craft(`npc:${cast.id}`).non_evidential, true);
  } finally { r.cleanup(); }
});
