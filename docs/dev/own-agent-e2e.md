# Own agents end to end, on a local stack

How to run `packages/mcp/test/own-agent-e2e.mjs` and its flag-off pass again. The script drives the built MCP server
as a real stdio process with a real MCP client, through the real web routes, the supervisor, the sender and a Base
fork. Only X is a stand-in (`packages/mcp/test/stub-x.mjs`). The script's own header is the source for what it checks
and for every variable it reads; this page is the order of work and the things the first run (2026-11-13) had to find
out.

The script starts nothing itself and refuses anything that is not local. Nothing here needs a production secret: every
key below is made for the run and thrown away with it. Keep the run's files in one folder outside the repository
(`RUN` below), and never write the RPC URL of the fork's upstream into a file.

Ports used below: Postgres 5544, the fork 8555, the stub X 4010, the tripwire 4020, the sender 3002, the supervisor
3004, the indexer 42069, the web 3200. Any free ports do; keep them the same in every step.

## 1. Build

```sh
pnpm install
pnpm --filter @bootrfun/sdk build && pnpm --filter @bootrfun/mcp build   # the script runs packages/mcp/dist/index.js
```

## 2. A throwaway Postgres

A cluster of its own, made with `initdb`, so no existing database is touched:

```sh
export RUN="$(mktemp -d)"                      # everything of this run lives here
LC_ALL=en_US.UTF-8 initdb -D "$RUN/pg" -U bootr --auth=trust
pg_ctl -D "$RUN/pg" -l "$RUN/pg.log" -o "-p 5544 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start
psql -h 127.0.0.1 -p 5544 -U bootr -d postgres -c 'create database bootr'
export DATABASE_URL=postgres://bootr@127.0.0.1:5544/bootr
pnpm db:migrate                                # sender 0003 and supervisor 0011 are among them
```

- `initdb` needs a UTF-8 locale: without `LC_ALL=en_US.UTF-8` it can pick one the machine does not have and stop.
- TCP only (`unix_socket_directories=''`): a Unix socket's path has a short length limit, and a temporary folder's
  path is longer than it on macOS, so the server does not start with a socket there.

## 3. The fork

