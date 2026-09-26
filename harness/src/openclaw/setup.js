// OpenClaw setup: derive agents, bindings and policies for a campaign from its manifest and
// apply them through the openclaw CLI (or print them with --dry-run). Also writes the thin
// coordinator/specialist workspace files. Campaign content stays in the campaign package.
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeFileAtomic, exists } from "../lib/fsx.js";
import { genericPrompt, fill } from "../prompts/render.js";
import { agentIdFor } from "../campaign/manifest.js";
import { discordCommandPrefix } from "../transport/discord.js";

export const SPECIALIST_ROLES = ["director", "novelist", "editor"];

/** The OpenClaw config fragments (path -> JSON value) for one campaign. */
export function openclawConfigFor(store, { rpBin = "/opt/rp-harness/bin/rp", workspacesRoot } = {}) {
  const m = store.manifest;
  const id = m.id;
  const root = workspacesRoot || path.dirname(store.root);
  const coordinatorModel = m.roles.coordinator?.model;
  const discordBound = Boolean(m.discord?.guild_id && m.discord?.channel_id);
  const entries = {};
  // Tool policy: an empty `allow` list counts as unset in OpenClaw (full catalog, ~23k tokens of
  // schemas per call). Use the minimal profile; the coordinator adds exec (to run rp) and, when it
  // is routed to a Discord channel, message (OpenClaw requires a message tool on channel-routed
  // agents). Nothing else: no memory, no skills, no subagents. Specialists deny all.
  entries[id] = {
    workspace: store.root,
    ...(coordinatorModel && !coordinatorModel.startsWith("fake/") ? { model: coordinatorModel } : {}),
    tools: { profile: "minimal", alsoAllow: discordBound ? ["exec", "message"] : ["exec"] },
    skills: [],
    subagents: { allowAgents: [] },
  };
  for (const role of SPECIALIST_ROLES) {
    const rc = m.roles[role];
    if (!rc) continue;
    const agentId = agentIdFor(m, role);
    // Roles pointed at an existing agent (openclaw:<id>) are not (re)configured here.
    if (rc.model?.startsWith("openclaw:") && !rc.agent_id && agentId !== `${id}-${role}`) continue;
    entries[agentId] = {
      workspace: path.join(root, `${id}-${role}`),
      ...(rc.model && !rc.model.startsWith("fake/") && !rc.model.startsWith("openclaw:") ? { model: rc.model } : {}),
      tools: { profile: "minimal", deny: ["*"] },
      skills: [],
      subagents: { allowAgents: [] },
    };
  }
  const bindings = [];
  if (discordBound) {
    bindings.push({ agentId: id, match: { channel: "discord", guildId: m.discord.guild_id, peer: { kind: "channel", id: m.discord.channel_id } } });
  }
  const users = m.discord?.user_ids?.length ? m.discord.user_ids : m.player.user_ids || [];
  // Per-channel keys must match OpenClaw's guild channel schema: requireMention, users, enabled, skills, systemPrompt.
  // historyLimit is channel-wide (channels.discord.historyLimit) and is left to the operator.
  const channelCfg = m.discord?.channel_id ? { [m.discord.channel_id]: { requireMention: false, users } } : {};
  return {
    agents: { ownership: "explicit", entries },
    bindings,
    // Players are allowlisted users, never OpenClaw command owners: commands.ownerAllowFrom is an
    // operator/deployment setting and is deliberately not derived from player ids.
    discord: m.discord?.guild_id ? { enabled: true, groupPolicy: "allowlist", guilds: { [m.discord.guild_id]: { channels: channelCfg } } } : null,
    tools: {
      agentToAgent: { enabled: true, allow: [id, ...Object.keys(entries).filter((k) => k !== id)] },
      sessions: { visibility: "agent" },
      // OpenClaw 2026.9.5: tools.exec.mode is the persisted policy; allowlist entries live in the
      // exec-approvals store (openclaw approvals allowlist add), not in config.
      exec: { mode: "allowlist" },
    },
    approvals: [{ agentId: id, pattern: rpBin }],
    specialists: Object.keys(entries).filter((k) => k !== id),
    commands: users.length ? { allowFrom: { discord: users.map((u) => `user:${u}`) } } : null,
    memory: { agents: Object.keys(entries) },
  };
}

