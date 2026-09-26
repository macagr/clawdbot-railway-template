// Fact ledger: pure functions over the facts array plus roster/catalog inputs.
// Code derives who may act on what; models only cite fact ids.
import { schemas } from "../lib/schema.js";

export class LedgerError extends Error {
  constructor(msg, code = "ledger") { super(msg); this.name = "LedgerError"; this.code = code; }
}

export function indexFacts(facts) {
  const m = new Map();
  for (const f of facts) m.set(f.id, f);
  return m;
}

/** Group memberships of an actor: [{group, role}]. */
export function membershipsOf(actors, actorId) {
  return actors.actors[actorId]?.groups || [];
}

/**
 * Does `actorId` have access to a holding? Individual holdings are direct.
 * Group holdings grant access only via a scope rule: the actor is explicitly listed for the
 * scope, or is a member of the scope's group with one of the scope's roles.
 */
export function holdingAccessible(holding, actorId, { actors, catalog }) {
  if (holding.holder.type === "actor") return holding.holder.id === actorId;
  const scope = catalog?.scopes?.[holding.holder.scope];
  if (!scope || scope.group !== holding.holder.id) return false;
  if (scope.actors?.includes(actorId)) return true;
  const roles = scope.roles || [];
  return membershipsOf(actors, actorId).some((m) => m.group === scope.group && (roles.length === 0 || roles.includes(m.role)));
}

/** The holding through which an actor accesses a fact, or null. Individual beats group. */
export function accessOf(fact, actorId, env) {
  const own = fact.holdings.find((h) => h.holder.type === "actor" && h.holder.id === actorId);
  if (own) return { ...own, via_scope: null };
  const viaGroup = fact.holdings.find((h) => h.holder.type === "group" && holdingAccessible(h, actorId, env));
  return viaGroup ? { ...viaGroup, via_scope: viaGroup.holder.scope } : null;
}

export function actorHolds(facts, actorId, factId, env) {
  const f = (facts instanceof Map ? facts : indexFacts(facts)).get(factId);
  if (!f) return false;
  if (f.persistence === "retracted") return false;
  return accessOf(f, actorId, env) !== null;
}

/**
 * Derived permitted-knowledge view for a set of actors: for each actor, the facts they can
 * act on, in the version they hold. Never includes truth status or hidden facts they lack.
 */
export function permittedView(facts, actorIds, env) {
  const view = {};
  for (const a of actorIds) {
    view[a] = [];
    for (const f of facts) {
      if (f.persistence === "retracted") continue;
      const h = accessOf(f, a, env);
      if (!h) continue;
      view[a].push({
        fact: f.id,
        content: h.version === "accurate" ? f.content : (h.variant || f.content),
        version: h.version,
        confidence: h.confidence,
        evidence: h.evidence,
        ...(h.via_scope ? { via_scope: h.via_scope } : {}),
      });
    }
  }
  return view;
}

/** Facts an actor does NOT hold, restricted to a candidate set (used for forbidden lists). */
export function unheldAmong(facts, actorId, factIds, env) {
  return factIds.filter((id) => !actorHolds(facts, actorId, id, env));
}

// ---- mutation helpers (return new arrays; callers commit) ----

export function newFact({ id, content, turn, revision, truth, tags = [], aliases = [] }) {
  const f = {
    id, content, created_turn: turn, created_revision: revision, tags, aliases,
    persistence: "provisional",
    truth: { status: truth?.status ?? "unresolved", authorial: truth?.authorial ?? "undecided", visibility: truth?.visibility ?? "restricted" },
    holdings: [], provenance: [],
  };
  if (f.truth.authorial === "undecided" && f.truth.status !== "unresolved") {
    throw new LedgerError(`fact ${id}: undecided truth must have status 'unresolved'`, "truth-undecided");
  }
  return schemas.validate("fact", f);
}

