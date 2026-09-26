import test from "node:test";
import assert from "node:assert/strict";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK, EDITOR_REVISE } from "./fixtures/packets.js";

test("Editor receives packet, draft, style, voices, validation and permitted view; never the ledger or hidden truth", async () => {
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    await r.runner.run({ text: "x", eventId: "e" });
    const call = r.fake.calls.find((c) => c.role === "editor");
    assert.ok(call);
    assert.match(call.user, /Draft/);
    assert.match(call.user, /Deterministic validation results/);
    assert.match(call.user, /Permitted knowledge per present actor/);
    assert.doesNotMatch(call.user, /"truth"/);
    assert.doesNotMatch(call.user, /gm_only/);
    assert.doesNotMatch(call.user, /Who owns <LOCATION_B>/, "unheld hidden fact");
    assert.doesNotMatch(call.user, /mind_deltas|fact_proposals|knowledge_events/);
    assert.match(call.system, /implied_knowledge/);
  } finally { r.cleanup(); }
});

test("Editor revise=true triggers exactly one Novelist revision; revision must still pass validation", async () => {
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [NOVELIST_PROSE, "⟦say npc_a⟧“Why.”⟦/say⟧ Nothing else."], editor: [EDITOR_REVISE, EDITOR_REVISE] } });
  try {
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.equal(r.fake.calls.filter((c) => c.role === "novelist").length, 2);
    assert.equal(r.fake.calls.filter((c) => c.role === "editor").length, 1, "editor runs once per turn");
    assert.match(res.output, /Nothing else\./);
    assert.match(r.fake.calls.filter((c) => c.role === "novelist")[1].user, /Revision notes from the Editor[\s\S]*cut the explanation/);
  } finally { r.cleanup(); }
});

test("a revision that fails deterministic validation is discarded; the validated draft ships", async () => {
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [NOVELIST_PROSE, "⟦say pc_fixture⟧“No.”⟦/say⟧"], editor: [EDITOR_REVISE] } });
  try {
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.equal(res.turn.status, "committed");
    assert.match(res.output, /You remembered it/);
    assert.doesNotMatch(res.output, /“No.”/);
  } finally { r.cleanup(); }
});

test("Editor failure never fails the turn; Editor is skipped in presentation modes not listed", async () => {
  const r = makeRunner({ responses: { director: [directorPacket({ presentation: "montage" })], novelist: [NOVELIST_PROSE] } });
  try {
    const res = await r.runner.run({ text: "x", eventId: "e" });
    assert.equal(res.turn.status, "committed");
    assert.equal(r.fake.calls.filter((c) => c.role === "editor").length, 0);
  } finally { r.cleanup(); }
  const r2 = makeRunner({ responses: { director: [directorPacket()], novelist: [NOVELIST_PROSE], editor: ["garbage", "garbage"] } });
  try {
    const res = await r2.runner.run({ text: "x", eventId: "e" });
    assert.equal(res.turn.status, "committed");
    assert.ok(res.turn.history.some((h) => /editor skipped/.test(h.note || "")));
  } finally { r2.cleanup(); }
});
