# Production: one Coolify server

Bootr runs on a single Hetzner Cloud VPS managed by [Coolify](https://coolify.io) (self-hosted PaaS: Docker,
Traefik proxy, Let's Encrypt). This is the production runbook since 2026-11-01; the Railway layout it replaced is
summarised in [`railway.md`](./railway.md) (history only). The contract-side cutover, keys and the $BOOTR launch
are in [`mainnet.md`](./mainnet.md).

## 1. Layout

| Piece | Where |
| --- | --- |
| Server | Hetzner CX23 (2 vCPU, 4 GB RAM + 4 GB swap, 40 GB NVMe), Ubuntu 26.04, Helsinki, hostname `ubuntu-4gb-hel1-1`, IPv4 `77.42.90.52`. SSH as `root` with a key only (no password login) |
| Network | Hetzner Cloud Firewall `bootr-1`: inbound TCP 22, 80, 443, 6001-6002 and ICMP, everything else dropped at the edge. ufw on the host mirrors it; Docker-published ports bypass ufw, which is why the cloud firewall is the one that counts |
| Coolify | v4.5.x, installed with the official `install.sh`; panel at `https://coolify.bootr.fun`; API enabled, token in `/root/.coolify-token` (mode 600, never in the repo); `/data/coolify/source/.env` backed up off-server |
| Source | GitHub `dnebayis/bootr` (private), branch `main`. Coolify clones it with a read-only deploy key (registered on the repo and in Coolify → Keys & Tokens) |
| Application | Coolify project `bootr` → environment `production` → `bootr-stack`: a **Docker Compose** application built from [`docker-compose.coolify.yml`](../../docker-compose.coolify.yml) at the repo root |
| Compose services | `postgres` (postgres:17, volume `postgres-data`), `sender` :3002, `inference` :3003, `indexer` :42069, `web` :3000 (volume `web-data` at `/data`), `supervisor` :3004 |
| Domains (Traefik, Let's Encrypt) | `web` → `bootr.fun`, `www.bootr.fun`; `sender` → `api.bootr.fun`; `indexer` → `indexer.bootr.fun`. `inference`, `supervisor` and `postgres` have no domain and stay private on the compose network |
| DNS | Namecheap: `A @`, `A www`, `A api`, `A indexer`, `A coolify` → `77.42.90.52` |
| Hermes Agent | `/root/.hermes`, runs as root for server operations on request (incident fixes, one-off tasks); Anthropic OAuth, model `claude-opus-5.5`. Routine jobs (backups) are plain cron, not Hermes. Reachable from Telegram as `@bootrhermesbot`: the gateway is the systemd service `hermes-gateway` (enabled at boot, `journalctl -u hermes-gateway -f`), the bot token and the single allowed Telegram user id live in `/root/.hermes/.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`; mode 600, never in the repo). Anyone else who writes to the bot is ignored. `python-telegram-bot` is installed in Hermes's own venv with its bundled `uv` |

Service-to-service URLs are the compose service names: `http://sender:3002`, `http://inference:3003`,
`http://indexer:42069`, `postgres://bootr:<generated>@postgres:5432/bootr`. The compose file hard-codes them.
The public hosts live in `NEXT_PUBLIC_*`, `X_REDIRECT_URI`, `SENDER_OAUTH_RETURN_URL`, `INDEXER_CORS_ORIGIN` and
`ADMIN_CONFIG_URL`.

Public endpoints: `bootr.fun` (web: the app, `/api/*`, agent cards at `/agents/<id>.json`, token metadata at
`/tokens/<id>.json`), `api.bootr.fun` (sender: X OAuth `/oauth/start` and `/oauth/callback`, `/public/posts/:agentId`,
`/health`; `/internal/*` is HMAC-authenticated and only called over the compose network), `indexer.bootr.fun`
(GraphQL `/graphql`, REST, SSE `/stream`, `/health`, `/ready`).

## 2. How a deploy works

1. Push to `main`. Coolify does not pull on its own unless a GitHub webhook is configured (application →
   Webhooks); until then deploy from the panel (**Deploy** / **Redeploy**) or from the server:
   ```sh
   curl -s -X POST -H "Authorization: Bearer $(cat /root/.coolify-token)" -H "Content-Type: application/json" \
     http://127.0.0.1:8000/api/v1/deploy -d '{"uuid":"<application uuid>","force":false}'
   ```
   The application uuid is in the panel URL. `GET /api/v1/deployments/<deployment uuid>` returns the status and the
   build log.
2. Coolify clones the repo, runs `docker compose build` for the five services (the Dockerfiles under `apps/*`; the
   web image takes its `NEXT_PUBLIC_*` build args from the application's environment) and `docker compose up -d`.
   The first build on the CX23 took ~11 minutes with swap in use; later builds reuse the layer cache. Build one
   application at a time on this box. Since 2026-11-03 the images are built by GitHub Actions and
   pushed to GHCR (section 9); once the compose file points at them, this step is a pull.
3. Migrations run inside the containers at start (`command:` in the compose file): sender and supervisor
   `node dist/db/migrate.js`, inference `node scripts/migrate.mjs`. Each keeps its own journal, so restarts are
   no-ops. Migrations are forward-only (drizzle has no down migrations): keep them backward-compatible (add first,
   remove in a later release) and take a backup (section 6) before a release that contains one.
4. The indexer manages its own schema. `DATABASE_SCHEMA=bootr_v1` is fixed: bump it (`bootr_v2`, ...) whenever
   the indexing code changes, because Ponder refuses to reuse a schema built by another app version, and drop the
   old one afterwards (`docker exec <indexer container> ./node_modules/.bin/ponder db prune`). A fresh schema
   backfills from `BOOTR_START_BLOCK` (53219209): about 70 minutes on the CDP RPC at Ponder's own rate, longer under the `INDEXER_RPC_BU_PER_SEC` budget when little is in the RPC cache;
   `/ready` returns 503 until then while `/health` is already 200. Unlike Railway's per-deployment schemas, the
   previous index is **not** kept serving during a backfill: a schema bump means roughly an hour without token
   data on the site, so do it at a quiet time.
5. Check: application → Logs per service, or on the server `docker ps` and `docker logs <container>`.
   ```sh
   curl -sk --resolve bootr.fun:443:127.0.0.1 https://bootr.fun/api/health
   curl -sk --resolve indexer.bootr.fun:443:127.0.0.1 https://indexer.bootr.fun/ready
   ```
   `--resolve` tests the proxy on the server itself, independent of DNS.

Rollback: application → Deployments → a previous successful one → **Redeploy**. It rebuilds that commit (the
Docker layer cache makes it fast) with the current environment; `NEXT_PUBLIC_*` values are baked into the web
image at build time, so a rollback with changed public values needs those variables reverted first.

## 3. Environment

The compose file declares every variable as `${NAME}` (secrets) or `${NAME:-default}` (config), and Coolify lists
them under application → Environment Variables. `SERVICE_PASSWORD_POSTGRES` is generated by Coolify;
`SERVICE_FQDN_<service>_<port>` carries the domain. `.env.example` describes every variable; `.env.mainnet.example`
holds the mainnet values and placeholders.

| Service | Secrets | Config |
| --- | --- | --- |
| web | `SESSION_SECRET`, `ADMIN_CONSOLE_SLUG` (hides the console), `PINATA_JWT`, `SENDER_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY` (the coin page's agent config and activity, `/api/agent/[kernel]/*`), `BASE_RPC_URL` | `ADMIN_ADDRESSES`, `SENDER_URL=http://sender:3002`, `INFERENCE_URL=http://inference:3003`, `SUPERVISOR_URL=http://supervisor:3004`, `HOSTNAME=0.0.0.0`; build args `NEXT_PUBLIC_CHAIN_ID=8453`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_INDEXER_URL`, `NEXT_PUBLIC_SENDER_PUBLIC_URL`, `NEXT_PUBLIC_RPC_URL` (a public endpoint, never the keyed one), `NEXT_PUBLIC_BUILDER_CODE`, `NEXT_PUBLIC_IPFS_GATEWAY`, `NEXT_PUBLIC_LAUNCHER_ADDRESS`, `NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS`, `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY`, `NEXT_PUBLIC_BOOT_X_URL`, `NEXT_PUBLIC_SWAP_LINK_BASE`, `NEXT_PUBLIC_USE_MOCK` (empty) |
| sender | `SENDER_SERVICE_KEY`, `SENDER_ENCRYPTION_KEY` (rotating it orphans every stored X token), `X_CLIENT_SECRET` | `X_CLIENT_ID`, `X_REDIRECT_URI=https://api.bootr.fun/oauth/callback`, `SENDER_OAUTH_RETURN_URL=https://bootr.fun/launch`, `SENDER_TRUST_PROXY=1` (behind Traefik) |
| inference | `OPENROUTER_API_KEY`, `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`, `INFERENCE_RPC_URL` | `X402_NETWORK=eip155:8453`, `X402_FACILITATOR_URL`, `INFERENCE_PAYTO_ADDRESS` |
| indexer | `BASE_RPC_URL`, `INDEXER_SERVICE_KEY` | `DATABASE_SCHEMA=bootr_v1`, `CHAIN_ID`, `BOOTR_LAUNCHERS` (every BootrLauncher ever used, `address@deployBlock,...`; while it is empty the single `BOOTR_LAUNCHER_ADDRESS` + `BOOTR_START_BLOCK` pair is used instead), `BOOTR_GUARDIAN_ADDRESS`, `RWAGMI_*_V3_ADDRESS` (four), `INDEXER_CORS_ORIGIN=https://bootr.fun,https://www.bootr.fun`, `ADMIN_CONFIG_URL=https://bootr.fun/api/admin/config`, `INDEXER_MAX_RPS=40`, `BOOT_TOKEN_ADDRESS` after the $BOOTR launch. Adding a launcher (a redeploy of BootrLauncher) = append `0x<new launcher>@<its deploy block>` to `BOOTR_LAUNCHERS` (keep the old entries so their coins stay indexed) **and** bump `DATABASE_SCHEMA`: the address list is part of Ponder's build id, so the old schema is refused and a backfill runs (shorter than the first one, Ponder's `ponder_sync` RPC cache is reused; see `apps/indexer/README.md` "Adding a launcher") |
| indexer (schema) | | `DATABASE_SCHEMA=auto` (since 2026-11-04): each image indexes into `bootr_<first 7 of its commit>` and drops the automatic schemas of older images except the newest previous one at start (`apps/indexer/scripts/schema-janitor.mjs`). Ponder refuses to reuse a schema built by a different app version, so a fixed name (`bootr_v3`) had to be bumped or dropped by hand after every indexer change; `auto` removes that step. Every indexer change still backfills from scratch (about 7 minutes since 77cca45; it took 20 before the snapshot handler was thinned during backfill), during which the site shows stale or partial data. |
| supervisor | `SESSION_SIGNER_PRIVATE_KEY`, `SPENDER_MASTER_KEY`, `ADMIN_PRIVATE_KEY`, `SENDER_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`, `BASE_RPC_URL`, `BUNDLER_URL`, `TELEGRAM_BOT_TOKEN` (optional, creator notifications) | `CHAIN_ID`, `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS`, `LAUNCHER_START_BLOCK`, `RWAGMI_LAUNCHER_V3_ADDRESS`, `RWAGMI_LOCKER_V3_ADDRESS`, `BOOTR_CLANKER_LAUNCHER_ADDRESS` (the `BootrClankerLauncher` once deployed, [`docs/design/clanker-launch.md`](../design/clanker-launch.md); empty until then; the poller follows it next to `BOOTR_LAUNCHER_ADDRESS` from the same cursor, so set it before the first Clanker launch or lower the cursor), `CLANKER_LOCKER_ADDRESS` / `CLANKER_FEE_LOCKER_ADDRESS` (defaults are the verified Base mainnet lockers; override only if Clanker rotates them), `INFERENCE_PAYTO_ADDRESS`, `PLATFORM_TREASURY_ADDRESS`, `ENABLE_MODE_SELF_BUNDLE=true`, `PAYMASTER_URL` empty, `GAS_MIN_WEI`, `GAS_TARGET_WEI` ([`docs/gas-model.md`](../gas-model.md)), `BUILDER_CODES_*`, `SESSION_*`, `SPENDER_*`, `CHAINLINK_MAX_AGE_SECONDS`, `PLATFORM_POST_SLOTS_PER_10M`, `PLATFORM_QUIET_HOURS_UTC`, `PLATFORM_DIGEST_AT`, `PLATFORM_NUMBERS_AT`, `PLATFORM_WATCHLIST`, `LOG_LEVEL` |

Direct mode (supervisor, `apps/supervisor/src/blockrun.ts`): an agent's spender pays BlockRun over x402 for its thoughts,
chat and pictures, so no OpenRouter credit is needed. Off unless `BLOCKRUN_DIRECT_MODE` says otherwise: `agents` with the ids
in `BLOCKRUN_DIRECT_AGENTS`, or `all`. It adds no secret, so no `env -u` list changes. `BLOCKRUN_RELAY_FALLBACK` (default
`false`) decides what happens when BlockRun cannot serve a call: off, the agent waits with backoff and nothing is paid; on, the
relay takes it, so set it only while OpenRouter is funded, because a relay with no credit takes the payment and cannot answer.
A failed call that was already signed holds the thought until the chain shows the payment settled or its signature expired, so
one thought is never paid on both routes. The optional `BLOCKRUN_BASE_URL`, `BLOCKRUN_PAYTO_ADDRESS`, `BLOCKRUN_ALLOW_EXACT`,
`BLOCKRUN_PROMPT_CACHE`, `BLOCKRUN_TIMEOUT_MS`, `BLOCKRUN_HOLD_MS` and `BLOCKRUN_IMAGE_POLL_MS` have safe defaults. Agents not
in direct mode still pay the relay: stop funding OpenRouter only with `BLOCKRUN_DIRECT_MODE=all` and the fallback off.

Creator notifications (supervisor, `apps/supervisor/src/notifications.ts`): the console inbox always works. For Telegram,
create a bot with BotFather and put its token in `TELEGRAM_BOT_TOKEN`; empty means inbox only and nothing fails. The
supervisor holds the token alone: it long-polls Telegram, so it needs no public route and no webhook, and only one
supervisor may poll a given bot at a time. Creators link a chat from the coin page's console with a one-time deep link.
`NOTIFY_SWEEP_MS` (default 60000) and `NOTIFY_CHECK_MS` (default 300000) set how often the notifier runs and the least
time between checks of one agent.

Posting rhythm (supervisor, `apps/supervisor/src/rhythm.ts`, behaviour in [`docs/agent-identity.md`](../agent-identity.md)
"Posting rhythm"): `PLATFORM_POST_SLOTS_PER_10M` (default `3`) is the most original posts all Bootr agents together may
send per ten-minute window; an agent whose post is due but finds the window full waits for a later tick and keeps its
slot. `PLATFORM_QUIET_HOURS_UTC` (default unset = none) is a UTC window `HH-HH` such as `02-06` (`22-06` wraps midnight)
during which original posts wait; replies still go out. Both are plain config, no redeploy of anything else.
`PLATFORM_DIGEST_AT` (default `sun:16`) is when the platform's own agent writes its "this week on Bootr" post, as
`<day>:<hour>` in UTC, once per ISO week (`apps/supervisor/src/weekly-digest.ts`, behaviour in
[`docs/agent-identity.md`](../agent-identity.md) "Platform agent"); it waits for quiet hours and a free slot like any post.
`PLATFORM_NUMBERS_AT` (default `15`) is the hour in UTC (`HH`) at which the platform agent writes its daily numbers post
(`apps/supervisor/src/platform-numbers.ts`), once per UTC day, held like any post. `PLATFORM_WATCHLIST` (default
`bootrfun,base,jessepollak,clanker_world`) is the comma-separated list of X handles whose latest posts the platform agent reads
(`apps/supervisor/src/watchlist.ts`; one read per handle per six hours through the sender) and may engage with in an
original post.

Secret keys shared by several services (`SENDER_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`) are one Coolify variable
reaching every container that references it.

Coolify does not scope variables per service: it writes every variable of the application into one `.env`
(`/data/coolify/applications/<uuid>/.env`) and attaches it as `env_file` to every service, so by default each
container, the public web process included, would carry the supervisor's keys. The compose file therefore
starts every service through `env -u ...`, dropping the secrets that service does not declare in its own
`environment` block (found on 2026-11-02; the lists are in the file's header comment). The stripping happens
inside the container, so the container's own config (`docker inspect`, and the shell `docker exec` opens) still
carries the full `.env`; what matters is the service's main process. Check after a deploy with
`docker exec <web container> sh -c 'tr "\0" "\n" < /proc/1/environ | grep -c ^ADMIN_PRIVATE_KEY='`, which must
print 0 (verified 2026-11-02 for all five services: each main process holds exactly the secrets its block
declares). `SEARCH_API_KEY` (Brave Search subscription token, with `SEARCH_API_URL=https://api.search.brave.com/res/v1/web/search`) backs the agents' web research power and is supervisor-only (every other service strips it). Optional and empty today: `SWAP_SLIPPAGE_BPS`,
`BOOT_TOKEN_ADDRESS`, `ENABLE_MODE_*_URL`, `NEXT_PUBLIC_WC_PROJECT_ID`, `NEXT_PUBLIC_WORKER_SOURCE_BASE`,
`NEXT_PUBLIC_INFERENCE_URL`. Changing a `NEXT_PUBLIC_*` value needs a redeploy (the web image is rebuilt).

Hygiene: `.env` files are excluded from every image by `.dockerignore`; the images contain no secrets and the web
build args are public values only. Services log to stdout and never log tokens or keys; the supervisor reduces
every URL in an error to its origin because RPC and bundler URLs embed API keys. Rotate `SENDER_SERVICE_KEY` on
all four consumers at once (one variable here), then redeploy. The Coolify API token can reach every variable:
keep it on the server only.

## 4. The web data volume

`/api/admin/config` stores the platform config in a JSON file (`ADMIN_CONFIG_PATH`, image default
`/data/admin-config.json`) and the launch drafts (`LAUNCH_DRAFTS_DIR`, `/data/launch-drafts`: the creator's Identity
text per launch, served to the supervisor through the agent card, see [`docs/agent-identity.md`](../agent-identity.md))
live next to it. The compose file mounts the named volume `web-data` at `/data`; the image owns `/data` as `node`
and the volume inherits that ownership, so no root override is needed. The file store pins `web` to one replica;
moving it to Postgres (the TODO in `apps/web/lib/server/admin-config.ts`) would lift that.

## 5. X app, DNS and certificates

- X developer portal (the app behind `X_CLIENT_ID`), User authentication settings: callback
  `https://api.bootr.fun/oauth/callback` (plus `http://localhost:3002/oauth/callback` on the development app only),
  website `https://bootr.fun`. `X_REDIRECT_URI` must match the portal exactly.
- Traefik requests a Let's Encrypt certificate for each domain when the application deploys. If DNS did not point
  at the server at that moment the attempt fails and is **not retried** until the proxy restarts: after a DNS
  change run `docker restart coolify-proxy` and check `openssl s_client -servername <host> -connect <host>:443`
  shows a Let's Encrypt issuer instead of `TRAEFIK DEFAULT CERT`.
- The panel's own domain is set in Coolify → Settings → General ("Instance's Domain"). With it set, port 8000 is
  not needed and the cloud firewall keeps it closed.

## 6. Backups and disk

`/root/backup-bootr-db.sh` runs from root's crontab every day at 03:00 UTC (log: `/root/backups/backup.log`):
`pg_dump -U bootr --exclude-schema="ponder_rpc_cache_*" bootr | gzip` into `/root/backups/bootr-<date>.sql.gz`,
14 days kept. The excluded schema is the indexer's RPC cache (gigabytes of raw chain data that a backfill
rebuilds); the dump keeps `public` (sender, supervisor), `drizzle` (inference) and the indexer's `bootr_v1` tables,
a few KB while the platform is empty. Restore into the compose Postgres with
`zcat <file> | docker exec -i <postgres container> psql -U bootr bootr`. The dumps are not shipped off the server
yet; copy them to the owner's machine (`scp`) or a Hetzner Storage Box. Coolify's own `/data/coolify/source/.env`
is backed up on the owner's machine.

Disk: the 40 GB box fills up with Docker build cache (each deploy adds layers; the four Node service images were
~1.8 GB each until 2026-11-03, when the runtime stage still inherited the whole fetched pnpm store; section 9).
Coolify runs a Docker cleanup on a schedule (Servers → localhost → Advanced); when the disk passes ~80%, run `docker builder prune -f`
and `docker image prune -f` by hand. Never delete the `postgres-data` or `web-data` volumes.

Memory: after a deploy the Docker daemon itself keeps the memory the in-daemon BuildKit build used (seen on
2026-11-02: `dockerd` at 1.5 GB RSS plus 0.9 GB swap on the 4 GB box, against ~100 MB normally). It is not a leak
and not logs (container logs rotate at 10 MB, three files). `live-restore` is on in `/etc/docker/daemon.json`, so
`systemctl restart docker` hands the memory back without stopping the containers; Traefik answers 503 for about
30 s afterwards while every container's health check runs again, then the site is back. Do this after a deploy
when `free -m` shows swap in use. The Hermes Telegram gateway costs ~330 MB on its own; `systemctl stop
hermes-gateway` frees it when the bot is not needed.

Hermes scheduled jobs (`hermes cron list` on the server; scripts in `/root/.hermes/scripts/`):

| Job | When | What |
| --- | --- | --- |
| Bootr daily check | 05:30 UTC (08:30 Istanbul) | `bootr-check.sh` collects load, memory (incl. dockerd RSS/swap), disk, container health, public endpoint codes, certificate expiry, backup age, fail2ban and SSH counts, pending apt updates, reboot-required and error-line counts per service; Hermes summarises it in Turkish to the owner on Telegram. It may restart Docker when dockerd is bloated (RSS > 600 MB or swap > 1.5 GB) and prune build cache/images when the disk passes 80%; it never reboots, never changes firewall/SSH/fail2ban, never runs apt upgrade, never touches volumes or secrets |
| Bootr watchdog | every 15 min, no LLM | `bootr-watchdog.sh` prints only when something is wrong (a public endpoint not 200, an unhealthy Bootr container, disk ≥ 85%, < 300 MB RAM available, backup older than 30 h); empty output sends nothing, so a healthy day is silent |

Both deliver to `telegram:<owner's user id>` (a bare `telegram` target does not resolve). Trigger one by hand with
`hermes cron run <job id>`; `hermes cron runs <job id>` lists the attempts and `~/.hermes/logs/gateway.log` the
delivery line.

## 7. Known limits of the small box

- 4 GB RAM: the five services idle at ~2.5 GB; a web build pushes into swap. Do not run two builds at once, and
  do not add a second project of this size. Rescale in the Hetzner panel (Servers → Rescale, "resize disk too") to
  CX33 (8 GB / 80 GB) or CX43 (16 GB / 160 GB) when stock allows; the IP, disk and Coolify survive a rescale,
  the site is down for a few minutes while the server reboots.
- The supervisor and the indexer share one CDP RPC key, whose limit is 7,500 billing units per 5 s. Since the Denim fork
  (2026-11-05 18:00 UTC) Base has 5 blocks a second, and following them takes about half of that, and the supervisor
  retries a rate-limited read for up to 8 s. A restart must fetch Ponder's 180 s reorg window again, now about 1,000 blocks.
  Ponder is held to `INDEXER_RPC_BU_PER_SEC` (1300 by default), which should still catch up in about 5 minutes without
  saturating the key; `BASE_RPC_FALLBACK_URL` shortens that (`apps/indexer/README.md`).
- One `web` replica (the `/data` file store), one `supervisor` replica (the tick loop). Compose stops the old
  supervisor before starting the new one, so there is no overlap of two tick loops, but a deploy still interrupts
  an in-flight tick: deploy when no on-chain operation is pending.
- Inference shutdown closes the server and the database right away on SIGTERM; a paid request in flight during a
  deploy can end up `unknown` and is settled by reconciliation (`GET /v1/requests/:key`).
- Ponder answers CORS preflights itself with `*`; `INDEXER_CORS_ORIGIN` is enforced on the actual response, which
  is what browsers check.

## 8. Local development

Launching a coin needs the RWAGMI v3 stack and Base's B20 precompiles, which only exist on Base mainnet. Sepolia
still works for everything that does not launch (sender, inference, x402, web shell). The dev path for the launch
flow is a Base mainnet fork with Base's Foundry binaries (`base-forge`, `base-anvil`):

```sh
cd packages/contracts && BASE_RPC_URL="$BASE_RPC_URL" base-forge test   # the fork tests fork mainnet themselves
base-anvil --fork-url "$BASE_RPC_URL" --chain-id 8453 --port 8545         # a forked node for a local stack
```

Point a local stack at the fork with `BASE_RPC_URL=http://127.0.0.1:8545`, `CHAIN_ID=8453`, the mainnet
`RWAGMI_*_V3_ADDRESS` values from `.env.mainnet.example` and the addresses of a Bootr launcher deployed onto the
fork (`script/Deploy.s.sol`). The fork keeps its state in memory: redeploy the Bootr contracts and restart the
indexer on a fresh schema after each restart. End to end against real infrastructure, test with a small coin on
mainnet. The whole stack can also be run locally with the same compose file:
`docker compose -f docker-compose.coolify.yml up --build` with the variables in a `.env` next to it.

## 9. Images are built by GitHub Actions

Building five images on the 4 GB box took 12-16 minutes per deploy and filled the disk with build cache, so the
workflow [`.github/workflows/images.yml`](../../.github/workflows/images.yml) builds them on GitHub instead and
pushes them to the GitHub Container Registry as **public** images (free, no registry login on the server):

| Service | Image |
| --- | --- |
| web | `ghcr.io/dnebayis/bootr-web` |
| sender | `ghcr.io/dnebayis/bootr-sender` |
| inference | `ghcr.io/dnebayis/bootr-inference` |
| indexer | `ghcr.io/dnebayis/bootr-indexer` |
| supervisor | `ghcr.io/dnebayis/bootr-supervisor` |

Every push to `main` that touches `apps/**`, `packages/**`, the lockfile or the workflow (and every manual run,
Actions → images → Run workflow) builds the five `linux/amd64` images in parallel from the Dockerfiles under
`apps/*` (same build context and Dockerfiles as before) and tags each one `:<short sha>`, `:sha-<full sha>` and
`:main` (a manual run from another branch tags `:<branch>` instead of `:main`). Layers are cached per service in
the Actions cache; a run that changes one app rebuilds only that app's later layers. The runtime stages copy only
the service's production `node_modules`, `dist` and migrations; the old images carried the whole fetched pnpm
store (1.3 GB) and weighed ~1.8 GB each, the new ones are a quarter of that.

**Repository variables** (Settings → Secrets and variables → Actions → Variables, or
`gh variable set NEXT_PUBLIC_SITE_URL --body https://bootr.fun`): the public values inlined into the web bundle,
the same list as the web service's `build.args` in the compose file. Unset ones fall back to the compose defaults
(`NEXT_PUBLIC_CHAIN_ID=8453`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_INDEXER_URL`, `NEXT_PUBLIC_SENDER_PUBLIC_URL`)
or stay empty: `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_INDEXER_URL`,
`NEXT_PUBLIC_SENDER_PUBLIC_URL`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_WC_PROJECT_ID`, `NEXT_PUBLIC_BUILDER_CODE`,
`NEXT_PUBLIC_INFERENCE_URL`, `NEXT_PUBLIC_SWAP_LINK_BASE`, `NEXT_PUBLIC_LAUNCHER_ADDRESS`,
`NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS`, `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY`, `NEXT_PUBLIC_BOOT_X_URL`,
`NEXT_PUBLIC_WORKER_SOURCE_BASE`, `NEXT_PUBLIC_IPFS_GATEWAY`. They are public by definition; changing one means a
new web image (push or manual run), the `NEXT_PUBLIC_*` variables in Coolify no longer matter once the compose
file pulls images. No secret reaches any build: the workflow holds only `GITHUB_TOKEN` (push to GHCR) and the
optional deploy token below.

**Making the packages public** (once, after the first run has created them; there is no API for container
visibility): GitHub → profile → Packages → `bootr-<svc>` → Package settings → Danger Zone → Change visibility →
Public, for each of the five. Until then `docker pull` from the server fails with `denied` because the server
has no GHCR login, and a public package can be pulled by anyone, which is fine: the images contain no secrets
(section 3, Hygiene), only the public `NEXT_PUBLIC_*` values and the code of a private repo. If that is not
acceptable, keep them private and add a GHCR login on the server (Coolify → Servers → Docker registries, with a
read-only PAT) instead.

**Automatic deploy** (optional): with the repository secret `COOLIFY_DEPLOY_TOKEN` (Coolify → Keys & Tokens →
API tokens, deploy-only is enough) the workflow's last job calls `POST https://coolify.bootr.fun/api/v1/deploy`
with `{"uuid":"ko7sx54pwakworrqogccvbfc","force":false}` after a push to `main` once all five images are pushed;
without the secret the job prints "skipped". Set it only after the compose file has been switched to `image:`
(below), otherwise the call just triggers a server-side rebuild as before.

**Switching Coolify to the images**: replace each service's `build:` block in `docker-compose.coolify.yml` with
`image: ghcr.io/dnebayis/bootr-<svc>:${IMAGE_TAG:-main}` and `pull_policy: always` (the web service also loses its
`build.args`, the values live in the repository variables now). Add `IMAGE_TAG` to the application's variables in
Coolify (empty = `main`). A deploy then pulls instead of building: Coolify still clones the repo for the compose
file, runs `docker compose pull` and `up -d`. The `command:` lines and the environment blocks stay as they are.

**Rollback**: every image is also tagged with its commit (`sha-<full sha>`, listed under the package's versions or
in the workflow run). Set `IMAGE_TAG=sha-<sha>` in Coolify and redeploy: all five services move to that commit
(the tags are per commit, so a partial rollback is `IMAGE_TAG` on one service only if you edit the compose file).
Clear `IMAGE_TAG` to return to `main`. The migrations are forward-only (section 2), so a rollback across a
migration still needs the backup from section 6; a `DATABASE_SCHEMA` bump is not undone by a rollback either.
