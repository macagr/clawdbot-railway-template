# Campaign package and workspace format

A campaign package is a directory. Installing it (`rp campaign install --from <pkg> --to <workspace>`) copies everything except `state/`, `runtime/`, `branches/`, `persistence/`, then runs `rp init`, which seeds `state/` from `seed/state/` if present and creates `runtime/`. Existing state is never overwritten.

```
<CAMPAIGN_ID>/
  campaign.json                  manifest (schema campaign-manifest)
  canon/                         durable canon, local copy (roles below); refreshed by /sync
  prompts/
    director.md novelist.md      campaign fragments appended to the generic role prompts
    agency.md                    agency rules (the harness only provides the stop mechanics)
    modes/<MODE>.md              semantic mode fragments
    presentation/<MODE>.md       presentation fragments
  voices/<id>.json|.md           voice cards (style only)
  channels.json                  propagation catalog: channels, scopes, rules
  casting.json                   axes vocabularies, name pools, archetypes
  seed/state/*.json, seed/state/minds/*.json   initial state used once at init
  craft/director.json craft/novelist.json craft/npcs/<id>.json   non-evidential notes
  exemplars/ anti-exemplars/     created by /good and /flat
  denylist.txt                   campaign-specific tokens forbidden in generic files (for rp lint-generic)
  models.json                    optional overrides for config/models.json (providers, aliases)
  AGENTS.md SOUL.md              written by rp setup-openclaw (coordinator workspace)
  state/ runtime/ branches/      created and owned by the harness
```

## campaign.json

```json
{
  "id": "<CAMPAIGN_ID>", "display_name": "…", "schema_version": 1,
  "player": { "character": "<PC_ID>", "user_ids": ["<discord user id>"] },
  "roles": {
    "coordinator": { "model": "openrouter/<FAST_MODEL>" },
    "director":    { "model": "openclaw:<CAMPAIGN_ID>-director", "temperature": 0.4, "reasoning": "medium", "input_price_per_m": 0, "output_price_per_m": 0 },
    "novelist":    { "model": "openclaw:<CAMPAIGN_ID>-novelist", "temperature": 0.9, "fallback": "openrouter/<PROSE_MODEL>" },
    "editor":      { "model": "openrouter/<MID_MODEL>" },
    "npc":         { "model": "openrouter/<MID_MODEL>" },
    "casting":     { "model": "openrouter/<MID_MODEL>" },
    "summary":     { "model": "openrouter/<FAST_MODEL>" },
    "propagation": { "model": "openrouter/<MID_MODEL>" }
  },
  "budget": { "per_turn": 1, "per_day": 5, "per_month": 60, "warn_fraction": 0.8 },
  "canon": { "operational_canon": "canon/operational.md", "style_rules": "canon/style.md", "recent_history": "canon/recent.md",
             "detailed_history": "canon/history", "divergence_history": "canon/divergences.md", "references": { "world": "canon/world" } },
  "context": { "recent_turns": 8, "recent_prose_turns": 2, "max_voice_cards": 4, "operational_max_chars": 12000, "history_on_demand": true, "exemplars": 2, "anti_exemplars": 2 },
  "modes": {
    "semantic": { "default": "play", "enabled": ["play", "development", "research", "branch", "meta", "save"], "canon_affecting": ["play"] },
    "presentation": { "default": "scene", "enabled": ["scene", "montage", "strategic", "doc", "pressure"], "auto_transition": "director_suggests",
                      "allowed_transitions": { "scene": ["montage", "pressure"] }, "editor_modes": ["scene", "pressure"] }
  },
  "agency": { "fragment": "prompts/agency.md", "pc_dialogue_by_model": false, "stop_on": ["dialogue", "major_action", "irreversible"] },
  "editor": { "when": "selected", "max_revisions": 1, "questions": [] },
  "form": { "decay": 0.7 },
  "propagation": { "mode": "rules", "catalog": "channels.json", "scene_end_pass": true },
  "casting": { "enabled": true, "config": "casting.json" },
  "commands": { "enabled": ["save", "sync", "status", "context", "mode", "scene", "good", "flat", "ooc", "branch", "resume", "help"] },
  "save": { "adapter": "webhook", "endpoint_env": "RP_SAVE_URL", "token_env": "RP_SAVE_TOKEN", "sync_endpoint_env": "RP_SYNC_URL", "session_summary": true },
  "sessions": { "reset_on_resume": true, "reset_on_scene_end": true, "token_threshold": 120000 },
  "discord": { "guild_id": "…", "channel_id": "…", "user_ids": ["…"], "threads": "off" },
  "output": { "max_chars": 3500, "show_presentation_tag": true },
  "denylist": "denylist.txt"
}
```

Defaults for omitted knobs are in `src/campaign/manifest.js`. The canon roles are generic (`operational_canon`, `style_rules`, `recent_history`, `detailed_history`, `divergence_history`, `references.*`); the documents behind them are the campaign's.

## Generic vs campaign boundary

| Generic harness | Campaign package |
|---|---|
| orchestration, lifecycle, lock, ids | manifest values, ids |
| all schemas | the data |
| base prompts with placeholders | prompt fragments, principles, tone |
| agency mechanics (stop, PC tagging) | agency rules |
| propagation mechanics | channel catalog, scopes, rules, timings |
| mode mechanism, transition engine | enabled modes, defaults, fragments, policy |
| casting mechanics | axes vocabularies, name pools, archetypes |
| voice-card schema, loader, SillyTavern adapter | cards, exemplars |
| role slots, meter, caps | role → model mapping, budgets |
| OpenClaw agent template, policies | Discord ids, user ids |
| tests with placeholder fixtures | campaign fixtures |

## Adding a new campaign

1. Copy `campaigns/_template/` (or the fixture) to a private location and fill in `campaign.json`, `canon/`, `prompts/`, `voices/`, `channels.json`, `casting.json`, `seed/state/` (roster, opening scene, initial facts with holdings, minds for majors), `denylist.txt`.
2. `rp campaign install --from <pkg> --to /data/workspaces/<CAMPAIGN_ID>` then `rp validate --campaign …`.
3. `rp lint-generic --denylist <pkg>/denylist.txt` to confirm nothing campaign-specific leaked into the harness.
4. `rp setup-openclaw --campaign … --dry-run`, review, then run without `--dry-run`; restart the gateway; `openclaw agents list --bindings`.
5. `rp smoke-test --campaign …` (with real models) and `rp reconstruct-check`.
6. Configure persistence env vars and `rp test-adapter`.
7. Play. No orchestration code changes are needed.
