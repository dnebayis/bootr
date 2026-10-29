# Deploying Bootr on Railway

Runbook for running the five Bootr services on [Railway](https://railway.com) with the production
domain `bootr.fun`. Every service is built from its own Dockerfile (`apps/<app>/Dockerfile`, build
context = repository root). The project itself (services, build and deploy settings, volumes) is declared
as Railway **Infrastructure as Code** in [`.railway/railway.ts`](../../.railway/railway.ts) and applied with
the CLI. Railway's older config-as-code files (`railway.json`) are deprecated and are not read for new
services, so none exist in this repository any more.

## 1. Project layout

One Railway project (`bootr`, workspace `someone`, environment `production` = Base mainnet), six services:

| Service name (exact) | Source | Public domain | Listens on | Private address |
| --- | --- | --- | --- | --- |
| `web` | `apps/web/Dockerfile` | `bootr.fun`, `www.bootr.fun` | `PORT=3000` | `http://web.railway.internal:3000` |
| `sender` | `apps/sender/Dockerfile` | `api.bootr.fun` | `PORT=3002` | `http://sender.railway.internal:3002` |
| `inference` | `apps/inference/Dockerfile` | none (internal) | `INFERENCE_PORT=3003` | `http://inference.railway.internal:3003` |
| `supervisor` | `apps/supervisor/Dockerfile` | none (internal) | `SUPERVISOR_PORT=3004` | `http://supervisor.railway.internal:3004` |
| `indexer` | `apps/indexer/Dockerfile` | `indexer.bootr.fun` | `PORT=42069` | `http://indexer.railway.internal:42069` |
| `Postgres` | Railway Postgres template | none | 5432 | `${{Postgres.DATABASE_URL}}` |

The service name is the private DNS name, so keep the names above (or adjust every `*.railway.internal`
URL below).

### Infrastructure as Code (`.railway/railway.ts`)

The file declares, per service: Dockerfile builder and path, watch patterns, start command, pre-deploy
(release) command, healthcheck path and timeout, replicas (one each; the supervisor must never run twice),
draining/overlap seconds and the restart policy, plus the `web-data` volume mounted at `/data` on `web`.
Variables are **unmanaged** (`variables: { managed: false }`): they are set with `railway variable set`
(section 3) and never written to the repository. Custom domains cannot be registered from IaC; attach them
with `railway domain` (section 4).

```sh
pnpm install                 # the file imports the `railway` SDK (workspace dev dependency)
railway link                 # once per checkout: project bootr, environment production
railway config plan          # diff against Railway
railway config apply --yes   # apply (add --confirm-destructive for destructive changes)
railway config pull --variables=unmanaged   # re-import after dashboard edits
```

What the IaC gives each service:

| Service | Pre-deploy (release) command | Healthcheck | Notes |
| --- | --- | --- | --- |
| `sender` | `node dist/db/migrate.js` | `/health`, 300 s | draining 20 s |
| `inference` | `node scripts/migrate.mjs` | `/health`, 300 s | draining 30 s |
| `supervisor` | `node dist/db/migrate.js` | `/health`, 300 s | 1 replica, overlap 0 s, draining 40 s (the shutdown waits up to 30 s for the running tick) |
| `indexer` | none (Ponder owns its schema) | `/ready`, 3600 s | see section 6 |
| `web` | none | `/api/health`, 300 s | volume `web-data` at `/data` (admin config, launch drafts) |

The pre-deploy command runs inside the freshly built image, with the service's variables and private
networking, before the new deployment starts. If it fails, the deployment fails and the previous one keeps
running.

### Deploying code

The repository has no GitHub remote, so services are deployed from a local checkout with `railway up`
(the CLI uploads the working tree minus `.gitignore` and `.railwayignore` paths, Railway builds the
Dockerfile):

```sh
railway up --service sender --detach --ci     # one upload + build per service
railway up --service inference --detach --ci
railway up --service indexer --detach --ci
railway up --service web --detach --ci
railway up --service supervisor --detach --ci
railway service status                        # or: railway service logs --service <svc>
```

`.railwayignore` keeps `brand/`, `docs/`, Foundry artifacts and build output out of the upload. If the
repository gets a GitHub remote later, connect it with `railway service source connect --repo <owner/repo>
--branch main --service <svc>` and the watch patterns in the IaC file decide which pushes rebuild which service.

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

1. `railway init --name bootr`, `railway add --database postgres`, then `railway add --service <name>` for
   the five app services (empty services; the IaC file fills in their settings). Enable Postgres backups.
2. `railway config apply`, then set the variables (section 3). Do not attach domains yet.
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
4. Deploy with `railway up --service <svc>` in dependency order: `sender`, `inference`, `indexer` (wait for
   `/ready`), `web`, `supervisor` last (it calls all the others). Builds are independent, so they can run
   in parallel; the order only matters for the first healthchecks.
5. Attach the domains (section 4), update the X app (section 5), then rebuild `web` if any `NEXT_PUBLIC_*`
   value changed.

## 3. Environment matrix (names only)

Use Railway **shared variables** (`${{shared.NAME}}`) for values that several services need, and reference
variables for Postgres and private URLs. Never paste a secret into a `NEXT_PUBLIC_*` variable, a build arg
or a log line. `.env.example` is the authoritative list; every variable is described there.

The RWAGMI v3 launcher, hook, locker and dev-buy addresses (names above) exist on **Base mainnet only**. There
is no RWAGMI v3 deployment on Base Sepolia, so on a Sepolia environment those variables stay empty and
launching a coin is not possible there (see "Local development" below). Coins launched before 2026-10-29 are on
Clanker v4 (history: `docs/deploy/mainnet.md`); the indexer and the supervisor follow RWAGMI launches only, from
block 53219209 (`BOOTR_START_BLOCK` / `LAUNCHER_START_BLOCK`).

### Shared (project-level shared variables)

| Variable | Used by | Value |
| --- | --- | --- |
| `CHAIN_ID` | supervisor, indexer | `84532` (Sepolia) / `8453` (mainnet) |
| `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` | supervisor, indexer, web (SIWE checks) | CDP Node URL (secret: the key is in the path). Indexer accepts a comma-separated list |
| `SENDER_SERVICE_KEY` | sender, supervisor, web | secret, ≥ 32 chars (`openssl rand -hex 32`) |
| `INDEXER_SERVICE_KEY` | indexer, supervisor, web | secret, ≥ 32 chars, distinct from the others (the indexer still accepts `SENDER_SERVICE_KEY` with a deprecation warning) |
| `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS` | supervisor, indexer | deployed contracts |
| `RWAGMI_LAUNCHER_V3_ADDRESS`, `RWAGMI_LOCKER_V3_ADDRESS` | supervisor, indexer | RWAGMI v3 launch stack on Base mainnet (`.env.mainnet.example` has the verified values) |
| `INFERENCE_PAYTO_ADDRESS` | inference, supervisor | relay revenue address |

### Per service

**web** (runtime)

| Kind | Variables |
| --- | --- |
| platform | `PORT=3000`; image defaults `HOSTNAME=::`, `ADMIN_CONFIG_PATH=/data/admin-config.json`, `LAUNCH_DRAFTS_DIR=/data/launch-drafts`, `NODE_ENV=production` |
| secrets | `SESSION_SECRET`, `SENDER_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `BASE_RPC_URL` |
| config | `ADMIN_CONSOLE_SLUG` (treat as secret: it hides the console; a bare random slug, the URL is `/console-<slug>/signin`), `ADMIN_ADDRESSES`, `SENDER_URL=http://sender.railway.internal:3002` |
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
| secrets | `SESSION_SIGNER_PRIVATE_KEY`, `SPENDER_MASTER_KEY`, `ADMIN_PRIVATE_KEY` (only if the supervisor approves session keys), `SENDER_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`, `BASE_RPC_URL`, `BUNDLER_URL`, `PAYMASTER_URL`, `ENABLE_MODE_BUNDLER_URL`, `ENABLE_MODE_PAYMASTER_URL`, `SEARCH_API_KEY` |
| private URLs | `SENDER_URL=http://sender.railway.internal:3002`, `INFERENCE_PROVIDER_URL=http://inference.railway.internal:3003`, `INDEXER_URL=http://indexer.railway.internal:42069` |
| config | `CHAIN_ID`, `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS`, `LAUNCHER_START_BLOCK`, `RWAGMI_LAUNCHER_V3_ADDRESS`, `RWAGMI_LOCKER_V3_ADDRESS` (claims go through the locker, the launch is decoded from the launcher), `INFERENCE_PAYTO_ADDRESS`, `PLATFORM_TREASURY_ADDRESS`, `ENABLE_MODE_SELF_BUNDLE`, `GAS_BOOTSTRAP_WEI`, `GAS_MIN_WEI`, `GAS_TARGET_WEI` (self-funded gas; `PAYMASTER_URL` empty), `BUILDER_CODES_ENABLED`, `BUILDER_CODES_URL` |
| optional | `LAUNCH_LOG_CHUNK_BLOCKS`, `SUPERVISOR_TICK_MS`, `MAX_AGENTS_PER_TICK`, `MAX_TOOL_STEPS`, `CLAIM_THRESHOLD_USD`, `FUEL_TARGET_USDC`, `SPENDER_MIN_USDC`, `SPENDER_TARGET_USDC`, `SWAP_SLIPPAGE_BPS`, `CHAINLINK_MAX_AGE_SECONDS`, `SEARCH_API_URL`, `SESSION_KEY_VALIDITY_DAYS`, `SESSION_ROTATE_BEFORE_DAYS`, `SESSION_RATE_LIMIT_PER_HOUR`, `SESSION_USDC_TRANSFER_CAP`, `SESSION_USDC_WINDOW_SECONDS`, `SESSION_GAS_ALLOWANCE_WEI`, `ENABLE_MODE_MAX_PREFUND_WEI`, `INFERENCE_TIMEOUT_MS`, `INFERENCE_MAX_OUTPUT_TOKENS`, `USER_OP_RECEIPT_TIMEOUT_MS`, `LOG_LEVEL` |

Nothing calls the supervisor's admin API from another service today; there is no `SUPERVISOR_URL` consumer.
Reach it with `railway ssh` or a temporary private-network client (`http://supervisor.railway.internal:3004`).

**indexer**

| Kind | Variables |
| --- | --- |
| platform | `PORT=42069` (must be set here: the root `.env` uses `PORT` for the sender), `INDEXER_DATABASE_URL=${{Postgres.DATABASE_URL}}` (the indexer deliberately ignores `DATABASE_URL`) |
| schema | `DATABASE_SCHEMA` — leave unset on Railway for one schema per deployment (section 6), or a fixed name |
| secrets | `BASE_RPC_URL`, `INDEXER_SERVICE_KEY` |
| config | `CHAIN_ID`, `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS`, `BOOTR_START_BLOCK`, `RWAGMI_LAUNCHER_V3_ADDRESS`, `RWAGMI_LOCKER_V3_ADDRESS`, `RWAGMI_HOOK_V3_ADDRESS`, `RWAGMI_DEV_BUY_V3_ADDRESS`, `INDEXER_CORS_ORIGIN=https://bootr.fun`, `ADMIN_CONFIG_URL=https://bootr.fun/api/admin/config`, `BOOT_TOKEN_ADDRESS` |
| optional | `INDEXER_MAX_RPS` (~25 when sharing a CDP key with the supervisor), `INDEXER_SNAPSHOT_INTERVAL`, `CHAINLINK_ETH_USD_FEED`, `FUEL_SCAN_MAX_RANGE` |

`ADMIN_CONFIG_URL` stays on the public HTTPS origin (the response is trusted as-is, so it should not travel
over plain HTTP). `INDEXER_CORS_ORIGIN` defaults to `https://bootr.fun` when empty; add
`https://www.bootr.fun` if that host serves the app.

### Local development

Launching a coin needs the RWAGMI v3 stack and Base's B20 precompiles, which only exist on Base mainnet. Local
development against Base Sepolia is therefore no longer possible for launches; Sepolia still works for everything
that does not launch (sender, inference, x402, web shell). The dev path for the launch flow is a **Base mainnet fork**
with Base's Foundry binaries (`base-forge`, `base-anvil`):

```sh
# contract tests: the fork tests create their own mainnet fork from BASE_RPC_URL (default https://mainnet.base.org)
cd packages/contracts && BASE_RPC_URL="$BASE_RPC_URL" base-forge test

# a forked node for a local service stack
base-anvil --fork-url "$BASE_RPC_URL" --chain-id 8453 --port 8545
```

Point a local stack at the fork with `BASE_RPC_URL=http://127.0.0.1:8545`, `CHAIN_ID=8453`, the mainnet
`RWAGMI_*_V3_ADDRESS` values from `.env.mainnet.example` and the addresses of a Bootr launcher deployed onto the
fork (`script/Deploy.s.sol`). The fork keeps its state in memory: redeploy the Bootr contracts and restart the indexer
on a fresh schema after each restart. End to end against real infrastructure, test with a small coin on mainnet.

## 4. Domains and DNS

Attach each host with the CLI (IaC cannot register custom domains):

```sh
railway domain bootr.fun --service web --port 3000
railway domain www.bootr.fun --service web --port 3000
railway domain api.bootr.fun --service sender --port 3002
railway domain indexer.bootr.fun --service indexer --port 42069
railway domain status <host> --service <svc> --json   # required DNS records + certificate state
```

Records Railway asked for on 2026-10-27 (the targets are per-domain and stable; re-read them with
`railway domain status` if a domain is ever deleted and re-added):

| Host | Service | Type | Name (Namecheap) | Value |
| --- | --- | --- | --- | --- |
| `bootr.fun` | `web` | `ALIAS` (apex; `CNAME`/`ANAME` with flattening elsewhere) | `@` | `1nw3vc4e.up.railway.app` |
| `www.bootr.fun` | `web` | `CNAME` | `www` | `3zsp2g23.up.railway.app` |
| `api.bootr.fun` | `sender` | `CNAME` | `api` | `6tykq0qo.up.railway.app` |
| `indexer.bootr.fun` | `indexer` | `CNAME` | `indexer` | `8rb2p9br.up.railway.app` |

Railway-provided domains (created with the API's `serviceDomainCreate`; kept for smoke tests before DNS
moves and as a fallback): `web-production-cf4e5.up.railway.app`, `sender-production-0670.up.railway.app`,
`indexer-production-caef.up.railway.app`. The browser bundle points at the custom hosts, so the site is
only fully functional once DNS resolves.

Remove Namecheap's parking records first (`www` currently points at `parkingpage.namecheap.com`, and the
apex has a URL-redirect record). If Railway reports `VALIDATING_OWNERSHIP` for long, it may additionally ask
for a `TXT` record at `_railway-verify[.<sub>]` with the `railway-verify=…` token from `railway domain
status`. Railway issues the TLS certificates once DNS resolves. With Cloudflare in front, use DNS-only
(grey cloud) until the certificate is issued, then "Full (strict)" if proxying.

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

