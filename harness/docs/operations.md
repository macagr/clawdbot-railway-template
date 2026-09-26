# Operations: testing, live tests, reconstruction, recovery, upgrading

## Deterministic test suite

`npm run test:harness` (or `node --test "harness/test/**/*.test.js"`) on Node 24. Classes:

| Class | Files |
|---|---|
| UNIT | `unit-*.test.js` (schema, fs, store, lifecycle, minds, models, dialogue) |
| TRANSACTION / GOLDEN TURN / FAILURE-INJECTION | `transaction.test.js` |
| EPISTEMOLOGY | `epistemology.test.js`, `validation.test.js`, `propagation.test.js` |
| RECONSTRUCTION | `reconstruction.test.js`, `ops.test.js` |
| CONTEXT | `context.test.js` (Novelist/Editor exclusion, debug inspection) |
| EDITOR, EXEMPLARS, FORM, MODES, CASTING, BRANCH, SAVE/SYNC, DISCORD, SILLYTAVERN, GENERIC-LEAK | one file each |
| CLI integration | `cli.integration.test.js` (spawned processes with scripted models) |
| CAMPAIGN SOURCE | `campaign-source.test.js` (real local git repositories as origin; token containment, command-scoped auth, refusals, `campaign update` preservation) |

All tests use the synthetic fixture campaign (`test/fixtures/campaign-generic`) and the `FakeModelAdapter`; no network, no OpenClaw.

## Live tests (`harness/scripts/live/run.mjs <scenario>`)

Prerequisites: a disposable copy of the fixture campaign (the script makes one), real models configured via `RP_LIVE_MODELS` (JSON mapping role → model ref, e.g. `{"director":"openrouter/<STRONG_MODEL>","novelist":"openrouter/<PROSE_MODEL>","editor":"openrouter/<MID_MODEL>","npc":"...","casting":"...","summary":"...","propagation":"..."}`) and the provider keys in the environment. Never point these at a real campaign.

| Scenario | What it does |
|---|---|
| `specialists` | one real Director + Novelist turn (no Discord); prints output, cost and validation |
| `reconstruction` | runs a turn, wipes specialist sessions, runs another; asserts commit succeeds and Director inputs are files-only |
| `editor` | forces a presentation in `editor_modes` and shows the Editor notes/revision |
| `branch` | creates a branch, plays a turn, shows main unchanged, discards |
| `persistence-local` | save to a local adapter, edit remote, sync, provoke a conflict, stash |
| `webhook-mock` | starts an in-process mock server implementing the contract; save, duplicate, revision mismatch, partial failure |
| `discord` | prints the procedure and a sample event JSON for `rp discord` against a live gateway |

With `openclaw:<agent>` model refs the scenarios exercise the OpenClaw CLI adapter against the running gateway (set `OPENCLAW_BIN` if needed).

## Reconstruction test procedure

1. `rp reconstruct-check --campaign <dir>` (deterministic: identical Director inputs after wiping session keys; all committed packets valid).
2. Live: `run.mjs reconstruction`, or manually: play a turn, `/resume` (resets caches), play the next turn; compare `runtime/turns/*.json` `context_selection` — nothing may depend on a session.
3. Stronger: `openclaw sessions` delete the specialist sessions in the gateway, then play. Continuity must be unaffected because every task message is self-contained.

## Disaster recovery

| Situation | Action |
|---|---|
| Stuck lock | `rp repair-lock --force` (only when no turn is running) |
| Crash mid-commit | automatic: the journal is rolled forward on next open |
| Crash mid-turn | `/resume` or any `rp` start abandons incomplete turns; the player re-sends |
| Corrupt state file | `rp validate` names it; restore from `rp export-state` bundle (`rp import-state --confirm`), from durable canon (`/sync --discard` if provisional play is expendable), or from the volume backup |
| Lost volume | restore volume backup, or `rp campaign update <CAMPAIGN_ID>` (re-clones the campaign repository, installs) + `/sync` (state from durable canon) + `rp import-state` if you have a bundle |
| Campaign clone refused (dirty / diverged / unexpected origin) | inspect `CAMPAIGNS_REPO_DIR` with git yourself; the harness never merges, rebases, stashes, resets or force-updates. Removing the directory and re-running `rp campaign source-sync` re-clones |
| Bad save (backend wrote wrong data) | fix in the backend; local `pending-save.json` and `dirty.json` show what was sent |
| Wrong branch promoted | main was backed up under `branches/_pre-promote-*`; copy back manually |

Nothing in the harness invents missing canon; recovery is restore-based.

## Upgrading

- The harness ships in the image (`/opt/rp-harness`); state lives on the volume. Upgrades change code, never state, unless `schema_version` in `meta.json` changes, in which case the release notes describe a migration command.
- Before upgrading: `/save`, `rp export-state`, volume snapshot. After: `rp validate`, `rp reconstruct-check`, `rp smoke-test`.
- OpenClaw upgrades: verify `openclaw agent --json` output still carries `payloads[].text` (adapter contract) and re-run `rp setup-openclaw --dry-run` to compare config.

## Security boundaries

- Player: Discord allowlists at OpenClaw (`users`, `commands.allowFrom`) and again in the harness (`campaign.json → discord`).
- Coordinator: `tools.exec.mode: allowlist` plus one path-only approval entry for `/opt/rp-harness/bin/rp` in the exec-approvals store; never reads campaign files. Verify with `openclaw approvals get --gateway --agent <CAMPAIGN_ID>`.
- Specialists: no tools; every task is a self-contained message.
- Secrets: provider keys and persistence tokens are env vars; never written to the workspace; logs redact bearer tokens and key-like strings.
- Campaign repository: `CAMPAIGNS_REPO_TOKEN` should be a GitHub fine-grained personal access token scoped only to the campaign repository with repository **Contents: read-only** permission. `rp campaign source-sync` passes it to each git process as `-c http.extraHeader=Authorization: Basic …` (username `x-access-token`) with credential helpers disabled for that process; the remote URL stays the plain HTTPS URL and nothing is written to `.git/config` or `.git-credentials`. Git output is scrubbed of the token and header before it can reach an error message or the console. Tests: `test/campaign-source.test.js`.
- Durable canon credentials (Google etc.) live only in n8n.
- Local files: workspace under the persistent volume with the same permissions as OpenClaw state.
