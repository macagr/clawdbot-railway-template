# Model adapters, roles, metering

## Roles

`coordinator` (configured in OpenClaw only), `director`, `novelist`, `editor` (optional), `npc`, `casting`, `summary`, `propagation`. Each has `campaign.json → roles.<role>`: `model`, optional `fallback`, `temperature`, `reasoning`, `max_tokens`, `timeout_ms`, `input_price_per_m`, `output_price_per_m`, `agent_id`.

## Model references

| Form | Adapter |
|---|---|
| `fake/<name>` | `FakeModelAdapter` (tests; `RP_FAKE_RESPONSES=<json>` scripts responses per role) |
| `openclaw:<agent id>` | `OpenClawCliAdapter`: `openclaw agent --agent <id> --session-key <key> --message-file <f> --json --timeout <s>`; reply from `payloads[].text`, usage and `costUsd` when present |
| `<provider>/<model>` | `HttpModelAdapter` (OpenAI-compatible chat completions); providers in `harness/config/models.json` (`base_url`, `api_key_env`, `headers`), overridable per campaign with `models.json` or `RP_MODELS_CONFIG` |
| `<alias>` | expanded from `aliases` (may carry temperature etc.) |

Keys are read from environment variables only. The HTTP adapter sends `response_format: json_object` when a schema is requested and passes `reasoning.effort` when configured.

## RoleCaller (`models/registry.js`)

`call(role, { system, user, schema, sessionKey, turn })`: resolves the model; on schema-validation or JSON failure re-asks once with the errors appended; on a retryable provider error tries the role's `fallback` once; non-retryable errors stop immediately. Every attempt, including rejected ones, is metered.

## Usage meter (`meter/usage.js`)

`runtime/usage.json`: one record per call (role, model, tokens, cached tokens, cost, estimated flag) and totals by day, month and role. Cost = provider-reported cost when available, else role prices × tokens (cached input at half price). Caps (`budget.per_turn/per_day/per_month`) are checked **before each call**; reaching a cap fails the turn before any model runs (`Budget cap reached`). `warn_fraction` produces warnings in `/status`.

## Prompt caching

Contexts put stable material first (generic prompt, campaign fragments, canon) and changing material last (scene, recent turns, input), so providers with prefix caching benefit without any special handling.
