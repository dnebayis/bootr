# The live switch: an indexer change without a half-filled index

Status 2026-11-25: designed and proven locally ([`docs/dev/indexer-live-switch-test.md`](../dev/indexer-live-switch-test.md)).
Nothing in production has changed: the image's default role is `all`, which is today's behaviour. Every panel step
below is the owner's; none has been done. Coolify facts are from its source at v4.7.6 and its docs; production runs
v4.5.x and nothing here was tried on it, so each step has a check and a way back. What is unsure is listed in section 8.

## 1. What changes

Today one `indexer` container indexes and serves. A new `DATABASE_SCHEMA` starts empty, takes 25 minutes or more to
fill, and the site and the agents read it the whole time.

After the move:

| Piece | What it is | Domain | Deploys |
| --- | --- | --- | --- |
| **Reader** `bootr-indexer-reader` | Docker Image app, `INDEXER_ROLE=reader`: `ponder serve` on the views schema `bootr_live`. GraphQL, the REST routes, `/stream`, the supervisor's social POST. Never indexes. | `indexer.bootr.fun` | Rolling update (new container healthy, then the old one stops). |
| **Writer** `bootr-indexer-writer-a` and `-b` | Docker Image apps, `INDEXER_ROLE=writer`: `ponder start` on `DATABASE_SCHEMA`. Used alternately: one is running, the other is stopped until the next indexing change. | none | Stop, then start (never two containers of one app). |
| **Web** `bootr-web` | Docker Image app, the `web` service moved out of the compose file with its `/data` volume. | `bootr.fun`, `www.bootr.fun` | Rolling update. |
| `bootr-stack` | The compose app: postgres, sender, inference, supervisor, dataset. | `api.bootr.fun` | As today (everything in it restarts). |

The views: `bootr_live.<table>` is `SELECT * FROM bootr_v<N>.<table>` for every table plus Ponder's two own tables.
A writer points them at its schema in one transaction, once its backfill is complete **and** its head has reached the
head of the schema being served (`apps/indexer/scripts/live-switch.mjs`). Measured locally: a client polling the
reader every 200 ms saw 0 failed requests across each switch and the head never stepped back.

Why two writer apps and not a rolling update of one: a new writer needs 25 to 60 minutes beside the old one. Coolify
waits for a new container at most start period + retries x interval and the whole deployment job is cut at the
server's deployment timeout (3,600 s by default); a backfill that outlasts either is rolled back. Two apps need
neither: the new one is deployed while the old one runs, and the old one is stopped by hand after the switch.

Why not Ponder's own `DATABASE_VIEWS_SCHEMA`: it switches at the end of the backfill, which is the finalized block
(the head stepped back 216 s in the test), and every start of a writer carrying it takes the views again, so an old
writer that restarts takes them back. `INDEXER_SWITCH=ponder` selects it anyway.

## 2. The roles (`apps/indexer/scripts/start.sh`)

