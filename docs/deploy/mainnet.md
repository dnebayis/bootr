# Base mainnet cutover

Runbook for moving Bootr from Base Sepolia (84532) to Base mainnet (8453). It assumes the Railway layout
of [`railway.md`](./railway.md) (one `production` environment) and the contracts in `packages/contracts`.
Nothing here is automated: every step is a command you run and a check you read back.

Related: `packages/shared/src/addresses.ts` (the mainnet address book, every entry carries its source),
`packages/contracts/test/fork/MainnetDryRun.t.sol` (the fork dry-run of this exact cutover),
`.env.mainnet.example` (every variable with its mainnet value or a placeholder).

## 0. Dry-run first (no keys, no gas)

```sh
cd packages/contracts
MAINNET_FORK=1 BASE_RPC_URL=https://base-rpc.publicnode.com forge test --match-contract MainnetDryRun -vv
```

Six tests must pass. They deploy the stack with the scripts' own `chainConfig()`, launch through the live Clanker
v4 (0.01 ETH dev buy, 20 USDC fuel, both presets), check the reward slots / bps / admins in the mainnet LP locker,
the kernel's root validator, the ERC-8004 identity owner, install the production session permission through the
guardian's enable path on the live EntryPoint, fund a spender through a self-bundled `handleOps`, and swap WETH ->
USDC through the real SwapRouter02 pool with a 1% bound. Re-run it on the day of the deploy: Clanker rotates
modules without notice (the README's `ClankerLpLockerFeeConversion` 0x63D2... is already disabled on mainnet; the
live one is 0xffA3...).

## 1. Pre-flight checklist

### Coinbase Developer Platform (mainnet project)

- [ ] **Node** (RPC): a Base *mainnet* Node URL (`https://api.developer.coinbase.com/rpc/v1/base/<key>`). This is
      `BASE_RPC_URL` for supervisor, indexer and web (SIWE) and `INFERENCE_RPC_URL`. The indexer backfill needs
      historical logs from the launcher's deploy block onwards (no archive state), budget `INDEXER_MAX_RPS` ~25.
- [ ] **Bundler + Paymaster**: the same URL serves `BUNDLER_URL` and `PAYMASTER_URL`. Keep
      `ENABLE_MODE_SELF_BUNDLE=true` (CDP rejects enable-mode userOps; the admin EOA bundles them).
- [ ] **Paymaster policy allow-list** (contracts a sponsored userOp may call). Add exactly:

  | Contract | Address | Called by |
  | --- | --- | --- |
  | `BootrLauncher` | filled in step 3 | creators launching through a sponsored smart wallet (`launch`) |
  | `AgentGuardian` | filled in step 3 | creators (`pauseAgent`, `unpauseAgent`) |
  | `BootrSwapHelper` | filled in step 3 | session keys (`swapWethToUsdc`) |
  | `ClankerFeeLocker` | `0xF3622742b1E446D92e45E22923Ef11C2fcD55D68` | session keys (`claim(kernel, token)`) |
  | `ClankerLpLockerFeeConversion` (live) | `0xffA37784D619F228D8B379d287a4D7282e500762` | anyone (`collectRewards`), if the web triggers it |
  | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | session keys (`transfer(spender, amount)`), creators (`approve(launcher)`) |
  | WETH | `0x4200000000000000000000000000000000000006` | session keys (`approve(swapHelper, amount)`) |
  | Uniswap v3 `SwapRouter02` | `0x2626664c2603336E57B271c5C0b26F421741e481` | internal call of the swap helper (`exactInputSingle`); add it if the policy inspects inner calls |

  Not needed any more: the Universal Router (session keys no longer touch it; the burner's `swapAndBurn` is an
  owner transaction, not a userOp). Set a per-userOp and daily USD cap on the policy.
- [ ] **Gasless campaign** (Base gasless / CDP paymaster credits): apply with the mainnet project id and the
      allow-list above before launch day; until approved, the paymaster bills the CDP account.
- [ ] **x402 facilitator**: `X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402` with a *secret*
      API key (`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`) of the same project; `X402_NETWORK=eip155:8453`.
