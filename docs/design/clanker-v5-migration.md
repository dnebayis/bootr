# Clanker v5 migration

Design note, 2026-11-10. Bootr's "Launch through Clanker" path moves from Clanker v4 (`BootrClankerLauncher`
`0x387f1B0a…AbbB`, LP fee + 20% on top, `ClankerLpLockerFeeConversion`, `ClankerFeeLocker`) to Clanker v5 (a buy and
sell tax, the `TaxLaunchHook`, the `FeeEscrow`). Approved by the owner on 2026-11-08; the burn-preset split of v4
([`clanker-launch.md`](./clanker-launch.md) section 7.6, `docs/research/bankr-clanker-gaps-2026-11.md`) is fixed by it,
and the indexer's claim cross-booking fix lands in the same schema bump. The v4 design stays the reference for what
the wrapper does around the launch (kernel, identity, fuel, gate); this note covers what changes.

Marks: **V** = read on a primary source (Clanker's verified sources on Sourcify, the live factory on Base, Clanker's
docs, the clanker-sdk repository), with the source named; **U** = unverified; **I** = inferred. Every address below was
read from the verified source or the live chain on 2026-11-10 (Base block 55346749) unless marked otherwise.

## 1. What Clanker v5 is

Sources: the factory's verified sources on Sourcify (exact match, verified 2026-11-03;
`https://sourcify.dev/server/v2/contract/8453/0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0?fields=all`, 65 files,
`src/tax/TaxRWAERC20LaunchpadFactory.sol`, `TaxLaunchpadFactoryCore.sol`, `TaxLaunchHook.sol`, `TaxFeeMath.sol`,
`TaxLaunchValidation.sol`, `TaxLaunchOperations.sol`, `TaxLaunchToken.sol`, `TaxLaunchTokenDeployer.sol`,
`FeeEscrow.sol`; the hook `0x5E320eA6…2AcC`, the escrow `0x5dd237d1…FA61` and the launch-buy adapter
`0x5C65823d…DA4d` are exact matches too), the live factory read with `cast call` at block 55346749, Clanker's docs
([v5 core contracts](https://clanker.gitbook.io/documentation/references/core-contracts/v5.md),
[v5 deployments](https://clanker.gitbook.io/documentation/tokens/token-deployments/v5-deployments.md),
[deployed contracts](https://clanker.gitbook.io/documentation/references/deployed-contracts)) and
[clanker-sdk](https://github.com/clanker-devco/clanker-sdk) `src/v5/*` (`addresses.ts`, `config.ts`, `launch.ts`,
`vanity.ts`, `routes.ts`) and `docs/v5.md`.

**Contracts on Base (V, docs + Sourcify + chain).** Factory `TaxRWAERC20LaunchpadFactory`
`0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0` (Solidity 0.8.26, via IR, not upgradeable; owner `0x87f4aa83…aF15`);
hook `TaxLaunchHook` `0x5E320eA6278107968C119942E57d876c5F922AcC` (one shared Uniswap v4 hook for every v5 pool; low
14 bits = its permissions: beforeInitialize, beforeAddLiquidity, beforeRemoveLiquidity, beforeSwap, afterSwap, both
return deltas); `FeeEscrow` `0x5dd237d1f716C65426CCd2FAe82B95109825FA61`; `TaxLaunchTokenDeployer`
`0xc25FfE6374EdcCb5bFCcA3b9684046a426AbCE6A`; `SwapXLaunchBuyAdapter` `0x5C65823dC5eaf0C37205F73213fC2f73D359DA4d`
(the factory's `launchBuyAdapter()`); `AnnouncementRegistry` `0x1B417526…097a`; `TaxLaunchValidation`
`0x830feA2a…5033`; the dividend contracts (`TaxDividendDeployer` `0xaaC00696…521e`, claim helper
`0xe896454E…34BD`, implementation `0x4C9C5D7E…E78f`) are not used by Bootr. There is no separate "tax module" or
locker: the hook holds the liquidity and takes the tax, the escrow holds the fees.

**Live configuration (V, `cast call` at block 55346749).** `configVersion() = 23`, `nativeLaunchFee() = 0`,
`launchSupply() = 1e27` (1,000,000,000 tokens, 18 decimals; v4 minted 100 B), `tickSpacing() = 200`,
`launchCreationEnabled() = true`, band template one band `[0, TAIL]` with 100% of the supply (the whole supply sits
in one single-sided range from the opening price upwards). `taxPolicy()`:

| Field | Value | Meaning |
| --- | --- | --- |
| `taxFeeBounds` | buy 1,000,000–10,000,000, sell 1,000,000–10,000,000 | 1%–10% per side (scale 1e8 = 100%) |
| `protocolFeeConfiguration.protocolTaxShare` | 10,000,000 | Clanker takes 10% of the tax… |
| `minimumProtocolFeeRate` / `maximumProtocolFeeRate` | 500,000 / 1,000,000 | …but at least 0.5% and at most 1% of the trade |
| `protocolFeeRecipient` | `0x7a2E54E3aa9C4D02F6C9B950DcD33054D2043829` | Clanker's fee wallet (frozen per pool at launch) |
| `antiSnipeConfiguration` | 99,000,000 / 20 | buys in the first 20 s pay a total fee that falls linearly from 99% to the tax; the extra goes to Clanker; exact-output swaps revert during the window |
| `minimumDividendHoldingRequirement` | 1e22 | 10,000 tokens (dividends only) |

Quote tokens (V): `quoteConfig(address(0))` = registered, 18 decimals, `startTickToken0Frame = -201000`;
`quoteConfig(USDC)` = registered, 6 decimals, `-400600`; **`quoteConfig(WETH)` = not registered**: an ETH pool is a
native-ETH pool (`currency0 = 0x000…0`), the SDK's `pairedToken: 'WETH'` is an alias for `address(0)`
(`config.ts taxQuoteToken`). The start tick is set by Clanker's `priceUpdater` so each quote opens at a steady
market cap: `-201000` is 1.0001^-201000 ≈ 1.86e-9 ETH per token, 1.86 ETH for the 1 B supply, about $3,950 at
$2,125/ETH; `-400600` is about 4,000 USDC. **Bootr cannot choose the opening cap on v5** (I: it is Clanker's dial;
it was roughly $4k on the day this was written, below Bootr's ~$6k RWAGMI cap and far below the ~$27k of the v4
path).

**Deploy call (V, `TaxLaunchpadFactoryCore.sol`).** `createLaunch(LaunchParams) payable returns (address token,
PoolId poolId)` with `msg.value == nativeLaunchFee` (0 today); `createLaunchAndBuy(LaunchParams, LaunchBuyParams)
payable returns (token, poolId, amountOut)` with `msg.value == nativeLaunchFee + amountIn` when `fundingToken ==
address(0)`. No `msg.sender` restriction: a contract may call it (Bootr's wrapper does). `LaunchParams`:

| Field | Type | What Bootr passes |
| --- | --- | --- |
| `creator` | address | `address(0)` → `msg.sender` (the wrapper) holds the creator rights: locked (section 3) |
| `feeSlots` | `FeeSlotInput[]` `{recipient, admin, relativeWeightBps, isCreator}` | 3 or 4 slots, weights sum to 10,000, `admin` = the wrapper, no `isCreator` |
| `tokenName`, `tokenSymbol` | string | `p.name`, `p.symbol` |
| `tokenContractURI` | string | `p.metadata` |
| `creatorSalt` | bytes32 | `keccak256(abi.encode(creator, p.salt))`; the factory scopes it again as `keccak256(abi.encode(msg.sender, creatorSalt))` and rejects a reused scoped salt (`LaunchSaltUsed`) |
| `quoteToken` | address | the wrapper's immutable `quoteToken` (`address(0)` = native ETH, recommended; `USDC` possible) |
| `expectedConfigVersion` | uint64 | `factory.configVersion()` read in the same transaction (a stale value reverts `StaleConfig`) |
| `deadline` | uint64 | `block.timestamp` |
| `metadataEditable` | bool | `false` (name, symbol, URI and extra metadata frozen, like v4) |
| `metadataKeys` / `metadataValues` | string[] | `["image", "metadata", "context"]` = `[p.image, p.metadata, p.context]`, the keys clanker-sdk writes (V for the SDK; I that clanker.world reads them) |
| `taxConfiguration` | `{buyTaxRate, sellTaxRate, creatorAllocationShare, burnAllocationShare, dividendAllocationShare, integratorAllocationShare, minimumDividendHolding}` | rates and shares on the 1e8 scale: `buyTaxRate = sellTaxRate = taxBps × 100`; `burnAllocationShare = burnBps × 10,000` (buyback preset) else 0; `creatorAllocationShare = 1e8 − burn`; dividends and integrator 0 |
| `creatorFeeRecipient` | address | the human creator (unused for payouts when no slot is `isCreator`; must be a valid recipient) |
| `integratorFeeRecipient` | address | `address(0)` |
| `antiSnipeEnabled` | bool | `true` (Clanker's default; owner-settable on the wrapper) |

Checks in `_prepareLaunch` (V): config version, deadline, non-empty name and symbol, registered quote, matching
metadata arrays, `validateLaunchTax` (rates inside the bounds; the four shares sum to exactly 1e8), scoped salt
unused, **the predicted token address must end in `0xcccc`** (`_validatePredictedToken`, `InvalidTokenAddressSuffix`),
recipients not a Clanker contract or a launch token. The token is a `TaxLaunchToken` created by CREATE2 from the
token deployer: `address = create2(tokenDeployer, scopedSalt, keccak(creationCode ‖ abi.encode(GenesisParams)))`
with `GenesisParams = (factory, dividendsEnabled, name, symbol, contractURI, metadataAuthority, hook,
launchSupply, metadataKeys, metadataValues)`; `factory.launchTokenInitCodeHash(launchParams)` returns the init code
hash, so the salt is mined off-chain (clanker-sdk `vanity.ts mineTaxSalt`: random 32-byte salt, increment until the
low 16 bits of the address are `0xcccc`; about 65,536 keccaks on average, a second in a browser). The pool key is
`(min(token, quote), max(token, quote), fee 0, tickSpacing, hook)`: with the native quote `currency0 = address(0)`
and the coin is always `currency1`. The factory then initialises the pool at the quote's start tick, registers the
pool on the hook (`PoolRegistered`, `FeeSlotCreated` per slot), seeds the single-sided band (`Seeded`) and emits
`LaunchTaxConfigured(poolId, token, configVersion, admittedPolicy, taxConfiguration, integratorFeeRecipient,
antiSnipeEnabled)` and `Launched(token, poolId, originalCreator, quoteToken, launchSupply, tickSpacing)`.

**Dev buy (V, `TaxLaunchpadFactoryCore.createLaunchAndBuy`, `TaxLaunchHook.executeLaunchBuy`,
`SwapXLaunchBuyAdapter.sol`).** No extension: the factory asks the hook to run the adapter with
`LaunchBuyParams{fundingToken: address(0), amountIn, minAmountOut ≥ 1, routeData}`; `routeData` is
`abi.encode(SwapDesc[])` and for a native quote one hop `{swapType 2, tokenIn address(0), tokenOut token,
poolAddress 0, fee 0, tickSpacing, hooks hook, hookData ""}` (clanker-sdk `routes.ts directNativeSwapXRoute`). The
buy is exempt from the anti-snipe surcharge (`_rates(…, exempt = activeLaunchBuy)`), and **the bought coins land on
`originalCreator = msg.sender` of the factory call**, so the wrapper receives them and forwards them to the creator.

**Tax (V, `TaxFeeMath.sol`, `TaxLaunchHook._afterSwap`, `_creditCreatorTax`).** On every swap of a registered pool
the hook takes the tax: the quote part as an ERC-6909 claim minted to the escrow (on a buy from the input, on a sell
from the output, so slots are paid in the quote on both sides) and the burn part in the launched token. The split of
the quote part: `protocol = clamp(tax × protocolTaxShare, minimumProtocolFeeRate, maximumProtocolFeeRate)` of the
trade (10% of the tax, never under 0.5% nor over 1% of the trade; the floor binds for every tax up to 5%),
`remainder = tax − protocol`; `creatorAmount = remainder × creatorAllocationShare` goes to the fee slots, each slot
`creatorAmount × weightBps / 10,000` with **the last slot taking only the wei remainder** (`_creditCreatorTax`);
`burn = remainder × burnAllocationShare`, taken in the coin and credited to the escrow for
`0x000000000000000000000000000000000000dEaD` (`BURN_SINK`). Events per swap: `Trade(poolId, executor, referrer,
quoteCurrency, quoteFeeAmount, comment)`, `ProtocolFeeCredited`, `AntiSnipeFeeCredited`, one
`CreatorTaxCredited(poolId, recipient, currency, amount)` per slot, `BurnTaxCredited(poolId, token, sink, amount)`,
and the escrow's `Credited(recipient, currency, amount)` for each. Frozen per pool at launch: tax, shares, the
admitted policy (Clanker's later policy changes apply to new launches only).

**Fee escrow (V, `FeeEscrow.sol`).** `owed(recipient, currency)` is one balance per recipient and currency across
every v5 pool (Bootr's and anyone else's); `claimFor(recipient, currency)` (selector `0xb4ba9e11`) is callable by
anyone and pays the whole balance to `recipient` (`poolManager.take`, native ETH when `currency == address(0)`);
`claimTo(currency, destination)` (`0x34a1ca89`) lets the balance owner redirect its own balance; `Claimed(recipient,
currency, destination, amount)` on payout. Only the hook can `credit`. `claimFor` reverts `NothingToClaim` on zero.

**Reward slots after launch (V, `TaxLaunchHook.updateFeeSlotRecipient / updateFeeSlotAdmin`).** Each slot's admin may
change that slot's recipient and admin; the weights are fixed; a slot marked `isCreator` follows the factory's
creator rights instead (`setCreatorFeeRecipient`, the two-step `proposeCreatorRightsTransfer` /
`acceptCreatorRightsTransfer`). The creator rights holder can also rename the token and change its URI and extra
metadata if `metadataEditable` was true.

**Token (V, `TaxLaunchToken.sol`).** Fixed supply, 18 decimals, no owner, minter, pauser or upgrade; `contractURI()`,
`extraMetadata(key)`, `name()`/`symbol()` (renamable only through the factory by the creator when editable). Clanker
documents "addresses end in `cccc`" and that v5 has no vault, airdrop or presale (V, docs; the SDK rejects those
fields).

**Chains (V, docs + SDK `addresses.ts`).** v5 is open on Base, BNB Chain, Monad, Robinhood Chain, X Layer, Arc and
Elysium; the non-Base deployments share one factory address `0xcA111dcdd2cE924c3378d6514fDCbC46217bcA16` and escrow
`0xFBB6e837A2eA96d6b4beb4788c2749Cf34A997e7` (section 11).

## 2. v4 feature → v5 mapping

| v4 (`BootrClankerLauncher`) | v5 (`BootrClankerLauncherV5`) |
| --- | --- |
| `deployToken(DeploymentConfig)` with token, pool, locker, MEV and extension configs | `createLaunch(LaunchParams)` or `createLaunchAndBuy(LaunchParams, LaunchBuyParams)`; one struct, the pool and the liquidity are Clanker's |
| Standard preset 5 / 65 / 30 of the LP fee, Buyback 5 / 50 / 15 / 30 | Same preset numbers. Standard: three fee slots with weights 500 / 6500 / 3000, `burnAllocationShare 0`. Buyback: `burnAllocationShare = 15%` of the post-Clanker tax, three slots renormalised over the other 85%: `floor(bps × 10,000 / 8,500)` = 588 / 5882 / 3529, the 1-bps rounding gap to the creator (5883), so the platform never gets more than its stated share: agent 4.998%, creator 50.006%, platform 29.997% of the slot pool |
| Agent, creator, platform slots in WETH (`FeeIn.Paired`), burn slot `0xdEaD` in the coin (`FeeIn.Clanker`, a conversion swap by the locker) | Slots paid in the quote (native ETH) on buys and sells alike; the burn is Clanker's `burnAllocationShare`, taken in the coin by the hook itself, no slot, no conversion swap |
| `rewardAdmins[i] = launcher`, `tokenAdmin = launcher`, no update path | `feeSlots[i].admin = launcher`, no `isCreator`, `creator = launcher` (rights holder), `metadataEditable = false`, no update path: recipients, weights, name, image and metadata are frozen as before |
| `lpFeeBps` (10,000 = 1%), trader pays `lpFee × 1.2` | `LaunchDefaults.lpFeeBps` keeps its name and unit (hundredths of a bip) but is **the tax**: 15,000 = 1.5%, the trader pays exactly that; buy and sell taxes are equal |
| `platformLpFeeBps` for the treasury's own coins | `platformTaxBps`, same mechanism |
| Dev buy `ClankerUniv4EthDevBuy` extension, coins to the creator | `createLaunchAndBuy` with the one-hop route, coins arrive on the wrapper and are forwarded to the creator in the same transaction |
| Sniper protection: `ClankerSniperAuctionV2` module, owner-settable | Clanker's anti-snipe fee (99% → tax over 20 s, policy-set); `antiSnipeEnabled` on, owner-settable |
| Image and metadata: `TokenConfig.image / metadata / context` | `tokenContractURI = metadata`, extra metadata keys `image`, `metadata`, `context` |
| `AgentLaunched(token, kernel, creator, burner, agentId, defaults, workerHash, model, agentURI, supervisorSessionKey)` | Identical signature; `burner = 0x…dEaD` on the buyback preset (the burn share's sink, as on v4), `address(0)` on the standard preset; there is no burn recipient contract and no dead-address fee slot |
| `ClankerLaunched(token, poolId, hook, locker, mevModule, startingTick, lpFeeBps)` | `ClankerV5Launched(token, poolId, hook, feeEscrow, quoteToken, tickSpacing, taxBps, antiSnipe)`; the opening tick is in the PoolManager's `Initialize` log of the same receipt |
| `LaunchContext`, `LaunchFeePaid` | Unchanged |
| Launch gate: `gate.registerAgent(kernel, token, creator, dormancy)` | Unchanged; the v5 launcher is added to the gate's allowlist beside the v4 one |
| `predictKernel(creator, salt)` | Unchanged; `predictToken(creator, p)` and `tokenInitCodeHash(p)` added for the web's salt mining |
| Opening cap ~10 ETH (`STARTING_TICK = -230400`) | Clanker's per-quote start tick, about $4k on 2026-11-10; not Bootr's choice |
| Supply 100,000,000,000 | 1,000,000,000 |
| Launch cost: Clanker 20% of the LP fee | Clanker's share of the tax (0.5% of each trade at any tax up to 5%) |

## 3. How fees reach the kernel

**Asset.** With the recommended native quote, every slot's income is **native ETH**: `FeeEscrow.owed(kernel,
address(0))` grows on every trade and `claimFor(kernel, address(0))` sends ETH to the kernel (Kernel v3.1 accepts
plain ETH; the fork test `test_kernelClaimsNativeEth` proves the path). The burn is `owed(0xdEaD, coin)`, finalised by
anyone with `claimFor(0xdEaD, coin)`. With a USDC quote the slots would receive USDC instead (section 9 compares the
two).

**Agent treasury turn (`apps/supervisor`, not changed by this task).** The claim is one call, not two: there is no
collection step (v4 needed `collectRewards(token)` before `claim`). The `claims` session rule for a v5 coin is
exactly one `BootrCallPolicy` rule:

| Field | Value |
| --- | --- |
| `target` | `FeeEscrow` `0x5dd237d1f716C65426CCd2FAe82B95109825FA61` (Base) |
| `selector` | `claimFor(address,address)` = `0xb4ba9e11` |
| `windowSeconds` | 0 |
| `args` | `[{index: 0, op: EQUAL, value: pad(kernel)}]` (word 0 = `recipient`, pinned to the kernel; the currency is free: whatever it is, the payee is the kernel) |

`session-rules.ts` gets a third branch in `claimsProvider` keyed on `layout.source === 'clanker-v5'` (one spec,
label `claims.claimFor`), `CALL_POLICY_RULES_VERSION` 5 for that layout, and `SessionRuleInputs.feeLocker` holds
the escrow for v5 agents (`lpLocker` unused). Because the rule set has one claim rule instead of two,
`FUNDING_RULE_INDEX` shifts for v5 policies (3 instead of 4): the funding rule index must come from the layout, as
`fundingRuleIndex` already does for the legacy layout. `treasury.ts` reads `owed(kernel, address(0))` as `settled`
(pending is 0, like v4) and the claim op encodes `claimFor`. `chain.ts` `launchSources` gains `'clanker-v5'` and
`onboarding.ts` maps the new launcher address (`BOOTR_CLANKER_V5_LAUNCHER_ADDRESS`) to it; the poller follows the
third launcher.

**ETH, not WETH, on the kernel.** Today the fee share arrives as WETH and the treasury loop is `WETH.withdraw` for
gas and `WETH.approve(swapHelper)` + `swapWethToUsdc` for fuel. ETH on the kernel is gas by itself (Kernel pays its
userOp prefund from its own balance), so `fund_gas` becomes a no-op for v5 agents. Turning fee ETH into USDC needs a
value-carrying call (`WETH.deposit{value}` or a payable swap-helper entry) and `BootrCallPolicy` rejects every call
with `value != 0` by design, so until `BootrCallPolicy` v2 (STATUS item 4) allows value on one named rule, a v5
agent's fee ETH is gas only and its fuel comes from the creator's USDC as today. The agent slot is 5% of the tax,
so at 1.5% tax a coin needs about $67k of volume for $50 of agent ETH; the simplification outweighs the delay.

**Creator and platform.** `claimFor(creator, address(0))` / `claimFor(platformRecipient, address(0))` from any
wallet; the coin page's and the console's claim buttons change target, selector and asset (section 7). The escrow
balance is per recipient across every v5 coin, so a creator with several v5 coins claims them in one call (as with
v4's fee locker).

**Indexer.** Section 5.

## 4. Slot arithmetic (owner decision 1: the tax rate)

Per $100,000 of volume, buys and sells alike (both taxes are equal). Clanker's share is `max(10% of the tax, 0.5% of
the trade)` capped at 1% of the trade, so it is $500 for every tax rate between 1% and 5%. Slots get `tax − 0.5%`.

| Tax | Trader pays | Clanker | Slots | Standard: agent 5 / creator 65 / platform 30 | Buyback: agent 5 / creator 50 / burn 15 / platform 30 |
| --- | --- | --- | --- | --- | --- |
| 1.2% | $1,200 | $500 | $700 | $35 / $455 / $210 | $35 / $350 / $105 (coin) / $210 |
| **1.5%** | $1,500 | $500 | $1,000 | $50 / $650 / $300 | $50 / $500 / $150 (coin) / $300 |
| 2.0% | $2,000 | $500 | $1,500 | $75 / $975 / $450 | $75 / $750 / $225 (coin) / $450 |
| today, v4 1% LP fee | $1,200 | $200 | $1,000 | $50 / $650 / $300 | stated $50 / $500 / $150 / $300; on sells the platform takes up to the burn's 15 points from the agent and the creator |
| Clanker's own v5 default (1%) | $1,000 | $500 | $500 | 100% to the deployer | — |
| RWAGMI path (1%) | $1,000 | RWAGMI $100 | $900 | $45 / $585 / $270 | $45 / $450 / $135 / $270 |

Where it sits in the indexer (section 5): `lpFeeBps` = tax (15,000 at 1.5%), `protocolBps` = Clanker's share of the
tax in bps (3,333 at 1.5%, 4,167 at 1.2%, 2,500 at 2%), the four slot kinds share `10,000 − protocolBps`.

**Recommendation: 1.5%.** It gives every slot exactly today's income per dollar of volume ($1,000 per $100k), which
is what the fee tables, the skill and the launch form already promise; the trader pays 0.3 points more than on v4
(1.5% against 1.2%) and 0.5 more than on RWAGMI. 1.2% keeps the trader's cost where it is but cuts every slot by 30%
(the agent slot to $35 per $100k) because Clanker's floor takes $500 of it either way. 2% pays the slots 50% more but
is twice Clanker's own default and would be the highest fee in Bootr's table; worth revisiting only if the owner
wants the platform slot to carry more. Built as a parameter: the tax is `LaunchDefaults.lpFeeBps` of each preset,
set at deploy (`TAX_BPS`, default 15,000) and changeable for future launches with `setDefaults`, bounded on-chain to
[10,000, 30,000] (Clanker's 1% floor; Bootr's own 3% ceiling, `MAX_TAX_BPS`) and by Clanker's bounds at launch.

## 5. The burn slot on v5

v5 has no burn recipient slot: the burn is `TaxConfiguration.burnAllocationShare`, a share of the post-Clanker tax
that the hook takes **in the launched token on both sides** of every trade (`_afterSwap`: `burnFee` is minted to the
escrow as a claim on the coin and credited to `0x000…dEaD`, `BurnTaxCredited`). The coins leave circulation when
anyone calls `FeeEscrow.claimFor(0xdEaD, coin)`; the indexer counts that claim as the burn (as it counts the v4
`ClaimTokens` of the dead address today). Bootr's `BuybackBurner` stays on the RWAGMI path only. Because the burn is
taken in the coin by the hook and the three paid slots receive exact weights of the quote part, nothing is converted
and no slot can be over-credited: the v4 problem (the fee-conversion locker swapping the burn slot's quote share into
the coin and handing the rounding to the last slot) does not exist on v5. The fork test `test_sellSideSplitBuyback`
swaps both ways and checks each slot's escrow balance against `creatorAmount × weight / 10,000` to the wei, and the
platform against at most 30% of the slot pool including the burn.

## 6. Indexer

New `token.source` value **`clanker-v5`** (`LaunchSource = 'bootr' | 'clanker' | 'clanker-v5'`,
`SLOTS_BPS_TOTAL['clanker-v5']` = `10,000 − protocolBps`, so the five bps columns sum to 10,000 like the RWAGMI
path: Clanker's share is inside the tax, not on top). The launcher list stays one variable: `BOOTR_CLANKER_LAUNCHERS`
gains `0x<v5 launcher>@<deploy block>`; the Ponder source `BootrClankerLauncher` takes the whole list with a merged
ABI (v4 events plus `ClankerV5Launched`), and the `AgentLaunched` handler tells the two apart by which launch event
the receipt carries. Sources added: `ClankerV5Hook` (`CreatorTaxCredited`, `BurnTaxCredited`) and `ClankerV5FeeEscrow`
(`Claimed`), both public contracts whose events of coins that are not ours are dropped, like the v4 lockers.

| Event | Handler |
| --- | --- |
| `BootrClankerLauncher.AgentLaunched` + `ClankerV5Launched` in the receipt | token / agent / `feeSlot` rows: slots from the hook's `FeeSlotCreated` logs (`poolFeeSlots(poolId)` as fallback) plus a synthetic burn slot (`recipient 0xdEaD`, bps from `defaults.burnBps`) when the preset burns; `lpFeeBps` = tax; `protocolBps` = `floor(protocolRate / tax × 10,000)`; `pool` row from the PoolManager's `Initialize` log (fee 0, tick spacing, hook, `currency0 = 0x0` for ETH); `clankerPool.version = 5`; the dev buy's `Swap`, transfers and fuel replayed as today |
| `ClankerV5Hook.CreatorTaxCredited(poolId, recipient, currency, amount)` | `feeAccrual` + `feeCredit`, `feeBalance.accrued = settled` (claimable at once), per-kind rollups; the kind from the `feeSlot` row of that recipient |
| `ClankerV5Hook.BurnTaxCredited(poolId, token, sink, amount)` | the burn slot's accrual in the coin (`asset = token`, recipient `0xdEaD`) |
| `ClankerV5FeeEscrow.Claimed(recipient, currency, destination, amount)` | `recordClaim(…, source 'clanker-v5')`: split over the recipient's `feeBalance` rows of v5 coins only; a dead-address claim of the coin is a `burn` row and `token.burnedTotal` |
| `PoolManager.Swap` | unchanged; `swapFeePips('clanker-v5', fee, lpFeeBps)` = the tax (pool fee is 0, nothing on top); the gross fee is booked per trade as on v4 |

`assetUsd` learns `address(0)` (native ETH at ETH/USD) and USDC (6 decimals, $1); `/treasury/:kernel` reads
`FeeEscrow.owed(recipient, address(0))` for v5 coins (the burn slot `owed(0xdEaD, coin)`), `pending` 0, `symbol`
`ETH`; `/token/:id/fees`, `/platform/fees` (`bySource` gains `clanker-v5`), `/tokens/list` (`source` filter accepts
the new value) keep their shapes. **Claim cross-booking fix** (found 2026-11-08): `recordClaim` takes the locker's
source from its handler (`'bootr'` for `QuoteRewardsClaimedV3`, `'clanker'` for `ClaimTokens` /
`ClaimTokensPermissioned`, `'clanker-v5'` for `Claimed`) and drops the `feeBalance` rows whose coin is from another
source before `allocateClaim`, so a Clanker claim is no longer pro-rated over RWAGMI coins of the same wallet (the
claim at block 54656132, tx `0xdb1d0914…`, came out 0.000393 WETH short on $BOOTR because FORK's unclaimed RWAGMI WETH
sat in the same group). `src/lib/fees.test.ts` covers the selection. Everything here is indexing code: one schema
bump, `DATABASE_SCHEMA=bootr_v9` (section 10).

Built 2026-11-10 as above, with three readings the build settled: the launch handler reads the policy and the burn
share from the factory's `LaunchTaxConfigured` in the receipt (the preset and the live policy are the fallback), so
`protocolBps` follows the policy each pool was admitted under; the paid slots' rounding gap goes to the heaviest slot
(the creator's); and because `CreatorTaxCredited` names the recipient and not the slot, a wallet holding two slots of
one coin (the platform launching its own coin) takes them in slot order per transaction (`pickV5Slot`). The event
topics of `CreatorTaxCredited`, `FeeSlotCreated` and the escrow's `Claimed` were checked against Base logs.

## 7. What the web task must change (after this one)

- `lib/types.ts` `LaunchSource`, `lib/token-filters.ts` and `components/tokens/TokenFilterBar.tsx` (the `source`
  filter), `lib/fee-split.ts` (`launcherPct`, `traderPaysPct`, `slotsBps`, `launcherName` keyed on the source:
  for `clanker-v5` the trader pays the tax, Clanker's share is inside it, slots total `10,000 − protocolBps`),
  `lib/server/catalog.ts`, `lib/mock.ts` (a v5 coin), `e2e/clanker.spec.ts`.
- Copy that says "1% LP fee" / "Clanker adds 20% on top" / "1.2%": `components/docs/content.ts` (the launch
  comparison, the fee table, "Fee math and claims"), `lib/docs/markdown.ts`, `lib/skill/skill-md.ts`
  (`CLANKER_PATH` fee model, `launchThrough` values, the launcher table), `components/token/FeeSplit.tsx`,
  `ClankerFeeLine.tsx`, `components/console/PlatformFees.tsx`, `components/analytics/AnalyticsView.tsx`. New copy:
  "a 1.5% tax on every trade; Clanker keeps 0.5% of the trade, the rest goes to the agent, you and the platform
  (and the burn)".
- Launch form (`components/launch/LaunchForm.tsx`, `lib/launch.ts`, `app/api/launch/draft/route.ts`,
  `app/api/agent/launch/route.ts`, `lib/server/launch-drafts.ts`): `launchThrough: 'clanker-v5'` (or the Clanker card
  simply moves to v5), the transaction goes to `NEXT_PUBLIC_CLANKER_V5_LAUNCHER_ADDRESS` (`lib/env.ts`,
  `lib/contracts.ts`) with the same `LaunchParams`, **the salt is mined** before signing: read
  `launcher.tokenInitCodeHash(params)` once, then increment `salt` until
  `create2(tokenDeployer, keccak(launcher, keccak(creator, salt)), hash)` ends in `cccc` (clanker-sdk `vanity.ts`
  is the reference; `launcher.predictToken(creator, params)` checks the result on-chain); the preset text shows the
  tax; the opening cap line reads Clanker's start tick (about $4k today) instead of "about 10 ETH"; supply 1 B.
- Claims: `lib/use-clanker-fees.ts`, `lib/server/claim.ts`, `components/profile/ClankerCreatorFees.tsx`,
  `app/api/agent/claim/[id]/route.ts`: for v5 coins the target is the `FeeEscrow`, the read `owed(owner,
  address(0))`, the write `claimFor(owner, address(0))`, the asset ETH (new `lib/abi/feeEscrow.ts`).
- Swap panel (`lib/swap/core.ts`, `use-swap.ts`, `quote.ts`, `mock.ts`, tests): v5 pool key `fee 0`, the v5 hook,
  `currency0 = address(0)` (native ETH in and out: the Universal Router settles native with `msg.value`), the tax
  shown as the fee, exact-output disabled and a 99% → tax surcharge in the first 20 s after launch (show "trading
  opens in n s" rather than letting a buy pay the sniper fee), and `pairedToken = 0x000…0` on the token row.
- `lib/coin-links.ts` (clanker.world link unchanged), `lib/agent-card.ts` if it names the fee.

## 8. Migration plan and runbook

**Contracts (this task).** `packages/contracts/src/BootrClankerLauncherV5.sol`, `src/interfaces/IClankerV5.sol`,
`script/DeployClankerLauncherV5.s.sol`, `test/fork/ClankerV5Fork.t.sol`, `test/unit/ClankerLauncherV5.t.sol`,
`packages/shared/src/addresses.ts` (`clankerV5` block, `bootr.clankerLauncherV5`).

**Deploy order (the owner signs every transaction; nothing here is automated).**

1. Rehearse on a fork the day of the deploy: `cd packages/contracts && BASE_RPC_URL=<rpc> forge test --match-path
   'test/fork/ClankerV5Fork.t.sol' -vv` (stock `forge` is enough: nothing here touches the B20 precompiles). The suite
   reads the live policy (`taxPolicy`, `quoteConfig(address(0))`, `launchCreationEnabled`, `launchBuyAdapter`) and
   fails if Clanker changed something the launcher assumes.
2. Deploy: from `packages/contracts`,
   `PRIVATE_KEY=<deployer> PLATFORM_ADMIN=0x2C97C20FAD740cCf60d4Eeb54260F3BFE899D9b3 OLD_CLANKER_LAUNCHER=0x387f1B0aC128D534E822c344D829645336BDAbbB TAX_BPS=15000 forge script script/DeployClankerLauncherV5.s.sol --rpc-url base -vvv`
   (dry run), then the same with `--broadcast --verify --verifier sourcify`. The script copies both presets,
   `minPlatformBps` and the launch fee from the live v4 launcher, replaces each preset's fee with `TAX_BPS`, sets
   `PLATFORM_TAX_BPS` if given (the $BOOTR-style 2% rule, default off), and hands ownership to `PLATFORM_ADMIN`
   (`acceptOwnership` is the admin's first transaction). It never calls the gate.
3. Read back: `cast call <v5> 'standardDefaults()'`, `buybackDefaults()`, `quoteToken()` (`0x000…0`),
   `antiSnipe()`, `owner()`/`pendingOwner()`.
4. Register on the gate, from the admin wallet: `cast send 0x7ddaf2A1FC0861B288c7b0BDfA8314621C47c3a5
   'addLauncher(address)' <v5> --rpc-url base --private-key <admin>` (until then every v5 launch reverts
   `NotLauncher`, the intended order). Then `acceptOwnership()` on the v5 launcher.
5. The burn-preset decision (section 9): `cast send 0x387f1B0a…AbbB 'pause()'` from the admin if v4 is to stop.
6. Indexer: set `BOOTR_CLANKER_LAUNCHERS=0x387f1B0aC128D534E822c344D829645336BDAbbB@53503025,<v5>@<its deploy block>`
   and `DATABASE_SCHEMA=bootr_v9` in Coolify (backup first, `docs/deploy/coolify.md` section 6; about 13 minutes of
   backfill during which the site shows stale data; `/ready` answers 503 meanwhile), supervisor
   `BOOTR_CLANKER_V5_LAUNCHER_ADDRESS=<v5>` (once the supervisor task lands), web
   `NEXT_PUBLIC_CLANKER_V5_LAUNCHER_ADDRESS=<v5>` (a `NEXT_PUBLIC_*` change rebuilds the web image). Record the address
   and the deploy block in `packages/shared/src/addresses.ts`, `.env.mainnet.example`, `docs/deploy/mainnet.md`.
7. First launch: a Bootr-owned test coin through the console; check `FeeSlotCreated` on the hook, `owed` growing
   after a trade, `claimFor(kernel, 0x0)` landing ETH on the kernel, the coin on clanker.world
   (`POST https://www.clanker.world/api/tokens/index-by-address` as for v4).

**Owner decision 2: the burn preset meanwhile.** Today both v4 presets are open and the buyback preset mis-splits
sell-side fees (platform up, agent and creator down; Brian Brain `0xd3f0…5dac` is the live example). Options:
(a) leave v4 open for both presets until the v5 launcher is live, then `pause()` v4 (one admin transaction at
go-live) — no interim change, days of exposure; (b) hide the buyback option on the web's Clanker card now and pause
v4 at go-live — one web deploy today; (c) keep v4 unpaused next to v5 for good — no reason, two codepaths to
support. **Recommendation: (a)**, with v5 going live in the same week; the v4 launcher has no per-preset switch,
the indexer follows v4 coins forever either way, and $BOOTR (v4, buyback) is unaffected by any of this since its
slots are locked. The runbook carries both (a) and (b); (c) needs nothing.

## 9. Open points and risks

1. **Quote asset: native ETH (recommended) or USDC.** ETH keeps every v5 Bootr pool shaped like the rest of Clanker
   (clanker.world's default, the deepest routing), keeps the indexer's price math (an 18-decimal paired asset at
   ETH/USD) and makes the kernel's fee share gas without a swap; its cost is the ETH→USDC step for the agent
   (section 3) until `BootrCallPolicy` v2 allows one value-carrying rule. USDC would hand the agent its fuel
   directly and remove the swap and the Chainlink floor, but coins would be USDC pools (the trade panel, the
   indexer's `coinPriceInWeth`, `valueUsd`, `liquidityUsd` and the leaderboards all assume an 18-decimal paired
   asset priced at ETH/USD), and gas would need a USDC→WETH→ETH path (a reverse swap-helper function plus two rules).
   The wrapper takes the quote as a constructor parameter, so the choice is a deploy-time one; the indexer values
   `address(0)` and USDC fee rows correctly, but the USDC pool price math is not built.
2. **Clanker controls the tax policy and the quote ticks** and can change them for future launches
   (`setTaxPolicy`, `setQuoteStartTick`, `setLaunchCreationEnabled`). A policy change outside the launcher's bounds
   makes launches revert (`InvalidTaxConfiguration`, `StaleConfig` cannot happen: the version is read in the same
   transaction); the deploy-day fork run and `test_livePolicyMatchesAssumptions` read the live policy.
3. **Salt mining moves to the web** (section 7): a launch with an unmined salt reverts `InvalidTokenAddressSuffix`.
   `predictToken` is a view the form calls before signing; the agent API (`/api/agent/launch`) must mine too.
4. **Dev buy routing** depends on the factory's `launchBuyAdapter()` and its `SwapX` router; if Clanker unsets the
   adapter, `createLaunchAndBuy` reverts `LaunchBuyAdapterNotConfigured` and the form must offer launches without a
   dev buy (the wrapper reverts with Clanker's error; nothing is stuck).
5. **Anti-snipe window:** 20 s of up to 99% buy surcharge and no exact-output swaps. The dev buy is exempt. The web
   should not quote a buy in that window.
6. **One escrow balance per recipient across all v5 pools:** `recordClaim` pro-rates a claim over the wallet's
   Bootr v5 coins; balances from a wallet's non-Bootr v5 coins are an unattributed excess, as with v4.
7. **Opening cap is Clanker's**, about $4k today, moving with ETH/USD as Clanker updates the tick: the launch form
   should read `quoteConfig(address(0))` live rather than print a number.
8. **Creator handover** (gap list of 2026-11-05) is cheap on v5: marking the creator's slot `isCreator` with
   `creator = <human>` would let creators move their slot and rename the coin. Not built: it changes the lock
   guarantee the docs make; the owner can ask for it as a preset flag later.
9. `$BOOTR` and the two other v4 coins stay on v4 forever (slots locked); the indexer and the supervisor keep both
   paths.

## 10. Schema bump

Any change under `apps/indexer/src` (outside `src/api`), `ponder.schema.ts` or the contracts, accounts, blocks and
ordering of `ponder.config.ts` changes Ponder's build id; this work touches all three, so the deploy sets
`DATABASE_SCHEMA=bootr_v9` in Coolify before the indexer image goes out, with a Postgres backup first and about 13
minutes of backfill (`docs/deploy/coolify.md` section 2, step 4). Check it yourself before the deploy:
`git diff <live commit>..HEAD --name-only -- apps/indexer/src apps/indexer/ponder.schema.ts apps/indexer/ponder.config.ts | grep -v src/api`.

## 11. Robinhood Chain

The owner's next step after v5: launch through Clanker on Robinhood Chain as well as Base. Research only; nothing is
built. Marks as above; the research was done on 2026-11-10 from Robinhood's docs (`docs.robinhood.com/chain/*`),
Clanker's deployed-contracts page and SDK, chain explorers and the RPC, and the providers' own docs.

**The chain.**
- V Arbitrum Nitro L2 ("built on Arbitrum Dedicated Blockchains", node image `offchainlabs/nitro-node` v3.11, ArbOS
  61), settling on Ethereum with blob data availability (a rollup, not AnyTrust); Rollup `0x23A19d23…2D94`,
  SequencerInbox `0xBd0D173E…ba96` on Ethereum — https://docs.robinhood.com/chain/differences-from-ethereum ,
  https://docs.robinhood.com/chain/protocol-contracts
- V Chain id **4663** mainnet (`0x1237`, confirmed with `eth_chainId` on the public RPC), 46630 testnet —
  https://docs.robinhood.com/chain/add-network-to-wallet
- V Public RPC `https://rpc.mainnet.chain.robinhood.com` (rate-limited, "not recommended for production"), sequencer
  feed `wss://feed.mainnet.chain.robinhood.com`; also `robinhood-rpc.publicnode.com`, `robinhood.drpc.org` —
  https://docs.robinhood.com/chain/connecting , https://chainid.network/chain/4663/
- V Explorer: Blockscout `https://robinhoodchain.blockscout.com` (Etherscan does not index 4663; contract verification
  is Blockscout only, `forge --verifier blockscout`) — https://docs.blockscout.com/robinhood-api ,
  https://docs.robinhood.com/chain/deploy-smart-contracts
- V Bridge: the canonical Arbitrum bridge (`portal.arbitrum.io/bridge?destinationChain=robinhood-chain`, ~7-day
  withdrawals) plus Relay, Across, Stargate, CCIP, LiFi — https://docs.robinhood.com/chain/bridging
- V Gas token ETH; fee = L2 execution + L1 data; base fee about 0.02 gwei (RPC, 2026-11-10) —
  https://docs.robinhood.com/chain/gas-and-fees
- V 100 ms blocks (measured 0.105 s over 1,048,576 blocks); mainnet live since 2026-07-01 (newsroom; Chainlink's
  changelog dates its feeds to the same day) — https://robinhood.com/newsroom/category/crypto/ ,
  https://dev.chain.link/changelog/data-feeds-expands-to-robinhood-chain-mainnet
- V Single sequencer, first-come-first-served; 2 permissioned BoLD validators (Offchain Labs, Alchemy); 8-seat Security
  Council (Robinhood 2 seats, BitGo, Chainlink Labs, Fireblocks, Offchain Labs, Paxos, Talos) —
  https://docs.robinhood.com/chain/governance . I: the sequencer is run by Robinhood or Offchain Labs; the docs do not
  say.
- V `block.number` returns an L1 estimate; the L2 height is `ArbSys.arbBlockNumber()` (matters for Ponder's block
  handlers and `secondsBetweenBlocks`) — https://docs.robinhood.com/chain/differences-from-ethereum
- V Permissionless deployment ("anyone can … deploy smart contracts"); transaction screening exists (a blocked
  transfer "is never processed"; TRM Labs is a partner) — https://docs.robinhood.com/chain ,
  https://docs.robinhood.com/chain/differences-from-ethereum
- V Stock Tokens are standard 18-decimal ERC-20s tradable on AMMs, minted and burned by KYB'd participants only, not
  offered to US persons; registry `GET https://api.robinhood.com/rhj/assets` —
  https://docs.robinhood.com/chain/stock-tokens , https://docs.robinhood.com/chain/building-with-stock-tokens
- V The chain pays 10% of net revenue to the Arbitrum DAO (AEP) —
  https://forum.arbitrum.foundation/t/arbitrumdao-factsheet-robinhood-chain-mainnet-launch/31041

**Clanker v5 there.**
- V Clanker v5 is open on Robinhood Chain; deployed 2026-11-05, first block 106,650,212. Addresses: Factory
  `0xcA111dcdd2cE924c3378d6514fDCbC46217bcA16`, Hook `0x565189a6780D1a50FC1792F64db8e4881119AaCC`, FeeEscrow
  `0xFBB6e837A2eA96d6b4beb4788c2749Cf34A997e7`, Token Deployer `0xE76c413b26c7006CF3ac747b46A8F05E0Ccf3287`, Launch
  Buy Adapter `0xB23DCEC5F77abC6185c6a1535F1662A37e578689`, Launch Operations `0x533179dF…a967`, Launch Validation
  `0xCB453072…4288`, Announcement Registry `0x2D75afC0…a43A`, dividend contracts `0xffe2627E…6723` /
  `0xdb525d50…2B49` / `0x4305A185…Ed95` — https://clanker.gitbook.io/documentation/references/deployed-contracts ,
  clanker-sdk `src/v5/addresses.ts` (4663). The factory has 23,776 bytes of code on chain (RPC `eth_getCode`).
  U: the Robinhood deployment is the same source as Base's (the SDK and docs name the same contract set; the Robinhood
  factory's verified source was not read).
- V Clanker v4.1 is also deployed there (Clanker `0xD3f2cC17…9A94`, ClankerFeeLocker `0x88db2340…d70c`,
  ClankerLpLockerFeeConversion `0xE4910b09…4A09`, hooks, vault, airdrop, dev buy) — same page.
- V SDK chain table: Robinhood Chain 4663, native quote ETH, stable quote **USDG** (6 decimals), 0.01% V3 fee for the
  stable dev-buy route — https://raw.githubusercontent.com/clanker-devco/clanker-sdk/main/docs/v5.md ,
  `src/v5/routes.ts` `STABLE_ROUTES[4663] = USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- U clanker.world's deploy page shows a chain selector for Robinhood (the home copy says "Base, BNB Chain, Monad, and
  more"; the page is rendered client-side and was not driven).
- V Bankr launches on Robinhood Chain by default through **Doppler**, not Clanker; stock-paired launches exist there —
  https://docs.bankr.bot/token-launching/overview

**USDC and WETH.**
- V No Circle USDC on Robinhood Chain (absent from Circle's address list; Relay's chain config lists only USDG as an
  ERC-20 for 4663) — https://developers.circle.com/stablecoins/usdc-contract-addresses , https://api.relay.link/chains .
  U: a bridged USDC.e may exist (Chainlink publishes a USDC/USD feed there), no address found; do not assume one.
- V USDG (Paxos Global Dollar) `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals, is the chain's stablecoin —
  https://docs.robinhood.com/chain/contracts
- V WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (not the OP predeploy address) —
  https://docs.robinhood.com/chain/protocol-contracts
- I The natural Clanker pair there is native ETH (Clanker's default) with USDG as the stable alternative.

**Bootr's stack assumptions.**
- V ERC-4337 EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` deployed (16,035 bytes of code); "Account
  abstraction on Robinhood Chain is powered by Alchemy, with ZeroDev available as an alternative"; the docs' example
  uses Kernel v3.1 — https://docs.robinhood.com/chain/account-abstraction
- V ZeroDev lists Robinhood (4663) and its testnet as supported; Kernel v3.1 implementation `0xBAC849bB…4b4D`,
  meta-factory `0xd703aaE7…42d5` and the ECDSA validator `0x845ADb2C…cE57` have code at their canonical addresses
  (RPC `eth_getCode`) — https://docs.zerodev.app/api-and-toolings/faqs/chains ,
  https://www.zerodev.app/blogs/zerodev-is-live-on-robinhood-chain . U: `BootrCallPolicy` is Bootr's own module and
  must be deployed there; the ZeroDev policies Bootr does not use were not checked.
- V Bundlers and paymasters: Pimlico (v0.6/0.7/0.8, bundler and paymaster) and Alchemy (bundler, gas manager) support
  4663 — https://docs.pimlico.io/guides/supported-chains , https://www.alchemy.com/docs/wallets/supported-chains.md
- V **Coinbase CDP does not**: Paymaster/Bundler and Node RPC are Base only, the x402 facilitator lists Base, Base
  Sepolia, Polygon, Arbitrum, Monad, World and Solana — https://docs.cdp.coinbase.com/paymaster/introduction/welcome.md ,
  https://docs.cdp.coinbase.com/node/introduction/welcome , https://docs.cdp.coinbase.com/x402/network-support
- V Chainlink ETH/USD on Robinhood mainnet: proxy `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, 8 decimals, 0.5%
  deviation, 24 h heartbeat (`latestRoundData` answered 2,125.61 on 2026-11-10); USDG/USD `0x61B7e565…9aD2`,
  USDC/USD `0x9e6f4605…2546`, 40+ Robinhood stock feeds; Data Streams verifier `0xcE73c8ad…36E7` —
  https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json (the feed directory behind
  docs.chain.link), https://docs.robinhood.com/chain/oracles-and-price-feeds , https://docs.robinhood.com/chain/data-streams .
  Pyth is deployed too (`0x8250f4aF…487a`) — https://docs.pyth.network/price-feeds/contract-addresses/evm
- V Uniswap v4 on 4663: PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`, Universal Router
  `0x8876789976decbfcbbbe364623c63652db8c0904`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`, Quoter
  `0x8dc178ef…8f94`, StateView `0xf3334192…673b`, PositionManager `0x58daec31…4fa7` —
  https://developers.uniswap.org/docs/protocols/v4/deployments
- V **x402 inference: none on Robinhood Chain.** BlockRun settles in USDC on Base, Solana, Arc and through Circle
  Gateway; the CDP facilitator does not list 4663 — https://blockrun.ai/x402 , https://blockrun.ai/docs/x402/how-it-works .
  U: a third-party `hood402-facilitator` npm package claims USDG settlement on Robinhood. I: a Robinhood agent still
  buys its thoughts with Base USDC (the spender stays on Base, funded across the bridge or from Base fees).
- V RPC with `eth_getLogs` for the indexer: Alchemy (`robinhood-mainnet.g.alchemy.com`; free tier 10 blocks per
  `eth_getLogs`, paid tiers unlimited, 150 MB response cap, no trace API), QuickNode (archive), Chainstack, dRPC; the
  public RPC answered an address-filtered `eth_getLogs` over ~3.7 M blocks without a range error but is rate-limited
  and "use an archive endpoint for historical reads"; Blockscout's API caps at 1,000 records —
  https://www.alchemy.com/docs/chains/robinhood-chain/robinhood-chain-api-endpoints/eth-get-logs ,
  https://www.quicknode.com/docs/robinhood , https://docs.chainstack.com/docs/robinhood-tooling ,
  https://docs.robinhood.com/chain/connecting
- U RedStone / API3 presence, Ankr support, who legally operates the sequencer: not found.

**What in Bootr is Base-only today.**

| Piece | Where | What binds it to Base |
| --- | --- | --- |
| Address book | `packages/shared/src/addresses.ts` | `SupportedChainId = 8453 \| 84532`, one `ChainAddresses` per id; RWAGMI, Clanker, Uniswap, ZeroDev, ERC-8004 and Bootr contracts per chain |
| Contracts | `packages/contracts/script/*.s.sol` (`chainConfig()` reverts off 8453/84532), fork tests pinned to Base addresses; `AgentGuardian`, `BootrLaunchGate`, `BootrCallPolicy`, `BootrSwapHelper` (Uniswap v3 SwapRouter02 + Chainlink ETH/USD) all deployed once on Base | redeploy per chain; the swap helper needs that chain's v3 router and feed |
| Indexer | `apps/indexer/ponder.config.ts` (one chain per process, `CHAIN_ID` 8453 or 84532, `chainName base \| baseSepolia`), `src/lib/env.ts` (`CHAINLINK_ETH_USD`, `RWAGMI_V3`, `CLANKER_V4` maps keyed by chain id, `PUBLIC_RPC`), `src/lib/blocks.ts` (Base's two block times, the Denim fork block), `rpc-budget.ts` (CDP billing units) | per-chain constants and the block-time model |
| Supervisor | `apps/supervisor/src/chain.ts` (`chainId`, one viem client, the launcher list), `session-key.ts` / `session-rules.ts` (policy and helper addresses), `treasury.ts`, `gas.ts`, `blockrun.ts` (x402 on Base USDC), bundler URL (CDP) | one chain per process; CDP bundler and x402 facilitator are Base-only |
| Sender | `apps/sender` | chain-agnostic (X only) apart from the agent id → kernel mapping |
| Inference relay | `apps/inference` | `X402_NETWORK=eip155:8453`, CDP facilitator |
| Web | `apps/web/lib/env.ts` (`NEXT_PUBLIC_CHAIN_ID`), `lib/chains.ts`, `lib/wagmi.ts` (Base Account connector), `lib/swap/*`, `lib/contracts.ts`, the skill ("Base mainnet only"), explorer and clanker.world links | one chain per build |
| Docs and copy | `docs/*`, `components/docs/content.ts`, `skill-md.ts` | "on Base" throughout |

**A staged plan (sizes are estimates).**

1. **Address book and chain model (shared, two days).** `ChainAddresses` gains `chainId`, `nativeSymbol`, `explorer`,
   `blockTimeMs`, the Clanker v5 set (`clankerV5: {factory, hook, feeEscrow, tokenDeployer, launchBuyAdapter}`), the
   stable quote (USDC on Base, USDG on Robinhood), the ETH/USD feed, bundler and paymaster kinds; a `4663` entry with
   the addresses above; `getAddresses` keeps throwing for unknown ids.
2. **Contracts on Robinhood Chain (three days + the owner's deploy).** Deploy `AgentGuardian`, `BootrLaunchGate`,
   `BootrCallPolicy`, `BootrClankerLauncherV5` (no RWAGMI path there; no `BuybackBurner`) with a `DeployRobinhood.s.sol`
   whose `chainConfig()` returns the 4663 set; `BootrSwapHelper` needs a Uniswap v3 router on 4663 (U: whether
   SwapRouter02 is deployed there; the v5 fork test's dev-buy adapter uses SwapX with a Uniswap v3 factory, which
   suggests v3 exists) and the Chainlink ETH/USD proxy above; verify on Blockscout. Fork tests run against
   `ROBINHOOD_RPC_URL`. ERC-8004: U whether the identity registry is deployed at `0x8004A169…a432` on 4663
   (`eth_getCode` first; without it the launcher's identity step needs a flag).
3. **Indexer multi-chain (four days).** Today's config is one chain per process; the cheapest path is one indexer
   process per chain (`CHAIN_ID=4663`, its own `DATABASE_SCHEMA`, its own RPC budget model since there is no CDP
   there), with `env.ts` maps gaining 4663 entries, `blocks.ts` a 100 ms block-time era, the snapshot interval in
   seconds, the ETH/USD feed, and the API answering `chainId` on every row (the web already reads `chainId` on
   tokens). A second Coolify service (`indexer-robinhood`) and host (`indexer-rh.bootr.fun`), or one host with a
   path prefix. Ponder multichain in one process is possible later (`ordering: 'multichain'` is already set) but the
   RPC budget and the schema bump rule get harder to reason about.
4. **Supervisor (a week).** The agent row gains `chainId`; one `ChainContext` per chain (client, bundler URL from
   Pimlico or Alchemy, no paymaster, Kernel addresses from the book); session-key installs and rotations per chain;
   the treasury loop per chain (fees as ETH on both; the ETH→USDC step exists on neither until policy v2); BlockRun
   stays on Base, so a Robinhood agent's spender keeps living on Base and is funded from the owner's console or a
   bridge, which is the real product question (I: agents on Robinhood earn ETH they cannot spend on thoughts without
   a bridge step).
5. **Web (three days).** A chain switch on the launch form (Base / Robinhood), `wagmi` with both chains, explorer and
   clanker.world links per chain (clanker.world shows a chain id in its URLs, U for the exact format), the trade
   panel against the right PoolManager and Universal Router, the docs and the skill saying "Base and Robinhood
   Chain".
6. **Operations (one day).** Alchemy or QuickNode keys for 4663 (RPC and bundler), Coolify variables per chain, the
   runbook. The biggest blocker is not technical: there is no x402 inference seller and no CDP on Robinhood Chain, so
   the agent economy (fees → fuel) does not close there without a bridge; the launchpad itself (launch, trade, claim)
   closes fine.