## 7. Web data volume (admin config, launch drafts)

`/api/admin/config` stores the platform config in a JSON file (`ADMIN_CONFIG_PATH`, image default
`/data/admin-config.json`). Without a volume, every redeploy resets it to the defaults. The same volume holds
the launch drafts (`LAUNCH_DRAFTS_DIR`, image default `/data/launch-drafts`): the creator's Identity text per
launch, which the agent card serves to the supervisor (`docs/agent-identity.md`). Without a volume, a redeploy
between a launch and the supervisor's first card read leaves that agent with the default persona.

1. The IaC file declares the `web-data` volume mounted at `/data` on `web` (`railway config apply` creates it).
2. Railway mounts volumes owned by root, and the image runs as `node`; set `RAILWAY_RUN_UID=0` on `web` so the
   process can write the file (this runs the web process as root inside the container).
3. A volume pins the service to one replica and adds a few seconds of downtime per deploy. The file store
   does not work with several `web` replicas; moving it to Postgres (the TODO in `lib/server/admin-config.ts`)
   removes both limits.

## 8. Coinbase Developer Platform (CDP)

- One CDP project provides the RPC (`BASE_*_RPC_URL`), the bundler (`BUNDLER_URL`) and the x402 facilitator
  (`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`). No paymaster: agents pay their own gas (`PAYMASTER_URL` empty, the
  `GAS_*` knobs; `docs/deploy/mainnet.md` section 1, "Gas model").
