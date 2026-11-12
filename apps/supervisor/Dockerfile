# syntax=docker/dockerfile:1
# apps/supervisor: agent loop + HMAC admin API (internal only). Build from the repo root:
#   docker build -f apps/supervisor/Dockerfile -t bootr-supervisor .
#   docker run --rm -p 3004:3004 --env-file <file> bootr-supervisor
# Migrations (compose `command`, WORKDIR /app/apps/supervisor): node dist/db/migrate.js
# Run exactly one replica: the tick loop is not built for horizontal scaling.
#
# Stages: build (dev install of supervisor and its workspace deps, tsc --noEmit + esbuild) and prod-deps
# (production node_modules of the same packages from the same lockfile) feed a runtime stage that holds
# prod-deps, dist and the drizzle migrations only. The pnpm store lives on a BuildKit cache mount, never in a
# layer: the former `pnpm fetch` layer put every package of the lockfile (1.3 GB) into the runtime image's
# virtual store. The runtime layout (root node_modules/.pnpm + workspace symlinks, WORKDIR /app/apps/supervisor)
# is unchanged.

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
COPY apps/supervisor/package.json apps/supervisor/
COPY apps/inference/package.json apps/inference/
COPY packages/shared/package.json packages/shared/
COPY packages/agent-core/package.json packages/agent-core/

# ---------------------------------------------------------------- build: agent-core + inference (tsc), supervisor (tsc --noEmit + esbuild)
# The esbuild bundle inlines the workspace packages (@bootr/shared, @bootr/agent-core, @bootr/inference/client);
# npm dependencies stay external and are resolved from apps/supervisor/node_modules at runtime.
FROM base AS build
# --ignore-scripts: the sources are not there yet (agent-core's `prepare` would run tsc on nothing); the build
# below compiles agent-core and inference explicitly. esbuild needs no postinstall (it resolves its platform
# binary from @esbuild/linux-x64 at run time).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "supervisor..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/agent-core packages/agent-core
COPY apps/inference apps/inference
COPY apps/supervisor apps/supervisor
RUN pnpm --filter "supervisor..." run build

# ---------------------------------------------------------------- prod-deps: production node_modules only, same lockfile resolution
# (keeps pnpm's hoisted .pnpm/node_modules, which some dependencies rely on, e.g. @zerodev/webauthn-key -> tslib)
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "supervisor..."
# Trim what Node never loads: type declarations, source maps and docs of the dependencies, plus two packages the
# lockfile resolves into the production tree as optional peers although only dev code uses them: typescript
# (viem's) and @electric-sql/pglite (drizzle-orm's; production runs on the pg driver). Only the symlinks that
# pointed at them remain, dangling.
RUN find node_modules/.pnpm -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete \
 && rm -rf node_modules/.pnpm/typescript@* node_modules/.pnpm/@electric-sql+pglite@*
# sharp (own agents' picture uploads, src/own/pictures.ts) is a native module, and the bundle imports it when the
# supervisor starts: without its binary nothing starts, hosted agents included. The binary is not built here and no
# install script fetches it (sharp has none, so --ignore-scripts changes nothing): it is the optional dependency pnpm
# picks for this platform (@img/sharp-linux-x64 and its libvips, glibc 2.28 or later; this base image has 2.36). One
# pixel is written here, on the tree the runtime stage copies, so a tree where it cannot load fails this build.
RUN cd apps/supervisor \
 && node -e "require('sharp')({create:{width:1,height:1,channels:3,background:'#000'}}).png().toBuffer().then((b)=>{if(b.length<8)process.exit(1)},(e)=>{console.error(e);process.exit(1)})"

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
