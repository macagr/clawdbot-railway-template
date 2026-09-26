import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRunner } from "./runner-helpers.js";
import { openclawConfigFor, configSetOps, writeWorkspaces, applyConfig, approvalOps, mergeBindings, readCurrentConfig, ALLOWED_CONFIG_KEY_PATTERNS } from "../src/openclaw/setup.js";

test("openclaw config: one coordinator + specialists, explicit ownership, Discord binding, tool and command policies", () => {
  const r = makeRunner();
  try {
    const cfg = openclawConfigFor(r.store, { rpBin: "/opt/rp-harness/bin/rp", workspacesRoot: "/data/workspaces" });
    assert.deepEqual(Object.keys(cfg.agents.entries), ["campaign_fixture", "campaign_fixture-director", "campaign_fixture-novelist", "campaign_fixture-editor"]);
    assert.equal(cfg.agents.ownership, "explicit");
    // empty allow lists count as unset in OpenClaw (full tool catalog); use profile minimal + deny/alsoAllow
    // channel-routed coordinator: exec (rp) + message (reply); nothing else
    assert.deepEqual(cfg.agents.entries.campaign_fixture.tools, { profile: "minimal", alsoAllow: ["exec", "message"] });
    for (const role of ["director", "novelist", "editor"]) assert.deepEqual(cfg.agents.entries[`campaign_fixture-${role}`].tools, { profile: "minimal", deny: ["*"] }, `${role} stays tool-denied`);
    for (const e of Object.values(cfg.agents.entries)) { assert.ok(!("allow" in e.tools && e.tools.allow.length === 0), "no empty allow lists"); assert.deepEqual(e.skills, []); assert.ok(!("memory" in e)); }
    assert.equal(cfg.discord.enabled, true); assert.equal(cfg.discord.groupPolicy, "allowlist");
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
    assert.ok(!ops.some(([k]) => k.endsWith(".promptMode")), "promptMode is not a per-agent key in 2026.9.5");
    assert.ok(ops.some(([k, v]) => k === "plugins.entries.discord.enabled" && v === true), "Discord plugin explicitly enabled");
    assert.ok(ops.some(([k, v]) => k === "channels.discord.groupPolicy" && v === "allowlist"), "Discord group policy hardened");
    assert.ok(!ops.some(([k]) => /ownerAllowFrom/.test(k)), "players are never promoted to OpenClaw command owners");
    assert.ok(!ops.some(([k]) => /skill_workshop|memory\.enabled$/.test(k) && ops.find((o) => o[0] === k)[1] === true), "no memory/skill features enabled");
  } finally { r.cleanup(); }
});

test("no Discord configured: coordinator gets exec only; no Discord plugin/policy/binding ops", () => {
  const r = makeRunner({ manifestPatch: (m) => { delete m.discord; return m; } });
  try {
    const cfg = openclawConfigFor(r.store);
    assert.deepEqual(cfg.agents.entries.campaign_fixture.tools, { profile: "minimal", alsoAllow: ["exec"] });
    assert.equal(cfg.bindings.length, 0); assert.equal(cfg.discord, null);
    const keys = configSetOps(cfg).map(([k]) => k);
    assert.ok(!keys.some((k) => k.startsWith("plugins.") || k.startsWith("channels.") || k === "bindings"));
  } finally { r.cleanup(); }
});

test("bindings merge: unrelated bindings survive, rerun is idempotent, channel move replaces only this campaign's Discord binding; player allowlist merges", () => {
  const r = makeRunner();
  try {
    const cfg = openclawConfigFor(r.store);
    const other = { agentId: "other_campaign", match: { channel: "discord", guildId: "guild_fixture", peer: { kind: "channel", id: "channel_other" } } };
    const mineElsewhere = { agentId: "campaign_fixture", match: { channel: "telegram", peer: { kind: "dm", id: "x" } } };
    const stale = { agentId: "campaign_fixture", match: { channel: "discord", guildId: "guild_fixture", peer: { kind: "channel", id: "channel_old" } } };
    const current = { bindings: [other, stale, mineElsewhere], commands: { allowFrom: { discord: ["user:operator_fixture", "user:user_fixture"] } } };
    const first = configSetOps(cfg, current);
    const bindings = first.find(([k]) => k === "bindings")[1];
    assert.deepEqual(bindings, [other, mineElsewhere, cfg.bindings[0]], "other agent and other-channel bindings kept; stale Discord binding replaced");
    assert.equal(bindings.filter((b) => b.agentId === "campaign_fixture" && b.match.channel === "discord").length, 1);
    // rerun with the merged result as current: no duplicate, same list
    const second = configSetOps(cfg, { bindings }).find(([k]) => k === "bindings")[1];
    assert.deepEqual(second, bindings);
    // the same campaign moves to a new channel: only its binding changes
    const moved = makeRunner({ manifestPatch: (m) => { m.discord.channel_id = "channel_new"; return m; } });
    try {
      const movedOps = configSetOps(openclawConfigFor(moved.store), { bindings });
      const mb = movedOps.find(([k]) => k === "bindings")[1];
      assert.deepEqual(mb.filter((b) => b.agentId !== "campaign_fixture" || b.match.channel !== "discord"), [other, mineElsewhere]);
      const mine = mb.filter((b) => b.agentId === "campaign_fixture" && b.match.channel === "discord");
      assert.equal(mine.length, 1); assert.equal(mine[0].match.peer.id, "channel_new");
    } finally { moved.cleanup(); }
    assert.deepEqual(mergeBindings(undefined, cfg.bindings), cfg.bindings, "fresh install");
    // allowFrom union keeps the operator's entries; still never ownerAllowFrom
    const allow = first.find(([k]) => k === "commands.allowFrom.discord")[1];
    assert.deepEqual(allow, ["user:operator_fixture", "user:user_fixture"]);
    assert.ok(!first.some(([k]) => k.includes("ownerAllowFrom")));
  } finally { r.cleanup(); }
});

