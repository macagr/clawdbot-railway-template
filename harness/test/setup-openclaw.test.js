import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRunner } from "./runner-helpers.js";
import { openclawConfigFor, configSetOps, writeWorkspaces, applyConfig, approvalOps, ALLOWED_CONFIG_KEY_PATTERNS } from "../src/openclaw/setup.js";

test("openclaw config: one coordinator + specialists, explicit ownership, Discord binding, tool and command policies", () => {
  const r = makeRunner();
  try {
    const cfg = openclawConfigFor(r.store, { rpBin: "/opt/rp-harness/bin/rp", workspacesRoot: "/data/workspaces" });
    assert.deepEqual(Object.keys(cfg.agents.entries), ["campaign_fixture", "campaign_fixture-director", "campaign_fixture-novelist", "campaign_fixture-editor"]);
    assert.equal(cfg.agents.ownership, "explicit");
    assert.deepEqual(cfg.agents.entries.campaign_fixture.tools, { allow: ["exec"] });
    assert.deepEqual(cfg.agents.entries["campaign_fixture-director"].tools, { allow: [] });
    assert.equal(cfg.agents.entries["campaign_fixture-director"].workspace, path.join("/data/workspaces", "campaign_fixture-director"));
    assert.equal(cfg.bindings[0].match.peer.id, "channel_fixture");
    assert.equal(cfg.bindings[0].match.guildId, "guild_fixture");
    assert.deepEqual(cfg.discord.guilds.guild_fixture.channels.channel_fixture, { requireMention: false, users: ["user_fixture"] }, "only schema-valid per-channel keys");
    assert.deepEqual(cfg.tools.exec, { mode: "allowlist" }, "exec policy is mode only; no config-level allowlist");
    assert.deepEqual(cfg.approvals, [{ agentId: "campaign_fixture", pattern: "/opt/rp-harness/bin/rp" }]);
    assert.deepEqual(cfg.commands.allowFrom.discord, ["user:user_fixture"]);
    assert.ok(!("model" in cfg.agents.entries.campaign_fixture), "fake/ models are not written to OpenClaw");
    const ops = configSetOps(cfg);
    assert.ok(ops.some(([k]) => k === "bindings"));
    assert.ok(ops.some(([k]) => k === "tools.sessions.visibility"));
    assert.ok(ops.some(([k, v]) => k === "tools.exec.mode" && v === "allowlist"));
    const pm = ops.filter(([k]) => k.endsWith(".promptMode"));
    assert.deepEqual(pm.map(([k]) => k), ["agents.entries.campaign_fixture-director.promptMode", "agents.entries.campaign_fixture-novelist.promptMode", "agents.entries.campaign_fixture-editor.promptMode"], "specialists only, never the coordinator");
    assert.ok(pm.every(([, v, o]) => v === "minimal" && o.optional));
  } finally { r.cleanup(); }
});

test("live-schema guard: generated config keys stay within the OpenClaw 2026.9.5 keys that validated live", () => {
  const r = makeRunner();
  try {
    const ops = configSetOps(openclawConfigFor(r.store));
    const sets = ops.filter(([, , o]) => !o || o.op !== "unset");
    for (const [key] of sets) assert.ok(ALLOWED_CONFIG_KEY_PATTERNS.some((re) => re.test(key)), `unexpected config key ${key}`);
    const setKeys = sets.map(([k]) => k);
    for (const bad of ["tools.exec.security", "tools.exec.allowlist", "tools.exec.ask"]) assert.ok(!setKeys.includes(bad), `${bad} is never SET (not a valid 2026.9.5 key)`);
    // legacy keys are unset (tolerated) before mode is set, so mode never collides with them
    const idx = (k, op) => ops.findIndex(([key, , o]) => key === k && (o?.op || "set") === op);
    assert.ok(idx("tools.exec.security", "unset") >= 0 && idx("tools.exec.ask", "unset") >= 0);
    assert.ok(idx("tools.exec.security", "unset") < idx("tools.exec.mode", "set"));
    assert.ok(ops.find(([k, , o]) => k === "tools.exec.security")[2].optional);
    const channelOp = ops.find(([k]) => k.startsWith("channels.discord.guilds."));
    assert.ok(!("historyLimit" in channelOp[1]), "historyLimit is channel-wide, not per channel");
    // exec must never be broadened by the generator
    assert.ok(!ops.some(([k, v]) => k === "tools.exec.mode" && v !== "allowlist"));
  } finally { r.cleanup(); }
});