/** Apply a knowledge event immediately (delays are handled by the caller via pending events). */
export function applyKnowledgeEvent(facts, ev) {
  schemas.validate("knowledge-event", ev);
  const map = indexFacts(facts);
  const f = map.get(ev.fact);
  if (!f) throw new LedgerError(`knowledge event ${ev.id}: unknown fact ${ev.fact}`, "unknown-fact");
  const out = facts.map((x) => (x.id === f.id ? { ...x, holdings: [...x.holdings], provenance: [...x.provenance, ev.id] } : x));
  const target = out.find((x) => x.id === f.id);
  if (!ev.succeeded || !ev.believed) return out; // recorded in provenance, no holding change
  const key = JSON.stringify(ev.to);
  const idx = target.holdings.findIndex((h) => JSON.stringify(h.holder) === key);
  const holding = {
    holder: ev.to, version: ev.fidelity, ...(ev.variant ? { variant: ev.variant } : {}),
    confidence: ev.confidence, evidence: ev.evidence, via: ev.id, since_turn: ev.turn,
  };
  if (idx >= 0) {
    // Upgrade only: a better version or higher confidence replaces; otherwise keep prior holding.
    const prev = target.holdings[idx];
    if (rank(holding.version) >= rank(prev.version) || confRank(holding.confidence) > confRank(prev.confidence)) target.holdings[idx] = holding;
  } else {
    target.holdings.push(holding);
  }
  return out;
}

const VERSION_RANK = { false: 0, distorted: 1, partial: 2, accurate: 3 };
const CONF_RANK = { low: 0, medium: 1, high: 2 };
function rank(v) { return VERSION_RANK[v] ?? 0; }
function confRank(c) { return CONF_RANK[c] ?? 0; }

/** Apply a resolution event: the only way truth changes. */
export function applyResolutionEvent(facts, ev) {
  schemas.validate("resolution-event", ev);
  const f = facts.find((x) => x.id === ev.fact);
  if (!f) throw new LedgerError(`resolution event ${ev.id}: unknown fact ${ev.fact}`, "unknown-fact");
  if (ev.authorial === "undecided" && ev.to_status !== "unresolved") {
    throw new LedgerError(`resolution ${ev.id}: cannot set status '${ev.to_status}' while authorial is undecided`, "truth-undecided");
  }
  return facts.map((x) => (x.id !== f.id ? x : {
    ...x,
    truth: { status: ev.to_status, authorial: ev.authorial, visibility: ev.visibility },
    provenance: [...x.provenance, ev.id],
  }));
}

export function retractFact(facts, factId, eventId) {
  return facts.map((x) => (x.id !== factId ? x : { ...x, persistence: "retracted", provenance: [...x.provenance, eventId] }));
}

export function markSaved(facts, uptoRevision) {
  return facts.map((f) => (f.persistence === "provisional" && (f.created_revision ?? 0) <= uptoRevision ? { ...f, persistence: "saved" } : f));
}

// ---- candidates ----

export function proposeCandidate(candidates, { id, fact, proposal, proposed_status, turn }) {
  const c = schemas.validate("candidate", { id, fact, proposal, ...(proposed_status ? { proposed_status } : {}), status: "open", created_turn: turn });
  return [...candidates, c];
}

export function abandonCandidate(candidates, id, turn) {
  if (!candidates.some((c) => c.id === id)) throw new LedgerError(`unknown candidate ${id}`, "unknown-candidate");
  return candidates.map((c) => (c.id === id ? { ...c, status: "abandoned", updated_turn: turn } : c));
}

/** Promotion is explicit: returns the resolution event to apply and the updated candidate list. */
export function promoteCandidate(candidates, id, { eventId, turn, visibility = "restricted", cause }) {
  const c = candidates.find((x) => x.id === id);
  if (!c) throw new LedgerError(`unknown candidate ${id}`, "unknown-candidate");
  if (c.status !== "open") throw new LedgerError(`candidate ${id} is ${c.status}`, "candidate-closed");
  if (!c.proposed_status || c.proposed_status === "unresolved") throw new LedgerError(`candidate ${id} has no proposed status to promote`, "candidate-no-status");
  const ev = schemas.validate("resolution-event", {
    id: eventId, turn, fact: c.fact, to_status: c.proposed_status, authorial: "decided", visibility, candidate: id, cause: cause || `promoted candidate ${id}: ${c.proposal}`,
  });
  return { event: ev, candidates: candidates.map((x) => (x.id === id ? { ...x, status: "promoted", updated_turn: turn } : x)) };
}

/** Alias/name strings that identify a fact in prose (for forbidden-reveal checks). */
export function factAliases(fact) {
  return [...(fact.aliases || [])].filter((a) => a && a.length >= 3);
}
