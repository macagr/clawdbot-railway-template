// Generic command routing. Handlers are campaign-agnostic; campaigns enable/alias commands.
import { markTurn, exemplarExists } from "../exemplars/exemplars.js";
import { performSave, dryRunSave, createAdapter } from "../persistence/save.js";
import { performSync, syncStatus } from "../persistence/sync.js";
import { assertSemanticMode, assertPresentation } from "../modes/modes.js";
import { createBranch, listBranches, discardBranch, promoteBranch, exportBranch, switchToMain } from "../branch/branch.js";
import { usageSummary } from "../meter/usage.js";
import { buildDirectorContext, buildNovelistContext } from "../context/builder.js";
import { loadCatalog } from "../knowledge/catalog.js";
import { highPressure } from "../form/pressure.js";
import { CampaignStore } from "../state/store.js";

export function parseCommand(line) {
  const m = String(line || "").trim().match(/^\/([a-z][a-z0-9_-]*)\s*(.*)$/is);
  if (!m) return null;
  const args = (m[2] || "").trim();
  return { name: m[1].toLowerCase(), args, argv: args ? args.split(/\s+/) : [] };
}

export function isCommand(line) { return parseCommand(line) !== null; }

export const COMMAND_HELP = {
  help: "/help — list commands",
  status: "/status — revision, mode, scene, unsaved turns, budget",
  context: "/context [director|novelist] — what the next turn would select (ids and counts)",
  mode: "/mode <semantic mode> — switch semantic mode explicitly",
  scene: "/scene <presentation|auto> — force a presentation mode, or 'auto' to unpin",
  good: "/good [turn id] [note] — mark the last (or given) delivered turn as a style exemplar",
  flat: "/flat [turn id] [note] — mark it as an anti-exemplar",
  ooc: "/ooc <text> — out-of-character exchange; nothing becomes canon",
  save: "/save [--dry-run] — persist unsaved turns to durable canon",
  sync: "/sync [--stash | --discard <campaign id>] — pull durable canon",
  branch: "/branch create <id> [label] | list | discard <id> <id> | promote <id> <id> | export <id>",
  resume: "/resume — start a play session: reset specialist caches, check canon staleness, redeliver",
};

/**
 * Route a command line. `deps` = { store, runner, sessions, clock, caller, adapter?, env, log, reopen() }.
 * Returns { text, handled }.
 */
/**
 * Route a canonical command line (always "/name args"). `prefix` only changes how command names
 * are rendered back to the user (a transport such as Discord may present "!" instead of "/").
 */
export async function routeCommand(line, deps, { transport = "cli", eventId, player, prefix = "/" } = {}) {
  const cmd = parseCommand(line);
  if (!cmd) return { handled: false };
  const { store } = deps;
  const enabled = new Set(store.manifest.commands.enabled);
  const aliases = store.manifest.commands.aliases || {};
  const name = aliases[cmd.name] || cmd.name;
  if (!enabled.has(name) || !HANDLERS[name]) return { handled: true, text: `Unknown or disabled command ${prefix}${cmd.name}.${enabled.has("help") ? ` Try ${prefix}help.` : ""}` };
  try {
    const out = await HANDLERS[name]({ ...deps, cmd, transport, eventId, player, prefix });
    // Handlers return a string, or { text, ...metadata } when a transport needs more than text
    // (e.g. /resume on Discord reports which committed turn is being redelivered).
    return typeof out === "string" ? { handled: true, text: out } : { handled: true, ...out };
  } catch (err) {
    deps.log?.error?.(`[command /${name}] ${err.stack || err.message}`);
    return { handled: true, text: `${prefix}${name} failed: ${err.message}` };
  }
}

/** Command names the router knows (before campaign enable/alias filtering). */
export const COMMAND_NAMES = Object.freeze(Object.keys(COMMAND_HELP));

