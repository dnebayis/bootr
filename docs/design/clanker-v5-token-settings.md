# Clanker v5: creator-set token settings

Design note, 2026-11-10. Builds on [`clanker-v5-migration.md`](./clanker-v5-migration.md) (the v5 launcher as built on
branch `clanker-v5-2026-11-10`, not deployed). Today's `BootrClankerLauncherV5` fixes every token setting at launch:
three fee slots agent / creator / platform with the launcher as each slot's admin, one tax rate from the presets for
both sides, `metadataEditable: false`, native ETH as the only quote, Clanker's default anti-snipe fee. The owner wants
the creator to set the token the way Clanker's own deploy form does (tax, sniper tax, editable metadata, rewards,
paired asset). This note maps each form setting to Clanker v5, proposes the launcher's new parameters, and lists the
work. No contract code is written here.

Marks: **V** = verified against a primary source, named (the factory's verified sources on Sourcify, a live
`eth_call` on Base at block 55,591,370 on 2026-11-10, clanker-sdk `main`, clanker.world's own deploy-page bundle and
public API); **U** = unverified; **I** = inferred.

Sources: Sourcify exact match of the factory `0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0` (65 files:
`TaxLaunchpadFactoryCore.sol`, `TaxRWAERC20LaunchpadFactory.sol`, `TaxLaunchHook.sol`, `TaxFeeMath.sol`,
`TaxLaunchValidation.sol`, `TaxLaunchOperations.sol`, `TaxLaunchToken.sol`, `TaxDividend.sol`, `FeeEscrow.sol`,
`TaxSuiteConstants.sol`); `cast call` against `https://mainnet.base.org`; clanker-sdk `src/v5/config.ts`,
`src/v5/index.ts`, `src/v5/routes.ts`, `src/utils/zod-onchain.ts`, `examples/v5/*`; the deploy page
`https://www.clanker.world/deploy` (its Next.js chunks, which build the SDK config from the form); the API
`https://www.clanker.world/api/tokens` and `https://www.clanker.world/api/tax/quote-market?chainId=8453`.

## Decided by the owner (2026-11-10)

1. **Agent and platform slots are locked.** Each keeps a fixed floor, its admin stays the launcher, nobody can change
   it after launch. The creator freely splits only the rest: creator funds, holder dividends, burn, and extra reward
   recipients with their own admins (the Rewards panel).
2. **Paired assets.** Coins launched with an agent: ETH and USDC only at first. The feature stays open-ended in the
   contract and the web: an admin-set allow-list, per launch kind (agent coins now; a plain-token path, no agent,
   later, which may use the other launch-enabled assets). The plain-token path is not built.
3. **Editable metadata.** On by default. Only the creator wallet may change the image and the metadata after launch;
   name, symbol and fee recipients (agent and platform) stay locked.

RWAGMI (`BootrLauncher.sol` and its web, indexer and supervisor paths) is untouched by all of this.

## 1. Clanker's form, setting by setting

### 1.1 Tax: buy tax, sell tax, allocation

- **V (`TaxFeeMath.TaxConfiguration`)** `{buyTaxRate, sellTaxRate, creatorAllocationShare, burnAllocationShare,
  dividendAllocationShare, integratorAllocationShare, minimumDividendHolding}`, rates and shares on a 1e8 scale
  (1e8 = 100%). Buy and sell are separate rates; the shares are one split used on both sides.
- **V (live `taxPolicy()`)** bounds per side 1,000,000–10,000,000 (1%–10%), the same for buy and sell. Clanker's cut
  is `clamp(tax × 10%, 0.5%, 1%)` of the trade (`protocolTaxShare 10,000,000`, `minimumProtocolFeeRate 500,000`,
  `maximumProtocolFeeRate 1,000,000`, recipient `0x7a2E54E3…3829`), taken first; the shares divide the remainder
  (`TaxFeeMath.rates`). A side of 0% is only possible if the policy's minimum is 0; today it is 1%.
