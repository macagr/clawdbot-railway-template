import test from "node:test";
import assert from "node:assert/strict";
import { makeRunner } from "./runner-helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";
import { DiscordTransport, chunkForDiscord, authorizeDiscordEvent, normalizeDiscordEvent, discordCommandLine, discordCommandPrefix } from "../src/transport/discord.js";
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

test("discord command prefix: !cmd reaches the harness command, args preserved, unknown !foo is not a turn, prose stays play, / still works", async () => {
  const r = makeRunner({ responses: { director: [directorPacket()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] } });
  try {
    const m = r.store.manifest;
    assert.equal(discordCommandPrefix(m), "!");
    assert.equal(discordCommandLine("!status", m), "/status");
    assert.equal(discordCommandLine("  !context novelist ", m), "/context novelist");
    assert.equal(discordCommandLine("!sync --status", m), "/sync --status");
    assert.equal(discordCommandLine("!mode play", m), "/mode play");
    assert.equal(discordCommandLine("!ooc hello   there", m), "/ooc hello   there", "argument text preserved");
    assert.equal(discordCommandLine("!BRANCH list", m), "/branch list");
    assert.equal(discordCommandLine("!foo bar", m), "/foo bar", "unknown names still route to the router's unknown-command answer");
    for (const play of ["I wait.", "Hello! How are you?", "! alone with a space", "!", "!123", "She shouted 'no!' and ran.", "Fine!status", "!-x"]) assert.equal(discordCommandLine(play, m), null, `${JSON.stringify(play)} is play`);
    assert.equal(discordCommandLine("/status", m), "/status", "enabled canonical slash commands still accepted at the boundary");
    assert.equal(discordCommandLine("/nonsense", m), null, "unknown slash text is not a harness command");
    const custom = structuredClone(m); custom.discord.command_prefix = "!!";
    assert.equal(discordCommandLine("!!status", custom), "/status"); assert.equal(discordCommandLine("!status", custom), null);

    const d = new DiscordTransport(deps(r));
    let c = await d.handleInbound(ev({ message_id: "c1", text: "!status" }));
    assert.equal(c.command, true); assert.equal(c.command_line, "/status"); assert.match(c.chunks[0], /revision 0/);
    assert.equal(r.store.meta().revision, 0, "no turn");
    c = await d.handleInbound(ev({ message_id: "c2", text: "!context" }));
    assert.match(c.chunks[0], /Director selection/);
    c = await d.handleInbound(ev({ message_id: "c3", text: "!mode play" }));
    assert.match(c.chunks[0], /Already in play/);
    c = await d.handleInbound(ev({ message_id: "c4", text: "!help" }));
    assert.match(c.chunks[0], /^!help — /m); assert.match(c.chunks[0], /!status — /); assert.doesNotMatch(c.chunks[0], /^\/[a-z]/m);
    c = await d.handleInbound(ev({ message_id: "c5", text: "!foo bar" }));
    assert.equal(c.command, true); assert.match(c.chunks[0], /Unknown or disabled command !foo\. Try !help\./);
    assert.equal(r.store.meta().revision, 0, "unknown prefixed command created no turn");
    assert.equal(r.store.listTurnIds().length, 0);
    const play = await d.handleInbound(ev({ message_id: "p1", text: "Hello! I keep working on the car." }));
    assert.ok(play.turn_id); assert.equal(r.store.meta().revision, 1);
    const dup = await d.handleInbound(ev({ message_id: "p1", text: "Hello! I keep working on the car." }));
    assert.equal(dup.reused, true); assert.equal(r.store.meta().revision, 1, "idempotent on message id");
    const sameCmdAgain = await d.handleInbound(ev({ message_id: "c1", text: "!status" }));
    assert.match(sameCmdAgain.chunks[0], /revision 1/, "commands are not deduplicated (they are reads/ops, not turns)");
  } finally { r.cleanup(); }
});

test("discord: threads never create branches implicitly", async () => {
  const r = makeRunner({ manifestPatch: (m) => { m.discord.threads = "branches_on_request"; return m; } });
  try {
    const d = new DiscordTransport(deps(r));
    const res = await d.handleInbound(ev({ message_id: "m9", thread_id: "th1", channel_id: "th1", text: "I sneak out." }));
    assert.equal(res.refused, true);
    assert.match(res.chunks[0], /!branch create/);
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
