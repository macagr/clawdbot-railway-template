// Deterministic validation: schema, id existence, holdings, truth rules, annotation, speakers,
// forbidden aliases, lengths. Returns { errors, warnings } where errors block the turn.
// Semantic judgments (voice, implied knowledge in prose, named subtext) are NOT here.
import { schemas } from "../lib/schema.js";
import { indexFacts, actorHolds, factAliases } from "../knowledge/ledger.js";
import { formErrors } from "../form/pressure.js";
import { parseSpans, quotedOutsideSpans, wordCount, stripSpans } from "../render/dialogue.js";

const NEW_REF = /^new:[a-z0-9_-]{1,40}$/;

export function isNewRef(ref) { return NEW_REF.test(ref || ""); }

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
