import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Migrate deprecated CLAWDBOT_* env vars → OPENCLAW_* so existing Railway deployments
// keep working. Users should update their Railway Variables to use the new names.
for (const suffix of ["PUBLIC_PORT", "STATE_DIR", "WORKSPACE_DIR", "GATEWAY_TOKEN", "CONFIG_PATH"]) {
  const oldKey = `CLAWDBOT_${suffix}`;
  const newKey = `OPENCLAW_${suffix}`;
  if (process.env[oldKey] && !process.env[newKey]) {
    process.env[newKey] = process.env[oldKey];
    // Best-effort compatibility shim for old Railway templates.
    // Intentionally no warning: Railway templates can still set legacy keys and warnings are noisy.
  }
  // Avoid forwarding legacy variables into OpenClaw subprocesses.
  // OpenClaw logs a warning when deprecated CLAWDBOT_* variables are present.
  delete process.env[oldKey];
}

// Railway injects PORT at runtime and routes traffic to that port.
// Do not force a different public port in the container image, or the service may
// boot but the Railway domain will be routed to a different port.
//
// OPENCLAW_PUBLIC_PORT is kept as an escape hatch for non-Railway deployments.
const PORT = Number.parseInt(process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000", 10);

// State/workspace
// OpenClaw defaults to ~/.openclaw.
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Run the CLI entry directly to avoid PATH/global-install mismatches.
// The official image ships the launcher at /app/openclaw.mjs (it also enforces the Node version).
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/app/openclaw.mjs";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

// Bind address for the wrapper. Railway private networking is IPv6-only on legacy environments,
// so bind dual-stack ("::") by default; override with HOST for other platforms.
const HOST = process.env.HOST?.trim() || "::";

// Externally reachable HTTPS origin (e.g. the Cloudflare hostname). Written to gateway.publicOrigin so
// the Control UI websocket passes the gateway's Origin check when served behind the proxy.
const PUBLIC_ORIGIN = process.env.OPENCLAW_PUBLIC_ORIGIN?.trim() || "";

// SecretRef pointing at the gateway token env var. Stored in config instead of the plaintext token.
const GATEWAY_TOKEN_REF = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" };

// Migration gate: the wrapper records which OpenClaw version last ran against this state dir.
// When the image version changes, the operator must run `openclaw doctor --fix` (after a backup)
// before the gateway starts. Set OPENCLAW_MIGRATION_GATE=off to disable.
const MIGRATION_GATE_ENABLED = (process.env.OPENCLAW_MIGRATION_GATE ?? "on").trim().toLowerCase() !== "off";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function resolveConfigCandidates() {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return [explicit];

  return [path.join(STATE_DIR, "openclaw.json")];
}

function configPath() {
  const candidates = resolveConfigCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  // Default to canonical even if it doesn't exist yet.
  return candidates[0] || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured() {
  try {
    return resolveConfigCandidates().some((candidate) => fs.existsSync(candidate));
  } catch {
    return false;
  }
}

// One-time migration: rename legacy config files to openclaw.json so existing
// deployments that still have the old filename on their volume keep working.
(function migrateLegacyConfigFile() {
  // If the operator explicitly chose a config path, do not rename files in STATE_DIR.
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return;

  const canonical = path.join(STATE_DIR, "openclaw.json");
  if (fs.existsSync(canonical)) return;

  for (const legacy of ["clawdbot.json", "moltbot.json"]) {
    const legacyPath = path.join(STATE_DIR, legacy);
    try {
      if (fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, canonical);
        console.log(`[migration] Renamed ${legacy} → openclaw.json`);
        return;
      }
    } catch (err) {
      console.warn(`[migration] Failed to rename ${legacy}: ${err}`);
    }
  }
})();

let gatewayProc = null;
let gatewayStarting = null;

// Debug breadcrumbs for common Railway failures (502 / "Application failed to respond").
let lastGatewayError = null;
let lastGatewayExit = null;
let lastDoctorOutput = null;
let lastDoctorAt = null;

// Migration gate state: null when no migration is pending, otherwise { from, to }.
let migrationRequired = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Version marker / migration gate ---

function versionMarkerPath() {
  return path.join(STATE_DIR, ".wrapper-openclaw-version");
}

function parseOpenclawVersion(text) {
  const m = String(text || "").match(/\d{4}\.\d+\.\d+(?:-[A-Za-z0-9.]+)?/);
  return m ? m[0] : null;
}

async function detectOpenclawVersion() {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]), { timeoutMs: 30_000 });
  return parseOpenclawVersion(r.output);
}

