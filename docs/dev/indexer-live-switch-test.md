# Indexer live switch: the local test (2026-11-25)

What was run on a Mac to find out whether a new index schema can take over from the old one without the site reading
a half-filled index, and what came out. The design that follows from it is in
[`docs/deploy/live-switch.md`](../deploy/live-switch.md). Times are UTC unless a log line is quoted (Ponder logs local
time, UTC+3 here).

## Summary

| Question | Result |
| --- | --- |
| Does `ponder serve` run Bootr's API? | Yes: GraphQL, every REST route tried, the signed `POST /internal/agent/:kernel/social` (it wrote `bootr_offchain.agent_social`) and the SSE `/stream`. It takes its schema from `--schema` (or `DATABASE_SCHEMA`), so `ponder serve --schema <views schema>` reads the views; `db` from `ponder:api` and the tables of `ponder:schema` both resolve to that schema. |
| A client polling the reader every 200 ms during a switch | 0 failed requests in every run (3,687, 4,047 and 2,463 requests around three switches), no response slower than 42 ms, no gap between ticks. The views are dropped and created in one transaction. |
| Ponder's own `DATABASE_VIEWS_SCHEMA` | Works, but switches when the backfill ends, which is the finalized block: the head the reader reports stepped back 1,079 blocks (216 s) and took 69 s to pass the old head again. Every start of a writer that carries the variable takes the views again, so a restarted old writer took them back from the new one. |
| The switch in `scripts/live-switch.mjs` (what `INDEXER_ROLE=writer` uses) | Switches once the new schema's head has reached the served one's: 0 failed requests and the head never went backwards (last run). A restarted old writer leaves the views alone. |
| Writer restart with the same build id | The reader keeps answering 200 with the data as it stood (42 s in the test), then the head steps back to the last finalized block (945 blocks, 189 s) and catches up. That is Ponder's crash recovery and is what a restart does today too. |
| Two writers on one schema | Ponder refuses the second one, and that refusal clears the first one's lock flag: the next attempt passed the lock check while the first writer was still running. `INDEXER_ROLE=writer` therefore checks the heartbeat itself and waits without starting Ponder. |
| A half-built schema of an abandoned attempt | A later writer with different code or config is refused on it ("previously used by a different Ponder app"). Drop it or use the next name. |

Not covered: Base mainnet with the real sources (only the snapshot handler runs on Base Sepolia, so the tables were
almost empty), memory and Postgres load at production size, and anything in Coolify.

## Setup

- No Docker on the Mac. A throwaway Postgres 16.15 cluster (Homebrew) in a temp directory, port 54329,
  `max_connections=100`, TCP only:
  ```sh
  initdb -D $S/pgdata -U bootr --auth=trust -E UTF8
  pg_ctl -D $S/pgdata -o "-p 54329 -c listen_addresses=127.0.0.1 -c max_connections=100 -c unix_socket_directories=''" -l $S/pg.log start
  psql -h 127.0.0.1 -p 54329 -U bootr -d postgres -c "create database bootr"
  ```
