// LocalFilesystemPersistenceAdapter: a durable-canon stand-in on disk (testing, offline play,
// or a git-backed canon directory). Implements the same contract as the webhook adapter,
// including idempotency by save_id, revision checks, and per-target partial failure.
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJson, writeJson, writeFileAtomic, exists } from "../lib/fsx.js";
import { PersistenceError, assertSaveResult, assertSyncManifest } from "./adapter.js";
import { schemas } from "../lib/schema.js";

export class LocalFilesystemPersistenceAdapter {
  constructor({ dir, canonRoles = {}, failTargets = () => [] }) {
    this.dir = path.resolve(dir);
    this.canonRoles = canonRoles;
    this.failTargets = failTargets; // test hook: (packet) => ["target", ...]
    ensureDir(this.dir);
    ensureDir(path.join(this.dir, "canon"));
    ensureDir(path.join(this.dir, "state"));
    if (!exists(this.metaPath())) writeJson(this.metaPath(), { canon_revision: 0, saves: {} });
  }

  metaPath() { return path.join(this.dir, "meta.json"); }
  meta() { return readJson(this.metaPath()); }

  async health() { return { ok: true, message: `local canon at ${this.dir} (revision ${this.meta().canon_revision})` }; }

  async getRemoteRevision() { return { canon_revision: this.meta().canon_revision }; }

  /** Seed canon files from a campaign package (first use). */
  seedFrom(store) {
    for (const [role, rel] of Object.entries(store.manifest.canon || {})) {
      if (typeof rel !== "string") continue;
      const src = store.packagePath(rel);
      if (exists(src) && fs.statSync(src).isFile()) writeFileAtomic(path.join(this.dir, "canon", `${role}.md`), fs.readFileSync(src, "utf8"));
    }
  }

  async pullCanon() {
    const meta = this.meta();
    const files = {};
    for (const f of fs.readdirSync(path.join(this.dir, "canon"))) if (f.endsWith(".md")) files[f.replace(/\.md$/, "")] = fs.readFileSync(path.join(this.dir, "canon", f), "utf8");
    const state = {};
    for (const name of ["scene", "relationships", "unresolved", "actors"]) { const p = path.join(this.dir, "state", `${name}.json`); if (exists(p)) state[name] = readJson(p); }
    for (const name of ["facts", "candidates", "minds"]) { const p = path.join(this.dir, "state", `${name}.json`); if (exists(p)) state[name] = readJson(p); }
    const manifest = { campaign: meta.campaign || "unknown", canon_revision: meta.canon_revision, exported_at: new Date().toISOString(), files, ...(Object.keys(state).length ? { state } : {}) };
    if (manifest.campaign === "unknown") manifest.campaign = "campaign_unknown";
    return assertSyncManifest(manifest);
  }

  async save(packet) {
    schemas.validate("save-packet", packet);
    const meta = this.meta();
    if (meta.saves[packet.save_id]) return assertSaveResult({ ...meta.saves[packet.save_id], status: "duplicate" });
    if (packet.expect.canon_revision !== null && packet.expect.canon_revision !== undefined && String(packet.expect.canon_revision) !== String(meta.canon_revision)) {
      return assertSaveResult({ save_id: packet.save_id, status: "rejected", applied: [], failed: [{ target: "expect", error: `canon revision is ${meta.canon_revision}, packet expected ${packet.expect.canon_revision}` }], canon_revision: meta.canon_revision, message: "revision mismatch; sync first" });
    }
    const failing = new Set(this.failTargets(packet));
    const applied = [], failed = [];
    const tryTarget = (target, fn) => {
      if (failing.has(target)) { failed.push({ target, error: "simulated failure" }); return; }
      try { fn(); applied.push(target); } catch (err) { failed.push({ target, error: err.message }); }
    };
    // replace/state targets first, appends last (an append never lands without its state)
    for (const [name, value] of Object.entries(packet.replace || {})) tryTarget(`state.${name}`, () => writeJson(path.join(this.dir, "state", `${name}.json`), value));
    tryTarget("events", () => {
      const p = path.join(this.dir, "state", "events.json");
      const cur = exists(p) ? readJson(p) : { knowledge: [], resolution: [] };
      writeJson(p, { knowledge: [...cur.knowledge, ...packet.events.knowledge], resolution: [...cur.resolution, ...packet.events.resolution] });
    });
    if (failed.length === 0) {
      if (packet.append.chronicle) tryTarget("chronicle", () => this.#append("recent_history", `\n\n## ${packet.append.chronicle.heading}\n\n${packet.append.chronicle.markdown}\n`));
      if (packet.append.divergences?.length) tryTarget("divergences", () => this.#append("divergence_history", packet.append.divergences.map((d) => `\n\n${d.markdown}\n`).join("")));
      if (packet.append.audit?.length) tryTarget("audit", () => { const p = path.join(this.dir, "audit.jsonl"); fs.appendFileSync(p, packet.append.audit.map((a) => JSON.stringify({ save_id: packet.save_id, ...a })).join("\n") + "\n"); });
    } else {
      for (const t of ["chronicle", "audit"]) if (packet.append[t]) failed.push({ target: t, error: "skipped: state targets failed" });
    }
    const status = failed.length ? (applied.length ? "partial" : "error") : "ok";
    const next = { ...meta, campaign: packet.campaign };
    if (status === "ok") next.canon_revision = meta.canon_revision + 1;
    const result = { save_id: packet.save_id, status, applied, failed, canon_revision: next.canon_revision, message: status === "ok" ? "saved" : "some targets failed; retry with the same save_id" };
    if (status === "ok") next.saves[packet.save_id] = result;
    writeJson(this.metaPath(), next);
    return assertSaveResult(result);
  }

  #append(role, text) {
    const p = path.join(this.dir, "canon", `${role}.md`);
    fs.appendFileSync(p, text);
  }
}
