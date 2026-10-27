# syntax=docker/dockerfile:1
# apps/supervisor: agent loop + HMAC admin API (internal only). Build from the repo root:
#   docker build -f apps/supervisor/Dockerfile -t bootr-supervisor .
#   docker run --rm -p 3004:3004 --env-file <file> bootr-supervisor
# Migrations (Railway pre-deploy command, WORKDIR /app/apps/supervisor): node dist/db/migrate.js
# Run exactly one replica: the tick loop is not built for horizontal scaling.

ARG NODE_VERSION=24

# ---------------------------------------------------------------- base: Node + pnpm (corepack, version from package.json)
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_STORE_DIR=/pnpm/store
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------- fetch: lockfile-only layer, cached until pnpm-lock.yaml changes
FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --store-dir "$PNPM_STORE_DIR"

# ---------------------------------------------------------------- build: agent-core + inference (tsc), supervisor (tsc --noEmit + esbuild)
# The esbuild bundle inlines the workspace packages (@bootr/shared, @bootr/agent-core, @bootr/inference/client);
# npm dependencies stay external and are resolved from apps/supervisor/node_modules at runtime.
FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --store-dir "$PNPM_STORE_DIR" --filter "supervisor..."
RUN pnpm --filter "supervisor..." run build

# ---------------------------------------------------------------- prod-deps: production node_modules only, same lockfile resolution
# (keeps pnpm's hoisted .pnpm/node_modules, which some dependencies rely on, e.g. @zerodev/webauthn-key -> tslib)
FROM fetch AS prod-deps
COPY apps/supervisor/package.json apps/supervisor/
COPY apps/inference/package.json apps/inference/
COPY packages/shared/package.json packages/shared/
COPY packages/agent-core/package.json packages/agent-core/
RUN pnpm install --offline --frozen-lockfile --prod --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "supervisor..."

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SUPERVISOR_PORT=3004
WORKDIR /app
# Code stays root-owned (read-only for the service user).
COPY --from=prod-deps /repo ./
COPY --from=build /repo/apps/supervisor/dist apps/supervisor/dist
COPY --from=build /repo/apps/supervisor/drizzle apps/supervisor/drizzle
WORKDIR /app/apps/supervisor
USER node
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SUPERVISOR_PORT||3004)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
