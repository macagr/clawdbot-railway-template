// Usage meter and budget caps. Pure functions over the usage record; the store persists it.
import { roleConfig } from "../campaign/manifest.js";

export class BudgetError extends Error {
  constructor(msg, scope) { super(msg); this.name = "BudgetError"; this.scope = scope; }
}

export function estimateCost(manifest, role, usage) {
  let rc;
  try { rc = roleConfig(manifest, role); } catch { rc = {}; }
  const inP = rc.input_price_per_m ?? 0, outP = rc.output_price_per_m ?? 0;
  const cached = usage.cached_tokens || 0;
  const cost = ((usage.input_tokens - cached) * inP + cached * inP * 0.5 + usage.output_tokens * outP) / 1_000_000;
  return { cost: Math.max(0, cost), estimated: !(inP || outP) ? true : false };
}

export function recordUsage(usageRec, manifest, { at, role, model, usage, turn, cost_reported }) {
  const est = estimateCost(manifest, role, usage);
  const cost = typeof cost_reported === "number" ? cost_reported : est.cost;
  const day = at.slice(0, 10), month = at.slice(0, 7);
  const next = structuredClone(usageRec);
  next.calls.push({ at, ...(turn ? { turn } : {}), role, model, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, ...(usage.cached_tokens ? { cached_tokens: usage.cached_tokens } : {}), cost, estimated: typeof cost_reported === "number" ? false : est.estimated });
  if (next.calls.length > 5000) next.calls = next.calls.slice(-5000);
  const t = next.totals;
  t.cost += cost; t.input_tokens += usage.input_tokens; t.output_tokens += usage.output_tokens;
  t.by_day ||= {}; t.by_month ||= {}; t.by_role ||= {};
  t.by_day[day] = (t.by_day[day] || 0) + cost;
  t.by_month[month] = (t.by_month[month] || 0) + cost;
  t.by_role[role] = (t.by_role[role] || 0) + cost;
  return next;
}

export function turnCost(usageRec, turnId) {
  return usageRec.calls.filter((c) => c.turn === turnId).reduce((s, c) => s + c.cost, 0);
}

/** Throws BudgetError when a hard cap is already reached; returns warnings for soft thresholds. */
export function checkBudget(usageRec, manifest, { at, turnId }) {
  const b = manifest.budget || {};
  const day = at.slice(0, 10), month = at.slice(0, 7);
  const warnings = [];
  const checks = [
    ["per_day", usageRec.totals.by_day?.[day] || 0],
    ["per_month", usageRec.totals.by_month?.[month] || 0],
    ["per_turn", turnId ? turnCost(usageRec, turnId) : 0],
  ];
  for (const [scope, spent] of checks) {
    const cap = b[scope] || 0;
    if (!cap) continue;
    if (spent >= cap) throw new BudgetError(`budget ${scope} reached (${spent.toFixed(4)} >= ${cap})`, scope);
    if (spent >= cap * (b.warn_fraction ?? 0.8)) warnings.push(`${scope}: ${spent.toFixed(4)} of ${cap}`);
  }
  return warnings;
}

export function usageSummary(usageRec, at) {
  const day = at.slice(0, 10), month = at.slice(0, 7);
  return {
    today: usageRec.totals.by_day?.[day] || 0,
    month: usageRec.totals.by_month?.[month] || 0,
    total: usageRec.totals.cost,
    by_role: usageRec.totals.by_role || {},
    calls: usageRec.calls.length,
  };
}
