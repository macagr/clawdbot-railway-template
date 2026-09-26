import test from "node:test";
import assert from "node:assert/strict";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";
import { resolvePresentation, isCanonMode, assertSemanticMode } from "../src/modes/modes.js";

test("presentation policy: suggestions are visible; changes only under director_changes and allowed transitions; pinned never moves", () => {
  const r = makeRunner();
  try {
    const m = r.store.manifest;
    const scene = { presentation: "scene" };
    let res = resolvePresentation(m, scene, { presentation_suggestion: "montage" });
    assert.equal(res.changed, false);
    assert.match(res.note, /Director suggests montage/);
    const m2 = structuredClone(m); m2.modes.presentation.auto_transition = "director_changes";
    res = resolvePresentation(m2, scene, { presentation_suggestion: "montage" });
    assert.equal(res.changed, true); assert.equal(res.presentation, "montage"); assert.match(res.note, /scene → montage/);
    res = resolvePresentation(m2, scene, { presentation_suggestion: "doc" });
    assert.equal(res.changed, false, "scene -> doc not in allowed_transitions");
    res = resolvePresentation(m2, { presentation: "scene", presentation_forced: true }, { presentation_suggestion: "montage" });
    assert.equal(res.changed, false); assert.match(res.note, /pinned/);
    const m3 = structuredClone(m); m3.modes.presentation.auto_transition = "off";
    assert.equal(resolvePresentation(m3, scene, { presentation_suggestion: "montage" }).note, null);
    assert.equal(isCanonMode(m, "play"), true);
    assert.equal(isCanonMode(m, "development"), false);
    assert.throws(() => assertSemanticMode(m, "chaos"), /not enabled/);
  } finally { r.cleanup(); }
});

test("semantic mode is never inferred: a non-canon mode turn commits no state and is tagged", async () => {
  const r = makeRunner({ responses: { director: ["As GM: that place was once owned by <GROUP_A>, but nothing is decided."] } });
  try {
    r.store.commit({ "state/scene.json": { ...r.store.scene(), mode: "development" } });
    const res = await r.runner.run({ text: "what about <LOCATION_B>?", eventId: "e" });
    assert.equal(res.turn.status, "committed");
    assert.match(res.output, /^\(\( development \)\)/);
    assert.equal(r.store.meta().revision, 0);
    assert.equal(r.store.dirty().entries.length, 0);
    assert.equal(r.fake.calls.length, 1);
    assert.match(r.fake.calls[0].user, /Non-canon mode: development/);
  } finally { r.cleanup(); }
});

test("director_changes policy applies and reports the presentation change on commit", async () => {
  const r = makeRunner({ responses: { director: [directorPacket({ presentation_suggestion: "montage" })], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] }, manifestPatch: (m) => { m.modes.presentation.auto_transition = "director_changes"; return m; } });
  try {
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.match(res.output, /^\[presentation: scene → montage\]/);
    assert.equal(r.store.scene().presentation, "montage");
  } finally { r.cleanup(); }
});
