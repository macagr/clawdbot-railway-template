import test from "node:test";
import assert from "node:assert/strict";
import { tempCampaign } from "./helpers.js";
import { loadCatalog } from "../src/knowledge/catalog.js";
import { validateDirectorPacket, validateNovelistOutput, validateNpcDecision } from "../src/validate/deterministic.js";

function ctx(store) { return { facts: store.facts(), actors: store.actors(), catalog: loadCatalog(store), manifest: store.manifest, scene: store.scene() }; }
function packet(over = {}) {
  return {
    turn_summary: "s",
    form: { length_band: "short", structure: "dialogue", camera: "close", tempo: "slow", ending: "question", sense: "sound" },
    scene: { location: "location_a", present: ["pc_fixture", "npc_a"], beats: ["b"] }, perception: "p",
    npc_intents: [{ npc: "npc_a", intent: "i", acting_on: ["fact_b"], emotional_register: "e", speech_acts: [{ act: "asks" }], must_not_reveal: ["fact_b"] }],
    reveals_allowed: ["fact_a"], reveals_forbidden: ["fact_b"], stop_for_player: true, ...over,
  };
}
const codes = (r) => r.errors.map((e) => e.code);

test("normalizeDirectorPacket drops echoed scene state and fills defaults; other extras stay strict", async () => {
  const { normalizeDirectorPacket } = await import("../src/validate/deterministic.js");
  const echoed = packet({ scene: { scene_id: "scene_seed", location: "location_a", time: "t", clock: 3, present: ["pc_fixture", "npc_a"], mode: "play", presentation: "scene", active_plots: ["plot_a"], summary: "s" } });
  delete echoed.scene.beats;
  const n = normalizeDirectorPacket(echoed);
  assert.deepEqual(Object.keys(n.scene).sort(), ["beats", "location", "present", "time"]);
  const { store, cleanup } = tempCampaign();
  try {
    assert.deepEqual(validateDirectorPacket(n, ctx(store)).errors, []);
    assert.ok(codes(validateDirectorPacket(normalizeDirectorPacket(packet({ bogus: 1 })), ctx(store))).includes("schema"), "unknown top-level keys are still rejected");
  } finally { cleanup(); }
});

test("normalizeDirectorPacket coerces mind-delta variants and drops the unrecoverable ones with notes", async () => {
  const { normalizeDirectorPacket } = await import("../src/validate/deterministic.js");
  const notes = [];
  const n = normalizeDirectorPacket(packet({ mind_deltas: [
    { actor: "npc_a", intentions_add: ["press the question", { text: "watch the door", weight: 0.4, scope: "scene" }], suspicions_add: ["<PC_ID> is hiding something"], dispositions: { toward_pc_fixture: "wary" } },
    { actor: "npc_a", intentions_add: [{ weight: 1 }] },
    "not an object",
  ] }), notes);
  assert.equal(n.mind_deltas.length, 2, JSON.stringify(notes));
  const d = n.mind_deltas[0];
  assert.deepEqual(d.intentions_add.map((i) => i.what), ["press the question", "watch the door"]);
  assert.ok(d.intentions_add.every((i) => i.id && i.status === "held"));
  assert.equal(d.suspicions_add[0].confidence, "medium");
  assert.equal(d.dispositions.pc_fixture.stance, "wary");
  assert.equal(n.mind_deltas[1].intentions_add.length, 0, "unrecoverable item filtered, delta kept");
  assert.ok(notes.some((x) => /mind_deltas\[2\] dropped/.test(x)));
  const { store, cleanup } = tempCampaign();
  try { assert.deepEqual(validateDirectorPacket(n, ctx(store)).errors, []); } finally { cleanup(); }
});

test("acting_on and reveals accept new:<ref> fact refs at the schema level", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const p = packet({ fact_proposals: [{ ref: "new:x", content: "c" }], knowledge_events: [{ kind: "observe", fact: "new:x", to: { type: "actor", id: "npc_a" }, channel: "face_to_face" }],
      npc_intents: [{ npc: "npc_a", intent: "i", acting_on: ["fact_b", "new:x"], emotional_register: "e", speech_acts: [], must_not_reveal: ["new:x"] }], reveals_forbidden: ["fact_b", "new:x"] });
    assert.deepEqual(validateDirectorPacket(p, ctx(store)).errors, []);
  } finally { cleanup(); }
});

