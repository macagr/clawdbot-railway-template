import test from "node:test";
import assert from "node:assert/strict";
import { tempCampaign } from "./helpers.js";
import { applyMindDelta, renderMind, renderCraft, emptyMind } from "../src/minds/minds.js";

test("mind delta applies at once, bumps revision, and never carries holdings", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const mind = store.mind("npc_a");
    const next = applyMindDelta(mind, {
      actor: "npc_a",
      dispositions: { pc_fixture: { stance: "intrigued", trust: "medium" } },
      intentions_update: [{ id: "int_a_test_pc", status: "done" }],
      intentions_add: [{ id: "int_a_recruit", what: "sound out <PC_ID>", status: "held" }],
      suspicions_add: [{ about: "fact_a", hypothesis: "<PC_ID> is observant on purpose", confidence: "medium" }],
    }, { turn: "t5" });
    assert.equal(next.revision, 1);
    assert.equal(next.dispositions.pc_fixture.stance, "intrigued");
    assert.equal(next.intentions.find((i) => i.id === "int_a_test_pc").status, "done");
    assert.equal(next.intentions.find((i) => i.id === "int_a_recruit").since_turn, "t5");
    assert.ok(!("holdings" in next));
    assert.throws(() => applyMindDelta(mind, { actor: "npc_b" }), /actor/);
    assert.throws(() => applyMindDelta(mind, { actor: "npc_a", holdings: [] }), /unexpected property/);
  } finally { cleanup(); }
});

test("rendering separates authoritative mind from non-evidential craft", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const m = renderMind(store.mind("npc_a"));
    assert.match(m, /Intentions:/);
    assert.doesNotMatch(m, /craft|avoid/i);
    const c = renderCraft(store.craft("npc:npc_a"));
    assert.match(c, /^NON-EVIDENTIAL/);
    assert.match(c, /weather/);
    assert.equal(renderCraft(null), "");
    assert.equal(emptyMind("npc_x").revision, 0);
  } finally { cleanup(); }
});
