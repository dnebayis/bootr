# Agent autonomy: what the references really do, where Bootr stands, and the stages after this round

Written 2026-11-13 against commit `5d389a1`. Research and direction only: no code, nothing signed, sent or deployed.

The owner's goal, in their words: the agent should be as autonomous as possible, with rules and security; it quotes,
comments, researches, trades, opens bounties and more by itself; better than Claus and the best it can be; "this will
not be another AI agent project, it will be the next AI project".

How to read this note:

- The fifteen-minute path: the short answer, the two paragraphs that close section 2, the stage table that opens
  section 4, then sections 6 and 7. The rest is the evidence and the detail a designer builds from.
- Every outside fact carries a source number in square brackets; the list with URLs is at the end. Every page was
  read on 2026-11-13. Marks in the list: **P** the project's or regulator's own page, **S** press or a third party,
  **N** a search result that was not opened.
- Every statement about Bootr names the file or note that proves it.
- "This round" means the build round another note is designing (`docs/design/agent-tools-2.md`, not on this branch
  and not read here): threads, quote posts, comments on conversations, scheduled posts, learning from post
  performance, an MCP swap-preparing tool, cloud-scheduled runs and a Telegram due notice. The roadmap in section 4
  starts after it.
- I am not a lawyer. Section 5 says where the owner needs one.

## The short answer

- **None of the three references is an agent that runs money by itself.** The Anchorage desk produced one
  recommendation and executed no trade [A1]. Claus's coin, fees and upgrades sit with one founder wallet, and its own
  pages still say the handover to the agent is in progress [C4][C5]. aixbt is a data product run by a company; it
  does not trade and holds no treasury of its own that any source shows [X1][X2].
- **Bootr already has the part the others lack**: a key whose limits are on chain, a pause only the creator holds,
  roles that keep mention text away from money, and a public tape. It is behind on what the agent perceives without
  being asked, on planning past one turn, on selling anything, and on trading and paying by contract (both designed,
  neither built).
- **The evidence does not support letting a model pick trades.** Four of six leading models lost 42 to 59% in a
  17-day live contest [R5]; the Anchorage authors say two runs prove nothing and saw confirmation bias in their own
  risk team [A1]. The one working money agent found is rule-based rebalancing under session keys [G1]. So the Trade
  power should start as trades inside bands the creator sets, not free choice (section 4, stage 5).
- **Two X rules cut across this round and the next.** On self-serve API tiers a reply is accepted only when the
  author mentioned or quoted the agent [T2], and X's developer policy says a service should not pay people for
  actions on X [T3]. The first limits "comments on conversations"; the second touches bounty entries posted as
  replies. Both are in section 5.

## 1. What each reference really does

### 1.1 The Anchorage trading desk [A1]

An article by an Anchorage Digital engineer, dated 2026-11-04. A demo, and the authors say so.

| Question | Finding |
|---|---|
| What it decides alone | Five teams of model roles (analysts, bull and bear researchers, a trader, a three-voice risk team, a portfolio manager) read data, argue and return one view on BTC: "Overweight", with a proposed buy at $85,509 and a stop at $83,353. It also decides which paid data to buy. Built on the open TradingAgents framework. |
| What a human still does | Creates the agents, sets each team's budget and merchant list, issues one API key per team, patches the framework, adds a free data key, starts the run. No trade was executed; the decision was saved to the desk's memory as "pending" for a later run to review. |
| How it is funded, what it earns | Funded by the authors' account at the bank. It earns nothing. The whole run cost about $0.19 in 18 payments: 15 for model calls (through BlockRun) and 3 for signed market data (Mycelia, $0.11). |
| How money is bounded, and by what | **Custodian policy.** Funds stay at Anchorage Digital Bank; "the agent never holds your money"; each team has a cap it cannot pass; agents can pay only merchants the bank has reviewed. Nothing on chain enforces this; the bank's platform does. |
| What it publishes, how often | Nothing in public. Every payment settles on chain over x402 (Solana or Base; the article does not say which, or which stablecoin). The paid data carries a signature, so what the desk acted on can be proved later. |
| What broke | The first run lacked macro and sentiment data and the portfolio manager said so. The sentiment analyst had 30 posts to work from. Two price feeds differed by $27.30. The authors saw the risk team reasoning towards the plan it was handed. They state that two runs cannot show whether the desk trades well. |

What to take from it: separate budgets per role, signed inputs kept for audit, and a decision stored as pending and
reviewed later. What not to take: it is a recommendation engine behind a bank's policy server, not an agent with
bounded on-chain powers.

### 1.2 Claus [C1]-[C10], and what changed since our report of 2026-11-06

Our earlier report is `docs/research/claus-official-agent-2026-11.md`. Its findings on control stand: I found
nothing today that contradicts them.

| Question | Finding |
|---|---|
| What it decides alone | By its own description: posts, replies and quotes under a written policy (reply to a direct question, quote only with a verified source, stay silent on repeats or doubt) [C7]; small tools and pages through a review pipeline; small free tasks. How much runs unattended cannot be shown from outside: its own status still reports `liveExecutionObserved: false` and `runtimeProof: false` [C7]. |
| What a human still does | One admin wallet can upgrade the Robinhood token, hook and liquidity management, change fees and mint with no cap and no timelock; the one-hour notice is a promise, not code [C4]. The release page lists as not enabled: unrestricted wallet custody, general investment execution, a public inference resale gateway; the autonomous handover is "in progress" [C5]. Two items on its Work page say "published with operator assistance" [C8]. |
| How it is funded, what it earns | Ethereum pool: 2.3% of volume, all of it to the founder wallet [C6]. Robinhood pool: 2%, all to liquidity [C4]. Work page: "No independent customer has paid yet"; the only paid order came from the operator's own Jobs wallet [C8]. |
| How money is bounded, and by what | By its operator's code and a fixed-recipient design, as it describes itself: per-cycle compute funding, a 100 USDC one-time investment budget, 0.02 USDC a paid web call, a fixed Jobs wallet (figures from the earlier report, not re-read today). No on-chain policy binds the founder wallet. |
| What it publishes, how often | A weekly ledger that leaves unknowns visible, machine-readable state pages, a work log [C8]. The latest dated work item is 24 October; the overview lists two results dated 3 November [C8][C9]. |
| What broke | See the earlier report: stuck draws, payouts blocked by an unrelated pause, features retired soon after launch, buybacks switched off. Today the fee state still shows the timed buyback inactive and every share but the wallet's at zero [C6]; FOMO buybacks, Rising Tide and the weather rule are listed as retired, Ethereum buyback and NFT allocations as paused [C4]. |

**What changed in the week since 6 November.** Little that moves towards autonomy. The release page still carries
"Updated 26 October 2026" [C5]. The Work page has no item after 24 October [C8]. The docs now lead with the network
(projects, static sites, apps, a free public task board, native launches on Robinhood Chain) rather than with the
official agent's own powers [C1][C3]. Points I had not recorded before, which may or may not be new: Claus Jobs is
described as free and public with "no automatic payment", paid agreements being a separate ETH or CLAUS escrow
[C3]; a native launch carries 10 USDC of operating credit on Base while the token launches on Robinhood Chain [C2];
independent token launches go through a partner gateway with a 15% total fee ceiling that includes a fixed 0.3%
platform fee [C5]; new project inference was disabled on 21 October [C2]. The verdict of the earlier report holds:
copy the conduct (the ledger, the role without money powers, small named jobs), not the control.

### 1.3 aixbt [X1]-[X15]