function readVersionMarker() {
  try {
    return fs.readFileSync(versionMarkerPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeVersionMarker(version) {
  if (!version) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(versionMarkerPath(), `${version}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(`[wrapper] failed to write version marker: ${String(err)}`);
  }
}

// Files/dirs the wrapper itself creates on a fresh volume. They do not indicate an existing install.
const WRAPPER_OWNED_STATE_ENTRIES = new Set([".wrapper-openclaw-version", "gateway.token", "logs"]);

// True when the state dir holds OpenClaw state from a previous run: a config file (or its
// backups), credentials, databases, sessions, agents, auth profiles, etc. An empty dir, or one
// that only contains wrapper-owned files and empty directories, is a fresh install.
function hasMeaningfulState(stateDir) {
  let entries;
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (WRAPPER_OWNED_STATE_ENTRIES.has(e.name)) continue;
    if (e.isDirectory()) {
      // Empty directories (e.g. `credentials/` pre-created by the wrapper) do not count.
      try {
        if (fs.readdirSync(path.join(stateDir, e.name)).length > 0) return true;
      } catch {
        // unreadable: treat as meaningful, the safe direction
        return true;
      }
      continue;
    }
    // Any other file (openclaw.json, *.bak-*, *.db, .env, auth-profiles.json, ...) is real state.
    return true;
  }
  return false;
}

// Pure decision for the migration gate.
//   "fresh"   -> no marker and no existing state: initialize the marker, no migration
//   "ok"      -> marker matches the running version
//   "migrate" -> existing state without marker, or marker differs from the running version
function decideMigration({ current, recorded, hasState }) {
  if (recorded && recorded === current) return "ok";
  if (!recorded && !hasState) return "fresh";
  return "migrate";
}

// Decide whether the persisted state must be migrated before the gateway may start.
// Only mutates state in the "fresh" case (writes the version marker on an otherwise empty dir).
async function checkMigrationGate() {
  if (!MIGRATION_GATE_ENABLED) {
    migrationRequired = null;
    return migrationRequired;
  }
  const current = await detectOpenclawVersion();
  if (!current) {
    // Can't tell; don't block, but leave a breadcrumb.
    console.warn("[wrapper] could not detect openclaw version; migration gate skipped");
    migrationRequired = null;
    return migrationRequired;
  }
  const recorded = readVersionMarker();
  const hasState = hasMeaningfulState(STATE_DIR);
  const decision = decideMigration({ current, recorded, hasState });

  if (decision === "ok") {
    migrationRequired = null;
  } else if (decision === "fresh") {
    console.log(`[wrapper] fresh state dir; recording openclaw ${current} as the baseline version`);
    writeVersionMarker(current);
    migrationRequired = null;
  } else {
    migrationRequired = {
      from: recorded || "unknown (existing state without a version marker, e.g. 2026.3.8)",
      to: current,
    };
  }
  return migrationRequired;
}

function migrationInstructions() {
  if (!migrationRequired) return "";
  return [
    `OpenClaw version changed: ${migrationRequired.from} -> ${migrationRequired.to}.`,
    "The gateway will not start until the persisted state has been migrated.",
    "Steps:",
    "  1. Download a backup from /setup (or snapshot the Railway volume).",
    "  2. In /setup -> Debug console run `openclaw doctor --fix` (command: openclaw.doctor.fix).",
    "  3. On success the wrapper records the version and starts the gateway.",
    "If you already ran doctor yourself, use `migration.acknowledge` instead.",
    "To roll back instead: redeploy the previous image AND restore the pre-upgrade backup.",
  ].join("\n");
}

// Run the operator-requested migration. Only called from an authenticated /setup action.
async function runMigrationDoctorFix() {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix", "--non-interactive"]), {
    timeoutMs: 10 * 60 * 1000,
  });
  const output = redactSecrets(r.output || "");
  lastDoctorOutput = output;
  lastDoctorAt = Date.now();
  if (r.code !== 0) {
    return { ok: false, output: `doctor --fix exited with code ${r.code}. Gateway remains stopped.\n${output}` };
  }
  return { ok: true, output };
}

async function completeMigration() {
  const current = await detectOpenclawVersion();
  writeVersionMarker(current);
  migrationRequired = null;
  await syncGatewayConfig();
}

// --- Gateway readiness ---

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // The gateway serves an unauthenticated liveness probe.
      const res = await fetch(`${GATEWAY_TARGET}/healthz`, { method: "GET" });
      if (res.ok) return true;
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");
  if (migrationRequired) throw new Error(`Gateway cannot start: migration required\n${migrationInstructions()}`);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    const msg = `[gateway] spawn error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    const msg = `[gateway] exited code=${code} signal=${signal}`;
    console.error(msg);
    lastGatewayExit = { code, signal, at: new Date().toISOString() };
    gatewayProc = null;
  });
}

async function runDoctorBestEffort() {
  // Avoid spamming `openclaw doctor` in a crash loop.
  const now = Date.now();
  if (lastDoctorAt && now - lastDoctorAt < 5 * 60 * 1000) return;
  lastDoctorAt = now;

  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
    const out = redactSecrets(r.output || "");
    lastDoctorOutput = out.length > 50_000 ? out.slice(0, 50_000) + "\n... (truncated)\n" : out;
  } catch (err) {
    lastDoctorOutput = `doctor failed: ${String(err)}`;
  }
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (migrationRequired) return { ok: false, reason: `migration required\n${migrationInstructions()}` };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
        if (!ready) {
          throw new Error("Gateway did not become ready in time");
        }
      } catch (err) {
        const msg = `[gateway] start failure: ${String(err)}`;
        lastGatewayError = msg;
        // Collect extra diagnostics to help users file issues.
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

// Stop the gateway and wait for it to actually exit (so SQLite closes and the port is released).
// Escalates to SIGKILL after timeoutMs.
async function stopGateway(timeoutMs = 8_000) {
  const proc = gatewayProc;
  if (!proc) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve();
    };
    const killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      // Give the kill a moment to be observed, then move on regardless.
      setTimeout(finish, 500);
    }, timeoutMs);
    proc.once("exit", finish);
    if (proc.exitCode !== null || proc.signalCode !== null) return finish();
    try {
      proc.kill("SIGTERM");
    } catch {
      finish();
    }
  });
  if (gatewayProc === proc) gatewayProc = null;
}

