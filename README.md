# OpenClaw Railway Template (1‑click deploy)

This repo packages **OpenClaw** for Railway with a small **/setup** web wizard so users can deploy and onboard **without running any commands**.

This fork runs the **official prebuilt OpenClaw image** (pinned to `2026.9.5`) and is designed for a private deployment behind **Cloudflare Tunnel + Railway private networking**. A public Railway domain is optional.

## What you get

- **OpenClaw Gateway + Control UI** (served at `/` and `/openclaw`)
- A friendly **Setup Wizard** at `/setup` (protected by a password)
- Persistent state via **Railway Volume** (so config/credentials/memory survive redeploys)
- One-click **Export backup** (so users can migrate off Railway later)
- **Import backup** from `/setup` (advanced recovery)
- A **migration gate**: after an OpenClaw version change the gateway stays stopped until you run `openclaw doctor --fix` from `/setup`

## How it works (high level)

- The image is `ghcr.io/openclaw/openclaw:<version>` plus a small Node wrapper (`src/server.js`).
- The wrapper protects `/setup` (and the Control UI at `/openclaw`) with `SETUP_PASSWORD` using HTTP Basic auth.
- During setup, the wrapper runs `openclaw onboard --non-interactive ...` inside the container, writes state to the volume, and then starts the gateway on loopback (`127.0.0.1:18789`).
- After setup, **`/` is OpenClaw**. The wrapper reverse-proxies all traffic (including WebSockets) to the local gateway process.
- The wrapper listens on `$PORT` and binds dual-stack (`::`), so it is reachable over Railway private networking as well as a public domain.

## Architecture (Cloudflare Tunnel, no public domain)

```
Internet → Cloudflare Access (MFA) → Cloudflare Tunnel → cloudflared service (Railway)
        → Railway private network → http://<openclaw-service>.railway.internal:8080 → wrapper → gateway (loopback)
```

- The OpenClaw service needs **no public Railway domain**. Point the tunnel's origin at `http://<service>.railway.internal:8080` (plain HTTP; TLS terminates at Cloudflare).
- Railway private networking is IPv6-only on legacy environments; the wrapper binds `::` so this works either way. Set `HOST=0.0.0.0` only if you deploy somewhere without IPv6.
- Set `OPENCLAW_PUBLIC_ORIGIN` to the HTTPS origin users open in the browser (e.g. `https://openclaw.example.com`). The wrapper writes it to `gateway.publicOrigin`, which the gateway uses for the Control UI websocket **Origin check**. Without it the Control UI may fail to connect behind the proxy.
- `/healthz` and `/hooks/*` bypass Basic auth by design. Behind Cloudflare Access they are still gated by Access unless you add a bypass rule.

## Railway deploy instructions

1) Create a service from this repo (Dockerfile build).
2) Add a **Volume** mounted at `/data`.
3) Set variables:

Required:
- `SETUP_PASSWORD` — password for `/setup` and the Control UI (`/openclaw`) via HTTP Basic auth
- `OPENCLAW_GATEWAY_TOKEN` — generate a long random secret. The wrapper falls back to generating and persisting one in `/data/.openclaw/gateway.token` if unset, but a Railway secret is preferred.

Recommended:
- `OPENCLAW_PUBLIC_ORIGIN` — e.g. `https://openclaw.example.com` (see Architecture)
- `OPENROUTER_API_KEY` — OpenRouter key (see OpenRouter setup)
- `DISCORD_BOT_TOKEN` — Discord bot token (see Discord setup)
- `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` — lets the gateway shut down cleanly on redeploy (set in `railway.toml`)

Already set by `railway.toml` / Dockerfile:
- `OPENCLAW_STATE_DIR=/data/.openclaw`, `OPENCLAW_WORKSPACE_DIR=/data/workspace`
- `OPENCLAW_NO_AUTO_UPDATE=1` (the image is immutable; upgrade by changing the pinned version)

Optional:
- `OPENCLAW_MIGRATION_GATE=off` — disable the migration gate (not recommended)
- `HOST` — wrapper bind address (default `::`)

4) Networking: either connect a Cloudflare Tunnel to `http://<service>.railway.internal:8080` (recommended), or enable Railway Public Networking (HTTP). Railway injects `PORT` either way.
5) Deploy, then open `/setup` (any username; password is `SETUP_PASSWORD`) and complete setup.

## Environment variables and secrets

