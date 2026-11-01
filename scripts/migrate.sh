#!/usr/bin/env sh
# Applies the Postgres migrations of sender, inference and supervisor, in that order, to DATABASE_URL.
#
# Each service keeps its own journal (public.sender_migrations, drizzle.__drizzle_migrations,
# public.sv_migrations), so re-running is a no-op once everything is applied. The indexer (Ponder)
# manages its own schema at startup and is not migrated here.
#
# Usage, from a checkout with `pnpm install` done:
#   DATABASE_URL=postgres://... ./scripts/migrate.sh
#   pnpm db:migrate                          # same, via the root package.json
#
# In production (docs/deploy/coolify.md) the containers migrate themselves at start:
#   sender: node dist/db/migrate.js   inference: node scripts/migrate.mjs   supervisor: node dist/db/migrate.js
# so this script is for a laptop or a one-off run against a database URL you can reach.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "migrate: DATABASE_URL is not set" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Print the target without credentials.
target=$(printf '%s' "$DATABASE_URL" | sed -E 's#^([a-z]+://)[^@/]*@#\1***@#')
echo "migrate: target ${target}"

echo "migrate: [1/3] sender"
pnpm --filter sender db:migrate

echo "migrate: [2/3] inference"
pnpm --filter @bootr/inference db:migrate

echo "migrate: [3/3] supervisor"
pnpm --filter supervisor db:migrate

echo "migrate: done"
