// Compute the full set of state changes for a validated turn. Pure with respect to disk: takes
// current state, returns the files to write plus a summary. The store commits atomically.
import { newFact, applyKnowledgeEvent, applyResolutionEvent, proposeCandidate, abandonCandidate, promoteCandidate, LedgerError } from "../knowledge/ledger.js";
import { materializeKnowledgeEvent, materializeResolutionEvent, partitionByDelay, dueEvents } from "../knowledge/events.js";
import { applyMindDelta, emptyMind } from "../minds/minds.js";
import { recordForm, pressureReport } from "../form/pressure.js";
import { rulesPass } from "../propagation/propagation.js";
import { castActor } from "../casting/casting.js";

export class CommitError extends Error {
  constructor(msg, code = "commit") { super(msg); this.name = "CommitError"; this.code = code; }
}

/**
 * @param store CampaignStore
 * @param turn  turn record (validated)
 * @param packet Director packet (validated), with npc_intents possibly replaced by NPC decisions
 * @param extra { npcMindDeltas, castings: [{ref, actor, card, mind, craft}], plainOutput, presentation, presentationNote, propagationEvents }
 */
export function computeCommit(store, { turn, packet, plainOutput, npcMindDeltas = [], castings = [], catalog, idGen, presentation, presentationNote, clock, canon = true }) {
  const meta = store.meta();
  const revision = meta.revision + 1;
  const turnId = turn.turn_id;
  const files = {};
  const summary = { revision, facts_new: [], knowledge_events: [], resolution_events: [], candidates: [], minds: [], actors: [], scene_end: false, pending_scheduled: 0, pending_applied: 0 };

  // ---- actors (including castings) ----
  const actors = structuredClone(store.actors());
  const refMap = {};
  for (const c of castings) {
    actors.actors[c.actor.id] = c.actor;
    refMap[c.ref] = c.actor.id;
    files[`state/voices/${c.actor.id}.json`] = c.card;
    files[`state/minds/${c.actor.id}.json`] = c.mind;
    summary.actors.push({ op: "cast", id: c.actor.id });
  }
  const mapActor = (id) => refMap[id] || id;

  // ---- facts ----
  let facts = store.facts();
  const factRefs = {};
  for (const p of packet.fact_proposals || []) {
    const id = idGen("fact");
    factRefs[p.ref] = id;
    facts = [...facts, newFact({ id, content: p.content, turn: turnId, revision, truth: { status: p.truth_status, authorial: p.authorial, visibility: p.visibility }, tags: p.tags || [], aliases: p.aliases || [] })];
    summary.facts_new.push(id);
  }
  const resolveFactRef = (r) => {
    if (r.startsWith("new:")) { if (!factRefs[r]) throw new CommitError(`unknown new fact ref ${r}`, "unknown-ref"); return factRefs[r]; }
    return r;
  };
  const currentFact = (id) => facts.find((f) => f.id === id);

  // ---- candidates ----
  let candidates = store.candidates();
  for (const c of packet.candidate_updates || []) {
    if (c.op === "propose") {
      const id = c.id || idGen("cand");
      candidates = proposeCandidate(candidates, { id, fact: resolveFactRef(c.fact), proposal: c.proposal, proposed_status: c.proposed_status, turn: turnId });
      summary.candidates.push({ op: "propose", id });
    } else if (c.op === "abandon") {
      candidates = abandonCandidate(candidates, c.id, turnId);
      summary.candidates.push({ op: "abandon", id: c.id });
    }
  }

  // ---- resolution events ----
  const resolutionEvents = [];
  for (const r of packet.resolution_events || []) {
    const factId = resolveFactRef(r.fact);
    let ev;
    if (r.candidate && candidates.some((x) => x.id === r.candidate && x.status === "open")) {
      const promoted = promoteCandidate(candidates, r.candidate, { eventId: idGen("res"), turn: turnId, visibility: r.visibility, cause: r.cause });
      candidates = promoted.candidates;
      ev = promoted.event;
    } else {
      ev = materializeResolutionEvent({ ...r, fact: factId }, { id: idGen("res"), turn: turnId, resolveFactRef, currentFact: currentFact(factId) });
    }
    facts = applyResolutionEvent(facts, ev);
    resolutionEvents.push(ev);
    summary.resolution_events.push(ev.id);
  }

  // ---- scene ----
  const scene = structuredClone(store.scene());
  const sd = packet.state_deltas?.scene || {};
  const clockBefore = scene.clock || 0;
  scene.clock = clockBefore + (sd.clock_advance || 0);
  if (sd.location) scene.location = sd.location;
  if (sd.time) scene.time = sd.time; else if (packet.scene.time) scene.time = packet.scene.time;
  scene.present = (sd.present || packet.scene.present || scene.present).map(mapActor);
  if (sd.active_plots) scene.active_plots = sd.active_plots;
  if (sd.summary) scene.summary = sd.summary; else scene.summary = packet.turn_summary;
  if (sd.extensions) scene.extensions = { ...(scene.extensions || {}), ...sd.extensions };
  if (presentation) scene.presentation = presentation;
  if (sd.scene_end) { summary.scene_end = true; scene.scene_id = idGen("scene"); }

  // ---- knowledge events (packet) ----
  const knowledgeEvents = [];
  for (const k of packet.knowledge_events || []) {
    const ev = materializeKnowledgeEvent({ ...k, to: k.to.type === "actor" ? { ...k.to, id: mapActor(k.to.id) } : k.to, from: k.from?.type === "actor" ? { ...k.from, id: mapActor(k.from.id) } : k.from }, { id: idGen("kev"), turn: turnId, catalog, resolveFactRef, clock: scene.clock });
    knowledgeEvents.push(ev);
  }

  // ---- propagation (scene end, rules mode) ----
  let propagationEvents = [];
  if (summary.scene_end && store.manifest.propagation?.scene_end_pass && store.manifest.propagation.mode !== "disabled") {
    const changed = [...summary.facts_new, ...knowledgeEvents.map((e) => e.fact), ...resolutionEvents.map((e) => e.fact)];
    propagationEvents = rulesPass({ facts, changedFactIds: [...new Set(changed)], catalog, actors, turnId, clock: scene.clock, idGen });
  }

  // ---- apply due pending + immediate events; schedule delayed ----
  const pendingBefore = store.pendingEvents();
  const { due, rest } = dueEvents(pendingBefore, scene.clock);
  for (const ev of due) { facts = applyKnowledgeEvent(facts, { ...ev, applied: true }); summary.pending_applied++; }
  const all = [...knowledgeEvents, ...propagationEvents];
  const { now, later } = partitionByDelay(all);
  for (const ev of now) { facts = applyKnowledgeEvent(facts, { ...ev, applied: true }); }
  const pending = [...rest, ...later];
  summary.pending_scheduled = later.length;
  summary.knowledge_events = all.map((e) => e.id);

  // ---- minds ----
  const mindFiles = {};
  const deltas = [...(packet.mind_deltas || []), ...npcMindDeltas];
  for (const d of deltas) {
    const actorId = mapActor(d.actor);
    const base = mindFiles[actorId] || store.mind(actorId) || (files[`state/minds/${actorId}.json`]) || emptyMind(actorId);
    mindFiles[actorId] = applyMindDelta(base, { ...d, actor: actorId }, { turn: turnId });
    summary.minds.push(actorId);
  }
  for (const [id, m] of Object.entries(mindFiles)) files[`state/minds/${id}.json`] = m;

  // ---- relationships ----
  const relationships = structuredClone(store.relationships());
  for (const r of packet.state_deltas?.relationships || []) {
    const key = `${mapActor(r.from)}>${mapActor(r.to)}`;
    const cur = relationships.edges[key] || { stance: "unknown" };
    const next = { ...cur };
    if (r.stance) next.stance = r.stance;
    if (r.trust) next.trust = r.trust;
    if (r.debt !== undefined) next.debt = r.debt;
    if (r.history_add) next.history = [...(cur.history || []), r.history_add].slice(-50);
    next.updated_turn = turnId;
    relationships.edges[key] = next;
  }

  // ---- unresolved ----
  const unresolved = structuredClone(store.unresolved());
  for (const u of packet.state_deltas?.unresolved || []) {
    if (u.op === "add") unresolved.items.push({ id: u.id || idGen("unr"), question: u.question || "(unspecified)", status: "open", actors: (u.actors || []).map(mapActor), locations: u.locations || [], plots: u.plots || [], facts: (u.facts || []).map(resolveFactRef), created_turn: turnId });
    else { const it = unresolved.items.find((x) => x.id === u.id); if (it) { it.status = u.op === "resolve" ? "resolved" : "dropped"; it.updated_turn = turnId; } }
  }

  // ---- actor ops ----
  for (const a of packet.state_deltas?.actors || []) {
    if (a.op === "cast") continue;
    const act = actors.actors[a.id];
    if (!act) continue;
    if (a.op === "appearance") act.appearances = [...(act.appearances || []), { turn: turnId, summary: a.summary || packet.turn_summary }].slice(-200);
    if (a.op === "promote" && a.tier) { act.tier = a.tier; summary.actors.push({ op: "promote", id: a.id, tier: a.tier }); }
    if (a.op === "retire") { act.retired = true; summary.actors.push({ op: "retire", id: a.id }); }
  }
  // Automatic appearance lines for present NPCs.
  for (const id of scene.present) {
    const act = actors.actors[id];
    if (act && act.kind === "npc" && !(packet.state_deltas?.actors || []).some((x) => x.op === "appearance" && x.id === id)) {
      act.appearances = [...(act.appearances || []), { turn: turnId, summary: packet.turn_summary }].slice(-200);
    }
  }

  // ---- form ledger, recent play, dirty, events log, meta ----
  const ledger = store.formLedger();
  const pressureSeen = pressureReport(ledger, store.manifest.form.dimensions);
  const formLedger = recordForm(ledger, packet.form, { turnId, dimensions: store.manifest.form.dimensions, pressureSeen });
  const recent = `${store.recentPlay()}\n\n## ${turnId} (rev ${revision}${presentation ? `, ${presentation}` : ""})\n_${packet.turn_summary}_\n\n${plainOutput}`.trim();
  const recentTrimmed = trimRecent(recent, 60_000);
  const dirty = store.dirty();
  dirty.entries.push({ revision, turn_id: turnId, at: clock.iso(), summary: packet.turn_summary });
  const log = store.events();
  log.knowledge = [...log.knowledge, ...all, ...due.map((e) => ({ ...e, applied: true }))].slice(-5000);
  log.resolution = [...log.resolution, ...resolutionEvents].slice(-5000);

  files["state/meta.json"] = { ...meta, revision };
  files["state/scene.json"] = scene;
  files["state/facts.json"] = { facts };
  files["state/candidates.json"] = { candidates };
  files["state/relationships.json"] = relationships;
  files["state/unresolved.json"] = unresolved;
  files["state/actors.json"] = actors;
  files["state/events.json"] = log;
  files["state/pending-events.json"] = { events: pending };
  files["runtime/form-ledger.json"] = formLedger;
  files["runtime/recent-play.md"] = recentTrimmed;
  files["runtime/dirty.json"] = dirty;
  if (!canon) {
    // Non-canon modes: nothing above is written; only the turn record is kept by the runner.
    return { files: {}, summary: { ...summary, revision: meta.revision, non_canon: true }, revision: meta.revision };
  }
  return { files, summary, revision, presentationNote };
}

function trimRecent(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const idx = cut.indexOf("\n## ");
  return idx >= 0 ? cut.slice(idx + 1) : cut;
}

export { castActor, LedgerError };
