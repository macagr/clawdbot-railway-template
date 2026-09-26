# Campaign package template

Copy this directory to a private location, rename ids, and replace every placeholder
(`<CAMPAIGN_ID>`, `<PC_ID>`, `<NPC_A>`, `<NPC_B>`, `<LOCATION_A>`, `<GROUP_A>`, `<CHANNEL_A>`, `<SCOPE_A>`).
Nothing in this template describes a real setting; it is the same synthetic package the harness
test suite uses.

| Path | Purpose |
|---|---|
| `campaign.json` | manifest: ids, roles → models, budgets, canon roles, modes, agency, editor, propagation, casting, commands, save adapter, Discord ids |
| `canon/` | operational canon, style rules, recent history, detailed history, world references |
| `prompts/` | Director/Novelist fragments, agency rules, semantic-mode and presentation fragments |
| `voices/` | style-only voice cards (`generic.json` is the fallback for uncarded actors) |
| `channels.json` | propagation catalog: channels, scopes, scene-end rules |
| `casting.json` | axis vocabularies, name pools, archetypes |
| `seed/state/` | initial roster, scene, facts with holdings, minds for major NPCs (used once by `rp init`) |
| `craft/` | non-evidential writing notes (director, novelist, per NPC) |
| `denylist.txt` | campaign-specific tokens that must never appear in the generic harness |

Install: `rp campaign install --from <this dir> --to /data/workspaces/<CAMPAIGN_ID>` then `rp validate`.
See `harness/docs/campaign-package.md`.
