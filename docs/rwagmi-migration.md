# Token launcher: Clanker v4 → RWAGMI v3 (B20)

Decision (2026-10-29): Bootr launches coins through the RWAGMI v3 launcher (Base B20 Asset tokens in Uniswap v4
pools) instead of Clanker v4. This note is the shared contract between the four workstreams. Anything not written
here keeps today's behaviour. Source of truth for the RWAGMI side: `@rwagmi/token-launcher-sdk` 0.3.0
(https://github.com/RWAGMI/token-launcher-sdk, MIT) and the verified contracts on Basescan.

## RWAGMI v3 stack (Base mainnet, chain 8453)

| contract | address | notes |
| --- | --- | --- |
| `RwagmiB20LauncherV3` | `0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20` | `launchB20(LaunchConfigV3) payable returns (address token, bytes32[] poolIds)` |
| `RwagmiHookV3` | `0xB20B00367E37F826a0652c85a6DF375D784B20Ec` | takes the swap fee in the paired asset; `PoolFeeTakenV3` |
| `RwagmiLpLockerV3` | `0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20` | holds LP, reward ledger, claims |
| `RwagmiEthDevBuyV3` | `0xb20A2dCBC4AA42474072381aEb52CbFc5C751B20` | optional ETH creator buy (WETH pool only) |
| `B20Factory` precompile | `0xB20f000000000000000000000000000000000000` | token address = f(launcher, salt) |
| WETH | `0x4200000000000000000000000000000000000006` | the only paired asset Bootr uses in v1 |
| indexer start block | 52,861,401 | launcher creation block (SDK `DEFAULT_LAUNCHER_V3`) |

There is no v3 deployment on Base Sepolia. Contract tests run on a Base mainnet fork (`base-anvil`); services are
tested with unit fixtures and, end to end, on mainnet with a test coin. Local dev stacks point at a mainnet fork.

## Fee model (what changes for users)

- Native LP fee 0. The hook charges a static 1% swap fee (`staticFee = 10_000`, hundredths of a bip) **in the paired
  asset only** (WETH). No Clanker-style protocol fee on top: swappers pay 1.00% instead of 1.20%.
- Of every fee, 90% goes to the launch's creator reward slots and 10% to RWAGMI (an 11th slot the launcher appends).
- Reward slots: 1–6, `bps` must total **9000**. Bootr presets, expressed in slot bps:
  - standard: agent 450 / creator 5850 / platform 2700
  - buyback: agent 450 / creator 4500 / burn 1350 / platform 2700
  - Shown to users as shares of the 1% swap fee: agent 0.045%, creator 0.585% (or 0.45% + 0.135% burn), platform
    0.27%, RWAGMI 0.10%.
- Slot `admin` = `BootrLauncher` for every slot. The launcher exposes no `updateRewardRecipient/Admin` call, so
  recipients and bps are locked for the coin's life, as today.
- Fees settle per pool and are claimed per currency by the **recipient** (or anyone calling with the recipient's
  entitlement? no: `claimQuote(currency, to)` and `settleAndClaim(ids, currency, to)` pay `msg.sender`'s balance to
  `to`). The agent's kernel therefore claims its own WETH through its session key; the burner claims its own; the
  platform claims from the console.

## Launch (BootrLauncher v2)

`BootrLauncher.launch(LaunchParams)` keeps its signature and its `AgentLaunched` event unchanged. Internally it
builds a `LaunchConfigV3` and calls `RwagmiB20LauncherV3.launchB20{value: devBuyWei}`:

- `b20Config`: variant 0 (Asset), `salt = keccak256(creator, p.salt)`, `params = abi.encode((uint8 version=1, name,
  symbol, address initialAdmin=0, uint8 decimals=18))`, `initCalls = [updateContractURI(p.metadataURI)]` when a URI
  is given, `initialAdmin = 0`, `originatingChainId = 8453`.
- `adminMode = 0` (immutable). `liquiditySupply = 100_000_000_000e18` (unchanged total supply).
- `creatorRewards`: the preset above with recipients `[kernel, creator, (burner), platformRecipient]`, admin =
  `address(this)`.
- `pools`: one pool, `pairedToken = WETH`, `allocationBps = 10000`, `tickSpacing = 200`, `fee = {mode: 0, staticFee:
  10_000, dynamicConfig: zero}`, `tickIfToken0IsB20 = -230_400` (~10 ETH FDV at 100B supply, same as today),
  `positions = [{tickLower: -230_400, tickUpper: -120_000, positionBps: 10_000}]` (one-sided, token0-is-B20
  orientation; the launcher mirrors when the B20 sorts as currency1; the contracts workstream verifies this against
  the verified source).
- `primaryPoolIndex = 0`, `extensions = devBuyWei > 0 ? [{extension: devBuyV3, poolIndex: 0, msgValue: devBuyWei,
  data: <recipient=creator, minOut>}] : []`, `deadline = block.timestamp + 1 hours`.
- After `launchB20`: ERC-8004 registration, fuel transfer, `guardian.registerAgent`, launch fee, refund: unchanged.
- The token address is predictable: `B20Factory.getB20Address(0, rwagmiLauncher, salt)`; `predictToken` replaces the
  Clanker-based prediction.

`BuybackBurner` v2: `burn()` claims the burner's WETH from the locker (`claimQuote(WETH, address(this))`), swaps WETH
→ coin on the v4 pool through the Universal Router (pool key from `LaunchPoolCreatedV3.key`), and sends the coin to
`0x…dEaD`. B20 is an ERC-20 superset, so transfers and `0xdEaD` work; no burn role is needed.

`BootrCallPolicy` (session key): replaces `ClankerFeeLocker.claim` with `RwagmiLpLockerV3.settleAndClaim(bytes32[],
address currency, address to)` and `claimQuote(address currency, address to)`, both only with `to == kernel`. Swap
and USDC funding rules are unchanged.

## Events and reads (indexer, web, supervisor)

| need | source |
| --- | --- |
| launch | `BootrLauncher.AgentLaunched` (unchanged) + `RwagmiB20LauncherV3.B20LaunchCreatedV3(creator, token, …, primaryPoolId, poolCount, …)` |
| pool key / id | `RwagmiB20LauncherV3.LaunchPoolCreatedV3(token, poolId, poolIndex, key{currency0, currency1, fee, tickSpacing, hooks}, …, startingTick, fee)` |
| swaps, price, volume | Uniswap v4 `PoolManager.Swap` by `poolId` (unchanged) |
| fee taken per swap | `RwagmiHookV3.PoolFeeTakenV3(poolId, quote, amount, swapCase, rate)` |
| fee credited per recipient | `RwagmiLpLockerV3.PoolFeesSettledV3(poolId, currency, slot, recipient, amount)` |
| claims | `RwagmiLpLockerV3.QuoteRewardsClaimedV3(recipient, currency, to, amount)` |
| locked split | `RwagmiLpLockerV3.launchInfo(token) → {poolIds, rewards[{admin, recipient, bps}], complete}` |
| claimable now | `pendingQuote(poolId, recipient)` (unsettled) + `claimableQuote(recipient, currency)` (settled) |
| deployment info | `RwagmiB20LauncherV3.deploymentInfo(token) → {token, creator, hook, locker, primaryPoolId, poolIds, adminMode, state}` |

Fee currency is WETH only: "claimable token" columns go away; every fee figure is WETH (and its USD value).

## Workstreams and file ownership

| workstream | owns | model |
| --- | --- | --- |
| contracts (this session) | `packages/contracts/**` | Fable |
| supervisor | `apps/supervisor/**` | Fable |
| indexer | `apps/indexer/**` | Opus |
| web | `apps/web/**`, `packages/shared/src/addresses.ts` (adds the RWAGMI stack, removes Clanker) | Opus |
| config and docs | `docs/**` (except this note), `.env.example`, `.env.mainnet.example`, `README.md`, `.railway/**`, `apps/web/components/docs/content.tsx` fee copy is web's | Sonnet |

Each workstream vendors the RWAGMI ABIs it needs from the SDK (`src/abi/rwagmi-launcher-v3.ts`,
`rwagmi-lp-locker-v3.ts`, `rwagmi-hook-v3.ts`, `rwagmi-eth-dev-buy-v3.ts`) into its own package, as the Clanker ABIs
are vendored today. Nobody edits another workstream's files; shared changes go through this note.

## Done means

- Contracts: fork tests launch a coin through RWAGMI v3 with both presets, assert `launchInfo` slots (recipients,
  bps, admin = launcher), a swap pays WETH fees that the kernel and burner can claim, `burn()` works, the dormancy
  path still works; `DeployLauncher` deploys the new launcher and re-points the guardian.
- Indexer: tokens, pools, swaps, fees per recipient and claims from the RWAGMI events; `/market`, `/treasury`,
  GraphQL and the SSE stream keep their shapes (fields that were per-token fee now carry 0 / are removed).
- Supervisor: treasury read (pending + claimable WETH), claim through the session key, fee policy (WETH → USDC fund
  path unchanged), onboarding decodes the new launch, tests green.
- Web: launch form (fee preview with the 90/10 split and RWAGMI line), token page fee split from `launchInfo`,
  profile/console fee panels, docs fee math, e2e green.
- Config: addresses, env templates, Railway variables list, runbooks updated; Clanker references removed except the
  agent-core communication policy (which still treats "clanker" handles as execution accounts).
