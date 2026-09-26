import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

test("Dockerfile uses the official prebuilt image pinned via OPENCLAW_VERSION", () => {
  assert.match(dockerfile, /\nARG OPENCLAW_VERSION=2026\.9\.5\n/);
  assert.match(dockerfile, /FROM ghcr\.io\/openclaw\/openclaw:\$\{OPENCLAW_VERSION\}/);
  assert.doesNotMatch(dockerfile, /git clone/);
  assert.doesNotMatch(dockerfile, /bun\.sh/);
  assert.doesNotMatch(dockerfile, /OPENCLAW_GIT_REF/);
});

test("Dockerfile sets runtime defaults for the wrapper", () => {
  assert.match(dockerfile, /ENV OPENCLAW_ENTRY=\/app\/openclaw\.mjs/);
  assert.match(dockerfile, /ENV OPENCLAW_NO_AUTO_UPDATE=1/);
  assert.match(dockerfile, /ENV OPENCLAW_STATE_DIR=\/data\/\.openclaw/);
  assert.match(dockerfile, /ENV OPENCLAW_WORKSPACE_DIR=\/data\/workspace/);
  assert.match(dockerfile, /WORKDIR \/wrapper/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /ENTRYPOINT \["tini", "-s", "--"\]/);
});

test("bump script parses the Dockerfile version line", () => {
  const script = fs.readFileSync(new URL("../scripts/bump-openclaw-ref.mjs", import.meta.url), "utf8");
  const re = /\nARG OPENCLAW_VERSION=([^\n]+)\n/;
  assert.match(script, /ARG OPENCLAW_VERSION=/);
  const m = dockerfile.match(re);
  assert.ok(m);
  assert.equal(m[1].trim(), "2026.9.5");
});
