// Context builder: selects the minimum relevant explicit state for each role and records what
// was selected. Roles receive different, filtered views:
//   Director  - canon, scene, relevant facts with truth (it is the authority), minds, unresolved,
//               candidates, form pressure, recent turns, permitted views for present NPCs
//   Novelist  - packet (filtered), PC-held facts, reveals_allowed contents, voice cards, style,
//               presentation fragment, recent prose, exemplars, craft
//   Editor    - packet (filtered), draft, style, voice cards, validation, permitted view
//   NPC       - own card, own mind, own holdings view, scene, question, craft
import fs from "node:fs";
import path from "node:path";
import { exists, listFiles } from "../lib/fsx.js";
import { genericPrompt, fill, campaignFragment, modeFragment, sections, truncate } from "../prompts/render.js";
import { permittedView, indexFacts } from "../knowledge/ledger.js";
import { renderMind, renderCraft } from "../minds/minds.js";
import { selectVoiceCards, STYLE_ONLY_BANNER } from "../voices/voices.js";
import { selectExemplars, renderExemplars } from "../exemplars/exemplars.js";
import { pressureReport } from "../form/pressure.js";

function readCanon(store, role) {
  const rel = store.manifest.canon?.[role];
  if (!rel) return "";
  const p = store.packagePath(rel);
  return exists(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8") : "";
}

/** Keyword hits in detailed history / references, only when the input or scene mentions them. */
function onDemandHistory(store, needles, maxChars = 4000) {
  const hits = [];
  const dirs = [];
  if (store.manifest.canon?.detailed_history) dirs.push(store.packagePath(store.manifest.canon.detailed_history));
  for (const rel of Object.values(store.manifest.canon?.references || {})) dirs.push(store.packagePath(rel));
  const lowered = needles.map((n) => n.toLowerCase()).filter((n) => n.length >= 3);
  for (const dir of dirs) {
    if (!exists(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of listFiles(dir, ".md")) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const low = text.toLowerCase();
      const matched = lowered.filter((n) => low.includes(n));
      if (matched.length) hits.push({ file: path.relative(store.root, path.join(dir, f)).replace(/\\/g, "/"), matched, text: truncate(text, maxChars) });
    }
  }
  return hits;
}

/** Plain validated prose of a committed turn (never the rendered output with harness-added lines). */
export function proseOf(turn) {
  return turn.validation?.plain || turn.output || "";
}

/** The annotated draft (with ⟦say⟧ spans) of a committed turn, for the Novelist's continuity view. */
export function annotatedProseOf(turn) {
  return turn.revised || turn.draft || proseOf(turn);
}

function actorNames(actors, ids) {
  return ids.map((id) => { const a = actors.actors[id]; return a ? `${id} (${a.display_name}, ${a.kind}, ${a.tier})` : id; });
}

function mentionedActors(actors, text) {
  const low = (text || "").toLowerCase();
  return Object.values(actors.actors).filter((a) => [a.display_name, ...(a.aliases || []), a.id].some((n) => n && low.includes(String(n).toLowerCase()))).map((a) => a.id);
}

function relevantFacts(facts, { present, plots, location, recentTurnIds }) {
  const presentSet = new Set(present);
  return facts.filter((f) => {
    if (f.persistence === "retracted") return false;
    if (f.holdings.some((h) => h.holder.type === "actor" && presentSet.has(h.holder.id))) return true;
    if ((f.tags || []).some((t) => plots.includes(t) || t === location)) return true;
    if (recentTurnIds.includes(f.created_turn)) return true;
    return false;
  });
}

function renderFactForDirector(f, actors) {
  const holders = f.holdings.map((h) => `${h.holder.type === "group" ? `${h.holder.id}@${h.holder.scope}` : h.holder.id}:${h.version}/${h.confidence}`).join(", ");
  return `- ${f.id} [${f.truth.status}, ${f.truth.authorial}, ${f.truth.visibility}; ${f.persistence}] ${f.content}${holders ? ` | held by: ${holders}` : " | held by: nobody"}`;
}

export function buildDirectorContext(store, { input, turnId, env, formLedger }) {
  const m = store.manifest;
  const scene = store.scene();
  const actors = store.actors();
  const facts = store.facts();
  const present = scene.present || [];
  const pcId = m.player.character;
  const mentioned = mentionedActors(actors, input.text);
  const involved = [...new Set([...present, ...mentioned])];
  const npcsInvolved = involved.filter((a) => actors.actors[a]?.kind === "npc");
  const recentTurns = store.lastTurns(m.context.recent_turns).filter((t) => t.status === "committed" || t.status === "delivered");
  const recentTurnIds = recentTurns.map((t) => t.turn_id);
  const rel = relevantFacts(facts, { present: involved, plots: scene.active_plots || [], location: scene.location, recentTurnIds });
  const view = permittedView(facts, npcsInvolved, env);
  const minds = npcsInvolved.map((id) => store.mind(id)).filter(Boolean);
  const relationships = store.relationships();
  const relEdges = Object.entries(relationships.edges).filter(([k]) => { const [a, b] = k.split(">"); return involved.includes(a) && involved.includes(b); });
  const unresolved = store.unresolved().items.filter((u) => u.status === "open" && ((u.actors || []).some((a) => involved.includes(a)) || (u.locations || []).includes(scene.location) || (u.plots || []).some((p) => (scene.active_plots || []).includes(p))));
  const candidates = store.candidates().filter((c) => c.status === "open");
  const pending = store.pendingEvents();
  const needles = [...mentioned.map((id) => actors.actors[id].display_name), ...(m.context.history_on_demand ? input.text.split(/\W+/).filter((w) => w.length >= 6) : [])];
  const history = m.context.history_on_demand ? onDemandHistory(store, needles) : [];
  const pressure = pressureReport(formLedger, m.form.dimensions);
  const craft = store.craft("director");

  const system = fill(genericPrompt("director"), { campaign_id: m.id, pc_id: pcId });
  const user = sections([
    ["Campaign Director principles", campaignFragment(store, "prompts/director.md")],
    ["Agency rules", campaignFragment(store, m.agency.fragment)],
    [`Semantic mode: ${scene.mode}`, modeFragment(store, "semantic", scene.mode)],
    [`Presentation mode: ${scene.presentation}`, modeFragment(store, "presentation", scene.presentation)],
    ["Operational canon", truncate(readCanon(store, "operational_canon"), m.context.operational_max_chars)],
    ["Recent history", truncate(readCanon(store, "recent_history"), 6000)],
    ["On-demand history (keyword matched)", history.map((h) => `### ${h.file} (matched: ${h.matched.join(", ")})\n${h.text}`).join("\n\n")],
    ["Scene", JSON.stringify({ ...scene, present_detail: actorNames(actors, present) }, null, 2)],
    ["Actors involved", actorNames(actors, involved).join("\n")],
    ["Roster (ids only)", Object.values(actors.actors).filter((a) => !a.retired).map((a) => `${a.id}:${a.kind}:${a.tier}`).join(", ")],
    ["Relevant facts (you see truth; actors see only their holdings)", rel.map((f) => renderFactForDirector(f, actors)).join("\n")],
    ["Permitted knowledge per involved NPC (derived by code; cite these ids in acting_on)", JSON.stringify(view, null, 2)],
    ["Pending delayed knowledge events", pending.length ? JSON.stringify(pending, null, 2) : ""],
    ["Minds of involved NPCs", minds.map(renderMind).join("\n\n")],
    ["Relationships among involved actors", relEdges.map(([k, v]) => `- ${k}: ${v.stance}${v.trust ? ` (trust ${v.trust})` : ""}${v.debt ? `; debt: ${v.debt}` : ""}`).join("\n")],
    ["Open unresolved items", unresolved.map((u) => `- ${u.id}: ${u.question}`).join("\n")],
    ["Open candidate resolutions (non-canon)", candidates.map((c) => `- ${c.id} for ${c.fact}: ${c.proposal}${c.proposed_status ? ` (would set ${c.proposed_status})` : ""}`).join("\n")],
    ["Recent turns", recentTurns.map((t) => `- ${t.turn_id}: ${t.packet?.turn_summary || "(no summary)"}`).join("\n")],
    ["Last prose", recentTurns.slice(-m.context.recent_prose_turns).map((t) => `--- ${t.turn_id}\n${proseOf(t)}`).join("\n")],
    ["Form dimensions", Object.entries(m.form.dimensions).map(([k, v]) => `- ${k}: ${v.join(" | ")}`).join("\n")],
    ["form_pressure (recency of use; higher = used more recently)", JSON.stringify(pressure, null, 2)],
    ["Available channels (for knowledge_events)", Object.entries(env.catalog.channels || {}).map(([k, v]) => `- ${k}: ${v.label} (delay ${v.delay}, fidelity ${v.fidelity}, evidence ${v.evidence})`).join("\n")],
    ["Director craft notes", renderCraft(craft)],
    ["Player input", `turn_id: ${turnId}\n${input.text}`],
  ]);
  const selection = {
    role: "director", present, mentioned, involved, facts: rel.map((f) => f.id), minds: minds.map((x) => x.actor), unresolved: unresolved.map((u) => u.id),
    candidates: candidates.map((c) => c.id), recent_turns: recentTurnIds, history_files: history.map((h) => h.file), chars: system.length + user.length,
  };
  return { system, user, selection };
}

/** The Novelist never sees these packet fields. */
const NOVELIST_STRIP = ["fact_proposals", "knowledge_events", "resolution_events", "candidate_updates", "mind_deltas", "state_deltas", "npc_decision_requests", "consequences"];

export function filterPacketForNovelist(packet, { facts, actors }) {
  const out = {};
  for (const [k, v] of Object.entries(packet)) if (!NOVELIST_STRIP.includes(k)) out[k] = v;
  out.npc_intents = (packet.npc_intents || []).map((i) => { const { acting_on, must_not_reveal, decision_source, ...rest } = i; return rest; });
  const fmap = indexFacts(facts);
  out.reveals_allowed = (packet.reveals_allowed || []).map((id) => fmap.get(id)?.content || id);
  // Forbidden reveals are given as labels (aliases) or opaque ids, never as content.
  out.reveals_forbidden = (packet.reveals_forbidden || []).map((id) => { const f = fmap.get(id); return f?.aliases?.[0] ? `${f.aliases[0]}` : `[fact ${id}]`; });
  out.present_detail = actorNames(actors, packet.scene?.present || []);
  return out;
}

export function buildNovelistContext(store, { packet, env, revisionNotes }) {
  const m = store.manifest;
  const actors = store.actors();
  const facts = store.facts();
  const pcId = m.player.character;
  const presentation = packet.presentation || store.scene().presentation;
  const filtered = filterPacketForNovelist(packet, { facts, actors });
  const pcView = permittedView(facts, [pcId], env)[pcId] || [];
  const voices = selectVoiceCards(store, actors, { intents: packet.npc_intents, present: packet.scene?.present, pcId, max: m.context.max_voice_cards, context: presentation, maxChars: m.context.voice_card_max_chars });
  const recent = store.lastTurns(m.context.recent_prose_turns).filter((t) => t.output);
  const exemplars = selectExemplars(store, "good", { presentation, actors: voices.selected, max: m.context.exemplars });
  const craft = store.craft("novelist");
  const pcRule = m.agency.pc_dialogue_by_model
    ? `The player character \`${pcId}\` may be voiced only where the packet explicitly grants it.`
    : `Never write dialogue for the player character \`${pcId}\`, and never decide what \`${pcId}\` does beyond what the packet states.`;
  const lengthHint = packet.form?.length_band || "as prescribed";
  const system = fill(genericPrompt("novelist"), { campaign_id: m.id, pc_id: pcId, pc_rule: pcRule, pc_span_note: m.agency.pc_dialogue_by_model ? " unless the packet allows it" : "", length_hint: lengthHint });
  const user = sections([
    ["Campaign voice note", campaignFragment(store, "prompts/novelist.md")],
    ["Style rules", readCanon(store, "style_rules")],
    [`Presentation mode: ${presentation}`, modeFragment(store, "presentation", presentation)],
    ["Director packet", JSON.stringify(filtered, null, 2)],
    ["What the player character currently holds (permitted view)", pcView.map((v) => `- ${v.content}`).join("\n")],
    ["Do not reveal", filtered.reveals_forbidden.map((x) => `- ${x}`).join("\n")],
    [`Voice cards. ${STYLE_ONLY_BANNER}`, voices.text],
    ["Recent prose (continuity of rhythm only; shown with speaker spans as you must write them)", recent.map((t) => `--- ${t.turn_id}\n${annotatedProseOf(t)}`).join("\n")],
    ["Exemplars", renderExemplars(exemplars, "good")],
    ["Novelist craft notes", renderCraft(craft)],
    ["Revision notes from the Editor", revisionNotes ? revisionNotes.map((n) => `- (${n.severity}) ${n.finding}${n.quote ? ` — "${n.quote}"` : ""}${n.suggestion ? ` → ${n.suggestion}` : ""}`).join("\n") : ""],
  ]);
  const selection = { role: "novelist", voices: voices.selected, voices_omitted: voices.omitted, exemplars: exemplars.map((e) => e.id), recent_prose: recent.map((t) => t.turn_id), pc_facts: pcView.map((v) => v.fact), reveals_allowed: packet.reveals_allowed, reveals_forbidden: packet.reveals_forbidden, chars: system.length + user.length };
  return { system, user, selection };
}

export const DEFAULT_EDITOR_QUESTIONS = [
  { id: "implied_knowledge", text: "Does any character act on, react to, or hint at information that the permitted-knowledge view says they do not hold?" },
  { id: "agency_creep", text: "Does the narration choose a consequential action, decision, or line for the player character beyond what the packet states?" },
  { id: "named_subtext", text: "Is any subtext explained to the reader instead of delivered through what is said and done?" },
  { id: "generic_voice", text: "Could any dialogue line be spoken by almost any character rather than the one it is attributed to?" },
  { id: "tension_flattening", text: "Is tension resolved or defused in the same passage that created it?" },
  { id: "emotional_over_interpretation", text: "Does the prose tell the reader what a character feels where the packet only prescribed a register?" },
];

export function buildEditorContext(store, { packet, draft, validation, env }) {
  const m = store.manifest;
  const actors = store.actors();
  const facts = store.facts();
  const pcId = m.player.character;
  const presentation = packet.presentation || store.scene().presentation;
  const filtered = filterPacketForNovelist(packet, { facts, actors });
  const present = packet.scene?.present || [];
  const view = permittedView(facts, present, env);
  const voices = selectVoiceCards(store, actors, { intents: packet.npc_intents, present, pcId, max: m.context.max_voice_cards, context: presentation, maxChars: m.context.voice_card_max_chars });
  const anti = selectExemplars(store, "flat", { presentation, actors: voices.selected, max: m.context.anti_exemplars });
  const questions = (m.editor.questions?.length ? m.editor.questions.map((q, i) => ({ id: `campaign_${i + 1}`, text: q })) : []).concat(DEFAULT_EDITOR_QUESTIONS);
  const system = fill(genericPrompt("editor"), { campaign_id: m.id, questions: questions.map((q) => `- ${q.id}: ${q.text}`).join("\n") });
  const user = sections([
    ["Director packet (as the Novelist saw it)", JSON.stringify(filtered, null, 2)],
    ["Permitted knowledge per present actor (derived by code)", JSON.stringify(view, null, 2)],
    ["Player character", `${pcId} — the model must not decide this character's consequential actions or dialogue.`],
    ["Style rules", readCanon(store, "style_rules")],
    [`Voice cards. ${STYLE_ONLY_BANNER}`, voices.text],
    ["Anti-exemplars", renderExemplars(anti, "flat")],
    ["Deterministic validation results", JSON.stringify(validation || {}, null, 2)],
    ["Draft", draft],
  ]);
  return { system, user, selection: { role: "editor", present, voices: voices.selected, anti_exemplars: anti.map((e) => e.id), questions: questions.map((q) => q.id), chars: system.length + user.length } };
}

export function buildNpcContext(store, { npcId, packet, question, env }) {
  const m = store.manifest;
  const actors = store.actors();
  const facts = store.facts();
  const mind = store.mind(npcId);
  const view = permittedView(facts, [npcId], env)[npcId] || [];
  const card = selectVoiceCards(store, actors, { intents: [{ npc: npcId, speech_acts: [] }], present: [], pcId: m.player.character, max: 1, context: packet?.presentation, maxChars: m.context.voice_card_max_chars });
  const craft = store.craft(`npc:${npcId}`);
  const scene = store.scene();
  const recent = store.lastTurns(m.context.recent_turns).filter((t) => (t.packet?.npc_intents || []).some((i) => i.npc === npcId) || (t.packet?.scene?.present || []).includes(npcId));
  const system = fill(genericPrompt("npc"), { campaign_id: m.id, npc_id: npcId });
  const user = sections([
    ["Scene", JSON.stringify({ location: packet?.scene?.location || scene.location, time: packet?.scene?.time || scene.time, present: packet?.scene?.present || scene.present, beats: packet?.scene?.beats || [] }, null, 2)],
    ["Mind (authoritative)", mind ? renderMind(mind) : "(no mind record; decide from the card and held facts only)"],
    ["Held facts (the ONLY facts this character knows; cite by id)", view.map((v) => `- ${v.fact}: ${v.content} [${v.version}, ${v.confidence}, ${v.evidence}]`).join("\n") || "(none)"],
    ["Recent turns involving this character", recent.map((t) => `- ${t.turn_id}: ${t.packet?.turn_summary || ""}`).join("\n")],
    [`Voice card. ${STYLE_ONLY_BANNER}`, card.text],
    ["Craft notes", renderCraft(craft)],
    ["Decision question", question],
  ]);
  return { system, user, selection: { role: "npc", npc: npcId, facts: view.map((v) => v.fact), mind: Boolean(mind), chars: system.length + user.length } };
}
