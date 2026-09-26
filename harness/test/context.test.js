import test from "node:test";
import assert from "node:assert/strict";
import { tempCampaign } from "./helpers.js";
import { loadCatalog } from "../src/knowledge/catalog.js";
import { buildDirectorContext, buildNovelistContext, buildEditorContext, buildNpcContext, filterPacketForNovelist } from "../src/context/builder.js";
import { emptyLedger } from "../src/form/pressure.js";
import { selectVoiceCards, resolveVoiceCard, renderVoiceCard } from "../src/voices/voices.js";
import { markTurn, selectExemplars } from "../src/exemplars/exemplars.js";

const PACKET = {
  turn_summary: "s", presentation: "scene",
  form: { length_band: "short", structure: "dialogue", camera: "close", tempo: "slow", ending: "question", sense: "sound" },
  scene: { location: "location_a", present: ["pc_fixture", "npc_a"], beats: ["<NPC_A> arrives"] }, perception: "<PC_ID> hears the door.",
  npc_intents: [{ npc: "npc_a", intent: "test", acting_on: ["fact_b"], emotional_register: "dry", speech_acts: [{ act: "asks about the marking", subtext: "evaluating" }], must_not_reveal: ["fact_b"] }],
  reveals_allowed: ["fact_a"], reveals_forbidden: ["fact_b", "fact_c"], stop_for_player: true,
  fact_proposals: [{ ref: "new:x", content: "secret new thing" }], mind_deltas: [{ actor: "npc_a" }], knowledge_events: [], state_deltas: { scene: { summary: "hidden" } },
};

function env(store) { return { actors: store.actors(), catalog: loadCatalog(store) }; }

test("Director context includes truth, minds, permitted views, pressure and on-demand history; logs its selection", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const ctx = buildDirectorContext(store, { input: { text: "I ask <NPC_A> who owns <LOCATION_B>." }, turnId: "t1", env: env(store), formLedger: emptyLedger() });
    assert.match(ctx.system, /campaign_fixture/);
    assert.match(ctx.user, /fact_b \[true, decided, gm_only/);
    assert.match(ctx.user, /Mind of npc_a/);
    assert.match(ctx.user, /"npc_a": \[/);
    assert.match(ctx.user, /form_pressure/);
    assert.match(ctx.user, /canon\/history\/older\.md/, "history matched on <LOCATION_B> keyword");
    assert.ok(ctx.selection.facts.includes("fact_b"));
    assert.ok(ctx.selection.involved.includes("npc_a"), "mentioned by display name");
    assert.doesNotMatch(ctx.user, /weather/, "director does not receive NPC craft notes");
  } finally { cleanup(); }
});

test("Novelist packet filter strips authority fields and gives forbidden reveals as labels only", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const f = filterPacketForNovelist(PACKET, { facts: store.facts(), actors: store.actors() });
    for (const k of ["fact_proposals", "mind_deltas", "knowledge_events", "state_deltas"]) assert.ok(!(k in f), k);
    assert.ok(!("acting_on" in f.npc_intents[0]));
    assert.deepEqual(f.reveals_allowed, [store.facts()[0].content]);
    assert.deepEqual(f.reveals_forbidden, ["the plan against B", "[fact fact_c]"]);
  } finally { cleanup(); }
});

test("Novelist context cannot access excluded facts; includes only relevant voices and style-only banners", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const ctx = buildNovelistContext(store, { packet: PACKET, env: env(store) });
    assert.doesNotMatch(ctx.user, /plans to move against/, "gm_only fact content must not reach the Novelist");
    assert.doesNotMatch(ctx.user, /secret new thing/);
    assert.doesNotMatch(ctx.user, /believes the debt is real/);
    assert.match(ctx.user, /noticed the marking/, "reveals_allowed content is present");
    assert.match(ctx.user, /STYLE MATERIAL ONLY/);
    assert.deepEqual(ctx.selection.voices, ["npc_a"]);
    assert.doesNotMatch(ctx.user, /Voice: <NPC_B>/);
    assert.match(ctx.system, /Never write dialogue for the player character `pc_fixture`/);
    assert.match(ctx.system, /Length band: short/);
  } finally { cleanup(); }
});

test("Editor context: packet as Novelist saw it + derived permitted view; no ledger, no hidden truth", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const ctx = buildEditorContext(store, { packet: PACKET, draft: "draft text", validation: { ok: true }, env: env(store) });
    assert.match(ctx.user, /Permitted knowledge per present actor/);
    assert.match(ctx.user, /"npc_a": \[/);
    assert.match(ctx.user, /plans to move against/, "npc_a holds fact_b, so the derived view legitimately contains it");
    assert.doesNotMatch(ctx.user, /"truth"/, "no truth status");
    assert.doesNotMatch(ctx.user, /Who owns <LOCATION_B>/, "unheld hidden fact absent");
    assert.doesNotMatch(ctx.user, /secret new thing/);
    assert.ok(ctx.selection.questions.includes("implied_knowledge"));
  } finally { cleanup(); }
});

test("NPC context: only own mind and own holdings", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const ctx = buildNpcContext(store, { npcId: "npc_b", packet: PACKET, question: "Do you answer?", env: env(store) });
    assert.match(ctx.user, /fact_d: <NPC_B> believes the debt is real/);
    assert.doesNotMatch(ctx.user, /plans to move against/);
    assert.deepEqual(ctx.selection.facts, ["fact_d"]);
    assert.match(ctx.user, /no mind record/);
  } finally { cleanup(); }
});

test("voice cards: inheritance, markdown cards, selection order and cap", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const card = resolveVoiceCard(store, "npc_a");
    assert.equal(card.style_only, true);
    assert.match(renderVoiceCard(card), /style samples, not things said in play/);
    const sel = selectVoiceCards(store, store.actors(), { intents: [{ npc: "npc_b", speech_acts: [{ act: "a" }, { act: "b" }] }, { npc: "npc_a", speech_acts: [{ act: "a" }] }], present: ["pc_fixture"], pcId: "pc_fixture", max: 1 });
    assert.deepEqual(sel.selected, ["npc_b"]);
    assert.deepEqual(sel.omitted, ["npc_a"]);
    const generic = resolveVoiceCard(store, "generic");
    assert.ok(generic);
  } finally { cleanup(); }
});

test("exemplars: only delivered turns can be marked; selection prefers pinned, presentation, actor overlap", () => {
  const { store, cleanup, clock } = tempCampaign();
  try {
    store.saveTurn({ turn_id: "c-1", event_id: "e1", status: "delivered", revision_base: 0, started_at: clock.iso(), transport: "cli", input: { text: "x" }, packet: PACKET, output: "Prose one." });
    store.saveTurn({ turn_id: "c-2", event_id: "e2", status: "drafted", revision_base: 1, started_at: clock.iso(), transport: "cli", input: { text: "y" }, draft: "d" });
    const ex = markTurn(store, { kind: "good", turnId: "c-1", at: clock.iso(), note: "nice restraint" });
    assert.equal(ex.style_only, true);
    assert.deepEqual(ex.actors, ["npc_a"]);
    assert.throws(() => markTurn(store, { kind: "flat", turnId: "c-2", at: clock.iso() }), /only delivered/);
    assert.equal(selectExemplars(store, "good", { presentation: "scene", actors: ["npc_a"], max: 2 }).length, 1);
    assert.equal(selectExemplars(store, "good", { presentation: "scene", actors: [], max: 0 }).length, 0);
  } finally { cleanup(); }
});
