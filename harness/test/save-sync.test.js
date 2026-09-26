import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";
import { LocalFilesystemPersistenceAdapter } from "../src/persistence/local.js";
import { WebhookPersistenceAdapter } from "../src/persistence/webhook.js";
import { buildSavePacket, performSave, dryRunSave } from "../src/persistence/save.js";
import { performSync, syncStatus } from "../src/persistence/sync.js";
import { PersistenceError } from "../src/persistence/adapter.js";

async function playTurns(r, n) {
  r.seq = r.seq || 0;
  for (let i = 0; i < n; i++) {
    const k = ++r.seq;
    r.fake.enqueue("director", directorPacket({ fact_proposals: [{ ref: "new:f", content: `fact from turn ${k}` }], knowledge_events: [], mind_deltas: [] }));
    r.fake.enqueue("novelist", NOVELIST_PROSE); r.fake.enqueue("editor", EDITOR_OK);
    const res = await r.runner.run({ text: `t${k}`, eventId: `e${k}` });
    assert.equal(res.turn.status, "committed");
    assert.ok(!res.reused, "helper must create a new turn");
  }
}

function localAdapter(r, opts = {}) {
  const a = new LocalFilesystemPersistenceAdapter({ dir: path.join(r.dir, "persistence"), ...opts });
  a.seedFrom(r.store);
  return a;
}

test("save packet: idempotent id, append vs replace vs events, expected revision", async () => {
  const r = makeRunner();
  try {
    await playTurns(r, 2);
    const p1 = buildSavePacket(r.store, { at: r.clock.iso() });
    const p2 = buildSavePacket(r.store, { at: r.clock.iso() });
    assert.equal(p1.save_id, p2.save_id, "same unsaved range -> same id");
    assert.equal(p1.source.revision_from, 1); assert.equal(p1.source.revision_to, 2);
    assert.equal(p1.append.audit.length, 2);
    assert.match(p1.append.chronicle.markdown, /You remembered it/);
    assert.equal(p1.replace.facts.length, 6);
    assert.equal(p1.events.knowledge.length, 0);
    assert.equal(p1.expect.canon_revision, null);
    const d = dryRunSave(r.store, { at: r.clock.iso() });
    assert.equal(d.turns, 2);
    assert.throws(() => buildSavePacket(makeRunnerStore(), { at: "t" }), /nothing to save/);
  } finally { r.cleanup(); }
});
function makeRunnerStore() { const x = makeRunner(); const s = x.store; return s; }

test("local adapter: ok save marks facts saved and clears dirty; duplicate save is a no-op remotely", async () => {
  const r = makeRunner();
  try {
    await playTurns(r, 2);
    const a = localAdapter(r);
    const first = await performSave(r.store, a, { at: r.clock.iso() });
    assert.equal(first.status, "ok");
    assert.equal(r.store.dirty().entries.length, 0);
    assert.equal(r.store.meta().last_saved_revision, 2);
    assert.equal(r.store.meta().canon_revision, 1);
    assert.ok(r.store.facts().every((f) => f.persistence === "saved"));
    assert.match(fs.readFileSync(path.join(r.dir, "persistence", "canon", "recent_history.md"), "utf8"), /revisions 1-2/);
    assert.match(fs.readFileSync(path.join(r.dir, "canon", "recent.md"), "utf8"), /revisions 1-2/, "local canon copy appended");
    const again = await a.save(first.packet);
    assert.equal(again.status, "duplicate");
    assert.equal((await a.getRemoteRevision()).canon_revision, 1, "duplicate did not bump revision");
    await assert.rejects(performSave(r.store, a, { at: r.clock.iso() }), /nothing to save/);
  } finally { r.cleanup(); }
});

test("revision mismatch is rejected and nothing is marked saved", async () => {
  const r = makeRunner();
  try {
    await playTurns(r, 1);
    const a = localAdapter(r);
    r.store.commit({ "state/meta.json": { ...r.store.meta(), canon_revision: 41 } });
    const res = await performSave(r.store, a, { at: r.clock.iso() });
    assert.equal(res.status, "rejected");
    assert.equal(r.store.dirty().entries.length, 1);
    assert.ok(r.store.pendingSave());
  } finally { r.cleanup(); }
});

test("partial failure keeps the packet pending; retry uses the same save_id and completes", async () => {
  const r = makeRunner();
  try {
    await playTurns(r, 1);
    let fail = true;
    const a = localAdapter(r, { failTargets: () => (fail ? ["state.facts"] : []) });
    const res = await performSave(r.store, a, { at: r.clock.iso() });
    assert.equal(res.status, "partial");
    assert.ok(res.result.failed.some((f) => f.target === "state.facts"));
    assert.ok(res.result.failed.some((f) => f.target === "chronicle" && /skipped/.test(f.error)), "appends never land without state");
    assert.equal(r.store.dirty().entries.length, 1, "not marked saved");
    const pending = r.store.pendingSave();
    assert.equal(pending.attempts, 1);
    fail = false;
    const retry = await performSave(r.store, a, { at: r.clock.iso() });
    assert.equal(retry.status, "ok");
    assert.equal(retry.packet.save_id, res.packet.save_id);
    assert.equal(r.store.pendingSave(), null);
  } finally { r.cleanup(); }
});

