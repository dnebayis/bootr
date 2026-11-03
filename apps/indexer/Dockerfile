# syntax=docker/dockerfile:1
# apps/indexer: Ponder 0.18 indexer + Hono API (GraphQL, REST, SSE). Build from the repo root:
#   docker build -f apps/indexer/Dockerfile -t bootr-indexer .
#   docker run --rm -p 42069:42069 --env-file <file> -e DATABASE_SCHEMA=bootr_v1 bootr-indexer
# Ponder runs the TypeScript sources directly (no build step); @bootr/shared is consumed as TS source
# through the workspace symlink, so the runtime keeps the pnpm workspace layout.
#
# Stages: check (dev install, codegen + typecheck + unit tests: fails the image build on errors) and prod-deps
# (production node_modules of indexer + @bootr/shared from the same lockfile) feed a runtime stage that holds
# prod-deps and the sources only. The pnpm store lives on a BuildKit cache mount, never in a layer: the former
# `pnpm fetch` layer put every package of the lockfile (1.3 GB) into the runtime image's virtual store. The
# runtime layout (root node_modules/.pnpm + workspace symlinks, WORKDIR /app/apps/indexer) is unchanged.

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
COPY apps/indexer/package.json apps/indexer/
COPY packages/shared/package.json packages/shared/

# ---------------------------------------------------------------- check: typecheck + unit tests (fails the image build on errors)
FROM base AS check
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "indexer..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/indexer apps/indexer
RUN pnpm --filter indexer run codegen \
 && pnpm --filter indexer run typecheck \
 && pnpm --filter indexer run test \
 && touch /checked

# ---------------------------------------------------------------- prod-deps: production node_modules only, same lockfile resolution
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "indexer..."
# Trim what Node never loads: type declarations, source maps and docs of the dependencies. typescript and
# @electric-sql/pglite stay: both are dependencies of ponder itself.
RUN find node_modules/.pnpm -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=42069
WORKDIR /app
COPY --from=check /checked /tmp/checked
COPY --from=prod-deps /repo ./
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY tsconfig.base.json ./
# Ponder writes ponder-env.d.ts, generated/ and .ponder/ next to its config, so the app dir belongs to
# the service user; node_modules stays root-owned.
COPY --chown=node:node apps/indexer/abis apps/indexer/abis
COPY --chown=node:node apps/indexer/src apps/indexer/src
COPY --chown=node:node apps/indexer/ponder.config.ts apps/indexer/ponder.schema.ts apps/indexer/ponder-env.d.ts apps/indexer/tsconfig.json apps/indexer/
COPY --chown=node:node apps/indexer/scripts/start.sh apps/indexer/scripts/start.sh
RUN chown node:node apps/indexer
WORKDIR /app/apps/indexer
USER node
EXPOSE 42069
# /health = process up; /ready = backfill complete.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||42069)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["sh", "scripts/start.sh"]
