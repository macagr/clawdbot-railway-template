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

function rp(args, { env = {}, input } = {}) {
  const r = childProcess.spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input, env: { ...process.env, RP_LOG_LEVEL: "silent", ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// The exact strings a hostile or merely unlucky player might type. Nothing here may be shell-parsed.
const NASTY = [
  "hello ' \" $HOME $(touch /tmp/SHOULD_NOT_EXIST) `id`",
  "foo; echo bad",
  "a && b",
  "x | y",
  "<tag>",
  "> redirect",
  "multiline text\nsecond line\n\tthird line with tab and trailing spaces   ",
  "heredoc marker <<'EOF'\nEOF",
].join("\n");

test("--text-env: player text travels as process environment, survives byte-for-byte, never enters the command string; validation; idempotency", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rp-cli-env-"));
  const pkg = path.join(base, "pkg"), ws = path.join(base, "ws");
  fs.cpSync(FIXTURE_DIR, pkg, { recursive: true });
  const responses = path.join(base, "responses.json");
  fs.writeFileSync(responses, JSON.stringify({ director: [directorPacket()], novelist: [NOVELIST_PROSE], editor: [EDITOR_OK] }));
  const shouldNotExist = ["/tmp/SHOULD_NOT_EXIST", path.join(os.tmpdir(), "SHOULD_NOT_EXIST")];
  try {
    for (const p of shouldNotExist) fs.rmSync(p, { force: true });
    assert.equal(rp(["campaign", "install", "--from", pkg, "--to", ws]).code, 0);
    // Exactly what the coordinator's exec call is: an argument list plus one env var. No shell involved.
    const argv = ["turn", "--campaign", ws, "--transport", "discord", "--event-id", "discord:env-1", "--text-env"];
    assert.ok(!argv.join(" ").includes("hello") && !argv.some((a) => NASTY.includes(a)), "player text is absent from the command string");
    let r = rp(argv, { env: { RP_FAKE_RESPONSES: responses, RP_PLAYER_INPUT: NASTY } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /You remembered it/);
    const turnFiles = fs.readdirSync(path.join(ws, "runtime", "turns")).filter((f) => f.endsWith(".json"));
    assert.equal(turnFiles.length, 1);
    const turn = JSON.parse(fs.readFileSync(path.join(ws, "runtime", "turns", turnFiles[0]), "utf8"));
    assert.equal(turn.input.text, NASTY, "player text reached the harness exactly (quotes, $(...), backticks, newlines, tabs, trailing spaces)");
    assert.equal(turn.event_id, "discord:env-1");
    for (const p of shouldNotExist) assert.ok(!fs.existsSync(p), `no shell side effect: ${p}`);
    assert.ok(!fs.readdirSync(base).some((f) => /tmp|input/i.test(f)), "no temporary input file was written");
    // idempotency unchanged: same event id => same output, no new revision, even with different env text
    const dup = rp(argv, { env: { RP_FAKE_RESPONSES: responses, RP_PLAYER_INPUT: "something else entirely" } });
    assert.equal(dup.code, 0, dup.err);
    assert.equal(dup.out, r.out);
    assert.match(rp(["status", "--campaign", ws]).out, /revision 1/);
    assert.equal(fs.readdirSync(path.join(ws, "runtime", "turns")).filter((f) => f.endsWith(".json")).length, 1);
    // validation
    r = rp(["turn", "--campaign", ws, "--transport", "discord", "--text-env"], { env: { RP_FAKE_RESPONSES: responses } });
    assert.equal(r.code, 1); assert.match(r.err, /RP_PLAYER_INPUT is not set/); assert.doesNotMatch(r.err, /HOME|PATH=/);
    r = rp(["turn", "--campaign", ws, "--text-env"], { env: { RP_PLAYER_INPUT: "   \n" } });
    assert.equal(r.code, 1); assert.match(r.err, /player message is empty/);
    r = rp(["turn", "--campaign", ws, "--text-env", "--text", "x"], { env: { RP_PLAYER_INPUT: "y" } });
    assert.equal(r.code, 1); assert.match(r.err, /conflicting input sources --text and --text-env/);
    r = rp(["turn", "--campaign", ws, "--stdin", "--text-env"], { env: { RP_PLAYER_INPUT: "y" }, input: "z" });
    assert.equal(r.code, 1); assert.match(r.err, /conflicting input sources/);
    r = rp(["turn", "--campaign", ws, "--text-env", "SOME_OTHER_VAR"], { env: { RP_PLAYER_INPUT: "y", SOME_OTHER_VAR: "no" } });
    assert.equal(r.code, 1); assert.match(r.err, /takes no value; it always reads RP_PLAYER_INPUT/);
    r = rp(["turn", "--campaign", ws]);
    assert.equal(r.code, 1); assert.match(r.err, /exactly one of --text <t>, --stdin, or --text-env/);
    // the environment variable is ignored unless --text-env is given
    r = rp(["turn", "--campaign", ws, "--event-id", "t2", "--text", "plain"], { env: { RP_FAKE_RESPONSES: path.join(base, "none.json"), RP_PLAYER_INPUT: "ignored" } });
    assert.equal(r.code, 2, "ran a turn from --text (model failure expected with no responses), not from the env var");
    assert.match(rp(["status", "--campaign", ws]).out, /revision 1/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); for (const p of shouldNotExist) fs.rmSync(p, { force: true }); }
});

test("CLI end to end: install, turn via stdin, status, validate, dry-run-save, pending/deliver, reconstruct-check, export", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rp-cli-"));
  const pkg = path.join(base, "pkg"), ws = path.join(base, "ws");
  fs.cpSync(FIXTURE_DIR, pkg, { recursive: true });
  const responses = path.join(base, "responses.json");
  fs.writeFileSync(responses, JSON.stringify({ director: [directorPacket(), directorPacket({ fact_proposals: [], knowledge_events: [], mind_deltas: [] })], novelist: [NOVELIST_PROSE, NOVELIST_PROSE], editor: [EDITOR_OK, EDITOR_OK] }));
  const env = { RP_FAKE_RESPONSES: responses };
  try {
    let r = rp(["campaign", "install", "--from", pkg, "--to", ws]);
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(path.join(ws, "state", "meta.json")));
    r = rp(["turn", "--campaign", ws, "--event-id", "cli-1", "--stdin"], { env, input: "I keep working on the car." });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /You remembered it/);
    assert.doesNotMatch(r.out, /⟦/);
    r = rp(["turn", "--campaign", ws, "--event-id", "cli-1", "--stdin"], { env, input: "duplicate" });
    assert.match(r.out, /You remembered it/, "duplicate event id redelivers");
    r = rp(["status", "--campaign", ws]);
    assert.match(r.out, /revision 1/);
    r = rp(["command", "--campaign", ws, "--", "/mode", "development"]);
    assert.match(r.out, /play → development/);
    rp(["command", "--campaign", ws, "--", "/mode", "play"]);
    r = rp(["validate", "--campaign", ws]);
    assert.equal(r.code, 0, r.out);
    r = rp(["dry-run-save", "--campaign", ws]);
    assert.match(r.out, /"turns": 1/);
    r = rp(["turn", "--campaign", ws, "--event-id", "d-1", "--transport", "discord", "--text", "again"], { env });
    assert.equal(r.code, 0, r.err);
    // Discord boundary in the CLI: prefixed commands never become turns, on either entry point
    r = rp(["turn", "--campaign", ws, "--event-id", "d-cmd", "--transport", "discord", "--text", "!status"], { env });
    assert.equal(r.code, 0, r.err); assert.match(r.out, /revision 2/);
    r = rp(["command", "--campaign", ws, "--transport", "discord", "--", "!sync", "--status"]);
    assert.equal(r.code, 0, r.err); assert.match(r.out, /sync status|no persistence|failed/);
    r = rp(["command", "--campaign", ws, "--transport", "discord", "--", "!nothing"]);
    assert.match(r.out, /Unknown or disabled command !nothing\. Try !help\./);
    r = rp(["command", "--campaign", ws, "--", "/nothing"]);
    assert.match(r.out, /Unknown or disabled command \/nothing\. Try \/help\./, "CLI keeps the canonical form");
    r = rp(["status", "--campaign", ws]);
    assert.match(r.out, /revision 2/, "no turn was created by prefixed commands");
    r = rp(["pending", "--campaign", ws]);
    assert.match(r.out, /campaign_fixture-000002/);
    r = rp(["deliver", "--campaign", ws, "--turn", "campaign_fixture-000002", "--message-id", "m1", "--transport", "discord"]);
    assert.match(r.out, /delivered/);
    r = rp(["reconstruct-check", "--campaign", ws]);
    assert.equal(r.code, 0, r.out);
    const out = path.join(base, "export.json");
    r = rp(["export-state", "--campaign", ws, "--out", out]);
    assert.ok(fs.existsSync(out));
    r = rp(["setup-openclaw", "--campaign", ws, "--dry-run", "--workspaces-root", base]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /openclaw config set --strict-json agents\.entries\.campaign_fixture/);
    r = rp(["lint-generic"]);
    assert.equal(r.code, 0, r.out);
    const empty = path.join(base, "empty.json");
    fs.writeFileSync(empty, JSON.stringify({ director: [] }));
    r = rp(["turn", "--campaign", ws, "--text", "no responses left"], { env: { RP_FAKE_RESPONSES: empty } });
    assert.equal(r.code, 2, "model failure exits non-zero and reports");
    assert.match(r.out, /Nothing was recorded/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
