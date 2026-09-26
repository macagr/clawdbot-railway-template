// WebhookPersistenceAdapter: generic HTTP contract for n8n or any custom API.
//   POST {endpoint}            body: save-packet          -> save-result
//   GET  {syncEndpoint}?campaign=<id>&revision_only=1     -> { canon_revision }
//   GET  {syncEndpoint}?campaign=<id>                     -> sync-manifest
//   GET  {endpoint}/health (optional)                     -> { ok }
// Auth: Bearer token from an env var. Idempotency-Key header = save_id. Retries on network
// errors and 5xx with backoff; never retries a 4xx (except 429).
import { PersistenceError, assertSaveResult, assertSyncManifest } from "./adapter.js";
import { schemas } from "../lib/schema.js";

export class WebhookPersistenceAdapter {
  constructor({ campaignId, endpointEnv, tokenEnv, syncEndpointEnv, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 30000, retries = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.campaignId = campaignId;
    this.endpoint = env[endpointEnv];
    this.syncEndpoint = env[syncEndpointEnv] || (this.endpoint ? this.endpoint.replace(/\/save\/?$/, "/canon") : undefined);
    this.token = tokenEnv ? env[tokenEnv] : undefined;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.sleep = sleep;
    if (!this.endpoint) throw new PersistenceError(`webhook adapter: env ${endpointEnv} is not set`, { code: "config" });
  }

  headers(extra = {}) {
    return { "content-type": "application/json", accept: "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  async #request(url, init, { retryable = true } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetch(url, { ...init, signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) return await res.json();
        const body = await res.text().catch(() => "");
        const err = new PersistenceError(`HTTP ${res.status} from ${url}: ${body.slice(0, 300)}`, { code: `http-${res.status}`, retryable: res.status === 429 || res.status >= 500 });
        if (!err.retryable || !retryable) throw err;
        lastErr = err;
      } catch (err) {
        clearTimeout(t);
        if (err instanceof PersistenceError && !err.retryable) throw err;
        lastErr = err instanceof PersistenceError ? err : new PersistenceError(`${err.name === "AbortError" ? "timeout" : err.message} calling ${url}`, { code: err.name === "AbortError" ? "timeout" : "network", retryable: true, cause: err });
        if (!retryable) throw lastErr;
      }
      if (attempt < this.retries) await this.sleep(500 * 2 ** attempt);
    }
    throw lastErr;
  }

  async health() {
    try {
      await this.getRemoteRevision();
      return { ok: true, message: `webhook reachable at ${this.syncEndpoint}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async getRemoteRevision() {
    const url = `${this.syncEndpoint}${this.syncEndpoint.includes("?") ? "&" : "?"}campaign=${encodeURIComponent(this.campaignId)}&revision_only=1`;
    const data = await this.#request(url, { method: "GET", headers: this.headers() });
    if (data.canon_revision === undefined) throw new PersistenceError("revision response missing canon_revision", { code: "contract" });
    return { canon_revision: data.canon_revision };
  }

  async pullCanon() {
    const url = `${this.syncEndpoint}${this.syncEndpoint.includes("?") ? "&" : "?"}campaign=${encodeURIComponent(this.campaignId)}`;
    const data = await this.#request(url, { method: "GET", headers: this.headers() });
    return assertSyncManifest(data);
  }

  async save(packet) {
    schemas.validate("save-packet", packet);
    // A save POST is safe to retry because the backend must be idempotent by save_id.
    const data = await this.#request(this.endpoint, { method: "POST", headers: this.headers({ "idempotency-key": packet.save_id }), body: JSON.stringify(packet) });
    const result = assertSaveResult({ save_id: packet.save_id, applied: [], failed: [], ...data });
    if (result.save_id !== packet.save_id) throw new PersistenceError("save result save_id mismatch", { code: "contract" });
    return result;
  }
}
