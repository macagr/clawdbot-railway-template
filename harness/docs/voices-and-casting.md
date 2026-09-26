# Voice cards, exemplars, casting, SillyTavern

## Voice cards (schema `voice-card`)

Style-only material. Fields: `id`, `style_only: true`, `display_name`, `inherits` (parent card id), `rhythm`, `register`, `vocabulary`, `sentences`, `humor`, `stress{state: text}`, `status_modulation{label: text}`, `does_not_sound_like[]`, `examples[]` (max 20 short lines), `contextual{presentation: text}`, `notes`.

Loading (`voices/voices.js`): package `voices/<id>.json`, or `voices/<id>.md` (markdown body becomes `notes`), or generated `state/voices/<id>.json`. Inheritance resolves up to 4 levels; child fields win, objects merge, arrays concatenate. An actor's card is `actors[id].voice || id`, falling back to `voices/generic.json` if present. Cards are trimmed to `context.voice_card_max_chars` and rendered under a `STYLE MATERIAL ONLY` banner; example lines are labelled "style samples, not things said in play".

The Novelist receives only cards for NPCs with speaking intents (by speech-act count), then other present NPCs, up to `context.max_voice_cards`. The PC never gets a card.

**Authority rule:** nothing in a card is evidence about current relationships, possessions, events, knowledge, location, plans, emotional state or chronology. The prompts state this; the context builder enforces it structurally by never treating card text as state.

## Exemplars (schema `exemplar`)

`/good [turn] [note]` and `/flat [turn] [note]` copy a delivered turn's output into `exemplars/` or `anti-exemplars/` with `style_only: true`, presentation, voiced actors, note, and `pinned`. Only committed/delivered turns can be marked. Selection: pinned first, then presentation match (+2) and actor overlap (+1 each), recency tiebreak, capped by `context.exemplars` / `context.anti_exemplars`. Exemplars go to the Novelist, anti-exemplars to the Editor, both under the style-only banner. No vector search.

## Casting (`casting/casting.js`, config schema `casting-config`)

Triggered by a Director `state_deltas.actors[]` op `cast` with `casting_request { ref: "new:<slug>", role, kind, constraints, groups, returning }`. Mechanics:

1. Axis values are chosen per axis: a constraint forces an axis whose `constrained_by` matches; an archetype seeds fixed values; otherwise the **least-used** value across the roster wins, ties broken by weight and an injectable RNG. No quality-diversity search.
2. Name from `names.pools`: `pool_by_constraint` maps a constraint key or group id to a pool; unused names first. Id = slug of the name, de-duplicated.
3. Actor record (`generated: true`, tier `minor` if `returning`, else `extra`), a draft card inheriting `voice_defaults`, an empty mind and craft.
4. Optional casting-role model call fleshes out the card from the chosen axes and existing cards; it cannot change id or `style_only`.
5. Everything becomes real only at commit: actor into `actors.json`, card into `state/voices/`, mind into `state/minds/`, craft into `craft/npcs/`. `new:<ref>` in `present`, intents and events is mapped to the real id.

## SillyTavern adapter (`voices/sillytavern.js`)

Import/export only; the internal schema is not shaped by SillyTavern.

- Import (`rp sillytavern import --file card.json [--id <id>]`): `name` → display name/id, `personality` → `register`, `{{char}}` lines of `mes_example` → `examples`, `description` → a style note marked non-factual. Dropped and reported: scenario, first_mes, alternate greetings, system prompts, tags, extensions.
- Export (`rp sillytavern export --voice <id> --out card.json`): V2 card with `personality` = rendered style fields, `mes_example` from examples, empty description/scenario by design, `tags: ["voice-card","style-only"]`.

Both return an explicit `loss[]` list.
