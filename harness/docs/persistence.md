# Persistence: save, sync, adapters

## Concepts

- Durable canon lives behind a `PersistenceAdapter`. The harness never knows the backend.
- Local `state/` is the hot runtime copy. Committed-but-unsaved revisions are listed in `runtime/dirty.json` and their facts carry `persistence: provisional`.
- Every save is a packet with a deterministic `save_id`; backends must be idempotent by it.
- Local state is marked saved **only** after the adapter reports `ok` (or `duplicate`). Partial or failed saves leave everything unsaved and keep the packet in `runtime/pending-save.json` for a retry with the same id.

## Adapter contract (`persistence/adapter.js`)

```
getRemoteRevision() -> { canon_revision }
pullCanon()         -> sync-manifest { campaign, canon_revision, files: { <canon role>: markdown }, state?: {...} }
save(packet)        -> save-result { save_id, status: ok|partial|rejected|duplicate|error, applied[], failed[{target,error}], canon_revision, message }
health()            -> { ok, message }
```

Adapters: `LocalFilesystemPersistenceAdapter` (a directory: `canon/<role>.md`, `state/*.json`, `audit.jsonl`, `meta.json` with revision and save ledger; supports injected per-target failures for tests), `WebhookPersistenceAdapter` (n8n or any API), `NoopPersistenceAdapter` (`save.adapter: none`). Selected by `campaign.json → save.adapter`.

## Save packet (schema `save-packet`)

```
save_id  = <CAMPAIGN_ID>:save:<session_id>:<rev_from>-<rev_to>:<sha256(replace+events)[:12]>
source   = { revision_from, revision_to, turn_ids }
expect   = { canon_revision }                 remote must match or reject
append   = { chronicle {heading, markdown}, audit[], divergences[], references{} }   append-only records
replace  = { scene, facts, relationships, unresolved, candidates, actors, minds }    current-state replacement
deltas   = { relationships[], minds[] }       optional
events   = { knowledge[], resolution[] }      events from the saved turns
summary  = optional session summary (summary role, when save.session_summary)
```

Backend rules: apply `replace`/`events` before any `append` (an append must never land without its state); on `expect` mismatch return `rejected`; a repeated `save_id` returns `duplicate` with the original result and writes nothing; report `applied`/`failed` per target.

## Sync semantics (`persistence/sync.js`)

| Local | Remote | Result |
|---|---|---|
| clean | changed | pull canon files (and state if provided) |
| dirty | unchanged | no-op; report unsaved turns |
| dirty | changed | **conflict**; no auto-merge |

Conflict options: `/save` first (rejected on revision mismatch for touched targets), `/sync --stash` (unsaved turns and pre-sync state copied to `runtime/stash/<timestamp>/`, marked non-canon, never replayed; then pull), `/sync --discard <CAMPAIGN_ID>` (explicit confirmation required). Stash and discard need remote state in the manifest to revert local provisional state.

## Operator commands

`rp dry-run-save`, `rp test-adapter`, `/save --dry-run`, `/sync --status`.

## n8n

See [examples/n8n-contract.md](examples/n8n-contract.md) for the HTTP contract and `examples/n8n-save-workflow.example.json` for a placeholder workflow. Environment: `RP_SAVE_URL`, `RP_SAVE_TOKEN`, `RP_SYNC_URL` (names configurable in `campaign.json → save`). Google credentials live only in n8n.
