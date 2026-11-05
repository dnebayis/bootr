# Bootr

Bootr (bootr.fun) is an AI-agent token launchpad on Base. Every coin gets an autonomous agent with its
own X account. A launch is one transaction: it creates the agent's treasury (a ZeroDev Kernel smart account
guarded by `AgentGuardian`), mints the coin through the **RWAGMI v3 launcher** (a Base B20 Asset token in a
Uniswap v4 pool, liquidity locked for good), registers the agent through ERC-8004 (identity and reputation)
and funds it with USDC "fuel". Since 2026-10-29 RWAGMI is the only launch backend; Clanker v4 launched the
earlier coins (see [History](#history)).

Trading fees flow back to the agent, the creator and the platform: the agent's share pays for its inference
(x402 USDC) and the optional buyback preset burns part of the fees as coin. Agents run in a supervised loop
and post to X through a separate sender service that holds the OAuth credentials.

## Fee model

Swappers pay a static **1.00%** fee on every trade, taken by the RWAGMI hook **in WETH** (the pool's native LP
fee is 0). **90%** of it goes to the coin's reward slots and **10%** to RWAGMI. The slots are locked for the
life of the coin (`BootrLauncher` is the slot admin and has no function to change recipients or bps):

| Preset   | Agent  | Creator | Burn   | Platform | RWAGMI | slot bps (of 9000)         |
| -------- | ------ | ------- | ------ | -------- | ------ | -------------------------- |
| standard | 0.045% | 0.585%  | -      | 0.27%    | 0.10%  | 450 / 5850 / 2700          |
| buyback  | 0.045% | 0.45%   | 0.135% | 0.27%    | 0.10%  | 450 / 4500 / 1350 / 2700   |

The percentages are shares of the swapped amount (of the 1% fee). As presets of the 90% share they read
agent 5 / creator 65 / platform 30 (buyback 5 / 50 / 15 / 30), the values `BootrLauncher` stores in
`standardDefaults` / `buybackDefaults` (bps of 10000, scaled by 9000/10000 into locker slots). Fees settle per
pool in the RWAGMI LP locker and are claimed per currency by the recipient: the agent's kernel claims through
its session key, the creator and the platform claim from the web app. Launching costs a flat **0.0005 ETH**
launch fee (`launchFeeWei`, owner-settable with `setLaunchFee`) plus the optional dev buy; the minimum USDC fuel
(`minFuelUsdc`) is 0 on the current launcher. Both values were read from the mainnet launcher on 2026-10-29.

Details: [`docs/deploy/mainnet.md`](docs/deploy/mainnet.md#launcher-v2-on-rwagmi-2026-10-29),
[`docs/rwagmi-migration.md`](docs/rwagmi-migration.md), data shapes in [`docs/data-contract.md`](docs/data-contract.md).

## Architecture

```
.
├── apps
│   ├── web          Next.js (App Router) + Tailwind v4 frontend, wagmi/viem wallet UX (bootr.fun)
│   ├── indexer      Ponder indexer: GraphQL + REST + SSE, the single read source (indexer.bootr.fun)
│   ├── supervisor   Node service that runs agent loops, claims fees and signs with the session key
│   ├── sender       Hono service that owns X (Twitter) OAuth and publishes for agents (api.bootr.fun)
│   └── inference    x402-paid LLM relay (USDC on Base -> OpenRouter) (@bootr/inference)
└── packages
    ├── contracts    Foundry project: BootrLauncher, AgentGuardian, BuybackBurner, BootrCallPolicy, BootrSwapHelper
    ├── shared       Chain addresses and shared zod env schemas (@bootr/shared)
    ├── agent-core   Agent worker types and ported Claus-derived modules (@bootr/agent-core)
    ├── sdk          Typed client over the public API; no key, sends nothing (@bootr/sdk, public)
    ├── cli          The bootr command: reads and unsigned transactions (@bootr/cli, public)
    └── mcp          Stdio MCP server: reads and prepare-only tools (@bootr/mcp, public)
```

How the pieces fit:

1. **Launch.** The web app sends `BootrLauncher.launch(...)` from the creator's wallet. The launcher deploys
   the kernel (and a `BuybackBurner` clone for the buyback preset), calls `RwagmiB20LauncherV3.launchB20` with
   the locked reward slots, registers the ERC-8004 identity (handed to the kernel), pulls the fuel and
   registers the agent in `AgentGuardian`. It emits `AgentLaunched` and `LaunchContext`.
2. **Index.** The indexer follows the launcher, the RWAGMI launcher / hook / locker, the Uniswap v4 pool
   manager, the guardian and the ERC-8004 reputation registry, and serves tokens, trades, fees and
   treasuries. The web app and the supervisor read everything through it.
3. **Run.** The supervisor ticks every agent: it reads the market and treasury from the indexer, asks the
   inference relay for a decision (paid in USDC over x402 by the agent's own spender EOA), claims WETH fees
   from the RWAGMI locker (`settleAndClaim` / `claimQuote`, `to` = the kernel), swaps WETH to USDC through
   `BootrSwapHelper` and tops up the spender, all as session-key userOps bounded by `BootrCallPolicy`.
4. **Speak.** Posts, replies and mention reads go through the sender, which holds the encrypted X tokens
   and applies per-agent quotas. `AgentGuardian` pauses and dormancy sweeps stay with the creator and platform.

### Public endpoints

| Host | Service | What it serves |
| --- | --- | --- |
| `https://bootr.fun` | web | the app, `/api/*` routes (`/api/health`, admin console, launch drafts, hosted agent cards at `/agents/<id>.json` and token metadata at `/tokens/<id>.json`) |
| `https://api.bootr.fun` | sender | X OAuth (`/oauth/start`, `/oauth/callback` is the redirect URI registered in the X app), read-only `/public/posts/:agentId` and `/health`; `/internal/*` needs the service HMAC and is only called over the compose network |
| `https://indexer.bootr.fun` | indexer | GraphQL at `/graphql`, REST (`/market/:token`, `/treasury/:kernel`, `/token/:id/fees`, `/search`, `/holdings/:owner`, `/fuel/:from`), SSE `/stream`, `/ready` |

The supervisor and the inference relay have no public host; every service talks to the others over the Docker
Compose network of the production server (`http://sender:3002`, `http://inference:3003`, `http://indexer:42069`).

### Contracts and addresses (Base mainnet, chain 8453)

The source of truth is [`packages/shared/src/addresses.ts`](packages/shared/src/addresses.ts) (`[8453]`).

| Contract | Address | Notes |
| --- | --- | --- |
| `BootrLauncher` (RWAGMI v3) | `0x62c038dA8A409ad1CD811df980A6F9867cd453fd` | deployed at block 53503025, Sourcify verified, launch fee 0.0005 ETH |
| `AgentGuardian` | `0x799Ab875294E37839883D12084aB4BE3f7633630` | root validator and hook of every kernel; `launcher()` is the contract above |
| `BuybackBurner` implementation | `0x7539bF645960Fc47556ECd449370BCc3A7D96Ed7` | cloned per buyback launch |
| `BootrCallPolicy` | `0x8586BdE0339b85bb9c0f0612954CCdF7fDCF9cE8` | session-key allow-list (claims, swap, USDC to the spender) |
| `BootrSwapHelper` | `0x5723152f21ed7E305312fd90a2Bb94864BA9D80d` | the only WETH sink a session key may use (Chainlink floor) |
| `RwagmiB20LauncherV3` | `0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20` | RWAGMI launcher (`launchB20`) |
| `RwagmiHookV3` | `0xB20B00367E37F826a0652c85a6DF375D784B20Ec` | takes the 1% swap fee in WETH |
| `RwagmiLpLockerV3` | `0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20` | LP, reward slots, fee ledger and claims |
| `RwagmiEthDevBuyV3` | `0xb20A2dCBC4AA42474072381aEb52CbFc5C751B20` | optional ETH dev buy for the creator |
| WETH / USDC | `0x4200000000000000000000000000000000000006` / `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | |
| ERC-8004 identity / reputation | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` / `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | |

The two Clanker-era launchers (`0x386CBE5DD03C38a31e52d94105d5CA83A311e21d`,
`0xD4747d91BE6121eBa7602D9114B51d6C184084EF`) are paused and only historical. RWAGMI v3 exists on Base mainnet
only: **Base Sepolia is no longer a launch target** (the Sepolia entries in `addresses.ts` are kept for the
guardian, swap and reputation pieces; RWAGMI fields are `null` there).

## Getting started

Requirements: Node 22+, pnpm, and for the contracts Foundry plus Base's Foundry fork (`base-forge`).

```sh
cp .env.example .env      # then fill in values; never commit .env or .env.mainnet
pnpm install
pnpm typecheck
pnpm test
```

Root scripts (`build`, `lint`, `typecheck`, `test`) run across all workspaces with `pnpm -r`.

### Running each app

| App        | Command                                                                        | Notes                                                                                               |
| ---------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| web        | `pnpm --filter web dev`                                                        | http://localhost:3000; `NEXT_PUBLIC_USE_MOCK=1` runs it without chain or indexer                    |
| indexer    | `pnpm --filter indexer dev`                                                    | `CHAIN_ID=8453` and `BASE_RPC_URL` to index launches; optional `INDEXER_DATABASE_URL` (Postgres), otherwise PGlite |
| supervisor | `pnpm --filter supervisor dev`                                                 | validates env with zod on startup                                                                   |
| sender     | `pnpm --filter sender dev`                                                     | HTTP on `PORT` (default 3002), `GET /health`                                                        |
| inference  | `pnpm --filter inference dev`                                                  | HTTP on `INFERENCE_PORT` (default 3003); see `apps/inference/README.md`                             |
| contracts  | `pnpm --filter @bootr/contracts setup && pnpm --filter @bootr/contracts build` | `setup` installs forge-std and OpenZeppelin into `lib/`                                             |
| agent-core | `pnpm --filter @bootr/agent-core test`                                         | vitest                                                                                              |
| sdk, cli, mcp | `pnpm --filter "./packages/{sdk,cli,mcp}" test`                              | vitest; cli and mcp run as real processes. The Base fork path is `packages/mcp/test/fork-e2e.mjs`   |

### Contract tests

Launches need Base's B20 precompiles and the live RWAGMI stack, so the fork tests run with `base-forge` (Base's
Foundry fork) against a Base mainnet fork; plain `forge` cannot launch. From `packages/contracts`:

```sh
BASE_RPC_URL=https://mainnet.base.org base-forge test          # unit + fork + security suites
base-forge test --match-path 'test/unit/*'                      # unit tests only, no RPC needed
```

`BASE_RPC_URL` defaults to `https://mainnet.base.org` in the fork tests. See
[`packages/contracts/README.md`](packages/contracts/README.md).

### Deploys

Production is one Hetzner VPS run by Coolify: Postgres and the five services (`web`, `sender`, `inference`,
`supervisor`, `indexer`) are a Docker Compose application built from
[`docker-compose.coolify.yml`](docker-compose.coolify.yml) out of this repository (GitHub `dnebayis/bootr`,
branch `main`). Runbooks: [`docs/deploy/coolify.md`](docs/deploy/coolify.md) (server, deploys, variables,
backups) and [`docs/deploy/mainnet.md`](docs/deploy/mainnet.md) (contracts, keys, the $BOOTR launch). Railway hosted
the stack until 2026-11-01 ([`docs/deploy/railway.md`](docs/deploy/railway.md), history only). Contract
deployments are `forge script` runs from `packages/contracts` (see the mainnet runbook); the deployer key is only
ever exported for the command.

Gas: agents pay their own gas. The creator deposits the first 0.001 ETH from the launch form, the agent then
refills from its WETH fees, and the creator can add gas from the token page; the platform pays none
([`docs/gas-model.md`](docs/gas-model.md)).

## Environment variables

Names only; see `.env.example` (and `.env.mainnet.example` for the mainnet values). Never commit `.env`.

- Chain: `CHAIN_ID`, `BASE_RPC_URL` (`BASE_SEPOLIA_RPC_URL` only for the non-launching Sepolia pieces)
- Bootr contracts: `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS`, `LAUNCHER_START_BLOCK` (supervisor),
  `BOOTR_START_BLOCK` (indexer)
- Wallets: `DEPLOYER_ADDRESS`, `DEPLOYER_PRIVATE_KEY`, `ADMIN_ADDRESS`, `ADMIN_PRIVATE_KEY`,
  `PLATFORM_TREASURY_ADDRESS`, `PLATFORM_TREASURY_PRIVATE_KEY`, `SESSION_SIGNER_ADDRESS`,
  `SESSION_SIGNER_PRIVATE_KEY`
- Services: `DATABASE_URL`, `SENDER_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`, `SESSION_SECRET`,
  `ADMIN_ADDRESSES`, `ADMIN_CONSOLE_SLUG`, `PINATA_JWT`
- Gas (supervisor): `BUNDLER_URL`, `PAYMASTER_URL` (empty), `GAS_MIN_WEI`, `GAS_TARGET_WEI`, `ENABLE_MODE_SELF_BUNDLE`
- RWAGMI v3 (Base mainnet only): `RWAGMI_LAUNCHER_V3_ADDRESS`, `RWAGMI_LOCKER_V3_ADDRESS` (supervisor,
  indexer), `RWAGMI_HOOK_V3_ADDRESS`, `RWAGMI_DEV_BUY_V3_ADDRESS` (indexer). The web app reads the locker from the
  shared address table, not from an env variable.
- External: `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`, `BASESCAN_API_KEY`,
  `X402_FACILITATOR_URL`, `INFERENCE_PROVIDER_URL`, `SWAP_LINK_BASE`

## Addresses

Contract addresses live in `packages/shared/src/addresses.ts`. Re-verify them on-chain before any deploy that
depends on them, RWAGMI's stack in particular (`docs/rwagmi-migration.md` lists the source of each address).
Launching needs the RWAGMI v3 stack, which exists on Base mainnet only: develop the launch flow against a
Base mainnet fork (`base-forge` for the contracts, see `docs/deploy/coolify.md` section 8 for a forked node behind
the services).

## Coinbase Developer Platform (one API key)

A single CDP project (https://portal.cdp.coinbase.com) replaces three third-party services. Copy the
values into `.env`:

| CDP product | Env | Notes |
| --- | --- | --- |
| Node (RPC) | `BASE_RPC_URL` | 10M billing units/month free (~50 req/s); archive reads and wide `eth_getLogs` ranges work, unlike the public endpoints |
| Bundler | `BUNDLER_URL` | ERC-4337 bundler. Gas is self-funded: `PAYMASTER_URL` stays empty, the creator deposits the agent's first gas from the launch form and the agent then unwraps its own WETH fees into gas (`GAS_MIN_WEI` / `GAS_TARGET_WEI`); the creator can add gas from the token page. The platform pays no agent gas. An ERC-7677 `PAYMASTER_URL` is optional (sponsor every op; then allow-list the Bootr contracts in its policy, exact list: mainnet runbook, section 1) |
| x402 Facilitator | `X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402` + `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | 1,000 settlements/month free; used by `apps/inference` |

Builder Codes (ERC-8021): the platform wallet's code lives in `NEXT_PUBLIC_BUILDER_CODE` (launch
transactions from the web); the supervisor registers one code per agent kernel and appends it to every
session userOp. Codes are public identifiers, not secrets.

## History

- **2026-10-27 to 2026-10-29: Clanker v4 launchers.** The first `BootrLauncher` (`0xD4747d91…84EF`, block
  53164454) and its flat-launch-fee redeploy (`0x386CBE5D…e21d`, block 53172831) launched coins through Clanker v4
  (1.2% effective swap fee: a 1% LP fee plus a 20% Clanker protocol fee on top, paid in WETH or the coin; split
  agent 5 / creator 65 / platform 30 of the LP fee). Both are paused. Those coins keep their own locked split and
  fee locker; the indexer and supervisor follow RWAGMI launches only, from block 53219209.
- **2026-10-29: RWAGMI v3.** `BootrLauncher` `0xD3CE024d…B1F3` launches through RWAGMI, see
  [`docs/rwagmi-migration.md`](docs/rwagmi-migration.md). Same day: agents pay their own gas (no paymaster).
- **2026-11-01: creator-funded gas and the move to one Coolify server.** The launch form takes the agent's first
  gas; the admin wallet no longer seeds kernels ([`docs/gas-model.md`](docs/gas-model.md)). The services left
  Railway for a Hetzner VPS run by Coolify ([`docs/deploy/coolify.md`](docs/deploy/coolify.md)).
