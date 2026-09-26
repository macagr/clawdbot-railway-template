# Webhook persistence contract (n8n or custom API)

All requests carry `Authorization: Bearer <RP_SAVE_TOKEN>` and `content-type: application/json`. URLs come from environment variables named in `campaign.json → save` (`endpoint_env`, `sync_endpoint_env`, `token_env`); nothing is hard-coded.

## POST {RP_SAVE_URL}

Headers: `Idempotency-Key: <save_id>`.

Request body: a `save-packet` (see `harness/schemas/save-packet.json`):

```json
{
  "schema_version": 1,
  "save_id": "<CAMPAIGN_ID>:save:<session>:12-15:9f3a1c2b4d5e",
  "campaign": "<CAMPAIGN_ID>",
  "session_id": "<session>",
  "created_at": "2026-01-01T00:00:00.000Z",
  "source": { "revision_from": 12, "revision_to": 15, "turn_ids": ["<CAMPAIGN_ID>-000013", "..."] },
  "expect": { "canon_revision": 7 },
  "append": {
    "chronicle": { "heading": "Session <session>, revisions 12-15", "markdown": "..." },
    "audit": [ { "turn_id": "...", "summary": "...", "revision": 13 } ],
    "divergences": [], "references": {}
  },
  "replace": { "scene": {}, "facts": [], "relationships": {}, "unresolved": {}, "candidates": [], "actors": {}, "minds": [] },
  "events": { "knowledge": [], "resolution": [] },
  "summary": "optional"
}
```

Response body: a `save-result`:

```json
{ "save_id": "<same>", "status": "ok", "applied": ["state.facts", "state.scene", "events", "chronicle", "audit"], "failed": [], "canon_revision": 8, "message": "saved" }
```

Status semantics:

| status | meaning | harness reaction |
|---|---|---|
| `ok` | all targets applied; `canon_revision` is the new revision | marks local revisions saved, clears dirty |
| `duplicate` | this `save_id` was already applied; return the original result | same as ok |
| `rejected` | `expect.canon_revision` did not match, or validation failed; nothing written | keeps everything unsaved; user must `/sync` |
| `partial` | some targets applied, some failed (list both) | keeps everything unsaved; retry sends the **same** `save_id`; backend must skip already-applied targets |
| `error` | nothing applied | retry later |

HTTP: 2xx with a body for all of the above. 4xx (other than 429) is not retried; 5xx/429/network errors are retried with backoff (`save.retries`).

Backend obligations: keep a ledger keyed by `save_id` (with per-target status for partial retries); apply `replace` and `events` before `append`; compare `expect.canon_revision` against the current revision before writing; increment `canon_revision` exactly once per successful save.

## GET {RP_SYNC_URL}?campaign=<CAMPAIGN_ID>&revision_only=1

```json
{ "canon_revision": 8 }
```

## GET {RP_SYNC_URL}?campaign=<CAMPAIGN_ID>

A `sync-manifest`:

```json
{
  "campaign": "<CAMPAIGN_ID>",
  "canon_revision": 8,
  "exported_at": "...",
  "files": { "operational_canon": "# ...markdown...", "style_rules": "...", "recent_history": "...", "divergence_history": "..." },
  "state": { "scene": {}, "facts": [], "relationships": {}, "unresolved": {}, "candidates": [], "actors": {}, "minds": [] }
}
```

`files` keys are canon roles from `campaign.json → canon`. `state` is optional but required for `/sync --stash` and `/sync --discard`.

## Failure semantics summary

- No local "saved" marking without an `ok`/`duplicate` response.
- A save is safe to retry at any time; the backend's idempotency makes retries harmless.
- A sync never overwrites unsaved local play; conflicts stop and require an explicit choice.
