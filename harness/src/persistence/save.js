// Save flow: build an idempotent packet from the dirty ledger, send it, and only then mark
// local state as saved. Partial failure keeps the packet pending with the same save_id.
import fs from "node:fs";
import { sha256 } from "../lib/ids.js";
import { markSaved } from "../knowledge/ledger.js";
import { schemas } from "../lib/schema.js";
import { PersistenceError } from "./adapter.js";
import { genericPrompt, fill, sections } from "../prompts/render.js";
import { LocalFilesystemPersistenceAdapter } from "./local.js";
import { WebhookPersistenceAdapter } from "./webhook.js";
import { NoopPersistenceAdapter } from "./adapter.js";

export function createAdapter(store, { env = process.env, fetchImpl, adapters = {} } = {}) {
  const s = store.manifest.save;
  if (adapters[s.adapter]) return adapters[s.adapter];
  if (s.adapter === "local") return new LocalFilesystemPersistenceAdapter({ dir: store.packagePath(s.local_dir || "persistence"), canonRoles: store.manifest.canon });
  if (s.adapter === "webhook") return new WebhookPersistenceAdapter({ campaignId: store.id, endpointEnv: s.endpoint_env || "RP_SAVE_URL", tokenEnv: s.token_env || "RP_SAVE_TOKEN", syncEndpointEnv: s.sync_endpoint_env || "RP_SYNC_URL", env, fetchImpl, timeoutMs: s.timeout_ms, retries: s.retries });
  return new NoopPersistenceAdapter();
}

/** Dirty turns' committed records, in revision order. */
export function dirtyTurns(store) {
  return store.dirty().entries.map((e) => ({ entry: e, turn: store.turn(e.turn_id) })).filter((x) => x.turn && (x.turn.status === "committed" || x.turn.status === "delivered"));
}

export function buildSavePacket(store, { at, summary } = {}) {
  const meta = store.meta();
  const dirty = store.dirty();
  if (!dirty.entries.length) throw new PersistenceError("nothing to save (no unsaved turns)", { code: "nothing" });
  if (store.branch) throw new PersistenceError(`cannot save from branch '${store.branch}'; promote or discard it first`, { code: "branch" });
  const turns = dirtyTurns(store);
  const from = dirty.entries[0].revision, to = dirty.entries[dirty.entries.length - 1].revision;
  const turnIds = turns.map((t) => t.turn.turn_id);
  const events = store.events();
  const knowledge = events.knowledge.filter((e) => turnIds.includes(e.turn));
  const resolution = events.resolution.filter((e) => turnIds.includes(e.turn));
  const chronicleMd = turns.map(({ turn }) => `### ${turn.turn_id}\n_${turn.packet?.turn_summary || ""}_\n\n${turn.output || ""}`).join("\n\n");
  const sessions = store.sessions();
  const body = {
    schema_version: 1, campaign: store.id, session_id: sessions.session_id, created_at: at,
    source: { revision_from: from, revision_to: to, turn_ids: turnIds },
    expect: { canon_revision: meta.canon_revision ?? null },
    append: {
      chronicle: { heading: `Session ${sessions.session_id}, revisions ${from}-${to}`, markdown: summary ? `${summary}\n\n${chronicleMd}` : chronicleMd },
      audit: dirty.entries.map((e) => ({ turn_id: e.turn_id, summary: e.summary || "", revision: e.revision })),
    },
    replace: {
      scene: store.scene(), facts: store.facts(), relationships: store.relationships(), unresolved: store.unresolved(),
      candidates: store.candidates(), actors: store.actors(), minds: store.minds(),
    },
    events: { knowledge, resolution },
    ...(summary ? { summary } : {}),
  };
  const save_id = `${store.id}:save:${sessions.session_id}:${from}-${to}:${sha256(JSON.stringify(body.replace) + JSON.stringify(body.events)).slice(0, 12)}`;
  return schemas.validate("save-packet", { ...body, save_id });
}

export function buildSummaryContext(store, packet) {
  const system = fill(genericPrompt("summary"), { campaign_id: store.id });
  const user = sections([["Turns", packet.append.audit.map((a) => `- ${a.turn_id}: ${a.summary}`).join("\n")]]);
  return { system, user };
}

/**
 * Perform a save. Returns { status, result, packet } and mutates local state only on "ok".
 * On partial/error the packet is kept in runtime/pending-save.json for a retry with the same id.
 */
export async function performSave(store, adapter, { at, retryPending = true, caller, log } = {}) {
  let pending = retryPending ? store.pendingSave() : null;
  let packet;
  if (pending && pending.packet.source.revision_to === store.meta().revision) {
    packet = pending.packet; // identical unsaved range: reuse the id for idempotency
  } else {
    let summary;
    if (store.manifest.save.session_summary && caller && store.manifest.roles.summary) {
      try {
        const draft = buildSavePacket(store, { at });
        const res = await caller.call("summary", buildSummaryContext(store, draft), { allowFallback: false });
        summary = res.text.trim();
      } catch (err) { log?.warn?.(`session summary skipped: ${err.message}`); }
    }
    packet = buildSavePacket(store, { at, summary });
    pending = null;
  }
  let result;
  try {
    result = await adapter.save(packet);
  } catch (err) {
    store.savePendingSave({ packet, attempts: (pending?.attempts || 0) + 1, last_error: err.message, last_result: null, updated_at: at });
    return { status: "error", error: err, packet };
  }
  if (result.status === "ok" || result.status === "duplicate") {
    applySaved(store, packet, result, at);
    store.savePendingSave(null);
    return { status: result.status, result, packet };
  }
  store.savePendingSave({ packet, attempts: (pending?.attempts || 0) + 1, last_error: result.message || result.status, last_result: result, updated_at: at });
  return { status: result.status, result, packet };
}

function applySaved(store, packet, result, at) {
  const meta = store.meta();
  const facts = markSaved(store.facts(), packet.source.revision_to);
  const files = {
    "state/meta.json": { ...meta, last_saved_revision: packet.source.revision_to, canon_revision: result.canon_revision ?? meta.canon_revision, last_saved_at: at },
    "state/facts.json": { facts },
    "runtime/dirty.json": { entries: store.dirty().entries.filter((e) => e.revision > packet.source.revision_to) },
  };
  store.commit(files);
  // Keep the local recent-history canon copy current (package file, non-transactional).
  const rel = store.manifest.canon?.recent_history;
  if (rel && packet.append.chronicle) {
    try { fs.appendFileSync(store.packagePath(rel), `\n\n## ${packet.append.chronicle.heading}\n\n${packet.append.chronicle.markdown}\n`); } catch {}
  }
}

export function dryRunSave(store, { at }) {
  const packet = buildSavePacket(store, { at });
  return { packet, size: JSON.stringify(packet).length, turns: packet.source.turn_ids.length, facts: packet.replace.facts.length, events: packet.events.knowledge.length + packet.events.resolution.length };
}
