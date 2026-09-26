import test from "node:test";
import assert from "node:assert/strict";
import { newTurn, transition, canTransition, LifecycleError, isIncomplete, STATES } from "../src/state/lifecycle.js";

test("lifecycle: happy path received -> delivered", () => {
  let t = newTurn({ turnId: "c-000001", eventId: "e1", revisionBase: 0, input: { text: "hi", kind: "play" }, transport: "cli", at: "t0" });
  for (const s of ["planned", "drafted", "validated", "committed", "delivered"]) t = transition(t, s, { at: "t1" });
  assert.equal(t.status, "delivered");
  assert.equal(t.history.length, 6);
});

test("lifecycle: retries allowed before commit, nothing after commit is recomputed", () => {
  let t = newTurn({ turnId: "c-1", eventId: "e", revisionBase: 0, input: { text: "x" }, transport: "cli", at: "t" });
  t = transition(t, "planned"); t = transition(t, "planned"); t = transition(t, "drafted"); t = transition(t, "drafted");
  t = transition(t, "validated"); t = transition(t, "committed");
  assert.throws(() => transition(t, "planned"), LifecycleError);
  assert.throws(() => transition(t, "abandoned"), LifecycleError);
  assert.equal(canTransition("committed", "delivered"), true);
  assert.equal(canTransition("delivered", "delivered"), true, "redelivery allowed");
});

test("lifecycle: incomplete states can be abandoned; terminal states cannot move", () => {
  for (const s of ["received", "planned", "drafted", "validated"]) assert.equal(canTransition(s, "abandoned"), true, s);
  for (const s of ["abandoned", "failed"]) for (const to of STATES) assert.equal(canTransition(s, to), false);
  assert.equal(isIncomplete({ status: "drafted" }), true);
  assert.equal(isIncomplete({ status: "committed" }), false);
});