- **V** The form's footer "Per trade: 0.5% Clanker · 0.5% creator funds" is its default 1% tax: Clanker's 0.5% floor,
  the other 0.5% all to creator funds. At 1.5% it would read 0.5% Clanker · 1.0% split.
- **V (`TaxLaunchValidation`, `validateTax`)** the four shares must sum to exactly 1e8 (when a side is above zero);
  `integratorAllocationShare > 0` needs an `integratorFeeRecipient`.
- **"Creator funds" = `creatorAllocationShare`** (V): this part is paid in the quote to the fee slots by weight
  (`_creditCreatorTax`, the last slot takes the wei remainder).
- **"Burn allocation" = `burnAllocationShare`** (V): taken in the launched coin on both sides and credited in the escrow
  to `0x…dEaD` (`BurnTaxCredited`); it leaves circulation when anyone calls `claimFor(0xdEaD, coin)`.
- **"Holder dividends" = `dividendAllocationShare`** (V): taken in the quote, credited in the escrow to a per-coin
  `TaxDividend` tracker; section 4.
- **Integrator** (V): a fourth share paid to one `integratorFeeRecipient`, fixed for the pool at launch (no setter in
  the factory or hook). The deploy form does not show it; Bootr does not use it (section 2.4 says why).
- **V (deploy-page bundle)** the form refuses dividends + burn above 100% and builds
  `{buyFee, sellFee, burn, dividends: {share, minimumHolding}}` for the SDK, which turns percentages into shares with
  creator funds as the remainder (`config.ts taxLaunchParams`).

### 1.2 Sniper tax

- **V (`antiSnipeConfiguration` 99,000,000 / 20, `TaxLaunchHook._rates`, `_isSurchargeWindowActive`)** with
  `antiSnipeEnabled`, every swap in the first 20 s after launch pays a total fee falling linearly from 99% to that
  side's tax. It applies to **buys and sells alike** (the migration note said buys; the source computes it for both
  sides). The surcharge goes entirely to Clanker's protocol recipient (`AntiSnipeFeeCredited`), not to the slots.
  Exact-output swaps revert in the window (`ExactOutputDisabledDuringAntiSnipe`); the launch's own dev buy is exempt.
- **Off:** `antiSnipeEnabled = false` in `LaunchParams` (V). It is per pool and frozen at launch. Turning it on reverts
  if the policy's window is 0 (`AntiSnipeUnavailable`).

### 1.3 Editable metadata

- **V (`TaxLaunchpadFactoryCore`)** `metadataEditable` is stored in the coin's `CreatorRights` at launch and never
  changes. When true, the token's `metadataAuthority` is the factory (`TaxLaunchOperations`, part of the init code, so
  it changes the mined salt), and the factory lets **the current creator-rights holder** call `updateTokenName`,
  `updateTokenSymbol`, `updateTokenContractURI` and `updateTokenExtraMetadata(token, key, value)`
  (`_requireMetadataEditor` = `_requireCurrentCreator` + `metadataEditable`). One switch covers all four: **on v5,
  name and symbol can change whenever metadata can**, and only for whoever holds the creator rights.
- **V (SDK `index.ts`)** the SDK's `updateImage` / `updateMetadata` write the extra-metadata keys `image` and
  `metadata`; `contractURI` is a separate field (`config.ts`: `tokenContractURI: config.contractURI`, default `''`).
- **V** token events: `ExtraMetadataUpdated(updater, key, value)`, `ContractURIUpdated`, `NameUpdated`, `SymbolUpdated`.
- Consequence for decision 3: the creator cannot hold Clanker's creator rights, or they could rename the coin. The
  launcher keeps the rights and forwards only image and metadata edits for the coin's creator (section 2.5).

### 1.4 Rewards (fee slots)

