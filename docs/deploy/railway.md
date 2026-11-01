# Railway (retired 2026-11-01)

Bootr ran on Railway from the first mainnet deploy (2026-10-27) until 2026-11-01, when the services moved to a
single Coolify server: [`coolify.md`](./coolify.md) is the production runbook now. This page keeps what is still
useful from the Railway era; everything operational (variables, deploys, backups, domains) is in the Coolify
runbook, and the service roles, images and variable names did not change with the move.

## What the Railway layout was

One project `bootr`, environment `production`, six services: `web` (`bootr.fun`, `www.bootr.fun`, volume
`web-data` at `/data`), `sender` (`api.bootr.fun`), `inference` (internal), `supervisor` (internal, one replica),
`indexer` (`indexer.bootr.fun`) and a Railway Postgres. Images were the same Dockerfiles under `apps/*`;
services talked over `*.railway.internal`; migrations ran as pre-deploy commands; the indexer used one Postgres
schema per deployment (`RAILWAY_DEPLOYMENT_ID`, still honoured by `apps/indexer/scripts/start.sh` when
`DATABASE_SCHEMA` is unset) so the previous index kept serving until the new one reported `/ready`. The services
were declared as Railway IaC in `.railway/railway.ts` (removed with the move; `git log -- .railway` has it).

The DNS records Railway asked for (replaced by `A` records to the server on 2026-11-01): apex `ALIAS` to
`1nw3vc4e.up.railway.app`, `www` → `3zsp2g23.up.railway.app`, `api` → `6tykq0qo.up.railway.app`, `indexer` →
`8rb2p9br.up.railway.app`.

## Why it moved

Cost and control: one VPS carries the whole stack for a fraction of the price, Coolify gives the same push-to-deploy
flow, and the server also hosts the operator's agent (Hermes). The Railway project was emptied (every deployment
removed) on 2026-11-01; its Postgres stayed as a cold fallback for a week and the project is to be deleted after
that. Nothing was migrated from its database: the platform had no live agents at the time, and the admin console
config was re-entered on the new server.

## Lessons that carried over

- Railway's per-deployment indexer schemas avoided downtime on reindexes; the single server uses a fixed schema
  (`bootr_v1`), so a schema bump costs about an hour without token data (coolify.md section 2).
- Railway started the new supervisor before stopping the old one (two tick loops for a few seconds); Docker
  Compose stops the old container first.
- Railway volumes were root-owned and needed `RAILWAY_RUN_UID=0` on `web`; a Docker named volume inherits the
  image's `node` ownership of `/data` and needs nothing.
- A CDP paymaster was configured on Railway at first; the gas model is self-funded since 2026-10-29 and
  creator-funded since 2026-11-01 ([`../gas-model.md`](../gas-model.md)).
