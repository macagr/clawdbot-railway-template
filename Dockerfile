# Runtime image: the official prebuilt OpenClaw release image.
#
# Pinned to a released version. Override in Railway (Settings -> Build -> Build Args) or edit here.
# Keep this on 2026.9.5 until the 2026.3.8 -> 2026.9.5 bridge migration has been validated
# (see README "Upgrading OpenClaw").
ARG OPENCLAW_VERSION=2026.9.5
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

# The base image runs as `node`. The wrapper currently runs as root because Railway volumes are
# mounted root-owned; dropping privileges is tracked as a follow-up.
USER root
ENV NODE_ENV=production

# python3, git, curl, ca-certificates and tini already ship in the base image.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Persist user-installed tools by default by targeting the Railway volume.
# - npm global installs -> /data/npm
# - pnpm global installs -> /data/pnpm (binaries) + /data/pnpm-store (store)
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

# OpenClaw runtime defaults. The image is immutable: never self-update inside the container.
ENV OPENCLAW_ENTRY=/app/openclaw.mjs
ENV OPENCLAW_STATE_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE_DIR=/data/workspace
ENV OPENCLAW_NO_AUTO_UPDATE=1

# Wrapper lives outside /app (which is OpenClaw's install root).
WORKDIR /wrapper

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# The wrapper listens on $PORT (Railway injects it at runtime). Do not set a default PORT here.
# Over Railway private networking the origin is http://<service>.railway.internal:8080.
EXPOSE 8080

# Ensure PID 1 reaps zombies and forwards signals.
ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "src/server.js"]
