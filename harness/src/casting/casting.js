// Casting: create new actors without collapsing to the same traits. The harness chooses axis
// values (least-used, weighted) and a name; a model may flesh out the voice card afterwards.
// Nothing here is real until the turn commits.
import path from "node:path";
import { readJson, exists } from "../lib/fsx.js";
import { schemas } from "../lib/schema.js";
import { slug } from "../lib/ids.js";
import { emptyMind, emptyCraft } from "../minds/minds.js";
import { genericPrompt, fill, sections } from "../prompts/render.js";

export function loadCastingConfig(store) {
  const c = store.manifest.casting;
  if (!c?.enabled) return null;
  const p = store.packagePath(c.config || "casting.json");
  if (!exists(p)) return null;
  return schemas.validate("casting-config", readJson(p));
}

/** Count how often each axis value is used across the current roster. */
export function axisUsage(actors, axes) {
  const usage = {};
  for (const axis of Object.keys(axes)) {
    usage[axis] = {};
    for (const v of axes[axis].values) usage[axis][v] = 0;
    for (const a of Object.values(actors.actors)) {
      const v = a.axes?.[axis];
      if (v !== undefined) usage[axis][v] = (usage[axis][v] || 0) + 1;
    }
  }
  return usage;
}

/**
 * Choose values: constraints force an axis when `constrained_by` matches a constraint key;
 * archetype seeds fill others; the rest pick the least-used value, ties broken by weight then
 * by `rng` (injectable for tests).
 */
export function chooseAxes(config, actors, { constraints = {}, archetype, rng = Math.random } = {}) {
  const usage = axisUsage(actors, config.axes);
  const seed = archetype ? config.archetypes?.[archetype] || {} : {};
  const chosen = {};
  for (const [axis, def] of Object.entries(config.axes)) {
    if (def.constrained_by && constraints[def.constrained_by] && def.values.includes(constraints[def.constrained_by])) { chosen[axis] = constraints[def.constrained_by]; continue; }
    if (seed[axis] && def.values.includes(seed[axis])) { chosen[axis] = seed[axis]; continue; }
    const weights = def.weights && def.weights.length === def.values.length ? def.weights : def.values.map(() => 1);
    const min = Math.min(...def.values.map((v) => usage[axis][v] || 0));
    const candidates = def.values.map((v, i) => ({ v, w: weights[i] })).filter(({ v, w }) => (usage[axis][v] || 0) === min && w > 0);
    const total = candidates.reduce((s, c) => s + c.w, 0);
    let r = rng() * total;
    let pick = candidates[candidates.length - 1].v;
    for (const c of candidates) { r -= c.w; if (r <= 0) { pick = c.v; break; } }
    chosen[axis] = pick;
  }
  return chosen;
}

export function chooseName(config, actors, { constraints = {}, groups = [], rng = Math.random } = {}) {
  const used = new Set(Object.values(actors.actors).map((a) => a.display_name.toLowerCase()));
  let poolId = config.names.default_pool;
  for (const [key, pool] of Object.entries(config.names.pool_by_constraint || {})) {
    if (constraints[key] || groups.some((g) => g.group === key)) { poolId = pool; break; }
  }
  const pool = config.names.pools[poolId] || Object.values(config.names.pools)[0];
  const free = pool.filter((n) => !used.has(n.toLowerCase()));
  const from = free.length ? free : pool;
  const name = from[Math.floor(rng() * from.length)];
  return free.length ? name : `${name} ${Object.keys(actors.actors).length + 1}`;
}

/** Build the proposed actor, voice-card draft, mind and craft. Pure; nothing is written. */
export function castActor(config, actors, request, { rng = Math.random } = {}) {
  const constraints = request.constraints || {};
  const groups = request.groups || [];
  const axes = chooseAxes(config, actors, { constraints, archetype: constraints.archetype, rng });
  const display_name = chooseName(config, actors, { constraints, groups, rng });
  let id = slug(display_name);
  let n = 2;
  while (actors.actors[id]) id = `${slug(display_name)}_${n++}`;
  const actor = { id, kind: request.kind || "npc", tier: request.returning ? "minor" : "extra", display_name, aliases: [], groups, generated: true, axes, appearances: [] };
  const card = {
    id, style_only: true, display_name, ...(config.voice_defaults ? { inherits: config.voice_defaults } : {}),
    rhythm: axes.rhythm, register: axes.register, humor: axes.humor,
    notes: `Generated. Axes: ${Object.entries(axes).map(([k, v]) => `${k}=${v}`).join(", ")}. Role: ${request.role}.`,
  };
  return { actor, card: schemas.validate("voice-card", card), mind: emptyMind(id), craft: emptyCraft(id) };
}

export function buildCastingContext(store, { actor, card, request, existingCards }) {
  const system = fill(genericPrompt("casting"), { campaign_id: store.manifest.id });
  const user = sections([
    ["Chosen axes", Object.entries(actor.axes).map(([k, v]) => `- ${k}: ${v}`).join("\n")],
    ["Display name", actor.display_name],
    ["Role in the scene (from the Director)", request.role],
    ["Constraints", Object.entries(request.constraints || {}).map(([k, v]) => `- ${k}: ${v}`).join("\n")],
    ["Existing cast voices (do not resemble these)", existingCards.join("\n\n")],
    ["Draft card", JSON.stringify(card, null, 2)],
  ]);
  return { system, user };
}

/** Merge model-provided card fields into the draft; the model cannot change id or style_only. */
export function mergeCastingFields(card, fields) {
  const allowed = ["rhythm", "register", "vocabulary", "sentences", "humor", "stress", "status_modulation", "does_not_sound_like", "examples", "notes"];
  const merged = { ...card };
  for (const k of allowed) if (fields[k] !== undefined) merged[k] = fields[k];
  merged.id = card.id; merged.style_only = true;
  return schemas.validate("voice-card", merged);
}

export function generatedVoicePath(store, id) {
  return path.join(store.stateRoot, "voices", `${id}.json`);
}
