// NPC minds: explicit authoritative mental state. Holdings live in the ledger, not here.
import { schemas } from "../lib/schema.js";

export function emptyMind(actor) {
  return { actor, revision: 0, dispositions: {}, priorities: [], intentions: [], suspicions: [], interpretations: [], emotional_baseline: {} };
}

/** Apply a validated mind delta to a mind (pure). Unknown intention ids in updates are ignored with a note. */
export function applyMindDelta(mind, delta, { turn } = {}) {
  schemas.validate("mind-delta", delta);
  if (delta.actor !== mind.actor) throw new Error(`mind delta actor ${delta.actor} != ${mind.actor}`);
  const next = { ...mind, revision: (mind.revision || 0) + 1, ...(turn ? { updated_turn: turn } : {}) };
  if (delta.dispositions) next.dispositions = { ...mind.dispositions, ...delta.dispositions };
  if (delta.priorities_set) next.priorities = delta.priorities_set;
  if (delta.intentions_add) next.intentions = [...mind.intentions, ...delta.intentions_add.map((i) => ({ ...i, ...(turn && !i.since_turn ? { since_turn: turn } : {}) }))];
  if (delta.intentions_update) {
    const upd = new Map(delta.intentions_update.map((u) => [u.id, u.status]));
    next.intentions = (next.intentions || mind.intentions).map((i) => (upd.has(i.id) ? { ...i, status: upd.get(i.id) } : i));
  }
  if (delta.suspicions_add) next.suspicions = [...mind.suspicions, ...delta.suspicions_add];
  if (delta.suspicions_clear) next.suspicions = (next.suspicions || mind.suspicions).filter((s) => !delta.suspicions_clear.includes(s.about));
  if (delta.interpretations_add) next.interpretations = [...mind.interpretations, ...delta.interpretations_add];
  if (delta.emotional_baseline) next.emotional_baseline = { ...mind.emotional_baseline, ...delta.emotional_baseline };
  if (delta.extensions) next.extensions = { ...(mind.extensions || {}), ...delta.extensions };
  return schemas.validate("mind", next);
}

/** A compact, model-facing rendering of a mind (no holdings; those come from the ledger). */
export function renderMind(mind) {
  const lines = [`Mind of ${mind.actor} (revision ${mind.revision})`];
  const d = Object.entries(mind.dispositions || {});
  if (d.length) lines.push("Dispositions:", ...d.map(([k, v]) => `- toward ${k}: ${v.stance}${v.trust ? `, trust ${v.trust}` : ""}${v.heat ? `, heat ${v.heat}` : ""}`));
  if (mind.priorities?.length) lines.push("Priorities:", ...mind.priorities.map((p) => `- ${p.goal} (weight ${p.weight}${p.horizon ? `, ${p.horizon}` : ""})`));
  const live = (mind.intentions || []).filter((i) => i.status === "held" || i.status === "active");
  if (live.length) lines.push("Intentions:", ...live.map((i) => `- [${i.status}] ${i.what}${i.toward ? ` (toward ${i.toward})` : ""}${i.trigger ? `; trigger: ${i.trigger}` : ""}`));
  if (mind.suspicions?.length) lines.push("Suspicions:", ...mind.suspicions.map((s) => `- ${s.hypothesis} (${s.confidence})`));
  const open = (mind.interpretations || []).filter((i) => i.unresolved !== false);
  if (open.length) lines.push("Open interpretations:", ...open.map((i) => `- of ${i.of}: ${i.reading}`));
  if (mind.emotional_baseline?.register) lines.push(`Emotional baseline: ${mind.emotional_baseline.register}${mind.emotional_baseline.volatility ? ` (volatility ${mind.emotional_baseline.volatility})` : ""}`);
  return lines.join("\n");
}

export function emptyCraft(subject) {
  return { subject, non_evidential: true, habits_to_avoid: [], recent_patterns: [], performance_notes: [] };
}

export function renderCraft(craft) {
  if (!craft) return "";
  const lines = ["NON-EVIDENTIAL craft notes (style guidance only; says nothing about the fictional world):"];
  if (craft.habits_to_avoid?.length) lines.push("Avoid:", ...craft.habits_to_avoid.map((x) => `- ${x}`));
  if (craft.recent_patterns?.length) lines.push("Recently used patterns:", ...craft.recent_patterns.map((x) => `- ${x}`));
  if (craft.performance_notes?.length) lines.push("Performance notes:", ...craft.performance_notes.map((x) => `- ${x}`));
  return lines.join("\n");
}