- Paymaster policy allow-list (only if a paymaster is ever configured): `BootrLauncher`, `AgentGuardian`,
  `BootrSwapHelper`, the `RwagmiLpLockerV3` (`settleAndClaim` / `claimQuote`), USDC and WETH (exact table:
  `docs/deploy/mainnet.md` section 1).
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
- Service settings: `railway config plan` shows any drift between `.railway/railway.ts` and Railway.

## 11. Mainnet pre-flight checklist

- [ ] `CHAIN_ID=8453` on supervisor and indexer; `NEXT_PUBLIC_CHAIN_ID=8453` and a rebuilt `web`.
- [ ] `BASE_RPC_URL` set (CDP mainnet Node URL), archive-capable for the indexer backfill; `NEXT_PUBLIC_RPC_URL`
      public or empty.
- [ ] `packages/shared/src/addresses.ts` mainnet entries re-verified on-chain (RWAGMI v3 launcher, hook,
      locker and dev buy; PoolManager, USDC, WETH, Universal Router, ERC-8004 registries), and the Bootr mainnet
      launcher/guardian/burner/call policy/swap helper recorded.
- [ ] `RWAGMI_LAUNCHER_V3_ADDRESS`, `RWAGMI_LOCKER_V3_ADDRESS` (supervisor, indexer), `RWAGMI_HOOK_V3_ADDRESS`,
      `RWAGMI_DEV_BUY_V3_ADDRESS` (indexer) match the verified
      contracts on Basescan.