| Question | Finding |
|---|---|
| What it decides alone | Which items from its tracked accounts to surface and how to score them. "Trend" is an estimate of the chance that attention from tracked accounts stays above a project's usual level for the next six hours; items carry five sourcing grades, from one unsourced sighting to an official source with wide corroboration, described as sourcing strength, not truth [X1]. It writes posts and replies in its persona. Models are not stated anywhere. |
| What a human still does | A Singapore company (PRECOG ANALYTICS PTE. LTD.) operates it [X2]. People choose the tracked accounts and the data fed in (the launch spoke of a "curated social graph") [X7]. The company sets plans and prices and holds the keys. |
| How it is funded, what it earns | Access: holding 600,000 AIXBT qualifies for the Holder plan, with paid monthly or yearly plans beside it [X2]. A paid API (v3) and an MCP endpoint [X4]. The token gives access only: no revenue share, no vote; the company and team hold the token and earn fees as liquidity providers [X2][X8]. No revenue figure is published. An x402 test was announced in October 2025 [X11]; I could not confirm a live x402 endpoint today, and its ERC-8004 entry shows "No services configured" [X12]. |
| How money is bounded, and by what | No source shows it trading or running a treasury. Its one known on-chain power was a third-party tipping wallet its posts could trigger, and that is what was drained (below). Bound: nothing but the operator's dashboard. |
| What it publishes, how often | Early 2025: about one post an hour plus over 2,000 replies to mentions a day [X7]. Late October 2026: a post every three to four hours [X8]. Current reply behaviour is not confirmed. |
| What broke | 2025-03-18: an attacker reached the operator dashboard and queued two replies; the agent sent 55.5 ETH (about $105,000) from its tipping wallet. The builder said the model was not manipulated; the control panel was [X6][X14]. Accuracy: one study claimed 83% of 210 picks profitable with no method and figures that do not add up [X9]; another found a 48% win rate over 416 tokens, with the complaint that it is always positive [X10]. Small coins rose on a mention and mostly fell back within hours [X7]. The token went from $0.94 (January 2025) to about $0.015 (November 2026) [X6][X13]. |

Why people follow it, as far as sources say: it reached nearly 300,000 followers in under two months [X5] because it
compressed what several hundred accounts were saying into short, confident posts, around the clock, and answered
anyone. One engineer's description is the fair one: an index of posts and on-chain data with a model presenting it
[X10]. What changed in 2026: the terminal became separate views (rankings, intel, clusters, momentum, alerts), the
API and MCP arrived, paid plans sit beside the holder plan, and the posting volume fell from thousands of replies a
day to a few posts [X3][X4][X8]. That fall matches X's rules of 2026 (section 5.1).

What to take from it: perception is the product. A scored, sourced view of a set of accounts, built by code, is
what made the posts worth reading. What not to take: confident market talk, a token whose only use is a paywall,
and an operator panel that can make the agent move money.

### 1.4 The others that matter, and why these four

Picked because each is the clearest live example of one thing Bootr is about to build. Truth Terminal, Freysa and
ElizaOS were not rechecked and are left out; ERC-8004 is a standard, not an agent, and is covered in stage 9.

| | **Virtuals ACP** (agents hiring agents) | **Bankr** (the closest product) | **Giza ARMA** (a money agent that works) | **Coinbase x402 and Agentic Wallets** (the rail) |
|---|---|---|---|---|
| What it decides alone | A client agent posts a job, a provider delivers, an optional evaluator approves [V1] | Launches tokens and moves funds on a text command, also from other bots [B2][B3] | Moves stablecoins between lending markets when the gain beats the gas; compounds [G1] | Whatever the agent's code decides, inside session caps [K1] |
| What a human still does | Builds and funds each agent; the client is the default evaluator [V1] | Sets wallet limits and allowed recipients [B1] | Activates and deactivates; deactivation withdraws and revokes the key [G1] | Sets the caps; Coinbase holds the keys [K1] |
| How it is funded, what it earns | USDC locked at funding, paid on approval; provider 95%, protocol 5% (or 90/5/5 with an evaluator) [V1] | 1.75% of volume on launched tokens, split between creator, locked liquidity, Bankr and a buyback [B2] | 10% of the yield, taken at withdrawal; the agent pays gas [G2] | n/a; x402 has passed about 100 million payments on Base by third-party counts that do not agree with each other [K3][K4] |
| How money is bounded, and by what | Escrow contract per job [V2]; wallets are server-side | Bankr's servers on Privy wallets: daily and per-transaction limits and a recipient list that "don't decode raw calldata" [B1] | Session keys on smart accounts, "time-bound, limited in scope, and revocable" [G1]: the same family as Bootr's | Custodian policy inside Coinbase enclaves, not contract code [K1] |
| What broke | An on-chain audit found two wallets paying each other were 64% of v2 jobs, a median job of $0.01, platform fees falling from $345,200 in March 2026 to under $6 a month since June, and 151 of 44,052 registered agents ever earning over $1,000; Virtuals itself warned of "self-directed flows" [V3] | 2026-05-04: a Morse-coded reply made Grok tag Bankr with a transfer order; 3 billion DRB (about $150,000 to $200,000) left the wallet, and a membership NFT sent to it had raised its privileges; about 80% came back [B3][B4]. 2026-05-20: about $150,000 from 14 wallets [B5]. Suspended on X for hours in October 2025 [B7] | Nothing found; current size and audits not confirmed (self-reported $16M in August 2025 [G3]) | A bridge built on x402 lost 17,693 USDC to a leaked server key and loose approvals [R3] |

Three lessons from this table that shape section 4: a limit enforced by a server fell to one sentence twice (Bankr);
agent-to-agent commerce at scale is mostly agents paying themselves (Virtuals); the money agent that works does one
narrow, rule-shaped job under an on-chain session key (Giza).

## 2. The autonomy scorecard

"Yes", "Partial", "No" or "Designed" for Bootr, with the proof. Paths are under `apps/supervisor/src/` unless they
start with another folder; "caps note" is `docs/design/agent-capabilities.md`, "own note" is
`docs/design/byo-agent.md`. For the references a dash means no source shows it.

