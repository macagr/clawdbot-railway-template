# CLI reference (`rp`)

All commands take `--campaign <workspace dir>` unless noted. Exit codes: 0 ok, 1 error/invalid, 2 turn failed (nothing recorded), 3 refused (transport allowlist).

## Play

| Command | Description |
|---|---|
| `rp turn [--event-id <id>] [--transport cli\|discord\|openclaw-ui] [--player <id>] (--text <t> \| --stdin)` | run one turn; prints the player-facing output |
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
| `rp setup-openclaw [--dry-run] [--rp-bin <path>] [--workspaces-root <dir>]` | write workspace files and apply OpenClaw config |
| `rp sillytavern import --file <card.json> [--id <id>] [--force]` / `rp sillytavern export --voice <id> --out <file>` | card adapter |

## Environment

`RP_LOG_LEVEL` (debug/info/warn/error/silent), `RP_FAKE_RESPONSES` (scripted models), `RP_MODELS_CONFIG`, `OPENCLAW_BIN`, provider keys named in `config/models.json`, persistence env vars named in `campaign.json`.

Destructive operations (`import-state`, `/sync --discard`, `/branch discard`, `/branch promote`) require explicit confirmation. No repair command invents missing canonical content; `rp validate` reports, it does not fix.
