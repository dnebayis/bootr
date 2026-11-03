# syntax=docker/dockerfile:1
# apps/sender: Hono X (Twitter) boundary service. Build from the repo root:
#   docker build -f apps/sender/Dockerfile -t bootr-sender .
#   docker run --rm -p 3002:3002 --env-file <file> bootr-sender
# Migrations (compose `command`, WORKDIR /app/apps/sender): node dist/db/migrate.js
#
# Stages: build (dev install of sender and its workspace deps, tsc) and prod-deps (production node_modules of
# the same packages from the same lockfile) feed a runtime stage that holds prod-deps, dist and the drizzle
# migrations only. The pnpm store lives on a BuildKit cache mount, never in a layer: the former `pnpm fetch`
# layer put every package of the lockfile (1.3 GB) into the runtime image's virtual store. The runtime layout
# (root node_modules/.pnpm + workspace symlinks, WORKDIR /app/apps/sender) is unchanged.

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
COPY apps/sender/package.json apps/sender/
COPY packages/agent-core/package.json packages/agent-core/

# ---------------------------------------------------------------- build: @bootr/agent-core + sender (tsc)
FROM base AS build
# --ignore-scripts: the sources are not there yet (agent-core's `prepare` would run tsc on nothing); the build
# below compiles agent-core explicitly.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "sender..."
COPY tsconfig.base.json ./
COPY packages/agent-core packages/agent-core
COPY apps/sender apps/sender
RUN pnpm --filter "sender..." run build

# ---------------------------------------------------------------- prod-deps: production node_modules only, same lockfile resolution
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "sender..."
# Trim what Node never loads: type declarations, source maps and docs of the dependencies, plus two packages the
# lockfile resolves into the production tree as optional peers although only dev code uses them: typescript
# (viem's) and @electric-sql/pglite (drizzle-orm's; production runs on the pg driver). Only the symlinks that
# pointed at them remain, dangling.
RUN find node_modules/.pnpm -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete \
 && rm -rf node_modules/.pnpm/typescript@* node_modules/.pnpm/@electric-sql+pglite@*

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