- The real indexer app (`apps/indexer`, Ponder 0.18.2, Node 24.11.1) on Base Sepolia, where only the snapshot block
  handler runs (ETH/USD and the platform rollups; 30 tables are created all the same). Environment of every process:
  ```sh
  export CHAIN_ID=84532
  export INDEXER_DATABASE_URL=postgres://bootr@127.0.0.1:54329/bootr
  export BOOTR_START_BLOCK=63272700          # about 60,000 blocks behind the head, so a backfill takes 10 to 60 s
  export INDEXER_SERVICE_KEY=<a throwaway key>
  export NODE_ENV=production INDEXER_CORS_ORIGIN=https://bootr.fun
  ```
  RPC: the public `https://base-sepolia.gateway.tenderly.co` (the app's default). It answers 429 in bursts with one
  writer and more with three, which slowed every catch-up below; `base-sepolia-rpc.publicnode.com` and
  `sepolia.base.org` prune old blocks and stall Ponder's finality search.
- A different build id for each new writer without touching a file: `INDEXER_SNAPSHOT_INTERVAL` (150, 100, 120) and
  another `BOOTR_START_BLOCK` change the `blocks` config, which Ponder hashes.
- The client: a Node script that every 200 ms sends `POST /graphql` (`agents`, `platformStatss`, `_meta`),
  `GET /tokens/list` and `GET /status` to the reader in parallel with a 5 s timeout and writes one line per tick
  (HTTP codes, latencies, the head block, the agent count).
- One row was inserted by hand into `t_v1.agent` (with `session_replication_role = replica` so Ponder's triggers stay
  out of it): the signed POST needs an indexed agent, and it marks which schema a response came from.

## Part 1: Ponder's own views (`DATABASE_VIEWS_SCHEMA`)

Processes were started as `ponder start --schema <name>` and `ponder serve --schema t_live` directly.

### 1.1 Writer A becomes ready and the views appear

```sh
PORT=42101 DATABASE_VIEWS_SCHEMA=t_live ponder start --schema t_v1
```
```
09:34:24.201 INFO  Created database tables count=30 ...
09:34:24.353 INFO  Started returning 200 responses endpoint=/health
09:34:24.655 INFO  Started backfill indexing chain=baseSepolia block_range=[63272700,63332060]
09:34:36.313 INFO  Completed backfill indexing across all chains (11s)
09:34:36.445 INFO  Created database views schema=t_live count=30 (43ms)
09:34:36.446 INFO  Started returning 200 responses endpoint=/ready
```
`select viewname, definition from pg_views where schemaname='t_live'`: 32 views, one per table plus `_ponder_meta` and
`_ponder_checkpoint`, each `SELECT <columns> FROM t_v1.<table>`. `/health` is 200 from the moment the HTTP server is
up (4 s after start, before the backfill); `/ready` is 503 `Historical indexing is not complete.` until the backfill
ends; `/status` is `{}` and then the block the backfill has reached.

### 1.2 `ponder serve` on the views

```sh
PORT=42100 ponder serve --schema t_live
```
```
09:35:03.810 INFO  Connected to database type=postgres database=127.0.0.1:54329/bootr (56ms)
[indexer] CORS origins (INDEXER_CORS_ORIGIN): https://bootr.fun
09:35:04.016 INFO  Created HTTP server port=42100 (1ms)
09:35:04.016 INFO  Started returning 200 responses endpoint=/health
```
`serve` loads `ponder.config.ts` and `src/api`, opens no RPC connection of its own and never indexes. By its source
(`dist/esm/bin/commands/serve.js`) it exits with `Schema does not exist.` when the schema is missing; not run here. Its `/ready` and `/status` read `_ponder_meta` and
`_ponder_checkpoint` through the views, so they report the schema the views point at. Results (the same list was run
again in part 2):

```
 [/health 200]
 [/ready 200]
{"baseSepolia":{"id":84532,"block":{"number":63338796,"timestamp":1795589628}}} [/status 200]
{"data":{"platformStatss":{"items":[{"id":"global","updatedAt":1795589597}]},"priceFeeds":{"items":[{"id":"ETH/USD"}]},"agents":{"items":[]}}} [/graphql]
[/tokens/list 200] {"items":[],"pageInfo":{"endCursor":null,"hasNextPage":false},"readAt":1795589720}
[/tokens/bumped 200] [/tokens/trending 200] [/platform/fees 200] [/platform/feed 200] [/search?q=boot 200]
[/leaderboards/volume 200] [/creator/0x…01 200] [/holdings/0x…01 200] [/fuel/0x…01 200]
[/treasury/0x…a1 404] {"error":"not_found"}      (no such coin on this chain)
[/market/0x…b1 404] {"error":"not_found"}
--- POST unsigned                      {"error":"unauthorized","reason":"missing_authorization"} [401]
--- POST signed, agent not indexed     {"error":"unknown_agent"} [404]
--- POST signed, fixture agent         {"ok":true,"social":{"kernel":"0x…a1","xHandle":"livetest",...,"postsCount24h":3,"status":"awake",...}} [200]
--- GET /stream (9 s)
event: ready
data: {}

data: {"type":"agent","tokenId":"0x00000000000000000000000000000000000000b1"}
--- bootr_offchain.agent_social
0x00000000000000000000000000000000000000a1|livetest|awake|3
```
The POST writes through the indexer's own `pg` pool (`src/lib/social-store.ts`), not through Ponder's read-only
handle, so it works under `serve`. The SSE hint arrived over the open stream after the POST. The routes that read the
chain live (`/treasury`, `/market`) were not exercised past their database lookup, because no coin exists on this
chain.

### 1.3 Writer B starts beside A, and the switch

```sh
PORT=42102 DATABASE_VIEWS_SCHEMA=t_live INDEXER_SNAPSHOT_INTERVAL=150 BOOTR_START_BLOCK=63244000 ponder start --schema t_v2
```
While B filled (06:39:55 to 06:40:33):
```
views -> t_v1
t_v1: build_id=11f145a41b is_ready=1 is_locked=1
t_v2: build_id=026646a0be is_ready=0 is_locked=1
:42100 (reader)  health=200 ready=200 status=…"number":63334704…
:42101 (A)       health=200 ready=200 status=…"number":63334704…
:42102 (B)       health=200 ready=503 status=…"number":63266350…     <- what the site reads today during a backfill
```
```
09:40:32.956 INFO  Completed backfill indexing across all chains (33s)
09:40:33.000 INFO  Created database views schema=t_live count=30 (13ms)
09:40:33.001 INFO  Started returning 200 responses endpoint=/ready
09:40:33.002 INFO  Started live indexing chain=baseSepolia finalized_block=63333740
```
The client (1,229 ticks from 06:37:01 to 06:41:08, which covers the whole backfill):
```
ticks 1229, requests 3687, failed or empty ticks 0
  max gqlMs 42 ms, max listMs 17 ms, max statusMs 11 ms
  CHANGE 06:40:32.917 agents=1 block=63334819 -> 06:40:33.118 agents=0 block=63333740 (gql 3 ms)
  gaps over 400 ms between ticks: none
before flip 06:40:32.917 63334819 after 06:40:33.118 63333740 reader passes the pre-flip head at 06:41:42.352
```
Until 06:40:32.917 every response was A's complete, advancing data; the next tick was B's. No error and no blank
response. But B became "ready" at the block that was finalized when it started its last pass, 1,079 blocks (216 s of
chain time) behind what A was serving, and needed 69 s to pass it. On Base mainnet that step is the 180 s reorg window
plus whatever passed during the last pass.

Two side observations on the way there:
- A first attempt at B (another RPC, too slow) was killed at 1% and started again with another start block: `MigrationError:
  Schema "t_v2" was previously used by a different Ponder app. Drop the schema first, or use a different schema.` The
  half-built schema had to be dropped (`drop schema t_v2 cascade`). The views were on `t_v1` throughout.
- A writer that cannot reach its RPC at start creates no schema at all.

### 1.4 The writer that has the views crashes and restarts

`kill -9` of B at 06:42:29, restart at 06:42:55 with the same command:
```
09:42:59.979 INFO  Detected crash recovery build_id=026646a0be last_active=31ss schema=t_v2
09:43:00.329 INFO  Started backfill indexing chain=baseSepolia block_range=[63334450,63334645]
09:43:00.558 INFO  Created database views schema=t_live count=30 (9ms)
09:43:00.558 INFO  Started returning 200 responses endpoint=/ready
```
```
ticks 329, requests 987, failed or empty ticks 0
  CHANGE 06:43:00.290 agents=0 block=63335402 -> 06:43:00.491 agents=0 block=63334500 (gql 2 ms)
```
While B was dead the reader went on answering 200 with the head standing at 63335402. On restart Ponder reverted the
tables to the last finalized checkpoint, so the head stepped back about 900 blocks and caught up from there. The views
stayed on a usable schema the whole time.

### 1.5 An older writer restarts while the new one has the views

A was stopped (SIGTERM) and started again with its original command while B had the views:
```
09:43:42.842 INFO  Detected crash recovery build_id=11f145a41b last_active=18ss schema=t_v1
09:43:43.191 INFO  Completed backfill indexing across all chains (18ms)
views -> t_v1          <- taken back from t_v2
```
Any writer that has the variable repoints the views at the end of its start, whichever schema is newer. Nothing breaks
while both run, but stopping "the old one" afterwards would leave the views on a schema nobody fills.

### 1.6 Two writers on one schema

A second `ponder start --schema t_v2` while B was running:
```
09:44:07.952 WARN  Schema is locked by a different Ponder app schema=t_v2 retry_delay=17066
09:44:25.031 ERROR uncaughtException
MigrationError: Failed to acquire lock on schema "t_v2". A different Ponder app is actively using this schema.
```
Refused, but afterwards `t_v2._ponder_meta` read `is_locked=0` while B's heartbeat went on: the refused process
cleared the flag on its way out. A second attempt 30 s later passed the lock check:
```
09:45:00.244 INFO  Detected crash recovery build_id=026646a0be last_active=226mss schema=t_v2
09:45:00.245 ERROR uncaughtException
MigrationError: Finalized block for chain "84532" cannot move backwards
```
It died on a later check, in a transaction, and B went on indexing unharmed. That check depends on timing, so a
container that restarts in a loop on a schema another writer is using is not reliably kept out by Ponder.

## Part 2: the roles of `scripts/start.sh` and `scripts/live-switch.mjs`

Same database (schemas dropped), every process started through `sh scripts/start.sh` with `INDEXER_ROLE`,
`INDEXER_LIVE_SCHEMA=t_live` and `DATABASE_SCHEMA`.

### 2.1 Reader first, then writer A

```
$ INDEXER_ROLE=reader PORT=42100 sh scripts/start.sh
[live-switch] t_live has no views yet; waiting for a writer to switch (or run: node scripts/live-switch.mjs switch <schema>)
$ INDEXER_ROLE=writer DATABASE_SCHEMA=t_v1 PORT=42101 sh scripts/start.sh
[indexer] writer: ponder start --schema t_v1 (port 42101, views t_live, switch auto)
[live-switch] t_v1: waiting, the backfill is not complete
09:54:45.799 INFO  Completed backfill indexing across all chains (12s)
[live-switch] t_live now points at t_v1 (was nothing): no views yet
# the reader's log
[live-switch] t_live points at t_v1
[indexer] reader: ponder serve --schema t_live (port 42100)
09:54:49.336 INFO  Started returning 200 responses endpoint=/health
```
The reader answered nothing (connection refused) until the views existed, then came up in 3 s. The API list of 1.2 was
run against it with the same results.

### 2.2 A new writer takes over only when it has caught up

Last run (`t_v3` serving, `t_v4` new, `INDEXER_SNAPSHOT_INTERVAL=120`):
```
$ node scripts/live-switch.mjs status
t_live -> t_v3
  t_v1  build b4e541caed  ready  no writer (heartbeat 270 s ago)  265 s behind the clock
  t_v2  build 330682ec9f  ready  no writer (heartbeat 268 s ago)  266 s behind the clock
* t_v3  build 879bc4484a  ready  writer alive  1 s behind the clock
$ INDEXER_ROLE=writer DATABASE_SCHEMA=t_v4 PORT=42104 sh scripts/start.sh        # 07:11:21
[live-switch] t_v4: waiting, the backfill is not complete
10:11:55.648 INFO  Completed backfill indexing across all chains (30s)
[live-switch] t_v4: waiting, 214 s behind t_v3
[live-switch] t_v4: waiting, 85 s behind t_v3
[live-switch] t_live now points at t_v4 (was t_v3): caught up with t_v3 (0 s apart)     # 07:13:17.869
```
```
ticks 821 (07:11:21.347 .. 07:14:05.909), requests 2463, failed or empty ticks 0
  max gqlMs 28 ms, max listMs 17 ms, max statusMs 14 ms
  gaps over 400 ms between ticks: none
```
No `CHANGE` line: the head the reader reported never went backwards (63344642 at 07:13:17.747, 63344645 at
07:13:17.948). The 82 s between "ready" and the switch is the new writer replaying the reorg window on a rate-limited
public RPC next to two other writers.

Two earlier runs of the same step, with rules that were then tightened:
- `t_v1` to `t_v2`: the switch fired on "17 s behind the clock" while the served schema was ahead of that; the head
  stepped back 60 blocks (12 s). 2,124 requests, 0 failed. The clock is now only the measure when the served schema
  has no writer.
- `t_v2` to `t_v3`: allowed 2 s of slack; the head stepped back 9 blocks (1.8 s). 4,047 requests, 0 failed. The
  default slack is now 0.

`bootr_offchain.live_switch` after all runs:
```
1|06:54:46.077||t_v1|no views yet
2|06:57:27.064|t_v1|t_v2|17 s behind the clock
3|07:02:46.784|t_v2|t_v3|caught up with t_v2 (-2 s apart)
4|07:04:50.530|t_v3|t_v2|switched by hand
5|07:04:54.672|t_v2|t_v3|switched by hand
6|07:13:17.869|t_v3|t_v4|caught up with t_v3 (0 s apart)
```

### 2.3 The old writer restarts after it lost the views

```
$ INDEXER_ROLE=writer DATABASE_SCHEMA=t_v1 PORT=42101 sh scripts/start.sh     # right after a SIGTERM of the same writer
[live-switch] another process is writing t_v1 (heartbeat under 30 s old); not starting a second writer on it   (3 times)
[indexer] writer: ponder start --schema t_v1 (port 42101, views t_live, switch auto)
[live-switch] t_v1: the views moved on to t_v2; this schema had them before and does not take them back on its own
09:58:50.823 INFO  Detected crash recovery build_id=b4e541caed last_active=37ss schema=t_v1
views -> t_v2
```
(The wait after a clean stop was shortened afterwards: a cleared lock flag is believed after 15 s without a heartbeat.)

### 2.4 Rollback by hand

With three writers alive and the client polling:
```
$ node scripts/live-switch.mjs switch t_v2
[live-switch] t_live now points at t_v2 (was t_v3): switched by hand
$ node scripts/live-switch.mjs switch t_nope
[live-switch] failed: schema t_nope is not a Ponder index (no _ponder_meta)
$ node scripts/live-switch.mjs switch t_v3
[live-switch] t_live now points at t_v3 (was t_v2): switched by hand
ticks 55, requests 165, failed or empty ticks 0
```

### 2.5 A second writer on a schema in use

```
$ INDEXER_ROLE=writer DATABASE_SCHEMA=t_v3 PORT=42104 sh scripts/start.sh     # while the first t_v3 writer runs
[live-switch] another process is writing t_v3 (its heartbeat is fresh); not starting a second writer on it   (every 10 s)
t_v3: build_id=879bc4484a is_ready=1 is_locked=1        <- the first writer's lock flag is untouched
```
Ponder was never started and port 42104 never opened, so a health check on it fails and a deploy of it is rolled back.

### 2.6 The writer that has the views is killed and restarted

```
kill -9 at 07:05:07, sh scripts/start.sh again at 07:05:15
[live-switch] another process is writing t_v3 (its heartbeat is fresh); not starting a second writer on it   (3 times)
[indexer] writer: ponder start --schema t_v3 (port 42103, views t_live, switch auto)
[live-switch] t_v3: the views already point at this schema
10:05:49.329 INFO  Detected crash recovery build_id=879bc4484a last_active=43ss schema=t_v3
ticks 429, requests 1287, failed or empty ticks 0
  CHANGE 07:05:49.485 agents=0 block=63342188 -> 07:05:49.685 agents=0 block=63341243 (gql 2 ms)
head stood still from 07:05:06.726 to 07:05:49.485; stepped back 945 blocks; passed the old head at 07:06:32.231
```
The same as 1.4. While an older writer is still running, `live-switch.mjs switch <its schema>` moves the reader to a
live head at once instead (2.4).

## Numbers seen on the way

- Postgres connections: a writer held 2 to 7 (`<schema>_internal` 1, `<schema>_user` 1, `ponder_sync` 1 to 5 during a
  backfill), the reader 5 (`t_live_readonly`) under the client's 15 requests a second, the switch 1 for a moment.
  Three writers and the reader together: 14. Ponder's ceilings are far higher: a pool `max` of 30 by default, split
  as 2 internal and 9 each for user, read-only and sync in `start` (29), and 2 internal and 28 read-only in `serve`
  (30); the social store adds 2 in each process.
- Memory (RSS on macOS, almost empty tables): writers 384 to 451 MB, the reader 207 MB.
- `ponder create-views --schema <s> --views-schema <v>` (Ponder's CLI for the same switch) runs each drop and create as
  its own statement (read in `dist/esm/bin/commands/createViews.js`, not run here), so a reader can hit a missing view
  in between. `live-switch.mjs switch` does it in one transaction.
- `INDEXER_SWITCH=ponder` in `start.sh` (hand the switch to Ponder) was not run through `start.sh`; part 1 ran the
  same variable directly.