| Variable | Values |
| --- | --- |
| `INDEXER_ROLE` | `all` (default: today's behaviour), `writer`, `reader` |
| `INDEXER_LIVE_SCHEMA` | the views schema, `bootr_live` when empty |
| `INDEXER_SWITCH` (writer) | `auto` (default: switch once caught up), `manual` (never; the owner runs the switch), `ponder` (Ponder's own views) |
| `INDEXER_SWITCH_SLACK_SEC` (writer) | seconds the new head may trail the served one at the switch, 0 when empty |
| `DATABASE_SCHEMA` (all, writer) | as before: a fixed name or `auto` |

A writer:
- waits, without starting Ponder, while another process is writing its schema (a heartbeat under 30 s old). Ponder's
  own refusal of a second writer clears the first one's lock flag, so it is not relied on.
- switches the views once: `no views yet`, or `caught up with <served schema>`. When the served schema has no writer
  (its head stands still) the measure is the clock: within 20 s of it.
- never takes the views back: a schema that had them before and finds them on another one leaves them there
  (the history is `bootr_offchain.live_switch`). Going back is a deliberate command.

The reader waits for the views to exist, then serves. Its `/health` is 200 as soon as it listens; its `/ready` and
`/status` report the schema the views point at. A writer's `/health` is 200 a few seconds after start, its `/ready`
is 503 `Historical indexing is not complete.` until its backfill ends, and `/status` shows the block it has reached.

Commands (run in any indexer container: `docker exec <container> node scripts/live-switch.mjs ...`):

```sh
node scripts/live-switch.mjs status            # what the views point at; each schema: ready, writer alive, lag
node scripts/live-switch.mjs switch bootr_v10  # point the views at a schema now (rollback, fail-over); refuses one that is not ready
```

## 3. Sizes

**Postgres connections** (`max_connections` is 100). Ponder's pool `max` is 30 by default: a writer may open 29 (2
internal, 9 each for indexing, read-only and sync) plus 2 for the social store, a reader 30 plus 2. Two writers and a
reader could reach 94 next to the supervisor (10), the sender (10), the dataset process and the relay. What they
opened in the local test: a writer 2 to 7, the reader 5 under 15 requests a second, 14 in all with three writers. The
pools are lazy and close idle connections after 10 s, so the overlap fits in practice, but the ceiling is not safe.
The fix is one line in `ponder.config.ts` (`database.poolConfig.max` from an `INDEXER_DB_POOL_MAX` variable: 14 for a
writer, 12 for the reader, 46 at most for all three), which is outside the build id. It is in: set
`INDEXER_DB_POOL_MAX=14` on each writer app and `12` on the reader (2 to 30; unset keeps Ponder's 30).

**RPC.** Each process has its own budget (`INDEXER_RPC_BU_PER_SEC`), so the budgets add up against the key's 1,500
BU/s. A writer at the head spends about 500 BU/s with `INDEXER_BLOCKS_RPC_URL` set (production has it since
2026-11-08); a backfill is served mostly from Ponder's RPC cache, and then replays the 180 s reorg window (about
1,000 `eth_getLogs`, 100,000 BU). Set:

| App | `INDEXER_RPC_BU_PER_SEC` | Note |
| --- | --- | --- |
| each writer | `800` | the one at the head uses about 500 of it; two writers stay near 1,300 |
| reader | `100` | its routes read the chain only for treasury and market pages |

Both writers and the reader carry the two lists of public urls for the head (`apps/indexer/README.md`, "RPC rate";
outside the build id, so no new schema):

```
INDEXER_LOGS_RPC_URLS=https://base.drpc.org,https://1rpc.io/base,https://base-rpc.publicnode.com
INDEXER_BLOCKS_RPC_URL=https://mainnet.base.org,https://base.drpc.org,https://1rpc.io/base
```

The first takes `eth_getLogs` by block hash off the key, the second the block reads; each url is tried in order, a
failing one rests 10 s to 5 minutes, and the key comes last. With both set a writer at the head spends little of its
budget while the lists answer; the budgets below stay as they are, because they are what a writer may spend when the
lists fail or while it replays the reorg window. The reader needs them only to keep its variables the same as the
writers': it follows no blocks. With 800 a writer has about 300 BU/s spare while it replays the reorg
window, so catching up takes about 5 minutes instead of 2; `BASE_RPC_FALLBACK_URL` (a public endpoint that serves
`eth_getLogs`, for example `https://base-rpc.publicnode.com`, which answered one on 2026-11-25) takes the overflow.
These are estimates from the README's measurements, not a measured overlap: watch the 429 count during the first one.
The compose indexer of today has no explicit budget (1,300 on a CDP url); it only spends what the head costs.

**Memory** (the box has 7.6 GB; the compose limits add up to 5.9 GB today, the indexer's is 1,536 MB).

| App | Limit | Basis |
| --- | --- | --- |
| reader | 512 MB | 207 MB RSS in the local test (almost empty tables); no sync cache, no reorg window |
| each writer | 1,536 MB, today's limit | 384 to 451 MB in the local test; production size was not measured |

Steady state is one writer and the reader: 512 MB more in limits than today. During an overlap a second writer adds
up to 1.5 GB for about an hour, which puts the sum of limits (7.9 GB) over the box. Limits are ceilings, not use:
before the first overlap read `docker stats` and `free -m`, and start the second writer only with 1.5 GB available.
If it is tight, give the new writer 1,024 MB for the overlap.

## 4. Coolify facts the plan rests on

From Coolify's source at tag v4.7.6 (`app/Jobs/ApplicationDeploymentJob.php` unless noted) and
[its docs](https://coolify.io/docs/knowledge-base/rolling-updates). Production runs v4.5.x: check each in the panel.

- **Docker Image app**: every deploy pulls the image, so `:main` moves with CI. Deploy by API:
  `POST /api/v1/deploy` with `{"uuid":"<app uuid>","force":false}`; several uuids as one comma-separated string.
- **Rolling update** happens unless the app has a host port mapping, "Consistent Container Names" (or a custom
  container name), or `--ip` in its custom options. A volume does not prevent it. Compose apps never get one.
- **Health check**: the deploy waits for the new container only when the app's own health check is enabled in
  Coolify; the image's `HEALTHCHECK` alone does not gate a Docker Image app, and a disabled check means "healthy at
  once". The HTTP type runs `curl` or `wget` inside the container and Bootr's images have neither, so use the
  **command** type: `node scripts/healthcheck.mjs` (indexer image) and `node healthcheck.mjs` (web image). The wait is
  the whole start period, then up to `retries` looks `interval` apart; a container that is not healthy by then is
  removed and the old one stays.
- **Deployment timeout**: 3,600 s by default (Server → Advanced). No step below needs more.
- **Network**: a Docker Image app joins only its destination's network and gets the aliases typed under
  General → Network aliases. `--network` and `--network-alias` in custom options are not supported. A compose app's
  services sit on a network named after its uuid, here `ko7sx54pwakworrqogccvbfc`.
- **Storage**: a volume added under Storages is named `<app uuid>-<name>`; renaming the storage to an existing Docker
  volume's name makes the app use that volume, without moving data.
- **Env**: a Docker Image app has its own variables; nothing is shared with other apps. No start command can be set,
  which is fine: both images start the right process by default.
- **Domains**: a domain already used by another resource asks for confirmation and can be forced.

## 5. The one-time move

Do the steps in order; each ends in a state that can stay for days. The site keeps working after every one. Take a
database backup first (`docs/deploy/coolify.md` section 6).

### Step 0: ship the code (no behaviour change)

Merge this branch, let the images workflow finish, deploy `bootr-stack` as usual. The compose indexer still runs
`INDEXER_ROLE=all`. The compose file change in this branch is one line twice: the supervisor's and the dataset's
`INDEXER_URL` became `${INDEXER_INTERNAL_URL:-http://indexer:42069}`, the same value while that new variable is unset.

Check: `docker exec <indexer container> node scripts/live-switch.mjs status` prints `bootr_live -> (no views)` and the
`bootr_v10` line. Way back: none needed.

### Step 1: a network the new apps share with the stack

The new apps must reach `postgres`, `sender`, `inference` and `supervisor`, and the supervisor must reach the reader.

**Plan A (no change to the stack):** Server → Destinations → add a destination whose network is the stack's own,
`ko7sx54pwakworrqogccvbfc`. Coolify creates a destination's network only when it does not exist, and connects its
proxy to it (`app/Models/StandaloneDocker.php`). Apps deployed to that destination resolve the compose service names
directly, and the stack's services resolve the apps' network aliases.

Check (after step 3 has put the first app there):
`docker exec <reader container> node -e "require('dns').lookup('postgres',(e,a)=>console.log(e?.code??a))"` prints an
address. Way back: delete the destination (after the apps on it).

**Plan B (if Coolify refuses that destination):** on `bootr-stack` switch on "Connect To Predefined Network" and
redeploy it; the new apps go to the default destination (`coolify` network) and use the container names
`postgres-ko7sx54pwakworrqogccvbfc`, `sender-ko7sx54pwakworrqogccvbfc` and so on in their URLs. Before that, look at
who else is on that network (`docker network inspect coolify --format '{{range .Containers}}{{.Name}} {{end}}'`): the
box hosts another project, and a second container answering to `postgres` there would be resolved by Bootr's services
too.

### Step 2: create the views on today's schema

```sh
docker exec <compose indexer container> node scripts/live-switch.mjs switch bootr_v10
docker exec <compose indexer container> node scripts/live-switch.mjs status
```
This adds the schema `bootr_live` (one view per table, and two for Ponder's own tables) and the table
`bootr_offchain.live_switch`. Nothing reads them yet.
Way back: `drop schema bootr_live cascade;`.

### Step 3: the reader

New resource → Docker Image → `ghcr.io/dnebayis/bootr-indexer:main`, destination from step 1, name
`bootr-indexer-reader`.

- Ports Exposes `42069`. No port mapping. No domain yet.
- Network aliases: `indexer-reader`.
- Health check: enabled, type command, `node scripts/healthcheck.mjs`, interval 5, timeout 5, retries 12, start period 5.
- Resource limits: memory `512m`.
- Variables. Take the values from the running indexer, in the server's shell, and paste them into Coolify's editor,
  never into a chat or a file in the repo (they include the RPC key, the service key and the database password):
  ```sh
  docker exec <compose indexer container> sh -c 'tr "\0" "\n" < /proc/1/environ' \
    | grep -E '^(CHAIN_ID|BASE_RPC_URL|BASE_RPC_FALLBACK_URL|INDEXER_|BOOTR_|RWAGMI_|CLANKER_|CHAINLINK_|BOOT_TOKEN_ADDRESS|ADMIN_CONFIG_URL|LAUNCHER_START_BLOCK|FUEL_SCAN_MAX_RANGE)'
  ```
  Use every line it prints (the compose file's `environment` block is not the whole list: Coolify also hands the
  container the stack's shared variables, `BOOTR_CLANKER_LAUNCHERS` among them). Then add or replace:
  `INDEXER_ROLE=reader`, `PORT=42069`, `INDEXER_RPC_BU_PER_SEC=100`,
  `INDEXER_LOGS_RPC_URLS=https://base.drpc.org,https://1rpc.io/base,https://base-rpc.publicnode.com`,
  `INDEXER_BLOCKS_RPC_URL=https://mainnet.base.org,https://base.drpc.org,https://1rpc.io/base`
  (section 3, RPC; the grep above prints the old single-url `INDEXER_BLOCKS_RPC_URL`, replace it). `DATABASE_SCHEMA` is
  not needed.
  `INDEXER_DATABASE_URL` keeps the host `postgres` (plan A) or becomes `postgres-ko7sx54pwakworrqogccvbfc` (plan B).

Deploy. Check from the stack: `docker exec <supervisor container> node -e "fetch('http://indexer-reader:42069/status').then(r=>r.text()).then(console.log)"`
prints the head block, and it moves. Way back: stop or delete the app.

### Step 4: send the traffic to the reader

1. `bootr-indexer-reader` → Domains: `https://indexer.bootr.fun` (confirm the conflict dialog), deploy it. Both the
   compose indexer and the reader now answer that host with the same data.
2. `bootr-stack`: clear the indexer service's domain, set `INDEXER_INTERNAL_URL=http://indexer-reader:42069`, and
   redeploy the stack (the usual minute for the services in it; do it with the next stack deploy if one is due).

Check: `curl -s https://indexer.bootr.fun/status` moves; the supervisor's log shows no indexer errors; the site loads.
Way back: clear `INDEXER_INTERNAL_URL`, put the domain back on the compose service, remove it from the reader,
redeploy both.

From here an API-only change (`apps/indexer/src/api`) is a reader deploy: a rolling update, nothing goes down.

### Step 5: the first writer app, and the first switch

Do this at the next indexing change, or sooner as a rehearsal: a second index of the same code under a new name
(`bootr_v11`) costs one backfill and proves the switch in production while `bootr_v10` keeps serving.

New resource → Docker Image → `ghcr.io/dnebayis/bootr-indexer:main`, same destination, name `bootr-indexer-writer-a`.

- Ports Exposes `42069`. No domain, no port mapping, no network alias.
- Advanced: **Consistent Container Names on** (this turns rolling updates off: a writer must stop before its
  replacement starts).
- Health check: enabled, type command, `node scripts/healthcheck.mjs`, interval 10, timeout 5, retries 12, start period 30.
- Resource limits: memory `1536m` (or `1024m` for the overlap, section 3).
- Variables: the reader's list (`INDEXER_LOGS_RPC_URLS` and the `INDEXER_BLOCKS_RPC_URL` list included: the writer is
  the one that uses them), with `INDEXER_ROLE=writer`, `DATABASE_SCHEMA=bootr_v11`, `INDEXER_RPC_BU_PER_SEC=800`.
  The values that shape the index (`BOOTR_LAUNCHERS`, `BOOTR_CLANKER_LAUNCHERS`, the addresses, the start blocks,
  `INDEXER_SNAPSHOT_INTERVAL`) must be exactly the stack's: they are part of what is indexed.

Deploy, then follow it:

```sh
docker logs -f <writer-a container> 2>&1 | grep -E 'live-switch|backfill|ERROR'
docker exec <writer-a container> node scripts/live-switch.mjs status
```
The log ends with `[live-switch] bootr_live now points at bootr_v11 (was bootr_v10): caught up with bootr_v10 (0 s apart)`.
The site never notices.

Then retire the compose indexer: a commit that removes the `indexer` service from `docker-compose.coolify.yml` (and
`indexer` from the `depends_on` of `web`, `supervisor` and `dataset`), and a stack deploy. Until that deploy the
compose indexer keeps filling `bootr_v10`, which costs RPC budget and nothing else; it does not take the views back.
Keep `bootr_v10` for a day as the way back, then `drop schema bootr_v10 cascade;`.

Way back, at any point before `bootr_v10` is dropped and while something still fills it:
`node scripts/live-switch.mjs switch bootr_v10`, then stop `bootr-indexer-writer-a`.

Create `bootr-indexer-writer-b` the same way when the next change comes (section 6), with its own `DATABASE_SCHEMA`.

### Step 6: the web as its own app

1. On the server: `docker volume ls | grep web-data` (expected `ko7sx54pwakworrqogccvbfc_web-data`).
2. New resource → Docker Image → `ghcr.io/dnebayis/bootr-web:main`, same destination, name `bootr-web`.
   - Ports Exposes `3000`. No port mapping.
   - Storages: add a volume mounted at `/data`, then rename the storage to the exact volume name from 1.
   - Health check: enabled, type command, `node healthcheck.mjs`, interval 5, timeout 5, retries 12, start period 5.
   - Resource limits: memory `1g`.
   - Variables, the web's own and no other service's: `PORT=3000`, `HOSTNAME=0.0.0.0`, `SESSION_SECRET`,
     `SENDER_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `BASE_RPC_URL`, `ADMIN_CONSOLE_SLUG`, `ADMIN_ADDRESSES`,
     `PINATA_JWT`, `SUPERVISOR_SERVICE_KEY`, `BLOCKRUN_IMAGE_ROUTE`, `TRUSTED_PROXY`, `OWN_AGENT_ENABLED`, with the
     stack's values, and `SENDER_URL=http://sender:3002`, `INFERENCE_URL=http://inference:3003`,
     `SUPERVISOR_URL=http://supervisor:3004` (plan B: the `<service>-ko7sx54pwakworrqogccvbfc` names). The
     `env -u` list of the compose command is not needed: this app holds no other service's secret.
   - No domain yet. Deploy.
3. Check inside the network: `docker exec <supervisor container> node -e "fetch('http://<web container name>:3000/api/health').then(r=>console.log(r.status))"`.
4. Domains on `bootr-web`: `https://bootr.fun,https://www.bootr.fun` (confirm the conflict), deploy. Both webs answer
   and both write the same `/data` for a while, so do this at a quiet moment and do not edit the admin config or
   launch a coin until 5 is done.
5. A commit that removes the `web` service from the compose file (its `web-data` volume entry stays declared, so the
   volume is not orphaned by a prune), clear its domain in the stack, deploy the stack.

Way back before 5: remove the domains from `bootr-web` and stop it. After 5: revert the commit, set the domain on
the compose service again, deploy the stack, stop `bootr-web`.

From here a web change is a rolling update of `bootr-web`: the new container must answer `/api/health` before the old
one stops. For those seconds two containers share `/data`.

### Step 7: CI

`.github/workflows/images.yml` asks Coolify to deploy `bootr-stack` after every push. Once the apps exist, the deploy
job should call the web app always, the reader only when the push needs no new schema (the check of
`apps/indexer/README.md`: no change under `apps/indexer/src` outside `src/api`, `ponder.schema.ts` or
`ponder.config.ts`), the stack only when sender, inference, supervisor or the compose file changed, and a writer
never. That change needs the apps' uuids, so it is not in this branch.

## 6. The routine for an indexing change

1. Push. CI builds `ghcr.io/dnebayis/bootr-indexer:main`. Do not deploy the reader yet if `ponder.schema.ts` changed.
2. On the stopped writer app (say `-b`): set `DATABASE_SCHEMA` to the next name (`bootr_v12`), deploy.
3. Wait. `node scripts/live-switch.mjs status` shows it backfilling, then ready, then `*` on it. The log line
   `bootr_live now points at bootr_v12` is the switch. Nothing to do at that moment.
4. Deploy the reader (rolling), so its API code matches the new tables.
5. Stop the old writer app (`-a`). Next day: `drop schema bootr_v11 cascade;`.

If the new index is wrong after the switch and the old writer is still running:
`node scripts/live-switch.mjs switch bootr_v11` puts the site back on the old one at once.

A writer restart with the same schema (an env change, a crash) is the app's Restart or Redeploy: the reader keeps
answering with the data as it stood, then Ponder steps back to the last finalized block (about 3 minutes of chain)
and catches up. That is what any restart does today.

The shape rule: the reader's code and the tables it reads change at different moments (steps 3 and 4). A release
that only adds tables or columns is invisible. One that removes or renames a column the API reads makes those
queries fail between 3 and 4; add in one release and remove in the next, or use `INDEXER_SWITCH=manual` on the
writer and run the switch and the reader deploy together.

## 7. What a client sees

| Event | Reader |
| --- | --- |
| New schema filling | the old schema, complete and live |
| The switch | no error; the head does not step back |
| Reader deploy | rolling; SSE clients reconnect |
| Writer restart or crash | 200 with the head standing still, then about 3 minutes back and catching up |
| `bootr-stack` deploy | postgres restarts with the stack, so the reader and the web fail their database reads for that minute |

The last row is what is left of the old downtime: the database lives in the stack. Moving sender, inference,
supervisor and dataset out the same way (or the database to its own resource) would end it; not part of this move.

## 8. Not verified

- Anything in Coolify on the production version (v4.5.x): the destination on the stack's network (plan A), the
  command health check, the storage rename onto the compose volume, the forced domain overlap, a compose service's
  domain being cleared without side effects.
- A production-size overlap: memory of two writers, Postgres connections, and the RPC budget split of section 3.
- `DATABASE_SCHEMA=auto` with the views: `scripts/schema-janitor.mjs` keeps the current automatic schema and the
  newest previous one and drops the rest with `cascade`, which would take the views with it if they pointed at an
  older one. Production uses fixed names; before `auto` is used with a writer, the janitor has to skip the schema the
  views point at (that file is being changed on another branch).
- `INDEXER_SWITCH=ponder` through `start.sh`.