- **V (`TaxLaunchHook.FeeSlotInput`, `TaxLaunchValidation._validateFeeSlots`)** `{recipient, admin,
  relativeWeightBps, isCreator}`, **1 to 7 slots** (`MAX_FEE_SLOTS = 7`, live), each weight > 0, weights sum to
  10,000, recipient and admin non-zero and not a Clanker contract, the token or its dividend tracker; at most one
  `isCreator` slot, whose admin must be the creator-rights holder and recipient the `creatorFeeRecipient`.
- **V** a slot's admin can `updateFeeSlotRecipient` and `updateFeeSlotAdmin`; weights never change; an `isCreator`
  slot follows the factory's creator-rights transfers instead.
- **V (deploy-page bundle)** the form's first row always has the caller as admin (and as recipient unless changed);
  "+ Add recipient" adds rows; rows at 0% are dropped; "Allocated: 100/100%" is the weight sum.
- Slots are paid in the **quote** asset only (SDK: "v5 rewards only support Paired").

### 1.5 Pool: paired asset

- **V (`TaxRWAERC20LaunchpadFactory`)** a quote is usable when `quoteConfig(asset).registered`; the owner registers
  and unregisters quotes (`registerQuote`, `batchRegisterQuotes`, `unregisterQuote`), the owner or `priceUpdater`
  (`0xeE9F9A1D…7C48`, live) moves each quote's start tick (`setQuoteStartTick`). There is no on-chain list: the set is
  the `QuoteRegistered` / `QuoteUnregistered` history. "Launch enabled" on clanker.world = registered and
  `launchCreationEnabled()` (V, bundle: the badge shows "Launches paused" or "Status unknown" otherwise).
- **V (clanker.world `quote-market` API, 2026-11-10)** 337 quotes on Base: native ETH; 12 ERC-20s (USDC, cbBTC,
  cbDOGE, cbXRP, cbLTC, cbADA, cbMEGA, AERO, CLANKER, BNKR, VVV, MORPHO, each confirmed registered with `quoteConfig`);
  and 324 B20 tokens (`0xb200…` addresses: the tokenized stocks and other real-world assets the factory is named for,
  U for which is which). 41 have ≥ $50k liquidity in the API. Spot checks with `quoteConfig`:
  ETH `-201000` (18 dec), USDC `-400600` (6), cbBTC `-466800` (8), AERO `-118600`, CLANKER `-150800`, BNKR `-41200`,
  VVV `-155000`, a B20 `LITEc` `-418400` (8) all registered; **WETH not registered** (ETH pools are native).
- **Opening cap per asset** (V for the ticks, I for the intent): every quote's start tick puts the 1 B supply at about
  **$3.9k–4.0k** at that day's price (ETH $3,893, USDC $4,008, cbBTC $3,966, AERO $3,915, BNKR $3,960). Clanker keeps
  the opening cap the same in dollars across assets and moves the ticks as prices move; Bootr cannot choose it.
- **Dev buy with a non-ETH quote** (V, SDK `routes.ts`): the buy is still funded in native ETH; for USDC the route is
  two hops, Uniswap v3 WETH/USDC 0.05% then the launch pool (`stableSwapXRoute`, `STABLE_ROUTES[8453]`).
- "Market details" on the form shows the asset's price, liquidity and the opening market cap from the quote-market
  API (V, bundle); it is display only.

### 1.6 The metadata JSON

- **V (bundle)** the form writes `metadata = {description, socialMediaUrls: [telegram, website, x, farcaster],
  auditUrls: []}` with platform keys `telegram`, `website`, `x`, `farcaster`; no `discord`.
- **V (clanker.world API)** Brian Brain (Bootr v4 coin, 2026-11-07) shows the description and `website` from Bootr's
  JSON although that JSON carries Bootr's extra `contractUri` key: extra keys are tolerated. Part 1 of this task (commit
  `e637414`) adds `auditUrls` and the description; the hosted document's URL stays inside.

## 2. Bootr launch params v2

### 2.1 Shape

One entry point on the v5 launcher, replacing today's preset-only `launch(LaunchParams)` on that contract:

