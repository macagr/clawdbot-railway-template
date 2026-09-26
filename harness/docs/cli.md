# CLI reference (`rp`)

All commands take `--campaign <workspace dir>` unless noted. Exit codes: 0 ok, 1 error/invalid, 2 turn failed (nothing recorded), 3 refused (transport allowlist).

## Play

| Command | Description |
|---|---|
| `rp turn [--event-id <id>] [--transport cli\|discord\|openclaw-ui] [--player <id>] [--show-stop\|--hide-stop] (--text <t> \| --stdin)` | run one turn; prints the player-facing output (stop line per `output.show_stop_reason` unless overridden) |
| `rp command [--event-id <id>] [--transport <t>] -- /<cmd> [args]` | run a slash command |
| `rp discord --event <file\|->` | handle a normalized Discord event `{message_id, channel_id, guild_id, user_id, thread_id?, text}`; prints `{chunks, turn_id}` |
| `rp deliver --turn <id> [--message-id <id>]... [--transport <t>]` | mark a committed turn delivered |
| `rp pending` | committed-but-undelivered turns |

## Operate

| Command | Description |
|---|---|
| `rp status` | same as `/status` |
| `rp context [director\|novelist] [-- text]` | selection preview, no model call |
| `rp validate` | schema + cross-reference validation of all state; reports lock/journal presence |
| `rp reconstruct-check` | wipes specialist session keys and proves Director inputs are identical; checks committed packets |
| `rp repair-lock [--force]` | release a stale lock (refuses locks younger than 60 s without `--force`) |
| `rp export-state --out <file>` / `rp import-state --in <file> --confirm <CAMPAIGN_ID>` | full state/runtime bundle |
| `rp dry-run-save` | build the save packet without sending |
| `rp test-adapter` | persistence adapter health |
| `rp smoke-test [--text <t>]` | one real turn through the configured models |
| `rp lint-generic [--denylist <file>]` | scan the generic tree for campaign tokens |

## Setup

| Command | Description |
|---|---|
| `rp init` | create state/runtime for a package (idempotent) |
| `rp campaign install --from <pkg> --to <workspace>` | copy a package, never touching existing state |
| `rp campaign source-sync [--json]` (no `--campaign`) | clone or fast-forward the private campaign repository into `CAMPAIGNS_REPO_DIR`; prints `cloned` / `already current` / `fast-forwarded` / `refused` with short SHAs; exit 1 when refused or failed |
| `rp campaign update <campaign-id> [--workspaces-root <dir>] [--json]` (no `--campaign`) | `source-sync`, then install `<CAMPAIGNS_REPO_DIR>/<campaign-id>` into `<workspaces root>/<campaign-id>` (live `state/ runtime/ branches/ persistence/` untouched), then validate; names the failing stage (`source-sync`, `resolve`, `install`, `validate`) on exit 1. Never runs `setup-openclaw`, never touches bindings, OpenClaw or live state |
| `rp setup-openclaw [--dry-run] [--rp-bin <path>] [--workspaces-root <dir>]` | write workspace files, apply OpenClaw config (`tools.exec.mode: allowlist`), add the exec-approval allowlist entry for `rp`; exit 4 with an `ACTION REQUIRED` command if the approval could not be added |
| `rp sillytavern import --file <card.json> [--id <id>] [--force]` / `rp sillytavern export --voice <id> --out <file>` | card adapter |

## Environment

`RP_LOG_LEVEL` (debug/info/warn/error/silent), `RP_FAKE_RESPONSES` (scripted models), `RP_MODELS_CONFIG`, `OPENCLAW_BIN`, `GIT_BIN`, provider keys named in `config/models.json`, persistence env vars named in `campaign.json`.

Campaign source (`rp campaign source-sync` / `update`):

| Variable | Default | Meaning |
|---|---|---|
| `CAMPAIGNS_REPO_TOKEN` | required | GitHub token for the private campaign repository. Use a fine-grained personal access token scoped to that single repository with **Contents: read-only** and nothing else. Passed to each git process as a per-process header; never written to the remote URL, `.git/config`, a credential helper, `.git-credentials`, logs or output |
| `CAMPAIGNS_REPO_URL` | `https://github.com/macagr/rp-campaigns.git` | HTTPS URL of the repository (must not embed credentials) |
| `CAMPAIGNS_REPO_BRANCH` | `main` | the only branch cloned and fast-forwarded |
| `CAMPAIGNS_REPO_DIR` | `/data/campaigns-src` | persistent clone on the volume |
| `RP_WORKSPACES_ROOT` | `/data/workspaces` | where `campaign update` installs (`--workspaces-root` overrides) |

Example:

```
rp campaign source-sync
rp campaign update <CAMPAIGN_ID>
rp setup-openclaw --campaign /data/workspaces/<CAMPAIGN_ID> --dry-run   # only if roles, models or Discord ids changed
```

Destructive operations (`import-state`, `/sync --discard`, `/branch discard`, `/branch promote`) require explicit confirmation. No repair command invents missing canonical content; `rp validate` reports, it does not fix.
