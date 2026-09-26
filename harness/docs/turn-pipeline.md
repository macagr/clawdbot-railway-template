# Turn pipeline

## Transaction lifecycle

```
received   event_id recorded in runtime/event-index.json; duplicate → stored output re-returned, no new turn
planned    Director context built and logged; Director packet validated (schema + deterministic rules), one feedback retry
           NPC decision calls for npc_decision_requests (fresh, filtered), one retry each; casting proposals computed
drafted    Novelist context built; prose validated, one bounce with the issues; Editor (optional) → at most one revision
validated  all deterministic checks passed
committed  computeCommit → journaled atomic write of state/ + runtime/ + the turn record; revision N → N+1
delivered  transport confirms; Discord message ids recorded; committed-but-undelivered turns are redelivered on demand
```

Failure anywhere before `committed` → status `failed`, output is an OOC stall line, nothing on disk changes except the turn record and usage. Retries happen only in `planned`/`drafted`. Nothing after `committed` is recomputed. On restart, `rp` (or `/resume`) abandons `received/planned/drafted/validated` turns and clears a stale lock. One directory lock per campaign; stale after 3 minutes.

Non-canon semantic modes (anything not in `modes.semantic.canon_affecting`) and `/ooc` run a single Director "discussion" call, commit nothing, and prefix output with `(( <mode> ))`.

## Context builder (`context/builder.js`)

Selection is logged into `turn.context_selection` and shown by `/context`.

| Role | Receives | Never receives |
|---|---|---|
| Director | generic prompt + campaign fragments (director, agency, semantic mode, presentation), operational canon (truncated), recent history, keyword-matched detailed history, scene, involved actors (present + mentioned), relevant facts **with truth** and holder summary, derived permitted views for involved NPCs, pending delayed events, minds of involved NPCs, relationships among involved, open unresolved, open candidates, recent turn summaries + last prose, form dimensions + pressure, channel list, director craft, player input | NPC craft notes |
| Novelist | packet **filtered** (no fact proposals, events, candidates, mind/state deltas, consequences, `acting_on`, `must_not_reveal`), `reveals_allowed` as content, `reveals_forbidden` as **labels only** (aliases or opaque ids), PC's permitted view, voice cards for speaking/present NPCs (capped), style rules, presentation fragment, recent prose, exemplars, novelist craft, Editor notes on revision | ledger, canon, minds, hidden facts, Director private fields |
| Editor | packet as the Novelist saw it, derived permitted view for present actors, PC id, style, voice cards, anti-exemplars, deterministic validation results, draft | ledger, truth status, unheld hidden facts |
| NPC | own voice card, own mind, own permitted view, scene, recent turns involving it, own craft, the decision question | anything about other actors' knowledge |

Relevant facts for the Director: held by an involved actor, tagged with an active plot or the location, or created in a recent turn. Voice cards: speaking NPCs by speech-act count, then present NPCs, up to `context.max_voice_cards`.

## Director packet (schema `director-packet`)

Required: `turn_summary`, `form`, `scene` (location, present, beats), `perception`, `npc_intents[]` (`npc`, `intent`, `acting_on[]`, `emotional_register`, `speech_acts[{act, subtext}]`, `must_not_reveal[]`, `speaks`), `reveals_allowed[]`, `reveals_forbidden[]`, `stop_for_player`. Optional: `presentation_suggestion`, `fact_proposals[]` (`ref: "new:<slug>"`), `npc_decision_requests[]`, `knowledge_events[]`, `resolution_events[]`, `candidate_updates[]`, `uncertainty[]`, `consequences[]`, `state_deltas` (scene incl. `clock_advance` and `scene_end`, relationships, unresolved ops, actor ops incl. `cast`), `mind_deltas[]`, `stop_reason`, `novelist_notes`.

Not in the packet by design: `knows[]`/`does_not_know[]` (derived), truth for undecided facts, anything computable.

## Deterministic validation (`validate/deterministic.js`)

Director: schema; form values ∈ dimensions; modes enabled; present actors exist (or are `new:` cast refs); each `acting_on` fact is held by that NPC (or granted by a delay-0 event in the same packet); no PC intents; unknown facts/channels/scopes/actors; undecided proposals must be unresolved; `reveals_allowed` ∩ `reveals_forbidden` = ∅; an allowed reveal must be held by a present actor or the PC; transmit events need a source; candidate ops well-formed; mind deltas target NPCs. Rejection feeds the errors back to the Director once.

Novelist: annotation balance; speakers ∈ speaking intents; PC never voiced (unless `agency.pc_dialogue_by_model`); forbidden fact ids and aliases absent (`reveals_forbidden` and each intent's `must_not_reveal`); `output.max_chars`; stray markup. Warnings (not failures): length band, long quoted text outside spans.

NPC decision: schema; `acting_on` ⊆ own holdings; actor match.

## Semantic validation: the Editor (advisory)

Question-driven, never a rules dump. Default questions: implied knowledge, agency creep, named subtext, generic voice, tension flattening, emotional over-interpretation; campaigns may prepend their own. Returns `{ revise, notes[] }`; `revise` triggers one Novelist revision, which must itself pass deterministic validation or the validated draft ships. Enablement: `editor.when = disabled | selected (presentation modes in modes.presentation.editor_modes) | all | manual`. Editor failure never fails the turn. **These checks are heuristics, not guarantees.**

## Dialogue annotation and rendering

The Novelist wraps every attributable spoken line as `⟦say <ACTOR_ID>⟧“…”⟦/say⟧`. Quoted signs, documents, memories and free indirect thought stay outside spans. `render/dialogue.js` parses (unclosed/nested/stray → error), validates speakers, and strips markup before delivery. Long quoted runs outside spans are surfaced to the Editor as warnings.

## Shape / form ledger

Dimensions (campaign-configurable, defaults in `manifest.js`): length_band, structure, camera, tempo, ending, sense. Each value's score decays by `form.decay` per turn and +1 when used; pressure = score / (1 + dimension total). The Director sees the pressure table and is told high pressure is a prompt to vary, not a prohibition. Nothing is rejected for repetition and no justification is required; shape and pressure are logged per turn and summarized in `/status`.

## Output

`plain prose` (+ a visible presentation note when policy produces one) (+ `(( stop_reason ))` when the Director stopped for the player and `output.show_stop_reason` is true, the default). `rp turn --hide-stop` / `--show-stop` override per run. `stop_for_player` and `stop_reason` always remain in the turn record and the Director packet for audit; the option only affects rendering. Discord chunking happens in the transport.
