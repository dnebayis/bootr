#!/bin/sh
# Container entrypoint for the indexer (apps/indexer/Dockerfile): `ponder start` on Postgres.
#
# Schema: DATABASE_SCHEMA when set (a fixed name such as bootr_v1; bump it whenever the indexing code
# changes, since Ponder refuses to reuse a schema built by a different app version). On Railway, when
# DATABASE_SCHEMA is unset, each deployment indexes into its own schema named after
# RAILWAY_DEPLOYMENT_ID, so the previous deployment keeps serving until the new one reports /ready.
# Old schemas are dropped with `ponder db prune` (see docs/deploy/railway.md).
set -eu

schema="${DATABASE_SCHEMA:-}"
if [ -z "$schema" ] && [ -n "${RAILWAY_DEPLOYMENT_ID:-}" ]; then
  schema="$RAILWAY_DEPLOYMENT_ID"
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
