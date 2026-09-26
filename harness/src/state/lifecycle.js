// Turn transaction lifecycle. Pure functions over turn records.
export const STATES = Object.freeze([
  "received", "planned", "drafted", "validated", "committed", "delivered", "abandoned", "failed",
]);

const TRANSITIONS = Object.freeze({
  received: ["planned", "abandoned", "failed"],
  planned: ["planned", "drafted", "abandoned", "failed"],
  drafted: ["drafted", "validated", "abandoned", "failed"],
  validated: ["committed", "abandoned", "failed"],
  committed: ["delivered"],
  delivered: ["delivered"],
  abandoned: [],
  failed: [],
});

export const INCOMPLETE = Object.freeze(["received", "planned", "drafted", "validated"]);
export const MUTATING_STATES = Object.freeze(["committed", "delivered"]);

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export class LifecycleError extends Error {
  constructor(from, to) {
    super(`invalid turn transition ${from} -> ${to}`);
    this.name = "LifecycleError";
  }
}

export function newTurn({ turnId, eventId, revisionBase, input, transport, branch, at }) {
  return {
    turn_id: turnId,
    event_id: eventId,
    status: "received",
    revision_base: revisionBase,
    started_at: at,
    updated_at: at,
    transport,
    ...(branch ? { branch } : {}),
    input,
    history: [{ status: "received", at }],
  };
}

export function transition(turn, to, { at, note, patch = {} } = {}) {
  if (!canTransition(turn.status, to)) throw new LifecycleError(turn.status, to);
  const next = { ...turn, ...patch, status: to, updated_at: at ?? turn.updated_at };
  next.history = [...(turn.history || []), { status: to, at: at ?? turn.updated_at, ...(note ? { note: String(note).slice(0, 500) } : {}) }];
  return next;
}

export function isIncomplete(turn) {
  return INCOMPLETE.includes(turn.status);
}