- [ ] If any CDP key is IP-restricted: static outbound IPs on `supervisor`, `inference`, `indexer`.

### Keys and wallets (fresh, never reused from Sepolia)

| Role | Env | Funding before step 3 |
| --- | --- | --- |
| DEPLOYER | `PRIVATE_KEY` (forge only, never on Railway) | **~0.02 ETH** (five deployments, ~8M gas, leaves headroom for a Base fee spike) |
| PLATFORM_ADMIN | `ADMIN_PRIVATE_KEY` (supervisor) | **~0.05 ETH + 20 USDC** (two `acceptOwnership`, `setDefaults`, `approveSessionKey` + a 0.005 ETH prefund per agent install / rotation, dormancy sweeps; the USDC is for an admin test launch) |
| PLATFORM_RECIPIENT | address only | none (receives the 30% LP share) |
| PLATFORM_TREASURY | address + key on the operator's machine | **gas (~0.01 ETH) + the $BOOT dev buy + 20 USDC fuel** (step 6; also receives dormant sweeps and inference revenue as `INFERENCE_PAYTO_ADDRESS`) |
| SESSION_SIGNER | `SESSION_SIGNER_PRIVATE_KEY` | **none** (kernels pay their own gas through the paymaster / EntryPoint deposit) |
| SPENDER_MASTER | `SPENDER_MASTER_KEY` | **none** (spenders are funded by their kernels; EIP-3009 needs no ETH) |

Also fresh: `SENDER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `SESSION_SECRET`,
`SENDER_ENCRYPTION_KEY`, `ADMIN_CONSOLE_SLUG`; `ADMIN_ADDRESSES` = the production admin wallets.

### X, DNS, misc

- [ ] X developer portal: production app with callback `https://api.bootr.fun/oauth/callback`, website
      `https://bootr.fun`; `X_CLIENT_ID` / `X_CLIENT_SECRET` of that app, `X_REDIRECT_URI` identical to the portal,
      `SENDER_OAUTH_RETURN_URL=https://bootr.fun/launch`.
- [ ] DNS: `bootr.fun` (apex, CNAME-flattening) -> `web`, `api.bootr.fun` -> `sender`, `indexer.bootr.fun` ->
      `indexer`, certificates issued (railway.md section 4). `INDEXER_CORS_ORIGIN=https://bootr.fun`,
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
| `PLATFORM_RECIPIENT` | platform fee address | 30% LP share recipient of every launch |
| `PLATFORM_TREASURY` | treasury address | dormant sweeps |
| `MIN_FUEL_USDC` | `20000000` | 20 USDC minimum fuel per launch |
| `DORMANCY_PERIOD` | `7776000` | 90 days |
| `MIN_PLATFORM_BPS` | `1000` | floor for `setDefaults` |
| `LP_FEE_BPS` | `10000` | 1% LP fee (hook keeps 20% of it as Clanker protocol fee) |
| `SWAP_POOL_FEE` | `500` | WETH/USDC 0.05% pool `0xd0b53D9277642d899DF5C87A3966A349A798F224` (deploy helper) |

Presets baked by the script: standard 5 / 65 / 30 (agent / creator / platform), buyback 5 / 50 / 15 / 30. Chain
addresses are hard-coded in `chainConfig()` for 8453 and were verified on 2026-10-27 (`addresses.ts` has the sources).

## 3. Deploy order

Run from `packages/contracts` with `BASE_RPC_URL` = the CDP mainnet Node URL (or a public RPC; the scripts only send
three transactions each). `PRIVATE_KEY` is the DEPLOYER key, exported for the command only.

