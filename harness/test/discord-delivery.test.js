// End-to-end coordinator/Discord delivery protocol, simulated exactly as the generated coordinator
// instructions describe it: `rp discord --event-env` (event JSON in RP_DISCORD_EVENT_JSON, spawned
// process, no shell) → chunks → message tool → `rp deliver` with the returned message ids → NO_REPLY.
import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_DIR } from "./helpers.js";
import { directorPacket, NOVELIST_PROSE, EDITOR_OK } from "./fixtures/packets.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const NASTY = "hello ' \" $HOME $(touch /tmp/SHOULD_NOT_EXIST) `id`\nfoo; echo bad\na && b\nx | y\n<tag>\n> redirect\nmultiline text\nheredoc <<'EOF'\nEOF";
// ~3000 chars of neutral prose (under the 3500 output cap, over one Discord message).
const LONG_PROSE = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}. ${"The rain kept its own slow time on the roof while nobody in the room said anything worth writing down. ".repeat(5).trim()}`).join("\n\n");

function rp(args, { env = {}, input } = {}) {
  const r = childProcess.spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input, env: { ...process.env, RP_LOG_LEVEL: "silent", ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, argv: args };
}
const ev = (over = {}) => ({ message_id: "m1", channel_id: "channel_fixture", guild_id: "guild_fixture", user_id: "user_fixture", text: "I wait.", ...over });

/** The coordinator, as instructed: exec rp discord, post chunks, confirm delivery, or stop on a failed send. */
function coordinator(ws, event, { env = {}, send }) {
  const argv = ["discord", "--campaign", ws, "--event-env"];
  const r = rp(argv, { env: { ...env, RP_DISCORD_EVENT_JSON: JSON.stringify(event) } });
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  const ids = []; let sendFailed = null;
  if (!out.refused) for (const chunk of out.chunks) { try { ids.push(send(chunk)); } catch (err) { sendFailed = err.message; break; } }
  let deliver = null;
  if (out.turn_id && !sendFailed) {
    deliver = rp(["deliver", "--campaign", ws, "--turn", out.turn_id, "--transport", "discord", ...ids.flatMap((id) => ["--message-id", id])]);
    assert.equal(deliver.code, 0, deliver.err);
  }
  return { argv, out, ids, sendFailed, deliver, finalReply: "NO_REPLY" };
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rp-dd-"));
  const pkg = path.join(base, "pkg"), ws = path.join(base, "ws");
  fs.cpSync(FIXTURE_DIR, pkg, { recursive: true });
  assert.equal(rp(["campaign", "install", "--from", pkg, "--to", ws]).code, 0);
  const responses = (obj) => { const p = path.join(base, `r-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(p, JSON.stringify(obj)); return { RP_FAKE_RESPONSES: p }; };
  const turnFiles = () => fs.readdirSync(path.join(ws, "runtime", "turns")).filter((f) => f.endsWith(".json"));
  const turn = (id) => JSON.parse(fs.readFileSync(path.join(ws, "runtime", "turns", `${id}.json`), "utf8"));
  return { base, ws, responses, turnFiles, turn, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("A. normal PLAY: hostile text via env arrives exactly, one commit, >2000 chars → ordered multi-chunk send, real ids confirm delivery", () => {
  const s = setup();
  try {
    const env = s.responses({ director: [directorPacket({ form: { ...directorPacket().form, length_band: "long" } })], novelist: [LONG_PROSE], editor: [EDITOR_OK] });
    const sent = [];
    const res = coordinator(s.ws, ev({ message_id: "play-1", text: NASTY }), { env, send: (c) => { sent.push(c); return `dm-${sent.length}`; } });
    assert.ok(res.out.turn_id, "turn id returned");
    assert.ok(res.out.chunks.length >= 2, `multi-chunk (${res.out.chunks.length})`);
    assert.ok(res.out.chunks.every((c) => c.length <= 2000));
    assert.deepEqual(sent, res.out.chunks, "every chunk sent, in order, unchanged");
    assert.equal(res.out.chunks.join("\n\n").includes("Paragraph 6."), true, "whole output delivered");
    assert.deepEqual(res.ids, sent.map((_, i) => `dm-${i + 1}`));
    assert.match(res.deliver.out, /delivered/);
    const t = s.turn(res.out.turn_id);
    assert.equal(t.status, "delivered");
    assert.deepEqual(t.delivery.message_ids, res.ids, "the actual Discord ids were recorded");
    assert.equal(t.delivery.transport, "discord");
    assert.equal(t.input.text, NASTY, "player text reached the harness exactly");
    assert.equal(t.event_id, "discord:play-1");
    assert.equal(s.turnFiles().length, 1, "committed once");
    assert.ok(!res.argv.some((a) => a.includes("hello") || a.includes("$(") || a.includes("<<")), "no player text in the command");
    assert.ok(!fs.existsSync("/tmp/SHOULD_NOT_EXIST") && !fs.existsSync(path.join(os.tmpdir(), "SHOULD_NOT_EXIST")), "no shell side effect");
    assert.match(rp(["status", "--campaign", s.ws]).out, /revision 1[\s\S]*undelivered turns: 0/);
    assert.equal(rp(["pending", "--campaign", s.ws]).out.trim(), "[]");
  } finally { s.cleanup(); }
});

test("B+C+D. send failure keeps the turn committed-undelivered; !resume redelivers it without any model call and confirms the ORIGINAL turn; duplicate inbound events reuse", () => {
  const s = setup();
  try {
    const env = s.responses({ director: [directorPacket({ form: { ...directorPacket().form, length_band: "long" } })], novelist: [LONG_PROSE], editor: [EDITOR_OK] });
    // B: second send fails
    let n = 0;
    const res = coordinator(s.ws, ev({ message_id: "play-2", text: "I keep working." }), { env, send: () => { n++; if (n === 2) throw new Error("discord 5xx"); return `dm-${n}`; } });
    assert.ok(res.out.turn_id); assert.ok(res.sendFailed); assert.equal(res.deliver, null, "rp deliver NOT called");
    const id = res.out.turn_id;
    assert.equal(s.turn(id).status, "committed", "canon kept; turn stays committed-but-undelivered");
    assert.match(rp(["status", "--campaign", s.ws]).out, /revision 1[\s\S]*undelivered turns: 1/);
    assert.match(rp(["pending", "--campaign", s.ws]).out, new RegExp(id));

    // D: duplicate inbound event (retry/double delivery) reuses; no new turn, no new revision
    const dup = coordinator(s.ws, ev({ message_id: "play-2", text: "I keep working." }), { env: s.responses({ director: [] }), send: () => { throw new Error("do not resend here"); } });
    assert.equal(dup.out.reused, true); assert.equal(dup.out.turn_id, id);
    assert.deepEqual(dup.out.chunks, res.out.chunks);
    assert.equal(s.turnFiles().length, 1);
    assert.match(rp(["status", "--campaign", s.ws]).out, /revision 1/);

    // C: fresh process (= restart/session reset), !resume with NO model responses available
    const sent = [];
    const resume = coordinator(s.ws, ev({ message_id: "cmd-resume", text: "!resume" }), { env: s.responses({ director: [], novelist: [], editor: [] }), send: (c) => { sent.push(c); return `dm-r${sent.length}`; } });
    assert.equal(resume.out.command, true); assert.equal(resume.out.redelivery, true);
    assert.equal(resume.out.turn_id, id, "redelivery names the ORIGINAL committed turn");
    assert.match(resume.out.chunks[0], /never delivered; redelivering/);
    assert.equal(resume.out.chunks.slice(1).join("\n\n"), res.out.chunks.join("\n\n"), "the stored output is resent as-is");
    assert.ok(resume.deliver, "deliver called after all chunks were sent");
    const t = s.turn(id);
    assert.equal(t.status, "delivered"); assert.deepEqual(t.delivery.message_ids, resume.ids);
    assert.equal(s.turnFiles().length, 1, "no replacement turn was generated");
    assert.match(rp(["status", "--campaign", s.ws]).out, /revision 1[\s\S]*undelivered turns: 0/);
    assert.equal(rp(["pending", "--campaign", s.ws]).out.trim(), "[]");
    // !resume with nothing pending: no turn_id, nothing to deliver
    const again = coordinator(s.ws, ev({ message_id: "cmd-resume-2", text: "!resume" }), { env: s.responses({ director: [] }), send: () => "dm-x" });
    assert.equal(again.out.turn_id, undefined); assert.equal(again.out.redelivery, undefined); assert.equal(again.deliver, null);
  } finally { s.cleanup(); }
});

test("E+F. commands pass through rp discord (no turn, no turn_id); refusals; --event-env validation; nothing shell-shaped", () => {
  const s = setup();
  try {
    const env = s.responses({ director: [] });
    for (const [text, re] of [["!status", /revision 0/], ["!help", /^!help — /m], ["!context", /Director selection/], ["!foo", /Unknown or disabled command !foo\. Try !help\./]]) {
      const r = coordinator(s.ws, ev({ message_id: `c-${text}`, text }), { env, send: () => "dm" });
      assert.equal(r.out.command, true, text); assert.equal(r.out.turn_id, undefined, text); assert.equal(r.deliver, null);
      assert.ok(r.out.chunks.every((c) => c.length <= 2000)); assert.match(r.out.chunks[0], re);
    }
    assert.equal(s.turnFiles().length, 0, "commands created no turns");
    const refused = rp(["discord", "--campaign", s.ws, "--event-env"], { env: { RP_DISCORD_EVENT_JSON: JSON.stringify(ev({ user_id: "stranger" })) } });
    assert.equal(refused.code, 3); assert.equal(JSON.parse(refused.out).refused, true);
    // validation of the event source
    let r = rp(["discord", "--campaign", s.ws, "--event-env"]);
    assert.equal(r.code, 1); assert.match(r.err, /RP_DISCORD_EVENT_JSON is not set or empty/); assert.doesNotMatch(r.err, /PATH=/);
    r = rp(["discord", "--campaign", s.ws, "--event-env"], { env: { RP_DISCORD_EVENT_JSON: "{oops" } });
    assert.equal(r.code, 1); assert.match(r.err, /RP_DISCORD_EVENT_JSON: invalid JSON/);
    r = rp(["discord", "--campaign", s.ws, "--event-env"], { env: { RP_DISCORD_EVENT_JSON: "[1]" } });
    assert.equal(r.code, 1); assert.match(r.err, /expected a JSON object/);
    r = rp(["discord", "--campaign", s.ws, "--event-env", "OTHER_VAR"], { env: { RP_DISCORD_EVENT_JSON: "{}", OTHER_VAR: "{}" } });
    assert.equal(r.code, 1); assert.match(r.err, /takes no value; it always reads RP_DISCORD_EVENT_JSON/);
    const file = path.join(s.base, "ev.json"); fs.writeFileSync(file, JSON.stringify(ev({ message_id: "f1", text: "!status" })));
    r = rp(["discord", "--campaign", s.ws, "--event", file, "--event-env"], { env: { RP_DISCORD_EVENT_JSON: "{}" } });
    assert.equal(r.code, 1); assert.match(r.err, /conflicting event sources/);
    r = rp(["discord", "--campaign", s.ws]);
    assert.equal(r.code, 1); assert.match(r.err, /use --event <json file\|-> or --event-env/);
    // legacy forms still work for CLI/tests
    r = rp(["discord", "--campaign", s.ws, "--event", file]); assert.equal(r.code, 0, r.err); assert.match(JSON.parse(r.out).chunks[0], /revision 0/);
    r = rp(["discord", "--campaign", s.ws, "--event", "-"], { input: JSON.stringify(ev({ message_id: "s1", text: "!status" })) }); assert.equal(r.code, 0, r.err);
    // event without message id is rejected (dedup key)
    r = rp(["discord", "--campaign", s.ws, "--event-env"], { env: { RP_DISCORD_EVENT_JSON: JSON.stringify({ text: "x", channel_id: "channel_fixture", user_id: "user_fixture" }) } });
    assert.equal(r.code, 1); assert.match(r.err, /message id/);
  } finally { s.cleanup(); }
});