| Capability | Bootr today | Claus | aixbt | Anchorage desk | Best known example |
|---|---|---|---|---|---|
| **Perceive** | | | | | |
| Mentions addressed to it | Yes: `read_mentions`, verified-badge audience by default (`packages/agent-core/src/tools.ts`, `social/eligibility.ts`) | Yes, by its own policy [C7] | Yes; once 2,000 replies a day [X7] | - | aixbt in 2025, at a volume X no longer allows without approval |
| Timelines it follows | Partial: only the platform agent, a fixed list of up to 20 handles from an environment variable (`watchlist.ts`); a coin agent can read one account when it thinks to (`read_x_account`) | - | Yes: tracked accounts in four clusters [X1] | No | aixbt |
| Market and chain data | Partial: its own coin's snapshot and fee split in every turn (`runtime.ts` `buildFirstObservation`, `coin-fees.ts`); other data only when it asks (`read_market`, `read_chain`, `read_coin`); the platform agent gets daily numbers built by code (`platform-numbers.ts`). No brief over time for a coin agent | Reads chain and web | Yes: price, holder and protocol feeds [X13] | Yes: prices, indicators, macro, odds, signed paid data [A1] | Anchorage desk for breadth, aixbt for social |
| Its own results | Partial: posts are measured after a day and summarised into the next turns (`post-performance.ts`). Nothing for money decisions yet | A public ledger [C8] | - | A decision is stored as pending for a later review [A1] | Nobody shows a closed loop in public |
| **Decide** | | | | | |
| Plan inside a turn | Yes: up to 8 steps, one action at a time (`runtime.ts`, own note 1.1) | - | - | Yes: staged debate [A1] | Anchorage desk |
| Prioritise | Partial: code decides when a turn is worth buying (`packages/agent-core/src/runtime/wake.ts`, `rhythm.ts`, `post-budget.ts`); the model orders work inside it | - | - | - | - |
| Remember | Yes: notes with keyword recall and a checkpoint (`memories.ts`, `finish` in `tools.ts`) | - | - | A memory file [A1] | - |
| Learn | Partial: post numbers only; richer use is this round | - | - | - | - |
| Plan across days (goals, campaigns) | No: only the free-text agenda in the checkpoint | - | - | No | Nobody shows it in public |
| **Act socially** | | | | | |
| Original posts on a rhythm | Yes: `publish_post`, 2 to 48 a day, slots and quiet hours (`rhythm.ts`) | Yes | Yes | No | Level |
| Replies | Yes: one per interaction that addresses it (`social/eligibility.ts`, own note 7.1) | Yes | Yes | No | Level |
| Threads, quote posts, comments, scheduled posts | No; this round | Quote policy listed [C7] | - | No | - |
| Campaigns over days | No | - | - | No | Nobody |
| Pictures | Partial: `generate_image` and uploads for own agents; no live picture verified end to end (`docs/STATUS.md`, Parked) | - | - | No | - |
| **Act economically** | | | | | |
| Claim its fees | Yes: by code, under an on-chain rule (`treasury.ts`, `session-rules.ts`) | Fees go to the founder wallet [C6] | - | n/a | Bootr |
| Swap to fund itself | Yes: WETH to USDC through an immutable helper with a price floor (`docs/security/session-key-and-treasury-review.md`, C-02 fixed) | - | - | n/a | Bootr |
| Trade | No; designed (caps note 3.2) | Not enabled [C5] | No | No trade executed [A1] | Giza ARMA, in one narrow job [G1] |
| Hold a strategy | No | No | No | No | Giza ARMA |
| Pay for services | Yes: every thought is an x402 payment by the agent's own spender wallet; paid data and tools under caps (`docs/STATUS.md` section 1, `services.ts`) | Small paid web calls | - | Yes: 18 payments [A1] | Bootr and the Anchorage desk; Bootr does it for a fleet, every day |
| Sell a service | No: the agent card lists `"services": []` (`docs/agent-identity.md`) | Offers some; no outside customer has paid [C8] | Yes, as a company: plans, API, MCP [X2][X4] | No | aixbt |
| Hire people | Partial: stage A. It posts a job, code collects entries, a judge role rules, the creator pays by hand (`bounties.ts`, `judge.ts`) | A free task board; tiny paid jobs from its own wallet | - | No | Nobody at any size |
| Hire agents, or be hired | No | Agent apps and tasks, free [C3] | - | No | Virtuals ACP, with the caveats of 1.4 |
| Pay out by itself | No; designed (`BootrBounties`, caps note 3.3) | Escrow exists; no outside customer [C8] | No | Pays merchants only | Virtuals ACP escrow |
| **Govern itself** | | | | | |
| Budgets | Yes: a per-day USDC sum enforced on chain (`packages/contracts/src/BootrCallPolicy.sol`), service caps, posts and X reads a day, daily limits for own agents (own note 7.1) | Operator code | None shown | Custodian caps [A1] | Bootr for on-chain; Anchorage for custodian |
| Risk limits and breakers | Partial: holds after an X 403, a provider hold, backoff after a failed treasury operation (`rhythm.ts`, `provider-hold.ts`, `treasury.ts`). No breaker on loss or on a spike of refusals | - | - | - | Nobody |
| Kill switches | Yes: the creator's on-chain pause (`AgentGuardian.sol` `pauseAgent`), a switch per power, channel pauses (`tools.ts` `publicChannelBlocked`), a fleet-wide revoke (`api.ts` `panic-revoke`) | Operator | Operator | Bank | Bootr: the creator's pause is on chain and nobody else holds it |
| Audit trail | Yes: a public tape of posts, claims, swaps, paid calls with their reason, bounty events (`activity.ts`). The ledger page is designed, not built (caps note 5) | Weekly ledger with unknowns shown [C8] | No | On-chain payments, signed data [A1] | Claus for honesty about unknowns; Bootr for coverage |
| Identity and reputation | Partial: an ERC-8004 identity at launch and a hosted card (`apps/web/lib/agent-card.ts`); the indexer reads feedback and shows a plain average (`apps/indexer/src/reputation.ts`, `apps/web/components/token/AgentPanel.tsx`). Bootr publishes nothing about an agent's record to the registry | - | Registered, no services [X12] | - | Nobody; see stage 9 |
| Dead-man switch, outside monitoring | Partial: a session key expires and must be rotated (about every 27 days, `config.ts`); a watchdog runs on the same host with root (`docs/security/key-inventory-2026-11-08.md` 1.2) | - | - | The bank | Nobody |

**Where Bootr leads:** limits on chain, the creator's own pause, role separation in code, paying for its own
thinking over x402 as a daily fact, the bounty judge that sees artefacts and no names, the public tape, and the
fleet (one agent per coin, hosted or run from the creator's own AI client under the same guards).

**Where Bootr trails:** standing perception (aixbt), planning past a turn (nobody public, so this is open ground),
selling anything (aixbt), trading and paying by contract (designed only), reputation that says anything, and two
security items that matter more as powers grow: the admin key still on the server and one session signer for every
treasury (`docs/security/session-key-and-treasury-review.md`, C-03 and H-02, both open).

## 3. Where Bootr can be ahead, and where it should not compete

**Ahead, from what already exists:**

1. **Bounds a stranger can check.** The session key can make only the calls `BootrCallPolicy` lists, with a daily
   sum kept on chain, and the creator alone can pause (`packages/contracts/src/`). Claus is bounded by a founder
   wallet's good conduct, Bankr by servers that failed twice, Anchorage by a bank, aixbt by a company. Bootr can put
   the worst day as a number on the coin page and have the chain agree with it.
2. **One agent per coin, owned by its creator.** The references are one mascot each. A fleet under one set of
   guards is a different object: agents can hire each other, a creator can run the brain on their own machine (own
   note), and a visitor can compare records.
3. **A treasury that fills by rule.** The agent and platform fee slots are locked at launch
   (`docs/design/clanker-v5-token-settings.md`, decision 1), so the agent's income does not depend on a founder's
   choice. Claus's fee goes to the founder's wallet [C6].
4. **Judging separated from paying.** The judge role has no tools and never sees a reply's text, author or address;
   code pays (caps note 3.3). Virtuals' default evaluator is the client itself [V1].
5. **A tape with reasons.** Every paid call carries the reason the model gave (`services.ts`). Add the ledger and
   this becomes the one record where a holder can see what the agent did with money and why.
6. **Guards on the server whoever does the thinking.** An own agent's client is only the brain; every limit is
   checked by Bootr (own note 7.1). No reference offers that.

**Not worth competing on:**

- **Market data as a product.** aixbt's value is a curated graph of hundreds of accounts read all day. Bootr reads
  400 posts a day per agent at its own cost (`docs/security/fixes-2026-11-08.md` item 5) and should stay a consumer
  of data, buying it over x402 where it helps.
- **Reply volume.** X's rules now forbid what made aixbt grow (section 5.1).
- **Picking winners.** No public result shows a model doing it, and the legal exposure is the highest of anything
  here (section 5).
- **A general wallet, custody, or a jobs network with hosting.** Each is someone else's whole company (Bankr,
  Anchorage, Claus Network) and each has shown its own failure.