```solidity
/// Shares are bps of the tax pool after Clanker's cut (10_000 = all of it).
struct RewardInput {
    address recipient;   // non-zero; any address the factory accepts
    address admin;       // non-zero; may not be this launcher (launcher-admin slots mean agent / platform)
    uint16 bps;          // share of the creator funds, rows sum to 10_000
}

struct TokenSettings {
    address quoteToken;          // address(0) = native ETH; must be on the allow-list for LaunchKind.Agent
    uint24 buyTaxBps;            // hundredths of a bip like LaunchDefaults.lpFeeBps: 15_000 = 1.5%
    uint24 sellTaxBps;
    uint16 burnBps;              // of the post-Clanker pool
    uint16 dividendBps;          // of the post-Clanker pool
    uint256 minDividendHolding;  // raw token units (18 decimals); 0 iff dividendBps == 0
    RewardInput[] rewards;       // the creator funds' recipients; row 0 is the creator's own row
    bool antiSnipe;
    bool metadataEditable;
    string contractURI;          // Bootr's hosted ERC-7572 document (/tokens/<launchId>.json)
}

function launch(LaunchParams calldata p, TokenSettings calldata s) external payable returns (...);
```

`LaunchParams` keeps its fields (`metadata` becomes Clanker's JSON only; `contractURI` moves to the settings, so the
token's `contractURI()` is a real URI and the `metadata` key is the JSON Clanker reads, as the SDK does). `buybackBurn`
is ignored on this entry point (the burn is `burnBps`); the indexer and the web keep reading it from `AgentLaunched`
only through `defaults.burnBps`.

### 2.2 What the contract enforces

Launcher configuration (owner, for future launches; the `standardDefaults` / `buybackDefaults` presets of the v5
launcher become one `AgentDefaults`):

| Setting | Meaning | Bound |
| --- | --- | --- |
| `agentShareBps` | the agent's slot, share of the post-Clanker pool | ≥ 500 (5%, today's number), ≤ 5,000 |
| `platformShareBps` | the platform's slot | ≥ `minPlatformBps`; `agent + platform` ≤ 5,000 |
| `platformRecipient`, `minFuelUsdc`, `dormancyPeriod`, `launchFeeWei` | as today | as today |
| `minTaxBps`, `maxTaxBps` | each side's tax | inside Clanker's policy (1%–10% today); Bootr default [10,000, 50,000] |
| `allowedQuote[kind][asset]` | paired-asset allow-list per `LaunchKind { Agent, Plain }` | `setQuoteAllowed(kind, asset, bool)`; Agent starts with ETH and USDC |
| `maxRewardRows` | creator rows | 1..5 (7 slots − agent − platform) |

Per launch (`launch(p, s)` reverts otherwise):