```sh
cd packages/contracts
export BASE_RPC_URL=https://api.developer.coinbase.com/rpc/v1/base/<key>

# 3.1 guardian + burner implementation + launcher (wires setLauncher / setPlatformTreasury, hands ownership to PLATFORM_ADMIN)
PRIVATE_KEY=<deployer> PLATFORM_ADMIN=<admin> PLATFORM_RECIPIENT=<recipient> PLATFORM_TREASURY=<treasury> \
MIN_FUEL_USDC=20000000 DORMANCY_PERIOD=7776000 MIN_PLATFORM_BPS=1000 LP_FEE_BPS=10000 \
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
  "(10000,500,6500,0,3000,<recipient>,20000000,7776000)" --rpc-url base --private-key <admin>
cast send <launcher> "setDefaults(bool,(uint24,uint16,uint16,uint16,uint16,address,uint256,uint32))" true \
  "(10000,500,5000,1500,3000,<recipient>,20000000,7776000)" --rpc-url base --private-key <admin>
cast call <launcher> "standardDefaults()(uint24,uint16,uint16,uint16,uint16,address,uint256,uint32)" --rpc-url base
```

### 3.6 Sanity reads

```sh
cast call <launcher> "lpLocker()(address)" --rpc-url base   # 0xffA37784D619F228D8B379d287a4D7282e500762
cast call 0xE85A59c628F7d27878ACeB4bf3b35733630083a9 "enabledLockers(address,address)(bool)" \
  0xffA37784D619F228D8B379d287a4D7282e500762 0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC --rpc-url base   # true
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
Clanker addresses from it).

## 5. Services: environment switch

Shared variables (Railway `production` environment), from `.env.mainnet.example`:

| Variable | Mainnet value |
| --- | --- |
| `CHAIN_ID` | `8453` (supervisor, indexer); `NEXT_PUBLIC_CHAIN_ID=8453` on `web` (rebuild) |
| `BASE_RPC_URL` | CDP mainnet Node URL (supervisor, indexer, web, `INFERENCE_RPC_URL` on inference); leave `BASE_SEPOLIA_RPC_URL` unset |
| `NEXT_PUBLIC_RPC_URL` | `https://mainnet.base.org` or empty (never the keyed URL) |
| `BOOTR_LAUNCHER_ADDRESS`, `BOOTR_GUARDIAN_ADDRESS` | from step 3; same values in `NEXT_PUBLIC_LAUNCHER_ADDRESS`, `NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS` |
| `LAUNCHER_START_BLOCK` (supervisor), `BOOTR_START_BLOCK` (indexer) | the launcher's deploy block |
| `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY` | address of `SESSION_SIGNER_PRIVATE_KEY` |
| `X402_NETWORK` | `eip155:8453` |
| `X402_FACILITATOR_URL` | `https://api.cdp.coinbase.com/platform/v2/x402` + `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` |
| `INFERENCE_PAYTO_ADDRESS` | PLATFORM_TREASURY (inference + supervisor) |
| `BUNDLER_URL`, `PAYMASTER_URL` | CDP mainnet bundler/paymaster URL; `ENABLE_MODE_SELF_BUNDLE=true`, `ENABLE_MODE_MAX_PREFUND_WEI=5000000000000000` |
| `SWAP_SLIPPAGE_BPS` | `100` (the dry-run swaps at this bound) |
| `SESSION_USDC_TRANSFER_CAP` | `50000000` (50 USDC / day per agent to its spender); review `SESSION_GAS_ALLOWANCE_WEI`, `SESSION_RATE_LIMIT_PER_HOUR`, `SESSION_KEY_VALIDITY_DAYS` |
| Indexer | new `DATABASE_SCHEMA` (or per-deployment), `INDEXER_MAX_RPS=25`, `INDEXER_SNAPSHOT_INTERVAL` default (30 blocks), `BOOT_TOKEN_ADDRESS` after step 6 |
| Web | `NEXT_PUBLIC_SITE_URL=https://bootr.fun`, `NEXT_PUBLIC_INDEXER_URL=https://indexer.bootr.fun`, `NEXT_PUBLIC_SENDER_PUBLIC_URL=https://api.bootr.fun`, `NEXT_PUBLIC_SWAP_LINK_BASE=https://app.uniswap.org/swap?chain=base&outputCurrency=`, `NEXT_PUBLIC_BOOT_X_URL=https://x.com/bootrfun`, `NEXT_PUBLIC_USE_MOCK=` (empty) |

