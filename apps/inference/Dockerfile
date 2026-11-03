# syntax=docker/dockerfile:1
# apps/inference: x402-paid LLM relay (@bootr/inference). Build from the repo root:
#   docker build -f apps/inference/Dockerfile -t bootr-inference .
#   docker run --rm -p 3003:3003 --env-file <file> bootr-inference
# Migrations (compose `command`, WORKDIR /app/apps/inference): node scripts/migrate.mjs
#
# Stages: build (dev install, tsc) and prod-deps (production node_modules from the same lockfile) feed a runtime
# stage that holds prod-deps, dist, the drizzle migrations and the migration script only. The pnpm store lives on
# a BuildKit cache mount, never in a layer: the former `pnpm fetch` layer put every package of the lockfile
# (1.3 GB) into the runtime image's virtual store. The runtime layout (root node_modules/.pnpm + workspace
# symlinks, WORKDIR /app/apps/inference) is unchanged.

ARG NODE_VERSION=24

# ---------------------------------------------------------------- base: Node + pnpm (corepack, version from package.json) + manifests
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_STORE_DIR=/pnpm/store
RUN corepack enable
WORKDIR /repo
# Manifests only: the install layers below are reused until a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/inference/package.json apps/inference/

# ---------------------------------------------------------------- build: tsc -> dist
FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "@bootr/inference..."
COPY tsconfig.base.json ./
COPY apps/inference apps/inference
RUN pnpm --filter "@bootr/inference..." run build

# ---------------------------------------------------------------- prod-deps: production node_modules only, same lockfile resolution
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "@bootr/inference..."
# Trim what Node never loads: type declarations, source maps and docs of the dependencies, plus two packages the
# lockfile resolves into the production tree as optional peers although only dev code uses them: typescript
# (viem's) and @electric-sql/pglite (drizzle-orm's; production runs on postgres-js). Only the symlinks that
# pointed at them remain, dangling.
RUN find node_modules/.pnpm -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete \
 && rm -rf node_modules/.pnpm/typescript@* node_modules/.pnpm/@electric-sql+pglite@*

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