test("valid packet passes", () => {
  const { store, cleanup } = tempCampaign();
  try { const r = validateDirectorPacket(packet(), ctx(store)); assert.deepEqual(r.errors, [], JSON.stringify(r)); } finally { cleanup(); }
});

test("acting_on must be held: uncited knowledge is rejected; a delay-0 knowledge event in the packet grants it", () => {
  const { store, cleanup } = tempCampaign();
  try {
    let r = validateDirectorPacket(packet({ npc_intents: [{ npc: "npc_a", intent: "i", acting_on: ["fact_a"], emotional_register: "e", speech_acts: [], must_not_reveal: [] }] }), ctx(store));
    assert.ok(codes(r).includes("not-held"));
    r = validateDirectorPacket(packet({
      npc_intents: [{ npc: "npc_a", intent: "i", acting_on: ["fact_a"], emotional_register: "e", speech_acts: [], must_not_reveal: [] }],
      knowledge_events: [{ kind: "transmit", fact: "fact_a", from: { type: "actor", id: "pc_fixture" }, to: { type: "actor", id: "npc_a" }, channel: "face_to_face" }],
    }), ctx(store));
    assert.deepEqual(r.errors, []);
    r = validateDirectorPacket(packet({ npc_intents: [{ npc: "npc_a", intent: "i", acting_on: ["nope"], emotional_register: "e", speech_acts: [], must_not_reveal: [] }] }), ctx(store));
    assert.ok(codes(r).includes("unknown-fact"));
  } finally { cleanup(); }
});

test("truth and reveal rules: undecided proposals, allowed/forbidden conflicts, unheld reveals, unknown channels", () => {
  const { store, cleanup } = tempCampaign();
  try {
    let r = validateDirectorPacket(packet({ fact_proposals: [{ ref: "new:x", content: "c", truth_status: "true" }] }), ctx(store));
    assert.ok(codes(r).includes("truth-undecided"));
    r = validateDirectorPacket(packet({ reveals_allowed: ["fact_b"] }), ctx(store));
    assert.ok(codes(r).includes("reveal-conflict"));
    r = validateDirectorPacket(packet({ reveals_allowed: ["fact_c"], reveals_forbidden: [] }), ctx(store));
    assert.ok(codes(r).includes("reveal-unheld"), "nobody present holds fact_c");
    r = validateDirectorPacket(packet({ knowledge_events: [{ kind: "observe", fact: "fact_a", to: { type: "actor", id: "npc_a" }, channel: "telepathy" }] }), ctx(store));
    assert.ok(codes(r).includes("unknown-channel"));
    r = validateDirectorPacket(packet({ knowledge_events: [{ kind: "transmit", fact: "fact_a", to: { type: "group", id: "group_a", scope: "nope" }, channel: "face_to_face", from: { type: "actor", id: "pc_fixture" } }] }), ctx(store));
    assert.ok(codes(r).includes("unknown-scope"));
    r = validateDirectorPacket(packet({ form: { length_band: "epic", structure: "dialogue", camera: "close", tempo: "slow", ending: "question", sense: "sound" } }), ctx(store));
    assert.ok(codes(r).includes("form"));
    r = validateDirectorPacket(packet({ npc_intents: [{ npc: "pc_fixture", intent: "i", acting_on: [], emotional_register: "e", speech_acts: [], must_not_reveal: [] }] }), ctx(store));
    assert.ok(codes(r).includes("pc-intent"));
    r = validateDirectorPacket(packet({ scene: { location: "location_a", present: ["ghost"], beats: [] } }), ctx(store));
    assert.ok(codes(r).includes("unknown-actor"));
    r = validateDirectorPacket(packet({ state_deltas: { actors: [{ op: "cast", casting_request: { ref: "new:stranger", role: "clerk" } }] }, scene: { location: "location_a", present: ["pc_fixture", "new:stranger"], beats: [] }, npc_intents: [] }), ctx(store));
    assert.ok(r.errors.every((e) => e.code !== "unknown-actor"), "cast refs count as known this turn");
  } finally { cleanup(); }
});