Deploy order (railway.md section 2): migrations -> `sender` -> `inference` -> `indexer` (new schema; wait for
`/ready`, the backfill is short right after the deploy block) -> `web` (rebuild for the new `NEXT_PUBLIC_*`) ->
`supervisor` last. Save the admin config once from the console (graduation threshold, allowed models, `bootToken`
after step 6).

## 6. $BOOT launch (from PLATFORM_TREASURY)

The platform coin is a normal Bootr agent launched by the treasury wallet with the **buyback preset**:

1. Publish the agent card at `https://bootr.fun/agents/boot.json` (the ERC-8004 `agentURI`; name "Bootr",
   description, image, `https://x.com/bootrfun`).
2. Approve USDC and launch (`script/Launch.s.sol`; it approves the fuel itself):

```sh
cd packages/contracts
CREATOR_PRIVATE_KEY=<treasury> LAUNCHER=<launcher> \
AGENT_NAME="Bootr" AGENT_SYMBOL="BOOT" AGENT_IMAGE="ipfs://<boot image>" \
AGENT_URI="https://bootr.fun/agents/boot.json" \
AGENT_CONTEXT='{"interface":"Bootr","platform":"bootr.fun"}' \
AGENT_METADATA='{"description":"Bootr: the launchpad where every coin funds an agent.","socialMediaUrls":[{"platform":"x","url":"https://x.com/bootrfun"}],"auditUrls":[]}' \
AGENT_MODEL="claude-sonnet-4-5" BUYBACK=true FUEL_USDC=20000000 DEV_BUY_WEI=<wei> \
SUPERVISOR_KEY=<session signer address> \
forge script script/Launch.s.sol --rpc-url base --broadcast -vvv
# prints token, kernel, burner, agentId
```

   `DEV_BUY_WEI` is the treasury's own first buy (sets the first price impression; 0.05-0.1 ETH is typical).
   Use a `SALT` if a vanity address was mined (Clanker derives it from `(launcher, keccak(creator, salt))`).
3. Connect the `@bootrfun` X account to the agent from the launch form **before** launching if the agent should
   post (the draft id rebind in `apps/supervisor/README.md`), or leave it a silent treasury coin.
4. Record the token: `BOOT_TOKEN_ADDRESS` on the indexer, `bootToken` in the admin console, pin it on the site.
5. Verify: `cast call 0xffA3...0762 "tokenRewards(address)" <token>` shows 4 slots (kernel 500, treasury 5000,
   burner 1500, platform 3000), every admin = launcher; `guardian.agentInfo(kernel)`; the supervisor log shows
   `registerAgent` and, with `ADMIN_PRIVATE_KEY` set, the session install.

## 7. Smoke tests

- `https://bootr.fun/api/health`, `https://api.bootr.fun/health`, `https://indexer.bootr.fun/ready` (200).
- Indexer: `GET https://indexer.bootr.fun/market/<BOOT token>` returns the pool and price; `platformStats` non-zero.
- Supervisor logs: ticks every `SUPERVISOR_TICK_MS`, the $BOOT agent moves `onboarding -> active` (or stays
  `onboarding` with a clear "no X account" reason), `POST /internal/agents/:id/session/check-spender` returns the
  spender with a matching dry signature.
- One **small test launch** from a normal wallet through the web (standard preset, 20 USDC, no dev buy), then:
  `FeeLocker.availableFees(kernel, WETH)` after a trade, a sponsored `claim_fees` op in `sv_treasury_ops` with a
  `txHash`, and the paymaster dashboard showing the sponsorship.
- A single swap through the helper with the session key (`FUEL_TARGET_USDC` below the kernel's USDC triggers it
  once WETH is claimed): `Swapped` event, output >= Chainlink - 1%.
- Pause / unpause the test agent from the creator wallet; the supervisor marks the runtime `paused` by `guardian`.

## 8. Rollback

- The contracts are immutable and un-upgradeable. Stop intake with `launcher.pause()` (admin); existing agents keep
  running (fees accrue in the Clanker locker regardless of Bootr). A broken launcher is replaced by a new deploy
  (`Deploy.s.sol` again, new guardian + launcher, new address book entry); old kernels stay bound to the old guardian
  and keep working with the old supervisor config.
