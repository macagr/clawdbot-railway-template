// Operator tools: validate, reconstruct-check, export/import state, lock repair, generic-leak scan.
import fs from "node:fs";
import path from "node:path";
import { schemas } from "../lib/schema.js";
import { DirLock, readJson, writeJson, ensureDir, exists, listFiles } from "../lib/fsx.js";
import { loadCatalog } from "../knowledge/catalog.js";
import { holdingAccessible } from "../knowledge/ledger.js";
import { buildDirectorContext } from "../context/builder.js";
import { STATE_FILES } from "../state/store.js";

/** Validate every state file and cross-references. Returns { ok, problems[] }. */
export function validateCampaign(store) {
  const problems = [];
  const P = (m) => problems.push(m);
  const tryRead = (label, fn) => { try { return fn(); } catch (err) { P(`${label}: ${err.message}`); return null; } };
  const meta = tryRead("meta", () => store.meta());
  const scene = tryRead("scene", () => store.scene());
  const facts = tryRead("facts", () => store.facts()) || [];
  const actors = tryRead("actors", () => store.actors());
  const catalog = tryRead("catalog", () => loadCatalog(store)) || { channels: {}, scopes: {} };
  tryRead("relationships", () => store.relationships());
  tryRead("unresolved", () => store.unresolved());
  const candidates = tryRead("candidates", () => store.candidates()) || [];
  tryRead("dirty", () => store.dirty()); tryRead("form-ledger", () => store.formLedger()); tryRead("usage", () => store.usage()); tryRead("sessions", () => store.sessions());
  for (const id of store.mindIds()) tryRead(`mind ${id}`, () => store.mind(id));
  if (actors && scene) for (const id of scene.present) if (!actors.actors[id]) P(`scene.present references unknown actor ${id}`);
  if (actors && meta && !actors.actors[store.manifest.player.character]) P(`player character ${store.manifest.player.character} missing from roster`);
  const ids = new Set(facts.map((f) => f.id));
  for (const f of facts) {
    if (f.truth.authorial === "undecided" && f.truth.status !== "unresolved") P(`fact ${f.id}: undecided but status ${f.truth.status}`);
    for (const h of f.holdings) {
      if (h.holder.type === "actor" && actors && !actors.actors[h.holder.id]) P(`fact ${f.id}: holding for unknown actor ${h.holder.id}`);
      if (h.holder.type === "group" && !catalog.scopes?.[h.holder.scope]) P(`fact ${f.id}: group holding with unknown scope ${h.holder.scope}`);
    }
    if (f.superseded_by && !ids.has(f.superseded_by)) P(`fact ${f.id}: superseded_by unknown ${f.superseded_by}`);
  }
  for (const c of candidates) if (!ids.has(c.fact)) P(`candidate ${c.id}: unknown fact ${c.fact}`);
  for (const ev of tryRead("pending-events", () => store.pendingEvents()) || []) if (!ids.has(ev.fact)) P(`pending event ${ev.id}: unknown fact ${ev.fact}`);
  if (meta && meta.last_saved_revision > meta.revision) P(`meta: last_saved_revision ${meta.last_saved_revision} > revision ${meta.revision}`);
  const dirtyEntries = tryRead("dirty entries", () => store.dirty().entries) || [];
  for (const e of dirtyEntries) if (!store.turn(e.turn_id)) P(`dirty entry ${e.turn_id}: turn record missing`);
  const lockInfo = DirLock.info(store.lockPath());
  if (lockInfo) P(`lock held by ${lockInfo.owner || "?"} (pid ${lockInfo.pid || "?"}) since ${lockInfo.at}`);
  if (exists(store.journalPath())) P("commit journal present (an interrupted commit will be rolled forward on next open)");
  void holdingAccessible;
  return { ok: problems.length === 0, problems, counts: { facts: facts.length, actors: actors ? Object.keys(actors.actors).length : 0, minds: store.mindIds().length, turns: store.listTurnIds().length } };
}

/**
 * Reconstruction check: build the Director context twice, wiping specialist session keys in
 * between, and confirm the explicit inputs are identical. Also verifies every committed turn's
 * packet still validates against the schema.
 */
