// OpenAI-compatible chat-completions adapter (works for OpenAI, OpenRouter and similar).
// Credentials come from environment variables named in the provider config; never from files.
import { ModelError } from "./adapter.js";

export class HttpModelAdapter {
  constructor({ providerId, baseUrl, apiKeyEnv, apiKey, headers = {}, fetchImpl = globalThis.fetch, env = process.env } = {}) {
    this.providerId = providerId;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey ?? (apiKeyEnv ? env[apiKeyEnv] : undefined);
    this.headers = headers;
    this.fetch = fetchImpl;
    if (!this.apiKey) throw new ModelError(`provider ${providerId}: missing API key (env ${apiKeyEnv || "?"})`, { code: "no-key", retryable: false });
  }

  async complete({ model, system, user, schema, temperature, maxTokens, timeoutMs = 120000, reasoning }) {
    const body = {
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(schema ? { response_format: { type: "json_object" } } : {}),
      ...(reasoning && reasoning !== "off" ? { reasoning: { effort: reasoning } } : {}),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, ...this.headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new ModelError(`provider ${this.providerId}: ${err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : err.message}`, { code: err.name === "AbortError" ? "timeout" : "network", cause: err });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      throw new ModelError(`provider ${this.providerId}: HTTP ${res.status} ${text.slice(0, 300)}`, { code: `http-${res.status}`, retryable });
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string") throw new ModelError(`provider ${this.providerId}: empty completion`, { code: "empty" });
    const u = data.usage || {};
    return {
      text,
      usage: {
        input_tokens: u.prompt_tokens ?? 0,
        output_tokens: u.completion_tokens ?? 0,
        cached_tokens: u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0,
      },
      model: data.model || model,
      provider: this.providerId,
    };
  }
}
