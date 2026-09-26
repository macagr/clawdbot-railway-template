// OpenClaw setup: derive agents, bindings and policies for a campaign from its manifest and
// apply them through the openclaw CLI (or print them with --dry-run). Also writes the thin
// coordinator/specialist workspace files. Campaign content stays in the campaign package.
import childProcess from "node:child_process";
import path from "node:path";
import { ensureDir, writeFileAtomic, exists } from "../lib/fsx.js";
import { genericPrompt, fill } from "../prompts/render.js";
import { agentIdFor } from "../campaign/manifest.js";

export const SPECIALIST_ROLES = ["director", "novelist", "editor"];

/** The OpenClaw config fragments (path -> JSON value) for one campaign. */
export function openclawConfigFor(store, { rpBin = "/opt/rp-harness/bin/rp", workspacesRoot } = {}) {
  const m = store.manifest;
  const id = m.id;
  const root = workspacesRoot || path.dirname(store.root);
  const coordinatorModel = m.roles.coordinator?.model;
  const entries = {};
  entries[id] = {
    workspace: store.root,
    ...(coordinatorModel && !coordinatorModel.startsWith("fake/") ? { model: coordinatorModel } : {}),
    tools: { allow: ["exec"] },
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
      tools: { allow: [] },
      skills: [],
      subagents: { allowAgents: [] },
    };
  }
  const bindings = [];
  if (m.discord?.guild_id && m.discord?.channel_id) {
    bindings.push({ agentId: id, match: { channel: "discord", guildId: m.discord.guild_id, peer: { kind: "channel", id: m.discord.channel_id } } });
  }
  const users = m.discord?.user_ids?.length ? m.discord.user_ids : m.player.user_ids || [];
  // Per-channel keys must match OpenClaw's guild channel schema: requireMention, users, enabled, skills, systemPrompt.
  // historyLimit is channel-wide (channels.discord.historyLimit) and is left to the operator.
  const channelCfg = m.discord?.channel_id ? { [m.discord.channel_id]: { requireMention: false, users } } : {};
  return {
    agents: { ownership: "explicit", entries },
    bindings,
    discord: m.discord?.guild_id ? { guilds: { [m.discord.guild_id]: { channels: channelCfg } } } : null,
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
  /^agents\.entries\.[a-z][a-z0-9_-]*\.promptMode$/,
  /^agents\.ownership$/,
  /^bindings$/,
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

/** Flatten into `openclaw config set --strict-json <path> <json>` operations. */
export function configSetOps(cfg) {
  const ops = [];
  for (const [agentId, entry] of Object.entries(cfg.agents.entries)) ops.push([`agents.entries.${agentId}`, entry]);
  ops.push(["agents.ownership", cfg.agents.ownership]);
  if (cfg.bindings.length) ops.push(["bindings", cfg.bindings, { merge: "bindings" }]);
  if (cfg.discord) for (const [gid, g] of Object.entries(cfg.discord.guilds)) for (const [cid, c] of Object.entries(g.channels)) ops.push([`channels.discord.guilds.${gid}.channels.${cid}`, c]);
  ops.push(["tools.agentToAgent.enabled", true]);
  ops.push(["tools.sessions.visibility", cfg.tools.sessions.visibility]);
  // Legacy exec policy keys cannot coexist with mode; remove them first (no-op when absent).
  ops.push(["tools.exec.security", undefined, { op: "unset", optional: true }]);
  ops.push(["tools.exec.ask", undefined, { op: "unset", optional: true }]);
  ops.push(["tools.exec.mode", cfg.tools.exec.mode]);
  for (const agentId of cfg.memory.agents) ops.push([`agents.entries.${agentId}.memory.enabled`, false, { optional: true }]);
  // Specialists receive self-contained tasks; a minimal prompt mode drops OpenClaw's memory,
  // identity and messaging sections from their system prompt. Tolerated if the key is rejected.
  for (const agentId of cfg.specialists || []) ops.push([`agents.entries.${agentId}.promptMode`, "minimal", { optional: true }]);
  if (cfg.commands) ops.push(["commands.allowFrom.discord", cfg.commands.allowFrom.discord, { merge: "list" }]);
  return ops;
}

/** Write AGENTS.md/SOUL.md for the coordinator (in the campaign workspace) and for each specialist. */
export function writeWorkspaces(store, { workspacesRoot, transport = "discord" } = {}) {
  const m = store.manifest;
  const root = workspacesRoot || path.dirname(store.root);
  const written = [];
  const coord = path.join(store.root, "AGENTS.md");
  writeFileAtomic(coord, fill(genericPrompt("coordinator-AGENTS"), { campaign_id: m.id, transport }));
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
  }
  return written;
}

/**
 * Apply config through the openclaw CLI, then the exec-approval allowlist entries.
 * A failed config op aborts (unless optional). A failed approval op never aborts and never
 * broadens exec; it is reported with the exact command for the operator to run.
 * `run` is injectable for tests. Returns { results, approvals, instructions }.
 */
export async function applyConfig(cfg, { bin = process.env.OPENCLAW_BIN || "openclaw", run = spawnSync, dryRun = false, log = () => {} } = {}) {
  const results = [];
  for (const [key, value, opts = {}] of configSetOps(cfg)) {
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
