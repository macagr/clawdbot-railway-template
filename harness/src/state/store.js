// CampaignStore: the only module that reads and writes campaign state on disk.
// - explicit files under state/ and runtime/
// - commits are journaled: the full set of new file contents is written to a journal first,
//   then each file is written atomically, then the journal is removed. On open, an existing
//   journal is rolled forward, so a crash mid-commit cannot leave a half-applied revision.
// - a branch redirects state/ and runtime/ to branches/<id>/ while canon and package files
//   stay at the campaign root.
import fs from "node:fs";
import path from "node:path";
import { ensureDir, exists, readJson, writeJson, writeFileAtomic, readText, listFiles, DirLock } from "../lib/fsx.js";
import { schemas } from "../lib/schema.js";
import { loadManifest } from "../campaign/manifest.js";
import { realClock } from "../lib/clock.js";
import { silentLogger } from "../lib/log.js";

export const STATE_FILES = Object.freeze({
  meta: "meta.json",
  scene: "scene.json",
  facts: "facts.json",
  relationships: "relationships.json",
  unresolved: "unresolved.json",
  candidates: "candidates.json",
  actors: "actors.json",
  events: "events.json",
  pendingEvents: "pending-events.json",
});

export class CampaignStore {
  constructor(root, { clock = realClock(), log = silentLogger, branch = null } = {}) {
    this.root = path.resolve(root);
    this.clock = clock;
    this.log = log;
    this.manifest = loadManifest(this.root);
    this.id = this.manifest.id;
    const active = branch ?? readJson(path.join(this.root, "runtime", "active-branch.json"), { id: null }).id;
    this.branch = active || null;
    const base = this.branch ? path.join(this.root, "branches", this.branch) : this.root;
    this.stateRoot = path.join(base, "state");
    this.runtimeRoot = path.join(base, "runtime");
    this.recover();
  }

  // ---- paths ----
  statePath(name) { return path.join(this.stateRoot, name); }
  runtimePath(...parts) { return path.join(this.runtimeRoot, ...parts); }
  packagePath(...parts) { return path.join(this.root, ...parts); }
  mindPath(actor) { return path.join(this.stateRoot, "minds", `${actor}.json`); }
  craftPath(subject) { return path.join(this.root, "craft", subject.startsWith("npc:") ? path.join("npcs", `${subject.slice(4)}.json`) : `${subject}.json`); }
  turnPath(turnId) { return this.runtimePath("turns", `${turnId}.json`); }
  lockPath() { return this.runtimePath(".lock"); }
  journalPath() { return this.runtimePath("commit-journal.json"); }

  // ---- fresh state ----
  static init(root, { clock = realClock(), seed = true } = {}) {
    const manifest = loadManifest(root);
    const stateRoot = path.join(root, "state");
    const runtimeRoot = path.join(root, "runtime");
    ensureDir(path.join(stateRoot, "minds"));
    ensureDir(path.join(runtimeRoot, "turns"));
    ensureDir(path.join(root, "craft", "npcs"));
    const seedDir = path.join(root, "seed", "state");
    const write = (name, fallback) => {
      const target = path.join(stateRoot, name);
      if (exists(target)) return;
      const seedFile = path.join(seedDir, name);
      writeJson(target, seed && exists(seedFile) ? readJson(seedFile) : fallback);
    };
    write(STATE_FILES.meta, { campaign_id: manifest.id, schema_version: 1, revision: 0, canon_revision: null, last_saved_revision: 0, branch: null, session_id: `s${Date.now().toString(36)}` });
    write(STATE_FILES.scene, { scene_id: "scene_0001", location: "start", time: "", clock: 0, present: [], mode: manifest.modes.semantic.default, presentation: manifest.modes.presentation.default, active_plots: [] });
    write(STATE_FILES.facts, { facts: [] });
    write(STATE_FILES.relationships, { edges: {} });
    write(STATE_FILES.unresolved, { items: [] });
    write(STATE_FILES.candidates, { candidates: [] });
    write(STATE_FILES.actors, { actors: { [manifest.player.character]: { id: manifest.player.character, kind: "pc", tier: "major", display_name: manifest.player.character } } });
    write(STATE_FILES.events, { knowledge: [], resolution: [] });
    write(STATE_FILES.pendingEvents, { events: [] });
    if (seed && exists(path.join(seedDir, "minds"))) {
      for (const f of listFiles(path.join(seedDir, "minds"), ".json")) {
        const target = path.join(stateRoot, "minds", f);
        if (!exists(target)) writeJson(target, readJson(path.join(seedDir, "minds", f)));
      }
    }
    const rt = (name, fallback) => { const p = path.join(runtimeRoot, name); if (!exists(p)) writeJson(p, fallback); };
    rt("dirty.json", { entries: [] });
    rt("form-ledger.json", { decay: manifest.form.decay, scores: {}, history: [] });
    rt("usage.json", { calls: [], totals: { cost: 0, input_tokens: 0, output_tokens: 0, by_day: {}, by_month: {}, by_role: {} } });
    rt("event-index.json", { events: {} });
    rt("sessions.json", { session_id: `s${Date.now().toString(36)}`, started_at: clock.iso(), specialists: {} });
    if (!exists(path.join(runtimeRoot, "recent-play.md"))) writeFileAtomic(path.join(runtimeRoot, "recent-play.md"), "");
    return new CampaignStore(root, { clock });
  }

