// Scene-end knowledge propagation. Generic mechanics only; channels, scopes and rules come
// from the campaign catalog. Every outcome is a KnowledgeEvent; nothing propagates implicitly.
import { materializeKnowledgeEvent } from "../knowledge/events.js";
import { accessOf } from "../knowledge/ledger.js";
import { genericPrompt, fill, sections } from "../prompts/render.js";

/**
 * Deterministic rules pass. For each fact changed this scene, each catalog rule whose `when`
 * matches produces one event to `rule.to`, unless the target already holds the fact.
 */
export function rulesPass({ facts, changedFactIds, catalog, actors, turnId, clock, idGen }) {
  const events = [];
  const byId = new Map(facts.map((f) => [f.id, f]));
  for (const fid of changedFactIds) {
    const f = byId.get(fid);
    if (!f || f.persistence === "retracted") continue;
    for (const rule of catalog.rules || []) {
      if (!ruleMatches(rule.when, f)) continue;
      if (alreadyHeld(f, rule.to, { actors, catalog })) continue;
      const ch = catalog.channels[rule.channel];
      if (!ch) continue;
      events.push(materializeKnowledgeEvent({
        kind: "transmit", fact: fid, from: sourceFor(f), to: rule.to, channel: rule.channel,
        delay: rule.delay, fidelity: rule.fidelity, succeeded: rule.succeeded, believed: rule.believed, note: `rule ${rule.id}`,
      }, { id: idGen("kev"), turn: turnId, catalog, resolveFactRef: (r) => r, clock }));
    }
  }
  return events;
}

function ruleMatches(when, fact) {
  if (!when) return false;
  if (when.fact_tags && !when.fact_tags.some((t) => (fact.tags || []).includes(t))) return false;
  if (when.visibility && fact.truth.visibility !== when.visibility) return false;
  if (when.held_by_actor && !fact.holdings.some((h) => h.holder.type === "actor" && h.holder.id === when.held_by_actor)) return false;
  if (when.held_by_group && !fact.holdings.some((h) => h.holder.type === "group" && h.holder.id === when.held_by_group)) return false;
  return true;
}

function alreadyHeld(fact, to, env) {
  if (to.type === "actor") return accessOf(fact, to.id, env) !== null;
  return fact.holdings.some((h) => h.holder.type === "group" && h.holder.id === to.id && h.holder.scope === to.scope);
}

function sourceFor(fact) {
  const h = fact.holdings.find((x) => x.holder.type === "actor");
  return h ? h.holder : null;
}

/** Build the model-assisted pass prompt. The caller validates output as propagation-output. */
export function buildPropagationContext(store, { changedFacts, catalog, actors }) {
  const m = store.manifest;
  const system = fill(genericPrompt("propagation"), { campaign_id: m.id });
  const user = sections([
    ["Facts changed this scene", changedFacts.map((f) => `- ${f.id}: ${f.content} | held by: ${f.holdings.map((h) => (h.holder.type === "group" ? `${h.holder.id}@${h.holder.scope}` : h.holder.id)).join(", ") || "nobody"} | visibility ${f.truth.visibility}`).join("\n")],
    ["Actors (id: name, kind, tier, groups)", Object.values(actors.actors).filter((a) => !a.retired).map((a) => `- ${a.id}: ${a.display_name}, ${a.kind}, ${a.tier}${a.groups?.length ? `, groups ${a.groups.map((g) => `${g.group}/${g.role || "member"}`).join(" ")}` : ""}`).join("\n")],
    ["Channels", Object.entries(catalog.channels).map(([k, v]) => `- ${k}: ${v.label}; delay ${v.delay}; fidelity ${v.fidelity}; evidence ${v.evidence}${v.access?.length ? `; access ${v.access.join(",")}` : ""}`).join("\n")],
    ["Campaign propagation notes", store.manifest.propagation?.notes || ""],
  ]);
  return { system, user };
}

/** Filter model proposals: unknown channels/facts/actors are dropped with a reason. */
export function filterProposals(proposals, { facts, catalog, actors }) {
  const byId = new Set(facts.map((f) => f.id));
  const kept = [], dropped = [];
  for (const p of proposals) {
    if (!catalog.channels[p.channel]) { dropped.push({ p, reason: "unknown channel" }); continue; }
    if (!byId.has(p.fact)) { dropped.push({ p, reason: "unknown fact" }); continue; }
    if (p.to.type === "actor" && !actors.actors[p.to.id]) { dropped.push({ p, reason: "unknown recipient" }); continue; }
    if (p.to.type === "group" && !catalog.scopes?.[p.to.scope]) { dropped.push({ p, reason: "unknown scope" }); continue; }
    if (p.from && p.from.type === "actor" && !actors.actors[p.from.id]) { dropped.push({ p, reason: "unknown source" }); continue; }
    const ch = catalog.channels[p.channel];
    if (ch.access?.length && p.from?.type === "actor") {
      const groups = (actors.actors[p.from.id].groups || []).map((g) => g.group);
      if (!ch.access.some((g) => groups.includes(g))) { dropped.push({ p, reason: "source lacks channel access" }); continue; }
    }
    kept.push(p);
  }
  return { kept, dropped };
}