/** Config keys this generator may emit. Guarded by tests so unsupported keys are not reintroduced. */
export const ALLOWED_CONFIG_KEY_PATTERNS = [
  /^agents\.entries\.[a-z][a-z0-9_-]*$/,
  /^agents\.entries\.[a-z][a-z0-9_-]*\.memory\.enabled$/,
  /^agents\.ownership$/,
  /^bindings$/,
  /^plugins\.entries\.discord\.enabled$/,
  /^channels\.discord\.groupPolicy$/,
  /^channels\.discord\.guilds\.[^.]+\.channels\.[^.]+$/,
  /^tools\.agentToAgent\.enabled$/,
  /^tools\.sessions\.visibility$/,
  /^tools\.exec\.mode$/,
  /^commands\.allowFrom\.discord$/,
];

/** Approval commands (exec allowlist) as argv arrays. Idempotent on the OpenClaw side. */
export function approvalOps(cfg) {
  return (cfg.approvals || []).map(({ agentId, pattern }) => ({
    agentId, pattern,
    // Pattern is positional in `openclaw approvals allowlist add`; --agent scopes it to the coordinator.
    args: ["approvals", "allowlist", "add", "--gateway", "--agent", agentId, pattern],
  }));
}

export function approvalInstruction(op, bin = "openclaw") {
  return `${bin} ${op.args.map(quote).join(" ")}`;
}

/**
 * Merge this campaign's Discord binding into the existing bindings list: bindings of other agents,
 * and this agent's bindings on other channels, are preserved; this agent's previous Discord
 * binding(s) are replaced. Rerunning with the same manifest yields the same list (idempotent).
 */
export function mergeBindings(existing, mine) {
  const kept = (Array.isArray(existing) ? existing : []).filter((b) => !mine.some((n) => b?.agentId === n.agentId && b?.match?.channel === n.match.channel));
  return [...kept, ...mine];
}

function mergeList(existing, mine) {
  return [...new Set([...(Array.isArray(existing) ? existing : []), ...mine])];
}

/**
 * Read the live OpenClaw config (openclaw.json under the state dir) so list-valued keys can be
 * merged instead of replaced. A missing file is a fresh install ({}); an unreadable one is an error,
 * because replacing bindings blindly could detach other campaigns' channels.
 */
