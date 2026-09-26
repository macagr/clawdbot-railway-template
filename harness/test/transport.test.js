import test from "node:test";
import assert from "node:assert/strict";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";
import { DiscordTransport, chunkForDiscord, authorizeDiscordEvent, normalizeDiscordEvent } from "../src/transport/discord.js";
import { TextTransport } from "../src/transport/text.js";
import { silentLogger } from "../src/lib/log.js";

function deps(r) { return { store: r.store, runner: r.runner, sessions: r.sessions, clock: r.clock, caller: r.caller, log: silentLogger, reopen() {} }; }
const ev = (over = {}) => ({ message_id: "m1", channel_id: "channel_fixture", guild_id: "guild_fixture", user_id: "user_fixture", text: "I wait.", ...over });

test("discord: channel/guild/user allowlists and thread policy", () => {
  const r = makeRunner();
  try {
    const m = r.store.manifest;
    assert.equal(authorizeDiscordEvent(m, normalizeDiscordEvent(ev())).ok, true);
    assert.match(authorizeDiscordEvent(m, normalizeDiscordEvent(ev({ channel_id: "other" }))).reason, /channel/);
    assert.match(authorizeDiscordEvent(m, normalizeDiscordEvent(ev({ guild_id: "other" }))).reason, /guild/);
    assert.match(authorizeDiscordEvent(m, normalizeDiscordEvent(ev({ user_id: "stranger" }))).reason, /user/);
    const off = structuredClone(m); off.discord.threads = "off";
    assert.match(authorizeDiscordEvent(off, normalizeDiscordEvent(ev({ thread_id: "t1", channel_id: "t1" }))).reason, /threads/);
    assert.throws(() => normalizeDiscordEvent({ text: "x" }), /message id/);
  } finally { r.cleanup(); }
});

test("discord: duplicate message ids, command routing, delivery record, pending redelivery", async () => {
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    const d = new DiscordTransport(deps(r));
    const a = await d.handleInbound(ev());
    assert.ok(a.turn_id);
    assert.ok(a.chunks.length >= 1);
    assert.doesNotMatch(a.chunks.join(""), /⟦/);
    const dup = await d.handleInbound(ev());
    assert.equal(dup.reused, true);
    assert.deepEqual(dup.chunks, a.chunks);
    assert.equal(r.store.meta().revision, 1);
    assert.equal(d.pendingDeliveries().length, 1, "committed but not yet delivered");
    d.confirmDelivery(a.turn_id, ["dm1", "dm2"]);
    assert.equal(d.pendingDeliveries().length, 0);
    assert.deepEqual(r.store.turn(a.turn_id).delivery.message_ids, ["dm1", "dm2"]);
    const c = await d.handleInbound(ev({ message_id: "m2", text: "/status" }));
    assert.equal(c.command, true);
    assert.match(c.chunks[0], /revision 1/);
    const refused = await d.handleInbound(ev({ message_id: "m3", user_id: "stranger" }));
    assert.equal(refused.refused, true);
    assert.equal(r.store.meta().revision, 1);
  } finally { r.cleanup(); }
});

test("discord: threads never create branches implicitly", async () => {
  const r = makeRunner({ manifestPatch: (m) => { m.discord.threads = "branches_on_request"; return m; } });
  try {
    const d = new DiscordTransport(deps(r));
    const res = await d.handleInbound(ev({ message_id: "m9", thread_id: "th1", channel_id: "th1", text: "I sneak out." }));
    assert.equal(res.refused, true);
    assert.match(res.chunks[0], /\/branch create/);
    assert.equal(r.store.meta().revision, 0);
  } finally { r.cleanup(); }
});

test("chunking respects the Discord limit and paragraph boundaries", () => {
  const para = "word ".repeat(300).trim();
  const chunks = chunkForDiscord(`${para}\n\n${para}\n\n${para}`, 2000);
  assert.ok(chunks.every((c) => c.length <= 2000));
  assert.ok(chunks.length >= 2);
  const long = chunkForDiscord("x".repeat(4500), 2000);
  assert.ok(long.every((c) => c.length <= 2000));
  assert.equal(long.join("").length, 4500);
});

test("text transport marks turns delivered immediately and routes commands", async () => {
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    const t = new TextTransport(deps(r), { name: "openclaw-ui" });
    const res = await t.handle("I wait.", { eventId: "ui-1" });
    assert.equal(r.store.turn(res.turn_id).status, "delivered");
    assert.equal(r.store.turn(res.turn_id).transport, "openclaw-ui");
    const c = await t.handle("/status");
    assert.equal(c.command, true);
  } finally { r.cleanup(); }
});
