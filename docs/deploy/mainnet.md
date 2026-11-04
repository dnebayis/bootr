# Base mainnet cutover

Runbook for moving Bootr from Base Sepolia (84532) to Base mainnet (8453): contracts, keys, services and the
$BOOTR launch. Written for the Railway layout of 2026-10-27; since 2026-11-01 the services run on one Coolify
server ([`coolify.md`](./coolify.md)), which changes where variables are set and how deploys run, not what they
contain. Nothing here is automated: every step is a command you run and a check you read back.

Related: `packages/shared/src/addresses.ts` (the mainnet address book, every entry carries its source),
`packages/contracts/test/fork` and `test/security` (the Base mainnet fork suites that launch through this exact
configuration), `.env.mainnet.example` (every variable with its mainnet value or a placeholder).

> **Status (2026-10-29, updated 2026-11-03).** Current launcher: `0x01f290cC464Ac6D167588b35A08305F58683526f`, start block 53433988 (RWAGMI v3 backend; `scripts/switch-launcher.sh` rewrites this line).
> Sections 0-9 are the original Base Sepolia -> mainnet cutover of 2026-10-27, written for the Clanker v4 launcher;
> they stay the runbook for the guardian, call policy, swap helper, keys and services. Where a step depends on the
> launch backend it is marked *(Clanker era)* and superseded by
> [Launcher v2 on RWAGMI](#launcher-v2-on-rwagmi-2026-10-29) at the end of this file, which also holds the fee
> model, the launcher history and, since 2026-11-03, the procedure for replacing the launcher again:
> [Launcher switch (6k opening cap)](#launcher-switch-6k-opening-cap). Design:
> [`docs/rwagmi-migration.md`](../rwagmi-migration.md). Next: [Clanker path](#clanker-path) (gate, launcher v3.1,
> `BootrClankerLauncher`; design [`docs/design/clanker-launch.md`](../design/clanker-launch.md)), not deployed yet.

## 0. Dry-run first (no keys, no gas)

Fork rehearsal on a Base mainnet fork with `base-forge` (Base's Foundry fork with the B20 precompiles; stock `forge`
cannot launch through RWAGMI):

```sh
cd packages/contracts
BASE_RPC_URL=https://base-rpc.publicnode.com base-forge test --match-path 'test/fork/*' --match-path 'test/security/*' -vv
```

The suites deploy the stack in `setUp` and launch through the live RWAGMI v3 launcher (both presets, with and
without a dev buy), check the reward slots / bps / admins in the mainnet LP locker, the kernel's root validator and
the ERC-8004 identity owner, swap and claim fees as the kernel and the burner, install the production session
permission through the guardian's enable path on the live EntryPoint, and swap WETH -> USDC through the real
SwapRouter02 pool with the swap helper. Re-run them on the day of any deploy: RWAGMI can rotate modules without
notice, so re-verify the addresses in `docs/rwagmi-migration.md` first.

*(Clanker era, 2026-10-27: the same rehearsal was a `MainnetDryRun` fork suite that launched through Clanker v4. That
suite and its Clanker module checks are gone from the tree; the v1 launcher was deployed after it passed.)*

## 1. Pre-flight checklist

### Coinbase Developer Platform (mainnet project)

- [ ] **Node** (RPC): a Base *mainnet* Node URL (`https://api.developer.coinbase.com/rpc/v1/base/<key>`). This is
      `BASE_RPC_URL` for supervisor, indexer and web (SIWE) and `INFERENCE_RPC_URL`. The indexer backfill needs
      historical logs from the launcher's deploy block onwards (no archive state), budget `INDEXER_MAX_RPS` ~25.
- [ ] **Bundler**: the CDP bundler URL in `BUNDLER_URL`. Keep `ENABLE_MODE_SELF_BUNDLE=true` (CDP rejects
      enable-mode userOps; the admin EOA bundles them).
- [ ] **Gas model** (2026-10-29): agents pay their own gas, no paymaster. `PAYMASTER_URL` stays **empty**. Every
      kernel pays its userOp prefund from its EntryPoint deposit + ETH. The creator deposits the first gas: the
      launch form's Gas field (default 0.001 ETH, 0 allowed) sends `EntryPoint.depositTo(kernel)` right after the
      launch tx. The fee policy then unwraps the kernel's WETH fee share into ETH (`fund_gas` ops, `WETH.withdraw`)
      whenever gas drops under `GAS_MIN_WEI` (0.0002 ETH) up to `GAS_TARGET_WEI` (0.001 ETH). The creator can add gas
      from the token page or the console (`EntryPoint.depositTo(kernel)` from their own wallet); the platform pays
      no agent gas. ETH on a kernel can only leave as gas (no session-key rule carries value, the root validator is
      the guardian). An empty kernel sends nothing (`out_of_gas` in the supervisor log, "Out of gas" on the token
      page) until someone adds gas. Budget: a Base userOp costs ~0.00001–0.00003 ETH.
- [ ] **Paymaster policy allow-list** *(only if a `PAYMASTER_URL` is set to sponsor every op instead; not the
      default)*. Contracts a sponsored userOp may call, exactly:

  | Contract | Address | Called by |
  | --- | --- | --- |
  | `BootrLauncher` | filled in step 3 | creators launching through a sponsored smart wallet (`launch`) |
  | `AgentGuardian` | filled in step 3 | creators (`pauseAgent`, `unpauseAgent`) |
  | `BootrSwapHelper` | filled in step 3 | session keys (`swapWethToUsdc`) |
  | `RwagmiLpLockerV3` | `0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20` | session keys (`settleAndClaim(ids, WETH, kernel)`, `claimQuote(WETH, kernel)`) |
  | Clanker v4 `ClankerFeeLocker` (coins launched before 2026-10-29) | `0xF3622742b1E446D92e45E22923Ef11C2fcD55D68` | legacy session keys (`claim(kernel, token)`) only; the supervisor no longer claims from it. TODO(verify): the address comes from the Clanker-era address book (not in the tree any more); drop the row once those keys are rotated |
  | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | session keys (`transfer(spender, amount)`), creators (`approve(launcher)`) |
  | WETH | `0x4200000000000000000000000000000000000006` | session keys (`approve(swapHelper, amount)`) |
  | Uniswap v3 `SwapRouter02` | `0x2626664c2603336E57B271c5C0b26F421741e481` | internal call of the swap helper (`exactInputSingle`); add it if the policy inspects inner calls |

  Not needed any more: the Universal Router (session keys no longer touch it; the burner's `swapAndBurn` is an
  owner transaction, not a userOp). Set a per-userOp and daily USD cap on the policy.
- [ ] **Gasless campaign** *(paymaster mode only)*: apply with the mainnet project id and the allow-list above;
      until approved, the paymaster bills the CDP account.
- [ ] **x402 facilitator**: `X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402` with a *secret*
      API key (`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`) of the same project; `X402_NETWORK=eip155:8453`.
- [ ] If any CDP key is IP-restricted: the production server's IPv4 (`77.42.90.52`, one egress for every service).

### Keys and wallets (fresh, never reused from Sepolia)

| Role | Env | Funding before step 3 |
| --- | --- | --- |
| DEPLOYER | `PRIVATE_KEY` (forge only, never on the server) | **~0.02 ETH** (five deployments, ~8M gas, leaves headroom for a Base fee spike) |
| PLATFORM_ADMIN | `ADMIN_PRIVATE_KEY` (supervisor) | **~0.05 ETH + 20 USDC** (two `acceptOwnership`, `setDefaults`, `approveSessionKey` + the enable-op prefund per agent install / rotation, dormancy sweeps; the USDC is for an admin test launch). No agent gas: the creator funds each kernel's first gas at launch, the agent refills from its own fees. Keep the admin above ~0.01 ETH for installs and rotations |
| PLATFORM_RECIPIENT | address only | none (receives the platform slot: 27% of the 1% swap fee, 30% on pre-v2 Clanker coins) |
| PLATFORM_TREASURY | address + key on the operator's machine | **gas (~0.01 ETH) + the $BOOTR dev buy + 20 USDC fuel** (step 6; also receives dormant sweeps and inference revenue as `INFERENCE_PAYTO_ADDRESS`) |
| SESSION_SIGNER | `SESSION_SIGNER_PRIVATE_KEY` | **none** (kernels pay their own gas from their EntryPoint deposit: the creator's launch deposit, then their own WETH fees) |
| SPENDER_MASTER | `SPENDER_MASTER_KEY` | **none** (spenders are funded by their kernels; EIP-3009 needs no ETH) |

Also fresh: `SENDER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `SESSION_SECRET`,
`SENDER_ENCRYPTION_KEY`, `ADMIN_CONSOLE_SLUG`; `ADMIN_ADDRESSES` = the production admin wallets.

### X, DNS, misc

- [ ] X developer portal: production app with callback `https://api.bootr.fun/oauth/callback`, website
      `https://bootr.fun`; `X_CLIENT_ID` / `X_CLIENT_SECRET` of that app, `X_REDIRECT_URI` identical to the portal,
      `SENDER_OAUTH_RETURN_URL=https://bootr.fun/launch`.
- [ ] DNS: `bootr.fun` (apex, CNAME-flattening) -> `web`, `api.bootr.fun` -> `sender`, `indexer.bootr.fun` ->
      `indexer`, certificates issued (coolify.md section 5). `INDEXER_CORS_ORIGIN=https://bootr.fun`,
      `ADMIN_CONFIG_URL=https://bootr.fun/api/admin/config`, `NEXT_PUBLIC_SITE_URL=https://bootr.fun`.
- [ ] `NEXT_PUBLIC_BUILDER_CODE` registered for the mainnet platform wallet (Base Builder Codes).
- [ ] `BASESCAN_API_KEY` for `--verify` (or use `--verifier sourcify`; the Sepolia contracts are Sourcify matches).
- [ ] OpenRouter key with a spend limit; `INFERENCE_PRICE_TABLE_JSON` reviewed for mainnet margins.
- [ ] Postgres backups on; a fresh indexer schema name decided (`DATABASE_SCHEMA=bootr_mainnet_v1` or per-deployment).

## 2. Contract configuration

`script/Deploy.s.sol` reads everything from env. Mainnet values:

| Env | Value | Why |
| --- | --- | --- |
| `PLATFORM_ADMIN` | admin address (multisig or EOA, see section 9) | final owner of guardian + launcher (`Ownable2Step`) |
| `PLATFORM_RECIPIENT` | platform fee address | platform slot recipient of every launch |
| `PLATFORM_TREASURY` | treasury address | dormant sweeps |
| `MIN_FUEL_USDC` | `0` (script default; v1 was deployed with `20000000`) | minimum USDC fuel per launch. The current launcher (v2) reads `minFuelUsdc() = 0` on-chain (2026-10-29): `.env.mainnet.example` still shows 20 USDC as the `Deploy.s.sol` input |
| `DORMANCY_PERIOD` | `7776000` | 90 days |
| `MIN_PLATFORM_BPS` | `1000` | floor for `setDefaults` |
| `LP_FEE_BPS` | `10000` | hook swap fee in hundredths of a bip (10000 = 1%), `<= 100000`. On RWAGMI it is the hook's static fee; *(Clanker era)* it was the 1% LP fee on which Clanker took a 20% protocol fee on top |
| `SWAP_POOL_FEE` | `500` | WETH/USDC 0.05% pool `0xd0b53D9277642d899DF5C87A3966A349A798F224` (deploy helper) |

Presets baked by the script: standard 5 / 65 / 30 (agent / creator / platform), buyback 5 / 50 / 15 / 30 of the 90%
reward share, i.e. 0.045 / 0.585 / 0.27% and 0.045 / 0.45 / 0.135 / 0.27% of the swapped amount on RWAGMI (see the
v2 section; on Clanker the same bps were shares of the LP fee). Chain addresses are hard-coded in `chainConfig()` for
8453 (`addresses.ts` has the sources).

## 3. Deploy order

Run from `packages/contracts` with `BASE_RPC_URL` = the CDP mainnet Node URL (or a public RPC; the scripts only send
three transactions each). `PRIVATE_KEY` is the DEPLOYER key, exported for the command only.

```sh
cd packages/contracts
export BASE_RPC_URL=https://api.developer.coinbase.com/rpc/v1/base/<key>

# 3.1 guardian + burner implementation + launcher (wires setLauncher / setPlatformTreasury, hands ownership to PLATFORM_ADMIN)
PRIVATE_KEY=<deployer> PLATFORM_ADMIN=<admin> PLATFORM_RECIPIENT=<recipient> PLATFORM_TREASURY=<treasury> \
MIN_FUEL_USDC=0 DORMANCY_PERIOD=7776000 MIN_PLATFORM_BPS=1000 LP_FEE_BPS=10000 \
forge script script/Deploy.s.sol --rpc-url base --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY -vvv
# prints: AgentGuardian, BuybackBurner impl, BootrLauncher, pending owner

# 3.2 call policy (stateless, no wiring)
PRIVATE_KEY=<deployer> forge script script/DeployCallPolicy.s.sol --rpc-url base --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY -vvv

# 3.3 swap helper (WETH, USDC, SwapRouter02, Chainlink ETH/USD from chainConfig; logs the live ETH/USD it reads)
PRIVATE_KEY=<deployer> SWAP_POOL_FEE=500 forge script script/DeploySwapHelper.s.sol --rpc-url base --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY -vvv
```

Record from the broadcast logs (`broadcast/*/8453/run-latest.json`): the five addresses and the **block number of
the launcher deployment** (`LAUNCHER_START_BLOCK` / `BOOTR_START_BLOCK`).

### 3.4 `acceptOwnership` (PLATFORM_ADMIN)

```sh
cast send <guardian> "acceptOwnership()" --rpc-url base --private-key <admin>
cast send <launcher> "acceptOwnership()" --rpc-url base --private-key <admin>
cast call <guardian> "owner()(address)" --rpc-url base      # == admin
cast call <launcher> "owner()(address)" --rpc-url base      # == admin
cast call <guardian> "launcher()(address)" --rpc-url base   # == launcher
cast call <guardian> "platformTreasury()(address)" --rpc-url base
```

With a Safe as admin, submit the two `acceptOwnership()` calls from the Safe UI (Transaction Builder, the ABI is in
`out/AgentGuardian.sol/AgentGuardian.json`).

### 3.5 Defaults / minimum fuel

`BootrLauncher` has no separate `setMinFuelUsdc`: the minimum fuel is the `minFuelUsdc` field of each preset, set
by the constructor from `MIN_FUEL_USDC` (both presets). Only if the deploy used a different value, or to change a
preset later, call `setDefaults(bool buyback, LaunchDefaults d)` from the admin (both presets separately; the
struct must satisfy `agent + creator + burn + platform = 10000`, `platform >= minPlatformBps`, `burn == 0` for the
standard preset and `> 0` for buyback, `dormancyPeriod >= 30 days`):

```sh
cast send <launcher> "setDefaults(bool,(uint24,uint16,uint16,uint16,uint16,address,uint256,uint32))" false \
  "(10000,500,6500,0,3000,<recipient>,<minFuelUsdc>,7776000)" --rpc-url base --private-key <admin>
cast send <launcher> "setDefaults(bool,(uint24,uint16,uint16,uint16,uint16,address,uint256,uint32))" true \
  "(10000,500,5000,1500,3000,<recipient>,<minFuelUsdc>,7776000)" --rpc-url base --private-key <admin>
cast call <launcher> "standardDefaults()(uint24,uint16,uint16,uint16,uint16,address,uint256,uint32)" --rpc-url base
```

### 3.6 Sanity reads

```sh
cast call <launcher> "rwagmiLauncher()(address)" --rpc-url base   # 0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20
cast call <launcher> "rwagmiLocker()(address)" --rpc-url base     # 0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20
cast call <launcher> "launchFeeWei()(uint256)" --rpc-url base     # 500000000000000 (0.0005 ETH)
cast call <swapHelper> "ethUsdPrice()(uint256)" --rpc-url base   # ~ ETH/USD * 1e8
cast call <callPolicy> "isModuleType(uint256)(bool)" 5 --rpc-url base   # true
```

## 4. Address book

Fill `packages/shared/src/addresses.ts` -> `[8453].bootr`:

```ts
bootr: {
  // Deployed <date> (block <LAUNCHER_START_BLOCK>), verified on Basescan / Sourcify.
  launcher: '0x...',
  guardian: '0x...',
  burnerImplementation: '0x...',
  callPolicy: '0x...',
  swapHelper: '0x...',
},
```

Then `pnpm --filter @bootr/shared typecheck`, commit, and redeploy every service (the supervisor reads
`bootr.callPolicy` / `bootr.swapHelper` from the address book when it builds session permissions; the web reads the
RWAGMI v3 stack from it).

## 5. Services: environment switch

Variables of the Coolify application (one environment for every service; before 2026-11-01 Railway shared
variables), from `.env.mainnet.example`:

| Variable | Mainnet value |
| --- | --- |
| `CHAIN_ID` | `8453` (supervisor, indexer); `NEXT_PUBLIC_CHAIN_ID=8453` on `web` (rebuild) |
| `BASE_RPC_URL` | CDP mainnet Node URL (supervisor, indexer, web, `INFERENCE_RPC_URL` on inference); leave `BASE_SEPOLIA_RPC_URL` unset |
| `NEXT_PUBLIC_RPC_URL` | `https://mainnet.base.org` or empty (never the keyed URL) |
| `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS` | from step 3; same values in `NEXT_PUBLIC_LAUNCHER_ADDRESS`, `NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS` |
| `LAUNCHER_START_BLOCK` (supervisor), `BOOTR_START_BLOCK` (indexer) | the launcher's deploy block |
| `RWAGMI_LAUNCHER_V3_ADDRESS`, `RWAGMI_LOCKER_V3_ADDRESS` (supervisor, indexer), `RWAGMI_HOOK_V3_ADDRESS`, `RWAGMI_DEV_BUY_V3_ADDRESS` (indexer) | the verified RWAGMI v3 stack, values in `.env.mainnet.example` (the web reads the locker from the shared address table, not from a variable) |
| `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY` | address of `SESSION_SIGNER_PRIVATE_KEY` |
| `X402_NETWORK` | `eip155:8453` |
| `X402_FACILITATOR_URL` | `https://api.cdp.coinbase.com/platform/v2/x402` + `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` |
| `INFERENCE_PAYTO_ADDRESS` | PLATFORM_TREASURY (inference + supervisor) |
| `BUNDLER_URL`, `PAYMASTER_URL` | CDP mainnet bundler URL; `PAYMASTER_URL` **empty** (self-funded gas); `GAS_MIN_WEI=200000000000000`, `GAS_TARGET_WEI=1000000000000000`; `ENABLE_MODE_SELF_BUNDLE=true`, `ENABLE_MODE_MAX_PREFUND_WEI=5000000000000000` |
| `SWAP_SLIPPAGE_BPS` | `100` (on-chain cap 300) |
| `SESSION_USDC_TRANSFER_CAP` | `50000000` (50 USDC / day per agent to its spender); review `SESSION_GAS_ALLOWANCE_WEI`, `SESSION_RATE_LIMIT_PER_HOUR`, `SESSION_KEY_VALIDITY_DAYS` |
| Indexer | new `DATABASE_SCHEMA` (or per-deployment), `INDEXER_MAX_RPS=25`, `INDEXER_SNAPSHOT_INTERVAL` default (30 blocks), `BOOT_TOKEN_ADDRESS` after step 6 |
| Web | `NEXT_PUBLIC_SITE_URL=https://bootr.fun`, `NEXT_PUBLIC_INDEXER_URL=https://indexer.bootr.fun`, `NEXT_PUBLIC_SENDER_PUBLIC_URL=https://api.bootr.fun`, `NEXT_PUBLIC_SWAP_LINK_BASE` empty (LlamaSwap on Base), `NEXT_PUBLIC_BOOT_X_URL=https://x.com/bootrfun`, `NEXT_PUBLIC_USE_MOCK=` (empty) |

Deploy: one Coolify deploy builds and starts everything (coolify.md section 2); the compose file orders the
containers (Postgres, then sender / inference / indexer, then web and the supervisor) and each service migrates
itself at start. Give the indexer a new `DATABASE_SCHEMA` when its code changed and wait for `/ready` (the backfill
is short right after the deploy block). Save the admin config once from the console (graduation threshold, allowed
models, `bootToken` after step 6).

## 6. $BOOTR launch (from PLATFORM_TREASURY)

> **Before this launch (decided 2026-11-02):** redeploy `BootrLauncher` with a ~$6k opening market cap
> (`STARTING_TICK = -243_400`, ~2.7 ETH FDV; the live launcher's `-230_400` opens at ~22k) using
> `script/DeployLauncher.s.sol`, and first teach the indexer a list of launchers (old + new, each with its start
> block) so coins of the old launcher, OWL included, stay indexed. Then update the launcher address everywhere
> (`packages/shared/src/addresses.ts`, `.env.mainnet.example`, READMEs, this file) and redeploy web, supervisor
> and indexer. The step-by-step procedure, the exact commands and the read-back list are in
> [Launcher switch (6k opening cap)](#launcher-switch-6k-opening-cap) at the end of this file; the repo side of the
> address change is `scripts/switch-launcher.sh <new launcher> <new start block>`.
>
> **Also before this launch (decided 2026-11-02):** agents pay for inference directly to BlockRun over x402 from
> their own spender wallets (`docs/research/blockrun-vs-openrouter.md`), behind a supervisor flag with the
> OpenRouter relay kept as fallback: add BlockRun's payTo to the payer allowlist, move per-thought accounting, the
> model allowlist and spend caps into the supervisor, trial on the $BOOTR agent first. Outreach to BlockRun goes by
> email (`hello@blockrun.ai`, their X DMs are closed) and does not block the integration.

The platform coin is a normal Bootr agent launched by the treasury wallet with the **buyback preset**:

1. Publish the agent card at `https://bootr.fun/agents/boot.json` (the ERC-8004 `agentURI`; name "Bootr",
   description, image, `https://x.com/bootrfun`).
2. Approve USDC and launch (`script/Launch.s.sol`; it approves the fuel itself):

```sh
cd packages/contracts
CREATOR_PRIVATE_KEY=<treasury> LAUNCHER=<launcher> \
AGENT_NAME="Bootr" AGENT_SYMBOL="BOOTR" AGENT_IMAGE="ipfs://<boot image>" \
AGENT_URI="https://bootr.fun/agents/boot.json" \
AGENT_CONTEXT='{"interface":"Bootr","platform":"bootr.fun"}' \
AGENT_METADATA='{"description":"Bootr: the launchpad where every coin funds an agent.","socialMediaUrls":[{"platform":"x","url":"https://x.com/bootrfun"}],"auditUrls":[]}' \
AGENT_MODEL="anthropic/claude-haiku-4.5" BUYBACK=true FUEL_USDC=20000000 DEV_BUY_WEI=<wei> \
SUPERVISOR_KEY=<session signer address> \
forge script script/Launch.s.sol --rpc-url base --broadcast -vvv
# prints token, kernel, burner, agentId
```

   `DEV_BUY_WEI` is the treasury's own first buy (sets the first price impression; 0.05-0.1 ETH is typical).
   Use a `SALT` if a vanity address was mined (the launcher derives the B20 salt from `keccak(creator, salt)`; the address is `B20Factory.getB20Address(0, rwagmiLauncher, salt)`).
3. Connect the `@bootrfun` X account to the agent from the launch form **before** launching if the agent should
   post (the draft id rebind in `apps/supervisor/README.md`), or leave it a silent treasury coin.
4. Record the token: `BOOT_TOKEN_ADDRESS` on the indexer, `bootToken` in the admin console, pin it on the site.
5. Verify: `cast call 0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20 "launchInfo(address)" <token>` (the RWAGMI locker)
   shows the buyback slots (kernel 450, treasury 4500, burner 1350, platform 2700 of 9000; RWAGMI's 10% is the
   appended slot), every admin = launcher; `guardian.agentInfo(kernel)`; the supervisor log shows
   `registerAgent` and, with `ADMIN_PRIVATE_KEY` set, the session install.

## 7. Smoke tests

- `https://bootr.fun/api/health`, `https://api.bootr.fun/health`, `https://indexer.bootr.fun/ready` (200).
- Indexer: `GET https://indexer.bootr.fun/market/<BOOT token>` returns the pool and price; `platformStats` non-zero.
- Supervisor logs: ticks every `SUPERVISOR_TICK_MS`, the $BOOTR agent moves `onboarding -> active` (or stays
  `onboarding` with a clear "no X account" reason), `POST /internal/agents/:id/session/check-spender` returns the
  spender with a matching dry signature.
- One **small test launch** from a normal wallet through the web (standard preset, 20 USDC fuel (not required by the
  contract: min fuel is 0), 0.001 ETH gas, no dev buy), then: the second wallet prompt is `EntryPoint.depositTo(kernel)`
  and `EntryPoint.balanceOf(kernel)` = 0.001 ETH (the token page shows `Gas 0.001 ETH · ok`);
  `RwagmiLpLockerV3.claimableQuote(kernel, WETH)` (after `pendingQuote` settles) after a trade, a `claim_fees` op in `sv_treasury_ops` with a
  `txHash` paid from the kernel's gas (`EntryPoint.balanceOf(kernel)` went down by `actualGasCost`), and, once the
  claimed WETH is on the kernel and its gas is under `GAS_MIN_WEI`, a `fund_gas` op (`WETH.withdraw`) that brings
  the kernel's ETH back up; `GET /internal/agents/:id` shows `gas.status: ok`.
- A single swap through the helper with the session key (`FUEL_TARGET_USDC` below the kernel's USDC triggers it
  once WETH is claimed): `Swapped` event, output >= Chainlink - 1%.
- Pause / unpause the test agent from the creator wallet; the supervisor marks the runtime `paused` by `guardian`.

## 8. Rollback

- The contracts are immutable and un-upgradeable. Stop intake with `launcher.pause()` (admin); existing agents keep
  running (fees accrue in the RWAGMI locker, or the Clanker locker for coins launched before 2026-10-29, regardless of Bootr). A broken launcher is replaced by a new deploy
  (`Deploy.s.sol` again, new guardian + launcher, new address book entry); old kernels stay bound to the old guardian
  and keep working with the old supervisor config.
- Session keys: `POST /internal/agents/panic-revoke` (fleet-wide nonce bump + uninstall), see the supervisor README.
- Services: redeploy a previous deployment from Coolify (coolify.md section 2). The mainnet indexer schema is kept for a later
  resume; Base Sepolia is no longer a launch target (RWAGMI v3 has no testnet), so there is no testnet to fall back to.
- Funds: the only platform-held balances are the admin's gas and the treasury; nothing is custodied for users.

## 9. Open security items (go / no-go before step 3)

Each one is a decision; the default is written so the cutover is not blocked, but the answer must be explicit.

1. **Admin key template restriction (C-03).** `AgentGuardian.approveSessionKey` accepts *any* `validatorData`, so
   the admin key can approve a permission with `SudoPolicy` and drain every kernel. Mitigation today: the admin key
   lives only on the supervisor. Go/no-go: deploy as is and restrict the admin key operationally (a Coolify
   variable on one server, no other holder), or hold the deploy until the guardian pins a policy template (module list + flags)
   on-chain? *Default: go as is, tracked for the next guardian release.*
2. **Multisig as PLATFORM_ADMIN.** `Ownable2Step` on guardian and launcher accepts a Safe. But the supervisor
   needs `ADMIN_PRIVATE_KEY` for `approveSessionKey` / self-bundled installs, which a Safe cannot sign per tick.
   Go/no-go: (a) EOA admin everywhere (simple, one hot key with full root authority), or (b) Safe owns the
   contracts and a *separate* hot EOA is added once the guardian supports a delegated "session approver" role (not
   implemented). *Default: (a) EOA admin, hardware-backed export, with the Safe migration scheduled; `transferOwnership`
   to the Safe can happen later without redeploying.*
3. **Per-agent session signers.** One `SESSION_SIGNER_PRIVATE_KEY` is installed on every kernel: a leak exposes
   `SESSION_USDC_TRANSFER_CAP` x agents per window (to spenders the attacker does not control) plus swap slippage.
   Go/no-go: accept the single signer with the panic-revoke runbook, or derive one signer per agent (like the
   spenders) before launch? *Default: single signer, cap 50 USDC/day, panic-revoke tested on Sepolia.*
4. **Dev-buy minimum (BOOTR-05).** *(Clanker era)* The launcher passed `pairedTokenAmountOutMinimum = 0`, the MEV
   block delay covered same-block sandwiching. Launcher v2 passes `minOut = 1` in the dev-buy extension data: the
   launch transaction creates the pool and buys in the same call, so nothing can sandwich it and the amount is
   bounded by `devBuyWei`. *Default: accept the pool-creation price for a creator's own first buy.*
5. **MEV module** *(Clanker era; not applicable to launcher v2)*. The v1 dry-run deployed through `ClankerMevBlockDelay`;
   RWAGMI v3 has no such module, the pool is one-sided and the dev buy is part of the launch transaction.
6. **Gas exposure.** Self-funded: the platform pays no agent gas. The creator deposits the first gas at launch,
   everything after comes out of the agent's own fee share, and a session key can at most burn its own kernel's
   gas (the GasPolicy allowance caps even that). The admin's only per-agent gas is the enable-op prefund of the
   session-key install. With a paymaster instead, sponsored ops are capped by the CDP policy, not by Bootr: set the
   daily USD cap before the first launch.

## Deployed (2026-10-27, Base mainnet, original Clanker-era set)

| Contract | Address |
| --- | --- |
| AgentGuardian | `0x799Ab875294E37839883D12084aB4BE3f7633630` |
| BootrLauncher v1 (Clanker v4; Agent 5 / Creator 65 / Platform 30; buyback 5/50/15/30; min fuel 20 USDC; block 53164454) | `0xD4747d91BE6121eBa7602D9114B51d6C184084EF` (paused 2026-10-28) |
| BuybackBurner implementation | `0x7539bF645960Fc47556ECd449370BCc3A7D96Ed7` |
| BootrCallPolicy | `0x8586BdE0339b85bb9c0f0612954CCdF7fDCF9cE8` |
| BootrSwapHelper | `0x5723152f21ed7E305312fd90a2Bb94864BA9D80d` |

Owner of guardian and launcher: ADMIN `0x2C97C20FAD740cCf60d4Eeb54260F3BFE899D9b3` (accepted). All five were verified
on Basescan. Guardian, burner implementation, call policy and swap helper are still the live ones; the launcher was
replaced twice, see below. $BOOTR is not launched yet (planned from PLATFORM_TREASURY, buyback preset, no dev buy,
fuel at launch time).

## Launcher redeploy (2026-10-28): flat launch fee

`BootrLauncher` gained an owner-settable flat ETH launch fee (`launchFeeWei`, `setLaunchFee`), charged on top of the
dev buy and forwarded to the preset's `platformRecipient`. Contracts are immutable, so the launcher was redeployed
once with `script/DeployLauncher.s.sol` (copies the live presets and `minPlatformBps` from the old launcher, hands
ownership to the admin, `guardian.setLauncher(new)`, pauses the old launcher). Guardian, burner implementation and
registered agents are untouched.

| | address / block |
| --- | --- |
| new `BootrLauncher` (v1.1, Clanker v4) | `0x386CBE5DD03C38a31e52d94105d5CA83A311e21d` (block 53172831, fee 0.0005 ETH; paused 2026-10-29) |
| old `BootrLauncher` (v1) | `0xD4747d91BE6121eBa7602D9114B51d6C184084EF` (paused; `guardian.registerAgent` rejects it) |

The fee is changed from the admin console ("Launch fee" panel, `setLaunchFee`) without a redeploy. After a launcher
redeploy update `BOOTR_LAUNCHER_ADDRESS` / `NEXT_PUBLIC_LAUNCHER_ADDRESS` and `LAUNCHER_START_BLOCK` /
`BOOTR_START_BLOCK` on web, supervisor and indexer and redeploy the three services.

## Launcher v2 on RWAGMI (2026-10-29)

Coins are launched through the RWAGMI v3 launcher (Base B20 Asset tokens in Uniswap v4 pools) instead of Clanker v4.
`BootrLauncher.launch(LaunchParams)` and the `AgentLaunched` event keep their signatures; internally the launcher
builds a `LaunchConfigV3` and calls `RwagmiB20LauncherV3.launchB20`. Contracts are immutable, so this is a new
`BootrLauncher` (plus a new `BuybackBurner` implementation and, where the call-policy changes, a new
`BootrCallPolicy`), not an upgrade. Guardian, swap helper and registered agents stay. Design and file ownership:
[`docs/rwagmi-migration.md`](../rwagmi-migration.md).

### RWAGMI v3 stack (Base mainnet, verified on Basescan)

| Contract | Address | Used by |
| --- | --- | --- |
| `RwagmiB20LauncherV3` | `0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20` | `BootrLauncher` (`launchB20`), indexer, supervisor |
| `RwagmiHookV3` | `0xB20B00367E37F826a0652c85a6DF375D784B20Ec` | indexer (`PoolFeeTakenV3`) |
| `RwagmiLpLockerV3` | `0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20` | supervisor (claims), indexer (ledger), web (`launchInfo`), `BuybackBurner` |
| `RwagmiEthDevBuyV3` | `0xb20A2dCBC4AA42474072381aEb52CbFc5C751B20` | `BootrLauncher` (optional creator dev buy) |

There is no v3 deployment on Base Sepolia: the dry-run and the contract tests run on a Base mainnet fork
(`base-anvil`, coolify.md section 8), and the end-to-end check is a small test coin on mainnet.

### Fee model

- Swappers pay a static **1.00%** fee, charged by `RwagmiHookV3` **in WETH** (the paired asset); the native LP fee is 0.
  The old model charged 1.20% (1% LP fee plus a 20% Clanker protocol fee on top), paid in either asset.
- Of every fee **90% goes to the coin's reward slots and 10% to RWAGMI** (an 11th slot appended by the launcher).
- Slots are 1-6 entries whose bps total 9000, `admin` = `BootrLauncher` for every slot. The launcher exposes no
  recipient or bps update, so the split is **locked for the coin's life**.

| Preset | Agent | Creator | Burn | Platform | RWAGMI | slot bps (of 9000) |
| --- | --- | --- | --- | --- | --- | --- |
| standard | 0.045% | 0.585% | - | 0.27% | 0.10% | 450 / 5850 / 2700 |
| buyback | 0.045% | 0.45% | 0.135% | 0.27% | 0.10% | 450 / 4500 / 1350 / 2700 |

(Percentages are shares of the swapped amount, i.e. of the 1% fee.) Fees settle per pool and are claimed per
currency by the recipient: the agent's kernel claims its own WETH through its session key (`settleAndClaim` /
`claimQuote`, `to` must be the kernel), the burner claims its own and swaps it into the coin before sending it to
`0x...dEaD`, the platform claims from the console. Every fee figure the services show is in WETH (and its USD value).

Coins launched before 2026-10-29 are on Clanker v4 and keep their own split (agent 5 / creator 65 / platform 30 of
the LP fee, burn variant 5 / 50 / 15 / 30, paid in WETH or the coin).

### Redeploy steps

1. **Fork rehearsal.** On a Base mainnet fork run the fork test-suite of the contracts package (`base-forge test`) and the
   `DeployLauncher` script against the fork: launch with both presets, assert `launchInfo` slots (recipients, bps,
   admin = launcher), swap, claim as kernel and burner, `burn()`, dormancy sweep. Do not broadcast before it is green.
2. **Deploy.** From `packages/contracts` with the deployer key exported for the command only, run the
   `DeployLauncher` script with the RWAGMI addresses above and the live guardian, burner and treasury addresses (its
   header documents the env). `BootrCallPolicy` stays: it is generic (the allow-list is the rule data installed with each
   session key), so the move to the RWAGMI locker needed no new policy contract, only new rule data (step 7). Record
   the new launcher address and the deployment block.
3. **Wire.** As the guardian owner: `guardian.setLauncher(<new launcher>)` and `acceptOwnership()` on the new launcher
   (admin = `PLATFORM_ADMIN`). Read back:

   ```sh
   cast call <guardian> "launcher()(address)" --rpc-url base            # == new launcher
   cast call <new launcher> "owner()(address)" --rpc-url base           # == admin
   cast call <new launcher> "paused()(bool)" --rpc-url base             # false
   ```

   After `setLauncher`, `guardian.registerAgent` rejects the old launcher, so old-launcher launches can no longer
   complete; step 4 makes that explicit.
4. **Pause the old launcher.** `cast send <old launcher> "pause()" --rpc-url base --private-key <admin>`. Existing
   agents keep running; fees keep accruing in their own lockers.
5. **Paymaster** *(only if one is configured; the default is self-funded gas)*. Allow-list the new launcher and the
   RWAGMI locker in the CDP policy (section 1 table). Keep the old entries until the last Clanker-era agent is retired.
6. **Variables.** Set the new launcher address and block: `BOOTR_LAUNCHER_ADDRESS`, `NEXT_PUBLIC_LAUNCHER_ADDRESS`,
   `LAUNCHER_START_BLOCK` (supervisor), `BOOTR_START_BLOCK` (indexer), plus `BOOTR_BURNER_IMPL_ADDRESS` if it
   changed. Add `RWAGMI_LAUNCHER_V3_ADDRESS`, `RWAGMI_LOCKER_V3_ADDRESS` (supervisor, indexer),
   `RWAGMI_HOOK_V3_ADDRESS` and `RWAGMI_DEV_BUY_V3_ADDRESS` (indexer); the values are in `.env.mainnet.example`.
   The web app takes the RWAGMI stack from `packages/shared/src/addresses.ts`: update `[8453].bootr` (and, if RWAGMI
   rotated a module, `[8453].rwagmi*`) and commit it.
7. **Redeploy** (coolify.md section 2; on Railway at the time: indexer, web, supervisor in that order): the `indexer`
   on a **new schema** (it indexes the RWAGMI events; wait for `/ready`), `web` rebuilt, then the `supervisor`. Session keys installed before this release carry
   the Clanker-era rule layout (`rulesVersion` unset, a `ClankerFeeLocker.claim` rule); the supervisor installs the
   RWAGMI claim rules (`settleAndClaim` / `claimQuote` with `to == kernel`, `rulesVersion: 2`) when it rotates a key.
   `SESSION_ROTATE_BEFORE_DAYS` only rotates keys close to expiry, so trigger the rotation explicitly
   (`POST /internal/agents/:id/session/rotate`) for agents that should claim at once, and check `sv_treasury_ops`.
8. **Verify on Sourcify.** Verify every new contract (`forge verify-contract --verifier sourcify`, or `--verify
   --verifier sourcify` on the script), then open each address on Sourcify / Basescan and confirm an exact match.
   Check `launcher.rwagmiLauncher()` equals `0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20`.
9. **Smoke.** One small test coin per preset from a normal wallet: the web shows 1.00% with the 90/10 split, the
   locker `launchInfo(token)` matches, the indexer lists the token, a swap produces `PoolFeeTakenV3` and
   `PoolFeesSettledV3` rows, the kernel's `claimQuote` op appears in `sv_treasury_ops` with a `txHash`, and
   `burn()` sends the coin to `0x...dEaD`.

Rollback: `guardian.setLauncher(<previous launcher>)` and `unpause()` the previous launcher (it is paused, not
destroyed), then revert the variables. Coins already launched on v2 keep working either way.

### Launcher history

| Launcher | Backend | Address | Block | Status |
| --- | --- | --- | --- | --- |
| v1 | Clanker v4 | `0xD4747d91BE6121eBa7602D9114B51d6C184084EF` | 53164454 | paused 2026-10-28 |
| v1.1 (flat launch fee) | Clanker v4 | `0x386CBE5DD03C38a31e52d94105d5CA83A311e21d` | 53172831 | paused 2026-10-29 |
| v2 | RWAGMI v3 (B20) | `0xD3CE024ddC37465510E6c9a1D7942f003338B1F3` | 53219209 | paused 2026-11-03 |
| v3 (6k opening cap, `STARTING_TICK = -243400`) | RWAGMI v3 (B20) | `0x01f290cC464Ac6D167588b35A08305F58683526f` | 53433988 | current, verify on Sourcify |

The Clanker-era sections above (0-9) record how v1 and v1.1 were deployed; they are kept as written for reference.

### Deployed (2026-10-29)

Deployed with `script/DeployLauncher.s.sol` (presets and `minPlatformBps` copied from the previous launcher, launch fee
0.0005 ETH, ownership to the admin, `guardian.setLauncher(new)`, previous launcher paused). Guardian, burner
implementation, call policy, swap helper and registered agents are untouched. Read back from Base mainnet on
2026-10-29: `guardian.launcher()` = the v2 launcher, `owner()` = the admin `0x2C97C20F…D9b3`, not paused,
`launchFeeWei() = 500000000000000`, `minFuelUsdc = 0` and `dormancyPeriod = 7776000` (90 days) in both presets,
standard preset `10000 / 500 / 6500 / 0 / 3000`, buyback `10000 / 500 / 5000 / 1500 / 3000`, `minPlatformBps = 1000`,
both previous launchers `paused() = true`.

Coins launched before block 53219209 live on Clanker v4 with their own locked split; the indexer and supervisor only
follow RWAGMI launches from `BOOTR_START_BLOCK` / `LAUNCHER_START_BLOCK` = 53219209 onwards.

### Launcher switch (6k opening cap)

Decided 2026-11-02 (section 6): the next `BootrLauncher` opens every pool at `STARTING_TICK = -243_400` (~2.7 ETH
FDV, ~$6k) instead of the live `-230_400` (~22k). The constant is immutable, so this is the same move as the two
earlier redeploys: a new `BootrLauncher` from `script/DeployLauncher.s.sol`, which copies both presets and
`minPlatformBps` from `OLD_LAUNCHER`, hands ownership to the admin, `guardian.setLauncher(new)` and pauses the old
launcher. Guardian, burner implementation, call policy, swap helper and every registered agent stay where they are;
coins of the old launcher keep trading and claiming. The user signs every transaction; nothing here is automated.

**Preconditions**

- [ ] **Indexer multi-launcher support is live first.** The indexer reads `BOOTR_LAUNCHERS=<addr>@<startBlock>,...`
      (fallback: `BOOTR_LAUNCHER_ADDRESS` + `BOOTR_START_BLOCK`) so the coins of the old launcher, OWL
      (`0xb2000000000000000000004481c175669cbc8edb`) included, stay indexed once `BOOTR_LAUNCHER_ADDRESS` moves. Deploy
      that indexer release (new `DATABASE_SCHEMA`, wait for `/ready`) and check `GET https://indexer.bootr.fun/market/<OWL>`
      answers *before* touching the chain.
- [ ] **Contracts.** `STARTING_TICK = -243_400` committed in `src/BootrLauncher.sol` with `test/unit/StartingTick.t.sol`
      green; the fork suites green on the day (`base-forge test`, section 0); `forge build` clean. Rehearse the script
      without `--broadcast` first (it simulates every call, including the ownership and guardian checks).
- [ ] **Gas.** The deployer (`PRIVATE_KEY`) holds ~0.02 ETH on Base (the `via_ir` launcher is one large `CREATE`; the
      2026-10-29 deploy cost a fraction of that, 0.02 is the margin). The admin (`ADMIN_PRIVATE_KEY`, owner of the
      guardian and the old launcher: `0x2C97C20FAD740cCf60d4Eeb54260F3BFE899D9b3`) holds at least 0.002 ETH for
      `acceptOwnership`, `setLauncher` and `pause`. Both keys are exported for the command only.
- [ ] **Launches paused during the switch.** In the admin console press **Pause launches** (on-chain `pause()` on the
      live launcher) and switch on **Pause launches in the app**. Nothing then lands between `setLauncher` and the
      service redeploy; the script's `if (!old.paused()) old.pause()` becomes a no-op.
- [ ] `BASE_RPC_URL` set to the CDP Node URL or a public Base RPC (the script sends five transactions).

**1. Deploy** (from `packages/contracts`; `LAUNCH_FEE_WEI` defaults to 0, so pass the live fee explicitly):

```sh
cd packages/contracts
cast call 0xD3CE024ddC37465510E6c9a1D7942f003338B1F3 "launchFeeWei()(uint256)" --rpc-url base   # 500000000000000 today

PRIVATE_KEY=<deployer key> ADMIN_PRIVATE_KEY=<admin key> \
OLD_LAUNCHER=0xD3CE024ddC37465510E6c9a1D7942f003338B1F3 LAUNCH_FEE_WEI=500000000000000 \
forge script script/DeployLauncher.s.sol --rpc-url base -vvv                                     # dry run (simulation)

PRIVATE_KEY=<deployer key> ADMIN_PRIVATE_KEY=<admin key> \
OLD_LAUNCHER=0xD3CE024ddC37465510E6c9a1D7942f003338B1F3 LAUNCH_FEE_WEI=500000000000000 \
forge script script/DeployLauncher.s.sol --rpc-url base --broadcast --verify --verifier sourcify -vvv
```

`--verify --verifier sourcify` needs no key (this is how v2 was verified). For a Basescan verification instead,
export `BASESCAN_API_KEY` (read by `[etherscan]` in `foundry.toml`) and drop `--verifier sourcify`, or run
`forge verify-contract` afterwards. The script only deploys and calls (no B20 launch), so stock `forge` is enough;
the 2026-10-29 redeploy used the same script. The script prints `BootrLauncher (new): 0x...`,
`BootrLauncher (old, paused): ...` and `launchFeeWei`; its `deploy block:` line is the *simulation* block, not the
block the contract was mined in.

**2. Read the new address and the creation block.** From the broadcast artifact (the first transaction is the
`CREATE`):

```sh
jq -r '.transactions[0] | .contractName, .contractAddress' broadcast/DeployLauncher.s.sol/8453/run-latest.json
cast to-check-sum-address <address from above>                                                    # the repo stores checksummed addresses
cast to-dec "$(jq -r '.receipts[0].blockNumber' broadcast/DeployLauncher.s.sol/8453/run-latest.json)"   # creation block
```

Or on Basescan: open the new address, "Contract Creator ... at txn", the transaction's block. The old block of
53219209 came out of the same two fields (`0x32c0f89`).

**3. Repo.** From the checkout:

```sh
scripts/switch-launcher.sh <new launcher, checksummed> <creation block>
```

It validates both arguments, then rewrites every file that names the *current* launcher: `packages/shared/src/addresses.ts`
(`[8453].bootr.launcher` only; the Base Sepolia guardian shares the old address and is left alone),
`.env.mainnet.example` (`BOOTR_LAUNCHER_ADDRESS`, `NEXT_PUBLIC_LAUNCHER_ADDRESS`, `LAUNCHER_START_BLOCK`,
`BOOTR_START_BLOCK`, and `BOOTR_LAUNCHERS` when the line exists), `README.md`, `packages/contracts/README.md`,
`packages/contracts/src/README.md`, `apps/indexer/README.md`, `apps/supervisor/README.md`, `docs/rwagmi-migration.md`,
and in this file the status note at the top and the launcher history table (the v2 row becomes `paused <date>`, the
v3 row gets the address and block). Lines that mention a paused / old / previous launcher, history rows and any
`BOOTR_LAUNCHERS=` list keep the old address on purpose. It then prints `git diff --stat`, every remaining mention of
the old address and block for review, and the production calls of step 4; it commits nothing, deploys nothing and
never touches a secret. Then fill in the **Deployed** paragraph below, `pnpm --filter @bootr/shared typecheck`,
`git diff`, commit and push to `main` (Coolify builds from `main`).

**4. Production variables** (Coolify application `ko7sx54pwakworrqogccvbfc`; the script prints these with the real
values; on the server, as root, the token stays in `/root/.coolify-token`):

```sh
# one PATCH per variable; a variable that does not exist yet (BOOTR_LAUNCHERS the first time) is a POST on the same path
curl -s -X PATCH -H "Authorization: Bearer $(cat /root/.coolify-token)" -H "Content-Type: application/json" \
  http://127.0.0.1:8000/api/v1/applications/ko7sx54pwakworrqogccvbfc/envs \
  -d '{"key":"BOOTR_LAUNCHER_ADDRESS","value":"<new launcher>","is_preview":false,"is_build_time":false}'
#   ... NEXT_PUBLIC_LAUNCHER_ADDRESS = <new launcher>  ("is_build_time":true, it is a web build arg)
#   ... LAUNCHER_START_BLOCK         = <creation block>
#   ... BOOTR_LAUNCHERS              = 0xD3CE024ddC37465510E6c9a1D7942f003338B1F3@53219209,<new launcher>@<creation block>
# BOOTR_START_BLOCK is ignored once BOOTR_LAUNCHERS is set (the indexer starts at the earliest listed block): leave it. Read back:
curl -s -H "Authorization: Bearer $(cat /root/.coolify-token)" \
  http://127.0.0.1:8000/api/v1/applications/ko7sx54pwakworrqogccvbfc/envs | jq -r '.[] | select(.key | test("LAUNCHER|START_BLOCK")) | "\(.key)=\(.value)"'
```

The same four values can be set in the panel (application → Environment Variables); `NEXT_PUBLIC_LAUNCHER_ADDRESS`
must be marked build-time there.

**5. Deploy.** `curl -s -X POST -H "Authorization: Bearer $(cat /root/.coolify-token)" -H "Content-Type: application/json"
http://127.0.0.1:8000/api/v1/deploy -d '{"uuid":"ko7sx54pwakworrqogccvbfc","force":false}'`, then poll
`GET /api/v1/deployments/<deployment uuid>` (coolify.md section 2). One deploy rebuilds `web` with the new build arg and
restarts the indexer and the supervisor. The indexer's Ponder config now carries one more address: if it refuses to
start on the current schema (build id changed), bump `DATABASE_SCHEMA` and expect the backfill from 53219209 (about
70 minutes, coolify.md section 3). Wait for `https://indexer.bootr.fun/ready` and `https://bootr.fun/api/health`,
then switch **Pause launches in the app** off in the console (the new launcher is not paused on-chain).

**6. Verify** (`RPC` = a Base RPC, `NEW` = the new launcher, `OLD` = `0xD3CE024ddC37465510E6c9a1D7942f003338B1F3`,
`G` = the guardian `0x799Ab875294E37839883D12084aB4BE3f7633630`):

```sh
cast call $NEW "owner()(address)" --rpc-url $RPC            # 0x2C97C20FAD740cCf60d4Eeb54260F3BFE899D9b3 (admin; ownership accepted)
cast call $G "launcher()(address)" --rpc-url $RPC           # == NEW
cast call $OLD "paused()(bool)" --rpc-url $RPC              # true
cast call $NEW "paused()(bool)" --rpc-url $RPC              # false
cast call $NEW "STARTING_TICK()(int24)" --rpc-url $RPC      # -243400
cast call $NEW "launchFeeWei()(uint256)" --rpc-url $RPC     # 500000000000000, same as OLD
cast call $NEW "minPlatformBps()(uint16)" --rpc-url $RPC    # 1000, same as OLD
cast call $NEW "guardian()(address)" --rpc-url $RPC         # == G
cast call $NEW "burnerImplementation()(address)" --rpc-url $RPC   # 0x7539bF645960Fc47556ECd449370BCc3A7D96Ed7, same as OLD
cast call $NEW "rwagmiLauncher()(address)" --rpc-url $RPC   # 0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20
SIG="(uint24,uint16,uint16,uint16,uint16,address,uint256,uint32)"
diff <(cast call $OLD "standardDefaults()$SIG" --rpc-url $RPC) <(cast call $NEW "standardDefaults()$SIG" --rpc-url $RPC) && echo standard same
diff <(cast call $OLD "buybackDefaults()$SIG"  --rpc-url $RPC) <(cast call $NEW "buybackDefaults()$SIG"  --rpc-url $RPC) && echo buyback same
```

- Sourcify / Basescan show an exact match for `NEW`.
- Web: the admin console's launch-fee panel reads `0.0005` from the new address and shows "Launches open"; on the
  launch page the wallet prompt of the test launch below is addressed to `NEW` (check `to` before signing).
- Indexer: `GET https://indexer.bootr.fun/market/<OWL>` still answers (old launcher's coin, through `BOOTR_LAUNCHERS`);
  `platformStats` unchanged.
- Supervisor: no `registerAgent` errors in the log after the restart; the OWL agent keeps its state.
- **One small test launch** from a normal wallet (standard preset, 0 dev buy, 0.001 ETH gas): the coin appears in the
  indexer (`GET /market/<test token>`) and on the site, `RwagmiLpLockerV3.launchInfo(token)` shows the standard slots
  with every admin = `NEW`, the supervisor onboards it (`registerAgent`, session install) and the pool's opening price
  on the token page is in the ~$6k FDV range, not ~22k.
- Section 7 smoke tests for anything that touched the launcher (fees claim through the new coin's locker entry).

**Rollback.** As the admin: `cast send $G "setLauncher(address)" $OLD --rpc-url $RPC --private-key <admin>` and
`cast send $OLD "unpause()" --rpc-url $RPC --private-key <admin>` (the old launcher is paused, not destroyed; the new
one can stay deployed, or be paused with `pause()`). Then `git revert` the switch commit (running
`scripts/switch-launcher.sh` with the values swapped is not supported: it insists on a later block), PATCH the four
Coolify variables back (`BOOTR_LAUNCHER_ADDRESS` / `NEXT_PUBLIC_LAUNCHER_ADDRESS` = `OLD`,
`LAUNCHER_START_BLOCK` = 53219209, `BOOTR_LAUNCHERS` without the new entry, or with it: a launcher with no coins is
harmless to index) and deploy again. Coins launched on the new launcher in between keep working either way (their
locker entries are theirs); the supervisor only follows them while the new launcher is in `BOOTR_LAUNCHER_ADDRESS`.

**Deployed** 2026-11-03: new `BootrLauncher` `0x01f290cC464Ac6D167588b35A08305F58683526f` at block 53433988 (tx
`0xe0e0c1a6…f4acc`, five transactions, 0.0000169 ETH in total), verified on Sourcify and Basescan; read back the same
day: `guardian.launcher()` = new, `owner()` = admin (no pending owner), `STARTING_TICK() = -243400`,
`launchFeeWei() = 500000000000000`, `standardDefaults` and `buybackDefaults` byte-identical to v2, v2 `paused() = true`,
new `paused() = false`; first test coin: none yet; `BOOTR_LAUNCHERS` on production =
`0xD3CE024ddC37465510E6c9a1D7942f003338B1F3@53219209,0x01f290cC464Ac6D167588b35A08305F58683526f@53433988`, `DATABASE_SCHEMA`
bumped `bootr_v1` → `bootr_v2`.

## Clanker path

Written 2026-11-04 from [`docs/design/clanker-launch.md`](../design/clanker-launch.md) (task A); **not deployed
yet**. A creator picks "Launch through Bootr" (RWAGMI v3, the live launcher) or "Launch through Clanker"
(clanker.world's v4 factory) and gets the same agent either way. Three contracts, one admin switch:

| Contract | Role |
| --- | --- |
| `BootrLaunchGate` | becomes `guardian.launcher`; an owner-controlled allowlist of launchers that forwards `registerAgent`. Owner = `PLATFORM_ADMIN`. |
| `BootrLauncher` v3.1 | the live v3 with one change: it registers through the gate (`Deps.gate`). Same presets, `minPlatformBps`, launch fee, burner implementation; `STARTING_TICK = -243400` (~$6k) stays. |
| `BootrClankerLauncher` | same `LaunchParams` / `LaunchDefaults` / `AgentLaunched` / `LaunchContext` / `LaunchFeePaid` ABI plus `ClankerLaunched(token, poolId, hook, locker, mevModule, startingTick, lpFeeBps)`. Clanker `Standard` layout (tick `-230400`, one position to `-120000`, ~10 ETH opening cap), preset bps unscaled (Clanker's 20% protocol fee is charged **on top** of the LP fee), `Paired` WETH slots, burn slot `0xdEaD` in the coin, `tokenAdmin` / `rewardAdmins` = the launcher with no update path. Owner knobs: `setLaunchFee`, `setPlatformLpFeeBps` (the treasury's own coins, see below), `setMevModule`, `pause`. |

Until `guardian.setLauncher(gate)` is sent, both new launchers revert `NotLauncher` at the registration step, so they
can be deployed, verified and read back with no launch possible through them. The v3 launcher keeps registering
directly until then; after the switch it is paused and its coins keep trading and claiming (their locker entries
are theirs). The indexer and the supervisor follow launchers by address: the Clanker launcher needs the indexer
sources of design section 4 (tasks C / B) before its coins are visible on the site; the contracts do not wait for
that, the web's "Launch through Clanker" choice does.

**Deploy order**

1. `BootrLaunchGate(owner = deployer, guardian)`.
2. `BootrLauncher` v3.1 (RWAGMI deps + `gate`; presets, `minPlatformBps`, `burnerImplementation`, launch fee copied
   from `OLD_LAUNCHER`).
3. `BootrClankerLauncher` (Clanker deps + `gate`; same presets and launch fee; `MEV_MODULE` + its init data;
   `PLATFORM_LP_FEE_BPS`).
4. `gate.addLauncher(v3.1)`, `gate.addLauncher(clanker)`; ownership of all three transferred to `PLATFORM_ADMIN`
   (`acceptOwnership` on each: gate, v3.1 launcher, Clanker launcher).
5. **Admin:** `guardian.setLauncher(gate)` (from the guardian owner `0x2C97C20FAD740cCf60d4Eeb54260F3BFE899D9b3`).
6. **Admin:** `pause()` on v3 `0x01f290cC464Ac6D167588b35A08305F58683526f`.

Steps 1-4 are `script/DeployClankerLauncher.s.sol`; it sends 5 and 6 only when the broadcaster *is* the guardian
owner (a fork rehearsal), otherwise it prints the two `cast send` lines. Env of the script: `PRIVATE_KEY` (deployer),
`PLATFORM_ADMIN` (final owner; default deployer), `OLD_LAUNCHER` (`0x01f290cC…526f`), `LAUNCH_FEE_WEI` (default: the
old launcher's, 500000000000000 today), `MEV_MODULE` (default `ClankerSniperAuctionV2`
`0xebB25BB797D82CB78E1bc70406b13233c0854413`; `ClankerMevBlockDelay` `0xE143f9872A33c955F23cF442BB4B1EFB3A7402A2` is
the fallback and takes empty init data), `MEV_STARTING_FEE` / `MEV_ENDING_FEE` / `MEV_SECONDS_TO_DECAY` (clanker-sdk
defaults 666777 / 41673 / 15), `PLATFORM_LP_FEE_BPS` (default 0), `ERC8004_IDENTITY` (optional, as in `Deploy.s.sol`).

**Preconditions**

- [ ] `forge build` clean, unit tests green, `base-forge test --match-path 'test/fork/ClankerFork.t.sol' -vv` green
      **the same day** (section 0; Clanker's admin can change the allowlists without notice). `test_clankerAllowlistsOnFork`
      is the day-of read: factory `deprecated() == false`, `enabledLockers(0xffA37784…, 0xb429d62f…) == true`, the
      static V2 hook, the dev-buy extension and the chosen MEV module enabled (the private mappings are read from the
      factory's storage slots 5 / 7 / 8, checked against the public `enabledLockers` slot 6), fee locker
      `allowedDepositors(locker) == true`, hook `PROTOCOL_FEE_NUMERATOR() == 200000`. The 2026-11-04 read at block
      53501740: all true, both MEV modules enabled. If the sniper auction is disabled, pass `MEV_MODULE=<block delay>`
      (and later `setMevModule(0xE143…, 0x)` on a deployed launcher; `test_mevBlockDelayFallbackLaunchesIfEnabled`
      covers that path).
- [ ] Rehearse the script without `--broadcast` first; the simulation runs every call including the ownership
      transfers.
- [ ] Gas: deployer ~0.03 ETH (three `CREATE`s, two of them `via_ir` launchers of ~12.1 and ~12.5 kB runtime plus the
      gate; the v3 redeploy cost 0.0000169 ETH for five transactions, 0.03 is the margin); admin ~0.003 ETH for three
      `acceptOwnership`, `setLauncher`, `pause` (and `setPlatformLpFeeBps` if set later).
- [ ] **Launches paused during the switch** (console **Pause launches** + **Pause launches in the app**), as in the
      launcher switch above; unpause the app side once the services point at the new addresses.
- [ ] Indexer multi-launcher support already live (`BOOTR_LAUNCHERS`); the Clanker sources (task C) deployed or at
      least scheduled, since Clanker coins are invisible on the site until then.

**1. Deploy** (from `packages/contracts`; stock `forge` is enough, the script launches nothing):

```sh
cd packages/contracts
cast call 0x01f290cC464Ac6D167588b35A08305F58683526f "launchFeeWei()(uint256)" --rpc-url base   # 500000000000000 today

PRIVATE_KEY=<deployer key> PLATFORM_ADMIN=0x2C97C20FAD740cCf60d4Eeb54260F3BFE899D9b3 \
OLD_LAUNCHER=0x01f290cC464Ac6D167588b35A08305F58683526f \
forge script script/DeployClankerLauncher.s.sol --rpc-url base -vvv                                      # dry run

PRIVATE_KEY=<deployer key> PLATFORM_ADMIN=0x2C97C20FAD740cCf60d4Eeb54260F3BFE899D9b3 \
OLD_LAUNCHER=0x01f290cC464Ac6D167588b35A08305F58683526f \
forge script script/DeployClankerLauncher.s.sol --rpc-url base --broadcast --verify --verifier sourcify -vvv
```

The script prints `BootrLaunchGate`, `BootrLauncher v3.1`, `BootrClankerLauncher`, `mevModule`, `launchFeeWei`,
`platformLpFeeBps` and the two admin lines. Creation blocks: `jq -r '.receipts[] | .contractAddress, .blockNumber'
broadcast/DeployClankerLauncher.s.sol/8453/run-latest.json` (three `CREATE`s in deploy order), `cast to-dec` on the
block numbers; the v3.1 launcher's block is the new `LAUNCHER_START_BLOCK`, the Clanker launcher's block is
`CLANKER_START_BLOCK`.

**2. Admin** (`G` = guardian `0x799Ab875294E37839883D12084aB4BE3f7633630`, `GATE`, `V31`, `CL` = the printed
addresses, `OLD` = `0x01f290cC464Ac6D167588b35A08305F58683526f`; the admin key exported for each command only):

```sh
cast send $GATE "acceptOwnership()" --rpc-url base --private-key <admin>
cast send $V31  "acceptOwnership()" --rpc-url base --private-key <admin>
cast send $CL   "acceptOwnership()" --rpc-url base --private-key <admin>
cast send $G    "setLauncher(address)" $GATE --rpc-url base --private-key <admin>     # the switch: both new launchers go live
cast send $OLD  "pause()" --rpc-url base --private-key <admin>
# before the $BOOTR launch (owner decision 2026-11-04): the platform's own coin carries a 2% LP fee, every other coin
# keeps the preset 1%. The launcher applies it when the creator is the preset's platformRecipient (= PLATFORM_TREASURY).
cast send $CL   "setPlatformLpFeeBps(uint24)" 20000 --rpc-url base --private-key <admin>
```

`setPlatformLpFeeBps` can also be passed as `PLATFORM_LP_FEE_BPS=20000` to the script. Set it to `0` again after
the $BOOTR launch if no other platform coin should carry 2%; the stored presets never change.

**3. Repo.** `packages/shared/src/addresses.ts` (`[8453].bootr.launcher` = `V31`, `launchGate`, `clankerLauncher`),
`.env.mainnet.example` (`BOOTR_LAUNCHER_ADDRESS` / `NEXT_PUBLIC_LAUNCHER_ADDRESS` = `V31`, `LAUNCHER_START_BLOCK`,
`BOOTR_LAUNCHERS` with the v3.1 entry appended, `BOOTR_LAUNCH_GATE_ADDRESS`, `BOOTR_CLANKER_LAUNCHER_ADDRESS`,
`NEXT_PUBLIC_CLANKER_LAUNCHER_ADDRESS`, `CLANKER_START_BLOCK`, `CLANKER_FACTORY_ADDRESS`, `CLANKER_LOCKER_ADDRESS`,
`CLANKER_FEE_LOCKER_ADDRESS`), the READMEs, the launcher history below. `scripts/switch-launcher.sh <V31> <block>`
handles the v3.1 part (it rewrites the current-launcher lines only); the gate and Clanker lines are new and are edited
by hand. `pnpm --filter @bootr/shared typecheck`, commit, push to `main`.

**4. Production variables** (Coolify, as in step 4 of the launcher switch): `BOOTR_LAUNCHER_ADDRESS` = `V31`,
`NEXT_PUBLIC_LAUNCHER_ADDRESS` = `V31` (build-time), `LAUNCHER_START_BLOCK` = v3.1 block, `BOOTR_LAUNCHERS` =
`…,0x01f290cC464Ac6D167588b35A08305F58683526f@53433988,<V31>@<block>`, and the new ones: `BOOTR_LAUNCH_GATE_ADDRESS`,
`BOOTR_CLANKER_LAUNCHER_ADDRESS`, `NEXT_PUBLIC_CLANKER_LAUNCHER_ADDRESS` (build-time), `CLANKER_START_BLOCK`,
`CLANKER_FACTORY_ADDRESS=0xE85A59c628F7d27878ACeB4bf3b35733630083a9`,
`CLANKER_LOCKER_ADDRESS=0xffA37784D619F228D8B379d287a4D7282e500762`,
`CLANKER_FEE_LOCKER_ADDRESS=0xF3622742b1E446D92e45E22923Ef11C2fcD55D68`. Then deploy (step 5 of the launcher switch:
new `DATABASE_SCHEMA`, backfill, `/ready`, `/api/health`), unpause the app side.

**5. Verify** (`RPC` = a Base RPC):

```sh
cast call $G    "launcher()(address)" --rpc-url $RPC                       # == GATE
cast call $GATE "guardian()(address)" --rpc-url $RPC                       # == G
cast call $GATE "owner()(address)" --rpc-url $RPC                          # admin
cast call $GATE "launchers(address)(bool)" $V31 --rpc-url $RPC             # true
cast call $GATE "launchers(address)(bool)" $CL --rpc-url $RPC              # true
cast call $GATE "launchers(address)(bool)" $OLD --rpc-url $RPC             # false
cast call $OLD  "paused()(bool)" --rpc-url $RPC                            # true
cast call $V31  "paused()(bool)" --rpc-url $RPC                            # false
cast call $V31  "gate()(address)" --rpc-url $RPC                           # == GATE
cast call $V31  "STARTING_TICK()(int24)" --rpc-url $RPC                    # -243400
cast call $V31  "launchFeeWei()(uint256)" --rpc-url $RPC                   # same as OLD
cast call $CL   "gate()(address)" --rpc-url $RPC                           # == GATE
cast call $CL   "guardian()(address)" --rpc-url $RPC                       # == G
cast call $CL   "STARTING_TICK()(int24)" --rpc-url $RPC                    # -230400
cast call $CL   "lpLocker()(address)" --rpc-url $RPC                       # 0xffA37784D619F228D8B379d287a4D7282e500762
cast call $CL   "staticHook()(address)" --rpc-url $RPC                     # 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC
cast call $CL   "mevModule()(address)" --rpc-url $RPC                      # 0xebB25BB797D82CB78E1bc70406b13233c0854413 (or the block delay)
cast call $CL   "launchFeeWei()(uint256)" --rpc-url $RPC                   # same as OLD
cast call $CL   "platformLpFeeBps()(uint24)" --rpc-url $RPC                # 20000 before $BOOTR, else 0
SIG="(uint24,uint16,uint16,uint16,uint16,address,uint256,uint32)"
for L in $V31 $CL; do
  diff <(cast call $OLD "standardDefaults()$SIG" --rpc-url $RPC) <(cast call $L "standardDefaults()$SIG" --rpc-url $RPC) && echo "$L standard same"
  diff <(cast call $OLD "buybackDefaults()$SIG"  --rpc-url $RPC) <(cast call $L "buybackDefaults()$SIG"  --rpc-url $RPC) && echo "$L buyback same"
done
```

- Sourcify / Basescan show exact matches for `GATE`, `V31` and `CL`.
- One small test launch through `V31` from a normal wallet (standard preset, 0 dev buy): the coin appears in the
  indexer and on the site, `RwagmiLpLockerV3.launchInfo(token)` shows admins = `V31`, the supervisor onboards it.
- One small test launch through `CL` (standard preset, 0 dev buy, from a normal wallet): `TokenCreated` on the factory
  with `msgSender == CL` and `tokenAdmin == CL`, `ClankerLaunched.lpFeeBps == 10000`,
  `ClankerLpLockerFeeConversion.tokenRewards(token)` with three slots, admins = `CL`, bps 500 / 6500 / 3000,
  `feePreferences(token, i) == 1` (Paired) for all three; `https://clanker.world/clanker/<token>` after
  `POST https://www.clanker.world/api/tokens/index-by-address` (web, task D). After the first swap and 2 minutes:
  `collectRewards(token)` then `availableFees(kernel, WETH) > 0`.
- A launch through `CL` from `PLATFORM_TREASURY` with `platformLpFeeBps = 20000`: `ClankerHookStaticFeeV2.clankerFee
  (poolId) == 20000`; the next launch from another wallet reads `10000`.

**Rollback.** As the admin: `cast send $G "setLauncher(address)" $OLD` and `cast send $OLD "unpause()"`: v3 registers
directly again, both new launchers revert `NotLauncher` (no need to pause them, `pause()` is available). Agents
registered through the gate in between stay registered; their coins keep trading and claiming. Repo and Coolify
variables back as in the launcher-switch rollback; `BOOTR_LAUNCHERS` may keep the v3.1 entry.

**Deployed:** not yet.
