// SillyTavern character-card adapter (import/export). The internal voice-card schema is not
// shaped by SillyTavern; this adapter translates what it can and reports loss explicitly.
import { schemas } from "../lib/schema.js";
import { slug } from "../lib/ids.js";

const ST_FIELDS = ["name", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions", "alternate_greetings", "tags", "creator", "character_version", "extensions"];

/** Import a SillyTavern V2 (or V1) card object into a voice card. Returns { card, loss[] }. */
export function importSillyTavern(raw, { id } = {}) {
  const data = raw?.spec === "chara_card_v2" || raw?.spec === "chara_card_v3" ? raw.data : raw;
  if (!data || typeof data !== "object") throw new Error("not a SillyTavern card object");
  const loss = [];
  const name = data.name || "unnamed";
  const cardId = id || slug(name);
  const examples = [];
  if (data.mes_example) {
    for (const block of String(data.mes_example).split(/<START>/i)) {
      for (const line of block.split(/\n/)) {
        const m = line.match(/^\s*\{\{char\}\}:\s*(.+)$/i);
        if (m) examples.push(m[1].trim().slice(0, 600));
      }
    }
    if (!examples.length) loss.push("mes_example had no {{char}} lines; kept nothing");
  }
  const card = {
    id: cardId, style_only: true, display_name: name,
    ...(data.personality ? { register: String(data.personality).slice(0, 2000) } : {}),
    ...(data.description ? { notes: `Imported description (STYLE ONLY, not facts): ${String(data.description).slice(0, 1800)}` } : {}),
    ...(examples.length ? { examples: examples.slice(0, 20) } : {}),
  };
  for (const f of ["scenario", "first_mes", "alternate_greetings", "system_prompt", "post_history_instructions", "creator_notes", "extensions"]) {
    if (data[f] && (Array.isArray(data[f]) ? data[f].length : true)) loss.push(`${f}: dropped (world/scene content is not voice material)`);
  }
  if (data.tags?.length) loss.push(`tags: dropped (${data.tags.length})`);
  if (data.description) loss.push("description: kept only as a style note; any facts inside are NOT canon");
  loss.push("rhythm/sentences/humor/stress/status_modulation: not representable in SillyTavern; left empty");
  return { card: schemas.validate("voice-card", card), loss };
}

/** Export a voice card to a SillyTavern V2 card. Returns { card, loss[] }. */
export function exportSillyTavern(voice) {
  schemas.validate("voice-card", voice);
  const loss = [];
  const parts = [];
  for (const k of ["rhythm", "register", "vocabulary", "sentences", "humor"]) if (voice[k]) parts.push(`${k}: ${voice[k]}`);
  if (voice.stress) parts.push(`under stress: ${Object.entries(voice.stress).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  if (voice.status_modulation) parts.push(`by status: ${Object.entries(voice.status_modulation).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  if (voice.does_not_sound_like?.length) parts.push(`does not sound like: ${voice.does_not_sound_like.join("; ")}`);
  const mes_example = (voice.examples || []).map((e) => `<START>\n{{char}}: ${e}`).join("\n");
  const card = {
    spec: "chara_card_v2", spec_version: "2.0",
    data: {
      name: voice.display_name || voice.id,
      description: "",
      personality: parts.join("\n"),
      scenario: "", first_mes: "", mes_example,
      creator_notes: `Exported from a style-only voice card (${voice.id}). Contains no facts, relationships or scene state.${voice.notes ? ` Notes: ${voice.notes}` : ""}`,
      system_prompt: "", post_history_instructions: "", alternate_greetings: [], tags: ["voice-card", "style-only"], creator: "rp-harness", character_version: "1", extensions: {},
    },
  };
  loss.push("description/scenario/first_mes: empty by design (the harness owns facts and scenes)");
  if (voice.contextual) loss.push("contextual modulation: folded into creator_notes only");
  if (voice.inherits) loss.push(`inherits '${voice.inherits}': not representable; export the resolved card instead`);
  return { card, loss };
}

export const SILLYTAVERN_FIELDS = ST_FIELDS;
