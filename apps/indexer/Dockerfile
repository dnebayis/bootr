# syntax=docker/dockerfile:1
# apps/indexer: Ponder 0.18 indexer + Hono API (GraphQL, REST, SSE). Build from the repo root:
#   docker build -f apps/indexer/Dockerfile -t bootr-indexer .
#   docker run --rm -p 42069:42069 --env-file <file> -e DATABASE_SCHEMA=bootr_v1 bootr-indexer
# Ponder runs the TypeScript sources directly (no build step); @bootr/shared is consumed as TS source
# through the workspace symlink, so the runtime keeps the pnpm workspace layout.

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

# ---------------------------------------------------------------- check: typecheck + unit tests (fails the image build on errors)
FROM fetch AS check
COPY . .
RUN pnpm install --offline --frozen-lockfile --store-dir "$PNPM_STORE_DIR" --filter "indexer..." \
 && pnpm --filter indexer run codegen \
 && pnpm --filter indexer run typecheck \
 && pnpm --filter indexer run test \
 && touch /checked

# ---------------------------------------------------------------- prod-deps: production node_modules only, same lockfile resolution
FROM fetch AS prod-deps
COPY apps/indexer/package.json apps/indexer/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --offline --frozen-lockfile --prod --ignore-scripts --store-dir "$PNPM_STORE_DIR" --filter "indexer..."

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
# /health = process up; /ready (Railway deploy gate) = backfill complete.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||42069)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["sh", "scripts/start.sh"]
