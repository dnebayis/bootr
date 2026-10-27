# Deploying Bootr on Railway

Runbook for running the five Bootr services on [Railway](https://railway.com) with the production
domain `bootr.fun`. Every service is built from its own Dockerfile (`apps/<app>/Dockerfile`, build
context = repository root) and configured by its own config-as-code file (`apps/<app>/railway.json`).

## 1. Project layout

One Railway project, one environment per network (for example `sepolia` and `production`), six services:

| Service name (exact) | Source | Public domain | Listens on | Private address |
| --- | --- | --- | --- | --- |
| `web` | `apps/web/Dockerfile` | `bootr.fun` (and `www.bootr.fun`, optional) | `PORT=3000` | `http://web.railway.internal:3000` |
| `sender` | `apps/sender/Dockerfile` | `api.bootr.fun` | `PORT=3002` | `http://sender.railway.internal:3002` |
| `inference` | `apps/inference/Dockerfile` | none (internal) | `INFERENCE_PORT=3003` | `http://inference.railway.internal:3003` |
| `supervisor` | `apps/supervisor/Dockerfile` | none (internal) | `SUPERVISOR_PORT=3004` | `http://supervisor.railway.internal:3004` |
| `indexer` | `apps/indexer/Dockerfile` | `indexer.bootr.fun` | `PORT=42069` | `http://indexer.railway.internal:42069` |
| `Postgres` | Railway Postgres template | none | 5432 | `${{Postgres.DATABASE_URL}}` |

The service name is the private DNS name, so keep the names above (or adjust every `*.railway.internal`
URL below).

### Service settings (each app service)

1. **New service → GitHub repo** (this repository), branch `main`.
2. **Settings → Source → Root directory**: leave empty (`/`). The Dockerfiles need the whole workspace.
3. **Settings → Config-as-code → Railway config file**: `/apps/<app>/railway.json`. It sets the builder
   (`DOCKERFILE`), `dockerfilePath`, watch paths, start command, pre-deploy command, healthcheck,
   restart policy and draining time. Values in the file override the dashboard.
4. **Variables**: see section 3. Set `PORT` on **every** service to the port in the table above, including
   `inference` and `supervisor` (they listen on `INFERENCE_PORT` / `SUPERVISOR_PORT`, but Railway runs the
   deploy healthcheck against `PORT`).
5. **Networking**: generate/attach public domains only for `web`, `sender` and `indexer` (section 4). The
   target port of each domain is the service's `PORT`.

What each `railway.json` does:

| Service | Pre-deploy (release) command | Healthcheck | Notes |
| --- | --- | --- | --- |
| `sender` | `node dist/db/migrate.js` | `/health`, 60 s | draining 20 s |
| `inference` | `node scripts/migrate.mjs` | `/health`, 60 s | draining 30 s |
| `supervisor` | `node dist/db/migrate.js` | `/health`, 60 s | `numReplicas: 1`, overlap 0 s, draining 40 s (the shutdown waits up to 30 s for the running tick) |
| `indexer` | none (Ponder owns its schema) | `/ready`, 3600 s | see section 6 |
| `web` | none | `/api/health`, 60 s | `requiredMountPath: /data` (admin config volume) |

The pre-deploy command runs inside the freshly built image, with the service's variables and private
networking, before the new deployment starts. If it fails, the deployment fails and the previous one keeps
running.

### Images

All images: `node:24-bookworm-slim`, pnpm through corepack (version from the root `package.json`),
`pnpm fetch` layer keyed on `pnpm-lock.yaml`, `pnpm install --frozen-lockfile --offline --filter <app>...`,
a production-only `node_modules` installed from the same lockfile, non-root `node` user, Docker
`HEALTHCHECK` on the liveness endpoint. Build locally from the repo root:

```sh
docker build -f apps/<app>/Dockerfile -t bootr-<app> .
```

The web image needs the `NEXT_PUBLIC_*` values as build args (Railway passes service variables to every
`ARG` the Dockerfile declares, so set them as normal service variables).

## 2. Order of first deployment

1. Create the project and the `Postgres` service (Railway Postgres template). Enable backups.
2. Create the five app services with the settings above and their variables (section 3). Do not attach
   domains yet.
3. Migrations. They run automatically as the pre-deploy command of `sender`, `inference` and `supervisor`.
   To apply them all at once before the first deploy (or by hand at any time), run from a checkout with
   `pnpm install` done:

   ```sh
   railway link            # select the project + environment
   railway run --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" ./scripts/railway-migrate.sh'
   # or: DATABASE_URL=postgres://... pnpm db:migrate
   ```

   `scripts/railway-migrate.sh` applies sender → inference → supervisor in that order. Each service keeps
   its own journal (`public.sender_migrations`, `drizzle.__drizzle_migrations`, `public.sv_migrations`), so
   re-running is a no-op. `*.railway.internal` is not reachable from a laptop, hence `DATABASE_PUBLIC_URL`.
   Inside a running container: `railway ssh --service <svc>` then the command from the table above.
4. Deploy in dependency order: `sender`, `inference`, `indexer` (wait for `/ready`), `web`, `supervisor`
   last (it calls all the others).
5. Attach the domains (section 4), update the X app (section 5), then rebuild `web` if any `NEXT_PUBLIC_*`
   value changed.

## 3. Environment matrix (names only)

Use Railway **shared variables** (`${{shared.NAME}}`) for values that several services need, and reference
variables for Postgres and private URLs. Never paste a secret into a `NEXT_PUBLIC_*` variable, a build arg
or a log line. `.env.example` is the authoritative list; every variable is described there.

### Shared (project-level shared variables)

| Variable | Used by | Value |
| --- | --- | --- |
| `CHAIN_ID` | supervisor, indexer | `84532` (Sepolia) / `8453` (mainnet) |
| `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` | supervisor, indexer, web (SIWE checks) | CDP Node URL (secret: the key is in the path). Indexer accepts a comma-separated list |
| `SENDER_SERVICE_KEY` | sender, supervisor, web, indexer | secret, ≥ 32 chars (`openssl rand -hex 32`) |
| `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS` | supervisor, indexer | deployed contracts |
| `INFERENCE_PAYTO_ADDRESS` | inference, supervisor | relay revenue address |

### Per service

**web** (runtime)

| Kind | Variables |
| --- | --- |
| platform | `PORT=3000`; image defaults `HOSTNAME=::`, `ADMIN_CONFIG_PATH=/data/admin-config.json`, `NODE_ENV=production` |
| secrets | `SESSION_SECRET`, `SENDER_SERVICE_KEY`, `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` |
| config | `ADMIN_CONSOLE_SLUG` (treat as secret: it hides the console), `ADMIN_ADDRESSES`, `SENDER_URL=http://sender.railway.internal:3002` |
| volume | `RAILWAY_RUN_UID=0` (see section 7) |

**web** (build time, public, inlined into the browser bundle)

`NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_SITE_URL=https://bootr.fun`, `NEXT_PUBLIC_INDEXER_URL=https://indexer.bootr.fun`,
`NEXT_PUBLIC_SENDER_PUBLIC_URL=https://api.bootr.fun`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_WC_PROJECT_ID`,
`NEXT_PUBLIC_BUILDER_CODE`, `NEXT_PUBLIC_INFERENCE_URL`, `NEXT_PUBLIC_SWAP_LINK_BASE`, `NEXT_PUBLIC_LAUNCHER_ADDRESS`,
`NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS`, `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY`, `NEXT_PUBLIC_BOOT_X_URL`,
`NEXT_PUBLIC_WORKER_SOURCE_BASE`, `NEXT_PUBLIC_USE_MOCK` (empty in production).

- `NEXT_PUBLIC_RPC_URL` is shipped to every browser: use a public endpoint (or leave it empty), never the
  keyed CDP URL.
- `NEXT_PUBLIC_INFERENCE_URL`: the launch form fetches `<url>/v1/models` **from the browser**. The relay is
  internal and sends no CORS headers, so leave it empty (the form uses its built-in model list) unless the
  relay is exposed publicly with CORS.
- Changing any `NEXT_PUBLIC_*` value requires a rebuild (redeploy) of `web`.

**sender**

| Kind | Variables |
| --- | --- |
| platform | `PORT=3002`, `DATABASE_URL=${{Postgres.DATABASE_URL}}` |
| secrets | `SENDER_SERVICE_KEY`, `SENDER_ENCRYPTION_KEY` (rotating it orphans stored tokens), `X_CLIENT_SECRET` |
| config | `X_CLIENT_ID`, `X_REDIRECT_URI=https://api.bootr.fun/oauth/callback`, `SENDER_OAUTH_RETURN_URL=https://bootr.fun/launch` |
| optional | `SENDER_RECONCILE_INTERVAL_MS`, `SENDER_DEFAULT_POSTS_PER_DAY`, `SENDER_DEFAULT_MENTION_INTERVAL_SEC`, `X_API_BASE_URL`, `X_AUTHORIZE_URL`, `X_TIMEOUT_MS` |

**inference** (internal)

| Kind | Variables |
| --- | --- |
| platform | `PORT=3003`, `INFERENCE_PORT=3003`, `DATABASE_URL=${{Postgres.DATABASE_URL}}` |
| secrets | `OPENROUTER_API_KEY`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `INFERENCE_RPC_URL` (keyed RPC) |
| config | `X402_NETWORK` (`eip155:84532` / `eip155:8453`), `X402_FACILITATOR_URL`, `INFERENCE_PAYTO_ADDRESS` |
| optional | `INFERENCE_X402_SCHEMES`, `INFERENCE_PRICE_TABLE_JSON`, `INFERENCE_UPSTREAM_TIMEOUT_MS`, `INFERENCE_PAYMENT_TIMEOUT_SECONDS` |

**supervisor** (internal, one replica)

| Kind | Variables |
| --- | --- |
| platform | `PORT=3004`, `SUPERVISOR_PORT=3004`, `DATABASE_URL=${{Postgres.DATABASE_URL}}` |
| secrets | `SESSION_SIGNER_PRIVATE_KEY`, `ADMIN_PRIVATE_KEY` (only if the supervisor approves session keys), `SENDER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`, `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL`, `BUNDLER_URL`, `PAYMASTER_URL`, `ENABLE_MODE_BUNDLER_URL`, `ENABLE_MODE_PAYMASTER_URL`, `SEARCH_API_KEY` |
| private URLs | `SENDER_URL=http://sender.railway.internal:3002`, `INFERENCE_PROVIDER_URL=http://inference.railway.internal:3003`, `INDEXER_URL=http://indexer.railway.internal:42069` |
| config | `CHAIN_ID`, `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS`, `LAUNCHER_START_BLOCK`, `INFERENCE_PAYTO_ADDRESS`, `ENABLE_MODE_SELF_BUNDLE`, `BUILDER_CODES_ENABLED`, `BUILDER_CODES_URL` |
| optional | `LAUNCH_LOG_CHUNK_BLOCKS`, `SUPERVISOR_TICK_MS`, `MAX_AGENTS_PER_TICK`, `MAX_TOOL_STEPS`, `CLAIM_THRESHOLD_USD`, `FUEL_TARGET_USDC`, `SWAP_ROUTE`, `SWAP_SLIPPAGE_BPS`, `SEARCH_API_URL`, `SESSION_KEY_VALIDITY_DAYS`, `SESSION_ROTATE_BEFORE_DAYS`, `SESSION_RATE_LIMIT_PER_HOUR`, `SESSION_USDC_TRANSFER_CAP`, `SESSION_GAS_ALLOWANCE_WEI`, `SESSION_1271_CALLERS`, `INFERENCE_TIMEOUT_MS`, `INFERENCE_MAX_OUTPUT_TOKENS`, `USER_OP_RECEIPT_TIMEOUT_MS`, `LOG_LEVEL` |

Nothing calls the supervisor's admin API from another service today; there is no `SUPERVISOR_URL` consumer.
Reach it with `railway ssh` or a temporary private-network client (`http://supervisor.railway.internal:3004`).

**indexer**

| Kind | Variables |
| --- | --- |
| platform | `PORT=42069` (must be set here: the root `.env` uses `PORT` for the sender), `INDEXER_DATABASE_URL=${{Postgres.DATABASE_URL}}` (the indexer deliberately ignores `DATABASE_URL`) |
| schema | `DATABASE_SCHEMA` — leave unset on Railway for one schema per deployment (section 6), or a fixed name |
| secrets | `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL`, `SENDER_SERVICE_KEY` |
| config | `CHAIN_ID`, `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS`, `BOOTR_START_BLOCK`, `INDEXER_CORS_ORIGIN=https://bootr.fun`, `ADMIN_CONFIG_URL=https://bootr.fun/api/admin/config`, `BOOT_TOKEN_ADDRESS` |
| optional | `INDEXER_MAX_RPS` (~25 when sharing a CDP key with the supervisor), `INDEXER_SNAPSHOT_INTERVAL`, `CHAINLINK_ETH_USD_FEED`, `FUEL_SCAN_MAX_RANGE` |

`ADMIN_CONFIG_URL` stays on the public HTTPS origin (the response is trusted as-is, so it should not travel
over plain HTTP). `INDEXER_CORS_ORIGIN` defaults to `https://bootr.fun` when empty; add
`https://www.bootr.fun` if that host serves the app.

## 4. Domains and DNS

| Host | Service | DNS record |
| --- | --- | --- |
| `bootr.fun` | `web` | apex: `CNAME`/`ALIAS`/`ANAME` (CNAME flattening) to the target Railway shows, plus the `_railway-verify` TXT if requested |
| `www.bootr.fun` (optional) | `web` | `CNAME` to the Railway target |
| `api.bootr.fun` | `sender` | `CNAME` to the Railway target |
| `indexer.bootr.fun` | `indexer` | `CNAME` to the Railway target |

Railway issues the TLS certificates once DNS resolves. With Cloudflare in front, use DNS-only (grey cloud)
until the certificate is issued, then "Full (strict)" if proxying.

The sender is public because the browser needs `/oauth/start` and X needs `/oauth/callback`; its
`/internal/*` routes are HMAC-authenticated (`SENDER_SERVICE_KEY`). The indexer is public because the browser
reads GraphQL/REST/SSE from it; its only write route (`POST /internal/agent/:kernel/social`) is
HMAC-authenticated.

## 5. X (Twitter) app

In the X developer portal (the app behind `X_CLIENT_ID`), **User authentication settings**:

- Callback URI / Redirect URL: add `https://api.bootr.fun/oauth/callback` (keep `http://localhost:3002/oauth/callback`
  only on the development app).
- Website URL: `https://bootr.fun`.
- Sender variables: `X_REDIRECT_URI=https://api.bootr.fun/oauth/callback` (must match the portal exactly) and
  `SENDER_OAUTH_RETURN_URL=https://bootr.fun/launch`.

## 6. Indexer schema and deploys

Ponder refuses to start on a schema that was created by different indexing code ("previously used by a
different Ponder app"), and only one process may hold a schema's lock. `apps/indexer/scripts/start.sh` picks
the schema:

- **Default on Railway (`DATABASE_SCHEMA` unset)**: `--schema $RAILWAY_DEPLOYMENT_ID`. Each deployment backfills
  into a fresh schema while the previous deployment keeps serving; Railway switches traffic once `/ready`
  returns 200 (healthcheck timeout 3600 s). If the backfill takes longer than an hour the deploy is marked
  failed and the old one keeps running; raise `INDEXER_MAX_RPS` / RPC capacity or use a fixed schema.
  Drop inactive schemas periodically: `railway ssh --service indexer` then `./node_modules/.bin/ponder db list`
  and `./node_modules/.bin/ponder db prune`. Keep the previous schema until the new deploy is confirmed (it
  is what a rollback resumes from).
- **Fixed schema (`DATABASE_SCHEMA=bootr_v1`)**: restarts resume where they stopped, but every change to the
  indexer code requires a new name (`bootr_v2`, ...), and the new deploy reindexes from `BOOTR_START_BLOCK`.

`/health` (process up) is the Docker liveness check; `/ready` (backfill complete) is the Railway deploy gate.

## 7. Web admin config volume

`/api/admin/config` stores the platform config in a JSON file (`ADMIN_CONFIG_PATH`, image default
`/data/admin-config.json`). Without a volume, every redeploy resets it to the defaults.

1. `web` → **Add volume**, mount path `/data` (`railway.json` declares `requiredMountPath: /data`, so a deploy
   without it fails).
2. Railway mounts volumes owned by root, and the image runs as `node`; set `RAILWAY_RUN_UID=0` on `web` so the
   process can write the file (this runs the web process as root inside the container).
3. A volume pins the service to one replica and adds a few seconds of downtime per deploy. The file store
   does not work with several `web` replicas; moving it to Postgres (the TODO in `lib/server/admin-config.ts`)
   removes both limits.

## 8. Coinbase Developer Platform (CDP)

- One CDP project provides the RPC (`BASE_*_RPC_URL`), bundler/paymaster (`BUNDLER_URL` = `PAYMASTER_URL`)
  and the x402 facilitator (`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`).
- Paymaster policy allow-list: `BootrLauncher`, `AgentGuardian`, the Clanker fee locker, Universal Router,
  USDC and WETH on the target chain (mainnet addresses differ from Sepolia).
- Railway egress IPs are not static by default. If the CDP secret API key (or any provider) uses an IP
  allow-list, enable **Static Outbound IPs** on `supervisor`, `inference` and `indexer` and allow-list those
  addresses; otherwise leave IP restrictions off and rely on key scoping.
- The CDP RPC URL contains the key: keep it out of `NEXT_PUBLIC_RPC_URL`, logs and screenshots. Use separate
  keys (or at least separate rate budgets) for indexer and supervisor; `INDEXER_MAX_RPS` keeps the indexer
  under the shared quota.

## 9. Logs and secrets hygiene

- Secrets live only in Railway variables (sealed variables for keys: they cannot be read back in the UI).
  `.env` files are excluded from every image by `.dockerignore`; the images contain no secrets and the web
  build args are public values only.
- Services log to stdout (sender/supervisor JSON via their loggers, Ponder pretty logs). Do not raise log
  levels in production in a way that prints request bodies; the services never log tokens or keys by design,
  keep it that way when adding logs.
- `scripts/railway-migrate.sh` masks the password when it prints the target URL.
- Rotate `SENDER_SERVICE_KEY` on all four services at once (web, sender, supervisor, indexer), then redeploy.
  `SENDER_ENCRYPTION_KEY` cannot be rotated without re-connecting every X account.
- Restrict project membership; Railway "viewer" members can still see non-sealed variables.

## 10. Rollback

- Railway → service → Deployments → a previous successful deployment → **Rollback**. It redeploys that image
  with its variables.
- Database migrations are forward-only (drizzle has no down migrations). Keep migrations backward-compatible
  (add columns/tables first, remove in a later release) so the previous image still runs against the newer
  schema. Take a Postgres backup before any release that contains a migration.
- Indexer: with per-deployment schemas a rollback runs the old code; point `DATABASE_SCHEMA` at that
  deployment's schema (from `ponder db list`) if it still exists to avoid a reindex, otherwise it backfills
  again.
- Web: `NEXT_PUBLIC_*` values are baked into each image, so a rollback also restores the old public values.

## 11. Mainnet pre-flight checklist

- [ ] `CHAIN_ID=8453` on supervisor and indexer; `NEXT_PUBLIC_CHAIN_ID=8453` and a rebuilt `web`.
- [ ] `BASE_RPC_URL` set (CDP mainnet Node URL), archive-capable for the indexer backfill; `NEXT_PUBLIC_RPC_URL`
      public or empty.
- [ ] `packages/shared/src/addresses.ts` mainnet entries re-verified on-chain (Clanker v4, fee lockers,
      PoolManager, USDC, WETH, Universal Router, ERC-8004 registries — currently `null` on mainnet, so
      reputation indexing is skipped), and the Bootr mainnet launcher/guardian/burner recorded.
- [ ] `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS`, `BOOTR_START_BLOCK` (indexer) and `LAUNCHER_START_BLOCK`
      (supervisor) set to the mainnet deployment; `NEXT_PUBLIC_LAUNCHER_ADDRESS`,
      `NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS`, `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY` match.
- [ ] Indexer on a new schema (new deployment or new `DATABASE_SCHEMA`); expect a long backfill (on Base
      mainnet every v4 `Swap` log is fetched). `INDEXER_MAX_RPS` sized for the RPC plan.
- [ ] `X402_NETWORK=eip155:8453`, `X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`,
      `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`, `INFERENCE_RPC_URL` (mainnet), `INFERENCE_PAYTO_ADDRESS` (mainnet
      treasury), `INFERENCE_PRICE_TABLE_JSON` reviewed, OpenRouter key spend limit set.
- [ ] `BUNDLER_URL` / `PAYMASTER_URL` mainnet endpoints, paymaster policy allow-list updated for mainnet
      addresses; `ENABLE_MODE_*` reviewed; `SWAP_ROUTE` valid on mainnet.
- [ ] Session-key policy knobs reviewed (`SESSION_USDC_TRANSFER_CAP`, `SESSION_GAS_ALLOWANCE_WEI`,
      `SESSION_RATE_LIMIT_PER_HOUR`, `SESSION_1271_CALLERS`, `SESSION_KEY_VALIDITY_DAYS`).
- [ ] Fresh production secrets (not reused from Sepolia): `SESSION_SIGNER_PRIVATE_KEY`, `ADMIN_PRIVATE_KEY` (or
      unset), `SENDER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`, `SESSION_SECRET`, `SENDER_ENCRYPTION_KEY`,
      `ADMIN_CONSOLE_SLUG`; `ADMIN_ADDRESSES` = production admin wallets.
- [ ] `NEXT_PUBLIC_BUILDER_CODE` registered for the mainnet platform wallet; `BUILDER_CODES_ENABLED` as intended.
- [ ] X app callback `https://api.bootr.fun/oauth/callback`, `X_REDIRECT_URI`, `SENDER_OAUTH_RETURN_URL=https://bootr.fun/launch`.
- [ ] `INDEXER_CORS_ORIGIN=https://bootr.fun` (and `www` if used); `ADMIN_CONFIG_URL=https://bootr.fun/api/admin/config`.
- [ ] Web volume mounted at `/data`, `RAILWAY_RUN_UID=0`, admin config saved once from the console.
- [ ] Postgres backups enabled; migrations applied (`railway-migrate.sh` or pre-deploy logs show "migrations applied").
- [ ] Smoke: `https://bootr.fun/api/health`, `https://api.bootr.fun/health`, `https://indexer.bootr.fun/ready`,
      supervisor logs show ticks, a test launch end to end on a small amount.

## 12. Known limitations

- **Supervisor deploy overlap.** Railway starts the new supervisor before stopping the old one, so for a few
  seconds two tick loops can run. Per-agent work is guarded by the 60 s runtime lease, but there is no
  process-wide lock; deploy the supervisor when no on-chain operation is pending, and keep `numReplicas: 1`.
- **Inference shutdown** closes the server and the database right away on SIGTERM; a paid request in flight
  during a deploy can end up `unknown` and is settled by reconciliation (`GET /v1/requests/:key`).
- **Ponder answers CORS preflights itself** with `*`; `INDEXER_CORS_ORIGIN` is enforced on the actual response
  (allowed origins are echoed, others get no `Access-Control-Allow-Origin`), which is what browsers check.
- **`/public/posts/:kernel`**: the web reads it from the sender (`NEXT_PUBLIC_SENDER_PUBLIC_URL`), but the sender
  has no such route yet, so recent posts are not shown.
