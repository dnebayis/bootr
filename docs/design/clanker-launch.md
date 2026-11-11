# Launch through Clanker

Design note, 2026-11-04. A creator picks "Launch through Bootr" (today's RWAGMI v3 path, `BootrLauncher` v3) or
"Launch through Clanker" (clanker.world's factory) and gets the same Bootr agent either way: kernel treasury, ERC-8004
identity, guardian, session key, fee split into the same four slots as far as Clanker's locker allows.

Bootr's launcher v1 / v1.1 (`0xD4747d91…`, `0x386CBE5D…`, blocks 53164454–53219209) already launched coins through
Clanker v4 from a contract on Base mainnet; the Clanker-era code is at commit `390468e` (`git show 390468e:<path>`)
and is the starting point for every task below. Everything in section 1 was re-verified on 2026-11-04.

## 1. Clanker interface, as verified

**Version.** The Base factory is `Clanker` v4.0.0 at `0xE85A59c628F7d27878ACeB4bf3b35733630083a9`
([docs: deployed contracts](https://clanker.gitbook.io/documentation/references/deployed-contracts.md); Basescan
tag "Clanker v4.0.0", source verified, exact match; Sourcify match, verified 2026-06-23). On-chain 2026-11-04 11:20
UTC, block 53500947: `deprecated() == false`, `teamFeeRecipient() == 0xFC535Ead…`. "v4.1" is not a new factory: it is
a set of modules enabled on the same factory (`ClankerHookStaticFeeV2` `0xb429d62f…`, `ClankerHookDynamicFeeV2`
`0xd60D6B21…`, `ClankerSniperAuctionV2` `0xebB25BB7…`, `ClankerAirdropV2` `0xf652B361…`,
`ClankerPoolExtensionAllowlist`). The SDK lists one `clanker_v4` entry for chain 8453 with these as `related`
([clanker-sdk `src/utils/clankers.ts`](https://github.com/clanker-devco/clanker-sdk/blob/main/src/utils/clankers.ts)).
The SDK reference calls the V4 class "current version"; the Droids funding page says "Supported on Clanker v4 and
v5" and nothing else documents a v5 (unclear, see section 7).

**Deploy function** (`deployToken(DeploymentConfig) public payable nonReentrant returns (address)`,
[`Clanker.sol`](https://github.com/clanker-devco/v4-contracts/blob/main/src/Clanker.sol)). Checks, in order:
`deprecated`, `originatingChainId == block.chainid`, extensions ≤ `MAX_EXTENSIONS = 10` and ≤ `MAX_EXTENSION_BPS =
9000` of supply, `msg.value == Σ extension.msgValue`, allowlists `enabledExtensions`, `enabledHooks`,
`enabledLockers[locker][hook]`, `enabledMevModules`. **No `msg.sender` restriction**: a contract can call it (Bootr v1
did). Order inside: token (fixed `TOKEN_SUPPLY = 100_000_000_000e18`) → pool init → liquidity placed in the locker →
extensions run (dev buy) → MEV module initialised. A MEV module is mandatory (`address(0)` cannot be enabled).
Structs ([`IClanker.sol`](https://github.com/clanker-devco/v4-contracts/blob/main/src/interfaces/IClanker.sol);
vendored copy at `390468e:packages/contracts/src/interfaces/IClanker.sol`):

- `TokenConfig { tokenAdmin, name, symbol, salt, image, metadata, context, originatingChainId }`. `tokenAdmin` may
  later change image / metadata / admin; `context` is immutable. Token address derivation (`ClankerDeployer`) was not
  read: whether `msg.sender` is mixed into the CREATE2 salt is unverified.
- `PoolConfig { hook, pairedToken, tickIfToken0IsClanker, tickSpacing, poolData }`; for the V2 hooks `poolData =
  abi.encode(PoolInitializationData{extension, extensionData, feeData})`, static `feeData =
  abi.encode(PoolStaticConfigVars{clankerFee, pairedFee})` in hundredths of a bip (10_000 = 1%).
  `MAX_LP_FEE = 100_000` (10%) on the hook; the SDK schema allows 0–2000 bps, the partner API 0.25–5% (default 1%).
  Dynamic hook: `baseFee` (≥ 25 bps), `maxFee` (≤ 3000 bps), filter / reset parameters.
- `LockerConfig { locker, rewardAdmins[], rewardRecipients[], rewardBps[], tickLower[], tickUpper[], positionBps[],
  lockerData }`. The live locker is `ClankerLpLockerFeeConversion` `0xffA37784D619F228D8B379d287a4D7282e500762`
  (SDK `related.locker`; on-chain `enabledLockers(0xffA3…, staticV2) == true`, dynamicV2 `true`). **The address the
  docs and README list for it, `0x63D2DfEA…`, is not enabled (`false`)**: a launch through it reverts.
  On-chain: `MAX_REWARD_PARTICIPANTS = 7`, `MAX_LP_POSITIONS = 7`; `rewardBps` sum to 10_000, no zero bps, no zero
  address; every position's `tickLower ≥ tickIfToken0IsClanker`; `positionBps` sum to 10_000. `lockerData =
  abi.encode(LpFeeConversionInfo{FeeIn[] feePreference})`, one per recipient: `Both` (0), `Paired` (1), `Clanker`
  (2). Bps are immutable; each `rewardAdmins[i]` may `updateRewardRecipient`, `updateRewardAdmin`,
  `updateFeePreference` for its index.
- `ExtensionConfig { extension, msgValue, extensionBps, extensionData }`: dev buy `ClankerUniv4EthDevBuy`
  `0x1331f078…` (`abi.encode(Univ4EthDevBuyExtensionData{pairedTokenPoolKey, pairedTokenAmountOutMinimum,
  recipient})`), vault `0x8E845EAd…` (lockup ≥ 7 d, linear vesting), airdrop V2 (≥ 25 bps, lockup ≥ 1 d), presale
  `0xeeBbC567…`. None is needed for Bootr except the dev buy.
- `MevModuleConfig { mevModule, mevModuleData }`: clanker.world and the SDK default use `ClankerSniperAuctionV2`
  with `abi.encode(FeeConfig{startingFee, endingFee, secondsToDecay})` (SDK defaults 666_777 / 41_673 / 15; docs
  recommend 80% → 5% over 30 s). `ClankerMevBlockDelay` `0xE143f987…` is what Bootr v1 used (enabled 2026-10-27).
  `enabledMevModules` is not a public mapping, so today's state must be read from `SetMevModule` logs or a fork test.

**Protocol share.** The hook charges `PROTOCOL_FEE_NUMERATOR = 200_000` = **20% of the LP fee, on top of it**
(on-chain on `ClankerHookStaticFeeV2`; [docs: creator rewards and fees](https://clanker.gitbook.io/documentation/general/creator-rewards-and-fees.md):
"1% creator → 0.2% protocol → 1.2% total swap fee"). The hook takes it to the factory; `claimTeamFees` moves it to
`teamFeeRecipient`. Reward recipients share **100% of the LP fee** by `rewardBps`.

**Fee claiming.** The locker collects the LP positions' fees (`collectRewards(token)`, permissionless; the hook also
calls `collectRewardsWithoutUnlock` on swaps; skipped while the MEV module is active), converts per preference
(internal swap with `amountOutMinimum: 0`) and deposits each recipient's share into `ClankerFeeLocker`
`0xF3622742b1E446D92e45E22923Ef11C2fcD55D68` (`allowedDepositors(locker) == true`), emitting
`ClaimedRewards(token, amount0, amount1, rewards0[], rewards1[])`. **`ClankerFeeLocker.claim(feeOwner, token)` is
callable by anyone and always pays `feeOwner`**; `availableFees(feeOwner, token)` is the balance; events
`StoreTokens`, `ClaimTokens(feeOwner, token, amount)`
([docs: ClankerFeeLocker](https://clanker.gitbook.io/documentation/references/core-contracts/v4/fee-management-contracts/clankerfeelocker.md)).

**Events.** `TokenCreated(msgSender, tokenAddress idx, tokenAdmin idx, tokenImage, tokenName, tokenSymbol,
tokenMetadata, tokenContext, startingTick, poolHook, poolId, pairedToken, locker, mevModule, extensionsSupply,
extensions[])` on the factory; `ClaimedRewards` / `FeesSwapped` on the locker; `ClaimTokens` on the fee locker;
Uniswap v4 `PoolManager.Swap` on the pool.

**Listing on clanker.world.** No API call is required to deploy. The on-chain `context` (`{interface, platform,
messageId, id}`; the SDK defaults `interface: "SDK"`) "is not authenticated"; the site verifies in this order:
allowlisted contract (`isTrustedClanker`), trusted deployer (`msg_sender`), Farcaster FID ↔ deployer match, Twitter
id, else the token is shown as **Unverified**
([docs: verifying social context](https://clanker.gitbook.io/documentation/general/verifying-the-social-context-of-token-deploys.md)).
Whether direct deployments are indexed automatically is not stated; the public `POST /api/tokens/index-by-address`
(Base only, no key, 1 request per hour per address) indexes a token and returns
`https://clanker.world/clanker/0x…` ([docs: public deployment API](https://clanker.gitbook.io/documentation/api-reference/public/deployment.md)).
Warning tags: `UNUSUAL_TICK` (opening cap below ~1 ETH), `UNUSUAL_PAIR_ADDRESS`, `UNUSUAL_POSITIONS` (positions not
the `Standard` `[-230400, -120000]` single position or the `Project` five-position layout), `MISSING_POOL_CONFIG`.
The clanker.world form's own defaults: starting cap 10 ETH ("Recommended" layout, several positions; `Standard` tick
`-230400` ≈ 10 ETH ≈ $27k FDV in the SDK's comments), dynamic 1–5% fee, sniper auction V2, 100% of rewards to the
connected wallet in the paired token. The partner API (`POST /api/tokens/deploy`, `x-api-key`) has Clanker send
the transaction and is not usable from a contract. Clanker also sells its own token agent ("Droids": a 1–50%
carve-out of LP rewards to a runtime wallet, Farcaster posts with manual confirm); it is attached only through
their form, not to SDK / contract launches.

## 2. Proposed design: `BootrClankerLauncher`

Same shape as `BootrLauncher.launch(LaunchParams)` and the same `LaunchParams` / `LaunchDefaults` structs, so the web
and the supervisor reuse one ABI. Steps: (a) `kernelFactory.createAccount` (root validator = guardian, same init
data), (b) `clanker.deployToken{value: devBuyWei}(cfg)`, (c) ERC-8004 `register(agentURI)` + transfer to the kernel,
(d) USDC fuel, (e) guardian registration, (f) events, (g) launch fee + refund. `cfg`:

- `tokenConfig`: `tokenAdmin = this` (the contract has no `updateImage` / `updateMetadata` / `updateAdmin` path, so
  the coin's image and metadata are immutable like today), `salt = keccak(creator, p.salt)`, `image = p.image`
  (clanker.world shows `TokenCreated.tokenImage`: pass the hosted image URL, not only the contract URI),
  `metadata = p.metadata` (the SDK shape `{description, socialMediaUrls, auditUrls}` is what aggregators read),
  `context = p.context` (`{"interface":"Bootr","platform":"bootr.fun","id":<draft>}`, already emitted today).
- `poolConfig`: `ClankerHookStaticFeeV2`, WETH, **`tickIfToken0IsClanker = -230400`, tickSpacing 200**, static
  `clankerFee = pairedFee = lpFeeBps` (10_000 = 1%). One position `[-230400, -120000]`, 100%: the `Standard` layout,
  so the coin carries no `UNUSUAL_*` tag. The opening cap is therefore ~10 ETH, not Bootr's ~2.7 ETH (section 7).
- `lockerConfig`: locker `0xffA37784…`; recipients and bps **straight from the Bootr preset, no 9000 scaling**:
  `[kernel agentBps, creator creatorBps, (burn slot burnBps), platformRecipient platformBps]`, `rewardAdmins[i] =
  this` on every slot and no function that calls the locker's update methods, so the split is locked as today.
  Fee preference `Paired` for agent, creator and platform (everything arrives as WETH, the treasury path stays
  WETH-only). The limit of 7 recipients is never reached (max 4).
- **Buyback slot**: Clanker's locker converts a slot's share into the coin itself (`FeeIn.Clanker`), so no swap
  contract is needed: recipient `0x000…dEaD`, preference `Clanker`. Anyone finalises with
  `ClankerFeeLocker.claim(0xdEaD, token)`; the coin is out of circulation from the moment the locker swaps it. This is
  simpler than `BuybackBurner` (which existed because RWAGMI pays WETH only). Alternative, if the admin-controlled
  `minOut` of `swapAndBurn` is wanted: a clone of `BuybackBurner` with `claim()` pointed at `ClankerFeeLocker`
  (the v1 code at `390468e`).
- `mevModuleConfig`: `ClankerSniperAuctionV2` with Clanker's recommended `FeeConfig` (what every clanker.world
  launch uses; the dev buy runs before the module is initialised, so it is not auctioned). Decision pending the
  enabled-module check (section 7); `ClankerMevBlockDelay` is the fallback v1 shipped with.
- `extensionConfigs`: dev buy only, `msgValue = devBuyWei`, `recipient = creator`, `pairedTokenAmountOutMinimum = 1`
  (same reasoning as today: the pool is created in this transaction).

**Guardian.** `AgentGuardian.registerAgent` accepts exactly one `launcher` (`msg.sender != launcher → NotLauncher`),
and `BootrLauncher` v3 calls the guardian directly. Two launchers therefore need a small `BootrLaunchGate`
(allowlist of launchers, forwards `registerAgent`; owner = platform admin) set as `guardian.launcher`, and a
`BootrLauncher` v3.1 redeploy whose only change is `gate.registerAgent(...)` (the kernel root validator stays the
guardian). The launcher-switch procedure in `docs/deploy/mainnet.md` covers the redeploy. Alternative: one
`BootrLauncher` v4 with both backends and no gate; it needs the two config builders moved into external libraries to
stay under the 24 kB code limit. The gate keeps the contracts and the engineers independent; it is the proposal.

**Events.** `AgentLaunched(token, kernel, creator, burner, agentId, defaults, workerHash, model, agentURI,
supervisorSessionKey)` with the identical signature (`burner` = `0xdEaD` or zero; the indexer's `factory()` sources
and the supervisor's `LaunchContext` decoding keep working), `LaunchContext(token, context)`, `LaunchFeePaid`, plus
`ClankerLaunched(token indexed, poolId, hook, locker, mevModule, startingTick, lpFeeBps)` so the indexer does not have
to decode Clanker's `TokenCreated` from the receipt (it still can, as v1's handler did).

## 3. Fee claiming

**Agent (supervisor `treasury.ts`, second path keyed by `agent.source`).** Read: `settled =
ClankerFeeLocker.availableFees(kernel, WETH)`; `pending` (fees still inside the LP position) has no simple view, read
it from the position's fee growth via `tokenRewards(token).positionId` or show 0 (open). Claim op (`claim_fees`), one
batched userOp from the kernel: `ClankerLpLockerFeeConversion.collectRewards(token)` then
`ClankerFeeLocker.claim(kernel, WETH)`. Session-key policy (`session-key.ts`): two rules, `collectRewards(address)`
with `arg0 == token` and `claim(address,address)` with `arg0 == kernel` (the v1 rule
`FEE_LOCKER_CLAIM_SELECTOR` at `390468e:apps/supervisor/src/session-key.ts:167-188`); a new rule layout version so
`fundingRuleIndex` keeps resolving. Because `claim` pays the kernel whoever calls, an out-of-gas kernel can be claimed
for by the admin or anyone: a cheap fallback the RWAGMI path does not have (`settleAndClaim` pays the caller). The
fee policy itself (claim → gas → swap → spender float) does not change; the swap helper is launcher-agnostic.

**Platform and creator.** Manual: `ClankerFeeLocker.claim(platformRecipient, WETH)` from the admin console's fee panel
(a "Claim on Clanker" button; also fine from `cast send`), the creator's claim button on the coin page calls
`claim(creator, WETH)` from the creator's wallet. The v1 panels (`git show 390468e:apps/web/components/token/...`)
did exactly this before commit `c5e0280` replaced them with the RWAGMI versions; keep both, chosen by `source`.

## 4. Indexer

- `ponder.config.ts`: the wrapper joins `BOOTR_LAUNCHERS` (every Bootr source already takes the address list); new
  sources `Clanker` (`TokenCreated`, filter `msgSender` ∈ Clanker launchers), `ClankerLpLockerFeeConversion`
  (`ClaimedRewards`), `ClankerFeeLocker` (`ClaimTokens`); `PoolManager.Swap` on the new pool ids (already generic).
  Env: `CLANKER_FACTORY_ADDRESS`, `CLANKER_LOCKER_ADDRESS`, `CLANKER_FEE_LOCKER_ADDRESS`, `CLANKER_START_BLOCK`
  (`src/lib/env.ts`, same pattern as `rwagmiStack`). A new launcher changes Ponder's build id: new
  `DATABASE_SCHEMA` and a backfill, as README "Adding a launcher" says.
- `ponder.schema.ts`: `token.source: 'bootr' | 'clanker'` (text, not null, default `'bootr'`), `pool.hooks` already
  holds the hook. `protocolBps` keeps its meaning "bps the launch protocol takes" with the note that on Clanker it is
  2000 of the LP fee **on top** (`lpFeeBps` × 1.2 is what a trader pays) and `agent + creator + burn + platform =
  10000`, versus 9000 + 1000 within the fee on RWAGMI. `feeSlot` rows: 3–4 slots, `recipientKind` as today, the
  burn slot's recipient is `0xdEaD`; no `protocol` row.
- `src/launcher.ts`: in the `AgentLaunched` handler branch on the emitting launcher (`event.log.address`); for the
  Clanker branch build the token / pool rows from `ClankerLaunched` + `TokenCreated` (v1's receipt decoding at
  `390468e:apps/indexer/src/launcher.ts:40-60`) and read `tokenRewards(token)` from the locker for the slots.
- `src/fees.ts`: accrual from `ClaimedRewards` (per coin, per recipient, amounts post-conversion: WETH for the three
  `Paired` slots, coin for the burn slot) into `feeAccrual` / `feeBalance.settled`; claims from `ClaimTokens`
  through the existing `recordClaim` split (a claim pays the recipient's whole WETH balance across coins, exactly
  like `QuoteRewardsClaimedV3`). Gross fee per trade on Clanker coins: `valueUsd × lpFee × 1.2 / 1e6` (`Swap.fee`
  carries the LP fee only). `burnedTotal`: count the burn slot's `ClaimTokens` / coin transfers to `0xdEaD`.
- `src/api`: `/market/:token` and `/treasury/:kernel` return `source` and the Clanker balances (`availableFees`);
  `/platform/feed` entries unchanged.

## 5. Web

- Launch form (`components/launch/LaunchForm.tsx`, `lib/launch.ts`, `app/api/launch/*`, `lib/server/launch-drafts.ts`):
  a "Launch through" choice at the top of 06 Fuel & options, two cards in plain words:
  *Bootr* — "1% fee on every trade; 90% of it goes to the agent, you and the platform, 10% to the pool provider.
  Opens at about $6k. Listed on bootr.fun." *Clanker* — "1% fee to the agent, you and the platform, plus 0.2% that
  Clanker charges on top. Opens at about 10 ETH. Listed on bootr.fun and clanker.world." The summary card's fee
  split and cost line follow the choice; the draft stores `source`; the transaction goes to
  `NEXT_PUBLIC_CLANKER_LAUNCHER_ADDRESS` with the same `LaunchParams`. The agent API (`app/api/agent/launch`) gets
  `launchThrough: 'bootr' | 'clanker'`.
- Coin page (`components/token/TokenView.tsx`, `lib/coin-links.ts`): a label under the ticker, "Launched through
  Clanker" with a link to `https://clanker.world/clanker/<token>`; the fee panel reads the split by `source`; the
  creator claim button targets the fee locker for Clanker coins. `app/docs/launch` gets the comparison below.
- After a Clanker launch the web calls `POST https://www.clanker.world/api/tokens/index-by-address` once (public, 1
  per hour per address) so the token page exists on clanker.world without waiting for their indexer.

## 6. Bootr vs Clanker

| | Launch through Bootr (RWAGMI v3) | Launch through Clanker (v4) |
| --- | --- | --- |
| Trader pays | 1% (hook fee, WETH) | 1.2% (1% LP fee + 20% protocol on top) |
| Of the 1%: agent / creator / platform / burn | 4.5 / 58.5 / 27 (buyback 4.5 / 45 / 13.5 / 27) % of the swap fee; RWAGMI 10% | 5 / 65 / 30 (buyback 5 / 50 / 15 / 30) % of the LP fee; Clanker 0.2% extra |
| Protocol's share of what traders pay | 10% | 16.7% |
| Opening cap | ~2.7 ETH (~$6k), chosen by Bootr | ~10 ETH (~$27k) to match `Standard`; any tick is possible but off-standard layouts get a warning tag |
| Fee asset | WETH only | WETH (`Paired`); the burn slot receives the coin itself |
| Agent claim | kernel calls `settleAndClaim` (pays the caller, session-key rule `to == kernel`) | kernel (or anyone) calls `collectRewards` + `claim(kernel, WETH)`; always pays the kernel |
| Platform / creator claim | from their wallets on the RWAGMI locker | `claim(recipient, WETH)` by anyone |
| Split lock | admin = launcher, no update path | same (`rewardAdmins = launcher`) |
| Visibility | bootr.fun | bootr.fun + clanker.world (shown "Unverified" unless Bootr is a trusted deployer); DEX aggregators that follow Clanker |
| Extras available | — | sniper auction, vault, airdrop, presale (not used by Bootr) |
| Third-party control | RWAGMI can rotate modules | Clanker can pause deployments (`setDeprecated`) and disable hooks / lockers / modules at any time |

## 7. Risks and open questions

1. **One launcher per guardian**: the gate + `BootrLauncher` v3.1 redeploy (section 2) is a mainnet operation of its
   own; sequence it before the Clanker launcher goes live.
2. **MEV module**: `enabledMevModules` is not public. Confirm `ClankerSniperAuctionV2` (and `ClankerMevBlockDelay`)
   are enabled from `SetMevModule` logs in the fork test before choosing. Also confirm the hook, locker and dev-buy
   allowlists the same way the day of the deploy; Clanker's admin can change them without notice.
3. **Locker conversion swaps** run with `amountOutMinimum: 0` on every collection (the coin share of the three
   `Paired` slots, the WETH share of the burn slot). Every clanker.world token with a `Paired` preference lives with
   this; the alternative `Both` leaves coin in the kernel that the treasury never swaps. Decide `Paired` (proposed).
4. **Opening cap**: `Standard` (~10 ETH) or Bootr's ~2.7 ETH with an `UNUSUAL_POSITIONS` tag on clanker.world.
   Proposed: `Standard`, stated plainly on the form.
5. **Listing and verification**: unknown whether the site indexes direct deployments on its own; `index-by-address`
   is the explicit path. Ask Clanker (docs "contact" page) to add the wrapper to the trusted-contract list so coins
   are not shown as Unverified; without it, the `context.platform = bootr.fun` is displayed but unverified.
6. **v5**: Bootr's Clanker path moves to Clanker v5 (factory `0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0`, a buy and sell
   tax instead of an LP fee, fees in the `FeeEscrow`): design, slot arithmetic, migration plan and runbook in
   [`clanker-v5-migration.md`](./clanker-v5-migration.md). This note stays the reference for the v4 launcher, which
   keeps serving $BOOTR and the other v4 coins.
7. **Token address prediction**: `ClankerDeployer`'s salt derivation was not read; the wrapper uses the returned
   address and `predictToken` is dropped for this path (the web shows the address after the receipt, as v1 did).
8. **Pending fees view**: no `pendingQuote` equivalent; the agent's snapshot may under-report until collection.
9. **Fee-on-top economics**: a Clanker coin costs traders 20% more per swap; the comparison must say so.
10. **Two schemas, one web**: every place that sums `agentBps + creatorBps + burnBps + platformBps` must handle 9000
    and 10000; grep for `9000` / `protocolBps` in `apps/web` and `apps/indexer`.

## 8. Work breakdown

| Task | Files | Notes |
| --- | --- | --- |
| **A. Contracts + fork tests** | `packages/contracts/src/BootrClankerLauncher.sol` (new), `src/interfaces/IClanker.sol` (restore from `390468e`), `src/BootrLaunchGate.sol` (new), `src/BootrLauncher.sol` (v3.1: register through the gate), `src/AgentGuardian.sol` untouched, `script/DeployClankerLauncher.s.sol`, `test/fork/ClankerFork.t.sol` (restore the Clanker parts of `390468e:packages/contracts/test/fork/MainnetDryRun.t.sol`: launch both presets with / without dev buy, read `tokenRewards`, swap, `collectRewards` + `claim` as the kernel, burn slot receives coin, `SetMevModule` log check), `packages/shared/src/addresses.ts` (`clanker` block with the addresses in section 1 and their sources) | `base-forge` on a mainnet fork; independent of B–D |
| **B. Treasury tool** | `apps/supervisor/src/abi.ts` (fee locker + locker ABIs from `390468e`), `treasury.ts` (`readTreasuryOnChain`, `encodeClaimCall` by source), `session-key.ts` (two rules, layout version), `db/schema.ts` + migration (`agents.source`), `onboarding.ts` / `config.ts` / `chain.ts` (launcher list `BOOTR_LAUNCHERS`, Clanker addresses), tests | Starts now against the event shape; needs A only for the fork rehearsal |
| **C. Indexer** | `apps/indexer/abis/Clanker.ts`, `ClankerFeeLocker.ts`, `ClankerLpLockerFeeConversion.ts` (from `390468e`), `ponder.config.ts`, `ponder.schema.ts` (`token.source`), `src/launcher.ts`, `src/fees.ts`, `src/lib/env.ts`, `src/lib/store.ts` (`recipientKindOf` with `0xdEaD`), `src/api/index.ts`, `README.md`, `docs/data-contract.md` | New `DATABASE_SCHEMA` + backfill on deploy |
| **D. Web** | `apps/web/components/launch/LaunchForm.tsx`, `lib/launch.ts`, `lib/abi/launcher*.ts`, `app/api/launch/*`, `lib/server/launch-drafts.ts`, `app/api/agent/launch`, `components/token/TokenView.tsx`, `lib/coin-links.ts`, admin console fee panel, `app/docs/launch`, `.env` (`NEXT_PUBLIC_CLANKER_LAUNCHER_ADDRESS`) | Copy per `public-copy-no-internal-jargon`; mock data gets a Clanker coin |
| **E. Ops** | `docs/deploy/mainnet.md` (launcher history, gate, `BOOTR_LAUNCHERS`), `.env.mainnet.example`, Coolify variables | After A; `guardian.setLauncher(gate)` from the admin |