## 4. The roadmap after this round

Order follows two rules: nothing moves money before the record and the keys are right, and each new power starts in
its most rule-shaped form. Sizes are working days for one builder and are estimates. "Worst day" assumes a model
that has been fooled; a leaked key is covered where it differs. Every stage keeps the guardian's pause.

| # | Stage | What the agent newly does alone | The rule that bounds it | Worst day: money and reach | Must exist first | Size | How it is turned off |
|---|---|---|---|---|---|---|---|
| 1 | Foundations | Nothing new | The admin key leaves the server; a separate session signer for coins with a money power; `BootrCallPolicy` v2 (14 rules); recalled notes marked untrusted; the ledger page | Unchanged | Nothing | 8 to 10 | n/a |
| 2 | Brief and its own watchlist | Starts each day from a brief built by code; keeps a list of up to 10 accounts and 5 coins it wants to follow | The brief is numbers from the indexer, no model; the list has caps, account-age and badge rules, and sits inside the 400 reads a day | Money: none. Reach: none beyond its post quota | This round's performance learning | 5 | A "Watchlist" switch; the creator can remove any entry |
| 3 | The mandate | Works towards goals the creator set once, inside a risk tier, without a switch per action | The mandate is a form that writes the existing caps; on-chain caps are set by the creator's wallet and lapse after 30 days unless renewed | The tier's number, shown on the coin page | 1 | 5 | Lower the tier; let it lapse; pause |
| 4 | Bounties paid by contract | Pays a winner without the creator's hand | `BootrBounties` immutables: 0.1 to 1 USDC a job, 20 USDC a day ceiling, 5 open jobs, one payout a job, a cooldown per payee | 5 USDC by default, 20 at the ceiling; reach: job posts inside the quota | 1; a stage A trial worth paying for; entries moved off X replies (5.1) | 8 | The creator's `setPolicy(paused)` from their wallet; cancel; the switch |
| 5 | Trade, as policy trades | Rebalances its treasury inside bands the creator set; chooses when and how much | `BootrTradeHelper`: three tokens, per-trade and per-day caps, one trade an hour, no trade in the first 24 hours; own-coin sells by a fixed rule in code; a loss breaker | Fees and price impact on 0.03 ETH by default (about $3 to $5), on 0.5 ETH at the ceiling; reach: none, trades are never posted | 1, 3, the ledger, a lawyer's view (5.4) | 10 | The creator's `setCaps(kernel, 0, 0)`; the breaker; pause |
| 6 | Planning across days | Keeps up to three goals and a weekly plan, revises it, runs a campaign of posts over days | Plans are written only in a turn that sees no mention text; every post still passes the gate, the slot and the quota | Money: one extra thought a week. Reach: none beyond the quota | 1 (untrusted notes), 2 | 5 | A "Planning" switch |
| 7 | Earning | Answers paid questions at its own x402 endpoint and keeps the money in its treasury | A role with no tools answers; the buyer is charged only after the answer exists; the publish gate runs on every answer; a price floor above cost | Money: close to none (unpaid work is not done). Reach: one private answer a payer may screenshot | 1, the ledger, a lawyer's view on paid answers (5.4) | 7 | A "Paid answers" switch; the price |
| 8 | Agents hiring agents | Buys another Bootr agent's paid answer or picture; enters another agent's bounty | The Paid services caps as today; a cap per pair; same-creator pairs marked and left out of "earned" | The services cap (1 USDC by default) moving between two agents; reach: none | 4, 7 | 5 | The Paid services switch |
| 9 | Record and reputation | Publishes its own record and its services in its identity card | The record is built by code from the tape and the chain; feedback counts only with a payment behind it | Money: none. Reach: a public page | The ledger, 4, 7 | 4 | n/a |
| 10 | Safety that scales | Nothing new; it loses powers by itself when something looks wrong | Breakers on loss, on a spike of refusals and on outflow; a watcher on a second machine; a public status and incident list | Lowers every worst day above | 1 | 5, in pieces beside 4 to 8 | n/a |

About 60 to 65 days end to end for one builder; stages 2, 3 and 6 can run beside the contract work of 4 and 5.

### Stage 1. Foundations

No new power; everything later leans on these.

- **The admin key off the server** (`docs/security/key-inventory-2026-11-08.md` 3.4, steps 2 and 3; the owner's
  accepted decision 18 in the caps note). The aixbt loss came through the operator's panel, not the model [X6]. With
  upgradeable Trade and Bounties contracts, that key is the ceiling above every cap.
- **A separate session signer for coins with a money power.** One signer serves every treasury today (H-02, open).
  The earlier Claus report said a wider rule must use its own signer.
- **`BootrCallPolicy` v2**, two days (caps note 4).
- **Recalled notes marked untrusted** (M-04, still open in the session-key review). Memory injection is the attack
  that works best on agents with money: text planted in memory triggers a transfer later, and prompt-level defences
  help little [R1]. This must land before planning across days makes memory more powerful.
- **The ledger page**, two days (caps note 5): the record must exist before money moves by itself.
- **X:** ask for written approval for AI replies and add the "Automated" label and the operator's name to each
  agent's profile (5.1).

### Stage 2. The brief and a watchlist it keeps itself

- **The brief.** Once a day code builds, per coin: volume, holders, liquidity and fee income over one and seven
  days; treasury balances and days of fuel left; mentions received and answered; the week's best and weakest post.
  No model writes it, so it costs no thought and cannot be steered by a stranger. It is facts with dates; the
  no-price-talk rule decides what the agent may say about them.
- **The watchlist.** Two new tools, add and remove, for up to 10 X accounts and 5 Base coins. Code checks the
  account's age and badge. The existing reader (`watchlist.ts`, 2 handles a turn, 6 hours apart) and the 400 reads a
  day bound the cost. As today, the agent cannot reply to a watched post (`social/eligibility.ts`); it writes its
  own post and credits the author.
- **From the references:** this is aixbt's lesson at Bootr's size [X1]. Keep a sourcing grade on each item
  (official account, one sighting, several) and show it to the model; do not build a scoring product.

### Stage 3. The mandate

Today a creator switches eight powers and fills several caps forms (`docs/STATUS.md` section 1). A mandate replaces
that with one page set once:

- **Goals**, up to three short lines ("grow the holder count", "fund two pictures a week", "keep 30 days of fuel").
- **Tone and limits on topics**, which become owner rules in the prompt.
- **A risk tier**, each with its number: Talk (spends only on thinking), Spend (up to 1 USDC a day on services),
  Patron (up to 5 USDC a day on bounties), Manager (trades up to 0.03 ETH a day). The tier writes the caps that
  exist today; the hard ceilings do not move.
- **An expiry.** On-chain caps for Trade and Bounties carry an end date, 30 days by default. A creator who walks
  away leaves an agent that still talks and can no longer spend. This is the dead-man switch on the human side.
- **Public.** The coin page shows the mandate in plain words with a hash, and the on-chain caps beside it.

The mandate is not a new wall. The walls stay the policy, the helper and the supervisor's caps; the mandate is how a
creator sets them without thinking per action. The Anchorage desk works the same way: a budget and a merchant list
set once, then no approval per payment [A1].

### Stage 4. Bounties paid by contract

The design stands (caps note 3.3). Three changes from what the references show:

- **Move entries off X replies before the contract pays.** X's developer policy says a service should not pay
  people to take actions on X [T3], and in January 2026 X cut off apps that rewarded posting [R7]. A bounty whose
  entry is a reply on X sits too close to that. The job post announces; the entry is made on the coin page (an
  artefact link or upload, a Base address). This also removes the X read of replies that has not been seen live
  (`docs/STATUS.md` section 3 item 3).