async function restartGateway() {
  await stopGateway();
  return ensureGatewayRunning();
}

// Write proxy/auth settings into the OpenClaw config.
// - gateway.auth.token is stored as an env SecretRef (never the plaintext token).
// - gateway.remote.token is removed; the CLI reads OPENCLAW_GATEWAY_TOKEN from the environment.
// - gateway.publicOrigin is set when OPENCLAW_PUBLIC_ORIGIN is provided.
// Called after onboarding, after migration, and at boot only when the token is still plaintext.
async function syncGatewayConfig() {
  const set = (args) => runCmd(OPENCLAW_NODE, clawArgs(["config", "set", ...args]));
  await set(["gateway.auth.mode", "token"]);
  await set(["--strict-json", "gateway.auth.token", JSON.stringify(GATEWAY_TOKEN_REF)]);
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "unset", "gateway.remote.token"]));
  await set(["gateway.bind", "loopback"]);
  await set(["gateway.port", String(INTERNAL_GATEWAY_PORT)]);
  // Railway runs behind a reverse proxy (this wrapper). Trust loopback as a proxy hop so
  // forwarded-client detection stays correct when X-Forwarded-* headers are present.
  await set(["--strict-json", "gateway.trustedProxies", JSON.stringify(["127.0.0.1"])]);
  if (PUBLIC_ORIGIN) {
    await set(["gateway.publicOrigin", PUBLIC_ORIGIN]);
  }
}

// True when gateway.auth.token already references the env var (no plaintext token in config).
// Reads the config file directly (JSON5, keys may be unquoted) and falls back to the CLI.
async function gatewayTokenIsRef() {
  try {
    const text = fs.readFileSync(configPath(), "utf8");
    if (/id["']?\s*:\s*["']OPENCLAW_GATEWAY_TOKEN["']/.test(text)) return true;
  } catch {
    // fall through to CLI
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "gateway.auth.token"]));
  return r.code === 0 && /OPENCLAW_GATEWAY_TOKEN/.test(r.output || "");
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

