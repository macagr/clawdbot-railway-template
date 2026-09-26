// Deterministic validation: schema, id existence, holdings, truth rules, annotation, speakers,
// forbidden aliases, lengths. Returns { errors, warnings } where errors block the turn.
// Semantic judgments (voice, implied knowledge in prose, named subtext) are NOT here.
import { schemas } from "../lib/schema.js";
import { indexFacts, actorHolds, factAliases } from "../knowledge/ledger.js";
import { formErrors } from "../form/pressure.js";
import { parseSpans, quotedOutsideSpans, wordCount, stripSpans, quotedRuns } from "../render/dialogue.js";

const NEW_REF = /^new:[a-z0-9_-]{1,40}$/;

export function isNewRef(ref) { return NEW_REF.test(ref || ""); }

// Fields models tend to echo from the context into packet.scene. Code owns all of them, so they
// are dropped before schema validation instead of failing the turn. Everything else stays strict.
const SCENE_ECHO_KEYS = ["scene_id", "clock", "mode", "presentation", "presentation_forced", "active_plots", "summary", "extensions", "present_detail"];

/**
 * Normalize a raw Director packet before schema validation. `notes` collects what was changed
 * or dropped so the runner can log it. Mind deltas are supplementary: obvious variants are
 * coerced and deltas that remain invalid are dropped (never failing the turn for them).
 */
export function normalizeDirectorPacket(packet, notes = []) {
  if (!packet || typeof packet !== "object") return packet;
  const out = { ...packet };
  if (out.scene && typeof out.scene === "object") {
    const scene = { ...out.scene };
    for (const k of SCENE_ECHO_KEYS) if (k in scene) { delete scene[k]; notes.push(`scene.${k} dropped (code-owned)`); }
    if (!Array.isArray(scene.beats)) scene.beats = [];
    out.scene = scene;
  }
  for (const k of ["reveals_allowed", "reveals_forbidden", "npc_intents"]) if (out[k] == null) out[k] = [];
  if (typeof out.stop_for_player !== "boolean") out.stop_for_player = Boolean(out.stop_for_player);
  if (Array.isArray(out.mind_deltas)) {
    const kept = [];
    out.mind_deltas.forEach((d, i) => {
      const n = normalizeMindDelta(d);
      const errs = n ? schemas.errors("mind-delta", n) : ["not an object"];
      if (errs.length) notes.push(`mind_deltas[${i}] dropped: ${errs.slice(0, 3).join("; ")}`);
      else kept.push(n);
    });
    out.mind_deltas = kept;
  }
  return out;
}

const INTENT_ALIASES = { text: "what", description: "what", intent: "what", goal: "what", target: "toward" };
const SUSPICION_ALIASES = { text: "hypothesis", suspicion: "hypothesis", subject: "about" };
const INTERP_ALIASES = { text: "reading", interpretation: "reading", event: "of", fact: "of" };

function normalizeMindDelta(d) {
  if (!d || typeof d !== "object" || !d.actor) return null;
  const out = { actor: d.actor };
  const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "intent";
  const objectify = (item, aliases, textKey, extra) => {
    if (typeof item === "string") return { [textKey]: item, ...extra };
    if (!item || typeof item !== "object") return null;
    const o = {};
    for (const [k, v] of Object.entries(item)) o[aliases[k] || k] = v;
    return { ...extra, ...o };
  };
  if (d.intentions_add) out.intentions_add = [].concat(d.intentions_add).map((it) => {
    const o = objectify(it, INTENT_ALIASES, "what", { status: "held" });
    if (!o) return null;
    const keep = { id: o.id || `int_${slugify(o.what || "")}`, what: o.what, status: ["held", "active", "done", "abandoned"].includes(o.status) ? o.status : "held" };
    if (o.toward) keep.toward = o.toward; if (o.trigger) keep.trigger = o.trigger; if (o.since_turn) keep.since_turn = o.since_turn;
    return keep;
  }).filter((x) => x && x.what);
  if (d.intentions_update) out.intentions_update = [].concat(d.intentions_update).map((u) => (u && typeof u === "object" && u.id && u.status ? { id: u.id, status: u.status } : null)).filter(Boolean);
  if (d.suspicions_add) out.suspicions_add = [].concat(d.suspicions_add).map((s) => {
    const o = objectify(s, SUSPICION_ALIASES, "hypothesis", { confidence: "medium" });
    if (!o || !o.hypothesis) return null;
    const keep = { hypothesis: o.hypothesis, confidence: ["low", "medium", "high"].includes(o.confidence) ? o.confidence : "medium" };
    if (o.about) keep.about = String(o.about);
    return keep;
  }).filter(Boolean);
  if (d.suspicions_clear) out.suspicions_clear = [].concat(d.suspicions_clear).map(String);
  if (d.interpretations_add) out.interpretations_add = [].concat(d.interpretations_add).map((it) => {
    const o = objectify(it, INTERP_ALIASES, "reading", {});
    if (!o || !o.reading) return null;
    const keep = { of: String(o.of || "unspecified"), reading: o.reading };
    if (typeof o.unresolved === "boolean") keep.unresolved = o.unresolved;
    return keep;
  }).filter(Boolean);
  if (d.dispositions && typeof d.dispositions === "object") {
    out.dispositions = {};
    for (const [k, v] of Object.entries(d.dispositions)) {
      const key = k.replace(/^toward[_ ]/, "");
      const o = typeof v === "string" ? { stance: v } : (v && typeof v === "object" ? v : null);
      if (!o || !o.stance) continue;
      const keep = { stance: o.stance };
      if (["low", "medium", "high"].includes(o.trust)) keep.trust = o.trust;
      if (["cold", "cool", "warm", "hot"].includes(o.heat)) keep.heat = o.heat;
      out.dispositions[key] = keep;
    }
  }
  if (d.priorities_set) out.priorities_set = [].concat(d.priorities_set).map((p) => (p && typeof p === "object" && p.goal ? { goal: p.goal, weight: typeof p.weight === "number" ? Math.min(1, Math.max(0, p.weight)) : 0.5, ...(p.horizon ? { horizon: p.horizon } : {}) } : null)).filter(Boolean);
  if (d.emotional_baseline && typeof d.emotional_baseline === "object") out.emotional_baseline = d.emotional_baseline;
  if (d.extensions && typeof d.extensions === "object") out.extensions = d.extensions;
  return out;
}

