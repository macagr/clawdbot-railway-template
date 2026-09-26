// TurnRunner: owns the turn transaction. received -> planned -> drafted -> validated ->
// committed -> delivered. No state mutation before commit; retries only before commit.
import { newTurn, transition } from "../state/lifecycle.js";
import { turnId as makeTurnId, makeIdGen } from "../lib/ids.js";
import { loadCatalog } from "../knowledge/catalog.js";
import { buildDirectorContext, buildNovelistContext, buildEditorContext, buildNpcContext } from "../context/builder.js";
import { validateDirectorPacket, validateNovelistOutput, validateNpcDecision, formatIssues, normalizeDirectorPacket } from "../validate/deterministic.js";
import { computeCommit } from "./commit.js";
import { recordUsage, checkBudget, BudgetError } from "../meter/usage.js";
import { ModelError } from "../models/adapter.js";
import { resolvePresentation, isCanonMode } from "../modes/modes.js";
import { loadCastingConfig, castActor, buildCastingContext, mergeCastingFields } from "../casting/casting.js";
import { buildPropagationContext, filterProposals } from "../propagation/propagation.js";
import { materializeKnowledgeEvent } from "../knowledge/events.js";
import { renderVoiceCard, resolveVoiceCard } from "../voices/voices.js";
import { genericPrompt, fill, sections } from "../prompts/render.js";
import { redact } from "../lib/redact.js";

export class TurnError extends Error {
  constructor(msg, { code = "turn", turn, cause } = {}) { super(msg); this.name = "TurnError"; this.code = code; this.turn = turn; if (cause) this.cause = cause; }
}

export const OOC_PREFIX = "(( ";
export const OOC_SUFFIX = " ))";

export class TurnRunner {
  constructor({ store, caller, sessions, clock, log, idGen, rng }) {
    this.store = store;
    this.caller = caller;
    this.sessions = sessions;
    this.clock = clock;
    this.log = log;
    this.idGen = idGen || makeIdGen({ now: clock.now });
    this.rng = rng || Math.random;
    this.env = { actors: null, catalog: loadCatalog(store) };
  }

  refreshEnv() { this.env = { actors: this.store.actors(), catalog: loadCatalog(this.store) }; return this.env; }

  /** Entry point. Returns { turn, output, reused } and never throws for model/validation failures. */
  async run({ text, eventId, transport = "cli", player, presentation: forcedPresentation, nonCanon = null }) {
    this.nonCanonLabel = nonCanon;
    const store = this.store;
    const idx = store.eventIndex();
    if (eventId && idx.events[eventId]) {
      const prior = store.turn(idx.events[eventId]);
      if (prior && (prior.status === "committed" || prior.status === "delivered")) return { turn: prior, output: prior.output, reused: true };
      if (prior && ["received", "planned", "drafted", "validated"].includes(prior.status)) return { turn: prior, output: `${OOC_PREFIX}That message is already being processed.${OOC_SUFFIX}`, reused: true, inProgress: true };
      // failed/abandoned: allow a fresh attempt with the same event id
    }
    const lock = store.lock();
    if (!lock.acquire(`turn:${transport}`)) {
      return { turn: null, output: `${OOC_PREFIX}A turn is already in progress. Wait for it to finish, or run 'rp repair-lock' if it is stuck.${OOC_SUFFIX}`, refused: true };
    }
    let turn;
    try {
      const meta = store.meta();
      const scene = store.scene();
      const tid = makeTurnId(store.id, meta.revision + 1) + (idx.events[eventId] ? `-${this.clock.now().toString(36)}` : "");
      turn = newTurn({ turnId: tid, eventId: eventId || `local:${tid}`, revisionBase: meta.revision, input: { text, kind: "play", mode: scene.mode, presentation: forcedPresentation || scene.presentation, ...(player ? { player } : {}) }, transport, branch: store.branch, at: this.clock.iso() });
      store.saveTurn(turn);
      idx.events[turn.event_id] = turn.turn_id;
      store.saveEventIndex(idx);
      try {
        turn = await this.#execute(turn);
      } catch (err) {
        turn = this.#fail(turn, err);
        return { turn, output: turn.output, failed: true };
      }
      return { turn, output: turn.output };
    } finally {
      lock.release();
    }
  }

  #save(turn) { this.store.saveTurn(turn); return turn; }

