# State model, epistemology, truth, minds

All files are JSON validated by `harness/schemas/*.json`. Paths are relative to the campaign workspace (or `branches/<id>/` when a branch is active).

## state/

| File | Schema | Purpose |
|---|---|---|
| `meta.json` | meta | revision, canon_revision, last_saved_revision, session id |
| `scene.json` | scene | location, display time, `clock` (scene-time counter), present actors, semantic mode, presentation, pinned flag, active plots |
| `facts.json` | fact[] | the ledger |
| `events.json` | – | log of applied knowledge/resolution events |
| `pending-events.json` | knowledge-event[] | delayed events with `applies_at` |
| `candidates.json` | candidate[] | explicit non-canonical resolution proposals |
| `relationships.json` | relationships | directed edges `from>to` |
| `unresolved.json` | unresolved | open questions tagged by actors/locations/plots/facts |
| `actors.json` | actors | roster: PC, NPCs (tier extra/minor/major), groups, memberships, axes, appearances |
| `minds/<NPC_ID>.json` | mind | authoritative explicit mental state |
| `voices/<id>.json` | voice-card | generated (cast) cards; authored cards live in the package `voices/` |

## Fact

```json
{ "id": "<FACT_A>", "content": "…", "created_turn": "…", "created_revision": 3,
  "tags": [], "aliases": ["short label used for forbidden-reveal matching"],
  "persistence": "provisional | saved | superseded | retracted",
  "truth": { "status": "true | false | unresolved | disputed", "authorial": "decided | undecided", "visibility": "public | restricted | gm_only" },
  "holdings": [ { "holder": {"type":"actor","id":"<NPC_A>"} | {"type":"group","id":"<GROUP_A>","scope":"<SCOPE_A>"},
                  "version": "accurate | partial | distorted | false", "variant": "text when not accurate",
                  "confidence": "low|medium|high", "evidence": "witnessed|documentary|testimony|hearsay|inference|forged|background", "via": "<EVENT_A>" } ],
  "provenance": ["<EVENT_A>", "…"] }
```

Axes are independent: `persistence` says whether durable canon has it; `truth` says what is so and whether the author has decided; each holding says what an actor believes and on what basis; `provenance` is the event chain.

Rules enforced in code (`knowledge/ledger.js`, `validate/deterministic.js`):

- `authorial: undecided` ⇒ `status: unresolved`. Nothing may present an undecided fact as true or false.
- A holding changes only via a `KnowledgeEvent`. Failed (`succeeded:false`) or disbelieved (`believed:false`) transfers are recorded in provenance and change nothing. A later better version upgrades a holding; a worse one never downgrades it.
- Truth changes only via a `ResolutionEvent` (from a Director proposal or a promoted candidate). Deciding hidden truth (`visibility: gm_only`) grants no holding.
- Retracted facts are held by nobody.

## Holdings and access

`actorHolds(facts, actor, fact)` is true when the actor has an individual holding, or a group holding exists whose `scope` grants access: the catalog's `scopes.<SCOPE_A>` names a `group`, optional `roles` (matched against the actor's `groups[].role`) and optional explicit `actors`. **A group holding never means every member knows.** Individual holdings are preferred; group holdings model information existing inside an organizational domain.

`permittedView(facts, actors)` returns, per actor, the facts they can act on **in the version they hold**, with confidence and evidence, and never truth status. This view is what the Director must cite (`acting_on`), what the Editor receives for present actors, and what an NPC decision call receives for itself.

## Knowledge events and propagation

```json
{ "id": "<EVENT_A>", "turn": "…", "kind": "transmit | observe | infer | forge | background",
  "fact": "<FACT_A>", "from": holder|null, "to": holder, "channel": "<CHANNEL_A>",
  "delay": 0, "fidelity": "accurate|partial|distorted|false", "variant": "…",
  "evidence": "…", "succeeded": true, "believed": true, "confidence": "medium", "applies_at": 7 }
```

Generic mechanics: source, recipient, channel, delay (scene-clock units), fidelity, evidence, success, belief/confidence. The campaign catalog (`channels.json`) defines the actual channels with default delay/fidelity/evidence/reliability/belief and optional `access` (groups that may use the channel), `scopes`, and deterministic scene-end `rules` (`when` matches fact tags/visibility/holders → transfer to a holder through a channel).

Propagation modes (`campaign.json → propagation.mode`): `disabled`, `rules` (deterministic rules at scene end), `model_assisted` (rules plus a propagation-role call whose proposals are filtered: unknown channels/facts/actors and channel access violations are dropped). Delayed events wait in `pending-events.json` until `scene.clock ≥ applies_at`. Nothing propagates without an event.

## Candidates

```json
{ "id": "cand_…", "fact": "<FACT_A>", "proposal": "what might be true", "proposed_status": "true", "status": "open|abandoned|promoted", "created_turn": "…" }
```

A candidate is where the Director plans without deciding. Promotion requires a `ResolutionEvent` (Director `resolution_events[].candidate`), which sets `status: promoted` and applies the truth change. No model can convert a candidate to a fact silently.

## NPC minds vs craft

`state/minds/<NPC_ID>.json` (authoritative): dispositions toward actors (stance, trust, heat), priorities (goal, weight, horizon), intentions (id, what, toward, trigger, status), suspicions, interpretations, emotional baseline, campaign `extensions`. **Holdings are not stored here**; they are derived from the ledger at call time.

`craft/npcs/<NPC_ID>.json`, `craft/director.json`, `craft/novelist.json` (non-canonical): habits to avoid, recent patterns, performance notes. Rendered with a `NON-EVIDENTIAL` banner, never given to the Director as world input.

Mind deltas (`mind-delta` schema) come from the Director packet or from NPC decision calls and apply only at commit. NPC decision calls are always fresh: voice card + mind + own permitted view + scene + question → intent (+ optional mind delta). No persistent NPC transcript exists.

## runtime/

`turns/<TURN_ID>.json` (full transaction record incl. packet, draft, editor notes, validation, output, delivery), `recent-play.md`, `dirty.json` (unsaved revisions), `form-ledger.json`, `usage.json`, `event-index.json` (event id → turn id), `sessions.json` (specialist cache keys), `pending-save.json`, `stash/`, `.lock`, `commit-journal.json` (present only during a commit).
