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
