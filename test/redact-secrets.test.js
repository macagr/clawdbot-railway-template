import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function getRedactor() {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const m = src.match(/function redactSecrets\(text\) \{([\s\S]*?)\n\}/);
  assert.ok(m, "redactSecrets not found");
  // eslint-disable-next-line no-new-func
  return new Function("return function redactSecrets(text){" + m[1] + "\n}" )();
}

test("redactSecrets redacts Discord bot tokens", () => {
  const redact = getRedactor();
  // Assemble a token-shaped sample at runtime (<base64 id>.<6>.<27+>) so no literal in this file
  // trips secret scanners / push protection.
  const id = Buffer.from("123456789012345678").toString("base64").replace(/=+$/, "");
  const fake = [id, "Ga" + "BcDe", "x".repeat(12) + "y".repeat(15)].join(".");
  const out = redact(`token: ${fake}`);
  assert.ok(!out.includes(id));
  assert.match(out, /\[REDACTED\]/);
});

test("redactSecrets redacts 64-hex gateway tokens", () => {
  const redact = getRedactor();
  const tok = "a".repeat(32) + "0123456789abcdef".repeat(2);
  const out = redact(`gateway token ${tok} ok`);
  assert.ok(!out.includes(tok));
  assert.match(out, /\[REDACTED\]/);
});

test("redactSecrets redacts generic quoted token/apiKey values but keeps keys", () => {
  const redact = getRedactor();
  const out = redact('{ "token": "SuperSecretValue123", "apiKey": "another-secret-value", "enabled": true }');
  assert.ok(!out.includes("SuperSecretValue123"));
  assert.ok(!out.includes("another-secret-value"));
  assert.match(out, /"token": "\[REDACTED\]"/);
  assert.match(out, /"enabled": true/);
});

test("redactSecrets leaves short/non-secret text alone", () => {
  const redact = getRedactor();
  assert.equal(redact("gateway.port = 18789"), "gateway.port = 18789");
  assert.equal(redact("version 2026.9.5"), "version 2026.9.5");
});

test("redactSecrets redacts Telegram bot tokens", () => {
  const redact = getRedactor();
  const s = "botToken: 123456789:AAABBBcccDDD_eee-FFF";
  const out = redact(s);
  assert.ok(!out.includes("123456789:"));
  assert.match(out, /\[REDACTED\]/);
});