- [ ] `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS`, `BOOTR_START_BLOCK` (indexer) and `LAUNCHER_START_BLOCK`
      (supervisor) set to the mainnet deployment; `NEXT_PUBLIC_LAUNCHER_ADDRESS`,
      `NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS`, `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY` match.
- [ ] Indexer on a new schema (new deployment or new `DATABASE_SCHEMA`); expect a long backfill (on Base
      mainnet every v4 `Swap` log is fetched). `INDEXER_MAX_RPS` sized for the RPC plan.
- [ ] `X402_NETWORK=eip155:8453`, `X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`,
      `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`, `INFERENCE_RPC_URL` (mainnet), `INFERENCE_PAYTO_ADDRESS` (mainnet
      treasury), `INFERENCE_PRICE_TABLE_JSON` reviewed, OpenRouter key spend limit set.
- [ ] `BUNDLER_URL` mainnet endpoint, `PAYMASTER_URL` empty (self-funded gas) with `GAS_BOOTSTRAP_WEI`,
      `GAS_MIN_WEI`, `GAS_TARGET_WEI` reviewed and the admin wallet funded for bootstraps; `ENABLE_MODE_*`
      reviewed; `SWAP_SLIPPAGE_BPS` set (on-chain cap 300).
- [ ] Session-key policy knobs reviewed (`SESSION_USDC_TRANSFER_CAP`, `SESSION_GAS_ALLOWANCE_WEI`,
      `SESSION_USDC_WINDOW_SECONDS`, `SESSION_RATE_LIMIT_PER_HOUR`, `SESSION_KEY_VALIDITY_DAYS`).
