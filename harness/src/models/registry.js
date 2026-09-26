// Role -> model resolution and the RoleCaller (schema-validated calls with one fallback).
//
// Model refs: "fake/<name>"           -> FakeModelAdapter (tests)
//             "openclaw:<agent-id>"   -> OpenClawCliAdapter (specialist agent through the gateway)
//             "<provider>/<model>"    -> HttpModelAdapter for that provider (config/models.json)
//             "<alias>"               -> expanded from config/models.json aliases or a campaign models.json
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, exists } from "../lib/fsx.js";
import { schemas } from "../lib/schema.js";
import { FakeModelAdapter, ModelError, extractJson } from "./adapter.js";
import { HttpModelAdapter } from "./http.js";
import { OpenClawCliAdapter } from "./openclaw-cli.js";
import { roleConfig } from "../campaign/manifest.js";

const DEFAULT_MODELS_CONFIG = fileURLToPath(new URL("../../config/models.json", import.meta.url));

export function loadModelsConfig(campaignRoot, { env = process.env } = {}) {
  const base = readJson(DEFAULT_MODELS_CONFIG);
  const override = env.RP_MODELS_CONFIG || (campaignRoot ? path.join(campaignRoot, "models.json") : null);
  if (override && exists(override)) {
    const o = readJson(override);
    return { providers: { ...base.providers, ...(o.providers || {}) }, aliases: { ...base.aliases, ...(o.aliases || {}) } };
  }
  return base;
}

export function resolveModelRef(ref, cfg) {
  let settings = {};
  let seen = 0;
  while (cfg.aliases?.[ref] && seen++ < 5) {
    const a = cfg.aliases[ref];
    settings = { ...settings, ...a };
    ref = a.model;
  }
  if (ref.startsWith("openclaw:")) return { provider: "openclaw", model: ref, settings };
  const slash = ref.indexOf("/");
  if (slash < 0) throw new ModelError(`model ref '${ref}' has no provider prefix and is not an alias`, { code: "bad-model-ref", retryable: false });
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1), settings };
}

export class AdapterFactory {
  constructor({ cfg, env = process.env, fake, fetchImpl, spawn, log } = {}) {
    this.cfg = cfg;
    this.env = env;
    this.fake = fake || new FakeModelAdapter();
    this.fetchImpl = fetchImpl;
    this.spawn = spawn;
    this.log = log;
    this.cache = new Map();
  }

  for(providerId) {
    if (this.cache.has(providerId)) return this.cache.get(providerId);
    const p = this.cfg.providers?.[providerId];
    let adapter;
    if (providerId === "fake" || p?.kind === "fake") adapter = this.fake;
    else if (providerId === "openclaw" || p?.kind === "openclaw-cli") adapter = new OpenClawCliAdapter({ env: this.env, spawn: this.spawn, log: this.log });
    else if (p?.base_url) adapter = new HttpModelAdapter({ providerId, baseUrl: this.env[p.base_url_env] || p.base_url, apiKeyEnv: p.api_key_env, headers: p.headers, fetchImpl: this.fetchImpl, env: this.env });
    else throw new ModelError(`unknown provider '${providerId}'`, { code: "unknown-provider", retryable: false });
    this.cache.set(providerId, adapter);
    return adapter;
  }
}

/**
 * RoleCaller: resolves a role to a model, calls it, validates JSON against a schema when given,
 * retries once on malformed output with the errors appended, then once on the fallback model.
 * Every call is reported to `onUsage` for metering. Session keys are supplied by the caller.
 */
export class RoleCaller {
  constructor({ manifest, factory, onUsage = () => {}, clock, log }) {
    this.manifest = manifest;
    this.factory = factory;
    this.onUsage = onUsage;
    this.clock = clock;
    this.log = log;
  }

  resolve(role, overrideModel) {
    const rc = roleConfig(this.manifest, role);
    const ref = overrideModel || rc.model;
    const r = resolveModelRef(ref, this.factory.cfg);
    return { rc, ...r, settings: { ...r.settings, ...pick(rc, ["temperature", "reasoning", "max_tokens", "timeout_ms"]) } };
  }

  async call(role, { system, user, schema, sessionKey, agentId, turn, allowFallback = true, jsonRetries = 1 }) {
    const primary = this.resolve(role);
    const attempts = [primary];
    if (allowFallback && primary.rc.fallback) attempts.push(this.resolve(role, primary.rc.fallback));
    let lastErr;
    for (const target of attempts) {
      const adapter = this.factory.for(target.provider);
      let userText = user;
      for (let i = 0; i <= jsonRetries; i++) {
        try {
          const res = await adapter.complete({
            role, model: target.model, system, user: userText, schema,
            temperature: target.settings.temperature, maxTokens: target.settings.max_tokens,
            timeoutMs: target.settings.timeout_ms, reasoning: target.settings.reasoning,
            sessionKey, agentId: agentId || target.rc.agent_id || target.model.replace(/^openclaw:/, ""),
          });
          this.onUsage({ role, model: `${target.provider}/${target.model}`, usage: res.usage, turn, cost_reported: res.cost_reported });
          if (!schema) return { ...res, role };
          const json = res.json ?? extractJson(res.text);
          const errs = schemas.errors(schema, json);
          if (errs.length) throw new ModelError(`${schema} validation: ${errs.slice(0, 6).join("; ")}`, { code: "schema", retryable: true, cause: errs });
          return { ...res, json, role };
        } catch (err) {
          lastErr = err;
          const retryable = err instanceof ModelError ? err.retryable : true;
          const isFormat = err instanceof ModelError && (err.code === "schema" || err.code === "bad-json");
          this.log?.warn?.(`[${role}] attempt ${i + 1} on ${target.provider}/${target.model} failed: ${err.message}`);
          if (!retryable) break;
          if (isFormat && i < jsonRetries) {
            userText = `${user}\n\n---\nYour previous reply was rejected: ${err.message}\nReturn ONLY a JSON object that satisfies the required schema.`;
            continue;
          }
          break;
        }
      }
    }
    throw lastErr instanceof ModelError ? lastErr : new ModelError(String(lastErr), { cause: lastErr });
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
