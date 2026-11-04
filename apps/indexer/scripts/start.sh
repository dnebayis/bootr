#!/bin/sh
# Container entrypoint for the indexer (apps/indexer/Dockerfile): `ponder start` on Postgres.
#
# Schema:
#   DATABASE_SCHEMA=<name>  a fixed name (bootr_v3): bump it by hand whenever the indexing code changes, since Ponder
#                           refuses to reuse a schema built by a different app version (MigrationError).
#   DATABASE_SCHEMA=auto    bootr_<first 7 of IMAGE_REVISION> (the commit the image was built from, CI build arg
#                           GIT_SHA): every image indexes into its own schema, so a deploy never trips over the last
#                           one's. Before Ponder starts, scripts/schema-janitor.mjs drops the automatic schemas of
#                           older images, keeping the current one and the newest previous one (a rollback target);
#                           fixed-name schemas (bootr_v*) and bootr_offchain are never touched.
#   unset on Railway        RAILWAY_DEPLOYMENT_ID (docs/deploy/railway.md).
set -eu

schema="${DATABASE_SCHEMA:-}"
if [ -z "$schema" ] && [ -n "${RAILWAY_DEPLOYMENT_ID:-}" ]; then
  schema="$RAILWAY_DEPLOYMENT_ID"
fi
if [ "$schema" = "auto" ]; then
  rev="${IMAGE_REVISION:-}"
  if [ -z "$rev" ] || [ "$rev" = "dev" ]; then
    echo "[indexer] DATABASE_SCHEMA=auto needs IMAGE_REVISION (the CI build arg GIT_SHA); this image has none" >&2
    exit 1
  fi
  schema="bootr_$(printf '%s' "$rev" | cut -c1-7 | tr 'A-F' 'a-f')"
  if [ -n "${INDEXER_DATABASE_URL:-}" ]; then
    node scripts/schema-janitor.mjs "$schema" || echo "[indexer] schema janitor failed; continuing" >&2
  fi
fi
if [ -z "$schema" ]; then
  echo "[indexer] DATABASE_SCHEMA is not set (and RAILWAY_DEPLOYMENT_ID is not available)" >&2
  exit 1
fi
if [ -z "${INDEXER_DATABASE_URL:-}" ]; then
  echo "[indexer] WARNING: INDEXER_DATABASE_URL is empty, so Ponder uses PGlite inside the container; the index is lost on every restart." >&2
fi

echo "[indexer] ponder start --schema ${schema} (port ${PORT:-42069})"
exec ./node_modules/.bin/ponder start --schema "$schema"
