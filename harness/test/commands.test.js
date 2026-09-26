import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";
import { routeCommand, parseCommand, reopenStore } from "../src/commands/router.js";
import { LocalFilesystemPersistenceAdapter } from "../src/persistence/local.js";
import { silentLogger } from "../src/lib/log.js";

function deps(r, extra = {}) {
  const d = { store: r.store, runner: r.runner, sessions: r.sessions, clock: r.clock, caller: r.caller, log: silentLogger, ...extra };
  d.reopen = () => { reopenStore(d); r.store = d.store; };
  return d;
}

test("parseCommand and disabled commands", async () => {
  assert.deepEqual(parseCommand("/save --dry-run"), { name: "save", args: "--dry-run", argv: ["--dry-run"] });
  assert.equal(parseCommand("plain text"), null);
  const r = makeRunner({ manifestPatch: (m) => { m.commands = { enabled: ["help"] }; return m; } });
  try {
    const out = await routeCommand("/save", deps(r));
    assert.match(out.text, /disabled/);
    assert.equal((await routeCommand("hello", deps(r))).handled, false);
  } finally { r.cleanup(); }
});

test("/status, /mode, /scene, /context, /good, /flat, /ooc, /resume", async () => {
  const r = makeRunner({ responses: { director: [directorPacket(), "As GM: nothing changes."], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    const d = deps(r);
    let t = (await routeCommand("/status", d)).text;
    assert.match(t, /revision 0/); assert.match(t, /mode play, presentation scene/);
    t = (await routeCommand("/mode development", d)).text; assert.match(t, /play → development/); assert.equal(r.store.scene().mode, "development");
    t = (await routeCommand("/mode chaos", d)).text; assert.match(t, /not enabled/);
    await routeCommand("/mode play", d);
    t = (await routeCommand("/scene pressure", d)).text; assert.match(t, /pinned/); assert.equal(r.store.scene().presentation_forced, true);
    t = (await routeCommand("/scene auto", d)).text; assert.match(t, /unpinned/);
    t = (await routeCommand("/context director I ask <NPC_A>", d)).text; assert.match(t, /no model call/); assert.match(t, /involved: .*npc_a/);
    t = (await routeCommand("/good", d)).text; assert.match(t, /No delivered turn/);
    const res = await r.runner.run({ text: "x", eventId: "e1" });
    r.runner.markDelivered(res.turn.turn_id, { transport: "cli" });
    t = (await routeCommand("/good great restraint", d)).text; assert.match(t, /exemplar/); assert.match(t, /Note: great restraint/);
    t = (await routeCommand("/good", d)).text; assert.match(t, /already marked/);
    t = (await routeCommand(`/flat ${res.turn.turn_id} too tidy`, d)).text; assert.match(t, /anti-exemplar/);
    t = (await routeCommand("/ooc is this canon?", d, { eventId: "e2" })).text; assert.match(t, /^\(\( ooc \)\)/); assert.equal(r.store.meta().revision, 1, "ooc committed nothing");
    t = (await routeCommand("/resume", d)).text; assert.match(t, /Specialist caches reset/);
    t = (await routeCommand("/help", d)).text; assert.match(t, /\/save/);
  } finally { r.cleanup(); }
});

test("/save and /sync through the router with the local adapter; /branch lifecycle", async () => {
  const r = makeRunner({ responses: { director: [directorPacket(), directorPacket({ fact_proposals: [], knowledge_events: [], mind_deltas: [] })], novelist: [NOVELIST_PROSE, NOVELIST_PROSE], editor: [EDITOR_OK, EDITOR_OK] } });
  try {
    const adapter = new LocalFilesystemPersistenceAdapter({ dir: path.join(r.dir, "persistence") });
    adapter.seedFrom(r.store);
    const d = deps(r, { adapter });
    let t = (await routeCommand("/save", d)).text; assert.match(t, /nothing to save/);
    await r.runner.run({ text: "x", eventId: "e1" });
    t = (await routeCommand("/save --dry-run", d)).text; assert.match(t, /Nothing sent/);
    t = (await routeCommand("/save", d)).text; assert.match(t, /Saved 1 turn/);
    t = (await routeCommand("/sync", d)).text; assert.match(t, /current/);
    t = (await routeCommand("/branch create alt a test", d)).text; assert.match(t, /created from revision 1/);
    assert.equal(d.store.branch, "alt");
    await r.runner.run({ text: "y", eventId: "e2" });
    t = (await routeCommand("/save", d)).text; assert.match(t, /branch/);
    t = (await routeCommand("/branch list", d)).text; assert.match(t, /alt \[active\]/);
    t = (await routeCommand("/branch discard alt", d)).text; assert.match(t, /confirmation/);
    t = (await routeCommand("/resume", d)).text; assert.match(t, /Left branch/);
    assert.equal(d.store.branch, null);
    assert.equal(d.store.meta().revision, 1);
    t = (await routeCommand("/branch discard alt alt", d)).text; assert.match(t, /discarded/);
  } finally { r.cleanup(); }
});