1. `allowedQuote[Agent][s.quoteToken]` (Clanker's own registration is checked by the factory).
2. `minTaxBps ≤ s.buyTaxBps, s.sellTaxBps ≤ maxTaxBps`.
3. `creatorFunds = 10_000 − agentShareBps − platformShareBps − s.burnBps − s.dividendBps ≥ 0`.
4. `creatorFunds > 0` ⇒ `1 ≤ rewards.length ≤ maxRewardRows`, rows sum to 10,000, every row's bps > 0, admin
   ≠ launcher; `creatorFunds == 0` ⇒ `rewards` empty.
5. `s.dividendBps > 0` ⇔ `s.minDividendHolding > 0` (Clanker checks ≥ its policy minimum, 10,000 tokens, and ≤ supply).

Clanker parameters the launcher builds:

- `creator = address(0)` (the launcher holds the creator rights, needed for decision 3), `creatorFeeRecipient =
  msg.sender`, no `isCreator` slot, `integratorAllocationShare = 0`, `integratorFeeRecipient = 0`.
- `taxConfiguration`: `buyTaxRate = buy × 100`, `sellTaxRate = sell × 100`, `burnAllocationShare = burnBps × 10,000`,
  `dividendAllocationShare = dividendBps × 10,000`, `creatorAllocationShare = 1e8 − burn − dividend` (agent + platform +
  creator funds), `minimumDividendHolding`.
- **Slots, in this order**: `[0] agent (kernel, admin launcher)`, `[1] platform (platformRecipient, admin launcher)`,
  `[2..] creator rows (recipient, admin as given)`. Weights over the slot pool `P = agent + platform + creatorFunds`:
  `w_agent = ceil(agent × 10,000 / P)` (the agent never gets less than its floor), `w_platform = floor(platform ×
  10,000 / P)` (the platform never more than its share), the rows split `10,000 − w_agent − w_platform` by their bps,
  floor each, the leftover to row 0, every weight ≥ 1 or revert. The last slot (a creator row whenever there is one)
  takes Clanker's wei remainder, so it never lands on the platform. Example, all to creator funds: P = 10,000,
  weights 500 / 3000 / 6500. Example, burn 30% and dividends 35%: P = 3,500, weights 1429 / 8571 / –, agent 5.0015%,
  platform 29.9985% of the pool.
- `metadataEditable = s.metadataEditable`; `tokenContractURI = s.contractURI`; extra metadata `image`, `metadata`,
  `context` as today. The salt is mined over these (`tokenInitCodeHash(p, s)`; `metadataEditable` changes the init code).
- `antiSnipeEnabled = s.antiSnipe`; `quoteToken = s.quoteToken`; dev buy: one hop for ETH, the two-hop v3 route for
  USDC (section 1.5).

Events: `AgentLaunched` keeps its signature (decided); its `defaults` carry the effective numbers: `lpFeeBps = buy tax`,
`agentBps`, `platformBps`, `burnBps` as enforced, `creatorBps = 10,000 − the other three` (creator funds and
dividends). `ClankerV5Launched` (not deployed yet, free to change) becomes `(token, poolId, hook, feeEscrow,
quoteToken, tickSpacing, buyTaxBps, sellTaxBps, burnBps, dividendBps, antiSnipe, metadataEditable)`; the slots are in
the hook's `FeeSlotCreated` logs and the split in the factory's `LaunchTaxConfigured`, which the indexer already reads.
Gate registration unchanged.

The launcher keeps `quoteOf[token]` (for `poolKeyFor(token)` and the supervisor) and `coinCreator[token]`.

### 2.3 Recommended defaults

| Setting | Default | Why |
| --- | --- | --- |
| Buy / sell tax | 1.5% / 1.5% | Clanker's floor takes 0.5% of every trade at any tax up to 5%; 1.5% keeps every Bootr slot at today's income per dollar of volume (migration note section 4). The form shows Clanker's 1% as the low end and says what it costs the agent. |
| Agent share | 5% of the pool | Today's number on every path; it is the agent's thinking budget. |
| Platform share | 30% of the pool | Today's number. |
| Creator funds / dividends / burn | 65% / 0 / 0 | Like today's standard preset. Dividends cost every holder gas and send their share to Clanker when nobody qualifies (section 4); burn is one click away. |
| Rewards | one row: the creator, admin the creator | The creator can redirect or hand over their own slot on Clanker's hook without Bootr. |
| Sniper tax | on | Clanker's default; the 20 s window keeps bots from taking the first block. The creator may switch it off. |
| Editable metadata | on (decided) | Lets the creator fix the image and links after launch. |
| Paired asset | ETH | The agent's fee share is gas at once; deepest routing; the indexer's price math exists. |
| Dividend minimum | Clanker's policy minimum (10,000 coins) | Smallest that Clanker accepts; 0.001% of supply. |

### 2.4 Why the platform is a slot and not Clanker's integrator share

The integrator share would pay the platform exactly, with no weight rounding, and clanker.world would label it. It is
not used because (a) decision 1 names slots; (b) the integrator recipient is fixed per pool with no setter at all,
where a launcher-admin slot is equally locked; (c) one model for agent and platform keeps the indexer's slot code;
(d) the integrator share stays 0 and is not a creator input, so there is no hidden extra recipient.

### 2.5 After launch, who may change what

| What | Who | How |
| --- | --- | --- |
| Agent slot, platform slot (recipient, admin) | nobody | admin = launcher, no function forwards to `updateFeeSlot*` |
| Creator's row and extra rows (recipient, admin) | that row's admin | Clanker's hook directly: `updateFeeSlotRecipient` / `updateFeeSlotAdmin` |
| Weights, tax rates, shares, quote, sniper tax | nobody | frozen per pool by Clanker |
| Image (`image` key), metadata JSON (`metadata` key) | `coinCreator[token]` while editable | launcher `updateImage(token, url)` / `updateMetadata(token, json)` → `factory.updateTokenExtraMetadata` |
| Editability | `coinCreator[token]`, one way | launcher `lockMetadata(token)`: the launcher's own per-coin flag (Clanker's flag cannot change) |
| Name, symbol, `contractURI` | nobody | the launcher never forwards `updateTokenName` / `updateTokenSymbol` / `updateTokenContractURI` |
| Creator rights at Clanker | the launcher, forever | no `proposeCreatorRightsTransfer` / `setCreatorFeeRecipient` forwarder |
| Dividend exclusions, emergency withdrawal of dividend backing | Clanker's owner / creator admin (`0x87f4aa83…aF15`) | not Bootr's (section 4) |
| `coinCreator` handover | open question 4 | — |

