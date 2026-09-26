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

An `openclaw:<agent>` specialist receives OpenClaw's own system prompt and tool schemas on top of the harness task. Measured on 2026.9.5: the system prompt is ~15k chars (~3.7k tokens of fixed OpenClaw sections plus the workspace files), but a specialist configured with `tools: { allow: [] }` still received a ~30k-token cached prefix, because an **empty allow list counts as unset** and the full tool catalog (~23k tokens of schemas) was sent. `rp setup-openclaw` therefore configures specialists with `tools: { profile: "minimal", deny: ["*"] }` and the coordinator with `{ profile: "minimal", alsoAllow: ["exec"] }`. OpenClaw also seeds `IDENTITY/SOUL/USER/BOOTSTRAP.md` into new workspaces; setup rewrites the first three to one line and removes `BOOTSTRAP.md`. Measure with `node /opt/rp-harness/scripts/measure-prompt.mjs <agent> /data/.openclaw`, which prints the stored `systemPromptReport`.

If the overhead is still large, point the specialist roles at a provider directly (`"model": "openrouter/<model>"` or `"openai/<model>"`): every task message is self-contained, so the behaviour is identical and only the harness context is sent. Keep `openclaw:<agent>` where you want OpenClaw's auth profiles, model fallbacks and usage ledger for that role. The coordinator must stay an OpenClaw agent either way; it is the transport.

Usage from `openclaw agent --json` is read from `result.meta.agentMeta.usage` (`input`, `output`, `cacheRead`, `cost.total`), per invocation.

## Coordinator model: production observations

- **Never rely on the coordinator model to echo `rp` output.** Observed on 2026.9.5: after a successful `rp` exec the coordinator's post-tool model pass completed (HTTP 200) yet produced no visible assistant payload, and OpenClaw logged `visible channel turn dispatched with no queued reply payloads … cause=completed`. The player received nothing although the turn was committed. This is why the Discord coordinator posts chunks itself with the `message` tool and confirms with `rp deliver` (see [transports.md](transports.md)); the model's final reply is `NO_REPLY` and carries no fiction.
- **`openrouter/auto` can route the coordinator to endpoints with incompatible reasoning requirements.** Observed: HTTP 400 `Reasoning is mandatory for this endpoint and cannot be disabled`, then OpenClaw's `unsupported thinking level for openrouter/openrouter/auto; retrying with minimal`, which succeeded. Harmless in that instance, but it adds latency and a failure mode to the relay. Pin the coordinator (`roles.coordinator.model` in `campaign.json`, written to `agents.entries.<CAMPAIGN_ID>.model` by `rp setup-openclaw`) to one cheap, tool-capable model whose reasoning settings are known rather than an auto router. Specialists are unaffected by this: their calls go through the harness adapters with per-role settings.

## Prompt caching

Contexts put stable material first (generic prompt, campaign fragments, canon) and changing material last (scene, recent turns, input), so providers with prefix caching benefit without any special handling.