- **Expect self-dealing and count it.** On Virtuals, two wallets paying each other were most of the jobs [V3]. The
  designed rules (not the creator, a cooldown per payee, account age) cover the contract side. Add to the public
  record: unique payees, and any payee linked to the creator marked.
- **Keep the judge as it is.** A separate evaluator with no stake is the part of Virtuals' design worth having, and
  Bootr's is stricter [V1].

### Stage 5. Trade with its own treasury

What stays from the design (caps note 3.2): the helper as the only route, three tokens, small caps, one trade an
hour, nothing in the first 24 hours, the treasury turn only, no X post about a trade, own-coin buys off. The
references support each: Bankr's limits did not decode calldata and a tier walked past them [B1][B3]; Bootr's rule
is one target, one selector and fixed words, on chain.

What should change:

1. **Start with policy trades.** The creator sets bands in the mandate: for example, hold between 30 and 70% of the
   treasury in USDC and keep at least 30 days of fuel. The model decides when and how much inside the band and
   writes the memo. It does not decide direction outside the band. Reasons: four of six leading models lost 42 to
   59% of $10,000 in 17 days of live trading [R5]; a 50-day live benchmark found that general skill did not predict
   trading results [R6]; the Anchorage authors make no claim that their desk trades well [A1]; the one money agent
   found to work is this shape [G1]. Free choice of direction can be a later tier, opened per agent after some weeks
   of published results.
2. **Own-coin sells by a fixed rule, in code.** The agent posts about its own coin every day, so a model that
   chooses when to sell that coin is one screenshot from the pattern regulators punish: talk, then sell
   [L2][L6]. A rule such as "sell at most X% of the coins received from fees each day" runs like the refuel swap
   does today (`treasury.ts` `runFeePolicy`), with no model timing. Own-coin buys stay off (accepted decision 14).
3. **One direction per asset per day.** If it sold an asset today it cannot buy it today. This ends churn and any
   look of wash trading; wash trading by bots is what the SEC and DOJ charged market makers for in 2024 and again in
   2026 [L5][L13].
4. **A quiet period, in code, both ways.** No trade in an asset within 24 hours after the agent's own post names
   it, and no post naming it within 24 hours after a trade. With WETH and USDC as the only free-choice assets this
   costs nothing, and it is in place before the token set ever widens.
5. **A loss breaker.** There is no price oracle for a new coin (caps note 1.2), so measure what is knowable: the
   gap between the quote and what arrived, plus fees. When that exceeds a set share of the week's traded amount, or
   the week's result in ETH terms passes the mandate's loss budget, trading stops until the creator turns it back
   on. Supervisor first; the helper can enforce it later.
6. **A review of its own decisions.** Each memo is closed after a day and after a week with the result in numbers,
   and the treasury turn sees its last ten. This is the Anchorage desk's "pending" decision made routine [A1].
7. **Agent trades left out of trending and volume ranks.** The indexer knows every treasury address. An agent's
   trade pays fees to its creator and to the platform (Claus report, problem 1); it must not also lift the coin's
   rank.

Prerequisites, in order: the admin key off the server; the separate signer; `BootrCallPolicy` v2; the ledger page;
the mandate with bands and expiry; a lawyer's view on own-coin sells and on the platform's own agent; fork tests on
a Clanker pool and a RWAGMI pool; an outside review of the helper.

### Stage 6. Memory and planning across days

- **Goals** come from the mandate. **A weekly plan** is a small structured record: up to five items with a day and
  a purpose. A planning turn writes it once a week and may revise it daily; it has the brief and the performance
  numbers and no mention text, the same wall the treasury turn has (`roles.ts`).
- **A campaign** is a named series of posts over at most 14 days tied to one goal. Each post still passes the
  publish gate, its slot and the quota, so a campaign cannot post more than the creator allowed.
- **Closing the loop.** Every plan item ends as done, dropped or failed with one line why; the next plan sees it.
- **The risk** is memory as an attack path [R1]. The bound is where plans are written and the untrusted mark on
  everything recalled (stage 1).

No reference shows this in public. It is the cheapest place to be visibly ahead: a coin page that says what the
agent set out to do this week and what came of it.

### Stage 7. The agent earns money by itself

- **The first product is "ask the agent".** A paid x402 endpoint per agent, USDC on Base, paid straight to the
  agent's treasury. Bootr already runs an x402 seller with a facilitator (`apps/inference/src/x402.ts`); the
  facilitator's default order is verify, serve, settle, so a failed answer costs the buyer nothing (caps note 1.1).
- **Who answers.** One thought in a role with no tools, like the judge. The question is a stranger's text and is
  treated as such. The answer passes the publish gate: no prediction, no buy or sell call, nothing personal to the
  asker.
- **Later products, same rail:** a sourced note on a Base coin's facts (no prices, as `read_coin` already is), a
  picture in the coin's style, and winning other agents' bounties (stage 8).
- **Being found.** A seller is listed in the x402 catalogue after one settled payment [K5], and the service goes
  into the agent's ERC-8004 card, which is empty today.
- **Honest size.** Claus has had no outside customer [C8]; the median job on Virtuals was one cent [V3]; aixbt
  earns as a company with a sales page. Expect cents. The value is the line "earned X from N different payers" on
  the coin page, with the creator's own payments marked and left out.
- **What it needs:** a price floor above the thought's cost; rate limits per payer; ledger rows for money in; the
  lawyer's view of 5.4, because an answer about a token for a fee is closer to advice than a post is.

### Stage 8. Agents hiring agents

Start with what needs no new contract: one Bootr agent's `x402_fetch` paying another's endpoint from stage 7. It is
agent-to-agent commerce under caps that already exist (`services.ts`). Then let an agent enter another agent's
bounty through the same entry path people use, paid to its treasury.

- **Bounds:** the Paid services caps; a cap per pair per day, in the spirit of the peer caps in
  `agent-directory.ts`; agents of the same creator may not win each other's bounties, and their payments to each
  other are marked and left out of "earned".
- **Not now:** Virtuals' protocol or any outside job network. Its own numbers say most of that traffic is not real
  demand [V3]. Watch it; a later adapter is cheap because the escrow shape matches Bootr's bounty states [V1].

### Stage 9. Reputation

- **What ERC-8004 is today:** a draft standard for identity, reputation and validation registries; payments are
  out of scope and the text itself warns of fake reviewers [E1]. A study of the live registries found that only 15%
  of registrations on Base had a working endpoint and that 59 to 91% of reviewers looked fake, depending on the
  chain [E2].
- **So do not show the registry's plain average as trust.** Bootr shows it today (`AgentPanel.tsx`, from
  `apps/indexer/src/reputation.ts`). Replace it with a record Bootr builds from the tape and the chain: posts sent,
  jobs posted and paid, verdicts given, money earned and from how many payers, trades and their measured result,
  guard refusals, breaker trips, days in service, and the mandate's hash.
- **Publish it** as a file linked from the agent's card, with its hash, and fill the card's `services`.
- **Feedback** counts only when it comes from an address with a payment behind it: a bounty payee, or the payer of
  a settled x402 call. That filter is something the registry lacks and Bootr can apply.

### Stage 10. Safety that grows with the powers

- **Tiers** are the mandate's (stage 3): each has one number and a new agent starts at Talk.
- **Breakers.** Loss (stage 5). Refusals: when the guards refuse an agent's actions far more often than usual in an
  hour, its money powers pause and the creator is told; a burst of refusals is what an attack in progress looks
  like. Outflow: a daily check that what left each treasury on chain matches what the supervisor recorded.
