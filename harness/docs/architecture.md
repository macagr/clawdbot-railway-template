# Architecture

## Layers

```
Discord / OpenClaw UI / CLI
        │  message + event id
        ▼
OpenClaw coordinator agent  <CAMPAIGN_ID>          (thin: runs `rp`, relays output)
        │  exec: rp turn | rp command
        ▼
rp harness (this code)                              owns the turn transaction
   ├─ context builder  → Director (agent <CAMPAIGN_ID>-director, or any model)
   ├─ NPC decision calls (fresh, filtered)
   ├─ casting proposals
   ├─ context builder  → Novelist (agent <CAMPAIGN_ID>-novelist)
   ├─ deterministic validation
   ├─ Editor (optional, question-driven)
   └─ atomic commit → state/ runtime/
        │  /save                                   │ /sync
        ▼                                          ▼
PersistenceAdapter (local | webhook → n8n → durable canon)
```

## Invariants (frozen)

1. Explicit state is authority. Models reason over selected views of explicit state. No model or session transcript is canon.
2. Every specialist (Director, Novelist, Editor, NPC decision) is reconstructable from durable canon + campaign package + explicit runtime state + committed turns. Deleting specialist sessions must not change what happens next (`rp reconstruct-check`).
3. Code derives, models decide: holdings, permitted views, revisions, speaker sets, form pressure are computed and never requested from a model.
4. Knowledge changes only through `KnowledgeEvent`s; truth changes only through `ResolutionEvent`s.
5. State mutates only at atomic commit, after deterministic validation. No API/model failure can mutate state.
6. `authorial: undecided` means genuinely undecided. Candidate resolutions are explicit and non-canonical. Decided hidden truth is explicit state with `visibility: gm_only` and grants nobody a holding.
7. Voice cards, exemplars and craft files are style-only and non-evidential.
8. Semantic modes are explicit and commanded; presentation changes are policy-governed and always visible.
9. Generic files contain no campaign-specific content (`rp lint-generic`).
10. Duplicate external events never create duplicate canonical turns (event id → turn id index).
11. Every model call is metered and capped.

## Agent topology (per campaign)

| Agent | Role | Tools | Session |
|---|---|---|---|
| `<CAMPAIGN_ID>` | coordinator: player-facing, runs `rp` | `exec` (allowlisted to `rp`) | channel session, persists, not authority |
| `<CAMPAIGN_ID>-director` | world/logic authority, returns a JSON packet | none | disposable cache, reset per policy |
| `<CAMPAIGN_ID>-novelist` | prose only | none | disposable cache |
| `<CAMPAIGN_ID>-editor` | optional semantic reviewer | none | disposable cache |
| NPC decisions, casting, summary, propagation | fresh calls, no agent required | – | none |

The harness calls specialist agents synchronously with `openclaw agent --agent <id> --session-key <key> --message-file <f> --json` (OpenClaw CLI adapter). Any role may instead be pointed at a direct OpenAI-compatible endpoint (`provider/model` ref) with no OpenClaw agent at all; the contract is identical because every task message is self-contained.

**Deviation from the earlier "coordinator uses `sessions_send`" sketch:** `sessions_send` is a coordinator-side tool and would make the coordinator model shuttle every payload and own the transaction. The harness owns the transaction, so it invokes specialists itself through `openclaw agent`, which returns reply text and usage; `/hooks/agent` was rejected because it never returns model output.

## OpenClaw integration

`rp setup-openclaw` derives from `campaign.json`:

- `agents.ownership: "explicit"`; `agents.entries.<CAMPAIGN_ID>` (workspace = campaign dir, `tools.allow: ["exec"]`) and one entry per specialist role with `tools.allow: []`, separate workspaces `<root>/<CAMPAIGN_ID>-<role>`.
- `bindings[]`: Discord guild + channel → coordinator.
- `channels.discord.guilds.<guild>.channels.<channel>`: `requireMention: false`, `users` allowlist. (`historyLimit` is channel-wide in OpenClaw; set `channels.discord.historyLimit` yourself if you want less Discord history in the coordinator's context. The coordinator relays only, so it is not required.)
- `tools.agentToAgent.enabled`, `tools.sessions.visibility: "agent"`, `tools.exec.mode: "allowlist"`, `commands.allowFrom.discord`.
- Exec allowlist entry for the coordinator through the approvals store, not config: `openclaw approvals allowlist add --gateway --agent <CAMPAIGN_ID> /opt/rp-harness/bin/rp` (path-only, idempotent). If that command fails, setup exits with code 4 and prints the exact command as an `ACTION REQUIRED` line; it never falls back to a broader exec mode.
- Memory disabled for all campaign agents (canon is files, not memory).
- Workspace files: coordinator `AGENTS.md` (relay only, never reads campaign files), specialist `AGENTS.md` (self-contained tasks, no tools).

Use `--dry-run` to print the exact `openclaw config set --strict-json` commands. Verify with `openclaw agents list --bindings` and `openclaw config validate`.

## What lives where

- `harness/src` — orchestration, schemas, adapters (generic).
- `harness/prompts` — generic role prompts with placeholders; campaign fragments are appended, never merged.
- `/data/workspaces/<CAMPAIGN_ID>` — campaign package + `state/` + `runtime/` (+ `branches/`, `craft/`).
- Durable canon — wherever the persistence adapter points (local directory or n8n → documents).
