# Agent capabilities: what a coin's agent may do with money, as powers the creator switches

Written 2026-11-08 on branch `agent-capabilities-2026-11-08`. The owner's direction: agents are on-chain agents and
must be able to trade, run their own treasury and use the x402 service ecosystem; promotion and fee claims alone are
not enough. This note designs that so the blast radius is bounded and chosen by the creator, and ships the first
slice (the **Paid services** power). Marks on research claims: **V** read today in a primary source or on chain (the
URL or the contract is named), **U** inferred or secondary. Nothing here is legal advice.

Reading order for the money code this builds on: `packages/contracts/src/BootrCallPolicy.sol`, `AgentGuardian.sol`,
`BootrSwapHelper.sol`; `apps/supervisor/src/session-key.ts`, `treasury.ts`, `spender.ts`, `blockrun.ts`, `broker/`;
`apps/inference/src/client/x402-payer.ts`; `docs/research/claus-official-agent-2026-11.md` (the worst-case table it
gives is the baseline below); `docs/security/`.

## 0. The shape of the answer

- Every new capability is a **power** in the agent config, switched by the creator in the console like `xRead`,
  `research` or `images`, with its own caps and its own line "the most this can cost you in a day". No hidden tiers.
- Three new powers, in the order they can be built: **Paid services** (no contract change, built in this branch),
  **Trade** (one new immutable helper contract and a wider call policy), **Payouts** (one new escrow contract with a
  delay). Each is enforced where it can be enforced: on chain when the session key moves treasury money, in the
  supervisor when the spender's float pays over x402.
- The thing that moves money is never the thing that reads X. The social turn can want; a separate treasury turn,
  with a narrow context and no mention text, decides and signs. Section 4.
- Every money action, in or out, is on the coin page with amount, counterparty and reason, and an unknown outcome
  stays "unknown" until the chain says otherwise. Section 5.

## 1. Research

### 1.1 x402 today (protocol, facilitators, catalogue, services)

- **Protocol v2** (V, https://github.com/coinbase/x402 README and `specs/x402-specification-v2.md`): a 402 carries a
  base64 `PaymentRequired` in the `PAYMENT-REQUIRED` header (`accepts[]` of `{scheme, network (CAIP-2), asset,
  amount (atomic), payTo, maxTimeoutSeconds, extra}`); the client signs one entry and resends with
  `PAYMENT-SIGNATURE`; the server verifies through a facilitator, does the work, settles, and answers with
  `PAYMENT-RESPONSE` (`success, transaction, network, payer, amount`). Default flow: verify, serve, settle, respond.
  Servers vary: BlockRun sends the same object in three headers and the body (V, probed). v1 (`X-PAYMENT`) is still
  accepted by the CDP facilitator; all 2000 catalogue items sampled were v2 (V).
- **Schemes** (V, `specs/schemes/exact/scheme_exact_evm.md`, `.../upto/scheme_upto_evm.md`): `exact` = EIP-3009
  `transferWithAuthorization`, the facilitator submits and pays gas, "cannot modify the amount or destination";
  `upto` = Permit2 witness transfer with a ceiling, the server settles `actualAmount <= ceiling`, needs a one-time
  Permit2 allowance from the payer and the spec itself says "a malicious server can charge up to the maximum
  regardless of usage". Payments are "irreversible once settled"; a refund is the seller sending money back (V,
  CDP FAQ). The spec does not say what a server must do when its handler fails after settlement (V, absent).
