// Identifier generation. Injectable so tests are deterministic.
import crypto from "node:crypto";

export const ID_PATTERN = "^[a-z][a-z0-9_-]{0,63}$";
export const ID_RE = new RegExp(ID_PATTERN);

export function isId(s) {
  return typeof s === "string" && ID_RE.test(s);
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "x";
}

/** Sortable opaque id: <prefix>_<base36 time><4 hex>. */
export function makeIdGen({ now = Date.now, random = () => crypto.randomBytes(2).toString("hex") } = {}) {
  let last = 0;
  return (prefix) => {
    let t = now();
    if (t <= last) t = last + 1;
    last = t;
    return `${prefix}_${t.toString(36)}${random()}`;
  };
}

/** Deterministic counter-based generator for tests and fixtures. */
export function makeCounterIdGen(start = 1) {
  const counters = new Map();
  return (prefix) => {
    const n = (counters.get(prefix) || start - 1) + 1;
    counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  };
}

export function turnId(campaignId, revision) {
  return `${campaignId}-${String(revision).padStart(6, "0")}`;
}

export function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