test("approvals: narrow path-only allowlist entry for the coordinator via the approvals CLI, idempotent by contract", () => {
  const r = makeRunner();
  try {
    const cfg = openclawConfigFor(r.store, { rpBin: "/opt/rp-harness/bin/rp" });
    const ops = approvalOps(cfg);
    assert.equal(ops.length, 1);
    assert.deepEqual(ops[0].args, ["approvals", "allowlist", "add", "--gateway", "--agent", "campaign_fixture", "/opt/rp-harness/bin/rp"], "pattern is positional; there is no --pattern flag");
    assert.ok(!ops[0].args.includes("*"), "no wildcard patterns");
  } finally { r.cleanup(); }
});

test("workspaces: coordinator AGENTS.md relays only; specialists get self-contained task instructions", () => {
  const r = makeRunner();
  try {
    const written = writeWorkspaces(r.store, { workspacesRoot: path.join(r.dir, "..", `ws-${path.basename(r.dir)}`), transport: "discord" });
    const coord = fs.readFileSync(path.join(r.dir, "AGENTS.md"), "utf8");
    assert.match(coord, /rp turn --campaign campaign_fixture --transport discord/);
    assert.match(coord, /Never read, quote, or reason about files/);
    const spec = written.find((w) => w.includes("campaign_fixture-director"));
    assert.match(fs.readFileSync(spec, "utf8"), /Director specialist/);
    fs.rmSync(path.dirname(path.dirname(spec)), { recursive: true, force: true });
  } finally { r.cleanup(); }
});

test("applyConfig: dry run prints config and approval commands; config failure aborts; approval failure yields an operator instruction, never a broader policy", async () => {
  const r = makeRunner();
  try {
    const cfg = openclawConfigFor(r.store);
    const lines = [];
    const dry = await applyConfig(cfg, { dryRun: true, log: (l) => lines.push(l) });
    assert.equal(dry.length + dry.approvals.length, lines.length);
    assert.match(lines[0], /^openclaw config set --strict-json agents\.entries\.campaign_fixture /);
    assert.ok(lines.includes("openclaw config unset tools.exec.security"));
    assert.match(lines.at(-1), /^openclaw approvals allowlist add --gateway --agent campaign_fixture \/opt\/rp-harness\/bin\/rp$/);
    const calls = [];
    const run = async (bin, args) => { calls.push(args); return { code: args[3]?.endsWith?.("memory.enabled") ? 1 : 0, output: "" }; };
    const ok = await applyConfig(cfg, { run });
    assert.ok(ok.length > 5);
    assert.equal(ok.approvals[0].code, 0);
    assert.deepEqual(ok.instructions, []);
    await assert.rejects(applyConfig(cfg, { run: async () => ({ code: 2, output: "nope" }) }), /failed \(2\)/);
    const approvalFails = async (bin, args) => (args[0] === "approvals" ? { code: 1, output: "unknown command" } : { code: 0, output: "" });
    const res = await applyConfig(cfg, { run: approvalFails });
    assert.equal(res.instructions.length, 1);
    assert.match(res.instructions[0], /Run manually:\n  openclaw approvals allowlist add --gateway --agent campaign_fixture \/opt\/rp-harness\/bin\/rp/);
    assert.ok(!calls.some((a) => a.includes("full")), "never broadens exec");
  } finally { r.cleanup(); }
});