test("readCurrentConfig: missing file is a fresh install; unparseable file is an error (never replace bindings blindly)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-oc-"));
  try {
    assert.deepEqual(readCurrentConfig(dir), {});
    fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify({ bindings: [{ agentId: "a", match: { channel: "discord" } }] }));
    assert.equal(readCurrentConfig(dir).bindings.length, 1);
    fs.writeFileSync(path.join(dir, "openclaw.json"), "{ not json");
    assert.throws(() => readCurrentConfig(dir), /cannot parse/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    assert.match(coord, /`!status`/, "coordinator instructions use the Discord command prefix");
    assert.doesNotMatch(coord, /`\/status`/);
    assert.doesNotMatch(coord, /\{\{/, "no unfilled placeholders");
    const spec = written.find((w) => w.includes("campaign_fixture-director") && w.endsWith("AGENTS.md"));
    assert.match(fs.readFileSync(spec, "utf8"), /Director specialist/);
    const dir = path.dirname(spec);
    // seeded bootstrap files are neutralised: one-line identity files, BOOTSTRAP.md removed
    fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "x".repeat(8000));
    writeWorkspaces(r.store, { workspacesRoot: path.dirname(dir), transport: "discord" });
    assert.ok(!fs.existsSync(path.join(dir, "BOOTSTRAP.md")));
    for (const f of ["IDENTITY.md", "SOUL.md", "USER.md"]) assert.ok(fs.readFileSync(path.join(dir, f), "utf8").length < 200, `${f} is minimal`);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  } finally { r.cleanup(); }
});

test("applyConfig: dry run prints config and approval commands; config failure aborts; approval failure yields an operator instruction, never a broader policy", async () => {
  const r = makeRunner();
  try {
    const cfg = openclawConfigFor(r.store);
    const lines = [];
    const dry = await applyConfig(cfg, { dryRun: true, log: (l) => lines.push(l), current: {} });
    assert.equal(dry.length + dry.approvals.length, lines.length);
    assert.match(lines[0], /^openclaw config set --strict-json agents\.entries\.campaign_fixture /);
    assert.ok(lines.includes("openclaw config unset tools.exec.security"));
    assert.ok(lines.includes("openclaw config set --strict-json plugins.entries.discord.enabled true"));
    assert.ok(lines.includes("openclaw config set --strict-json channels.discord.groupPolicy '\"allowlist\"'"));
    assert.match(lines.at(-1), /^openclaw approvals allowlist add --gateway --agent campaign_fixture \/opt\/rp-harness\/bin\/rp$/);
    const calls = [];
    const run = async (bin, args) => { calls.push(args); return { code: args[3]?.endsWith?.("memory.enabled") ? 1 : 0, output: "" }; };
    const ok = await applyConfig(cfg, { run, current: {} });
    assert.ok(ok.length > 5);
    assert.equal(ok.approvals[0].code, 0);
    assert.deepEqual(ok.instructions, []);
    await assert.rejects(applyConfig(cfg, { run: async () => ({ code: 2, output: "nope" }), current: {} }), /failed \(2\)/);
    const approvalFails = async (bin, args) => (args[0] === "approvals" ? { code: 1, output: "unknown command" } : { code: 0, output: "" });
    const res = await applyConfig(cfg, { run: approvalFails, current: {} });
    assert.equal(res.instructions.length, 1);
    assert.match(res.instructions[0], /Run manually:\n  openclaw approvals allowlist add --gateway --agent campaign_fixture \/opt\/rp-harness\/bin\/rp/);
    assert.ok(!calls.some((a) => a.includes("full")), "never broadens exec");
  } finally { r.cleanup(); }
});