- Session keys: `POST /internal/agents/panic-revoke` (fleet-wide nonce bump + uninstall), see the supervisor README.
- Services: Railway rollback per service (railway.md section 10). Switching the environment back to Sepolia is a
  variable change plus a `web` rebuild; the mainnet indexer schema is kept for a later resume.
- Funds: the only platform-held balances are the admin's gas and the treasury; nothing is custodied for users.

## 9. Open security items (go / no-go before step 3)

Each one is a decision; the default is written so the cutover is not blocked, but the answer must be explicit.

1. **Admin key template restriction (C-03).** `AgentGuardian.approveSessionKey` accepts *any* `validatorData`, so
   the admin key can approve a permission with `SudoPolicy` and drain every kernel. Mitigation today: the admin key
   lives only on the supervisor. Go/no-go: deploy as is and restrict the admin key operationally (sealed Railway
   variable, no other holder), or hold the deploy until the guardian pins a policy template (module list + flags)
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
4. **Dev-buy minimum (BOOTR-05).** The launcher passes `pairedTokenAmountOutMinimum = 0`; the MEV block delay
   covers same-block sandwiching. *Default: accept.*
5. **MEV module.** The dry-run deploys through `ClankerMevBlockDelay` (still enabled on mainnet); clanker.world
   launches now use `ClankerSniperAuctionV2`. If Clanker disables the block-delay module, `deployToken` reverts
   `MevModuleNotEnabled` and the launcher must be redeployed with the auction module (different `mevModuleData`).
   *Default: keep the block delay; re-run the dry-run on deploy day.*
6. **Paymaster exposure.** Sponsored ops are capped by the CDP policy, not by Bootr. Set the daily USD cap before
   the first launch.

## Deployed (2026-10-27, Base mainnet, block 53172831)

| Contract | Address |
| --- | --- |
| AgentGuardian | `0x799Ab875294E37839883D12084aB4BE3f7633630` |
| BootrLauncher (Agent 5 / Creator 65 / Platform 30; buyback 5/50/15/30; min fuel 20 USDC) | `0x386CBE5DD03C38a31e52d94105d5CA83A311e21d` |
| BuybackBurner implementation | `0x7539bF645960Fc47556ECd449370BCc3A7D96Ed7` |
| BootrCallPolicy | `0x8586BdE0339b85bb9c0f0612954CCdF7fDCF9cE8` |
| BootrSwapHelper | `0x5723152f21ed7E305312fd90a2Bb94864BA9D80d` |

Owner of guardian and launcher: ADMIN `0x2C97C20FAD740cCf60d4Eeb54260F3BFE899D9b3` (accepted). All five verified on Basescan. $BOOT is not launched yet (planned from PLATFORM_TREASURY, buyback preset, no dev buy, 20 USDC fuel at launch time).

## Launcher redeploy (2026-10-28): flat launch fee

`BootrLauncher` gained an owner-settable flat ETH launch fee (`launchFeeWei`, `setLaunchFee`), charged on top of the
dev buy and forwarded to the preset's `platformRecipient`. Contracts are immutable, so the launcher was redeployed
once with `script/DeployLauncher.s.sol` (copies the live presets and `minPlatformBps` from the old launcher, hands
ownership to the admin, `guardian.setLauncher(new)`, pauses the old launcher). Guardian, burner implementation and
registered agents are untouched.

| | address / block |
| --- | --- |
| new `BootrLauncher` | `0x386CBE5DD03C38a31e52d94105d5CA83A311e21d` (block 53172831, fee 0.0005 ETH) |
| old `BootrLauncher` | `0xD4747d91BE6121eBa7602D9114B51d6C184084EF` (paused; `guardian.registerAgent` rejects it) |

The fee is changed from the admin console ("Launch fee" panel, `setLaunchFee`) without a redeploy. After a launcher
redeploy update `BOOTR_LAUNCHER_ADDRESS` / `NEXT_PUBLIC_LAUNCHER_ADDRESS` and `LAUNCHER_START_BLOCK` /
`BOOTR_START_BLOCK` on web, supervisor and indexer and redeploy the three services.