test("adapter error (network) keeps everything unsaved with the pending packet recorded", async () => {
  const r = makeRunner();
  try {
    await playTurns(r, 1);
    const a = { save: async () => { throw new PersistenceError("boom", { code: "network", retryable: true }); } };
    const res = await performSave(r.store, a, { at: r.clock.iso() });
    assert.equal(res.status, "error");
    assert.equal(r.store.pendingSave().last_error, "boom");
    assert.equal(r.store.dirty().entries.length, 1);
  } finally { r.cleanup(); }
});

test("sync: clean pull, dirty no-op, conflict, stash, discard confirmation", async () => {
  const r = makeRunner();
  try {
    const a = localAdapter(r);
    await playTurns(r, 1);
    await performSave(r.store, a, { at: r.clock.iso() });
    // remote edited externally
    fs.appendFileSync(path.join(r.dir, "persistence", "canon", "operational_canon.md"), "\n\nEdited in durable canon.\n");
    const meta = a.meta(); fs.writeFileSync(a.metaPath(), JSON.stringify({ ...meta, canon_revision: meta.canon_revision + 1 }));
    let s = await syncStatus(r.store, a);
    assert.equal(s.state, "clean_pull");
    let res = await performSync(r.store, a, { at: r.clock.iso() });
    assert.equal(res.action, "pulled");
    assert.match(fs.readFileSync(path.join(r.dir, "canon", "operational.md"), "utf8"), /Edited in durable canon/);
    assert.equal(r.store.meta().canon_revision, 2);
    // dirty + unchanged
    await playTurns(r, 1);
    res = await performSync(r.store, a, { at: r.clock.iso() });
    assert.equal(res.action, "none"); assert.match(res.message, /1 unsaved turn/);
    // dirty + changed => conflict
    const m2 = a.meta(); fs.writeFileSync(a.metaPath(), JSON.stringify({ ...m2, canon_revision: m2.canon_revision + 1 }));
    res = await performSync(r.store, a, { at: r.clock.iso() });
    assert.equal(res.action, "conflict");
    assert.match(res.message, /No auto-merge/);
    assert.equal(r.store.dirty().entries.length, 1, "nothing overwritten");
    // discard needs confirmation
    await assert.rejects(performSync(r.store, a, { at: r.clock.iso(), mode: "discard", confirm: "wrong" }), /confirmation/);
    // stash
    const beforeFacts = r.store.facts().length;
    res = await performSync(r.store, a, { at: r.clock.iso(), mode: "stash" });
    assert.equal(res.action, "stash");
    assert.equal(r.store.dirty().entries.length, 0);
    assert.ok(r.store.facts().length < beforeFacts, "provisional fact reverted to saved state");
    const stashDir = path.join(r.dir, "runtime", "stash");
    assert.equal(fs.readdirSync(stashDir).length, 1);
    const stash = JSON.parse(fs.readFileSync(path.join(stashDir, fs.readdirSync(stashDir)[0], "stash.json"), "utf8"));
    assert.equal(stash.non_canon, true);
  } finally { r.cleanup(); }
});

test("webhook adapter: bearer auth, idempotency header, retries on 5xx, no retry on 4xx, contract checks", async () => {
  const calls = [];
  let failures = 1;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === "GET" && url.includes("revision_only")) return { ok: true, json: async () => ({ canon_revision: 7 }) };
    if (init.method === "GET") return { ok: true, json: async () => ({ campaign: "campaign_fixture", canon_revision: 7, files: { operational_canon: "remote text" } }) };
    if (failures-- > 0) return { ok: false, status: 503, text: async () => "unavailable" };
    const packet = JSON.parse(init.body);
    return { ok: true, json: async () => ({ save_id: packet.save_id, status: "ok", applied: ["state.facts", "chronicle"], failed: [], canon_revision: 8 }) };
  };
  const a = new WebhookPersistenceAdapter({ campaignId: "campaign_fixture", endpointEnv: "U", tokenEnv: "T", syncEndpointEnv: "S", env: { U: "https://example.invalid/rp/save", T: "tok", S: "https://example.invalid/rp/canon" }, fetchImpl, retries: 2, sleep: async () => {} });
  const r = makeRunner();
  try {
    await playTurns(r, 1);
    const res = await performSave(r.store, a, { at: r.clock.iso() });
    assert.equal(res.status, "ok");
    const posts = calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 2, "one 503 then success");
    assert.equal(posts[0].headers.authorization, "Bearer tok");
    assert.equal(posts[0].headers["idempotency-key"], res.packet.save_id);
    assert.equal(r.store.meta().canon_revision, 8);
    assert.deepEqual(await a.getRemoteRevision(), { canon_revision: 7 });
    const m = await a.pullCanon();
    assert.equal(m.files.operational_canon, "remote text");
  } finally { r.cleanup(); }
  const bad = new WebhookPersistenceAdapter({ campaignId: "c", endpointEnv: "U", env: { U: "https://example.invalid/save" }, fetchImpl: async () => ({ ok: false, status: 400, text: async () => "bad" }), retries: 3, sleep: async () => {} });
  let n = 0;
  bad.fetch = async (...args) => { n++; return { ok: false, status: 400, text: async () => "bad" }; };
  await assert.rejects(bad.getRemoteRevision(), /HTTP 400/);
  assert.equal(n, 1, "4xx is not retried");
  assert.throws(() => new WebhookPersistenceAdapter({ campaignId: "c", endpointEnv: "MISSING", env: {} }), /not set/);
});
