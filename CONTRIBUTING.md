# Contributing

Thanks for helping improve the OpenClaw Railway Template.

## Where to ask questions / get help

- Discord: https://discord.com/invite/clawd
- GitHub Issues: https://github.com/vignesh07/clawdbot-railway-template/issues

## Reporting bugs

Please include:

1) **Railway logs** around the failure
2) The output of:
   - `GET /healthz`
   - `GET /setup/api/debug` (after authenticating to `/setup`)
3) Your Railway settings relevant to networking:
   - How you reach the service: Cloudflare Tunnel to `http://<service>.railway.internal:<PORT>`, or a public Railway domain?
   - The `PORT` Railway injected (see the `listening on` line in the logs) and, if public, the domain target port
   - Whether `OPENCLAW_PUBLIC_ORIGIN` is set
4) The pinned OpenClaw version (`ARG OPENCLAW_VERSION` in the Dockerfile) and whether `/setup` showed *Migration required*

## Pull requests

- Keep PRs small and focused (one fix per PR)
- Run locally (Node 24):
  - `npm run lint`
  - `npm test`

If you’re making Dockerfile changes, please explain why they’re needed and how you tested.
