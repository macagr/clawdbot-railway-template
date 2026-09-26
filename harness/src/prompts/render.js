// Prompt assembly helpers. Generic prompt files live in harness/prompts; campaign fragments are
// appended, never merged into generic text.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exists } from "../lib/fsx.js";

export const PROMPT_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

export function genericPrompt(name) {
  return fs.readFileSync(path.join(PROMPT_DIR, `${name}.md`), "utf8");
}

export function fill(template, vars) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, k) => {
    const v = k.split(".").reduce((o, p) => (o == null ? undefined : o[p]), vars);
    return v === undefined || v === null ? "" : String(v);
  });
}

export function campaignFragment(store, rel) {
  if (!rel) return "";
  const p = store.packagePath(rel);
  return exists(p) ? fs.readFileSync(p, "utf8").trim() : "";
}

export function modeFragment(store, kind, mode) {
  const dir = store.manifest.modes[kind].fragments;
  return campaignFragment(store, path.join(dir, `${mode}.md`));
}

/** Join labelled sections, skipping empty ones. */
export function sections(parts) {
  return parts.filter(([, body]) => body && String(body).trim()).map(([title, body]) => `## ${title}\n\n${String(body).trim()}`).join("\n\n");
}

export function truncate(text, maxChars, marker = "\n[... truncated ...]") {
  if (!maxChars || !text || text.length <= maxChars) return text || "";
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}
