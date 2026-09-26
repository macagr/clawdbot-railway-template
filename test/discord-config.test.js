import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function getBuilder() {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const m = src.match(/function buildDiscordConfig\(\{ token, envToken \}\) \{[\s\S]*?\n\}/);
  assert.ok(m, "buildDiscordConfig not found");
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\nreturn buildDiscordConfig;`)();
}

test("discord config uses the current top-level dmPolicy schema", () => {
  const cfg = getBuilder()({ token: "abc.def.ghi", envToken: false });
  assert.equal(cfg.dmPolicy, "pairing");
  assert.equal(cfg.groupPolicy, "allowlist");
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.token, "abc.def.ghi");
  assert.ok(!("dm" in cfg), "legacy dm.policy shape must not be written");
});

test("discord config omits token when DISCORD_BOT_TOKEN comes from the environment", () => {
  const cfg = getBuilder()({ token: "", envToken: true });
  assert.ok(!("token" in cfg));
  assert.equal(cfg.dmPolicy, "pairing");
});

test("discord config refuses to write an unusable channel (no token anywhere)", () => {
  assert.throws(() => getBuilder()({ token: "", envToken: false }), /DISCORD_BOT_TOKEN/);
});

test("setup writes channels.discord with strict JSON and never the legacy dm.policy", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /"--strict-json", "channels\.discord"/);
  assert.doesNotMatch(src, /dm:\s*\{\s*policy/);
});