const HANDLERS = {
  async help({ store, prefix = "/" }) {
    return store.manifest.commands.enabled.filter((c) => COMMAND_HELP[c]).map((c) => COMMAND_HELP[c].replace(/^\//, prefix)).join("\n");
  },

  async status({ store, runner, clock, adapter }) {
    const meta = store.meta(), scene = store.scene(), dirty = store.dirty().entries;
    const usage = usageSummary(store.usage(), clock.iso());
    const b = store.manifest.budget || {};
    const pending = store.pendingEvents().length;
    const undelivered = runner ? runner.undelivered().length : 0;
    const hp = highPressure(store.formLedger(), store.manifest.form.dimensions, 0.5);
    const lines = [
      `${store.manifest.display_name} (${store.id})${store.branch ? ` — BRANCH ${store.branch}` : ""}`,
      `revision ${meta.revision}, last saved ${meta.last_saved_revision}, canon revision ${meta.canon_revision ?? "unknown"}, unsaved turns ${dirty.length}${store.pendingSave() ? " (a pending save is waiting for retry)" : ""}`,
      `mode ${scene.mode}, presentation ${scene.presentation}${scene.presentation_forced ? " (pinned)" : ""}, scene ${scene.scene_id} at ${scene.location}${scene.time ? ` (${scene.time})` : ""}, present: ${scene.present.join(", ") || "nobody"}`,
      `pending delayed knowledge events: ${pending}; undelivered turns: ${undelivered}`,
      `spend: today ${usage.today.toFixed(4)}${b.per_day ? `/${b.per_day}` : ""}, month ${usage.month.toFixed(4)}${b.per_month ? `/${b.per_month}` : ""}, total ${usage.total.toFixed(4)} (${usage.calls} calls)`,
      hp.length ? `form pressure high on: ${hp.map((h) => `${h.dimension}=${h.value}`).join(", ")}` : "form pressure: nothing high",
    ];
    if (adapter) { try { const h = await adapter.health(); lines.push(`persistence: ${h.ok ? "ok" : "unavailable"} — ${h.message}`); } catch (err) { lines.push(`persistence: error — ${err.message}`); } }
    return lines.join("\n");
  },

  async context({ store, cmd }) {
    const which = cmd.argv[0] || "director";
    const env = { actors: store.actors(), catalog: loadCatalog(store) };
    if (which === "novelist") {
      const last = store.lastTurns(1)[0];
      if (!last?.packet) return "No committed turn yet; the Novelist selection depends on a Director packet.";
      const ctx = buildNovelistContext(store, { packet: last.packet, env });
      return `Novelist selection (based on ${last.turn_id}):\n${JSON.stringify(ctx.selection, null, 2)}`;
    }
    const ctx = buildDirectorContext(store, { input: { text: cmd.argv.slice(1).join(" ") || "(no input)" }, turnId: "preview", env, formLedger: store.formLedger() });
    const s = ctx.selection;
    return `Director selection (preview, no model call):\n- present: ${s.present.join(", ") || "-"}\n- involved: ${s.involved.join(", ") || "-"}\n- facts: ${s.facts.length} (${s.facts.join(", ")})\n- minds: ${s.minds.join(", ") || "-"}\n- unresolved: ${s.unresolved.length}; candidates: ${s.candidates.length}\n- recent turns: ${s.recent_turns.length}; history files: ${s.history_files.join(", ") || "-"}\n- context size: ${s.chars} chars`;
  },

  async mode({ store, cmd }) {
    const mode = cmd.argv[0];
    if (!mode) return `Current semantic mode: ${store.scene().mode}. Enabled: ${store.manifest.modes.semantic.enabled.join(", ")}.`;
    assertSemanticMode(store.manifest, mode);
    const scene = store.scene();
    if (scene.mode === mode) return `Already in ${mode}.`;
    store.commit({ "state/scene.json": { ...scene, mode } });
    return `Semantic mode: ${scene.mode} → ${mode}${store.manifest.modes.semantic.canon_affecting.includes(mode) ? " (turns commit canon)" : " (turns do NOT commit canon)"}.`;
  },

  async scene({ store, cmd }) {
    const p = cmd.argv[0];
    const scene = store.scene();
    if (!p) return `Presentation: ${scene.presentation}${scene.presentation_forced ? " (pinned)" : ""}. Enabled: ${store.manifest.modes.presentation.enabled.join(", ")}.`;
    if (p === "auto") { store.commit({ "state/scene.json": { ...scene, presentation_forced: false } }); return `Presentation unpinned (${scene.presentation}); Director suggestions apply per policy.`; }
    assertPresentation(store.manifest, p);
    store.commit({ "state/scene.json": { ...scene, presentation: p, presentation_forced: true } });
    return `Presentation: ${scene.presentation} → ${p} (pinned until /scene auto).`;
  },

  async good(d) { return mark(d, "good"); },
  async flat(d) { return mark(d, "flat"); },

  async ooc({ store, runner, cmd, eventId, transport }) {
    if (!cmd.args) return "Usage: /ooc <text>";
    const res = await runner.run({ text: cmd.args, eventId: eventId ? `${eventId}:ooc` : undefined, transport, nonCanon: "ooc" });
    return res.output;
  },

  async save({ store, clock, adapter, caller, cmd, log }) {
    const a = adapter || createAdapter(store);
    if (cmd.argv.includes("--dry-run")) { const d = dryRunSave(store, { at: clock.iso() }); return `Dry run: ${d.turns} turn(s), ${d.facts} facts, ${d.events} events, ${d.size} bytes, save_id ${d.packet.save_id}. Nothing sent.`; }
    const r = await performSave(store, a, { at: clock.iso(), caller, log });
    if (r.status === "ok") return `Saved ${r.packet.source.turn_ids.length} turn(s) (revisions ${r.packet.source.revision_from}-${r.packet.source.revision_to}); canon revision ${r.result.canon_revision}.`;
    if (r.status === "duplicate") return `Already saved (save_id ${r.packet.save_id}); local state marked saved.`;
    if (r.status === "rejected") return `Save REJECTED: ${r.result.message || r.result.failed.map((f) => f.error).join("; ")}. Run /sync to see the conflict.`;
    if (r.status === "partial") return `Save PARTIAL: applied ${r.result.applied.join(", ") || "nothing"}; failed ${r.result.failed.map((f) => `${f.target} (${f.error})`).join(", ")}. Local state still unsaved; /save again retries with the same save_id.`;
    return `Save failed: ${r.error?.message || r.result?.message || "unknown error"}. Packet kept pending; /save again to retry.`;
  },

  async sync({ store, clock, adapter, cmd, log }) {
    const a = adapter || createAdapter(store);
    let mode = "auto", confirm;
    if (cmd.argv.includes("--stash")) mode = "stash";
    if (cmd.argv.includes("--discard")) { mode = "discard"; confirm = cmd.argv[cmd.argv.indexOf("--discard") + 1]; }
    if (cmd.argv.includes("--status")) { const s = await syncStatus(store, a); return `sync status: ${s.state} (unsaved ${s.dirty}, local canon ${s.local_canon_revision}, remote ${s.remote_canon_revision})`; }
    const r = await performSync(store, a, { at: clock.iso(), mode, confirm, log });
    return r.message;
  },

  async branch({ store, clock, cmd, reopen }) {
    const [sub, id, ...rest] = cmd.argv;
    const at = clock.iso();
    if (!sub || sub === "list") {
      const list = listBranches(store.root);
      return list.length ? list.map((b) => `- ${b.id} [${b.status}] from revision ${b.base_revision}${b.label ? ` — ${b.label}` : ""}${store.branch === b.id ? " (active)" : ""}`).join("\n") : "No branches.";
    }
    if (sub === "create") { if (!id) return "Usage: /branch create <id> [label]"; const b = createBranch(store, { id, label: rest.join(" ") || undefined, at }); reopen?.(); return `Branch '${b.id}' created from revision ${b.base_revision}. Turns now commit to the branch; main canon is untouched. /resume returns to main.`; }
    if (sub === "discard") { const b = discardBranch(store.root, id, { confirm: rest[0] }); reopen?.(); return `Branch '${b.id}' discarded.`; }
    if (sub === "export") { const r = exportBranch(store.root, id, { at }); return `Branch '${id}' exported (${r.turns} turns) to ${r.path}.`; }
    if (sub === "promote") { const b = promoteBranch(store.root, id, { confirm: rest[0], clock }); reopen?.(); return `Branch '${b.id}' promoted to main (backup at ${b.backup}). Remember to /save.`; }
    return "Usage: /branch create <id> [label] | list | discard <id> <id> | promote <id> <id> | export <id>";
  },

  async resume({ store, runner, sessions, adapter, reopen, transport }) {
    const lines = [];
    if (store.branch) { switchToMain(store.root); reopen?.(); lines.push(`Left branch '${store.branch}'; back on main.`); }
    const abandoned = runner?.recoverIncomplete() || [];
    if (abandoned.length) lines.push(`Abandoned ${abandoned.length} incomplete turn(s) from a previous run: ${abandoned.join(", ")}.`);
    sessions?.onResume();
    lines.push("Specialist caches reset.");
    const und = runner?.undelivered() || [];
    // Redelivery never regenerates: the committed output is resent as-is. On Discord the transport
    // posts it as separate chunks and the coordinator confirms delivery, so the turn id is returned
    // as metadata instead of inlining the prose.
    let redeliver = null;
    if (und.length) {
      const last = und[und.length - 1];
      if (transport === "discord") { redeliver = { turn_id: last.turn_id, output: last.output || "" }; lines.push(`${und.length} committed turn(s) were never delivered; redelivering ${last.turn_id} below.`); }
      else lines.push(`${und.length} committed turn(s) were never delivered; redelivering the last one:\n\n${last.output}`);
    }
    if (adapter) {
      try { const s = await syncStatus(store, adapter); lines.push(s.state === "up_to_date" ? "Durable canon is current." : `Durable canon: ${s.state.replace("_", " ")} (unsaved ${s.dirty}, local ${s.local_canon_revision}, remote ${s.remote_canon_revision}).`); }
      catch (err) { lines.push(`Could not check durable canon: ${err.message}`); }
    }
    const scene = store.scene();
    lines.push(`Scene ${scene.scene_id} at ${scene.location}${scene.time ? ` (${scene.time})` : ""}; present: ${scene.present.join(", ") || "nobody"}; mode ${scene.mode}/${scene.presentation}.`);
    return redeliver ? { text: lines.join("\n"), redeliver } : lines.join("\n");
  },
};

async function mark({ store, clock, cmd }, kind) {
  let [turnId, ...rest] = cmd.argv;
  if (!turnId || !store.turn(turnId)) { rest = cmd.argv; const last = store.listTurnIds().map((id) => store.turn(id)).filter((t) => t.status === "delivered" || t.status === "committed").at(-1); if (!last) return "No delivered turn to mark."; turnId = last.turn_id; }
  if (exemplarExists(store, kind, turnId)) return `${turnId} is already marked ${kind}.`;
  const ex = markTurn(store, { kind, turnId, at: clock.iso(), note: rest.join(" ") || undefined });
  return `Marked ${turnId} as ${kind === "good" ? "an exemplar" : "an anti-exemplar"} (style only; it establishes no facts).${ex.note ? ` Note: ${ex.note}` : ""}`;
}

export function reopenStore(deps) {
  deps.store = new CampaignStore(deps.store.root, { clock: deps.clock, log: deps.log });
  if (deps.runner) deps.runner.store = deps.store;
  if (deps.sessions) deps.sessions.store = deps.store;
  return deps.store;
}