- [ ] Fresh production secrets (not reused from Sepolia): `SESSION_SIGNER_PRIVATE_KEY`, `ADMIN_PRIVATE_KEY` (or
      unset), `SENDER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`, `SESSION_SECRET`, `SENDER_ENCRYPTION_KEY`,
      `ADMIN_CONSOLE_SLUG`; `ADMIN_ADDRESSES` = production admin wallets.
- [ ] `NEXT_PUBLIC_BUILDER_CODE` registered for the mainnet platform wallet; `BUILDER_CODES_ENABLED` as intended.
- [ ] X app callback `https://api.bootr.fun/oauth/callback`, `X_REDIRECT_URI`, `SENDER_OAUTH_RETURN_URL=https://bootr.fun/launch`.
- [ ] `INDEXER_CORS_ORIGIN=https://bootr.fun` (and `www` if used); `ADMIN_CONFIG_URL=https://bootr.fun/api/admin/config`.
- [ ] Web volume mounted at `/data`, `RAILWAY_RUN_UID=0`, admin config saved once from the console; `/data/launch-drafts` is created on the first launch.
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
- **Recent posts** are read by the web through its own `/api/agents/:id/posts` route, which proxies the sender's
  public `GET /public/posts/:agentId` (over `SENDER_URL`); the sender answers 404 for an agent it has never seen.