export function readCurrentConfig(stateDir = process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "/root", ".openclaw")) {
  const file = path.join(stateDir, "openclaw.json");
  if (!exists(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) { throw new Error(`cannot parse ${file} to merge bindings/allowlists: ${err.message}`); }
}

/** Flatten into `openclaw config set --strict-json <path> <json>` operations. `current` is the live config for merges. */
export function configSetOps(cfg, current = {}) {
  const ops = [];
  for (const [agentId, entry] of Object.entries(cfg.agents.entries)) ops.push([`agents.entries.${agentId}`, entry]);
  ops.push(["agents.ownership", cfg.agents.ownership]);
  if (cfg.bindings.length) ops.push(["bindings", mergeBindings(current.bindings, cfg.bindings), { merge: "bindings" }]);
  if (cfg.discord) {
    ops.push(["plugins.entries.discord.enabled", true]);
    ops.push(["channels.discord.groupPolicy", cfg.discord.groupPolicy]);
    for (const [gid, g] of Object.entries(cfg.discord.guilds)) for (const [cid, c] of Object.entries(g.channels)) ops.push([`channels.discord.guilds.${gid}.channels.${cid}`, c]);
  }
  ops.push(["tools.agentToAgent.enabled", true]);
  ops.push(["tools.sessions.visibility", cfg.tools.sessions.visibility]);
  // Legacy exec policy keys cannot coexist with mode; remove them first (no-op when absent).
  ops.push(["tools.exec.security", undefined, { op: "unset", optional: true }]);
  ops.push(["tools.exec.ask", undefined, { op: "unset", optional: true }]);
  ops.push(["tools.exec.mode", cfg.tools.exec.mode]);
  for (const agentId of cfg.memory.agents) ops.push([`agents.entries.${agentId}.memory.enabled`, false, { optional: true }]);
  // Player allowlist is merged (other campaigns' players stay). commands.ownerAllowFrom is never written.
  if (cfg.commands) ops.push(["commands.allowFrom.discord", mergeList(current.commands?.allowFrom?.discord, cfg.commands.allowFrom.discord), { merge: "list" }]);
  return ops;
}

/** Write AGENTS.md/SOUL.md for the coordinator (in the campaign workspace) and for each specialist. */
export function writeWorkspaces(store, { workspacesRoot, transport = "discord" } = {}) {
  const m = store.manifest;
  const root = workspacesRoot || path.dirname(store.root);
  const written = [];
  const coord = path.join(store.root, "AGENTS.md");
  const command_prefix = transport === "discord" ? discordCommandPrefix(m) : "/";
  writeFileAtomic(coord, fill(genericPrompt("coordinator-AGENTS"), { campaign_id: m.id, transport, command_prefix }));
  written.push(coord);
  const soul = path.join(store.root, "SOUL.md");
  if (!exists(soul)) { writeFileAtomic(soul, `Coordinator for ${m.display_name}. Relay only. No narration, no opinions about the fiction.\n`); written.push(soul); }
  for (const role of SPECIALIST_ROLES) {
    if (!m.roles[role]) continue;
    const dir = path.join(root, `${m.id}-${role}`);
    ensureDir(dir);
    const p = path.join(dir, "AGENTS.md");
    writeFileAtomic(p, fill(genericPrompt("specialist-AGENTS"), { campaign_id: m.id, role_title: role[0].toUpperCase() + role.slice(1) }));
    written.push(p);
    // OpenClaw seeds default bootstrap files into new workspaces (IDENTITY/SOUL/USER and an
    // ~8 KB BOOTSTRAP.md first-run ritual). Specialists must not carry them: keep the three
    // identity files to one line so nothing is re-seeded, and remove BOOTSTRAP.md.
    for (const [name, text] of Object.entries(SPECIALIST_MINIMAL_FILES)) {
      const fp = path.join(dir, name);
      writeFileAtomic(fp, fill(text, { role_title: role[0].toUpperCase() + role.slice(1), campaign_id: m.id }));
      written.push(fp);
    }
    const bootstrap = path.join(dir, "BOOTSTRAP.md");
    if (exists(bootstrap)) { fs.rmSync(bootstrap, { force: true }); written.push(`${bootstrap} (removed)`); }
  }
  return written;
}

export const SPECIALIST_MINIMAL_FILES = Object.freeze({
  "IDENTITY.md": "{{role_title}} specialist ({{campaign_id}}). No persona beyond the task instructions.\n",
  "SOUL.md": "Follow the task message exactly. No conversation, no initiative, no tools.\n",
  "USER.md": "The only user is the harness process. Never address a human.\n",
});

/**
 * Apply config through the openclaw CLI, then the exec-approval allowlist entries.
 * A failed config op aborts (unless optional). A failed approval op never aborts and never
 * broadens exec; it is reported with the exact command for the operator to run.
 * `run` is injectable for tests. Returns { results, approvals, instructions }.
 */
export async function applyConfig(cfg, { bin = process.env.OPENCLAW_BIN || "openclaw", run = spawnSync, dryRun = false, log = () => {}, current } = {}) {
  const results = [];
  for (const [key, value, opts = {}] of configSetOps(cfg, current ?? readCurrentConfig())) {
    const args = opts.op === "unset" ? ["config", "unset", key] : ["config", "set", "--strict-json", key, JSON.stringify(value)];
    if (dryRun) { results.push({ key, args, dryRun: true }); log(`${bin} ${args.map(quote).join(" ")}`); continue; }
    const r = await run(bin, args);
    results.push({ key, op: opts.op || "set", code: r.code, output: r.output });
    if (r.code !== 0 && !opts.optional) throw new Error(`openclaw config ${opts.op || "set"} ${key} failed (${r.code}): ${r.output.slice(-400)}`);
  }
  const approvals = [];
  const instructions = [];
  for (const op of approvalOps(cfg)) {
    const cmd = approvalInstruction(op, bin);
    if (dryRun) { approvals.push({ ...op, dryRun: true }); log(cmd); continue; }
    const r = await run(bin, op.args);
    approvals.push({ ...op, code: r.code, output: r.output });
    if (r.code !== 0) {
      instructions.push(`exec allowlist entry for ${op.agentId} could not be added automatically (${r.output.trim().slice(-200) || `exit ${r.code}`}). Run manually:\n  ${cmd}`);
    }
  }
  results.approvals = approvals;
  results.instructions = instructions;
  return results;
}

function quote(s) { return /[\s"']/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s; }

export function spawnSync(bin, args) {
  return new Promise((resolve) => {
    const p = childProcess.spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    p.stdout.on("data", (d) => (output += d)); p.stderr.on("data", (d) => (output += d));
    p.on("error", (err) => resolve({ code: 127, output: String(err) }));
    p.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}