| Variable | Where it ends up |
|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | Process env only. The config stores an env **SecretRef** (`{source:"env", id:"OPENCLAW_GATEWAY_TOKEN"}`), never the token. Rotating the Railway variable needs no config change. |
| `OPENROUTER_API_KEY` (and other `<PROVIDER>_API_KEY`) | If you leave the key field blank in `/setup`, onboarding runs with `--secret-input-mode ref` and the auth profile stores an env reference. If you paste a key, it is stored by OpenClaw as before. |
| `DISCORD_BOT_TOKEN` | If set, `/setup` writes `channels.discord` **without** a `token` field; the plugin reads the env var for the default account. |
| `SETUP_PASSWORD` | Process env only (Basic auth check). |

The **config editor** in `/setup` shows the raw config file, and **backups** contain everything under `/data/.openclaw`. Both are behind Basic auth (and Cloudflare Access), but treat them as sensitive.

## OpenRouter setup

1) Set `OPENROUTER_API_KEY` in Railway Variables.
2) In `/setup`, choose provider group **OpenRouter** → **OpenRouter API key**, leave the key field **blank**, run setup.
3) Verify from the Debug console: `openclaw status` / `openclaw config get gateway.auth.token` (should show an env reference, not a key).

Model ids use the form `openrouter/<vendor>/<model>`; change the default with `openclaw models set ...` or the Control UI.

## Discord setup

Discord is a bundled plugin in OpenClaw 2026.9.5 (`@openclaw/discord`).

1) Discord Developer Portal → **New Application** → **Bot** → copy the **Bot Token**.
2) Bot → **Privileged Gateway Intents** → enable **MESSAGE CONTENT INTENT** (required; the bot fails on startup without it).
3) OAuth2 URL Generator → scopes `bot`, `applications.commands` → pick permissions → invite the bot to your server.
4) Set `DISCORD_BOT_TOKEN` in Railway Variables (preferred) or paste it in `/setup`.
5) Run setup. The wrapper writes `channels.discord = { enabled, dmPolicy: "pairing", groupPolicy: "allowlist" }`.
6) DM the bot; approve the pairing code via **Approve pairing** in `/setup` (or `openclaw pairing approve discord <code>`).

Restricting channels later: edit `channels.discord.guilds.<guildId>.channels.<channelId>` (e.g. `requireMention`) in the config editor, or switch `groupPolicy`. See https://docs.openclaw.ai/channels/discord.

If `/setup` reports "discord plugin was not found", the image variant does not include it; install a version-matched plugin (`@openclaw/discord@<openclaw version>`) before rerunning setup.

## Telegram (not bundled)

OpenClaw 2026.9.5 no longer ships Telegram as a bundled plugin. The Telegram field in `/setup` is skipped unless a Telegram plugin is installed. Discord is the supported channel for this fork.

## Persistence (Railway volume)

Railway containers have an ephemeral filesystem. Only the mounted volume at `/data` persists across restarts/redeploys.

What persists:
- **OpenClaw state:** `/data/.openclaw` (config, credentials, auth profiles, sessions, devices, the wrapper's version marker)
- **Workspace / custom skills:** `/data/workspace`
- **Node global tools (npm/pnpm):** `/data/npm`, `/data/pnpm`, `/data/pnpm-store`
- **Python packages:** create a venv under `/data` (the image includes `python3-venv`)

What does *not* persist: `apt-get install ...`, anything under `/home/node` or `/root`.

### Optional bootstrap hook

If `/data/workspace/bootstrap.sh` exists, the wrapper runs it on startup (best-effort) before starting the gateway.

```bash
#!/usr/bin/env bash
set -euo pipefail
python3 -m venv /data/venv || true
mkdir -p /data/npm /data/npm-cache /data/pnpm /data/pnpm-store
```

## Upgrading OpenClaw

The version is pinned in the Dockerfile: `ARG OPENCLAW_VERSION=2026.9.5`. Override it in Railway (Settings → Build → Build Args) or edit the Dockerfile. Do not track `latest`.

The wrapper records the OpenClaw version that last ran against `/data/.openclaw` in `/data/.openclaw/.wrapper-openclaw-version`. When the running version differs (or no marker exists), the **migration gate** keeps the gateway stopped and `/setup` shows a *Migration required* banner. Normal startups never modify persisted state.

### Bridge migration: 2026.3.8 → 2026.9.5

Existing volumes created by the old template have no marker, so the gate triggers on the first deploy of this image. This is intentional: 2026.9.5 migrates config and SQLite state one-way.

1) **Back up first**: download a backup from `/setup` (and/or snapshot the Railway volume).
2) Deploy this image. Logs show `MIGRATION REQUIRED` and `/setup` shows the banner. The gateway does not start.
3) In `/setup` click **Run openclaw doctor --fix**. This runs `openclaw doctor --fix --non-interactive`, records the version, converts the gateway token in the config to an env reference, and starts the gateway.
   - If doctor exits non-zero, the gateway stays stopped and the output is shown. Fix the reported issue (config editor) and rerun, or roll back.
   - If you already ran doctor yourself (e.g. via a Railway shell), click **Mark migration done** instead.
