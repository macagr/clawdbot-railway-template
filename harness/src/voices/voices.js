// Voice cards: style-only material. Loader, inheritance, trimming, relevance selection.
import fs from "node:fs";
import path from "node:path";
import { readJson, exists, listFiles } from "../lib/fsx.js";
import { schemas } from "../lib/schema.js";

export const STYLE_ONLY_BANNER = "STYLE MATERIAL ONLY. Nothing below is evidence about the current scene, relationships, possessions, knowledge, location, emotional state, plans or chronology.";

export function voicesDir(store) { return store.packagePath("voices"); }

/** Load a single card by id: <voices>/<id>.json or <voices>/<id>.md (markdown becomes `notes`). */
export function loadVoiceCard(store, id) {
  const dir = voicesDir(store);
  const jsonPath = path.join(dir, `${id}.json`);
  if (exists(jsonPath)) return schemas.validate("voice-card", readJson(jsonPath));
  const mdPath = path.join(dir, `${id}.md`);
  if (exists(mdPath)) return schemas.validate("voice-card", { id, style_only: true, notes: fs.readFileSync(mdPath, "utf8").slice(0, 2000) });
  // Generated cards (casting) live in state so they are committed transactionally.
  const generated = path.join(store.stateRoot, "voices", `${id}.json`);
  if (exists(generated)) return schemas.validate("voice-card", readJson(generated));
  return null;
}

export function listVoiceIds(store) {
  const dir = voicesDir(store);
  return [...new Set(listFiles(dir).filter((f) => /\.(json|md)$/.test(f)).map((f) => f.replace(/\.(json|md)$/, "")))];
}

/** Resolve inheritance (child fields win; arrays/objects merge shallowly). */
export function resolveVoiceCard(store, id, depth = 0) {
  const card = loadVoiceCard(store, id);
  if (!card) return null;
  if (!card.inherits || depth > 4) return card;
  const parent = resolveVoiceCard(store, card.inherits, depth + 1) || {};
  const merged = { ...parent, ...card, id: card.id, style_only: true };
  for (const k of ["stress", "status_modulation", "contextual"]) if (parent[k] || card[k]) merged[k] = { ...(parent[k] || {}), ...(card[k] || {}) };
  for (const k of ["does_not_sound_like", "examples"]) if (parent[k] || card[k]) merged[k] = [...(card[k] || []), ...(parent[k] || [])].slice(0, 20);
  delete merged.inherits;
  return merged;
}

/** Voice card for an actor: actor.voice, else actor id, else generic fallback if configured. */
export function voiceForActor(store, actors, actorId, fallbackId = "generic") {
  const a = actors.actors[actorId];
  const id = a?.voice || actorId;
  return resolveVoiceCard(store, id) || (fallbackId ? resolveVoiceCard(store, fallbackId) : null);
}

export function renderVoiceCard(card, { maxChars = 3000, context } = {}) {
  if (!card) return "";
  const L = [];
  L.push(`### Voice: ${card.display_name || card.id} (${card.id})`);
  for (const k of ["rhythm", "register", "vocabulary", "sentences", "humor"]) if (card[k]) L.push(`- ${k}: ${card[k]}`);
  if (card.stress && Object.keys(card.stress).length) L.push(`- under stress: ${Object.entries(card.stress).map(([k, v]) => `${k}: ${v}`).join(" | ")}`);
  if (card.status_modulation && Object.keys(card.status_modulation).length) L.push(`- by status: ${Object.entries(card.status_modulation).map(([k, v]) => `${k}: ${v}`).join(" | ")}`);
  if (card.does_not_sound_like?.length) L.push(`- does not sound like: ${card.does_not_sound_like.join("; ")}`);
  if (context && card.contextual?.[context]) L.push(`- in this context (${context}): ${card.contextual[context]}`);
  if (card.examples?.length) L.push("- example lines (style samples, not things said in play):", ...card.examples.map((e) => `  ${e}`));
  if (card.notes) L.push(`- notes: ${card.notes}`);
  let out = L.join("\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 20)}\n[card truncated]`;
  return out;
}

/**
 * Select the cards relevant to a turn: speaking NPCs first (by number of speech acts),
 * then other present NPCs, capped at `max`. The PC never gets a card here.
 */
export function selectVoiceCards(store, actors, { intents = [], present = [], pcId, max = 4, context, maxChars }) {
  const order = [];
  const seen = new Set();
  const speaking = intents.filter((i) => i.speaks !== false).sort((a, b) => (b.speech_acts?.length || 0) - (a.speech_acts?.length || 0));
  for (const i of speaking) if (!seen.has(i.npc) && i.npc !== pcId) { seen.add(i.npc); order.push(i.npc); }
  for (const i of intents) if (!seen.has(i.npc) && i.npc !== pcId) { seen.add(i.npc); order.push(i.npc); }
  for (const p of present) if (!seen.has(p) && p !== pcId && actors.actors[p]?.kind === "npc") { seen.add(p); order.push(p); }
  const chosen = order.slice(0, max);
  const cards = chosen.map((id) => ({ actor: id, card: voiceForActor(store, actors, id) })).filter((x) => x.card);
  return { selected: cards.map((c) => c.actor), omitted: order.slice(max), text: cards.map((c) => renderVoiceCard(c.card, { context, maxChars })).join("\n\n") };
}