  #fail(turn, err) {
    const msg = err instanceof BudgetError ? `Budget cap reached (${err.scope}). Nothing was recorded.` : `The scene stalls: ${err.code || err.name} — ${redact(err.message).slice(0, 300)}. Nothing was recorded; send your action again.`;
    this.log.error(`[turn ${turn.turn_id}] failed: ${redact(err.stack || err.message)}`);
    const status = turn.status === "received" || turn.status === "planned" || turn.status === "drafted" || turn.status === "validated" ? "failed" : turn.status;
    const next = status === "failed" ? transition(turn, "failed", { at: this.clock.iso(), note: err.code || err.name, patch: { error: redact(err.message).slice(0, 4000), output: `${OOC_PREFIX}${msg}${OOC_SUFFIX}` } }) : turn;
    return this.#save(next);
  }

  #meter(role) {
    return ({ usage, model, cost_reported, turn }) => {
      const rec = recordUsage(this.store.usage(), this.store.manifest, { at: this.clock.iso(), role, model, usage, turn, cost_reported });
      this.store.saveUsage(rec);
      this.sessions?.noteUsage(role, (usage.input_tokens || 0) + (usage.output_tokens || 0));
    };
  }

  async #call(role, ctx, { schema, turn, allowFallback = true, normalize } = {}) {
    const prev = this.caller.onUsage;
    this.caller.onUsage = this.#meter(role);
    try {
      checkBudget(this.store.usage(), this.store.manifest, { at: this.clock.iso(), turnId: turn.turn_id });
      return await this.caller.call(role, { system: ctx.system, user: ctx.user, schema, sessionKey: this.sessions?.keyFor(role), turn: turn.turn_id, allowFallback, normalize });
    } finally {
      this.caller.onUsage = prev;
    }
  }

  async #execute(turn) {
    const store = this.store;
    const m = store.manifest;
    const env = this.refreshEnv();
    const scene = store.scene();
    const canon = isCanonMode(m, scene.mode) && !this.nonCanonLabel;
    const at = () => this.clock.iso();

    if (!canon) return this.#discussionTurn(turn, { ...scene, mode: this.nonCanonLabel || scene.mode });

    // ---- planned: Director ----
    const formLedger = store.formLedger();
    const dctx = buildDirectorContext(store, { input: turn.input, turnId: turn.turn_id, env, formLedger });
    turn = this.#save(transition(turn, "planned", { at: at(), patch: { context_selection: { director: dctx.selection } } }));
    let packet = await this.#directorWithValidation(turn, dctx, env, scene);
    turn = this.#save(transition(turn, "planned", { at: at(), note: "director packet accepted", patch: { packet } }));

    // ---- NPC decision calls ----
    const npcMindDeltas = [];
    const decisions = [];
    for (const npcId of packet.npc_decision_requests || []) {
      const d = await this.#npcDecision(turn, npcId, packet, env);
      if (!d) continue;
      decisions.push(d);
      const { mind_delta, rationale, ...intent } = d;
      const i = packet.npc_intents.findIndex((x) => x.npc === npcId);
      const merged = { ...intent, decision_source: "npc_call" };
      if (i >= 0) packet.npc_intents[i] = merged; else packet.npc_intents.push(merged);
      if (mind_delta) npcMindDeltas.push(mind_delta);
    }
    if (decisions.length) {
      const v = validateDirectorPacket(packet, { facts: store.facts(), actors: env.actors, catalog: env.catalog, manifest: m, scene });
      if (!v.ok) throw new TurnError(`packet invalid after NPC decisions:\n${formatIssues(v)}`, { code: "npc-merge" });
      turn = this.#save(transition(turn, "planned", { at: at(), note: "npc decisions merged", patch: { packet, npc_decisions: decisions.map((d) => ({ npc: d.npc, intent: d.intent, acting_on: d.acting_on })) } }));
    }

    // ---- casting (proposed; real at commit) ----
    const castings = await this.#castings(turn, packet, env);

    // ---- drafted: Novelist ----
    const nctx = buildNovelistContext(store, { packet, env });
    turn = this.#save(transition(turn, "drafted", { at: at(), patch: { context_selection: { ...turn.context_selection, novelist: nctx.selection } } }));
    const pcAllowed = Boolean(m.agency.pc_dialogue_by_model);
    let { prose, validation } = await this.#novelistWithValidation(turn, nctx, packet, env, pcAllowed);
    turn = this.#save(transition(turn, "drafted", { at: at(), note: "draft accepted", patch: { draft: prose, validation } }));

    // ---- Editor (semantic, advisory) ----
    if (this.#editorEnabled(packet.presentation || scene.presentation)) {
      const ectx = buildEditorContext(store, { packet, draft: prose, validation: { errors: validation.errors, warnings: validation.warnings }, env });
      try {
        const res = await this.#call("editor", ectx, { schema: "editor-notes", turn, allowFallback: false });
        const notes = res.json;
        turn = this.#save(transition(turn, "drafted", { at: at(), note: "editor reviewed", patch: { editor: { notes: notes.notes, revise: notes.revise, selection: ectx.selection } } }));
        if (notes.revise && (m.editor.max_revisions ?? 1) > 0) {
          const rctx = buildNovelistContext(store, { packet, env, revisionNotes: notes.notes });
          const revised = await this.#novelistWithValidation(turn, rctx, packet, env, pcAllowed, { retries: 0 }).catch((err) => { this.log.warn(`[turn ${turn.turn_id}] revision rejected: ${err.message}`); return null; });
          if (revised) { prose = revised.prose; validation = revised.validation; turn = this.#save(transition(turn, "drafted", { at: at(), note: "revised", patch: { revised: prose, validation } })); }
        }
      } catch (err) {
        this.log.warn(`[turn ${turn.turn_id}] editor skipped: ${err.message}`);
        turn = this.#save(transition(turn, "drafted", { at: at(), note: `editor skipped: ${err.code || err.name}` }));
      }
    }

    // ---- validated ----
    turn = this.#save(transition(turn, "validated", { at: at() }));

    // ---- committed ----
    const pres = resolvePresentation(m, scene, packet);
    const output = this.#renderOutput(validation.plain, { packet, presentation: pres, showTag: m.output.show_presentation_tag });
    const propagationExtra = await this.#modelPropagation(turn, packet, env);
    const commit = computeCommit(store, { turn, packet: { ...packet, knowledge_events: [...(packet.knowledge_events || []), ...propagationExtra] }, plainOutput: validation.plain, npcMindDeltas, castings, catalog: env.catalog, idGen: this.idGen, presentation: pres.changed ? pres.presentation : undefined, presentationNote: pres.note, clock: this.clock, canon: true });
    const committedTurn = transition(turn, "committed", { at: at(), patch: { revision_committed: commit.revision, output, usage: { cost: turnCostOf(store.usage(), turn.turn_id) } } });
    store.commit({ ...commit.files, [`runtime/turns/${turn.turn_id}.json`]: committedTurn });
    turn = committedTurn;
    for (const c of castings) store.saveCraft(`npc:${c.actor.id}`, c.craft);
    if (commit.summary.scene_end) this.sessions?.onSceneEnd();
    this.log.info(`[turn ${turn.turn_id}] committed revision ${commit.revision}`, commit.summary);
    return turn;
  }

  async #discussionTurn(turn, scene) {
    const store = this.store;
    const env = this.env;
    const dctx = buildDirectorContext(store, { input: turn.input, turnId: turn.turn_id, env, formLedger: store.formLedger() });
    const user = `${dctx.user}\n\n## Non-canon mode: ${scene.mode}\n\nThis is a ${scene.mode} exchange, out of fiction. Answer the player as the campaign's game master in plain prose. Do NOT return a packet, do NOT change canon, do NOT decide undecided truth. Nothing you say here becomes canonical.`;
    turn = this.#save(transition(turn, "planned", { at: this.clock.iso(), patch: { context_selection: { director: dctx.selection } } }));
    const res = await this.#call("director", { system: dctx.system, user }, { turn });
    const output = res.text.trim();
    turn = this.#save(transition(turn, "drafted", { at: this.clock.iso(), patch: { draft: output } }));
    turn = this.#save(transition(turn, "validated", { at: this.clock.iso() }));
    turn = this.#save(transition(turn, "committed", { at: this.clock.iso(), note: `non-canon (${scene.mode})`, patch: { revision_committed: store.meta().revision, output: `${OOC_PREFIX}${scene.mode}${OOC_SUFFIX} ${output}` } }));
    return turn;
  }

  async #directorWithValidation(turn, dctx, env, scene) {
    const store = this.store;
    let ctx = dctx;
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      const notes = [];
      const res = await this.#call("director", ctx, { schema: "director-packet", turn, normalize: (j) => normalizeDirectorPacket(j, notes) });
      if (notes.length) this.log.warn(`[turn ${turn.turn_id}] director packet normalized: ${notes.join(" | ")}`);
      const packet = res.json;
      const v = validateDirectorPacket(packet, { facts: store.facts(), actors: env.actors, catalog: env.catalog, manifest: store.manifest, scene });
      if (v.ok) { if (v.warnings.length) this.log.warn(`[turn ${turn.turn_id}] director warnings: ${formatIssues({ errors: [], warnings: v.warnings })}`); return { ...packet, presentation: packet.presentation || scene.presentation, mode: scene.mode }; }
      last = v;
      this.log.warn(`[turn ${turn.turn_id}] director packet rejected (attempt ${attempt + 1}):\n${formatIssues(v)}`);
      ctx = { ...dctx, user: `${dctx.user}\n\n## Your previous packet was rejected by deterministic validation\n\n${formatIssues(v)}\n\nFix every error. Cite only fact ids listed in the permitted views. Return the corrected JSON packet only.` };
    }
    throw new TurnError(`Director packet failed validation twice:\n${formatIssues(last)}`, { code: "director-validation" });
  }

  async #novelistWithValidation(turn, nctx, packet, env, pcAllowed, { retries = 1 } = {}) {
    const store = this.store;
    let ctx = nctx;
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await this.#call("novelist", ctx, { turn });
      const prose = res.text.trim();
      const v = validateNovelistOutput(prose, { packet, facts: store.facts(), actors: env.actors, manifest: store.manifest, pcAllowedToSpeak: pcAllowed });
      if (v.ok) return { prose, validation: v };
      last = v;
      this.log.warn(`[turn ${turn.turn_id}] novelist draft rejected (attempt ${attempt + 1}):\n${formatIssues(v)}`);
      ctx = { ...nctx, user: `${nctx.user}\n\n## Your previous draft was rejected\n\n${formatIssues(v)}\n\nRewrite the prose fixing every error. Return prose only.` };
    }
    throw new TurnError(`Novelist output failed validation:\n${formatIssues(last)}`, { code: "novelist-validation" });
  }

  async #npcDecision(turn, npcId, packet, env) {
    const store = this.store;
    const intent = packet.npc_intents.find((i) => i.npc === npcId);
    const question = intent ? `The Director's provisional intent for you is: "${intent.intent}". Decide what you actually do and say now, from your own mind and knowledge only.` : "Decide what you do and say now.";
    const ctx = buildNpcContext(store, { npcId, packet, question, env });
    let c = ctx;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try { res = await this.#call("npc", c, { schema: "npc-decision", turn }); } catch (err) { this.log.warn(`[turn ${turn.turn_id}] npc call for ${npcId} failed: ${err.message}; keeping Director intent`); return null; }
      const v = validateNpcDecision(res.json, { npcId, facts: store.facts(), actors: env.actors, catalog: env.catalog });
      if (v.ok) return res.json;
      c = { ...ctx, user: `${ctx.user}\n\n## Rejected\n${formatIssues({ errors: v.errors, warnings: [] })}\nCite only held fact ids. Return JSON only.` };
    }
    this.log.warn(`[turn ${turn.turn_id}] npc decision for ${npcId} invalid twice; keeping Director intent`);
    return null;
  }

  async #castings(turn, packet, env) {
    const reqs = (packet.state_deltas?.actors || []).filter((a) => a.op === "cast" && a.casting_request);
    if (!reqs.length) return [];
    const config = loadCastingConfig(this.store);
    if (!config) throw new TurnError("Director requested casting but casting is not enabled for this campaign", { code: "casting-disabled" });
    const out = [];
    const rosterView = structuredClone(env.actors);
    for (const r of reqs) {
      const req = r.casting_request;
      const cast = castActor(config, rosterView, req, { rng: this.rng });
      rosterView.actors[cast.actor.id] = cast.actor;
      try {
        const existing = Object.values(env.actors.actors).filter((a) => a.kind === "npc" && a.tier !== "extra").slice(0, 6).map((a) => renderVoiceCard(resolveVoiceCard(this.store, a.voice || a.id), { maxChars: 800 })).filter(Boolean);
        const cctx = buildCastingContext(this.store, { actor: cast.actor, card: cast.card, request: req, existingCards: existing });
        const res = await this.#call("casting", cctx, { turn, allowFallback: false });
        const fields = res.json ?? JSON.parse(res.text);
        cast.card = mergeCastingFields(cast.card, fields);
      } catch (err) {
        this.log.warn(`[turn ${turn.turn_id}] casting model step skipped for ${cast.actor.id}: ${err.message}`);
      }
      out.push({ ref: req.ref, ...cast });
    }
    return out;
  }

  async #modelPropagation(turn, packet, env) {
    const p = this.store.manifest.propagation;
    if (!packet.state_deltas?.scene?.scene_end || !p?.scene_end_pass || p.mode !== "model_assisted") return [];
    const facts = this.store.facts();
    const changedIds = new Set([...(packet.knowledge_events || []).map((k) => k.fact), ...(packet.resolution_events || []).map((r) => r.fact)].filter((id) => !id.startsWith("new:")));
    const changed = facts.filter((f) => changedIds.has(f.id));
    if (!changed.length) return [];
    try {
      const ctx = buildPropagationContext(this.store, { changedFacts: changed, catalog: env.catalog, actors: env.actors });
      const res = await this.#call("propagation", ctx, { schema: "propagation-output", turn, allowFallback: false });
      const { kept, dropped } = filterProposals(res.json.events, { facts, catalog: env.catalog, actors: env.actors });
      if (dropped.length) this.log.warn(`[turn ${turn.turn_id}] propagation dropped ${dropped.length} proposals`, dropped.map((d) => d.reason));
      return kept;
    } catch (err) {
      this.log.warn(`[turn ${turn.turn_id}] model propagation skipped: ${err.message}`);
      return [];
    }
  }

  #editorEnabled(presentation) {
    const e = this.store.manifest.editor;
    if (!this.store.manifest.roles.editor) return false;
    if (e.when === "disabled" || e.when === "manual") return false;
    if (e.when === "all") return true;
    return (this.store.manifest.modes.presentation.editor_modes || []).includes(presentation);
  }

  #renderOutput(plain, { packet, presentation, showTag }) {
    const parts = [];
    if (showTag && presentation.note) parts.push(presentation.note);
    parts.push(plain);
    if (packet.stop_for_player && packet.stop_reason) parts.push(`${OOC_PREFIX}${packet.stop_reason}${OOC_SUFFIX}`);
    return parts.join("\n\n");
  }

  /** Mark a committed turn delivered (idempotent). */
  markDelivered(turnId, { transport, messageIds = [] }) {
    const turn = this.store.turn(turnId);
    if (!turn) throw new TurnError(`unknown turn ${turnId}`, { code: "unknown-turn" });
    if (turn.status !== "committed" && turn.status !== "delivered") throw new TurnError(`turn ${turnId} is ${turn.status}; cannot deliver`, { code: "not-committed" });
    const attempts = (turn.delivery?.attempts || 0) + 1;
    const next = transition(turn, "delivered", { at: this.clock.iso(), patch: { delivery: { transport, message_ids: [...(turn.delivery?.message_ids || []), ...messageIds], delivered_at: this.clock.iso(), attempts } } });
    return this.#save(next);
  }

  /** Committed-but-undelivered turns, oldest first. */
  undelivered() {
    return this.store.listTurnIds().map((id) => this.store.turn(id)).filter((t) => t.status === "committed");
  }

  /** On startup: abandon incomplete turns from a previous process and clear a stale lock. */
  recoverIncomplete() {
    const abandoned = [];
    for (const id of this.store.listTurnIds()) {
      const t = this.store.turn(id);
      if (["received", "planned", "drafted", "validated"].includes(t.status)) {
        this.#save(transition(t, "abandoned", { at: this.clock.iso(), note: "incomplete at restart" }));
        abandoned.push(id);
      }
    }
    return abandoned;
  }
}

function turnCostOf(usageRec, turnId) {
  return usageRec.calls.filter((c) => c.turn === turnId).reduce((s, c) => s + c.cost, 0);
}

export { sections, fill, genericPrompt, materializeKnowledgeEvent, ModelError };