`base-anvil` (Base's Foundry build, `docs/deploy/coolify.md` section 8) forking Base mainnet, with a block every
second so receipts and the indexer move. `BASE_RPC_URL` is the upstream RPC, exported in the shell and nowhere else;
anvil prints it at start, so its output goes through a filter before it reaches a file:

```sh
base-anvil --fork-url "$BASE_RPC_URL" --chain-id 8453 --port 8555 --block-time 1 2>&1 \
  | sed "s|$BASE_RPC_URL|<upstream rpc>|g" > "$RUN/anvil.log" &
export RPC=http://127.0.0.1:8555
export FORK_BLOCK=$(cast block-number --rpc-url $RPC)    # note it now: the indexer starts from here
```

Anvil's first account is the creator in every part of the script (the script holds its well-known test key). Pick
another of anvil's accounts as the admin of the run; `ADMIN` is its address and `ADMIN_KEY` its key, as anvil printed
them.

**Hand `AgentGuardian` to the admin account.** A coin leaves setup only when its session key is installed, and only
the guardian's owner can approve one. On the fork the owner is the production admin, whose key is not here, so the
ownership is moved with anvil's impersonation. It is two steps (`Ownable2Step`):

```sh
GUARDIAN=0x799Ab875294E37839883D12084aB4BE3f7633630      # AgentGuardian on Base, public
OWNER=$(cast call $GUARDIAN "owner()(address)" --rpc-url $RPC)
cast rpc anvil_impersonateAccount $OWNER --rpc-url $RPC
cast rpc anvil_setBalance $OWNER 0xde0b6b3a7640000 --rpc-url $RPC
cast send $GUARDIAN "transferOwnership(address)" $ADMIN --from $OWNER --unlocked --rpc-url $RPC
cast send $GUARDIAN "acceptOwnership()" --private-key $ADMIN_KEY --rpc-url $RPC
cast call $GUARDIAN "owner()(address)" --rpc-url $RPC    # must print $ADMIN
```

The fork keeps its state in memory: after a restart of anvil, do this step again, note the new `FORK_BLOCK` and start
the indexer on a new schema.

## 4. Secrets of the run

Fresh ones, each from `openssl rand -hex 32`, exported in the shell or kept in `$RUN/env` (outside the repository):
`SENDER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `SENDER_ENCRYPTION_KEY`, `SESSION_SECRET`,
and, with `0x` in front, `SESSION_SIGNER_PRIVATE_KEY` and `SPENDER_MASTER_KEY`. The rest of each service's settings
(the contract addresses of Base mainnet, the X client id and secret, which can be any words here) are as in
`.env.example` and `.env.mainnet.example`; only what differs for this run is listed below.

## 5. The services, in this order

**The stub X.** `STUB_X_USER_ID` and `STUB_X_HANDLE` must be the ones the seed script stores (its defaults are in
`apps/supervisor/scripts/seed-own-agent.ts`):

```sh
STUB_X_PORT=4010 STUB_X_USER_ID=990001 STUB_X_HANDLE=own_seed_agent node packages/mcp/test/stub-x.mjs &
```

**The tripwire.** A small HTTP server that answers every request with an error and prints it. The supervisor's
`INFERENCE_PROVIDER_URL` and `X402_DISCOVERY_URL` point at it, so a thought bought for an own coin, or a paid-service
lookup nobody asked for, cannot go unseen: the run must end with nothing printed here.

```sh
node -e 'require("node:http").createServer((q,s)=>{console.log("TRIPWIRE",q.method,q.url);s.writeHead(500).end("{}")}).listen(4020,"127.0.0.1")' &
```

**The sender**, with X pointed at the stub: `PORT=3002`, `DATABASE_URL`, `SENDER_SERVICE_KEY`,
`SENDER_ENCRYPTION_KEY`, `X_API_BASE_URL=http://127.0.0.1:4010`.

**The indexer**, started live. It must not read Base's history through the fork, so every launcher it follows is
named at the fork block and it gets a schema nothing else has used:

```sh
CHAIN_ID=8453 BASE_RPC_URL=$RPC INDEXER_DATABASE_URL=$DATABASE_URL \
  BOOTR_LAUNCHERS=<launcher>@$FORK_BLOCK \
  pnpm --filter indexer exec ponder start --schema e2e_$FORK_BLOCK
```

`<launcher>` is the `BootrLauncher` the web launches through (`NEXT_PUBLIC_LAUNCHER_ADDRESS`, a public address in
`.env.mainnet.example`).

**The supervisor**, with own agents on and a short tick:

| Setting | Value for this run | Why |
| --- | --- | --- |
| `OWN_AGENT_ENABLED` | `true` | the feature's one flag |
| `SUPERVISOR_TICK_MS` | `5000` | the script waits for the tick to register its coin |
| `CHAIN_ID`, `BASE_RPC_URL` | `8453`, `$RPC` | the fork |
| `LAUNCHER_START_BLOCK` | `$FORK_BLOCK` | launches are scanned from the fork on |
| `SENDER_URL`, `INDEXER_URL` | the local sender and indexer | |
| `INFERENCE_PROVIDER_URL`, `X402_DISCOVERY_URL` | `http://127.0.0.1:4020` | the tripwire |
| `ADMIN_PRIVATE_KEY` | `$ADMIN_KEY` | owns the guardian on the fork (step 3) |
| `ENABLE_MODE_SELF_BUNDLE` | `true` | the session key is installed without a bundler |
| `SITE_URL` | unset, or any public-looking name | **not a localhost address**: the link a bounty job's post carries goes through the publish gate, which refuses a post that names localhost |

**The web**, in `next dev`:

```sh
OWN_AGENT_ENABLED=true NEXT_PUBLIC_USE_MOCK=0 NEXT_PUBLIC_CHAIN_ID=8453 NEXT_PUBLIC_SITE_URL=http://localhost:3200 \
  NEXT_PUBLIC_RPC_URL=$RPC NEXT_PUBLIC_INDEXER_URL=http://127.0.0.1:42069 \
  SUPERVISOR_URL=http://127.0.0.1:3004 pnpm --filter web exec next dev -p 3200
```

with `SUPERVISOR_SERVICE_KEY`, `SENDER_SERVICE_KEY`, `SESSION_SECRET` and the launcher addresses in its environment.
`GET http://localhost:3200/api/platform` must answer `ownAgent: true` before the script is started.

## 6. Seed, then run

```sh
export E2E_SEED="$(pnpm --silent --filter supervisor exec tsx scripts/seed-own-agent.ts)"   # one JSON line

SITE=http://localhost:3200 RPC=$RPC STUB=http://127.0.0.1:4010 \
  SUPERVISOR_URL=http://127.0.0.1:3004 INDEXER_URL=http://127.0.0.1:42069 \
  node packages/mcp/test/own-agent-e2e.mjs
```

The seed script reads `DATABASE_URL` and `SENDER_ENCRYPTION_KEY` from the environment and refuses a database that is
not on this machine. The run script reads those two as well, and `SUPERVISOR_SERVICE_KEY` for the one check that
reads the coin's tape from the supervisor itself (the seeded coin is in the database and not on the fork, so the
indexer does not know it). It ends with "All parts passed" and the reminder of the last step.