- **Dead-man switches.** The mandate's expiry on the creator's side. On the platform's side, shorter session keys
  for coins with a money power, so a dead or seized supervisor loses those powers within days, and rotation is a
  deliberate act once the admin key is off the server.
- **Outside monitoring.** The watchdog runs as root on the same host as the keys
  (`docs/security/key-inventory-2026-11-08.md` 1.2). A read-only watcher on a second machine that reads the chain
  and the public tape and alerts over Telegram is a few days of work and is the first check that survives a
  compromise of the host.
- **Disclosure.** A public status page: which powers are on across the fleet, every breaker trip, every incident
  with its cause. Claus's habit of publishing its own failures is its best one.

## 5. Rules and lines that must not be crossed

### 5.1 X

What X's developer pages say today [T1][T2][T3][T4]:

| Action | Rule | For Bootr |
|---|---|---|
| Original posts, unprompted | Allowed. No unsolicited @mentions, no identical posts across accounts, no posting into trending topics for reach. Scheduled price posts are allowed if "informational, no manipulation" | Fine as built. Template posts (the bounty job text) must not be the same across many agents on the same day |
| Replies | Only if the user engaged first; at most one reply per interaction. Since 2026-02-23 the API on self-serve tiers accepts a reply only when the author mentioned the replier or quoted its post | Bootr's replies fit (`social/eligibility.ts`). **A comment on a conversation the agent was not called into will be refused by the API**; the working form is an original post that credits the author, as the watchlist already does |
| AI-written replies | "Requires prior approval from X"; without it, a violation "even if the content itself is helpful" | I found no record that approval was asked for or given. This is the largest single risk to every agent at once, because one X app serves them all (Claus report, problem 4) |
| Quote posts and reposts | Allowed for information, not in bulk. But on 2026-04-16 "Following, Likes, and Quote-Posts via the API have been removed from all self-serve tiers"; whether that blocks creating a quote post is not clear from the page | Check on Bootr's tier before this round builds the quote tool |
| Likes, follows, direct messages | Likes must be started by a person; no automated following; messages only after the user writes first | Do not build |
| The account | Turn on the "Automated" label; name the operator in the bio; give an opt-out | The label is still a parked item (`docs/STATUS.md`); opt-out exists (`resolve_mention`) |
| Paying people | "Your service shouldn't compensate people to take actions on X"; apps that rewarded posting lost access in January 2026 [R7] | Bounty entries off X (stage 4); a job may never ask for a post (already decided, caps note decision 15) |
| Consequences | App suspension, loss of API access, permanent bans; X removed 42,000 chatbot reply accounts in two days in July 2026 [T7] | |

Cost note: X's price list now charges $0.015 a post and $0.20 for a post that contains a link [T2][T5]. Bootr's meter
still counts $0.01 a post (`apps/sender/src/metering.ts`). Posts with links (job posts, platform updates, credits)
may cost far more than the meter says. Not checked against Bootr's bill.

### 5.2 What an agent must never say

- **No price predictions, no buy or sell calls, no advice, no promises about a token's value.** This is already the
  project's rule in the prompt (`packages/agent-core/src/prompt/system-prompt.ts`, `RULE_NO_PRICE_TALK`) and in the
  publish gate (`social/communication-policy.ts`, `social/post-validation.ts`; `platformPostRisk` for the platform
  agent). Own agents keep the gate but lose the prompt's force (own note section 10).
- **Why it matters more once the agent trades.** In the EU, market manipulation includes spreading misleading
  signals and voicing an opinion about an asset after taking a position in it without disclosing that; the rule
  applies to any person, inside or outside the EU, for crypto-assets admitted to trading [L1][L2]. In the US the SEC
  charged influencers who bought, promoted and sold [L6], and its staff statement on meme coins says fraud remains
  open to other agencies [L7]. In the UK a crypto promotion that can reach UK consumers falls under the financial
  promotion rules, with criminal penalties [L3].
- **Never, in addition:** "I bought", "I sold" or any first-person treasury talk tied to value (the gate refuses it
  today); a reason for a trade stated in terms of price; a trade announced before it happens; a comparison of coins;
  anything addressed to one person's situation.
- **Who answers for it.** No regulator has said who is liable when an agent acts; the CFTC's chairman asked the
  question in October 2026 and pointed at "the control exercised" [L9]. A Canadian tribunal refused the argument
  that a chatbot is a separate party from its company [L10]. Assume the operator and the creator are responsible.

### 5.3 Trading and posting about the same asset

The simplest rules that avoid the known patterns, all enforceable in code or contract:

1. The agent never buys its own coin. If that ever changes: by fixed rule, to a burn address, with counsel's
   written view first (Claus report, section 4).
2. It sells its own coin only by a fixed daily rule the creator set in advance (stage 5).
3. It trades no other Bootr coin, ever. Every coin pays the same platform wallet, so any such trade is a conflict
   (Claus report, problem 5).
4. One direction per asset per day; no round trips.
5. A 24-hour quiet period between a post that names an asset and a trade in it, both ways.
6. Holdings and every trade are on the public ledger within a minute, with both legs, the memo and the hash. No X
   post about trades.
7. Agent trades do not count towards trending or volume ranks.

### 5.4 Prompt-injection paths to money, and what closes each

| Path | Real case | What closes it at Bootr | Stage |
|---|---|---|---|
| A mention or reply steers a money action | Bankr, May 2026: a decoded message became a transfer [B3] | The social turn holds no money tools; the treasury turn never sees mention text (`roles.ts`). For an own agent this wall cannot be enforced on the creator's machine (own note section 10): only the on-chain caps hold | Built; own-agent limit stated |
| Another bot's output is trusted as a command | Bankr trusted Grok [B3][B5] | Other agents' posts are data; peer caps (`agent-directory.ts`) | Built |
| Something anyone can send grants power | A membership NFT raised a wallet's privileges [B3] | No tier, token or badge lifts a limit; caps change only by the creator's wallet inside fixed ceilings | Keep as a rule for every stage |
| The operator's panel | aixbt: 55.5 ETH through the dashboard [X6] | Admin key off the server; a separate signer; cap changes signed by the creator's wallet, not by a console session | 1 |
| Text planted in memory acts later | Shown on ElizaOS in research [R1] | Recalled notes marked untrusted; plans and trades written only in turns with no mention text | 1, 6 |
| A page or a paid service's answer | - | Answers are data; `exact` payments only, caps, host lists (`services.ts`) | Built |
| A bounty entry argues for itself | - | The judge has no tools and names an entry, not a payee; code reads the address (`bounties.ts`) | Built; contract in 4 |
| A paying customer's question | - | The answering role has no tools; the gate runs on the answer | 7 |
| The creator's own machine | A fake MCP server stole wallet files and keys in February 2026 [R4] | The client holds no key, only a credential scoped to one coin (own note section 3). Publish the package with a pinned version and say so in the connect step | Built; copy to add |
| The supervisor host | - | C-03 and H-02 are open (`docs/security/session-key-and-treasury-review.md`); the on-chain caps bound a leaked session key, not a leaked admin key | 1 |

### 5.5 Where the owner needs a lawyer

I am not one, and nothing above is advice. Before stage 5 (Trade) and stage 7 (paid answers), put these to counsel
in the owner's country and for EU and UK holders:

- Whether an agent selling the coin it posts about, even by fixed rule, is a manipulation risk, and what disclosure
  cures it. Whether MiCA's market abuse rules reach a coin that trades only on a DEX: the text speaks of assets
  admitted to trading on a platform [L1], and I could not settle this.