export function validateDirectorPacket(packet, { facts, actors, catalog, manifest, scene }) {
  const errors = [], warnings = [];
  const E = (code, msg) => errors.push({ code, msg });
  const W = (code, msg) => warnings.push({ code, msg });
  for (const e of schemas.errors("director-packet", packet)) E("schema", e);
  if (errors.length) return { ok: false, errors, warnings };

  const fmap = indexFacts(facts);
  const newRefs = new Set((packet.fact_proposals || []).map((p) => p.ref));
  const seenRefs = new Set();
  for (const p of packet.fact_proposals || []) {
    if (seenRefs.has(p.ref)) E("dup-new-ref", `duplicate fact proposal ref ${p.ref}`);
    seenRefs.add(p.ref);
    if ((p.authorial ?? "undecided") === "undecided" && (p.truth_status ?? "unresolved") !== "unresolved") E("truth-undecided", `${p.ref}: undecided truth must be unresolved`);
  }
  const factKnown = (ref) => fmap.has(ref) || newRefs.has(ref);
  const env = { actors, catalog };
  const roster = actors.actors;
  const castRefs = new Set((packet.state_deltas?.actors || []).filter((a) => a.op === "cast").map((a) => a.casting_request?.ref).filter(Boolean));
  const actorKnown = (id) => Boolean(roster[id]) || castRefs.has(id);

  for (const e of formErrors(packet.form, manifest.form.dimensions)) E("form", e);
  if (packet.mode && !manifest.modes.semantic.enabled.includes(packet.mode)) E("mode", `unknown semantic mode ${packet.mode}`);
  for (const k of ["presentation", "presentation_suggestion"]) if (packet[k] && !manifest.modes.presentation.enabled.includes(packet[k])) E("presentation", `unknown presentation mode ${packet[k]}`);
  for (const id of packet.scene.present) if (!actorKnown(id)) E("unknown-actor", `present actor ${id} not in roster`);

  // Delay-0 knowledge events in this packet grant access for citation purposes.
  const grantsNow = new Set((packet.knowledge_events || []).filter((k) => (k.delay ?? catalog.channels?.[k.channel]?.delay ?? 0) === 0 && k.succeeded !== false && k.believed !== false && k.to?.type === "actor").map((k) => `${k.to.id}:${k.fact}`));

  const npcSet = new Set();
  for (const intent of packet.npc_intents) {
    if (npcSet.has(intent.npc)) E("dup-intent", `duplicate intent for ${intent.npc}`);
    npcSet.add(intent.npc);
    const a = roster[intent.npc];
    if (!a && !castRefs.has(intent.npc)) { E("unknown-actor", `intent for unknown actor ${intent.npc}`); continue; }
    if (a && a.kind === "pc") E("pc-intent", `npc_intents may not target the player character ${intent.npc}`);
    if (a && !packet.scene.present.includes(intent.npc)) W("absent-intent", `${intent.npc} has an intent but is not present`);
    for (const fid of intent.acting_on) {
      if (!factKnown(fid)) { E("unknown-fact", `${intent.npc} acting_on unknown fact ${fid}`); continue; }
      const ok = (fmap.has(fid) && actorHolds(facts, intent.npc, fid, env)) || grantsNow.has(`${intent.npc}:${fid}`);
      if (!ok) E("not-held", `${intent.npc} cites ${fid} but does not hold it`);
    }
    for (const fid of intent.must_not_reveal) if (!factKnown(fid)) E("unknown-fact", `${intent.npc} must_not_reveal unknown fact ${fid}`);
  }
  for (const id of packet.npc_decision_requests || []) {
    if (!roster[id] || roster[id].kind !== "npc") E("unknown-actor", `npc_decision_requests: ${id} is not an NPC`);
  }
  for (const fid of packet.reveals_forbidden) if (!factKnown(fid)) E("unknown-fact", `reveals_forbidden unknown fact ${fid}`);
  for (const fid of packet.reveals_allowed) {
    if (!factKnown(fid)) { E("unknown-fact", `reveals_allowed unknown fact ${fid}`); continue; }
    if (packet.reveals_forbidden.includes(fid)) E("reveal-conflict", `${fid} is both allowed and forbidden`);
    if (fmap.has(fid)) {
      const pc = manifest.player.character;
      const heldByPresent = [pc, ...packet.scene.present].some((a) => actorHolds(facts, a, fid, env)) || [...grantsNow].some((g) => g.endsWith(`:${fid}`));
      if (!heldByPresent) E("reveal-unheld", `reveals_allowed ${fid}: no present actor holds it`);
      const f = fmap.get(fid);
      if (f.truth.authorial === "undecided" && !(packet.resolution_events || []).some((r) => r.fact === fid)) W("reveal-undecided", `reveals_allowed ${fid} is undecided; only held versions may surface`);
    }
  }
  for (const k of packet.knowledge_events || []) {
    if (!catalog.channels?.[k.channel]) E("unknown-channel", `knowledge event uses unknown channel ${k.channel}`);
    if (!factKnown(k.fact)) E("unknown-fact", `knowledge event for unknown fact ${k.fact}`);
    if (k.to.type === "actor" && !actorKnown(k.to.id)) E("unknown-actor", `knowledge event to unknown actor ${k.to.id}`);
    if (k.to.type === "group" && !catalog.scopes?.[k.to.scope]) E("unknown-scope", `knowledge event to group ${k.to.id} with unknown scope ${k.to.scope}`);
    if (k.from && k.from.type === "actor" && !actorKnown(k.from.id)) E("unknown-actor", `knowledge event from unknown actor ${k.from.id}`);
    if (k.kind === "transmit" && !k.from) E("transmit-no-source", `transmit event for ${k.fact} has no source`);
  }
  for (const r of packet.resolution_events || []) {
    if (!factKnown(r.fact)) E("unknown-fact", `resolution event for unknown fact ${r.fact}`);
    if (r.candidate && !(packet.candidate_updates || []).some((c) => c.id === r.candidate) && !r.candidate.startsWith("cand")) W("resolution-candidate", `resolution references candidate ${r.candidate}`);
  }
  for (const c of packet.candidate_updates || []) {
    if (c.op === "propose" && (!c.fact || !c.proposal)) E("candidate", "propose needs fact and proposal");
    if (c.op === "propose" && c.fact && !factKnown(c.fact)) E("unknown-fact", `candidate for unknown fact ${c.fact}`);
    if (c.op === "abandon" && !c.id) E("candidate", "abandon needs id");
  }
  for (const d of packet.mind_deltas || []) {
    if (!roster[d.actor] || roster[d.actor].kind !== "npc") E("unknown-actor", `mind delta for non-NPC ${d.actor}`);
  }
  for (const a of packet.state_deltas?.actors || []) {
    if (a.op === "cast") { if (!a.casting_request) E("cast", "cast op needs casting_request"); }
    else if (!a.id || !roster[a.id]) E("unknown-actor", `actor op ${a.op} on unknown actor ${a.id}`);
  }
  for (const r of packet.state_deltas?.relationships || []) for (const id of [r.from, r.to]) if (!actorKnown(id)) E("unknown-actor", `relationship delta with unknown actor ${id}`);
  if (scene && packet.scene.location !== scene.location && !packet.state_deltas?.scene?.location) W("location-drift", `packet location ${packet.scene.location} differs from state ${scene.location} without a scene delta`);
  return { ok: errors.length === 0, errors, warnings };
}