**Before a second run, start the coin over.** The first part needs an original post due, no client connected and a
mention read the sender does not hold back, so seed again and empty the stub:

```sh
export E2E_SEED="$(pnpm --silent --filter supervisor exec tsx scripts/seed-own-agent.ts)"
curl -s -X POST http://127.0.0.1:4010/__stub/reset
```

## 7. The flag-off pass

Stop the supervisor and the web, start both again **without** `OWN_AGENT_ENABLED` (everything else unchanged), and run
the script with `FLAG_OFF=1`:

```sh
FLAG_OFF=1 SITE=http://localhost:3200 RPC=$RPC STUB=http://127.0.0.1:4010 node packages/mcp/test/own-agent-e2e.mjs
```

It checks that the site says `ownAgent: false`, that the MCP server lists no agent tool and that the run routes answer
`own_agent_disabled`. Then watch the supervisor's log for a few ticks: the seeded own coin must get no turn from the
Bootr agent, and the tripwire must have printed nothing during the whole run.

## 8. Clean up

```sh
pg_ctl -D "$RUN/pg" stop
kill %1 %2 %3 2>/dev/null     # anvil, the stub, the tripwire; stop the services where you started them
rm -rf "$RUN"
```

## When it fails

- **`initdb` stops on the locale**: `LC_ALL=en_US.UTF-8` was not set for that command.
- **Postgres does not start, the log names the socket**: the temporary path is too long for a Unix socket; start it
  with TCP only, as above.
- **The launched coin never leaves setup** (the part that launches a coin waits and times out): the guardian on the
  fork is not owned by `ADMIN_PRIVATE_KEY`'s account (step 3 is lost when anvil restarts), or
  `ENABLE_MODE_SELF_BUNDLE` is not `true`.
- **A bounty job's post is refused by the publish gate**: the supervisor's `SITE_URL` is a localhost address.
- **The first part finds no post due, or `due` shows no mention**: the coin was not seeded again, or the stub was not
  reset, after the last run.
- **The tape answers `unknown_coin`**: `SUPERVISOR_URL` and `SUPERVISOR_SERVICE_KEY` were not given to the script.
- **The indexer reads for a long time before it answers**: a launcher is named at its mainnet block and not at
  `$FORK_BLOCK`, or the schema was used before.
- **The tripwire printed a line**: stop and read it. Something asked for a thought or a service on behalf of an own
  coin, which is exactly what must never happen.