The launcher stays non-upgradeable (it holds every coin's creator rights and is the admin of the locked slots: an
upgradeable launcher would make "locked" depend on an admin key). Versions keep going through the gate's allow-list.

## 3. What each paired asset means for Bootr

| | ETH (native) | USDC | Any other asset (later, plain tokens only) |
| --- | --- | --- | --- |
| Agent fees | `owed(kernel, 0x0)`, claimed as ETH | `owed(kernel, USDC)`, claimed as USDC | `owed(kernel, asset)` |
| Claim rule `claimFor(kernel, *)` | fine (currency free, recipient pinned) | fine | fine |
| Fuel (x402 thoughts, paid in USDC) | no: ETH → USDC needs a value-carrying call that `BootrCallPolicy` refuses until policy v2; fuel stays the creator's USDC | **yes, directly**: claimed USDC lands on the kernel and funds the spender under the windowed cap | no, and no swap the policy allows |
| Gas (self-funded kernels) | **yes, directly** (ETH on the kernel pays the prefund; `fund_gas` is a no-op) | no: gas is the creator's tank plus "Add gas" until a USDC → ETH rule exists | no |
| Supervisor treasury read | `owed(kernel, 0x0)` (built) | `owed(kernel, USDC)`, a 6-decimal USD figure; the note text per asset | — |
| Indexer price | built (`coinPriceInWeth` × Chainlink ETH/USD) | new: coin price in USDC from the pool (6 decimals), USD = 1 (or Chainlink USDC/USD); fee rows already value USDC | needs a USD price per asset (an oracle, a pool against ETH or USDC, or Clanker's quote-market API, U for terms) |
| Web trade panel | built (native in/out, `msg.value`) | new: USDC in (Permit2 approval) and ETH → USDC → coin as a two-hop route | per-asset routing |
| Dev buy | one hop | two hops (v3 WETH/USDC 0.05%) | depends on the asset's pools |

**Recommendation (matches decision 2): ETH and USDC for agent coins.** ETH is the default (gas, routing, built). USDC is
the agent-friendly option: its fee share is fuel without any new rule, at the cost of gas coming from the creator; the
form says so in one line ("Fees arrive in USDC: the agent's thinking is paid from them; gas still comes from you").
Nothing else for agent coins: the call policy has no swap for any other asset, so the agent's fee share would be
neither fuel nor gas, and the indexer and trade panel have no price or route for them.

**The plain-token path later** (not built): a `launchPlain(LaunchParams-like, TokenSettings)` without kernel, identity,
fuel or gate registration; slots without an agent row (platform floor still enforced); `allowedQuote[Plain][asset]`
opened to more of Clanker's list; a new event (no `AgentLaunched`); the indexer prices other quotes (per-asset USD
source) and treats a coin without a kernel; the trade panel routes through the quote's own pools; the web gets a "no
agent" switch. The allow-list per kind keeps the agent rule (ETH, USDC) independent of what plain tokens may use.

