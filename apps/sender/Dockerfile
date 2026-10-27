# syntax=docker/dockerfile:1
# apps/sender: Hono X (Twitter) boundary service. Build from the repo root:
#   docker build -f apps/sender/Dockerfile -t bootr-sender .
#   docker run --rm -p 3002:3002 --env-file <file> bootr-sender
# Migrations (Railway pre-deploy command, WORKDIR /app/apps/sender): node dist/db/migrate.js

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

# ---------------------------------------------------------------- build: @bootr/agent-core + sender (tsc)
FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --store-dir "$PNPM_STORE_DIR" --filter "sender..."
RUN pnpm --filter "sender..." run build

# ---------------------------------------------------------------- prod-deps: production node_modules only, same lockfile resolution
FROM fetch AS prod-deps
COPY apps/sender/package.json apps/sender/
COPY packages/agent-core/package.json packages/agent-core/
RUN pnpm install --offline --frozen-lockfile --prod --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "sender..."

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3002
WORKDIR /app
# Code stays root-owned (read-only for the service user).
COPY --from=prod-deps /repo ./
COPY --from=build /repo/packages/agent-core/dist packages/agent-core/dist
COPY --from=build /repo/apps/sender/dist apps/sender/dist
COPY --from=build /repo/apps/sender/drizzle apps/sender/drizzle
WORKDIR /app/apps/sender
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
