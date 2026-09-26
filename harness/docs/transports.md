# Transports

A transport delivers text in and out; it never changes canon semantics. Three are supported.

## Discord (`transport/discord.js`)

OpenClaw does the Discord I/O. The coordinator agent runs `rp turn --transport discord --event-id <message id>` (or `rp discord --event <json>` for the full helper) and posts the output; then `rp deliver --turn <id> --message-id <ids>` records delivery.

- Event id = `discord:<message id>` → duplicate Discord events (retries, double delivery) never create a second turn; the stored output is returned instead.
- Allowlists from `campaign.json → discord` (`guild_id`, `channel_id`, `user_ids`) are checked before anything runs; refusals are silent to canon.
- Chunking to 2000 characters on paragraph then sentence boundaries.
- `rp pending` lists committed-but-undelivered turns; `/resume` redelivers the last one.
- Threads: `discord.threads = off | sessions | branches_on_request`. Threads never create a branch by themselves; in `branches_on_request` a thread must first run `/branch create <id>`.

OpenClaw side (written by `rp setup-openclaw`): binding guild+channel → coordinator; `requireMention: false`; `users` allowlist; `commands.allowFrom.discord` for the player. The harness owns history; optionally lower `channels.discord.historyLimit` (channel-wide) by hand.

Setup checklist: create the bot (Message Content Intent on), invite with `bot` + `applications.commands`, put guild/channel/user ids into `campaign.json`, run `rp setup-openclaw`, restart the gateway, `openclaw channels status --probe`, send `/status` in the channel.

## OpenClaw UI

Same as CLI: the coordinator agent is reachable from the Control UI; messages route through `rp turn --transport openclaw-ui`. Delivery is immediate.

## CLI / tests

`rp turn --campaign <dir> --text "…"` or `--stdin`. `TextTransport` marks turns delivered as soon as output is returned. Used by the CLI integration test and `rp smoke-test`.
