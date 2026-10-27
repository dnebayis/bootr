# syntax=docker/dockerfile:1
# apps/web: Next.js 16 (App Router) served from the standalone output. Build from the repo root:
#   docker build -f apps/web/Dockerfile -t bootr-web \
#     --build-arg NEXT_PUBLIC_CHAIN_ID=84532 --build-arg NEXT_PUBLIC_INDEXER_URL=https://indexer.bootr.fun ... .
#   docker run --rm -p 3000:3000 --env-file <file> bootr-web
#
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so they are build args
# (Railway passes service variables to every ARG declared here). They are public by definition:
# never put a secret, or an RPC URL that embeds an API key, in a NEXT_PUBLIC_* variable.
# Server-only secrets (SESSION_SECRET, SENDER_SERVICE_KEY, ...) are read at runtime and are NOT build args.

ARG NODE_VERSION=24

# ---------------------------------------------------------------- base: Node + pnpm (corepack, version from package.json)
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_STORE_DIR=/pnpm/store \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------- fetch: lockfile-only layer, cached until pnpm-lock.yaml changes
FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --store-dir "$PNPM_STORE_DIR"

# ---------------------------------------------------------------- build: next build -> .next/standalone
FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --store-dir "$PNPM_STORE_DIR" --filter "web..."

ARG NEXT_PUBLIC_CHAIN_ID=84532
ARG NEXT_PUBLIC_SITE_URL=https://bootr.fun
ARG NEXT_PUBLIC_INDEXER_URL=
ARG NEXT_PUBLIC_USE_MOCK=
ARG NEXT_PUBLIC_WC_PROJECT_ID=
ARG NEXT_PUBLIC_RPC_URL=
ARG NEXT_PUBLIC_BUILDER_CODE=
ARG NEXT_PUBLIC_INFERENCE_URL=
ARG NEXT_PUBLIC_SENDER_PUBLIC_URL=
ARG NEXT_PUBLIC_SWAP_LINK_BASE=
ARG NEXT_PUBLIC_LAUNCHER_ADDRESS=
ARG NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS=
ARG NEXT_PUBLIC_SUPERVISOR_SESSION_KEY=
ARG NEXT_PUBLIC_BOOT_X_URL=
ARG NEXT_PUBLIC_WORKER_SOURCE_BASE=

RUN NEXT_OUTPUT=standalone pnpm --filter web run build

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=:: \
    ADMIN_CONFIG_PATH=/data/admin-config.json
# HOSTNAME: Docker sets it to the container id, which Next would bind to; `::` listens on IPv6 and IPv4
# (Railway private networking is IPv6). Use 0.0.0.0 on a host where IPv6 is unavailable.
WORKDIR /app
# The standalone tree mirrors the monorepo: the server entry is apps/web/server.js, with the traced
# node_modules at the root. Owned by the service user because Next writes its cache under .next/.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public apps/web/public
# Admin config store (lib/server/admin-config.ts). Mount a persistent volume here in production.
RUN mkdir -p /data && chown node:node /data
WORKDIR /app/apps/web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
