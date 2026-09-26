import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Extract PROVIDER_ENV_FOR_CHOICE + buildOnboardArgs from server.js and evaluate them with the
// closure values they depend on, so the tests exercise the real argument builder.
function getBuilder() {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const envMap = src.match(/const PROVIDER_ENV_FOR_CHOICE = \{[\s\S]*?\};/);
  const fn = src.match(/function buildOnboardArgs\(payload\) \{[\s\S]*?\n\}/);
  assert.ok(envMap, "PROVIDER_ENV_FOR_CHOICE not found");
  assert.ok(fn, "buildOnboardArgs not found");
  // eslint-disable-next-line no-new-func
  return new Function(
    "WORKSPACE_DIR",
    "INTERNAL_GATEWAY_PORT",
    "process",
    `${envMap[0]}\n${fn[0]}\nreturn buildOnboardArgs;`,
  )("/data/workspace", 18789, { env: {} });
}

test("onboard args store the gateway token as an env SecretRef, never plaintext", () => {
  const build = getBuilder();
  const args = build({ flow: "quickstart" });
  const i = args.indexOf("--gateway-token-ref-env");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], "OPENCLAW_GATEWAY_TOKEN");
  assert.ok(!args.includes("--gateway-token"));
  assert.deepEqual(args.slice(0, 2), ["onboard", "--non-interactive"]);
  assert.ok(args.includes("--gateway-bind") && args[args.indexOf("--gateway-bind") + 1] === "loopback");
});

test("onboard args: pasted API key is passed as plaintext flag", () => {
  const build = getBuilder();
  const args = build({ authChoice: "openrouter-api-key", authSecret: "sk-or-abc" });
  assert.equal(args[args.indexOf("--openrouter-api-key") + 1], "sk-or-abc");
  assert.ok(!args.includes("--secret-input-mode"));
});

test("onboard args: blank key + env var present -> env-backed SecretRef", () => {
  const build = getBuilder();
  const args = build({ authChoice: "openrouter-api-key", authSecret: "", env: { OPENROUTER_API_KEY: "sk-or-fromenv" } });
  const m = args.indexOf("--secret-input-mode");
  assert.ok(m >= 0);
  assert.equal(args[m + 1], "ref");
  // Flag receives the env var NAME, not the value.
  assert.equal(args[args.indexOf("--openrouter-api-key") + 1], "OPENROUTER_API_KEY");
  assert.ok(!args.includes("sk-or-fromenv"));
});

test("onboard args: blank key + no env var -> fails fast with a hint", () => {
  const build = getBuilder();
  assert.throws(
    () => build({ authChoice: "openrouter-api-key", authSecret: "", env: {} }),
    /Missing auth secret for authChoice=openrouter-api-key.*OPENROUTER_API_KEY/,
  );
});

test("onboard args: OAuth-style choices without a key flag are unaffected", () => {
  const build = getBuilder();
  const args = build({ authChoice: "codex-cli", authSecret: "" });
  assert.equal(args[args.indexOf("--auth-choice") + 1], "codex-cli");
  assert.ok(!args.includes("--secret-input-mode"));
});
