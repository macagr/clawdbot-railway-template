import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Integration test: boots the real wrapper (src/server.js) against
//  - a fake gateway HTTP/WebSocket server that records the Authorization header it receives
//  - a stub `openclaw` CLI so no OpenClaw install is required
// and checks the auth boundaries: Basic auth only on /setup, Bearer injection on proxied traffic.

const SERVER = fileURLToPath(new URL("../src/server.js", import.meta.url));
const PASSWORD = "test-password";
const TOKEN = crypto.randomBytes(32).toString("hex");
const VERSION = "2026.9.5";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeoutMs = 30_000, label = "condition" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// Stub CLI: answers the few commands the wrapper runs at boot; `gateway run` stays alive.
const STUB_CLI = `
const args = process.argv.slice(2);
const cmd = args.join(" ");
if (cmd === "--version") { console.log("openclaw ${VERSION}"); process.exit(0); }
if (args[0] === "gateway" && args[1] === "run") { setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0)); }
else if (args[0] === "plugins" && args[1] === "list") { console.log('[{"id":"discord"}]'); process.exit(0); }
else if (args[0] === "config" && args[1] === "get") { console.log('{ source: "env", id: "OPENCLAW_GATEWAY_TOKEN" }'); process.exit(0); }
else { process.exit(0); }
`;

function basic(password) {
  return "Basic " + Buffer.from(`user:${password}`).toString("base64");
}

async function startFakeGateway(port) {
  const seen = { http: [], ws: [] };
  const server = http.createServer((req, res) => {
    seen.http.push({ url: req.url, authorization: req.headers.authorization || null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "live" }));
  });
  server.on("upgrade", (req, socket) => {
    seen.ws.push({ url: req.url, authorization: req.headers.authorization || null });
    const key = req.headers["sec-websocket-key"] || "";
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.end();
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { server, seen };
}

async function startWrapper({ port, gatewayPort, stateDir, stubPath }) {
  const child = childProcess.spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      INTERNAL_GATEWAY_PORT: String(gatewayPort),
      SETUP_PASSWORD: PASSWORD,
      OPENCLAW_GATEWAY_TOKEN: TOKEN,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
      OPENCLAW_ENTRY: stubPath,
      OPENCLAW_NODE: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  // The stub gateway inherits these pipes; don't let them keep the test process alive.
  child.stdout.unref?.();
  child.stderr.unref?.();
  child.unref();
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await fetch(`${base}/setup/healthz`)).ok, { label: "wrapper healthz" });
  } catch (err) {
    throw new Error(`${err.message}\n--- wrapper log ---\n${log}`);
  }
  return { child, base, getLog: () => log };
}

