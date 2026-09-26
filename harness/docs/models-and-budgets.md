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

`runtime/usage.json`: one record per call (role, model, tokens, cached tokens, cost, estimated flag) and totals by day, month and role. Token counts are taken per CLI/HTTP invocation. Cost precedence: configured role prices × tokens (cached input at half price) when `input_price_per_m`/`output_price_per_m` are set for the role; otherwise a positive provider-reported cost; otherwise 0 flagged `estimated`. Provider-reported cost is deliberately not preferred because `openclaw agent` envelopes do not report it per invocation. Set prices for every role you use so `/status` and the caps are meaningful. Caps (`budget.per_turn/per_day/per_month`) are checked **before each call**; reaching a cap fails the turn before any model runs (`Budget cap reached`). `warn_fraction` produces warnings in `/status`.

## Where the tokens go: OpenClaw agents versus direct endpoints

An `openclaw:<agent>` specialist receives OpenClaw's own system prompt (tool guidance, safety sections, runtime context, skills catalog, bootstrap files) on top of the harness task. Measured on 2026.9.5 with an empty tool list and a two-paragraph `AGENTS.md`: about 38k input tokens per call, of which the harness context was about 3.5k. `rp setup-openclaw` sets `promptMode: "minimal"` on specialist agents (tolerated if the gateway rejects the key), which drops the memory, identity and messaging sections; measure again after applying it.

If the overhead is still large, point the specialist roles at a provider directly (`"model": "openrouter/<model>"` or `"openai/<model>"`): every task message is self-contained, so the behaviour is identical and only the harness context is sent. Keep `openclaw:<agent>` where you want OpenClaw's auth profiles, model fallbacks and usage ledger for that role. The coordinator must stay an OpenClaw agent either way; it is the transport.

Usage from `openclaw agent --json` is read from `result.meta.agentMeta.usage` (`input`, `output`, `cacheRead`, `cost.total`), per invocation.

## Prompt caching

Contexts put stable material first (generic prompt, campaign fragments, canon) and changing material last (scene, recent turns, input), so providers with prefix caching benefit without any special handling.