async function probeGateway() {
  // Don't assume HTTP — the gateway primarily speaks WebSocket.
  // A simple TCP connect check is enough for "is it up".
  const net = await import("node:net");

  return await new Promise((resolve) => {
    const sock = net.createConnection({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      timeout: 750,
    });

    const done = (ok) => {
      try { sock.destroy(); } catch {}
      resolve(ok);
    };

    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

// Public health endpoint (no auth) so Railway can probe without /setup.
// Keep this free of secrets.
app.get("/healthz", async (_req, res) => {
  let gatewayReachable = false;
  if (isConfigured()) {
    try {
      gatewayReachable = await probeGateway();
    } catch {
      gatewayReachable = false;
    }
  }

  res.json({
    ok: true,
    wrapper: {
      configured: isConfigured(),
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      migrationRequired: migrationRequired ? { from: migrationRequired.from, to: migrationRequired.to } : null,
    },
    gateway: {
      target: GATEWAY_TARGET,
      reachable: gatewayReachable,
      lastError: lastGatewayError,
      lastExit: lastGatewayExit,
      lastDoctorAt,
    },
  });
});

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // No inline <script>: serve JS from /setup/app.js to avoid any encoding/template-literal issues.
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>OpenClaw Setup</h1>
  <p class="muted">This wizard configures OpenClaw by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div id="migration" class="card" style="display:none; border-color:#b45309; background:#fffbeb">
    <h2>Migration required</h2>
    <pre id="migrationText" style="white-space:pre-wrap"></pre>
    <button id="migrationDoctor" style="background:#b45309">Run openclaw doctor --fix (back up first)</button>
    <button id="migrationAck" style="background:#444; margin-left:0.5rem">Mark migration done (I already ran doctor)</button>
    <pre id="migrationOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div id="statusDetails" class="muted" style="margin-top:0.5rem"></div>
    <div style="margin-top: 0.75rem">
      <a href="/openclaw" target="_blank">Open OpenClaw UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>
    <div class="muted" style="margin-top:0.5rem">
      <strong>Backups contain secrets.</strong> The archive includes <code>openclaw.json</code>, credentials, auth profiles and sessions
      (provider keys, channel tokens, the gateway token if stored in config). It is not encrypted. Store it accordingly.
    </div>

    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong> (advanced): restores into <code>/data</code> and restarts the gateway.</div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>

  <div class="card">
    <h2>Debug console</h2>
    <p class="muted">Run a small allowlist of safe commands (no shell). Useful for debugging and recovery.</p>

    <div style="display:flex; gap:0.5rem; align-items:center">
      <select id="consoleCmd" style="flex: 1">
        <option value="gateway.restart">gateway.restart (wrapper-managed)</option>
        <option value="gateway.stop">gateway.stop (wrapper-managed)</option>
        <option value="gateway.start">gateway.start (wrapper-managed)</option>
        <option value="openclaw.status">openclaw status</option>
        <option value="openclaw.health">openclaw health</option>
        <option value="openclaw.doctor">openclaw doctor</option>
        <option value="openclaw.doctor.fix">openclaw doctor --fix (migration/repair; back up first)</option>
        <option value="migration.acknowledge">migration.acknowledge (record current version as migrated)</option>
        <option value="openclaw.logs.tail">openclaw logs --limit N</option>
        <option value="openclaw.config.get">openclaw config get &lt;path&gt;</option>
        <option value="openclaw.version">openclaw --version</option>
        <option value="openclaw.devices.list">openclaw devices list</option>
        <option value="openclaw.devices.approve">openclaw devices approve &lt;requestId&gt;</option>
        <option value="openclaw.plugins.list">openclaw plugins list</option>
        <option value="openclaw.plugins.enable">openclaw plugins enable &lt;name&gt;</option>
      </select>
      <input id="consoleArg" placeholder="Optional arg (e.g. 200, gateway.port)" style="flex: 1" />
      <button id="consoleRun" style="background:#0f172a">Run</button>
    </div>
    <pre id="consoleOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Config editor (advanced)</h2>
    <p class="muted">Edits the full config file on disk (JSON5). Saving creates a timestamped <code>.bak-*</code> backup and restarts the gateway.</p>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup">
      <option>Loading providers…</option>
    </select>

    <label>Auth method</label>
    <select id="authChoice">
      <option>Loading methods…</option>
    </select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />
    <div class="muted" style="margin-top: 0.25rem">
      Leave blank to use the provider's env var from Railway (e.g. <code>OPENROUTER_API_KEY</code>). The config then stores an
      env reference instead of the key.
    </div>

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside OpenClaw, but this helps you get messaging working immediately.</p>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token (leave blank if DISCORD_BOT_TOKEN is set in Railway)" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      Prefer setting <code>DISCORD_BOT_TOKEN</code> as a Railway variable and leaving this blank; the token then never lands in the config file.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Telegram bot token (optional; not bundled in OpenClaw 2026.9.5)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Telegram is no longer a bundled plugin in this OpenClaw version. Unless a Telegram plugin is installed, this field is skipped.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>2b) Advanced: Custom OpenAI-compatible provider (optional)</h2>
    <p class="muted">Use this to configure an OpenAI-compatible API that requires a custom base URL (e.g. Ollama, vLLM, LM Studio, hosted proxies). You usually set the API key as a Railway variable and reference it here.</p>

    <label>Provider id (e.g. ollama, deepseek, myproxy)</label>
    <input id="customProviderId" placeholder="ollama" />

    <label>Base URL (must include /v1, e.g. http://host:11434/v1)</label>
    <input id="customProviderBaseUrl" placeholder="http://127.0.0.1:11434/v1" />

    <label>API (openai-completions or openai-responses)</label>
    <select id="customProviderApi">
      <option value="openai-completions">openai-completions</option>
      <option value="openai-responses">openai-responses</option>
    </select>

    <label>API key env var name (optional, e.g. OLLAMA_API_KEY). Leave blank for no key.</label>
    <input id="customProviderApiKeyEnv" placeholder="OLLAMA_API_KEY" />

    <label>Optional model id to register (e.g. llama3.1:8b)</label>
    <input id="customProviderModelId" placeholder="" />
  </div>

  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">Reset deletes the OpenClaw config file so you can rerun onboarding. Pairing approval lets you grant DM access when dmPolicy=pairing.</p>

    <details style="margin-top: 0.75rem">
      <summary><strong>Pairing helper</strong> (for “disconnected (1008): pairing required”)</summary>
      <p class="muted">This lists pending device requests and lets you approve them without SSH.</p>
      <button id="devicesRefresh" style="background:#0f172a">Refresh pending devices</button>
      <div id="devicesList" class="muted" style="margin-top:0.5rem"></div>
    </details>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`);
});

const AUTH_GROUPS = [
  { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
    { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
    { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
    { value: "openai-api-key", label: "OpenAI API key" }
  ]},
  { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
    { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
    { value: "token", label: "Anthropic token (paste setup-token)" },
    { value: "apiKey", label: "Anthropic API key" }
  ]},
  { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
    { value: "gemini-api-key", label: "Google Gemini API key" },
    { value: "google-antigravity", label: "Google Antigravity OAuth" },
    { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
  ]},
  { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
    { value: "openrouter-api-key", label: "OpenRouter API key" }
  ]},
  { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
    { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
  ]},
  { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
    { value: "moonshot-api-key", label: "Moonshot AI API key" },
    { value: "kimi-code-api-key", label: "Kimi Code API key" }
  ]},
  { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
    { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
  ]},
  { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
    { value: "minimax-api", label: "MiniMax M2.1" },
    { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
  ]},
  { value: "qwen", label: "Qwen", hint: "OAuth", options: [
    { value: "qwen-portal", label: "Qwen OAuth" }
  ]},
  { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
    { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
    { value: "copilot-proxy", label: "Copilot Proxy (local)" }
  ]},
  { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
    { value: "synthetic-api-key", label: "Synthetic API key" }
  ]},
  { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
    { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
  ]}
];

// Which channel plugins are available in this OpenClaw build.
// `channels add --help` no longer lists channels, so ask the plugin registry.
// On failure, report everything as available and let the config/doctor step surface problems.
async function detectChannelPlugins() {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list", "--json"]));
  const out = r.output || "";
  const probeFailed = r.code !== 0 || !out.trim();
  const has = (name) => probeFailed || new RegExp(`"${name}"`).test(out);
  return {
    probeFailed,
    discord: has("discord"),
    telegram: has("telegram"),
    slack: has("slack"),
  };
}

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channels = await detectChannelPlugins();

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channels,
    migration: migrationRequired ? { required: true, ...migrationRequired, instructions: migrationInstructions() } : { required: false },
    envDetected: {
      openrouter: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
      discord: Boolean(process.env.DISCORD_BOT_TOKEN?.trim()),
      publicOrigin: PUBLIC_ORIGIN || null,
    },
    authGroups: AUTH_GROUPS,
  });
});

app.get("/setup/api/auth-groups", requireSetupAuth, (_req, res) => {
  res.json({ ok: true, authGroups: AUTH_GROUPS });
});

// Standard provider env vars OpenClaw honors for each API-key auth choice.
// When the form secret is blank and the env var is set, onboarding uses an env SecretRef.
const PROVIDER_ENV_FOR_CHOICE = {
  "openrouter-api-key": "OPENROUTER_API_KEY",
  "openai-api-key": "OPENAI_API_KEY",
  "apiKey": "ANTHROPIC_API_KEY",
  "gemini-api-key": "GEMINI_API_KEY",
  "moonshot-api-key": "MOONSHOT_API_KEY",
  "zai-api-key": "ZAI_API_KEY",
};

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    // Store the gateway token as an env SecretRef, not plaintext. The env var is always set
    // (resolveGatewayToken() exports it before any subprocess runs).
    "--gateway-token-ref-env",
    "OPENCLAW_GATEWAY_TOKEN",
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };

    const flag = map[payload.authChoice];
    const envName = PROVIDER_ENV_FOR_CHOICE[payload.authChoice];
    const envValue = envName ? (payload.env ?? process.env)[envName]?.trim() : "";

    if (flag && !secret && envValue) {
      // Env-backed credential: onboarding stores keyRef {source:"env", id:<envName>}; the key
      // itself never enters the config or auth-profile store.
      args.push("--secret-input-mode", "ref", flag, envName);
    } else if (flag && !secret) {
      // If the user picked an API-key auth choice but didn't provide a secret, fail fast.
      // Otherwise OpenClaw may fall back to its default auth choice, which looks like the
      // wizard "reverted" their selection.
      const hint = envName ? ` (paste a key, or set ${envName} in Railway Variables)` : "";
      throw new Error(`Missing auth secret for authChoice=${payload.authChoice}${hint}`);
    } else if (flag) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token") {
      // This is the Anthropic setup-token flow.
      if (!secret) throw new Error("Missing auth secret for authChoice=token");
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120_000;

    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    let killTimer;
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2_000);
      out += `\n[timeout] Command exceeded ${timeoutMs}ms and was terminated.\n`;
      resolve({ code: 124, output: out });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    const respondJson = (status, body) => {
      if (res.writableEnded || res.headersSent) return;
      res.status(status).json(body);
    };
    if (migrationRequired) {
      // Existing state from another OpenClaw version: onboarding must not run on top of it.
      return respondJson(409, { ok: false, output: `Setup blocked: migration required.\n${migrationInstructions()}\n` });
    }
    if (isConfigured()) {
      await ensureGatewayRunning();
      return respondJson(200, {
        ok: true,
        output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};

    let onboardArgs;
    try {
      onboardArgs = buildOnboardArgs(payload);
    } catch (err) {
      return respondJson(400, { ok: false, output: `Setup input error: ${String(err)}` });
    }

    const prefix = "[setup] running openclaw onboard...\n";
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional setup (only after successful onboarding).
  if (ok) {
    // Fresh state created by this OpenClaw version: record it so the migration gate stays quiet.
    writeVersionMarker(await detectOpenclawVersion());
    migrationRequired = null;

    // Gateway auth (env SecretRef), loopback bind, trusted proxy, public origin.
    await syncGatewayConfig();

    // Optional: configure a custom OpenAI-compatible provider (base URL) for advanced users.
    if (payload.customProviderId?.trim() && payload.customProviderBaseUrl?.trim()) {
      const providerId = payload.customProviderId.trim();
      const baseUrl = payload.customProviderBaseUrl.trim();
      const api = (payload.customProviderApi || "openai-completions").trim();
      const apiKeyEnv = (payload.customProviderApiKeyEnv || "").trim();
      const modelId = (payload.customProviderModelId || "").trim();

      if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
        extra += `\n[custom provider] skipped: invalid provider id (use letters/numbers/_/-)`;
      } else if (!/^https?:\/\//.test(baseUrl)) {
        extra += `\n[custom provider] skipped: baseUrl must start with http(s)://`;
      } else if (api !== "openai-completions" && api !== "openai-responses") {
        extra += `\n[custom provider] skipped: api must be openai-completions or openai-responses`;
      } else if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        extra += `\n[custom provider] skipped: invalid api key env var name`;
      } else {
        const providerCfg = {
          baseUrl,
          api,
          apiKey: apiKeyEnv ? "${" + apiKeyEnv + "}" : undefined,
          models: modelId ? [{ id: modelId, name: modelId }] : undefined,
        };

        // Ensure we merge in this provider rather than replacing other providers.
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", `models.providers.${providerId}`, JSON.stringify(providerCfg)]),
        );
        extra += `\n[custom provider] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
      }
    }

    const channels = await detectChannelPlugins();
    const supports = (name) => Boolean(channels[name]);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (telegram plugin is not installed in this openclaw build; it is no longer bundled)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));

        // Best-effort: enable the telegram plugin explicitly (some builds require this even when configured).
        const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));

        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${redactSecrets(set.output) || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${redactSecrets(get.output) || "(no output)"}`;
        extra += `\n[telegram plugin enable] exit=${plug.code} (output ${plug.output.length} chars)\n${redactSecrets(plug.output) || "(no output)"}`;
      }
    }

    const discordFormToken = payload.discordToken?.trim() || "";
    const discordEnvToken = Boolean(process.env.DISCORD_BOT_TOKEN?.trim());
    if (discordFormToken || discordEnvToken) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (discord plugin not found in `openclaw plugins list`)\n";
      } else {
        // Current schema: top-level dmPolicy/groupPolicy. When DISCORD_BOT_TOKEN is set in the
        // environment, omit `token` entirely; the plugin reads the env var for the default account.
        const cfgObj = buildDiscordConfig({ token: discordFormToken, envToken: discordEnvToken });
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--strict-json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        const source = discordFormToken ? "token from form" : "token from DISCORD_BOT_TOKEN env";
        extra += `\n[discord config] (${source}) exit=${set.code} (output ${set.output.length} chars)\n${redactSecrets(set.output) || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${redactSecrets(get.output) || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${redactSecrets(set.output) || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${redactSecrets(get.output) || "(no output)"}`;
      }
    }

    // Apply changes immediately.
    await restartGateway();

    // Ensure OpenClaw applies any "configured but not enabled" channel/plugin changes.
    // This makes Telegram/Discord pairing issues much less "silent". Fresh state only (just onboarded).
    const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix", "--non-interactive"]));
    extra += `\n[doctor --fix] exit=${fix.code} (output ${fix.output.length} chars)\n${redactSecrets(fix.output) || "(no output)"}`;

    // Doctor may require a restart depending on changes.
    await restartGateway();
  }

  return respondJson(ok ? 200 : 500, {
    ok,
    output: `${prefix}${redactSecrets(onboard.output)}${extra}`,
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return respondJson(500, { ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channels = await detectChannelPlugins();

  // Channel config checks (redact secrets before returning to client)
  const tg = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
  const dc = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));

  const tgOut = redactSecrets(tg.output || "");
  const dcOut = redactSecrets(dc.output || "");

  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      publicPortEnv: process.env.PORT || null,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configured: isConfigured(),
      configPathResolved: configPath(),
      configPathCandidates: typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : null,
      internalGatewayHost: INTERNAL_GATEWAY_HOST,
      internalGatewayPort: INTERNAL_GATEWAY_PORT,
      gatewayTarget: GATEWAY_TARGET,
      gatewayRunning: Boolean(gatewayProc),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      publicOrigin: PUBLIC_ORIGIN || null,
      listenHost: HOST,
      migrationGateEnabled: MIGRATION_GATE_ENABLED,
      migrationRequired,
      versionMarker: readVersionMarker(),
      lastGatewayError,
      lastGatewayExit,
      lastDoctorAt,
      lastDoctorOutput,
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelPlugins: channels,
      channels: {
        telegram: {
          exit: tg.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(tg.output || "") || /enabled\s*[:=]\s*true/.test(tg.output || ""),
          botTokenPresent: /(\d{5,}:[A-Za-z0-9_-]{10,})/.test(tg.output || ""),
          output: tgOut,
        },
        discord: {
          exit: dc.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(dc.output || "") || /enabled\s*[:=]\s*true/.test(dc.output || ""),
          tokenPresent: /"token"\s*:\s*"?\S+"?/.test(dc.output || "") || /token\s*[:=]\s*\S+/.test(dc.output || ""),
          output: dcOut,
        },
      },
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  // Best-effort redaction of well-known secret shapes. (Config paths/values may still contain secrets.)
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    // Discord bot tokens: <base64 id>.<6 chars>.<27+ chars>
    .replace(/\b([A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})\b/g, "[REDACTED]")
    // Telegram bot tokens look like: 123456:ABCDEF...
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]")
    // Wrapper-generated gateway tokens are 32 random bytes as hex.
    .replace(/\b[a-f0-9]{64}\b/g, "[REDACTED]")
    // Generic quoted secret-bearing keys in JSON/JSON5 output: "token": "..." etc.
    .replace(/(["']?(?:token|botToken|appToken|apiKey|api_key|password|secret)["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi, "$1[REDACTED]$3");
}

// Build the channels.discord config object for the current schema.
// - dmPolicy/groupPolicy are top-level (the old nested dm.policy shape is legacy).
// - When the token comes from DISCORD_BOT_TOKEN, omit `token` so the config never holds it.
function buildDiscordConfig({ token, envToken }) {
  const cfg = {
    enabled: true,
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
  };
  if (token) cfg.token = token;
  else if (!envToken) throw new Error("Discord: no token provided and DISCORD_BOT_TOKEN is not set");
  return cfg;
}

function extractDeviceRequestIds(text) {
  const s = String(text || "");
  const out = new Set();

  for (const m of s.matchAll(/requestId\s*(?:=|:)\s*([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/"requestId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g)) out.add(m[1]);

  return Array.from(out);
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.doctor.fix",
  "migration.acknowledge",
  "openclaw.logs.tail",
  "openclaw.config.get",

  // Device management (for fixing "disconnected (1008): pairing required")
  "openclaw.devices.list",
  "openclaw.devices.approve",

  // Plugin management
  "openclaw.plugins.list",
  "openclaw.plugins.enable",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      await stopGateway();
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor.fix") {
      // Operator-run migration/repair. Mutates persistent state; the UI tells users to back up first.
      await stopGateway();
      const r = await runMigrationDoctorFix();
      if (!r.ok) return res.status(500).json({ ok: false, output: r.output });
      await completeMigration();
      let started = "";
      try {
        await ensureGatewayRunning();
        started = "\nMigration recorded; gateway started.\n";
      } catch (err) {
        started = `\nMigration recorded, but the gateway failed to start: ${String(err)}\n`;
      }
      return res.json({ ok: true, output: `${r.output}${started}` });
    }
    if (cmd === "migration.acknowledge") {
      if (!migrationRequired) {
        return res.json({ ok: true, output: "No migration pending.\n" });
      }
      await completeMigration();
      const started = await ensureGatewayRunning().then(() => "gateway started", (e) => `gateway failed to start: ${String(e)}`);
      return res.json({ ok: true, output: `Recorded current OpenClaw version as migrated; ${started}.\n` });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--limit", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Device management commands (for fixing "disconnected (1008): pairing required")
    if (cmd === "openclaw.devices.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.devices.approve") {
      const requestId = String(arg || "").trim();
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "Missing device request ID" });
      }
      if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
        return res.status(400).json({ ok: false, error: "Invalid device request ID" });
      }
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Plugin management commands
    if (cmd === "openclaw.plugins.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.plugins.enable") {
      const name = String(arg || "").trim();
      if (!name) return res.status(400).json({ ok: false, error: "Missing plugin name" });
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return res.status(400).json({ ok: false, error: "Invalid plugin name" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", name]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

// Device pairing helper (list + approve) to avoid needing SSH.
app.get("/setup/api/devices/pending", requireSetupAuth, async (_req, res) => {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
  const output = redactSecrets(r.output);
  const requestIds = extractDeviceRequestIds(output);
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, requestIds, output });
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const requestId = String((req.body && req.body.requestId) || "").trim();
  if (!requestId) return res.status(400).json({ ok: false, error: "Missing device request ID" });
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) return res.status(400).json({ ok: false, error: "Invalid device request ID" });
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Reset: stop gateway (frees memory) + delete config file(s) so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    // Stop gateway to avoid running gateway + onboard concurrently on small Railway instances.
    try {
      await stopGateway();
    } catch {
      // ignore
    }

    const candidates = typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : [configPath()];
    for (const p of candidates) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }

    res.type("text/plain").send("OK - stopped gateway and deleted config file(s). You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  // NOTE: the archive contains secrets (openclaw.json, credentials/, auth profiles, sessions).
  // Log files are excluded; they are large and not needed for restore.
  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
      filter: (p) => !isExcludedFromBackup(p),
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

// Paths (relative to the archive root) skipped by /setup/export.
function isExcludedFromBackup(p) {
  const parts = String(p || "").split("/").filter(Boolean);
  // .openclaw/logs/** or workspace/logs/** style directories.
  return parts.length >= 2 && parts[1] === "logs";
}

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    await stopGateway();

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // A restored backup may come from a different OpenClaw version: re-evaluate the migration gate.
    await checkMigrationGate();
    if (migrationRequired) {
      res.type("text/plain").send(`OK - imported backup into /data.\nGateway NOT started:\n${migrationInstructions()}\n`);
      return;
    }

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err);
  try {
    if (res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Gateway unavailable\n");
    }
  } catch {
    // ignore
  }
});

// --- Auth boundaries ---
// SETUP_PASSWORD (HTTP Basic) protects ONLY the /setup admin surface. The proxied Control UI
// is not behind Basic auth: the public hostname is protected by Cloudflare Access, and the
// gateway enforces its own token auth + device pairing. Putting Basic auth in front of the
// Control UI caused repeated browser prompts and the Basic header shadowed the gateway token.
//
// Unauthenticated by design: /healthz, /setup/healthz (Railway probes) and /hooks/* (OpenClaw
// webhook endpoints, which carry their own hook token). Everything else under /setup that is
// not an explicit route above is still gated here and then 404s, so no admin path is exposed.
function guardSetupPrefix(req, res, next) {
  if (!req.path.startsWith("/setup")) return next();
  if (req.path === "/setup/healthz") return next();
  return requireSetupAuth(req, res, () => res.status(404).type("text/plain").send("Not found\n"));
}

// --- Gateway token injection ---
// The gateway is only reachable from this container. The Control UI in the browser
// cannot set custom Authorization headers for WebSocket connections, so we inject
// the token into proxied requests at the wrapper level.
// A Basic header (browsers replay cached /setup credentials for sibling paths) is replaced;
// a client-supplied Bearer (e.g. an API client with its own gateway/device token) is kept.
function gatewayAuthHeaderFor(existing) {
  if (!OPENCLAW_GATEWAY_TOKEN) return existing;
  const scheme = String(existing || "").split(" ")[0];
  if (scheme && scheme.toLowerCase() === "bearer") return existing;
  return `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
}

function attachGatewayAuthHeader(req) {
  if (!req?.headers) return;
  const next = gatewayAuthHeaderFor(req.headers.authorization);
  if (next) req.headers.authorization = next;
}

// Set the header on the outgoing request too, so it is applied regardless of when http-proxy
// copies headers from the incoming request.
proxy.on("proxyReq", (proxyReq, req) => {
  attachGatewayAuthHeader(req);
  if (req.headers.authorization) proxyReq.setHeader("authorization", req.headers.authorization);
});

proxy.on("proxyReqWs", (proxyReq, req) => {
  attachGatewayAuthHeader(req);
  if (req.headers.authorization) proxyReq.setHeader("authorization", req.headers.authorization);
});

app.use(guardSetupPrefix, async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    if (migrationRequired) {
      return res.status(503).type("text/plain").send(`Gateway not started: migration required.\n\n${migrationInstructions()}\n`);
    }
    try {
      await ensureGatewayRunning();
    } catch (err) {
      const hint = [
        "Gateway not ready.",
        String(err),
        lastGatewayError ? `\n${lastGatewayError}` : "",
        "\nTroubleshooting:",
        "- Visit /setup and check the Debug Console",
        "- Visit /setup/api/debug for config + gateway diagnostics",
      ].join("\n");
      return res.status(503).type("text/plain").send(hint);
    }
  }

  attachGatewayAuthHeader(req);
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, HOST, async () => {
  console.log(`[wrapper] listening on [${HOST}]:${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);

  // Harden state dir for OpenClaw and avoid missing credentials dir on fresh volumes.
  try {
    fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  } catch {}
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}

  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }

  // Optional operator hook to install/persist extra tools under /data.
  // This is intentionally best-effort and should be used to set up persistent
  // prefixes (npm/pnpm/python venv), not to mutate the base image.
  const bootstrapPath = path.join(WORKSPACE_DIR, "bootstrap.sh");
  if (fs.existsSync(bootstrapPath)) {
    console.log(`[wrapper] running bootstrap: ${bootstrapPath}`);
    try {
      await runCmd("bash", [bootstrapPath], {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        },
        timeoutMs: 10 * 60 * 1000,
      });
      console.log("[wrapper] bootstrap complete");
    } catch (err) {
      console.warn(`[wrapper] bootstrap failed (continuing): ${String(err)}`);
    }
  }

  // Migration gate: never start the gateway against state last touched by a different OpenClaw
  // version. Normal startup does not mutate persistent state; the operator runs doctor from /setup.
  await checkMigrationGate();
  if (migrationRequired) {
    console.error(`[wrapper] MIGRATION REQUIRED\n${migrationInstructions()}`);
  }

  // Legacy plaintext gateway token in config (e.g. state written by an older wrapper): replace it
  // with an env SecretRef. Skipped when the config already references the env var, so a normal
  // boot leaves the config untouched.
  if (isConfigured() && !migrationRequired && OPENCLAW_GATEWAY_TOKEN) {
    try {
      if (!(await gatewayTokenIsRef())) {
        console.log("[wrapper] gateway.auth.token is not an env reference; rewriting as SecretRef...");
        await syncGatewayConfig();
        console.log("[wrapper] gateway config synced");
      }
    } catch (err) {
      console.warn(`[wrapper] failed to sync gateway config: ${String(err)}`);
    }
  }

  // Auto-start the gateway if already configured so polling channels (Discord/etc.)
  // work even if nobody visits the web UI.
  if (isConfigured() && !migrationRequired) {
    console.log("[wrapper] config detected; starting gateway...");
    try {
      await ensureGatewayRunning();
      console.log("[wrapper] gateway ready");
    } catch (err) {
      console.error(`[wrapper] gateway failed to start at boot: ${String(err)}`);
    }
  }
});

server.on("upgrade", async (req, socket, head) => {
  // Note: browsers cannot attach arbitrary HTTP headers (including Authorization: Basic)
  // in WebSocket handshakes. Do not enforce dashboard Basic auth at the upgrade layer.
  // The gateway authenticates at the protocol layer and we inject the gateway token below.

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  attachGatewayAuthHeader(req);
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[wrapper] ${signal} received; stopping gateway...`);

  // Hard deadline in case the gateway ignores SIGTERM/SIGKILL handling stalls.
  setTimeout(() => process.exit(0), 12_000).unref?.();

  // Stop accepting new connections (in-flight requests may finish while the gateway stops).
  try {
    server.close();
  } catch {
    // ignore
  }

  // Wait for the gateway to exit so SQLite/state files are closed cleanly.
  try {
    await stopGateway(8_000);
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
