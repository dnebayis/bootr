# syntax=docker/dockerfile:1
# apps/inference: x402-paid LLM relay (@bootr/inference). Build from the repo root:
#   docker build -f apps/inference/Dockerfile -t bootr-inference .
#   docker run --rm -p 3003:3003 --env-file <file> bootr-inference
# Migrations (Railway pre-deploy command, WORKDIR /app/apps/inference): node scripts/migrate.mjs

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

# ---------------------------------------------------------------- build: tsc -> dist
FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --store-dir "$PNPM_STORE_DIR" --filter "@bootr/inference..."
RUN pnpm --filter "@bootr/inference..." run build

# ---------------------------------------------------------------- prod-deps: production node_modules only, same lockfile resolution
FROM fetch AS prod-deps
COPY apps/inference/package.json apps/inference/
RUN pnpm install --offline --frozen-lockfile --prod --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "@bootr/inference..."

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    INFERENCE_PORT=3003
WORKDIR /app
# Code stays root-owned (read-only for the service user).
COPY --from=prod-deps /repo ./
COPY --from=build /repo/apps/inference/dist apps/inference/dist
COPY --from=build /repo/apps/inference/drizzle apps/inference/drizzle
COPY --from=build /repo/apps/inference/scripts/migrate.mjs apps/inference/scripts/migrate.mjs
WORKDIR /app/apps/inference
USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.INFERENCE_PORT||3003)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