const DEFAULT_LENGTH_BANDS = { short: [0, 260], medium: [180, 650], long: [500, 1400] };

export function validateNovelistOutput(prose, { packet, facts, actors, manifest, pcAllowedToSpeak = false, markers }) {
  const errors = [], warnings = [];
  const E = (code, msg) => errors.push({ code, msg });
  const W = (code, msg) => warnings.push({ code, msg });
  if (typeof prose !== "string" || !prose.trim()) { E("empty", "empty prose"); return { ok: false, errors, warnings, plain: "" }; }
  const { spans, errors: spanErrors } = parseSpans(prose, markers);
  for (const e of spanErrors) E("annotation", e);
  const pcId = manifest.player.character;
  const allowed = new Set(packet.npc_intents.filter((i) => i.speaks !== false).map((i) => i.npc));
  // Dialogue must be annotated: speaking intents exist, the draft contains quoted lines, but no
  // speaker span at all. Without spans the speaker and PC-dialogue checks are vacuous.
  if (spans.length === 0 && allowed.size > 0) {
    const quotes = quotedRuns(prose).filter((q) => q.trim().split(/\s+/).length >= 2);
    if (quotes.length) E("unannotated-dialogue", `${quotes.length} quoted line(s) but no ⟦say <id>⟧ spans; wrap every spoken line in a speaker span (quoted signs/documents excepted)`);
  }
  for (const s of spans) {
    if (s.speaker === pcId) { if (!pcAllowedToSpeak) E("pc-dialogue", `player character ${pcId} voiced: "${s.text.slice(0, 80)}"`); continue; }
    if (!actors.actors[s.speaker]) E("unknown-speaker", `unknown speaker ${s.speaker}`);
    else if (!allowed.has(s.speaker)) E("speaker-not-allowed", `${s.speaker} speaks but has no speaking intent this turn`);
    if (!s.text.trim()) W("empty-span", `empty span for ${s.speaker}`);
  }
  const plain = stripSpans(prose, markers);
  const low = plain.toLowerCase();
  const fmap = indexFacts(facts);
  for (const fid of packet.reveals_forbidden || []) {
    if (low.includes(fid.toLowerCase())) E("forbidden-id", `forbidden fact id ${fid} appears in prose`);
    const f = fmap.get(fid);
    for (const alias of f ? factAliases(f) : []) if (low.includes(alias.toLowerCase())) E("forbidden-alias", `forbidden reveal: alias "${alias}" of ${fid} appears in prose`);
  }
  for (const i of packet.npc_intents) for (const fid of i.must_not_reveal || []) {
    const f = fmap.get(fid);
    for (const alias of f ? factAliases(f) : []) if (low.includes(alias.toLowerCase())) E("forbidden-alias", `${i.npc} must not reveal ${fid}: alias "${alias}" appears`);
  }
  const maxChars = manifest.output?.max_chars || 3500;
  if (plain.length > maxChars) E("too-long", `prose is ${plain.length} chars; max ${maxChars}`);
  const band = packet.form?.length_band;
  const range = DEFAULT_LENGTH_BANDS[band];
  const words = wordCount(plain);
  if (range && (words < range[0] || words > range[1])) W("length-band", `${words} words outside band '${band}' (${range[0]}-${range[1]})`);
  for (const q of quotedOutsideSpans(prose, { markers })) W("quoted-outside-span", `long quoted text outside a speaker span (${q.words} words): "${q.text.slice(0, 60)}"`);
  if (/⟦|⟧/.test(plain)) E("annotation", "stray annotation characters remain after stripping");
  return { ok: errors.length === 0, errors, warnings, plain, speakers: [...new Set(spans.map((s) => s.speaker))], words };
}

export function validateNpcDecision(decision, { npcId, facts, actors, catalog }) {
  const errors = [];
  for (const e of schemas.errors("npc-decision", decision)) errors.push({ code: "schema", msg: e });
  if (errors.length) return { ok: false, errors };
  if (decision.npc !== npcId) errors.push({ code: "npc-mismatch", msg: `decision is for ${decision.npc}, expected ${npcId}` });
  for (const fid of decision.acting_on) if (!actorHolds(facts, npcId, fid, { actors, catalog })) errors.push({ code: "not-held", msg: `${npcId} cites ${fid} but does not hold it` });
  if (decision.mind_delta && decision.mind_delta.actor !== npcId) errors.push({ code: "mind-actor", msg: "mind_delta actor mismatch" });
  return { ok: errors.length === 0, errors };
}

export function formatIssues(result) {
  return [...result.errors.map((e) => `error ${e.code}: ${e.msg}`), ...(result.warnings || []).map((w) => `warn ${w.code}: ${w.msg}`)].join("\n");
}