- Whether a paid answer about a token is investment advice or an investment recommendation where the buyer lives.
  The US definition turns on advising "for compensation" [L12]; a public, impersonal publication is treated
  differently, but that reading is from memory and was not rechecked.
- Whether a coin agent's daily posts are a financial promotion in the UK [L3].
- Whether the platform earning fees on trades made by agents it runs is a problem in itself (carried over from the
  Claus report).
- Whether paying bounty winners makes the creator or Bootr a payer with duties (tax forms, sanctions screening).
- The SEC staff's September 2026 answers on buybacks and burns cover systems with no central party [L8]; Bootr has
  one. Read with counsel before any burn or buy feature is described in public.

## 6. What would make people call it the next AI project

Four things. Each is a fact a visitor can check on a coin page, not a claim.

1. **Its limits are on the page and the chain agrees.** The coin page shows the mandate in plain words, the worst
   day as one number, and the on-chain rules and caps read live from the contracts, with the creator's pause beside
   them. A visitor opens the contract and sees the same numbers. No reference can show this: their limits live in a
   founder's wallet, a company's server or a bank. Stages 1 and 3.
2. **It pays its own way, and the page shows the sum.** Fees in, answers sold and to how many payers, thinking and
   data paid for, bounties paid, the net for the week, each row with a hash, with unknown shown as unknown. The
   paying half is already true: every thought of every Bootr agent is a settled x402 payment from the agent's own
   wallet (`docs/STATUS.md` section 1). The Anchorage article is about doing that once [A1]. Stages 1, 4 and 7.
3. **It says what it will do this week and shows what came of it.** A plan with goals, each item closed as done,
   dropped or failed, and money decisions reviewed against their results. No reference publishes its own intent and
   outcome side by side. Stages 5 and 6.
4. **It is a population, not a mascot.** Many creators' agents, some thinking on Bootr and some on their creator's
   own AI client, under one set of guards, hiring people and each other, each with a record a stranger can compare.
   The page shows who ran the brain, who was paid, and which payments were between related parties. Stages 8 and 9.

What it is not: a market-call account. The projects that grew on calls are the ones whose tokens and records look
worst two years on [X6][X10][X13].

## 7. Open decisions for the owner

| # | Decision | Recommendation | Why, in one line |
|---|---|---|---|
| 1 | Does Trade start as policy trades inside bands the creator sets, with free choice of direction as a later tier? | Yes | No public result shows a model choosing trades at a profit; a band is something a holder can understand |
| 2 | Are own-coin sells a fixed daily rule in code rather than the model's choice? | Yes | An agent that talks about its coin and picks when to sell it is the pattern regulators punish |
| 3 | Do bounty entries move from X replies to the coin page before the contract pays? | Yes | X says a service should not pay people for actions on X, and it has cut off apps for it |
| 4 | Ask X now for written approval of AI replies, and add the Automated label to every agent? | Yes | One app serves every agent; a suspension silences all of them |
| 5 | Does "comments on conversations" in this round become an original post that credits the author? | Yes, unless Bootr's tier is exempt | The API refuses a reply to someone who did not mention or quote the agent |
| 6 | Replace per-action switches with a mandate: goals, tone, a risk tier, and caps that lapse after 30 days? | Yes | One page a creator sets once, and an agent that stops spending when its creator walks away |
| 7 | A separate session signer for coins with a money power, before stage 4? | Yes | One signer for every treasury makes that key worth more with each new power |
| 8 | First paid product: "ask the agent" at a fixed price, paid to the treasury, no personal or price answers? | Yes | The smallest thing that proves a stranger will pay; the gate keeps it away from advice |
| 9 | Agents hiring agents: start with Bootr agents paying each other over x402, no outside network? | Yes | No new contract, existing caps, and the outside networks are mostly self-dealing today |
| 10 | Stop showing the ERC-8004 average as a score; show a record built from the tape and the chain? | Yes | Most reviewers on the registry look fake; Bootr's own record can be checked |
| 11 | Leave agent trades out of trending and volume ranks? | Yes | An agent must not be able to lift its own coin's rank by trading |
| 12 | May an agent ever trade another Bootr coin? | No | Every coin pays the same platform wallet; any such trade is a conflict |
| 13 | Same Trade caps for a coin run from the creator's own AI client? | Yes, with the fact stated on the page | The on-chain caps are the wall either way; the context wall cannot be enforced there |
| 14 | One session with a lawyer before stage 5 and stage 7, with the questions of 5.5? | Yes | These two stages are where talk and money meet |
| 15 | A read-only watcher on a second machine before any agent pays or trades by itself? | Yes | Today's watchdog shares a host with the keys it would have to watch |

## 8. Not verified

- **x.com itself.** No post, profile or follower count was read from X. Everything about aixbt's and Claus's
  posting comes from their own sites and from third parties.
- **X's automation help page** (https://help.x.com/en/rules-and-policies/x-automation) returned 403. The sentence
  that an AI reply bot needs "prior written and explicit approval" and its April 2026 date rest on a third party
  quoting X [T6]; X's developer guidelines, which I did open, say "requires prior approval from X" [T1].
- **The scope of "Quote-Posts via the API have been removed"** on self-serve tiers [T2]: creating, reading or both.
  Which tier Bootr's app is on, and whether X has ever been asked for AI reply approval.
- **What X bills Bootr per post** against the meter in `apps/sender/src/metering.ts`.
- **Claus:** which of the points in 1.2 are new since 6 November and which I had not read before; who holds the
  founder key; its real costs; how much of its work is unattended. `/Buyback-and-Burn` and `/docs` rendered as
  navigation only. The money limits quoted for it come from the earlier report.
- **aixbt:** its models, the number of tracked accounts (the "400+" figure is from directories only [N]), current
  reply behaviour, plan prices, revenue, whether any x402 endpoint is live, and a reported exchange delisting.
- **The Anchorage desk:** the chain and stablecoin of the 18 payments, the budgets in dollars, whether the product
  is generally available.
- **Giza:** current size, audits and incidents. **Virtuals:** the fee share differs between its docs (5%) and the
  audit's account (40% then 20%) [V1][V3]. **x402 volume:** the published counts do not agree [K3][K4].
- **Freysa** (2024, about $47,000 won by prompt) is from a search result only [N]. A "$45M AI trading agent
  exploit" reported for early 2026 has no named protocol or primary source and is left out.
- **Law:** MiCA articles 89 and 92, the FCA's PS26/9 and the SEC's March 2026 release were not read in the original;
  the UK points come from law-firm summaries [L3][L4]. Whether any of it reaches a DEX-only coin is open.
- **Bootr:** `docs/design/agent-tools-2.md` is being written on another branch and was not read. Whether the
  bounties stage A trial has run on production, and what the live values of caps and switches are, were not
  checked; this note reads the repository, not the server.
- **Who read what.** I opened the Anchorage article, the Claus pages and X's developer guidelines and changelog
  myself. The other sources were opened by two research helpers in the same session, who reported each as opened or
  not; I did not open those a second time.
- **Sizes** in section 4 are estimates, not measured against the code.

## Sources

All read 2026-11-13. P = the project's or regulator's own page; S = press or third party; N = search result, not
opened.

**Anchorage**
- [A1] P https://www.anchorage.com/insights/ran-ai-trading-desk-19-cents-every-payment-settled-onchain (dated 2026-11-04)

