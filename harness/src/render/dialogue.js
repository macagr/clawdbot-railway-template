// Dialogue annotation: ⟦say <ACTOR_ID>⟧“…”⟦/say⟧ spans inside natural prose.
// The renderer strips spans before delivery; validation uses the parsed spans.
export const DEFAULT_MARKERS = Object.freeze({ open: "⟦say ", openEnd: "⟧", close: "⟦/say⟧" });

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Parse spans. Returns { spans: [{speaker, text, start, end}], errors: [string] }.
 * Nesting is an error; an unclosed span or a stray close marker is an error.
 */
export function parseSpans(text, markers = DEFAULT_MARKERS) {
  const spans = [];
  const errors = [];
  let i = 0;
  let open = null;
  while (i < text.length) {
    const nextOpen = text.indexOf(markers.open, i);
    const nextClose = text.indexOf(markers.close, i);
    if (nextOpen < 0 && nextClose < 0) break;
    if (nextOpen >= 0 && (nextClose < 0 || nextOpen < nextClose)) {
      if (open) { errors.push(`nested span at ${nextOpen}`); i = nextOpen + markers.open.length; continue; }
      const idEnd = text.indexOf(markers.openEnd, nextOpen + markers.open.length);
      if (idEnd < 0) { errors.push(`unterminated span opener at ${nextOpen}`); break; }
      const speaker = text.slice(nextOpen + markers.open.length, idEnd).trim();
      if (!ID_RE.test(speaker)) errors.push(`invalid speaker id '${speaker}' at ${nextOpen}`);
      open = { speaker, start: nextOpen, bodyStart: idEnd + markers.openEnd.length };
      i = open.bodyStart;
    } else {
      if (!open) { errors.push(`stray close marker at ${nextClose}`); i = nextClose + markers.close.length; continue; }
      spans.push({ speaker: open.speaker, text: text.slice(open.bodyStart, nextClose), start: open.start, end: nextClose + markers.close.length });
      open = null;
      i = nextClose + markers.close.length;
    }
  }
  if (open) errors.push(`unclosed span for '${open.speaker}' at ${open.start}`);
  return { spans, errors };
}

/** Remove all annotation markup, leaving natural prose. Tolerant of malformed markup. */
export function stripSpans(text, markers = DEFAULT_MARKERS) {
  let out = text.split(markers.close).join("");
  out = out.replace(new RegExp(`${escapeRe(markers.open)}[^${escapeRe(markers.openEnd)}]*${escapeRe(markers.openEnd)}`, "g"), "");
  return out;
}

export function speakers(text, markers = DEFAULT_MARKERS) {
  return [...new Set(parseSpans(text, markers).spans.map((s) => s.speaker))];
}

/**
 * Quoted runs outside spans. Not dialogue by contract (signs, documents, memory), but long ones
 * are worth a warning for the Editor. Returns [{text, words}].
 */
export function quotedOutsideSpans(text, { minWords = 6, markers = DEFAULT_MARKERS } = {}) {
  const { spans } = parseSpans(text, markers);
  const inside = (idx) => spans.some((s) => idx >= s.start && idx < s.end);
  const out = [];
  const re = /[“"]([^”"]{3,}?)[”"]/g;
  let m;
  while ((m = re.exec(text))) {
    if (inside(m.index)) continue;
    const words = m[1].trim().split(/\s+/).length;
    if (words >= minWords) out.push({ text: m[1], words });
  }
  return out;
}

export function wordCount(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
