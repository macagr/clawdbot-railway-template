import test from "node:test";
import assert from "node:assert/strict";
import { FakeModelAdapter, ModelError, extractJson } from "../src/models/adapter.js";
import { resolveModelRef, AdapterFactory, RoleCaller, loadModelsConfig } from "../src/models/registry.js";
import { HttpModelAdapter } from "../src/models/http.js";
import { extractReplyText } from "../src/models/openclaw-cli.js";
import { recordUsage, checkBudget, BudgetError, estimateCost } from "../src/meter/usage.js";
import { tempCampaign } from "./helpers.js";

test("extractJson tolerates fences and preambles; rejects non-JSON", () => {
  assert.deepEqual(extractJson('Sure:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('prefix {"a":{"b":2}} suffix'), { a: { b: 2 } });
  assert.throws(() => extractJson("no json here"), ModelError);
});

test("model refs: aliases expand, provider prefix required, openclaw refs pass through", () => {
  const cfg = { providers: {}, aliases: { strong: { model: "openrouter/vendor/model-x", temperature: 0.4 }, again: { model: "strong" } } };
  assert.deepEqual(resolveModelRef("again", cfg), { provider: "openrouter", model: "vendor/model-x", settings: { model: "openrouter/vendor/model-x", temperature: 0.4 } });
  assert.equal(resolveModelRef("openclaw:campaign_x-director", cfg).provider, "openclaw");
  assert.throws(() => resolveModelRef("nomodel", cfg), /provider prefix/);
  const loaded = loadModelsConfig(null);
  assert.ok(loaded.providers.openrouter.api_key_env);
});

test("RoleCaller validates schema output, retries once with errors, then falls back", async () => {
  const { store, cleanup } = tempCampaign();
  try {
    const fake = new FakeModelAdapter({ responses: { novelist: ['{"nope": true}', { prose: "ok" }] } });
    const factory = new AdapterFactory({ cfg: loadModelsConfig(store.root), fake });
    const usages = [];
    const caller = new RoleCaller({ manifest: store.manifest, factory, onUsage: (u) => usages.push(u) });
    const res = await caller.call("novelist", { system: "s", user: "u", schema: "novelist-output" });
    assert.equal(res.json.prose, "ok");
    assert.equal(fake.calls.length, 2);
    assert.match(fake.calls[1].user, /previous reply was rejected/);
    assert.equal(usages.length, 2, "every call is metered, including rejected ones");
    // primary fails hard twice (json retries exhausted) -> fallback model used
    fake.enqueue("novelist", new ModelError("boom", { code: "http-500" }), { prose: "from fallback" });
    const r2 = await caller.call("novelist", { system: "s", user: "u", schema: "novelist-output" });
    assert.equal(r2.json.prose, "from fallback");
    assert.equal(fake.calls.at(-1).model, "novelist-fallback");
    // non-retryable error stops immediately
    fake.enqueue("director", new ModelError("no key", { code: "no-key", retryable: false }));
    await assert.rejects(caller.call("director", { user: "u" }), /no key/);
  } finally { cleanup(); }
});

test("openclaw agent id precedence: explicit agent_id > openclaw:<id> ref > <campaign>-<role>", async () => {
  const { agentIdFor } = await import("../src/campaign/manifest.js");
  const m = { id: "campaign_x", roles: { director: { model: "openclaw:main" }, novelist: { model: "openclaw:main", agent_id: "custom" }, editor: { model: "openrouter/v/m" } } };
  assert.equal(agentIdFor(m, "director"), "main");
  assert.equal(agentIdFor(m, "novelist"), "custom");
  assert.equal(agentIdFor(m, "editor"), "campaign_x-editor");
  assert.equal(agentIdFor(m, "npc", "openclaw:other"), "other");
});

test("HttpModelAdapter maps OpenAI-compatible responses and errors", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    if (calls.length === 1) return { ok: true, json: async () => ({ model: "m", choices: [{ message: { content: "{\"x\":1}" } }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } }) };
    return { ok: false, status: 429, text: async () => "slow down" };
  };
  const a = new HttpModelAdapter({ providerId: "p", baseUrl: "https://example.invalid/v1/", apiKeyEnv: "K", env: { K: "secret" }, fetchImpl });
  const r = await a.complete({ model: "m", system: "s", user: "u", schema: "x", temperature: 0.2, maxTokens: 50 });
  assert.equal(r.usage.cached_tokens, 4);
  assert.equal(calls[0].url, "https://example.invalid/v1/chat/completions");
  assert.equal(calls[0].body.response_format.type, "json_object");
  assert.equal(calls[0].auth, "Bearer secret");
  await assert.rejects(a.complete({ model: "m", user: "u" }), (e) => e instanceof ModelError && e.code === "http-429" && e.retryable);
  assert.throws(() => new HttpModelAdapter({ providerId: "p", baseUrl: "x", apiKeyEnv: "MISSING", env: {} }), /missing API key/);
});

test("openclaw agent JSON envelope: reply text is taken from payloads", () => {
  assert.equal(extractReplyText({ payloads: [{ text: "a" }, { text: "b" }] }), "a\nb");
  assert.equal(extractReplyText({ result: { payloads: ["c"] } }), "c");
  assert.equal(extractReplyText({ text: "d" }), "d");
});

test("usage meter: cost estimate from role prices, caps enforced, warnings below cap", () => {
  const { store, cleanup } = tempCampaign();
  try {
    let u = store.usage();
    const at = "2001-02-03T04:05:06Z";
    assert.ok(Math.abs(estimateCost(store.manifest, "director", { input_tokens: 1_000_000, output_tokens: 0 }).cost - 1) < 1e-9);
    u = recordUsage(u, store.manifest, { at, role: "director", model: "fake/d", usage: { input_tokens: 500_000, output_tokens: 100_000 }, turn: "t1" });
    assert.ok(u.totals.cost > 0.89 && u.totals.cost < 0.91);
    assert.deepEqual(checkBudget(u, store.manifest, { at, turnId: "t1" }), ["per_turn: 0.9000 of 1"]);
    u = recordUsage(u, store.manifest, { at, role: "director", model: "fake/d", usage: { input_tokens: 500_000, output_tokens: 0 }, turn: "t1" });
    assert.throws(() => checkBudget(u, store.manifest, { at, turnId: "t1" }), BudgetError);
    // reported cost from the provider wins over the estimate
    const u2 = recordUsage(store.usage(), store.manifest, { at, role: "novelist", model: "x", usage: { input_tokens: 1, output_tokens: 1 }, cost_reported: 0.42 });
    assert.equal(u2.totals.cost, 0.42);
    assert.equal(u2.calls[0].estimated, false);
  } finally { cleanup(); }
});
