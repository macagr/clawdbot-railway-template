import test from "node:test";
import assert from "node:assert/strict";
import { SchemaRegistry, SchemaError } from "../src/lib/schema.js";

const s = new SchemaRegistry();

test("every schema file loads and validates its own structure", () => {
  const names = s.list();
  assert.ok(names.length >= 25);
  for (const n of names) assert.ok(s.get(n).$id === `${n}.json`, `${n} has $id`);
});

test("fact schema: valid record passes; cross-file $ref for holdings works", () => {
  const fact = {
    id: "fact_a", content: "x", created_turn: "t1", persistence: "provisional",
    truth: { status: "unresolved", authorial: "undecided", visibility: "restricted" },
    holdings: [{ holder: { type: "actor", id: "npc_a" }, version: "accurate", confidence: "high", evidence: "witnessed", via: "ev_1" }],
    provenance: ["ev_1"],
  };
  assert.deepEqual(s.errors("fact", fact), []);
  fact.holdings.push({ holder: { type: "group", id: "group_a" }, version: "accurate", confidence: "high", evidence: "witnessed", via: "ev" });
  const errs = s.errors("fact", fact);
  assert.ok(errs.some((e) => /oneOf|scope/.test(e)), `group holder without scope must fail: ${errs}`);
});

test("enum, required, additionalProperties, pattern, oneOf errors are reported with paths", () => {
  const errs = s.errors("scene", { scene_id: "s", location: "Bad Location", time: "", present: [], mode: "play", presentation: "scene", bogus: 1 });
  assert.ok(errs.some((e) => e.includes("$.location")));
  assert.ok(errs.some((e) => e.includes("unexpected property 'bogus'")));
  assert.throws(() => s.validate("scene", {}), SchemaError);
});

test("director packet: minimal valid packet", () => {
  const p = {
    turn_summary: "s", form: { length_band: "short", structure: "dialogue", camera: "close", tempo: "slow", ending: "question", sense: "sight" },
    scene: { location: "location_a", present: ["npc_a"], beats: ["b"] }, perception: "p",
    npc_intents: [{ npc: "npc_a", intent: "i", acting_on: ["fact_a"], emotional_register: "e", speech_acts: [{ act: "asks" }], must_not_reveal: [] }],
    reveals_allowed: [], reveals_forbidden: ["fact_b"], stop_for_player: true,
  };
  assert.deepEqual(s.errors("director-packet", p), []);
});

test("uniqueItems and idList reject duplicates", () => {
  assert.ok(s.errors("director-packet", {
    turn_summary: "s", form: { length_band: "a", structure: "b", camera: "c", tempo: "d", ending: "e", sense: "f" },
    scene: { location: "l", present: ["npc_a", "npc_a"], beats: [] }, perception: "p", npc_intents: [], reveals_allowed: [], reveals_forbidden: [], stop_for_player: false,
  }).some((e) => e.includes("duplicate")));
});