- **Facilitators and fees** (V, https://docs.cdp.coinbase.com/x402/seller/facilitator.md and the FAQ): the CDP
  facilitator charges the **seller** $0.001 per settlement after 1,000 a month; verification is free; the **buyer
  pays nothing** beyond the quoted amount and no gas for `exact` USDC. The facilitator is the seller's choice; the
  buyer never talks to it. Other facilitators: PayAI, Dexter, Mogami, X Pay (V, https://docs.x402.org/dev-tools/facilitators).
- **Bazaar discovery** (V, https://docs.cdp.coinbase.com/x402/buyer/discover-services.md and my own calls):
  public, no key. `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=100&offset=0`
  listed 34,158 resources today; `/discovery/search?query=&network=eip155:8453&maxUsdPrice=&scheme=exact&limit=20`
  adds text and vector search and a `quality` block (30-day calls and payers). Of the first 2000 items 2188 accepts
  were `eip155:8453` and almost all USDC `0x8335…2913`. A seller is listed after one settled payment that carries
  `extensions.bazaar`; content is screened; a listing drops after 30 days without a settlement.
- **Services live on Base, USDC `exact`** (V, read from the catalogue today; atomic USDC): BlockRun LLM gateway
  (priced per request, about $0.006 for a small GPT-4o-mini call; the same gateway `blockrun.ts` already pays),
  agent402.tools chat 1000, Telnyx llama-3.1-8b 2237, onhub.ai chat 2000; web search oneshotagent 1000 and
  agentstools 3000; X search x402atlas 5000; scraping to markdown clawfetch 1000, gate402 2000, freeq 2000; weather
  tbs-digital 1000 (verified end to end: the 402 decodes as the spec says), tollkit 2000; crypto prices apitoll 1000,
  CoinGecko's own `pro-api.coingecko.com/api/v3/x402/...` 5000, DefiLlama via x402atlas 5000; onchain analytics
  Nansen who-bought-sold 10000, OneSource erc20-balance 3000, a Base RPC at nodeflare 1000 per call; news apitoll
  1000, Hacker News search 1000, Polymarket odds 1000; embeddings 2000 to 3000; Wikipedia 2000, arXiv 3000, email
  verify 1000, PageSpeed 6000. Prices across 2113 Base listings: min $0.001, median $0.005, p90 $0.05, max $249.
- **Failure modes for a buyer** (V unless marked): paid-and-no-answer has no protocol remedy; `settlement_pending`
  means "do not re-pay, check the tx" (V, settlement-pending page); a replayed EIP-3009 signature cannot double
  spend (one-time nonce) but a server may hold a signed authorization and settle later inside `validBefore` (U);
  `@x402/fetch` retries once and surfaces a second 402 as an error; the client signs the **live** 402, not the
  listing, so amount, payTo and asset must be checked by the client's own policy. The core client offers
  `spendControls` (default $1 per payment on USD assets), `registerPolicy` filters and `onBeforePaymentCreation`
  hooks; the CDP SDK adds cumulative-spend windows, allowed payees and networks (V, client-configuration.md).
  AgentKit's x402 provider allows only registered service URLs, $1 per request by default, no daily budget (V).
- **Limits** (V, CDP FAQ): no protocol minimum or maximum; CDP targets P95 verify 60 ms and settle 900 ms on Base;
  the facilitator verifies before the resource is served and settles after, in the default flow.

What this means for Bootr: the spender EOA already pays BlockRun and the relay exactly this way, so "pay any x402
endpoint" is a policy and bookkeeping problem, not a signing problem. The risks are a hostile or broken server
keeping the money, a server naming a higher price than its listing, and the answer being used as instructions.
All three are handled in the supervisor (section 3.1).

### 1.2 Trading primitives on Base and what a static allow-list can bound

- **Universal Router** `0x6fF5693b99212Da76ad316178A184AB56D299b43` (V, Uniswap deployments page; `poolManager()`
  reads the v4 PoolManager `0x4985…2b2b` on chain). `execute(bytes commands, bytes[] inputs, uint256 deadline)`:
  one byte per command, `inputs[i]` is dynamic, and SWEEP, TRANSFER, PAY_PORTION, TAKE and EXECUTE_SUB_PLAN send
  router-held funds anywhere (V, `Dispatcher.sol`, v4-periphery `Actions.sol`). The absolute word index of a
  recipient depends on the commands and on every earlier input's length, so `BootrCallPolicy`'s fixed-word rules
  cannot pin it. This is finding C-02 again and the reason the router was removed from the session rules: it stays
  out. `apps/web/lib/swap/core.ts` builds Universal Router calldata for the user's own wallet, which is fine there.
- **SwapRouter02** `0x2626664c2603336E57B271c5C0b26F421741e481` (V): `exactInputSingle` takes an all-static tuple
  (tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96), so every field sits at a
  fixed word and is boundable; but it reaches v3 pools only, and every Bootr coin lives in a Uniswap **v4** pool
  (Clanker v4 hooks or the RWAGMI hook). There is no deployed standalone v4 router: `V4Router` is abstract (V,
  v4-periphery). So the coin leg is reachable only through the Universal Router or a contract of our own that
  inherits `V4Router`.
- **Aggregators**: 0x Settler rotates addresses ("do not hardcode") and its `AllowanceHolder.exec(operator, token,
  amount, target, data)` is an arbitrary call funded by the allowance (V, 0x docs, 0x-settler repo); 1inch
  `AggregationRouterV6.swap(executor, desc, data)` has a static `desc` (dstReceiver at word 4) but the caller names
  the executor and `srcReceiver` (V, verified source, Sourcify) and the contract is owner-pausable with
  `rescueFunds`; KyberSwap `MetaAggregationRouterV2.swap(SwapExecutionParams)` nests dynamic arrays so the receiver is
  not at a fixed index, and it is owner-whitelisted (V, verified source). Odos and Velora take opaque API calldata (U
  on addresses). **Verdict (U):** none of them is safe as a direct session-key target; every one is
  caller-chooses-executor or arbitrary-call by design and owner-controlled. The workable pattern is the one Bootr
  already uses for WETH to USDC: an immutable Bootr helper that owns the router interaction, pays output to
  `msg.sender`, enforces the floor, and shows the policy a static-struct selector.
- **Oracles for the coin leg**: Chainlink ETH/USD `0x7104…Bb70` and USDC/USD exist (V, on chain); nothing for a
  fresh coin, and v4 pools have no built-in TWAP (an oracle is a hook chosen at pool creation; Clanker's hooks are
  fee hooks) (U). So the only on-chain floor for a coin trade is relative to the same block's spot price, which a
  sandwich can move; the real bound on a coin trade is its **size** (per trade and per day), not its price.
- **MEV on Base**: the sequencer orders by priority fee, there is no public mempool, Flashbots Protect and MEV
  Blocker are Ethereum-only (V), sandwiches on Base exist but are rare and probabilistic (V, arXiv 2601.19570 and
  2609.28115). A userOp also passes through the bundler before the sequencer (U, the bundler sees it first). For a
  small treasury the realistic loss is price impact in a thin pool plus the pool fee, not a sandwich.
- **What `BootrCallPolicy` can express today** (V, the contract): up to 8 rules of (target, selector) with up to 4
  argument rules each (EQUAL on a word, `<=` on a word, SUM_PER_WINDOW on a word with a fixed window grid), calls
  with zero ETH value only, no delegatecall. The $BOOTR permission uses 6 rules (two Clanker claims, WETH approve,
  swap, USDC to spender, WETH withdraw), so **two slots are free**. A policy can be widened per agent without
  redeploying anything: `approveSessionKey` takes any policy set (V, `AgentGuardian.sol`), but `sessionPolicyFor`
  builds one standard policy for everyone, so the 30-day rotation would strip extras unless the code learns
  per-agent rules (V, `session-key.ts`). A rule fixes one target and one selector: a general wallet tool cannot be
  expressed, and should not be.

### 1.3 Treasury management: what others let their agents do, and what went wrong

- **Clanker droids** are retired: "new droids can no longer be created", their wallets ran on a provider Clanker no
  longer uses, so Clanker cannot move the funds they hold (V, clanker.world/droids). What they were (U, from the
  removed funding page's search index): a default 10% carve-out of LP rewards into a runtime wallet that paid for
  inference; no evidence they traded or paid third parties. Lesson: a provider-held key stranded money.
- **Bankr**: Privy wallets, "non-exportable by design"; per-wallet daily and per-transaction USD limits plus allowed
  recipients, but "the limits and permitted recipients don't decode raw calldata"; swaps always return to the caller;
  x402 pay capped at $10 (V, docs.bankr.bot/security and wallet-api). Incidents: 2026-05-04 a Morse-code message
  translated by Grok became a transfer instruction and a membership NFT airdropped to the wallet had granted
  "Executive" permissions that bypassed limits, about $150K-200K of DRB moved, most returned (V, giskard.ai and the
  OECD incident record citing beincrypto); 2026-05-20 fourteen wallets accessed, $150K-440K, "social engineering
  targeting the trust layer between automated agents", no post-mortem (V, cointelegraph). Lessons: a limit a tier can
  bypass is not a limit; tokens anyone can airdrop must never grant power; model-to-model trust was the entry.
- **Virtuals**: ACP escrows the payment during a job; EconomyOS wallets are Privy server wallets with a local signer
  and "no human approval per transaction", with spend policies and allowlists marked "coming soon" (V, Privy docs);
  in Aug 2026 Virtuals announced owner policies enforced at its signing server after the $150K prompt-injection
  drain (V, cryptobriefing). Their bounds are policy-server bounds, not on-chain.
- **Base Spend Permissions** `SpendPermissionManager` `0xf852…67Ad` (V, on chain and the repo README): token,
  allowance, period, start, end, salt; the manager is an owner of the granting Base Smart Wallet and pulls with its
  `execute(target,value,data)`; Kernel v3.1 has no such function, so a Bootr kernel cannot be the granting account
  (V, bytecode check). Same shape as Bootr's `USDC.transfer(spender, SUM_PER_WINDOW)` rule, only for Base Smart
  Wallets.
- **ZeroDev policies** (V, docs.zerodev.app): Call (target, selector, per-argument comparisons, no cumulative sum),
  RateLimit (a lifetime count when the interval is omitted; the reset variant reads TIMESTAMP and the bundler
  refuses it), Gas, Timestamp, Signature, Sudo. The per-window sum is Bootr's addition.
- **Agents trading their own token**: ELIZA (Nov 2024) was front-run by a copycat launch and fell 65% in hours after
  an endorsement moved (V, theblock); Truth Terminal's RUSSEL mention was front-run by an unknown wallet (V,
  thedefiant); aixbt lost 55 ETH to a prompted transfer (U). The Claus report's own warnings stand: a predictable buy
  is traded around, an announced buy reads as a promise, and a platform buying its own coin while taking fees on the
  trade reads badly to a regulator (U, secondary sources only).

What "fully manage" can honestly mean for a coin's agent, from the above: hold ETH, WETH, USDC and its own coin;
rebalance between them on size caps the creator set; pay named services and named people within daily caps; and
publish a ledger. It cannot mean a general wallet, and buying its own coin should be deterministic, small,
reported after the fact, and only with counsel's view.

## 2. The powers

Today's baseline is the Claus report's table: with the current key a fooled model burns at most 50 USDC a day on
inference (to the operator's own relay or to BlockRun), and a leaked session signer moves at most 50 USDC a day into
a spender it does not control, plus up to 3% of one swap and the gas allowance. Everything below is **in addition** to
that, bounded by the creator's caps, and off by default.

| Power (console name) | What the agent can do | Enforced where | Worst case a day, hostile model | Worst case a day, leaked key | Creator sees | Creator stops it |
|---|---|---|---|---|---|---|
| **Treasury** (today, always on) | claim fees, WETH to USDC with a Chainlink floor, fund its own spender | on chain, `BootrCallPolicy` | 50 USDC of thinking | 50 USDC into the spender + ~3% of one swap + gas allowance | tape: claims, swaps, fuel | pause (guardian) |
| **Paid services** (built here) | pay any public x402 endpoint from the spender for data and tools | supervisor policy + the payer; money leaves the spender EOA, never the kernel | the daily cap `D` (default 1 USDC, hard ceiling 50) to hostile or useless services; also bounded by the spender's float (target 20 USDC, refilled at most 50 a day) | the spender key already exposes the whole float today; nothing new | tape: "Paid 0.005 USDC to host for: reason"; `/fuel` services total by host; the result the model saw | switch off (next tick), lower caps, deny the host; pause |
| **Trade** (next) | swap between WETH, USDC and its own coin through `BootrTradeHelper`, output to itself, per-trade and per-day caps and a slippage bound | on chain: the helper (token set, caps, floor) + the policy (approve rules, one swap selector) | buys the top of its own pool: loses impact + fees on at most the per-day notional `T` (coins stay in the treasury, nothing is stolen); on the WETH/USDC leg at most 3% of `T` | the same `T` at the worst price, once a day | tape: "Swapped 0.01 WETH for 1.2M COIN", with tx; `treasury_read` shows the caps and the day's use | `setCaps(kernel, 0, 0)` on the helper, from the creator's wallet, effective at once, no supervisor involved; pause |
| **Payouts** (later) | pay named people or services from the treasury: USDC to creator-listed payees, after a delay | on chain: `BootrPayouts` escrow (payee list, per-day cap `P`, delay) + one policy rule | proposes `P` a day to listed payees; the creator cancels inside the delay | the same, cancellable | tape: "Proposed 25 USDC to 0xabc… for: bounty, executes in 24 h"; Telegram notice | cancel the proposal; remove the payee; set `P` to 0; pause |

Numbers for a $BOOTR-sized treasury ($641 on 6 Nov; agent income about $55 a day): Paid services at the default 1
USDC a day is about 2% of income; a Trade cap of 0.01 ETH per trade and 0.03 ETH a day (about $65) means a very bad
day costs the pool fee and impact on $65, roughly $3-5 at today's 2.4% round trip, never the $65 itself; Payouts at
25 USDC a day to two listed payees is the Claus report's "named payees" line.

Hard ceilings that no console setting can pass: Paid services 5 USDC per call and 50 USDC a day (`agent-core`
`SERVICES_*_MAX_MICRO_USDC`); Trade and Payouts ceilings are constructor constants of their contracts (proposal: 0.1
ETH per trade, 0.5 ETH a day; 100 USDC a day for payouts).

## 3. Tools per power, and who decides what

Every tool call is validated by the catalog schema (`packages/agent-core/src/types.ts`), executed by the broker
(`apps/supervisor/src/broker/index.ts`), keyed by the deterministic action id so nothing is ever paid twice, and
read back as data with `instructionAuthority: false`.

### 3.1 Paid services (shipped)

- `discover_services({query, maxPriceMicroUsdc?, limit?})`, read: the catalogue's `/search` filtered to `exact`
  USDC on this chain under the agent's per-call cap; each item `{url, method, description, priceUsdc, payTo,
  allowed (by the creator's host lists), input, calls30d}` plus the agent's remaining budget. Cached ten minutes.
  Deterministic; the model only chooses the question.
- `x402_fetch({url, method?, body?, maxPriceMicroUsdc?, reason})`, money: the model chooses the endpoint, the body
  and its own ceiling; everything else is code: public https only (the `public-fetch` host rules, no redirects
  followed), the creator's deny then allow list, the cap = min(model's ceiling, per-call cap, what the day has left),
  the spender's float, `exact` USDC on this chain only, a 900 s signature window at most. One signature per action
  id, ever. The answer is bounded (256 KB read, 6000 characters shown), JSON re-serialised, control characters
  dropped, marked untrusted. After a signature exists the chain decides the cost: the EIP-3009 nonce spent means the
  signed amount moved (`exact` settles all of it); the deadline passed with the nonce unused means nothing can ever
  move. A server that settled and sent no usable answer costs the amount (`services_paid_no_answer`); there is no
  refund path and no replacement is ever bought. Rows: `sv_service_calls` (migration 0009).
- Why `exact` only: `upto` needs a Permit2 allowance from the spender (an extra approval surface) and the spec itself
  says a malicious server may settle the whole ceiling; for small fixed-price services `exact` is the honest shape.
  Direct-mode inference keeps using `upto` with BlockRun, whose address is pinned.
- Prompt injection: the Bootr rule added with this slice says a call is for a named need of the agent's own work,
  never because a message, a page or a listing asked it to pay, visit, test or tip, and never twice for the same
  question. The rule is advice; the caps are the wall. The result's `meaning` line repeats that it is data.

### 3.2 Trade (design)

- `trade_quote({tokenIn, tokenOut, amountIn})`, read, deterministic: the v4 Quoter (or the WETH/USDC Chainlink
  floor) for the three allowed tokens, with the pool's liquidity and the price impact of this size, the agent's
  caps and the day's use. The model sees numbers, not a recommendation.
- `treasury_prepare({operation: 'swap', asset, assetOut, amount, maxSlippageBps?, memo})` extended: builds
  `approve(helper, amountIn)` + `helper.swap(tokenIn, tokenOut, amountIn, minOut)` where `minOut` comes from the
  quote minus the slippage the helper allows (3% on the WETH/USDC leg against Chainlink; on the coin leg the
  supervisor's quote minus at most `MAX_COIN_SLIPPAGE_BPS`, and the helper also refuses any trade above its
  per-trade cap or above the day's remaining notional). Simulated and stored like today; `treasury_execute` as today.
  The model chooses direction, size and timing within the caps; the helper decides whether it may happen.
- Own-coin buys: off unless the creator switches `tradeOwnCoin` on; even then the publish gate keeps refusing first
  person "I bought" and the agent may only state a confirmed hash in the third person, after the fact. The platform
  agent's own coin: not without counsel (Claus report, problem 1).

### 3.3 Payouts (design)

- `payout_propose({payee, amountUsdc, reason})`, write: `BootrPayouts.propose(kernel, payee, amount, reasonHash)`
  through the session key; the payee must be on the creator's list, the amount inside the per-day cap. The proposal
  is public (tape and Telegram) and executes after the delay unless the creator cancels. `payout_list` reads them.
  No tool executes a payout; a keeper or anyone calls `execute(id)` after the delay.

### 3.4 Two turns: talking and treasury

The Claus report's single most useful idea: the role that reads mentions cannot hold money powers. Bootr today runs
one turn with every tool. Proposal:

- **Social turn** (as now, every wake): X, research, memory, pictures, `discover_services` and `x402_fetch` (the
  float is small and the caps are the wall), `treasury_read`. It cannot call trade or payout tools; it may leave a
  **treasury note** (`remember` with tag `treasury`) saying what it noticed and wants.
- **Treasury turn** (new, on its own clock, hourly or when a note is pending; `role: 'treasury'` in
  `buildSystemPrompt`, its own tool list): its observation is balances, caps, quotes, market numbers, its own notes
  and the social turn's treasury notes; never mention texts, pages or search results. It can `trade_quote`,
  `treasury_prepare`, `treasury_execute`, `payout_propose`. Cost: one or two thoughts an hour, about $0.05-0.20 a day
  on a Sonnet-class model, so it is itself a switch (on when Trade or Payouts is on).
- The guardian and the policy do not care which turn signs; this separation is supervisor code, and it is what makes
  "a mention made it trade" structurally impossible rather than merely forbidden.

## 4. Contract changes

| Change | Needed for | Shape | Migration |
|---|---|---|---|
| none | Paid services | the spender EOA signs EIP-3009 as it does for inference | none; a config switch |
| **`BootrTradeHelper`** (new, immutable, no owner) | Trade | inherits v4-periphery `V4Router` (or calls the Universal Router from inside with a plan it builds itself); `swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)`: pulls `amountIn` from `msg.sender`, allows only `{WETH, USDC, guardian.agentInfo(msg.sender).token}`, pays all output to `msg.sender`, enforces the Chainlink floor on the WETH/USDC leg and `minOut` plus `MAX_COIN_SLIPPAGE_BPS` against the pre-trade spot on the coin leg, and keeps per-kernel caps `(perTradeWei, perDayWei, windowEnd, spent)` measured on the WETH side of every trade (every pool has WETH on one side), settable only by the kernel's creator read from the guardian, bounded by constructor ceilings. Replaces `BootrSwapHelper` for new keys (WETH to USDC is a trade). | new launches get the new rules at install; existing agents at their next rotation (`sessionPolicyFor` learns per-agent powers: the rule set is built from the config, stored on the row, and re-applied on rotation). Old helper keeps working for old keys. |
| **`BootrCallPolicy` v2** (new deployment of the same module with `MAX_RULES = 14`) | Trade with headroom | `CONFIG_SLOTS = 1 + 14 * 9 = 127 < 128`, still associated storage under ERC-7562; otherwise byte-identical logic | optional: with the trade helper replacing the swap helper the rule count is 2 claims + 3 approves (WETH, USDC, coin) + 1 swap + USDC to spender + WETH withdraw = 8, which fits today's module exactly; v2 is for Payouts and anything after. New module address goes into `addresses.ts`; guardian unchanged (`approveSessionKey` accepts any policy set). |
| **`BootrPayouts`** (new) | Payouts | per-kernel payee list and `perDay` cap set by the creator (from the guardian), `propose` callable by the kernel (through the session key, one rule: `payouts.propose(kernel == msg.sender, …)`), `execute` after `delay` by anyone, `cancel` by the creator; holds no funds until execution pulls USDC from the kernel through an allowance the policy grants (`USDC.approve(payouts, SUM_PER_WINDOW)`) | new rule(s) on new keys; a `payouts` power switch |
| no change to `AgentGuardian` | all | `approveSessionKey` already accepts any policy set; `pauseAgent` stops every userOp | the open BOOTR-02 point (the admin can approve a sudo policy) is unchanged by this work and is the ceiling above every tier; move `ADMIN_PRIVATE_KEY` out of the supervisor container before Trade ships |

Public copy to change when Trade ships (`apps/web/components/docs/content.ts`): "cannot trade any token" becomes
"trades only with the Trade power on, only between WETH, USDC and its own coin, within the caps shown on its page";
the risks page's owner-powers table and the terms (still naming RWAGMI only) need the same pass.

## 5. The public ledger

Today the tape shows claims, swaps, gas, fuel, posts and now paid services. Proposal for `/agents/:id/ledger` (web,
reading the supervisor and the indexer): one table, newest first, columns `when · in/out · amount · counterparty ·
reason · status · tx`. In: fee claims (indexer), fuel sent by people (indexer `Transfer` to the kernel). Out: fuel
top-ups (treasury op), inference paid (sum per day from `sv_inference`, counterparty the relay or BlockRun), paid
services (per call, host, the model's reason), trades (per trade, both legs), payouts (proposal, execution, cancel).
Status is `confirmed`, `failed`, or `unknown`, and unknown stays unknown until the chain closes it, as the rows
already do. Daily totals at the top; the creator's console shows the same with the caps next to them.

## 6. Costs

- **Paid services**: the buyer pays only the quoted amount; no facilitator fee, no gas (V). Typical prices $0.001 to
  $0.05, median $0.005. A research agent calling five services a day spends about $0.03; the default cap of 1 USDC a
  day is 20 to 200 calls. Each call also costs the thought that decided it (about $0.03-0.10 on the current models).
- **Trade**: a userOp through the kernel on Base after Denim costs on the order of 300-500k gas; at Base's current
  fees that is well under a cent (U, not measured today) and comes from the kernel's gas, so a trading agent unwraps
  WETH into gas a little more often. The pool fee is 1% (RWAGMI) or 1.2% (Clanker) plus impact per leg; a round trip
  on the agent's own coin costs 2-4% plus whatever the fee split pays back to the creator and the platform (the
  Claus report's circular-money point). Hourly treasury turns add $0.05-0.20 a day of thinking.
- **Payouts**: two userOps per payout (propose, execute) and the proposal's thought.
- **Fuel**: the services spend comes out of the same float as thinking, so `/fuel` now shows it and the model's
  budget view shows what the day has left; an agent that spends its float on services sleeps sooner, which is the
  intended brake.

## 7. Presets ("Kind" on the launch form)

Every preset change is a new template version and a new hash; coins launched on v1 keep their v1 hash, and
`workerTemplateByHash` must keep resolving it (`WORKER_TEMPLATES` grows a `legacy` list of the v1 entries, like
`LEGACY_WORKER_HASHES` today). Powers and caps are editable after launch from the console whatever the preset said,
so a preset is the starting point, not a lock. `services` is deliberately **outside** the worker hash in this
branch (it is a console switch like the others; `canonicalWorkerJson` leaves it out) so that no existing hash moved;
the v2 presets below fold it and the later powers in.

| Kind | Powers on at launch | Caps at launch | Plain words on the form |
|---|---|---|---|
| **Community** v2 | xRead, xReply, xPublish, memory, treasury | none new | "Answers mentions, welcomes new holders, posts updates. Spends nothing beyond its thinking." |
| **Researcher** v2 | + research, **services** (0.05 USDC a call, 1 USDC a day, any public host) | services only | "Reads the web and paid data services, posts sourced findings. Can spend up to 1 USDC a day on data." |
| **Trader** v2 | + research, services (0.05 / 1), **trade** (0.01 ETH a trade, 0.03 ETH a day; own-coin buys off) | trade and services | "Watches its own market, rebalances between ETH, USDC and its coin within small caps, reports every trade with its hash. Never buys its own coin unless you switch that on." |
| **Steward** (new) | xRead, xReply, xPublish, memory, treasury, services (0.05 / 1), **payouts** (25 USDC a day, payees you list, 24 h delay) | payouts and services | "Runs a small budget for the community: proposes bounties and payments to people you list; you have a day to say no." |
| **Custom** | any set | the creator's caps | the Powers grid gains Paid services, Trade and Payouts, each with its caps and its "most per day" line |

The platform's own agent (`config.platform`) takes none of the money powers by preset; the owner switches Paid
services on for it with a tight cap (0.02 USDC a call, 0.5 USDC a day, allow list of named hosts) once the slice has
run on a coin agent for a few days.

## 8. Order of delivery

1. **Paid services** (this branch, done): config, tools, supervisor, console, docs, tests. Size: done. Next step: the
   owner reads it, switches it on for one coin agent with the defaults, watches the tape for a week.
2. **Per-agent session rules** (supervisor only, about two days): `sessionPolicyFor` builds the rule set from the
   agent's powers and stores it on the row; rotation re-applies it. Nothing changes for agents without new powers.
   This is the prerequisite for every on-chain power and fixes the "rotation strips extras" point.
3. **Treasury turn** (supervisor and agent-core, about three days): `role: 'treasury'`, its own clock, its tool list
   and observation; the social turn loses nothing it has today.
4. **`BootrTradeHelper` + Trade power** (contracts, about a week including fork tests and a review): the helper, its
   fork tests on a real Clanker pool and a real RWAGMI pool, the `trade_quote` tool, `treasury_prepare` extension, the
   console caps, the docs pass. Own-coin buys stay off by default and behind counsel.
5. **`BootrCallPolicy` v2 (14 rules)** (contracts, two days): when the rule budget bites, before Payouts.
6. **`BootrPayouts` + Payouts power + Steward preset** (contracts and all tiers, about a week).
7. **Ledger page** (web, two days), can run in parallel with 4.
8. **Presets v2** (shared, web, supervisor, one day): after 4 and 6 exist, so the Trader and Steward kinds mean what
   they say.

## 9. What the owner decides next

- Whether to switch Paid services on for a coin agent now (defaults: 0.05 USDC a call, 1 USDC a day, any public host),
  and for the platform agent later with an allow list.
- Whether Trade may include buying the agent's own coin at all, and if so only after a lawyer's written view (the
  Claus report's problem 1); the design keeps it a separate switch, off.
- The hard ceilings of the Trade and Payouts contracts (proposed 0.1 ETH a trade, 0.5 ETH a day; 100 USDC a day).
- Whether the treasury turn is required for Trade (recommended) or Trade may run inside the social turn behind the
  caps alone (cheaper, weaker).
- Moving `ADMIN_PRIVATE_KEY` out of the supervisor container before any on-chain power ships (the ceiling above every
  tier, BOOTR-02).

## 10. What I could not verify

- Any statement in the x402 docs on what a server must do if its handler fails after settlement, or how often that
  happens in the catalogue; and whether the CDP facilitator is the only one indexing a Bazaar.
- The real-world behaviour of the listed services beyond their 402 (one, the weather endpoint, was probed; none was
  paid).
- Gas per kernel userOp on Base after Denim (not measured today) and the current Base gas price.
- Whether 1inch publishes stable executor addresses; Kyber's receiver word position (derived, not tested); Odos and
  Velora addresses (repo mirror and search only).
- Clanker droid capabilities beyond the retirement notice; Virtuals' August policies having shipped.
- Legal questions: whether a platform-run agent trading the platform's coin is market abuse where the owner or the
  holders live; the SEC staff buyback FAQ was read through Unchained only.
- That the `*.hostname` allow pattern and the daily cap behave as intended against a real hostile server: the tests
  use a local stub and a Base fork, not the open internet.

## Sources

x402: https://github.com/coinbase/x402 (README, `specs/x402-specification-v2.md`, `specs/schemes/exact/scheme_exact_evm.md`,
`specs/schemes/upto/scheme_upto_evm.md`), https://docs.cdp.coinbase.com/x402/welcome.md, `/x402/how-it-works.md`,
`/x402/seller/facilitator.md`, `/x402/seller/get-discovered.md`, `/x402/seller/settlement-pending.md`,
`/x402/buyer/discover-services.md`, `/x402/buyer/client-configuration.md`, `/x402/buyer/mcp-payments.md`,
`/x402/support/faq.md`, https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/list-x402-resources.md
and `search-x402-resources.md`, https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources (read 2026-11-08),
https://docs.x402.org/ (quickstart-for-buyers, schemes/upto, extensions/bazaar, extensions/payment-identifier,
dev-tools/facilitators, faq), https://blockrun.ai/pricing, https://github.com/coinbase/agentkit (x402 action provider).
Trading: https://developers.uniswap.org/contracts/v4/deployments, `/contracts/v3/reference/deployments/base-deployments`,
`/contracts/universal-router/concepts/commands`, https://github.com/Uniswap/universal-router (`Dispatcher.sol`),
https://github.com/Uniswap/v4-periphery (`V4Router.sol`, `Actions.sol`, `ActionConstants.sol`),
https://github.com/Uniswap/swap-router-contracts (`IV3SwapRouter.sol`), https://docs.0x.org/docs/core-concepts/contracts,
https://github.com/0xProject/0x-settler, 1inch and Kyber verified sources via Sourcify, https://docs.kyberswap.com,
https://docs.base.org (flashblocks faq, transaction ordering), https://docs.flashbots.net/flashbots-protect/quick-start,
arXiv 2601.19570 and 2609.28115. Chain reads against https://mainnet.base.org at block 54852429.
Platforms: https://clanker.world/droids, https://docs.bankr.bot (security/overview, wallet-api/overview),
https://www.giskard.ai (2026-05-07 analysis), https://oecd.ai/en/incidents/2026-05-04-4a73,
https://cointelegraph.com/news/bankr-disables-transactions-after-14-wallets-hacked, https://whitepaper.virtuals.io,
https://docs.privy.io/recipes/agent-integrations/virtuals-economyos, https://cryptobriefing.com/virtuals-protocol-agent-wallet-prompt-injection/,
https://github.com/coinbase/spend-permissions, https://docs.zerodev.app/sdk/permissions/intro,
https://www.theblock.co/post/327234, https://thedefiant.io (Truth Terminal front-run).
Bootr: `packages/contracts/src/`, `apps/supervisor/src/`, `docs/research/claus-official-agent-2026-11.md`,
`docs/research/bankr-opportunity-2026-11.md`, `docs/security/`.
