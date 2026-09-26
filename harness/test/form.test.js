import test from "node:test";
import assert from "node:assert/strict";
import { emptyLedger, recordForm, pressureReport, highPressure, formErrors } from "../src/form/pressure.js";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";

const DIMS = { ending: ["question", "silence", "cut"], tempo: ["slow", "quick"] };
const form = (ending, tempo) => ({ ending, tempo });

test("pressure rises with repeated use and decays; never rejects", () => {
  let l = emptyLedger(0.5);
  l = recordForm(l, form("question", "slow"), { turnId: "t1", dimensions: DIMS });
  l = recordForm(l, form("question", "slow"), { turnId: "t2", dimensions: DIMS });
  l = recordForm(l, form("question", "quick"), { turnId: "t3", dimensions: DIMS });
  const p = pressureReport(l, DIMS);
  assert.ok(p.ending.question > 0.6 && p.ending.silence === 0);
  assert.ok(p.tempo.slow < p.tempo.quick, "quick is more recent");
  assert.ok(highPressure(l, DIMS, 0.5).some((h) => h.value === "question"));
  assert.equal(l.history.length, 3);
  for (let i = 0; i < 10; i++) l = recordForm(l, form("cut", "slow"), { turnId: `t${i + 4}`, dimensions: DIMS });
  assert.ok(pressureReport(l, DIMS).ending.question < 0.01, "old use decays away");
  assert.deepEqual(formErrors(form("question", "slow"), DIMS), []);
  assert.ok(formErrors({ ending: "boom" }, DIMS).length === 2);
});

test("repeated form is accepted by the runner; pressure is shown to the Director and logged", async () => {
  const r = makeRunner({ responses: { director: [directorPacket(), directorPacket({ fact_proposals: [], knowledge_events: [], mind_deltas: [] })], novelist: [NOVELIST_PROSE, NOVELIST_PROSE], editor: [EDITOR_OK, EDITOR_OK] } });
  try {
    await r.runner.run({ text: "a", eventId: "e1" });
    const res = await r.runner.run({ text: "b", eventId: "e2" });
    assert.equal(res.turn.status, "committed", "same shape twice is not rejected");
    const second = r.fake.calls.filter((c) => c.role === "director")[1];
    assert.match(second.user, /form_pressure[\s\S]*"question": 0\.5/);
    const ledger = r.store.formLedger();
    assert.equal(ledger.history.length, 2);
    assert.ok(ledger.history[1].pressure_seen.ending.question > 0);
  } finally { r.cleanup(); }
});
