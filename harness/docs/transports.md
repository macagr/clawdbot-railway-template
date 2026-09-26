# Transports

A transport delivers text in and out; it never changes canon semantics. Three are supported.

## Discord (`transport/discord.js`)

OpenClaw does the Discord I/O. The coordinator agent runs `rp turn --transport discord --event-id <message id>` (or `rp discord --event <json>` for the full helper) and posts the output; then `rp deliver --turn <id> --message-id <ids>` records delivery.

- Event id = `discord:<message id>` → duplicate Discord events (retries, double delivery) never create a second turn; the stored output is returned instead.
- Allowlists from `campaign.json → discord` (`guild_id`, `channel_id`, `user_ids`) are checked before anything runs; refusals are silent to canon.
- Chunking to 2000 characters on paragraph then sentence boundaries.
- `rp pending` lists committed-but-undelivered turns; `!resume` redelivers the last one.
- Threads: `discord.threads = off | sessions | branches_on_request`. Threads never create a branch by themselves; in `branches_on_request` a thread must first run `!branch create <id>`.

### Commands in Discord: `!status`, not `/status`

`/` is OpenClaw's native slash-command namespace: `/status` returns OpenClaw's gateway/model/session status and `/context` opens OpenClaw's context help, and neither reaches the harness. The harness does not fight, unregister or override those. Instead the Discord transport uses a **command prefix**, `!` by default (`campaign.json → discord.command_prefix`, one to three non-alphanumeric characters):

```
!status            !context            !context novelist
!mode play         !scene montage      !good        !flat
!ooc some text     !save               !sync --status
!branch list       !resume             !help
```

Rules, all applied only to the whole trimmed message and only at the Discord boundary (`DiscordTransport`, `rp turn --transport discord`, `rp command --transport discord`):

- `!name [args]` is rewritten to the canonical `/name [args]`; arguments are passed through verbatim. Canonical semantics, the CLI and internal `/` routing are unchanged.
- An unknown `!foo` gets the harness's unknown-command answer (`Unknown or disabled command !foo. Try !help.`) and never becomes a turn.
- Anything else is play input: `Hello! How are you?`, `!` alone, `!123`, `no!` inside a sentence.
- A canonical `/name` that OpenClaw did not intercept (for example `/mode play`) is still accepted when that command is enabled, so it does not turn into a PLAY turn either.
- Help and error texts render with the prefix; command outputs are otherwise identical to the CLI.
- Commands are not deduplicated by message id (they are reads or explicit operations); turns are.

OpenClaw side (written by `rp setup-openclaw`): Discord plugin enabled; `channels.discord.groupPolicy: allowlist`; binding guild+channel → coordinator (merged with existing bindings, one per campaign); `requireMention: false`; `users` allowlist; `commands.allowFrom.discord` for the player (merged). The coordinator gets `exec` (to run `rp`) and `message` (to reply); specialists have no tools. The harness owns history; optionally lower `channels.discord.historyLimit` (channel-wide) by hand. **Operator authority** (`commands.ownerAllowFrom`) is not derived from players; set it once per deployment: `openclaw config set --strict-json commands.ownerAllowFrom '["discord:<OPERATOR_ID>"]'`.

Setup checklist: create the bot (Message Content Intent on), invite with `bot` + `applications.commands`, put guild/channel/user ids into `campaign.json`, run `rp setup-openclaw`, restart the gateway, `openclaw channels status --probe`, send `!status` in the channel.

## OpenClaw UI

Same as CLI: the coordinator agent is reachable from the Control UI; messages route through `rp turn --transport openclaw-ui`. Delivery is immediate.

## CLI / tests

`rp turn --campaign <dir> --text "…"` or `--stdin`. `TextTransport` marks turns delivered as soon as output is returned. Used by the CLI integration test and `rp smoke-test`.