export function reconstructCheck(store, sessions) {
  const env = { actors: store.actors(), catalog: loadCatalog(store) };
  const input = { text: "(reconstruction check)" };
  const a = buildDirectorContext(store, { input, turnId: "check", env, formLedger: store.formLedger() });
  const before = store.sessions();
  sessions.resetAll("reconstruct-check");
  const b = buildDirectorContext(store, { input, turnId: "check", env, formLedger: store.formLedger() });
  const identical = a.system === b.system && a.user === b.user;
  const badTurns = [];
  for (const id of store.listTurnIds()) {
    const t = store.turn(id);
    if ((t.status === "committed" || t.status === "delivered") && t.packet && !schemas.isValid("director-packet", t.packet)) badTurns.push(id);
  }
  return { ok: identical && badTurns.length === 0, identical, sessions_reset: Object.keys(before.specialists).length, bad_turns: badTurns, context_chars: a.selection.chars };
}

export function exportState(store, outFile) {
  const bundle = {
    exported_at: new Date().toISOString(), campaign: store.id, branch: store.branch,
    state: Object.fromEntries(Object.values(STATE_FILES).map((f) => [f.replace(/\.json$/, ""), readJson(store.statePath(f), null)])),
    minds: store.minds(),
    generated_voices: listFiles(path.join(store.stateRoot, "voices"), ".json").map((f) => readJson(path.join(store.stateRoot, "voices", f))),
    runtime: { dirty: store.dirty(), form_ledger: store.formLedger(), usage: store.usage(), recent_play: store.recentPlay(), event_index: store.eventIndex() },
    turns: store.listTurnIds().map((id) => store.turn(id)),
  };
  writeJson(outFile, bundle);
  return { path: outFile, turns: bundle.turns.length, facts: bundle.state.facts?.facts?.length ?? 0 };
}

export function importState(store, inFile, { confirm }) {
  if (confirm !== store.id) throw new Error(`import-state overwrites state; confirm with --confirm ${store.id}`);
  const bundle = readJson(inFile);
  if (bundle.campaign !== store.id) throw new Error(`bundle is for campaign ${bundle.campaign}, not ${store.id}`);
  const files = {};
  for (const [name, value] of Object.entries(bundle.state)) if (value) files[`state/${name}.json`] = value;
  for (const m of bundle.minds || []) files[`state/minds/${m.actor}.json`] = m;
  for (const v of bundle.generated_voices || []) files[`state/voices/${v.id}.json`] = v;
  files["runtime/dirty.json"] = bundle.runtime.dirty;
  files["runtime/form-ledger.json"] = bundle.runtime.form_ledger;
  files["runtime/usage.json"] = bundle.runtime.usage;
  files["runtime/recent-play.md"] = bundle.runtime.recent_play || "";
  files["runtime/event-index.json"] = bundle.runtime.event_index || { events: {} };
  for (const t of bundle.turns || []) files[`runtime/turns/${t.turn_id}.json`] = t;
  store.commit(files);
  return { turns: (bundle.turns || []).length };
}

export function repairLock(store, { force = false }) {
  const info = DirLock.info(store.lockPath());
  if (!info) return { released: false, message: "no lock present" };
  const age = store.clock.now() - (info.at || 0);
  if (!force && age < 60_000) return { released: false, message: `lock is only ${Math.round(age / 1000)}s old (owner ${info.owner}); use --force if you are sure no turn is running` };
  DirLock.forceRelease(store.lockPath());
  return { released: true, message: `released lock held by ${info.owner || "?"} (pid ${info.pid || "?"}, age ${Math.round(age / 1000)}s)` };
}

/**
 * Generic-leak scan: every file under the given generic roots must not contain any token from
 * the denylist (case-insensitive substring). Returns { ok, hits[] }.
 */
export function scanGenericTree(roots, denylistFile, { exclude = [] } = {}) {
  const tokens = fs.readFileSync(denylistFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.toLowerCase());
  const hits = [];
  const walk = (p) => {
    if (exclude.some((x) => p.includes(x))) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return; }
    if (!/\.(js|mjs|json|md|txt|yml|yaml|sh)$/.test(p)) return;
    const text = fs.readFileSync(p, "utf8").toLowerCase();
    for (const t of tokens) { const i = text.indexOf(t); if (i >= 0) hits.push({ file: p, token: t, line: text.slice(0, i).split("\n").length }); }
  };
  for (const r of roots) if (exists(r)) walk(r);
  return { ok: hits.length === 0, hits, tokens: tokens.length };
}

export { ensureDir };
