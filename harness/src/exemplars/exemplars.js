// Exemplars and anti-exemplars: style-only references marked by the player (/good, /flat).
import path from "node:path";
import { readJson, writeJson, listFiles, exists } from "../lib/fsx.js";
import { schemas } from "../lib/schema.js";
import { STYLE_ONLY_BANNER } from "../voices/voices.js";

export function exemplarDir(store, kind) { return store.packagePath(kind === "good" ? "exemplars" : "anti-exemplars"); }

export function listExemplars(store, kind) {
  const dir = exemplarDir(store, kind);
  return listFiles(dir, ".json").map((f) => schemas.validate("exemplar", readJson(path.join(dir, f))));
}

/** Create an exemplar from a delivered turn. Only committed/delivered turns qualify. */
export function markTurn(store, { kind, turnId, note, at, pinned = false }) {
  const turn = store.turn(turnId);
  if (!turn) throw new Error(`unknown turn ${turnId}`);
  if (!["committed", "delivered"].includes(turn.status)) throw new Error(`turn ${turnId} is ${turn.status}; only delivered turns can be marked`);
  if (!turn.output) throw new Error(`turn ${turnId} has no output`);
  const id = `${kind}_${turnId}`;
  const ex = schemas.validate("exemplar", {
    id, kind, turn_id: turnId, style_only: true,
    presentation: turn.packet?.presentation || turn.input?.presentation || store.scene().presentation,
    actors: [...new Set((turn.packet?.npc_intents || []).map((i) => i.npc))],
    created_at: at, ...(note ? { note } : {}), pinned, text: turn.output,
  });
  writeJson(path.join(exemplarDir(store, kind), `${id}.json`), ex);
  return ex;
}

/**
 * Select a few exemplars: pinned first, then by score = presentation match (2) + actor overlap (1 each)
 * + recency tiebreak. Never returns more than `max`.
 */
export function selectExemplars(store, kind, { presentation, actors = [], max = 2 }) {
  if (!max) return [];
  const all = listExemplars(store, kind);
  const scored = all.map((e) => ({
    e,
    score: (e.pinned ? 100 : 0) + (e.presentation === presentation ? 2 : 0) + e.actors.filter((a) => actors.includes(a)).length,
  }));
  scored.sort((a, b) => b.score - a.score || (b.e.created_at > a.e.created_at ? 1 : -1));
  return scored.slice(0, max).map((s) => s.e);
}

export function renderExemplars(exemplars, kind) {
  if (!exemplars.length) return "";
  const label = kind === "good" ? "Exemplars the player marked as good" : "Anti-exemplars the player marked as flat";
  return [`${label}. ${STYLE_ONLY_BANNER}`, ...exemplars.map((e) => `--- (${e.presentation}${e.note ? `; note: ${e.note}` : ""})\n${e.text.trim()}`)].join("\n\n");
}

export function exemplarExists(store, kind, turnId) {
  return exists(path.join(exemplarDir(store, kind), `${kind}_${turnId}.json`));
}