4) Verify: `/healthz` shows `gateway.reachable: true`; Debug console `openclaw status`; Control UI connects; a Discord DM round trip works.

Later upgrades follow the same flow: back up → bump `OPENCLAW_VERSION` → deploy → run doctor from `/setup` → verify. Upstream recommends landing on 2026.9.5 before moving to newer releases.

## Backup / restore

- **Export**: `/setup` → *Download backup*. Archive contains `.openclaw/` and `workspace/` relative to `/data` (log directories excluded).
- **Backups contain secrets**: `openclaw.json`, `credentials/`, auth profiles, sessions, and possibly the gateway token (`gateway.token` if generated by the wrapper). They are not encrypted. Store them like a password database.
- **Import**: `/setup` → *Import backup*. Stops the gateway, extracts into `/data` (existing files are overwritten, nothing is deleted), re-checks the migration gate, then restarts the gateway if no migration is pending.

## Rollback

1) Restore the pre-upgrade backup (or Railway volume snapshot) — state migrated by a newer OpenClaw is not readable by older versions.
2) Redeploy the previous image / `OPENCLAW_VERSION`.
3) The version marker from the backup matches the old version, so the gateway starts normally. If the marker is missing, use **Mark migration done** after confirming the state is the old version's.

## Health checks

- `GET /setup/healthz` — wrapper liveness (Railway healthcheck path; no auth).
- `GET /healthz` — wrapper + gateway reachability, `migrationRequired`, last gateway error (no auth, no secrets).
- The gateway itself serves `/healthz`, `/startupz`, `/readyz` on loopback; the wrapper uses `/healthz` to detect readiness.

## Support / community

- GitHub Issues: https://github.com/vignesh07/clawdbot-railway-template/issues
- Discord: https://discord.com/invite/clawd

If you’re filing a bug, please include the output of `/healthz` and `/setup/api/debug` (after authenticating to /setup).

## Troubleshooting

### "Gateway not started: migration required" / MIGRATION REQUIRED in logs

Expected after a version change. Follow **Upgrading OpenClaw** above.

### cloudflared cannot reach `http://<service>.railway.internal:8080`

- Confirm the origin port matches `PORT` (Railway injects it; the wrapper logs `listening on [::]:<port>`).
- Both services must be in the same Railway environment/project.
- Private networking is unavailable during build and for a few seconds after start.

### Control UI loads but the websocket disconnects / origin rejected

Set `OPENCLAW_PUBLIC_ORIGIN` to the exact HTTPS origin in the browser (scheme + host, no path) and redeploy. The wrapper writes it to `gateway.publicOrigin`. If the UI asks for a gateway secret, paste `OPENCLAW_GATEWAY_TOKEN`.

### “disconnected (1008): pairing required”

The gateway is running but no device has been approved yet. Browser clients behind the proxy count as remote, so approval is required once per device.

- Open `/setup` → **Pairing helper** → *Refresh pending devices* → *Approve*, or Debug console `openclaw devices list` / `openclaw devices approve <requestId>`.

### “unauthorized: gateway token mismatch”

The config now references `OPENCLAW_GATEWAY_TOKEN` via SecretRef; make sure the Railway variable is set and redeploy. `/setup/api/debug` shows `gatewayTokenFromEnv`.

### “Application failed to respond” / 502 Bad Gateway

- Ensure a **Volume** is mounted at `/data`.
- Check Railway logs for `Gateway not ready:` or `MIGRATION REQUIRED`.
- `/healthz` shows `gateway.lastError` / `lastExit`.

### Legacy CLAWDBOT_* env vars

Use `OPENCLAW_*` variables only; the wrapper maps and strips the legacy names.

## Local smoke test

```bash
docker build -t clawdbot-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32) \
  -v $(pwd)/.tmpdata:/data \
  clawdbot-railway-template

# open http://localhost:8080/setup (password: test)
# CLI check: docker run --rm --entrypoint node clawdbot-railway-template /app/openclaw.mjs --version
```

---

## Official template / endorsements

- Upstream template: https://github.com/vignesh07/clawdbot-railway-template (officially recommended by OpenClaw: <https://docs.openclaw.ai/railway>)
- Railway announcement (official): [Railway tweet announcing 1‑click OpenClaw deploy](https://x.com/railway/status/2015534958925013438)
- Created and maintained by **Vignesh N (@vignesh07)**; this repository is a fork for a private Cloudflare Tunnel deployment.
