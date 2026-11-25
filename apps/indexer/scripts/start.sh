#!/bin/sh
# Container entrypoint for the indexer (apps/indexer/Dockerfile).
#
# Role (docs/deploy/live-switch.md):
#   INDEXER_ROLE=all     (default) `ponder start` on DATABASE_SCHEMA: one process indexes and serves, as before the live
#                        switch existed. A new schema is read by the site while it fills.
#   INDEXER_ROLE=writer  `ponder start` on DATABASE_SCHEMA, with no public domain. It refuses to start while another
#                        process is writing the same schema, and once its index is ready and as far along the chain as
#                        the one being served, it points the views of INDEXER_LIVE_SCHEMA (bootr_live) at its schema in
#                        one transaction (scripts/live-switch.mjs). A writer that had the views before and lost them to
#                        a newer one does not take them back. INDEXER_SWITCH: auto (default, as described), manual (never
#                        switches; run `node scripts/live-switch.mjs switch <schema>`), ponder (Ponder's own
#                        DATABASE_VIEWS_SCHEMA: switches at the end of the backfill, at the finalized block, and on
#                        every start of the writer).
#   INDEXER_ROLE=reader  `ponder serve` on the views: GraphQL and the routes of src/api, no indexing. It waits for the
#                        views to exist. Health is /health; DATABASE_SCHEMA is not read.
#
# Schema (all and writer):
#   DATABASE_SCHEMA=<name>  a fixed name (bootr_v3): bump it by hand whenever the indexing code changes, since Ponder
#                           refuses to reuse a schema built by a different app version (MigrationError).
#   DATABASE_SCHEMA=auto    bootr_<first 7 of IMAGE_REVISION> (the commit the image was built from, CI build arg
#                           GIT_SHA): every image indexes into its own schema, so a deploy never trips over the last
#                           one's. Before Ponder starts, scripts/schema-janitor.mjs drops the automatic schemas of
#                           older images, keeping the current one and the newest previous one (a rollback target);
#                           fixed-name schemas (bootr_v*) and bootr_offchain are never touched.
#   unset on Railway        RAILWAY_DEPLOYMENT_ID (docs/deploy/railway.md).
set -eu

role="${INDEXER_ROLE:-all}"
live="${INDEXER_LIVE_SCHEMA:-bootr_live}"
case "$role" in
  all | writer | reader) ;;
  *)
    echo "[indexer] INDEXER_ROLE=\"$role\" is not all, writer or reader" >&2
    exit 1
    ;;
esac

if [ "$role" != "all" ] && [ -z "${INDEXER_DATABASE_URL:-}" ]; then
  echo "[indexer] INDEXER_ROLE=$role needs INDEXER_DATABASE_URL (the views live in Postgres)" >&2
  exit 1
fi

if [ "$role" = "reader" ]; then
  # `ponder serve` exits when its schema does not exist; wait for the first switch instead of restarting in a loop.
  node scripts/live-switch.mjs wait-live
  unset DATABASE_VIEWS_SCHEMA
  echo "[indexer] reader: ponder serve --schema ${live} (port ${PORT:-42069})"
  exec ./node_modules/.bin/ponder serve --schema "$live"
fi

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

if [ "$role" = "writer" ]; then
  # Ponder refuses a second writer on a schema, and that refusal clears the first one's lock flag, so the next attempt
  # gets in beside it (measured, docs/dev/indexer-live-switch-test.md). Wait here instead, without starting Ponder.
  while :; do
    code=0
    node scripts/live-switch.mjs preflight "$schema" || code=$?
    [ "$code" -eq 0 ] && break
    if [ "$code" -ne 3 ]; then
      echo "[indexer] writer preflight failed; not starting" >&2
      exit 1
    fi
    sleep 10
  done
  switch="${INDEXER_SWITCH:-auto}"
  case "$switch" in
    auto)
      unset DATABASE_VIEWS_SCHEMA
      node scripts/live-switch.mjs watch "$schema" &
      ;;
    manual)
      unset DATABASE_VIEWS_SCHEMA
      ;;
    ponder)
      export DATABASE_VIEWS_SCHEMA="$live"
      ;;
    *)
      echo "[indexer] INDEXER_SWITCH=\"$switch\" is not auto, manual or ponder" >&2
      exit 1
      ;;
  esac
  echo "[indexer] writer: ponder start --schema ${schema} (port ${PORT:-42069}, views ${live}, switch ${switch})"
  exec ./node_modules/.bin/ponder start --schema "$schema"
fi

echo "[indexer] ponder start --schema ${schema} (port ${PORT:-42069})"
exec ./node_modules/.bin/ponder start --schema "$schema"