function rawUpgrade(port, urlPath, extraHeaders = "") {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      sock.write(
        `GET ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
      );
    });
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("close", () => resolve(data));
    sock.on("error", reject);
    setTimeout(() => sock.destroy(), 5_000);
  });
}

test("auth boundaries: Basic auth only on /setup; Bearer gateway auth on proxied HTTP and WebSocket", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-it-"));
  const stubPath = path.join(stateDir, "stub-openclaw.mjs");
  fs.writeFileSync(stubPath, STUB_CLI);
  // Configured state whose marker matches the stub version and whose token is already a SecretRef.
  fs.writeFileSync(path.join(stateDir, ".wrapper-openclaw-version"), `${VERSION}\n`);
  fs.writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({ gateway: { auth: { mode: "token", token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } } } }),
  );

  const [port, gatewayPort] = [await freePort(), await freePort()];
  const gw = await startFakeGateway(gatewayPort);
  const wrapper = await startWrapper({ port, gatewayPort, stateDir, stubPath });
  t.after(async () => {
    // Stop the stub gateway child through the wrapper first: on Windows child.kill() is a hard
    // terminate, so the wrapper's SIGTERM handler would not get to stop its own child.
    try {
      await fetch(`${wrapper.base}/setup/api/console/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basic(PASSWORD) },
        body: JSON.stringify({ cmd: "gateway.stop" }),
      });
    } catch {}
    if (process.platform === "win32") {
      childProcess.spawnSync("taskkill", ["/pid", String(wrapper.child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      wrapper.child.kill("SIGTERM");
      await sleep(500);
      try { wrapper.child.kill("SIGKILL"); } catch {}
    }
    gw.server.close();
    await sleep(200);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const { base } = wrapper;

  await t.test("/setup requires Basic auth (401 + challenge), accepts SETUP_PASSWORD", async () => {
    const r = await fetch(`${base}/setup`);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") || "", /^Basic/);

    const bad = await fetch(`${base}/setup`, { headers: { authorization: basic("wrong") } });
    assert.equal(bad.status, 401);

    const ok = await fetch(`${base}/setup`, { headers: { authorization: basic(PASSWORD) } });
    assert.equal(ok.status, 200);
  });

  await t.test("every /setup admin route is gated, including unknown /setup paths", async () => {
    for (const p of [
      "/setup/app.js",
      "/setup/api/status",
      "/setup/api/auth-groups",
      "/setup/api/debug",
      "/setup/api/config/raw",
      "/setup/api/devices/pending",
      "/setup/export",
      "/setup/does-not-exist",
      "/setup/api/anything-new",
    ]) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 401, `${p} should be 401 without auth`);
      assert.match(r.headers.get("www-authenticate") || "", /^Basic/, `${p} should challenge`);
    }
    for (const p of ["/setup/api/run", "/setup/api/console/run", "/setup/api/reset", "/setup/import", "/setup/api/devices/approve"]) {
      const r = await fetch(`${base}${p}`, { method: "POST" });
      assert.equal(r.status, 401, `POST ${p} should be 401 without auth`);
    }
    // Unknown /setup paths never reach the gateway proxy.
    const unknown = await fetch(`${base}/setup/does-not-exist`, { headers: { authorization: basic(PASSWORD) } });
    assert.equal(unknown.status, 404);
    assert.ok(!gw.seen.http.some((h) => h.url.startsWith("/setup")), "gateway must not see /setup traffic");
  });

  await t.test("/healthz and /setup/healthz are unauthenticated", async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/setup/healthz`)).status, 200);
  });

  await t.test("Control UI proxy paths issue no Basic challenge and carry Bearer gateway auth", async () => {
    for (const p of ["/openclaw", "/", "/openclaw/assets/app.js"]) {
      const r = await fetch(`${base}${p}`);
      assert.notEqual(r.status, 401, `${p} must not require Basic auth`);
      assert.equal(r.headers.get("www-authenticate"), null, `${p} must not challenge`);
    }
    const seen = gw.seen.http.filter((h) => h.url === "/openclaw");
    assert.ok(seen.length >= 1, "gateway should have received the proxied request");
    assert.equal(seen[seen.length - 1].authorization, `Bearer ${TOKEN}`);
  });

  await t.test("a browser-replayed Basic header is replaced by the gateway Bearer token", async () => {
    const r = await fetch(`${base}/openclaw/with-basic`, { headers: { authorization: basic(PASSWORD) } });
    assert.notEqual(r.status, 401);
    const seen = gw.seen.http.find((h) => h.url === "/openclaw/with-basic");
    assert.ok(seen);
    assert.equal(seen.authorization, `Bearer ${TOKEN}`);
  });

  await t.test("a client-supplied Bearer token is passed through untouched", async () => {
    await fetch(`${base}/openclaw/own-bearer`, { headers: { authorization: "Bearer client-token" } });
    const seen = gw.seen.http.find((h) => h.url === "/openclaw/own-bearer");
    assert.equal(seen.authorization, "Bearer client-token");
  });

  await t.test("WebSocket upgrades are proxied with Bearer gateway auth (no Basic required)", async () => {
    const reply = await rawUpgrade(port, "/ws-test");
    assert.match(reply, /HTTP\/1\.1 101/);
    const seen = await waitFor(() => gw.seen.ws.find((h) => h.url === "/ws-test"), { label: "ws upgrade at gateway" });
    assert.equal(seen.authorization, `Bearer ${TOKEN}`);

    // A replayed Basic header on the upgrade is replaced too.
    await rawUpgrade(port, "/ws-basic", `Authorization: ${basic(PASSWORD)}\r\n`);
    const seen2 = await waitFor(() => gw.seen.ws.find((h) => h.url === "/ws-basic"), { label: "ws upgrade (basic) at gateway" });
    assert.equal(seen2.authorization, `Bearer ${TOKEN}`);
  });
});
