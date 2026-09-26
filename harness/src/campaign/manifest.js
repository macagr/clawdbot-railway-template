// Campaign manifest loading with generic defaults. Content stays in the campaign package;
// only mechanisms and default knobs live here.
import path from "node:path";
import { readJson } from "../lib/fsx.js";
import { schemas } from "../lib/schema.js";

export const MANIFEST_FILE = "campaign.json";

export const DEFAULTS = Object.freeze({
  language: "en",
  context: {
    recent_turns: 8,
    recent_prose_turns: 2,
    max_voice_cards: 4,
    operational_max_chars: 12000,
    voice_card_max_chars: 3000,
    history_on_demand: true,
    exemplars: 2,
    anti_exemplars: 2,
  },
  budget: { per_turn: 0, per_day: 0, per_month: 0, warn_fraction: 0.8 },
  modes: {
    semantic: { canon_affecting: ["play"], fragments: "prompts/modes" },
    presentation: { fragments: "prompts/presentation", auto_transition: "director_suggests", allowed_transitions: {}, editor_modes: [] },
  },
  agency: { pc_dialogue_by_model: false, stop_on: [] },
  editor: { when: "selected", max_revisions: 1, questions: [] },
  form: {
    decay: 0.7,
    dimensions: {
      length_band: ["short", "medium", "long"],
      structure: ["dialogue", "action", "interior", "mixed"],
      camera: ["close", "medium", "wide"],
      tempo: ["slow", "steady", "quick"],
      ending: ["question", "silence", "cut", "escalation", "rest"],
      sense: ["sight", "sound", "touch", "smell", "taste", "none"],
    },
  },
  propagation: { mode: "rules", catalog: "channels.json", scene_end_pass: true },
  casting: { enabled: true, config: "casting.json" },
  commands: { enabled: ["save", "sync", "status", "context", "mode", "scene", "good", "flat", "ooc", "branch", "resume", "help"], aliases: {} },
  save: { adapter: "none", session_summary: false, timeout_ms: 30000, retries: 2, local_dir: "persistence" },
  sessions: { reset_on_resume: true, reset_on_scene_end: true, token_threshold: 120000 },
  discord: { threads: "off" },
  output: { max_chars: 3500, show_presentation_tag: true, show_stop_reason: true },
  roles: {},
});

export function mergeDefaults(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override === undefined ? base : override;
  if (base && typeof base === "object" && override && typeof override === "object") {
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) out[k] = mergeDefaults(base[k], v);
    return out;
  }
  return override === undefined ? base : override;
}

/** Load and validate <root>/campaign.json, returning a manifest with defaults applied. */
export function loadManifest(root) {
  const raw = readJson(path.join(root, MANIFEST_FILE));
  schemas.validate("campaign-manifest", raw);
  const m = mergeDefaults(DEFAULTS, raw);
  // Enabled mode lists must include their defaults.
  for (const kind of ["semantic", "presentation"]) {
    const block = m.modes[kind];
    if (!block.enabled.includes(block.default)) {
      throw new Error(`campaign.json: modes.${kind}.default '${block.default}' is not in enabled list`);
    }
  }
  return m;
}

export function roleConfig(manifest, role) {
  const r = manifest.roles?.[role];
  if (!r) throw new Error(`campaign.json: no model configured for role '${role}'`);
  return { timeout_ms: 120000, ...r };
}

/**
 * OpenClaw agent id for a role: explicit roles.<role>.agent_id, else the id embedded in an
 * "openclaw:<id>" model ref, else the conventional <campaign>-<role>.
 */
export function agentIdFor(manifest, role, modelRef) {
  const r = manifest.roles?.[role] || {};
  if (r.agent_id) return r.agent_id;
  const ref = modelRef || r.model || "";
  if (ref.startsWith("openclaw:")) return ref.slice("openclaw:".length);
  return `${manifest.id}-${role}`;
}
