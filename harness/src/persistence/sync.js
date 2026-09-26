// Sync flow with explicit conflict semantics.
//   clean local + changed remote      -> pull
//   dirty local + unchanged remote    -> no-op, report unsaved work
//   dirty local + changed remote      -> CONFLICT; options: save first, --stash, --discard <campaign id>
import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeFileAtomic, writeJson, exists } from "../lib/fsx.js";
import { PersistenceError } from "./adapter.js";

export async function syncStatus(store, adapter) {
  const meta = store.meta();
  const dirty = store.dirty().entries.length;
  const remote = await adapter.getRemoteRevision();
  const remoteChanged = meta.canon_revision === null || meta.canon_revision === undefined ? true : String(remote.canon_revision) !== String(meta.canon_revision);
  let state;
  if (!dirty && !remoteChanged) state = "up_to_date";
  else if (!dirty && remoteChanged) state = "clean_pull";
  else if (dirty && !remoteChanged) state = "dirty_unchanged";
  else state = "conflict";
  return { state, dirty, local_canon_revision: meta.canon_revision ?? null, remote_canon_revision: remote.canon_revision };
}

/**
 * @param mode "auto" | "stash" | "discard"
 * @param confirm  for discard, must equal the campaign id
 */
export async function performSync(store, adapter, { at, mode = "auto", confirm, log } = {}) {
  if (store.branch) throw new PersistenceError(`cannot sync while on branch '${store.branch}'`, { code: "branch" });
  const status = await syncStatus(store, adapter);
  if (status.state === "up_to_date") return { ...status, action: "none", message: "Local canon is current and nothing is unsaved." };
  if (status.state === "dirty_unchanged" && mode === "auto") return { ...status, action: "none", message: `${status.dirty} unsaved turn(s); remote unchanged. Run /save.` };
  if (status.state === "conflict" && mode === "auto") {
    return { ...status, action: "conflict", message: [
      `CONFLICT: ${status.dirty} unsaved turn(s) locally AND canon changed remotely (local ${status.local_canon_revision} vs remote ${status.remote_canon_revision}).`,
      "No auto-merge. Choose one:",
      "  /save            try to save first (rejected if the remote change touched saved targets)",
      "  /sync --stash    move unsaved turns to a non-canon stash, then pull",
      `  /sync --discard ${store.id}   delete unsaved turns, then pull (destructive)`,
    ].join("\n") };
  }
  if (mode === "discard" && confirm !== store.id) throw new PersistenceError(`discard requires explicit confirmation: /sync --discard ${store.id}`, { code: "confirm" });
  const manifest = await adapter.pullCanon();
  if ((mode === "stash" || mode === "discard") && status.dirty) {
    if (!manifest.state) throw new PersistenceError("remote canon does not include state; cannot revert local provisional state (stash/discard need remote state)", { code: "no-remote-state" });
    if (mode === "stash") stashDirty(store, at);
  }
  applyManifest(store, manifest, { at, replaceState: mode !== "auto" || status.dirty === 0 });
  return { ...status, action: mode === "auto" ? "pulled" : mode, message: `Pulled canon revision ${manifest.canon_revision} (${Object.keys(manifest.files).length} canon files${manifest.state ? ", state replaced" : ""}).${mode === "stash" ? " Unsaved turns stashed under runtime/stash/." : ""}` };
}

export function stashDirty(store, at) {
  const stamp = at.replace(/[:.]/g, "-");
  const dir = store.runtimePath("stash", stamp);
  ensureDir(dir);
  const dirty = store.dirty();
  for (const e of dirty.entries) {
    const t = store.turn(e.turn_id);
    if (t) writeJson(path.join(dir, `${e.turn_id}.json`), t);
  }
  writeJson(path.join(dir, "stash.json"), { at, entries: dirty.entries, non_canon: true, note: "Provisional turns removed from canon by /sync --stash. Kept for reference only; never replayed." });
  for (const name of ["scene", "facts", "relationships", "unresolved", "candidates", "actors"]) {
    const p = store.statePath(`${name}.json`);
    if (exists(p)) fs.copyFileSync(p, path.join(dir, `state-${name}.json`));
  }
  return dir;
}

export function applyManifest(store, manifest, { at, replaceState }) {
  // Canon files by role -> package paths.
  for (const [role, text] of Object.entries(manifest.files || {})) {
    const rel = store.manifest.canon?.[role];
    if (typeof rel !== "string") continue;
    writeFileAtomic(store.packagePath(rel), text);
  }
  const files = {};
  const meta = store.meta();
  files["state/meta.json"] = { ...meta, canon_revision: manifest.canon_revision, last_synced_at: at, ...(replaceState ? { last_saved_revision: meta.revision } : {}) };
  if (replaceState && manifest.state) {
    const s = manifest.state;
    if (s.scene) files["state/scene.json"] = s.scene;
    if (s.facts) files["state/facts.json"] = { facts: s.facts.map((f) => ({ ...f, persistence: f.persistence === "provisional" ? "saved" : f.persistence })) };
    if (s.relationships) files["state/relationships.json"] = s.relationships;
    if (s.unresolved) files["state/unresolved.json"] = s.unresolved;
    if (s.candidates) files["state/candidates.json"] = { candidates: s.candidates };
    if (s.actors) files["state/actors.json"] = s.actors;
    for (const m of s.minds || []) files[`state/minds/${m.actor}.json`] = m;
    files["runtime/dirty.json"] = { entries: [] };
    files["state/pending-events.json"] = { events: [] };
  }
  store.commit(files);
}