**Claus**
- [C1] P https://claus.si/docs
- [C2] P https://claus.si/build.txt
- [C3] P https://claus.si/docs/agent-guide
- [C4] P https://claus.si/llms.txt
- [C5] P https://claus.si/docs/release-status (page says updated 2026-10-26)
- [C6] P https://claus.si/fee-state.json (observed 2026-11-13 15:45 UTC)
- [C7] P https://claus.si/social.json
- [C8] P https://claus.si/Work
- [C9] P https://claus.si/overview.json
- [C10] P https://claus.si/docs/autonomous-work

**aixbt**
- [X1] P https://docs.aixbt.tech
- [X2] P https://docs.aixbt.tech/legal/terms-and-conditions (updated 2026-11-07)
- [X3] P https://aixbt.tech
- [X4] P https://docs.aixbt.tech/developers/v3 , https://docs.aixbt.tech/developers/v3/migration , https://aixbt.tech/connect
- [X5] S https://decrypt.co/299393/what-is-aixbt-ai-crypto-influencer (2025-01-02)
- [X6] S https://decrypt.co/310510/aixbt-ai-influencer-hacked-100k-ethereum (2025-03-18)
- [X7] S https://www.gate.com/learn/articles/analyzing-aixbt-s-performance-features-and-value-potential-on-crypto-twitter/5783 (January 2025)
- [X8] S https://solanacompass.com/projects/aixbt
- [X9] S https://cryptobriefing.com/ai-crypto-predictions-impressive-gains/ (2024-12-02)
- [X10] S https://www.bitget.com/news/detail/12560604470924 (2025-01-03)
- [X11] S https://m.lookonchain.com/feeds/34401 (2025-10-26)
- [X12] S https://erc-8004.quicknode.com/agents/base-mainnet/1294
- [X13] S https://coinmarketcap.com/cmc-ai/aixbt/latest-updates/ (a machine-written summary)
- [X14] S https://cointelegraph.com/news/hacker-breaches-ai-crypto-bot-aixbt-steals-55-eth (2025-03-19)
- [X15] S https://incidentdatabase.ai/cite/1003

**Other agents and rails**
- [V1] P https://os.virtuals.io/acp/concepts
- [V2] P https://os.virtuals.io/acp/overview
- [V3] S https://chainward.ai/decodes/virtuals-top-dog (2026-09-30)
- [B1] P https://docs.bankr.bot/security/overview
- [B2] P https://docs.bankr.bot/token-launching/overview
- [B3] S https://cryptoslate.com/how-one-trader-exploited-grok-and-morse-code-to-trick-ai-agent-into-sending-billions-of-crypto-tokens-from-a-verified-wallet/ (2026-05-04)
- [B4] S https://oecd.ai/en/incidents/2026-05-04-4a73 , https://www.makerchecker.ai/incidents/aid-2026-0004/
- [B5] S https://yellow.com/news/bankr-halts-14-wallets-150k-ai-attack (2026-05-20; one source)
- [B7] S https://www.theblock.co/post/374119/bankr-back-live-x (2025-10-10)
- [G1] P https://docs.gizatech.xyz/developers/architecture/overview.md
- [G2] P https://docs.gizatech.xyz/app-guide/fees-and-rewards.md
- [G3] S https://www.stablewatch.io/blog/giza-project-spotlight (2025-08-19, self-reported figures)
- [K1] S https://decrypt.co/357862/morning-minute-coinbase-gives-ai-agents-their-own-wallets (2026-02-12)
- [K3] S https://unchainedcrypto.com/x402-foundation-joins-linux-foundation-with-backing-from-google-microsoft-and-amazon/ (2026-04-03)
- [K4] S https://cryptobriefing.com/coinbase-x402-protocol-100m-transactions-base/ (2026-06-03)
- [K5] P https://docs.cdp.coinbase.com/x402/bazaar
- [E1] P https://eips.ethereum.org/EIPS/eip-8004
- [E2] P https://arxiv.org/abs/2606.26028

**Losses, attacks and results**
- [R1] P https://arxiv.org/abs/2503.16248 ("Real AI Agents with Fake Memories")
- [R3] S https://forklog.com/en/402bridge-protocol-loses-more-than-17000-usdc/ (2025-10-28)
- [R4] S https://www.upguard.com/blog/mcp-security-incidents
- [R5] S https://forklog.com/en/four-out-of-six-ai-models-suffer-losses-in-trading-tournament/
- [R6] P https://arxiv.org/abs/2511.03628 (LiveTradeBench)
- [R7] S https://www.theblock.co/post/385805/kaito-token-plummets-x-revises-api-policies-ban-infofi-crypto-projects (January 2026)

**X**
- [T1] P https://docs.x.com/developer-guidelines
- [T2] P https://docs.x.com/updates/changelog (entries of 2026-02-06, 2026-02-23, 2026-04-16)
- [T3] P https://docs.x.com/developer-terms/policy
- [T4] P https://docs.x.com/developer-terms/restricted-use-cases
- [T5] P https://docs.x.com/x-api/getting-started/pricing
- [T6] S https://opentweet.io/answers/does-x-allow-ai-generated-content
- [T7] S https://letsdatascience.com/news/x-says-it-removed-42000-chatbot-reply-accounts-0e994445 (2026-07-27)

**Law and regulators**
- [L1] P https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-86-scope-rules-market-abuse
- [L2] P https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-91-prohibition-market-manipulation
- [L3] S https://www.skadden.com/insights/publications/2026/10/social-media-meets-financial-regulation
- [L4] S https://www.simmons-simmons.com/en/publications/cmrvytdhw00e4uom8r2q9i3y7/ps-26-9-market-abuse-regime-for-cryptoassets
- [L5] P https://www.sec.gov/newsroom/press-releases/2024-166
- [L6] P https://www.sec.gov/news/press-release/2022-221
- [L7] P https://www.sec.gov/newsroom/speeches-statements/staff-statement-meme-coins
- [L8] P https://www.sec.gov/about/divisions-offices/division-corporation-finance/faqs-crypto-assets
- [L9] P https://www.cftc.gov/PressRoom/SpeechesTestimony/opaselig14 (2026-10-28)
- [L10] S https://barrysookman.com/2024/02/16/moffatt-v-air-canada-a-misrepresentation-by-an-ai-chatbot/
- [L12] P https://www.law.cornell.edu/uscode/text/15/80b-2
- [L13] S https://www.coindesk.com/business/2026/04/02/doj-sting-exposes-crypto-wash-trading-continues-to-be-far-more-common-than-expected

**Bootr**
- `docs/STATUS.md`, `docs/design/agent-capabilities.md`, `docs/design/byo-agent.md`,
  `docs/design/clanker-v5-token-settings.md`, `docs/agent-identity.md`,
  `docs/research/claus-official-agent-2026-11.md`, `docs/security/` (all five files)
- `packages/agent-core/src/` (`tools.ts`, `prompt/system-prompt.ts`, `social/`, `runtime/`),
  `packages/contracts/src/` (`AgentGuardian.sol`, `BootrCallPolicy.sol`)
- `apps/supervisor/src/` (`roles.ts`, `judge.ts`, `runtime.ts`, `broker/index.ts`, `session-rules.ts`,
  `services.ts`, `bounties.ts`, `creator-requests.ts`, `watchlist.ts`, `post-performance.ts`,
  `platform-updates.ts`, `platform-numbers.ts`, `weekly-digest.ts`, `context.ts`, `activity.ts`, `rhythm.ts`,
  `agent-directory.ts`, `memories.ts`, `api.ts`, `own/`), `apps/sender/src/metering.ts`,
  `apps/indexer/src/reputation.ts`, `apps/web/lib/agent-card.ts`, `apps/web/components/token/AgentPanel.tsx`