  // ---- readers (validated) ----
  #read(name, schema) {
    const v = readJson(this.statePath(name));
    if (schema) schemas.validate(schema, v);
    return v;
  }
  meta() { return this.#read(STATE_FILES.meta, "meta"); }
  scene() { return this.#read(STATE_FILES.scene, "scene"); }
  facts() { return this.#read(STATE_FILES.facts).facts.map((f) => schemas.validate("fact", f)); }
  relationships() { return this.#read(STATE_FILES.relationships, "relationships"); }
  unresolved() { return this.#read(STATE_FILES.unresolved, "unresolved"); }
  candidates() { return this.#read(STATE_FILES.candidates).candidates.map((c) => schemas.validate("candidate", c)); }
  actors() { return this.#read(STATE_FILES.actors, "actors"); }
  events() { return this.#read(STATE_FILES.events); }
  pendingEvents() { return this.#read(STATE_FILES.pendingEvents).events; }
  mindIds() { return listFiles(path.join(this.stateRoot, "minds"), ".json").map((f) => f.replace(/\.json$/, "")); }
  mind(actor) { const p = this.mindPath(actor); return exists(p) ? schemas.validate("mind", readJson(p)) : null; }
  minds() { return this.mindIds().map((id) => this.mind(id)); }
  craft(subject) { const p = this.craftPath(subject); return exists(p) ? schemas.validate("craft", readJson(p)) : null; }
  dirty() { return schemas.validate("dirty", readJson(this.runtimePath("dirty.json"), { entries: [] })); }
  formLedger() { return schemas.validate("form-ledger", readJson(this.runtimePath("form-ledger.json"))); }
  usage() { return schemas.validate("usage", readJson(this.runtimePath("usage.json"))); }
  sessions() { return schemas.validate("sessions", readJson(this.runtimePath("sessions.json"))); }
  eventIndex() { return readJson(this.runtimePath("event-index.json"), { events: {} }); }
  recentPlay() { return readText(this.runtimePath("recent-play.md"), ""); }
  pendingSave() { const p = this.runtimePath("pending-save.json"); return exists(p) ? schemas.validate("pending-save", readJson(p)) : null; }
  turn(turnId) { const p = this.turnPath(turnId); return exists(p) ? schemas.validate("turn", readJson(p)) : null; }
  listTurnIds() { return listFiles(this.runtimePath("turns"), ".json").map((f) => f.replace(/\.json$/, "")); }
  lastTurns(n) { return this.listTurnIds().slice(-n).map((id) => this.turn(id)); }

  // ---- non-transactional runtime writes (turn records, usage, sessions) ----
  saveTurn(turn) { schemas.validate("turn", turn); writeJson(this.turnPath(turn.turn_id), turn); return turn; }
  saveUsage(usage) { schemas.validate("usage", usage); writeJson(this.runtimePath("usage.json"), usage); }
  saveSessions(s) { schemas.validate("sessions", s); writeJson(this.runtimePath("sessions.json"), s); }
  saveEventIndex(idx) { writeJson(this.runtimePath("event-index.json"), idx); }
  savePendingSave(p) { if (p === null) fs.rmSync(this.runtimePath("pending-save.json"), { force: true }); else { schemas.validate("pending-save", p); writeJson(this.runtimePath("pending-save.json"), p); } }
  saveCraft(subject, craft) { schemas.validate("craft", craft); writeJson(this.craftPath(subject), craft); }

  lock() { return new DirLock(this.lockPath(), { now: this.clock.now, log: (m) => this.log.warn(m) }); }

  /**
   * Journaled atomic commit. `files` maps a path relative to the campaign base
   * ("state/facts.json", "runtime/dirty.json", "state/minds/<id>.json", "runtime/recent-play.md")
   * to an object (JSON) or string. All-or-nothing across files.
   */
  commit(files) {
    const base = this.branch ? path.join(this.root, "branches", this.branch) : this.root;
    const entries = {};
    for (const [rel, content] of Object.entries(files)) {
      if (!rel.startsWith("state/") && !rel.startsWith("runtime/")) throw new Error(`commit: refusing to write outside state/ or runtime/: ${rel}`);
      entries[rel] = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    }
    ensureDir(this.runtimeRoot);
    writeJson(this.journalPath(), { at: this.clock.iso(), base, entries });
    this.#applyJournal({ base, entries });
    fs.rmSync(this.journalPath(), { force: true });
  }

  #applyJournal(journal) {
    for (const [rel, content] of Object.entries(journal.entries)) writeFileAtomic(path.join(journal.base, rel), content);
  }

  /** Roll forward an interrupted commit, if any. Returns true when something was recovered. */
  recover() {
    const p = this.journalPath();
    if (!exists(p)) return false;
    const journal = readJson(p);
    this.log.warn(`[store] rolling forward interrupted commit from ${journal.at}`);
    this.#applyJournal(journal);
    fs.rmSync(p, { force: true });
    return true;
  }
}
