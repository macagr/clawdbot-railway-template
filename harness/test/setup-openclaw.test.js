import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRunner } from "./runner-helpers.js";
import { openclawConfigFor, configSetOps, writeWorkspaces, applyConfig } from "../src/openclaw/setup.js";

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
    assert.deepEqual(cfg.tools.exec, { security: "allowlist", allowlist: ["/opt/rp-harness/bin/rp"] });
    assert.deepEqual(cfg.commands.allowFrom.discord, ["user:user_fixture"]);
    assert.ok(!("model" in cfg.agents.entries.campaign_fixture), "fake/ models are not written to OpenClaw");
    const ops = configSetOps(cfg);
    assert.ok(ops.some(([k]) => k === "bindings"));
    assert.ok(ops.some(([k]) => k === "tools.sessions.visibility"));
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

test("applyConfig: dry run prints, real run stops on the first hard failure, optional ops tolerated", async () => {
  const r = makeRunner();
  try {
    const cfg = openclawConfigFor(r.store);
    const lines = [];
    const dry = await applyConfig(cfg, { dryRun: true, log: (l) => lines.push(l) });
    assert.equal(dry.length, lines.length);
    assert.match(lines[0], /^openclaw config set --strict-json agents\.entries\.campaign_fixture /);
    const calls = [];
    const run = async (bin, args) => { calls.push(args[3]); return { code: args[3].endsWith("memory.enabled") ? 1 : 0, output: "" }; };
    const ok = await applyConfig(cfg, { run });
    assert.ok(ok.length > 5);
    await assert.rejects(applyConfig(cfg, { run: async () => ({ code: 2, output: "nope" }) }), /failed \(2\)/);
  } finally { r.cleanup(); }
});
