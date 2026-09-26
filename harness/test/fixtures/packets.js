// Synthetic Director/Novelist/NPC fixtures for the generic fixture campaign. Placeholders only.
export function directorPacket(over = {}) {
  return {
    turn_summary: "<NPC_A> arrives and asks <PC_ID> about the marking.",
    form: { length_band: "short", structure: "dialogue", camera: "close", tempo: "slow", ending: "question", sense: "sound" },
    scene: { location: "location_a", time: "day 1, later morning", present: ["pc_fixture", "npc_a"], beats: ["door opens", "<NPC_A> notices the marking", "the question"] },
    perception: "<PC_ID> hears the door and sees <NPC_A> look at the object.",
    fact_proposals: [{ ref: "new:asked", content: "<NPC_A> asked <PC_ID> why the marking mattered.", tags: ["plot_a"], aliases: ["the question about the marking"] }],
    npc_intents: [{ npc: "npc_a", intent: "gauge whether <PC_ID> is observant", acting_on: ["fact_b"], emotional_register: "dry, unhurried", speech_acts: [{ act: "asks why the marking matters", subtext: "evaluating usefulness" }], must_not_reveal: ["fact_b"] }],
    knowledge_events: [
      { kind: "observe", fact: "fact_a", to: { type: "actor", id: "npc_a" }, channel: "face_to_face" },
      { kind: "observe", fact: "new:asked", to: { type: "actor", id: "npc_a" }, channel: "face_to_face" },
      { kind: "observe", fact: "new:asked", to: { type: "actor", id: "pc_fixture" }, channel: "face_to_face" },
    ],
    reveals_allowed: ["fact_a"],
    reveals_forbidden: ["fact_b", "fact_c"],
    uncertainty: ["whether <NPC_A> already suspected the marking"],
    state_deltas: { scene: { clock_advance: 1, summary: "<NPC_A> has asked the question." }, relationships: [{ from: "npc_a", to: "pc_fixture", stance: "assessing", history_add: "asked about the marking" }], unresolved: [{ op: "add", question: "Why does <NPC_A> care about the marking?", actors: ["npc_a"] }] },
    mind_deltas: [{ actor: "npc_a", intentions_update: [{ id: "int_a_test_pc", status: "active" }] }],
    stop_for_player: true,
    stop_reason: "<NPC_A> is waiting for an answer.",
    novelist_notes: "end on the question",
    ...over,
  };
}

export const NOVELIST_PROSE = "The door gave its usual complaint. <NPC_A> did not look at the car. He looked at the object, and then at the marking, and then at <PC_ID> for exactly as long as it took the kettle to tick twice.\n\n⟦say npc_a⟧“You remembered it.”⟦/say⟧ A pause. ⟦say npc_a⟧“Why.”⟦/say⟧";

export const EDITOR_OK = { revise: false, notes: [] };
export const EDITOR_REVISE = { revise: true, notes: [{ question: "named_subtext", finding: "The narration explains the evaluation.", quote: "for exactly as long as", severity: "medium", suggestion: "cut the explanation" }] };

export function npcDecision(over = {}) {
  return {
    npc: "npc_a", intent: "press once, then wait", acting_on: ["fact_b"], emotional_register: "amused", speech_acts: [{ act: "asks why", subtext: "testing" }], must_not_reveal: ["fact_b"], speaks: true,
    mind_delta: { actor: "npc_a", suspicions_add: [{ about: "fact_a", hypothesis: "<PC_ID> notices things on purpose", confidence: "medium" }] },
    rationale: "private",
    ...over,
  };
}