test("novelist output: speakers, PC dialogue, forbidden aliases, length, annotation", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const c = ctx(store);
    const p = packet();
    let r = validateNovelistOutput("Quiet. ⟦say npc_a⟧“You remembered it.”⟦/say⟧ The floor was cold.", { packet: p, ...c });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.speakers, ["npc_a"]);
    assert.doesNotMatch(r.plain, /⟦/);
    r = validateNovelistOutput("⟦say pc_fixture⟧“I know.”⟦/say⟧", { packet: p, ...c });
    assert.ok(codes(r).includes("pc-dialogue"));
    assert.deepEqual(validateNovelistOutput("⟦say pc_fixture⟧“I know.”⟦/say⟧", { packet: p, ...c, pcAllowedToSpeak: true }).errors, []);
    r = validateNovelistOutput("⟦say npc_b⟧“Hi.”⟦/say⟧", { packet: p, ...c });
    assert.ok(codes(r).includes("speaker-not-allowed"));
    r = validateNovelistOutput("He mentioned the plan against B, casually.", { packet: p, ...c });
    assert.ok(codes(r).includes("forbidden-alias"));
    r = validateNovelistOutput("x".repeat(4000), { packet: p, ...c });
    assert.ok(codes(r).includes("too-long"));
    r = validateNovelistOutput("⟦say npc_a⟧unclosed", { packet: p, ...c });
    assert.ok(codes(r).includes("annotation"));
    const long = validateNovelistOutput(Array(400).fill("word").join(" "), { packet: p, ...c });
    assert.ok(long.warnings.some((w) => w.code === "length-band"), "band overshoot is a warning, not an error");
    assert.deepEqual(long.errors, []);
  } finally { cleanup(); }
});

test("un-annotated dialogue is rejected when NPCs speak; silent prose and quoted signs are fine", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const c = ctx(store), p = packet();
    let r = validateNovelistOutput('He looked up. "You remembered it. Why." A pause.', { packet: p, ...c });
    assert.ok(codes(r).includes("unannotated-dialogue"));
    r = validateNovelistOutput("He looked up and said nothing. The kettle ticked.", { packet: p, ...c });
    assert.deepEqual(r.errors, []);
    r = validateNovelistOutput('The sign read “no credit”. ⟦say npc_a⟧“Sit.”⟦/say⟧', { packet: p, ...c });
    assert.deepEqual(r.errors, []);
    const silent = packet({ npc_intents: [{ npc: "npc_a", intent: "i", acting_on: ["fact_b"], emotional_register: "e", speech_acts: [], must_not_reveal: [], speaks: false }] });
    r = validateNovelistOutput('A voice from the radio: "…and that is the news." He switched it off.', { packet: silent, ...c });
    assert.deepEqual(r.errors, [], "no speaking intents: quotes are not treated as NPC dialogue");
  } finally { cleanup(); }
});

test("npc decision: acting_on restricted to own holdings", () => {
  const { store, cleanup } = tempCampaign();
  try {
    const c = ctx(store);
    const base = { npc: "npc_b", intent: "i", acting_on: ["fact_d"], emotional_register: "e", speech_acts: [], must_not_reveal: [] };
    assert.deepEqual(validateNpcDecision(base, { npcId: "npc_b", ...c }).errors, []);
    assert.ok(validateNpcDecision({ ...base, acting_on: ["fact_b"] }, { npcId: "npc_b", ...c }).errors.some((e) => e.code === "not-held"));
    assert.ok(validateNpcDecision({ ...base, npc: "npc_a" }, { npcId: "npc_b", ...c }).errors.some((e) => e.code === "npc-mismatch"));
  } finally { cleanup(); }
});
