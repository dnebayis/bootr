#!/usr/bin/env sh
# Applies the Postgres migrations of sender, inference and supervisor, in that order, to DATABASE_URL.
#
# Each service keeps its own journal (public.sender_migrations, drizzle.__drizzle_migrations,
# public.sv_migrations), so re-running is a no-op once everything is applied. The indexer (Ponder)
# manages its own schema at startup and is not migrated here.
#
# Usage, from a checkout with `pnpm install` done:
#   DATABASE_URL=postgres://... ./scripts/railway-migrate.sh
#   pnpm db:migrate                          # same, via the root package.json
#
# Against Railway from a laptop (the private *.railway.internal host is not reachable from outside,
# so use the Postgres service's public URL):
#   railway run --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" ./scripts/railway-migrate.sh'
#
# Inside a deployed image (railway ssh), each service can migrate itself instead:
#   sender: node dist/db/migrate.js   inference: node scripts/migrate.mjs   supervisor: node dist/db/migrate.js
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "railway-migrate: DATABASE_URL is not set" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Print the target without credentials.
target=$(printf '%s' "$DATABASE_URL" | sed -E 's#^([a-z]+://)[^@/]*@#\1***@#')
echo "railway-migrate: target ${target}"

echo "railway-migrate: [1/3] sender"
pnpm --filter sender db:migrate

echo "railway-migrate: [2/3] inference"
pnpm --filter @bootr/inference db:migrate

echo "railway-migrate: [3/3] supervisor"
pnpm --filter supervisor db:migrate

echo "railway-migrate: done"
