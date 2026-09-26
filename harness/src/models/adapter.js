// Model adapter contract and the deterministic FakeModelAdapter used by tests.
//
// adapter.complete({ role, model, system, user, schema, temperature, maxTokens, timeoutMs, sessionKey })
//   -> { text, json?, usage: { input_tokens, output_tokens, cached_tokens? }, model, provider }
// Adapters throw ModelError on transport/provider failure. Schema validation of JSON output is
// done by the caller (RoleCaller), so adapters only need to return text (and parsed json if easy).
export class ModelError extends Error {
  constructor(message, { code = "model", retryable = true, cause } = {}) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

/**
 * FakeModelAdapter: scripted, deterministic. Responses are looked up by role, in order.
 * A response may be: a string, an object (serialized as JSON), a function(req) -> string|object,
 * or an Error instance (thrown). When the queue for a role is exhausted, `fallback(role, req)`
 * is used, so tests can script "director returns X, then fails, then Y".
 */
export class FakeModelAdapter {
  constructor({ responses = {}, fallback = defaultFallback, tokensPerChar = 0.25 } = {}) {
    this.queues = Object.fromEntries(Object.entries(responses).map(([k, v]) => [k, [...v]]));
    this.fallback = fallback;
    this.tokensPerChar = tokensPerChar;
    this.calls = [];
  }

  enqueue(role, ...responses) {
    (this.queues[role] ||= []).push(...responses);
  }

  async complete(req) {
    const q = this.queues[req.role] || [];
    let r = q.length ? q.shift() : this.fallback(req.role, req);
    this.calls.push({ role: req.role, model: req.model, system: req.system, user: req.user, sessionKey: req.sessionKey });
    if (typeof r === "function") r = r(req);
    if (r instanceof Error) throw r;
    const text = typeof r === "string" ? r : JSON.stringify(r);
    const input = Math.ceil(((req.system || "").length + (req.user || "").length) * this.tokensPerChar);
    const output = Math.ceil(text.length * this.tokensPerChar);
    return { text, json: typeof r === "object" ? r : undefined, usage: { input_tokens: input, output_tokens: output }, model: req.model, provider: "fake" };
  }
}

function defaultFallback(role) {
  throw new ModelError(`FakeModelAdapter: no scripted response left for role '${role}'`, { code: "fake-exhausted", retryable: false });
}

/** Extract the first JSON object from model text (tolerates code fences and preambles). */
export function extractJson(text) {
  if (typeof text !== "string") throw new ModelError("model returned non-text", { code: "bad-json", retryable: true });
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ModelError("no JSON object in model output", { code: "bad-json", retryable: true });
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    throw new ModelError(`invalid JSON from model: ${err.message}`, { code: "bad-json", retryable: true });
  }
}