## 4. Holder dividends on v5

- **How (V, `TaxDividend.sol`, `TaxLaunchToken`):** a coin launched with `dividendAllocationShare > 0` gets its own
  tracker (cloned by `TaxDividendDeployer`, owner = the factory). Every token transfer calls `tracker.setShare(from,
  balance)` and `setShare(to, balance)`; a holder's share is its balance when at least `minimumDividendHolding`, else 0.
  Each trade's dividend part is credited in the escrow to the tracker (`DividendTaxCredited`) and spread over all
  shares (reward-debt accounting). Paid in the **quote asset** (ETH pools: native ETH, held as WETH inside and unwrapped
  on withdrawal; USDC pools: USDC). A holder claims itself (`withdrawDividends()`, or `claimDividends([...])` on the
  claim helper, both only for `msg.sender`); nothing is pushed.
- **Who is excluded (V):** the zero and dead addresses, the tracker, the token, the factory, the hook, the escrow, the
  PoolManager (so the pool's own coins earn nothing), the claim helper, plus the factory's default list (live: five
  addresses, among them Balancer's vaults). Clanker's owner / creator admin can exclude or re-include any holder and can
  `emergencyWithdrawDividendAssets` (the code says it "may remove unpaid backing"): holders trust Clanker for this money.
- **When nobody qualifies (V):** while `totalShares() == 0` the dividend part goes to Clanker's protocol recipient
  (`DividendTaxRedirected`). Right after launch, before anyone holds 10,000 coins outside the pool, that is Clanker's.
- **Cost (I):** every transfer of a dividend coin does two extra external calls with storage writes (tens of thousands
  of gas per swap); cents on Base, but it makes every trade of the coin more expensive and some aggregators price that.
- **Can the agent's kernel receive dividends? Yes, if it holds the coin** (I): only once the Trade power buys the coin
  (or someone sends it coins) above the minimum. The entitlement accrues, but claiming needs the kernel to call
  `withdrawDividends()` on the coin's tracker, which no session rule allows; it waits until a rule is added
  (`{target: tracker of this coin, selector withdrawDividends(), no args}`, value-free, safe: it only pays the
  caller). The creator's wallet and the platform recipient earn dividends like any holder. The dev buy passes through
  the launcher for one call and leaves it with no share.

## 5. Work list

Sizes are working days for one builder, with tests.

| Package | Work | Size |
| --- | --- | --- |
| contracts | `BootrClankerLauncherV5`: `TokenSettings`, `AgentDefaults`, the checks of 2.2, slot weights with ceil/floor, `quoteOf`, `coinCreator`, `allowedQuote[kind]` with `setQuoteAllowed`, USDC dev-buy route, `updateImage` / `updateMetadata` / `lockMetadata`, `tokenInitCodeHash(p, s)` / `predictToken(creator, p, s)`, events. Unit tests (bounds, weights, rounding, refusals, the editor role) and fork tests: ETH and USDC launches with and without dev buy, buy ≠ sell tax, burn + dividends + 4 extra rows, the agent's escrow balance ≥ its floor to the wei after swaps both ways, `claimFor(kernel, USDC)` landing on the kernel, sniper on and off, image and metadata edits by the creator only, name/symbol/slot updates refused, a non-allowed quote refused. Deploy script. | 5 |
| indexer | `pairedToken` per coin; USDC price math (`coinPrice` in the quote, decimals, USD per quote); the v2 `ClankerV5Launched`; slot classification by recipient and admin (agent, platform, creator, `recipient` rows) instead of position; buy and sell tax per coin (`lpFeeBps` today is one number); `DividendTaxCredited` / `DividendTaxRedirected` as a `dividends` kind; `ExtraMetadataUpdated` refreshing the coin's image and metadata; `/treasury` and `/token/:id/fees` per asset. One schema bump (fold into `bootr_v9` if v5 is not live yet). | 4 |
| supervisor | treasury read `owed(kernel, quoteOf(coin))`, USDC claims counted as fuel, the observation note per asset (ETH = gas, USDC = fuel), `fund_gas` and the gas warning for USDC agents; the claim rule is unchanged. | 1.5 |
| web: form | the screenshot's sections on the Clanker card: buy and sell tax; the allocation with agent and platform as fixed rows and creator funds / dividends / burn split by the creator, with the per-trade line ("Per trade: 0.5% Clanker · 0.05% agent · 0.30% Bootr · 0.65% creator funds"); sniper switch; editable-metadata switch; Rewards rows (admin, recipient, %, + Add recipient, Allocated x/100%); paired asset ETH / USDC with the opening cap read from `quoteConfig`; salt mining over the new hash. | 3 |
| web: elsewhere | `fee-split.ts` per-coin splits (two tax rates, dividends, extra rows), coin page fee lines, trade panel USDC pools (Permit2, two-hop from ETH), profile and console claims per asset, a creator-only "edit image and links" that sends the launcher call (and keeps the hosted document in step), mock coins. | 4 |
| agent API, skill, docs | `launch.token: {pairedAsset, buyTaxPct, sellTaxPct, burnPct, dividendsPct, minDividendHolding, rewards: [{recipient, admin, pct}], sniperTax, editableMetadata}` with the same checks and defaults; skill reference and docs pages; `docs/STATUS.md`. | 1.5 |

**Total: about 19 working days (four weeks).** Contracts first (the struct is the contract between the others), then
indexer and supervisor in parallel with the form.

## 6. Answered by the owner (2026-11-10)

1. **Ship order: one launcher with the settings.** No interim deploy of the fixed v5 launcher; v4 stays open for both
   presets until this launcher is live, then v4 is paused.
2. **Tax bounds: 1%–5% per side, default 1.5%** on both sides.
3. **Floors: agent 5%, platform 30%** of the post-Clanker pool, owner-settable for future launches within 2.2.
4. **No handover of the editor role.** Only the coin's creator wallet may change the image and the metadata, for good;
   there is no `proposeCoinCreator` / `acceptCoinCreator`. (The creator may still lock the metadata permanently.)
5. **Up to 4 extra reward rows** beside the creator's own row.
6. **USDC agents and gas: no new rule now**; the creator's gas tank and "Add gas" cover it, and the form says so.
7. **No dividend claim by the agent's kernel** (no session rule) for now.
8. **Sniper tax: the creator may switch it off; default on.** The form says the 20 s surcharge goes to Clanker.
9. **"Market details" uses clanker.world's quote-market API** (the one Clanker's own form uses) for the price,
   liquidity and the opening market cap, with Bootr's own `quoteConfig` arithmetic as the fallback when the API does
   not answer; the web calls it from the server with a short cache, never from the browser, and shows where the
   figures come from.

## 7. Risks

- Clanker can unregister a quote, move its start tick, change the policy bounds or disable launches for future
  launches; the launcher reads all of it in the same transaction, and a launch outside the new bounds reverts with
  Clanker's error (nothing is stuck). The deploy-day fork run checks the live policy.
- The dividend backing is under Clanker's emergency withdrawal; the form should say dividends are held by Clanker.
- Editable metadata means a creator can change the image and description to anything; Bootr's coin page shows what the
  chain says. The existing image moderation (if any) must read on-chain updates too (I).
- `contractURI` moving out of `metadata` changes how the indexer finds the hosted document for v2 coins (it reads the
  calldata or `contractURI()`); `ownContractUri` keeps reading `contractUri` inside the JSON for v4 and fixed-v5 coins.
