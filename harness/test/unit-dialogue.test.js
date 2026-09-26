import test from "node:test";
import assert from "node:assert/strict";
import { parseSpans, stripSpans, speakers, quotedOutsideSpans, wordCount } from "../src/render/dialogue.js";

const SAMPLE = "The door opened. ⟦say npc_a⟧“You remembered it. Why.”⟦/say⟧ A sign over the bar read “no credit, no exceptions, no stories about your mother”. ⟦say npc_b⟧“Sit.”⟦/say⟧";

test("spans parse with speakers and bodies; render strips markup cleanly", () => {
  const { spans, errors } = parseSpans(SAMPLE);
  assert.deepEqual(errors, []);
  assert.deepEqual(spans.map((s) => [s.speaker, s.text]), [["npc_a", "“You remembered it. Why.”"], ["npc_b", "“Sit.”"]]);
  const plain = stripSpans(SAMPLE);
  assert.equal(plain, "The door opened. “You remembered it. Why.” A sign over the bar read “no credit, no exceptions, no stories about your mother”. “Sit.”");
  assert.deepEqual(speakers(SAMPLE), ["npc_a", "npc_b"]);
});

test("quoted non-dialogue outside spans is allowed but long runs are surfaced as warnings", () => {
  const q = quotedOutsideSpans(SAMPLE, { minWords: 6 });
  assert.equal(q.length, 1);
  assert.match(q[0].text, /no credit/);
  assert.equal(quotedOutsideSpans(SAMPLE, { minWords: 12 }).length, 0);
});

test("stripOocNotes removes whole (( … )) paragraphs and nothing else", async () => {
  const { stripOocNotes, quotedRuns } = await import("../src/render/dialogue.js");
  const r = stripOocNotes("Prose one.\n\n(( <NPC_A> waits for an answer. ))\n\nProse two (( not a whole note )).\n\n(( multi\nline note ))");
  assert.equal(r.text, "Prose one.\n\nProse two (( not a whole note )).");
  assert.equal(r.removed.length, 2);
  assert.deepEqual(quotedRuns('a "b c" d “ef” “x”'), ["b c", "ef"], "single-character quotes are ignored");
});

test("malformed annotation is reported: unclosed, nested, stray close, bad id", () => {
  assert.match(parseSpans("⟦say npc_a⟧“x”").errors[0], /unclosed/);
  assert.match(parseSpans("⟦say npc_a⟧“x ⟦say npc_b⟧y⟦/say⟧”⟦/say⟧").errors[0], /nested/);
  assert.match(parseSpans("hello⟦/say⟧").errors[0], /stray/);
  assert.match(parseSpans("⟦say Bad Id⟧x⟦/say⟧").errors[0], /invalid speaker id/);
  assert.equal(stripSpans("⟦say npc_a⟧“x”"), "“x”", "strip is tolerant");
  assert.equal(wordCount("  a b  c "), 3);
});
