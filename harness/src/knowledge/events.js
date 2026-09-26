// Knowledge/resolution event construction from Director proposals, plus delayed-event scheduling.
import { schemas } from "../lib/schema.js";
import { LedgerError } from "./ledger.js";

/**
 * Turn a Director knowledge-event proposal into a full event using the channel catalog for
 * defaults. `resolveFactRef` maps "new:<ref>" or "<FACT_ID>" to a real fact id.
 */
export function materializeKnowledgeEvent(proposal, { id, turn, catalog, resolveFactRef, clock }) {
  const ch = catalog?.channels?.[proposal.channel];
  if (!ch) throw new LedgerError(`unknown channel '${proposal.channel}'`, "unknown-channel");
  const delay = proposal.delay ?? ch.delay ?? 0;
  const ev = {
    id, turn,
    kind: proposal.kind,
    fact: resolveFactRef(proposal.fact),
    from: proposal.from ?? null,
    to: proposal.to,
    channel: proposal.channel,
    delay,
    fidelity: proposal.fidelity ?? ch.fidelity ?? "accurate",
    ...(proposal.variant ? { variant: proposal.variant } : {}),
    evidence: proposal.evidence ?? ch.evidence ?? "testimony",
    succeeded: proposal.succeeded ?? true,
    believed: proposal.believed ?? true,
    confidence: proposal.confidence ?? ch.belief ?? "medium",
    applied: false,
    ...(delay > 0 ? { applies_at: (clock ?? 0) + delay } : {}),
    ...(proposal.note ? { note: proposal.note } : {}),
  };
  if (ev.fidelity !== "accurate" && !ev.variant && ev.kind !== "observe") {
    // A non-accurate transmission without a variant text is allowed but flagged in the note.
    ev.note = `${ev.note ? `${ev.note} ` : ""}[no variant text supplied]`.trim();
  }
  return schemas.validate("knowledge-event", ev);
}

export function materializeResolutionEvent(proposal, { id, turn, resolveFactRef, currentFact }) {
  const factId = resolveFactRef(proposal.fact);
  const ev = {
    id, turn, fact: factId,
    ...(currentFact ? { from_status: currentFact.truth.status } : {}),
    to_status: proposal.to_status,
    authorial: proposal.to_status === "unresolved" ? "undecided" : "decided",
    visibility: proposal.visibility ?? currentFact?.truth.visibility ?? "restricted",
    ...(proposal.candidate ? { candidate: proposal.candidate } : {}),
    cause: proposal.cause,
  };
  return schemas.validate("resolution-event", ev);
}

/** Split events into those applying now and those to schedule. */
export function partitionByDelay(events) {
  const now = [], later = [];
  for (const ev of events) (ev.delay > 0 ? later : now).push(ev);
  return { now, later };
}

/** Pending events whose applies_at <= clock become due. */
export function dueEvents(pending, clock) {
  const due = [], rest = [];
  for (const ev of pending) ((ev.applies_at ?? 0) <= clock ? due : rest).push(ev);
  return { due, rest };
}
