// Form/shape ledger: recency-weighted usage per dimension value. Pressure is exposed to the
// Director and logged; nothing is rejected for repetition.
export function emptyLedger(decay = 0.7) {
  return { decay, scores: {}, history: [] };
}

/** Decay all scores, then add 1 for each value used by `form`. Returns a new ledger. */
export function recordForm(ledger, form, { turnId, dimensions, pressureSeen }) {
  const next = { decay: ledger.decay, scores: {}, history: [...ledger.history] };
  for (const dim of Object.keys(dimensions)) {
    const prev = ledger.scores[dim] || {};
    next.scores[dim] = {};
    for (const [val, s] of Object.entries(prev)) {
      const d = s * ledger.decay;
      if (d >= 0.01) next.scores[dim][val] = round(d);
    }
    const used = form[dim];
    if (used) next.scores[dim][used] = round((next.scores[dim][used] || 0) + 1);
  }
  next.history.push({ turn: turnId, form, ...(pressureSeen ? { pressure_seen: pressureSeen } : {}) });
  if (next.history.length > 200) next.history = next.history.slice(-200);
  return next;
}

/** Pressure per dimension value in [0,1): score / (1 + total score in that dimension). */
export function pressureReport(ledger, dimensions) {
  const out = {};
  for (const [dim, values] of Object.entries(dimensions)) {
    const scores = ledger.scores[dim] || {};
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    out[dim] = {};
    for (const v of values) out[dim][v] = round((scores[v] || 0) / (1 + total));
  }
  return out;
}

/** Values whose pressure exceeds `threshold` (for logs and /status; advisory only). */
export function highPressure(ledger, dimensions, threshold = 0.5) {
  const rep = pressureReport(ledger, dimensions);
  const hits = [];
  for (const [dim, vals] of Object.entries(rep)) for (const [v, p] of Object.entries(vals)) if (p >= threshold) hits.push({ dimension: dim, value: v, pressure: p });
  return hits;
}

/** Deterministic check that the form uses only configured values. */
export function formErrors(form, dimensions) {
  const errs = [];
  for (const [dim, values] of Object.entries(dimensions)) {
    if (!(dim in form)) errs.push(`form.${dim} missing`);
    else if (!values.includes(form[dim])) errs.push(`form.${dim}='${form[dim]}' not in [${values.join(", ")}]`);
  }
  return errs;
}

function round(x) { return Math.round(x * 1000) / 1000; }
