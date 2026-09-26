// Semantic and presentation mode mechanics. Mode definitions live in the campaign manifest.
export function semanticModes(manifest) { return manifest.modes.semantic; }
export function presentationModes(manifest) { return manifest.modes.presentation; }

export function isCanonMode(manifest, mode) {
  return (manifest.modes.semantic.canon_affecting || []).includes(mode);
}

export function assertSemanticMode(manifest, mode) {
  if (!manifest.modes.semantic.enabled.includes(mode)) throw new Error(`semantic mode '${mode}' is not enabled for this campaign (${manifest.modes.semantic.enabled.join(", ")})`);
  return mode;
}

export function assertPresentation(manifest, mode) {
  if (!manifest.modes.presentation.enabled.includes(mode)) throw new Error(`presentation mode '${mode}' is not enabled (${manifest.modes.presentation.enabled.join(", ")})`);
  return mode;
}

/**
 * Decide the presentation for the committed turn given the Director's suggestion and policy.
 * Returns { presentation, changed, note } where note is a visible report string or null.
 * Never changes when the player has forced a presentation.
 */
export function resolvePresentation(manifest, scene, packet) {
  const pm = manifest.modes.presentation;
  const current = scene.presentation;
  const suggested = packet.presentation_suggestion;
  if (!suggested || suggested === current) return { presentation: current, changed: false, note: null };
  if (!pm.enabled.includes(suggested)) return { presentation: current, changed: false, note: `[presentation suggestion '${suggested}' ignored: not enabled]` };
  if (scene.presentation_forced) return { presentation: current, changed: false, note: `[Director suggests ${suggested}; presentation is pinned to ${current}]` };
  const allowed = pm.allowed_transitions?.[current];
  const permitted = !allowed || allowed.includes(suggested);
  if (pm.auto_transition === "director_changes" && permitted) return { presentation: suggested, changed: true, note: `[presentation: ${current} → ${suggested}]` };
  if (pm.auto_transition === "off") return { presentation: current, changed: false, note: null };
  return { presentation: current, changed: false, note: `[Director suggests ${suggested}${permitted ? "" : " (transition not allowed by policy)"}; use /scene ${suggested} to switch]` };
}
