# Modes, presentation, commands, branching

## Semantic modes

Defined by the campaign (`modes.semantic.enabled`, `default`, `canon_affecting`). Changed only by `/mode <name>`; never inferred. Turns in a canon-affecting mode run the full pipeline and commit. Turns in any other mode run a single Director discussion call, commit nothing, and are prefixed `(( <mode> ))`. Fragments: `prompts/modes/<MODE>.md`.

## Presentation modes

Defined by the campaign (`modes.presentation.enabled`, `default`, `allowed_transitions`, `auto_transition`, `editor_modes`). Fragments: `prompts/presentation/<MODE>.md`.

- `/scene <mode>` forces (pins) a presentation; `/scene auto` unpins.
- The Director may set `presentation_suggestion`. Policy `off`: ignored. `director_suggests` (default): the suggestion is reported visibly (`[Director suggests montage; use /scene montage to switch]`) and nothing changes. `director_changes`: applied when `allowed_transitions[current]` permits it, reported as `[presentation: scene → montage]`. A pinned presentation never moves.

## Commands (`commands/router.js`)

Enabled per campaign (`commands.enabled`, `aliases`). Available handlers:

| Command | Effect |
|---|---|
| `/help` | list enabled commands |
| `/status` | revision, unsaved turns, canon revision, mode/presentation, scene, pending events, undelivered turns, spend vs caps, high form pressure, persistence health |
| `/context [director\|novelist] [text]` | the selection the next turn would make (ids and counts; no model call, no secrets) |
| `/mode <m>` | switch semantic mode |
| `/scene <p\|auto>` | pin/unpin presentation |
| `/good [turn] [note]`, `/flat [turn] [note]` | mark exemplars |
| `/ooc <text>` | non-canon exchange |
| `/save [--dry-run]` | persist unsaved turns |
| `/sync [--status\|--stash\|--discard <CAMPAIGN_ID>]` | pull durable canon |
| `/branch create <id> [label] \| list \| discard <id> <id> \| promote <id> <id> \| export <id>` | branching |
| `/resume` | leave a branch, abandon incomplete turns, reset specialist caches, redeliver the last undelivered turn, report canon staleness and scene |

Commands never infer campaign behaviour; all values come from the manifest.

## Branching (`branch/branch.js`)

`/branch create <id>` copies `state/` and `runtime/` to `branches/<id>/`, records `base_revision`, and marks the branch active (`runtime/active-branch.json`). While active, the store's state/runtime roots point at the branch; canon, voices and prompts stay shared. Turns commit to the branch; main canon is untouched. Saving is refused on a branch.

- `discard <id> <id>` (confirmation = id): deletes branch state/runtime, keeps metadata as `discarded`.
- `export <id>`: writes a JSON bundle of branch state, minds and turns.
- `promote <id> <id>`: allowed only if main's revision still equals `base_revision`; main state/runtime is backed up under `branches/_pre-promote-…` and replaced by the branch; branch turns become unsaved on main. Otherwise `diverged` error.
- `/resume` returns to main without discarding.

Branch facts, holdings and minds never leak back to main except through promote.
