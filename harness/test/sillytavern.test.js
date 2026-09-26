import test from "node:test";
import assert from "node:assert/strict";
import { importSillyTavern, exportSillyTavern } from "../src/voices/sillytavern.js";
import { makeRunner } from "./runner-helpers.js";
import { resolveVoiceCard } from "../src/voices/voices.js";

test("import: V2 card becomes a style-only voice card; world content is dropped and reported", () => {
  const st = { spec: "chara_card_v2", spec_version: "2.0", data: { name: "Fixture Person", description: "Owns a shop at <LOCATION_A>. Hates <NPC_B>.", personality: "curt, watchful", scenario: "The shop is closing.", first_mes: "Hello.", mes_example: "<START>\n{{user}}: hi\n{{char}}: “What do you want.”\n<START>\n{{char}}: “No.”", tags: ["a", "b"] } };
  const { card, loss } = importSillyTavern(st);
  assert.equal(card.id, "fixture_person");
  assert.equal(card.style_only, true);
  assert.equal(card.register, "curt, watchful");
  assert.deepEqual(card.examples, ["“What do you want.”", "“No.”"]);
  assert.match(card.notes, /STYLE ONLY/);
  assert.ok(loss.some((l) => /scenario/.test(l)));
  assert.ok(loss.some((l) => /first_mes/.test(l)));
  assert.ok(loss.some((l) => /description: kept only as a style note/.test(l)));
  assert.ok(loss.some((l) => /not representable/.test(l)));
  assert.throws(() => importSillyTavern(null), /not a SillyTavern/);
});

test("export: voice card round-trips the representable fields and reports loss", () => {
  const r = makeRunner();
  try {
    const voice = resolveVoiceCard(r.store, "npc_a");
    const { card, loss } = exportSillyTavern(voice);
    assert.equal(card.spec, "chara_card_v2");
    assert.equal(card.data.name, "<NPC_A>");
    assert.match(card.data.personality, /rhythm: Short declaratives/);
    assert.match(card.data.mes_example, /\{\{char\}\}: “You remembered it\. Why\.”/);
    assert.equal(card.data.description, "");
    assert.ok(card.data.tags.includes("style-only"));
    assert.ok(loss.some((l) => /empty by design/.test(l)));
    const back = importSillyTavern(card, { id: "npc_a" });
    assert.deepEqual(back.card.examples, voice.examples);
    assert.match(back.card.register, /rhythm: Short declaratives/);
  } finally { r.cleanup(); }
});
