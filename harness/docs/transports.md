# Transports

A transport delivers text in and out; it never changes canon semantics. Three are supported.

## Discord (`transport/discord.js`)

OpenClaw does the Discord I/O; the harness owns everything else through `DiscordTransport`, and the coordinator agent is a relay that runs one procedure for every inbound message (written into its `AGENTS.md` by `rp setup-openclaw`):

```
Discord message
  → coordinator builds {"message_id","channel_id","guild_id","user_id","text"}
  → exec: /opt/rp-harness/bin/rp discord --campaign <absolute workspace> --event-env
          env: RP_DISCORD_EVENT_JSON = that JSON            (message text never in the command)
  → stdout JSON {chunks, turn_id?, command?, redelivery?, reused?, failed?, refused?}
  → coordinator sends each chunk, in order, with OpenClaw's `message` tool; collects the returned ids
  → if turn_id and every send succeeded:
      exec: /opt/rp-harness/bin/rp deliver --campaign <workspace> --turn <turn_id> --transport discord --message-id <id1> --message-id <id2> …
  → coordinator ends with NO_REPLY (OpenClaw's case-insensitive silent token) so the chunks are the only reply
```

The transport owns authorization (guild/channel/user allowlists), `!` command translation, PLAY vs command, event ids (`discord:<message id>`), deduplication, command handling and 2000-character chunking. The coordinator never classifies messages and never composes prose.

**Delivery failure.** If any `message` send fails the coordinator stops, does not call `deliver`, does not run `discord` again and does not regenerate. The turn stays *committed but undelivered*: canon already advanced, nothing is lost. `rp pending` lists such turns. The player recovers with `!resume`: the transport returns the stored output as chunks together with the original `turn_id` (`redelivery: true`), the coordinator posts them and confirms delivery of that original turn. No Director or Novelist call happens on redelivery. A duplicate inbound event (Discord retry) returns the existing output with `reused: true` and never creates a second turn or revision.

### Player text never touches the shell

OpenClaw's exec allowlist mode rejects shell redirections, heredocs and pipes (`exec denied: allowlist miss`), and player text must never be shell-parsed anyway. So the coordinator's command string is a constant argument list (absolute `rp` path, which is also the exec allowlist entry, plus the absolute campaign root) and the event travels as the fixed environment variable `RP_DISCORD_EVENT_JSON` via `--event-env`; the variable name cannot be chosen by the caller. `rp turn --text-env` (`RP_PLAYER_INPUT`) exists on the same principle for direct turn invocation. `--event <file|->`, `--text` and `--stdin` remain for CLI and tests; each command accepts exactly one input source. The regression tests feed quotes, `$(...)`, backticks, `;`, `&&`, `|`, `<`, `>`, heredoc markers and multi-line text through this path and check byte-for-byte arrival with no side effects.

- Event id = `discord:<message id>` → duplicate Discord events (retries, double delivery) never create a second turn; the stored output is returned instead.
- Allowlists from `campaign.json → discord` (`guild_id`, `channel_id`, `user_ids`) are checked before anything runs; refusals are silent to canon.
- Chunking to 2000 characters on paragraph then sentence boundaries.
- `rp pending` lists committed-but-undelivered turns; `!resume` redelivers the last one through the same chunk/deliver protocol and marks the original turn delivered.
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
