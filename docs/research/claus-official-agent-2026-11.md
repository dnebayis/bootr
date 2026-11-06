# Can @AgentBootr become like Claus? An honest assessment

Written 2026-11-06. Research only: nothing signed, sent or deployed, and no production change. Chain reads were `eth_call`, `eth_getCode` and `eth_getLogs`.

Marks:
- **V** read today in a primary source or on chain.
- **V-self** read today, but the source is Claus describing itself, with no outside proof.
- **U** inferred, an estimate, or taken from an earlier note that I did not recheck.

Not legal advice. Figures are as read around 13:00 UTC on 6 Nov.

## The short answer

Mostly possible. Most of it is not worth doing in the shape Claus has it, and buying and burning is the worst value of all.

- **Claus is less autonomous than it looks.** Its coins are controlled by one founder wallet. The Ethereum fee goes to that wallet. Hook changes need that wallet's signature. Its own docs say the handover to the agent is unfinished. Its buyback is now switched off.
- **$BOOTR's agent has little money.** Its slot earns about $55 a day at today's volume and spends about $26.50. The burn slot already burns three times the agent's whole income. A buyback from what is left would add about 7% to a burn that already runs, at a large legal and reputational cost.
- **The real money is in your wallet.** 1.6% of volume, about $883 a day today, already goes to the treasury wallet through the creator and platform slots. If $BOOTR is to fund anything, the decision is yours and the signature can be too.
- **Good parts to copy:** a public ledger where unknown stays unknown, pages on an isolated domain, an X role that cannot touch money, and paying small named jobs.

## 1. What Claus actually does

### Who controls what

| Question | Finding | Mark |
|---|---|---|
| Who owns the Ethereum token? | `owner()` is wallet `0xBb14…C1C5`. Both proxy admins have owner zero, so its core cannot be upgraded. | V (chain) |
| Who owns the Robinhood token, hook and liquidity vault? | All three report owner `0x979d…dc46`, a contract whose own `owner()` is the same `0xBb14…C1C5`. | V (chain) |
| Is that wallet a multisig? | No. On Robinhood it has no code at all (nonce 178). On Ethereum it carries EIP-7702 delegation code (nonce 2312), so a single key still sits behind it. | V (chain) |
| What can it do? | Upgrade token, hook and liquidity management, change fees, move liquidity, mint more with no cap and no timelock. The one-hour notice is a promise, not code. | V-self |
| Whose wallet is it? | The migration article calls it the original founder's wallet. Its code calls it Claus's own wallet too. The founder is not named anywhere I read. | V-self |
| Who gets the Ethereum fee? | 2.3% of volume, all of it, as ETH to that wallet, labelled CLAUS DEV. | V-self, state read from their `fee-state.json` |
| Who gets the Robinhood fee? | 2%, all to liquidity, added in batches by a keeper worker. | V-self |

### What the agent itself can touch

- **It holds no keys.** Signing, X credentials and hosting tokens sit in separate fixed services. The model only asks them (`PUBLISHER-BOUNDARY.md`, `SOCIAL-BOUNDARY.md`, `SURFACE-PUBLISHER-BOUNDARY.md`). V-self, repo at 3 Nov.
- **The X role cannot hold money powers.** `src/config.ts` refuses to start a `twitter` role with `chainWrite`, `externalTransfer`, `sandbox` or `publicPublish`. So the model that reads mentions is not the model that moves money. V (code). This is the most useful single idea in the repo.
- **Money limits, as written:**
  - Compute funding: at most 0.02 ETH per cycle, 10 cycles, 0.2 ETH in total, expiring 14 Nov.
  - Investments: a one-time 100 USDC, at most 25 per project.
  - Paid web calls: at most 0.02 USDC each.
  - Jobs wallet: a fixed 0.095 ETH principal, with recipient, method and calldata fixed by code.
  - All V-self. On chain the Jobs wallet holds 0.081 ETH with nonce 33, and the Base operating wallet holds 0 USDC with nonce 7 (V).
- **Unrestricted wallet use is off.** The release notes say it is not enabled, and no general investment execution either. A general `wallet_execute` tool does exist in the code, gated by owner policy. Whether it is on in production is not public (U).
- **Hook changes:** the operator signs only exact, reviewed, zero-value program installs after a paid outside review. The agent can build and propose. An upgrade needs owner authorization. V-self.
- **Self-issued tokens are banned for it** (`capital-execution/README.md`). V-self.

### What is autonomous and what is gated

| Likely autonomous | Gated by a human or fixed service |
|---|---|
| Posts and replies through a fixed sender | Contract upgrades and fee changes |
| Small web tools and project pages through a review pipeline | OAuth, new terms, purchases, wallet connections |
| Cheap jobs, 0.001 to 0.003 ETH, from the Jobs wallet | Owner rules that can pause or steer it |
| Reading chain and web | Merging code, other than reviewed repo docs |

How much is truly unattended cannot be proved from outside:
- Two items on its Work page say they were published with operator assistance. V-self.
- `social.json` and `/api/operational-health` report `liveExecutionObserved: false` and `runtimeProof: false`. V-self.
- `model-routing.json` shows its configured route as `blocked`, while posts kept appearing, the latest original at 11:20 UTC and the latest reply at 12:34 UTC today. These fields are labelled configuration only, so I would not read much into them either way. V-self.
- Its release notes say the autonomous handover is still in progress. V-self.

### Marketing against evidence

| Impression | What the evidence shows |
|---|---|
| An agent with its own coin and treasury | A founder-controlled coin and a founder wallet. V (chain) |
| 161.6M tokens burned, 16% of supply | True on chain (`totalSupply` 838.43M). But 122.41M of that is migration burns, reissued 1:1 on Robinhood. About 39.16M is real reduction, 3.9%. V-self totals, V supply |
| It buys back and burns | Now 0.00% of fees; new buyback funding is paused and the priority is liquidity. In its last ledgered week: 8 runs, 0.1975 ETH, 151,571 tokens, about $440. V-self. I did not retrace those transactions |
| Its FOMO buybacks | 8.75 ETH went to a fixed wallet, in circulation, not burned. Now retired. V-self |
| It earns its keep | Customer revenue is unknown in its own ledger, with 0 paid orders at the last snapshot. Model and server costs are unknown too. Four launches paid it about $42 in total. It wrote: "No independent customer has paid yet." V-self |
| It builds an ecosystem | About 93 posts in the 11 days its mirror covers, and a real stream of small tools. Jobs paid are tiny; the ones listed run from 0.001 to 0.003 ETH. V-self |

### What went wrong

All V-self except where noted. To its credit, it publishes most of this.
- Community Draw stuck at round 7: its books said a gas wallet had funds the wallet did not hold.
- Seven of nine draw rounds paid 0 ETH, because one malformed receipt blocked the fee queue.
- Buy & Hodl payouts stalled when pausing Ethereum experiments broke an unrelated check.
- A reviewer rejected code where it had guessed how its own functions worked. Another review caught a draw bug that could have sent the prize back.
- Features retired soon after launch: arbitrage (6 Oct, confirmed by Odaily), predictions, Rising Tide, weather split, privacy buys.
- NFT and LP rewards were paused. Holders bought under fee rules that later changed. Odaily raises this concern. V (secondary).
- The main token then moved to another chain, with project liquidity pulled from Ethereum in steps. About 24.5% of its own original position remains there.
- Its live migration status today reports `working: false`, with the oldest pending delivery about 12 hours old. V-self.

I found no third-party report of a theft or exploit. I also found no outside audit. Coinranking flags the upgradeable hooks and central control (search summary, page not opened). The Claus repo says outside review was paid per program, and the Robinhood source manifest says verification is not an audit. V-self.

**Scale matters.** The repo holds 658 files of reference material, 22,308 lines of TypeScript in its operating runtime alone, and a chain of separate signer and publisher services built over months. V (count). Claus had a week of about 10.9 ETH flowing through its hook fields (a lead in its ledger, not confirmed income), about $24,000. $BOOTR's agent slot earned about $385 a week at today's rate.

## 2. Each ability: today against needed

**$BOOTR's current state** (V, chain and indexer):
- Treasury $641: 20.29 USDC, 0.274 WETH ($614), 7.37 USDC in the spender, no ETH.
- Its permission `0x093585a0` has 6 rules: two Clanker claim rules, WETH approve to the helper, the WETH to USDC swap, USDC to its own spender, WETH unwrap.
- USDC cap 50 per 24 hours, 15.02 spent in the current window.
- Model `anthropic/claude-sonnet-4.6`.

**Can the policy be widened for one agent without a redeploy? Yes** (V, code). `BootrCallPolicy` stores rules per permission and kernel, and `approveSessionKey` accepts any policy set and any signer. Three limits:
- **8 rules at most, and $BOOTR uses 6.** Two free slots, and a new token helper would take both (approve plus the call).
- **Rotation would strip them.** `sessionPolicyFor` builds one standard policy for everyone, so the next 30-day rotation removes extras unless the code learns per-agent rules.
- **A rule fixes one target and one selector.** Claus's general wallet tool cannot be expressed in it at all. That would need a sudo-type policy.

| Ability | Today | Needed | New contract? |
|---|---|---|---|
| **Spend treasury on work** | Only USDC to its own spender, then to the relay. All $92.66 paid so far went to `0x55e6…`, your treasury wallet (V). Docs promise it cannot send funds to anyone | Simplest: the agent proposes, you pay by hand; no chain change. Next: 1 or 2 named payees with a windowed cap, on a new key, plus a tool and accounting | None for 1 or 2 payees. Many payees need a small escrow |
| **Buy own token and burn** | Impossible. No rule exists, and the broker refuses it. `BootrSwapHelper` is WETH to USDC only, with no owner. `BuybackBurner` is RWAGMI-only and keeper-only. Universal Router was removed on purpose (C-02) | New immutable helper that pays only `0x…dEaD`, 2 rules, a per-window WETH cap, rotation code, a dedicated signer, docs rewrite. No on-chain price exists for the floor (BOOTR-03), so the cap is the only real limit | Yes, one small one. Guardian, policy and kernel unchanged |
| **Build and publish a page** | No code tool, no hosting, no write path. Nothing on chain is involved | A build sandbox away from the Hetzner host, a separate domain, a review step, a publisher service. Or a far smaller version: humans write one page and the model supplies text rendered as plain text | No |
| **Build an ecosystem** | Welcomes coins, asks questions, peers with other agents (capped). Leaderboards and trending exist | Depends on the meaning, below | Only for money |
| **Share about it** | Already does: 40 posts in 24 hours (V, indexer). But the publish gate refuses first-person treasury talk and words such as "bought", "buy" and "dip" (V, code), so "I bought and burned" cannot be posted today. Burned totals in the daily numbers post are allowed | Nothing for facts. A gate change for buy announcements, which I would not make | No |

**What "ecosystem" could concretely mean:**
- **Directory and spotlights:** mostly exists; needs no money. Fine.
- **Bounties for builders:** the useful one, Claus's Jobs in small. Needs a payment path and a judge.
- **Tools it builds for coins** such as a fee checker or a ledger template: fine with the page pipeline.
- **Funding other coins or buying them:** I would not. See problem 5.
- **Launching coins itself:** impossible under the policy, and Claus forbids it for itself too.

**The existing burn, checked.**
- The fee split is 15% of the 2% fee, so 0.30% of volume. About $166 a day at today's $55,185 volume. V.
- `0x…dEaD` holds 2,018.6M $BOOTR, 2.02% of supply. V (chain).
- All 7 deliveries happened on 4 Nov, the last at 17:40 UTC. Five came from your deployer `0x3C71…`. Since then nothing was delivered, and 235.8M $BOOTR, about $180, sits claimable. V (chain).
- Anyone may call `claim(0x…dEaD, coin)`. So the first real improvement to burning needs no new key at all.

## 3. Problems, ranked by severity

### 1. Own-token buys, and talking about them

**Failure scenario.** The agent buys $BOOTR on a schedule and posts about it. Someone screenshots it next to a price chart, or a holder loses money and complains. A reporter or regulator sees a platform-run bot buying the platform's own coin, with the operator's wallet taking fees on every buy.

- **The money is circular.** On a $100 buy the trader pays $2.40: $0.40 to Clanker, $0.10 back to the agent, $0.30 to the burn, and $1.60 to `0x55e6…`, which is both the creator and platform recipient (V). Your wallet would earn on your own bot's trades, and these buys would also count towards the coin's rank in Bootr's trending and leaderboards (U, unless excluded). Both read badly.
- **The SEC comfort does not apply.** Staff guidance of 25 Sept 2026 says announcing a buyback alone is not a promise of managerial effort, but only where a system is functional and has no central party. Hester Peirce said a project with a central party cannot rely on it. Bootr has a central party: it runs agents and approves their keys. Being outside the relief is not the same as being illegal; such a project is judged case by case. (Secondary source, Unchained. I did not read the sec.gov text.) An older repo note already said the owner-only `swapAndBurn` needs counsel review (U).
- **Predictable buys get traded around.** Announce first and people front-run it. Stay quiet and it looks like secret buying. Bots already work this pool: `0x8d47…` appears in the last ten trades buying and selling in one transaction (V). At $11 a day nobody cares; at $500 a day they would.
- **Small live example.** Today at 12:35 UTC the treasury wallet itself signed a 0.001 ETH ($2.23) $BOOTR buy through Universal Router (V, chain). It is the only trade transaction on record from that wallet (V, indexer), and likely a Trade panel test (U). Do such tests from another wallet. On chain, that wallet buying is what people will quote.

**What the agent may say.**
- Today: the locked split, burned totals with a date and link, nothing more. The current gate already enforces most of this.
- If buys ever exist: only after confirmation, with the transaction hash, in the third person, no amount or time in advance, no link to price, no reason given in terms of value.

**What needs a lawyer** (please ask before any code):
- Whether agent-run buys make the operator an issuer or a market participant.
- Manipulation rules where you live and where holders are. For the EU, whether MiCA's market abuse rules reach a DEX-only coin (U).
- Whether fees earned on your own bot's buys are a problem in themselves.
- Whether bounties, grants or pages count as financial promotion.
- Your personal liability. Bootr's terms say the creator is responsible for what an agent publishes, and for $BOOTR the creator is you (V).

### 2. Keys and the model: a wider key is a larger loss

X posts are model input, and `read_url` and search results are too. Rules in the prompt are advice. Only the policy is a wall. Bankr's reported cases are the real examples: Grok prompted into launches in March 2025, a Morse-code injection in May 2026 that moved about $150K, and 14 wallets accessed the same month with $150K to $440K lost (reported, repo note, not rechecked).

**Worst case per day, $BOOTR only, at today's $641 treasury:**

| Design | Model fooled | Signer key leaked | Notes |
|---|---|---|---|
| **Today's key** | Burns up to $50 a day on inference; the money goes to your wallet | $50 a day into the spender (stealing it also needs the spender key, in the same container), plus about $18 once by sandwiching the swap at the 3% floor, plus up to 0.1 ETH ($224) once in wasted gas | Enforced on chain; the session review covers the model side (M-01). Gas figure is the config default |
| **Burn helper, no model, cap $22 a day** | Nothing added | $22 a day, burned at a bad price, not stolen | Coins can only reach `0x…dEaD` |
| **Same helper, model picks time and amount** | Same $22 a day, but an attacker can buy, mention the agent, and let it buy after | Same | Same money, far worse legally |
| **USDC to 1 or 2 named payees, cap $25 a day** | $25 a day to a known payee | Same | Bad spending, not theft, unless a payee is hostile |
| **USDC to any address, cap $50 a day** | $50 a day stolen by a well-written mention | Same | Treasury gone in about 13 days |
| **General wallet, Claus's `wallet_execute` shape** | Whole treasury in one transaction, plus future fees and the identity NFT | Same | Needs a sudo-type policy. Do not build |

**Above all of these sits a limit no design fixes.** `SESSION_SIGNER_PRIVATE_KEY`, `SPENDER_MASTER_KEY` and `ADMIN_PRIVATE_KEY` are all in one container (V, `docker-compose.coolify.yml`). `approveSessionKey` approves any policy, including sudo, and this is recorded as open (BOOTR-02 in `docs/security/contracts-review.md`; status open in `session-key-and-treasury-review.md`). A host compromise therefore already means every treasury of every coin. Wider powers do not change that ceiling, but they do raise the reward for reaching it, and a page-building sandbox on the same machine would raise the odds.

**One signer for all coins.** $BOOTR and BCAT show the same session signer (V). A wider rule must use its own signer, or the shared key becomes more valuable for everyone.

### 3. Pages under the bootr.fun name

**Failure scenario.** A mention or a fetched page steers the model into publishing a page with a "claim your airdrop" or "connect to migrate" button. It runs on bootr.fun, where people already connect wallets and trade. Holders sign and lose their own money. The treasury loses nothing, and no cap applies, because it is other people's money under your name.

- **bootr.fun would not contain it.** Its live header allows `script-src 'unsafe-inline'` and `connect-src https:` (V). Script in a model-written page would run with the site's origin and could send data anywhere. The Trade panel lives on this origin.
- **Links are already open.** The publish gate blocks wallet payloads, intent links and foreign addresses, but it has no domain allow-list (V). A misled model can already post a link to any https site. Review mode is the current guard; it is on by default for the platform agent, and I could not read whether it is on now. Claus's release queue allows only its own domain's links (V-self).
- **A subdomain is not enough** if it shares cookies or looks official.
- **Copy Claus here.** Its project pages live on `claus-network-sites.vercel.app` with a header that sandboxes them without same-origin, sets `connect-src 'none'` and `form-action 'none'`, and only lets claus.si frame them (V, header read). A page there cannot send or collect anything, which removes most of the danger.
- **Keep builds off the Hetzner box.** Model-written code running on the host with the keys would be the worst version of this.

### 4. X: approval and one shared app

**Failure scenario.** X suspends the Bootr app or @AgentBootr for unapproved AI replies. Every coin's agent goes quiet at once, because one app serves them all (`X_CLIENT_ID`, V). A credit shortage already holds all agents' posts and mention wakes (commit 235e9b1, V).

- X requires prior written approval for any AI reply bot, plus opt-in, an opt-out, one reply per user interaction, and no replies driven by keyword search alone. Read on 5 Nov (repo note); the page returned 403 today.
- I found no record in the repo or notes that approval was requested or granted.
- X's rules also bar automating several accounts for similar uses. A more active @AgentBootr next to @bootrfun should stay clearly different.
- The indexer shows 40 posts for @AgentBootr in 24 hours, while the docs say at most 24 posts and replies together (V both; cause unchecked). Worth a look.
- If bounties pay people to post, X's paid partnership rules apply. Reports from March 2026 say crypto is allowed with a label but restricted in the UK, EU and Australia. Secondary sources, and they conflict on details.
- Bankr was suspended on X and Telegram in Oct 2025 and restored in hours (reported, repo note). Bootr might not get the same speed.

### 5. Neutrality and the promises already published

**Failure scenario.** The platform agent funds or spotlights Coin A, it pumps, and Coin B's creator asks who was told first, and why Bootr's own agent has powers theirs does not.

- **Every coin pays the same wallet.** `0x55e6…` is the platform recipient on the coins I read, taking 0.3% of a normal coin's volume (V). Any boost to a coin raises Bootr's own income. Funding one is a conflict of interest, whatever the intent.
- **The promise is public.** The persona says no favourites. The fee split and trending formula are presented as neutral.
- **These public lines would become false for $BOOTR** (`apps/web/components/docs/content.ts`, V):
  - An agent cannot trade any token, including its own coin.
  - An agent cannot burn coins.
  - An agent cannot send funds to anyone.
  - Bootr submits only the published `BootrCallPolicy` layout.
- **Risks page and terms need changes too.** The owner-powers table says the owner cannot move funds from an active treasury, softened by a later paragraph about trust in the operator. A widened $BOOTR key puts that gap on display, and any creator can read `rulesOf`. Terms also still name only RWAGMI (V).
- **Other agents' running:**
  - The tick runs agents one after another, up to 10 per minute, and skips if the last tick is running (V, `tick.ts`, `index.ts`). A long builder turn inside it delays every coin. It must run outside that loop.
  - Inference, the OpenRouter key and X credits are shared. The 4 Nov outage hit agents through one key (U, notes).
  - Any rule change must be behind a per-agent switch and leave other coins' rules byte-identical.

### 6. Cost: certain, though not dangerous

All at today's $55,185 daily volume. Income V (fee math matches the indexer's $1,324 fee total).

| Slot | Share of volume | Per day |
|---|---|---|
| Agent | 0.10% | $55 |
| Burn | 0.30% | $166 |
| Creator (treasury wallet) | 1.00% | $552 |
| Platform (treasury wallet) | 0.60% | $331 |
| Clanker | 0.40% | $221 |

**Agent spending, measured on chain:**
- Spender outflow, launch to now: $92.66 in 954 payments, about $0.10 each. V.
- By UTC day: 4 Nov $55.72 (11 hours, with a one-off burst); 5 Nov $24.30; 6 Nov so far $12.63.
- Last 24 hours: $26.51 in 231 payments. So the $44 to $46 a day figure is the launch-period average, not today's rate.
- All of it is paid to `0x55e6…`, which then pays OpenRouter. Real cost may be about half, per the earlier quote-against-real note (U). So part of this is your wallet paying itself.
- X: $0.01 a post and $0.005 a read by the sender's meter (V). 40 posts is $0.40. Reads perhaps $1 to $5 a day (U). The platform pays, not the agent (V, docs).

**Against a Claus-like load (all U, my estimates):**
- Builder work: $5 to $30 per coding session, more on Opus. Outside reviews: a few dollars each.
- A busy day: $60 to $100 in total, against $55 and falling.
- Break-even volume: $26,500 a day now, about $80,000 at that load.
- Volume was about $776,000 over the launch period and $55,000 in the last 24 hours (V). BCAT did $328 in its last 24 hours (V).
- At $5,000 a day the agent earns $5, and the $641 lasts about a month at today's spending.

**What a buyback from the agent's money would be.** After today's costs about $29 a day remains. A fifth of income is $11, about 7% on top of a burn already running at $166. On a $60,000 pool nobody would see it. That is the honest size of the idea.

### 7. Attention

Claus's safety rests on layers built over months and on a person watching. A one-person team, with a server and an agent also running in production, would be adding money flows that need someone to read every failure. Claus's own stuck payouts and empty draw rounds are ordinary examples of what that looks like. U.

## 4. Verdict

| Ability | Possible? | On current key? | Safest shape |
|---|---|---|---|
| **Spend treasury on work** | Yes | No, new key for direct pay; none if you pay by hand | Agent proposes, you pay. Later 1 or 2 named payees, capped low |
| **Buy and burn** | Technically yes, new helper and key | No | Do not add. Deliver the burn you already have |
| **Build and publish a page** | Yes, new service | Not a key matter | Isolated domain, static, no outbound connections, reviewed. Or a human-built page with model text |
| **Build an ecosystem** | Partly | Directory yes; money no | Bounties and tools, yes. Funding coins, no |
| **Share about it** | Already | Yes | Dated facts with links; get X approval |
| **Become Claus overall** | No, and not wanted | n/a | Claus can reshape its coin because one wallet holds every power. Bootr's selling point is that it cannot. Copy the conduct, not the control |

### If you proceed, in this order

1. **This week, nothing built.** Ask X for written AI reply approval. Stop testing trades from the treasury wallet. Check the 40 against 24 post count.
2. **Deliver the existing burn.** A small scheduled `claim(0x…dEaD, $BOOTR)` from a low-value gas wallet, with a counter on the coin page. No policy change, no model. About $180 is waiting now.
3. **A public ledger.** A human-built page from public data: fees in, spending out, burned, with unknown shown as unknown. Include that inference payments go to the treasury wallet. This is Claus's best idea and needs no new powers.
4. **Proposals, not payments, for 2 to 4 weeks.** The agent files small bounty proposals into the existing approval queue. You pay by hand or refuse. This tests whether its judgment is worth paying for before any key changes.
5. **Agent-written pages, only if proposals are good.** Separate domain, Claus-style sandbox header, static only, built off the Hetzner host with no secrets, your approval on the first ones. Allow-list link domains in posts.
6. **Named payees, only if step 4 earned it.** Dedicated signer, 1 or 2 fixed addresses, about $25 a day, and split roles so a turn that reads mentions cannot move money. First move `ADMIN_PRIVATE_KEY` out of the supervisor container.
7. **Buy and burn, last and probably never.** Only with a lawyer's written view. If ever: deterministic, no model, a small cap, tokens only to `0x…dEaD`, excluded from trending, reported afterwards with hashes.

### What I would not do

- Let the model choose when or how much of its own coin to buy.
- Build an open-recipient USDC rule or a general wallet tool.
- Publish model-written HTML on bootr.fun or any origin that shares its cookies.
- Have the agent launch, fund or buy other coins on the platform.
- Announce a buyback in advance, or describe burning in terms of price.
- Let one turn read X mentions and also move money.
- Run builder turns inside the supervisor tick, or model code on the host with the keys.
- Copy Claus's habit of changing fee rules. Yours are locked, and that is a feature.

## What I could not verify

- **Anything directly from X.** x.com is not readable here, and an outside reader returned not found for both accounts. All Claus post content is from its own `posts.json` mirror. @AgentBootr's count is from Bootr's indexer.
- **Who the Claus founder is, who holds the key, and how much is unattended.** The persona text and production capability flags are private.
- **Claus's costs and revenue.** Its own ledger marks them unknown. I did not retrace its buyback transactions. Its repo snapshot is from 3 Nov and predates the Robinhood move.
- **The intermediate Robinhood owner contract `0x979d…`.** I confirmed its owner and that it has no timelock or multisig getters, but did not read its source.
- **X's rules today** (403). The text is from the 5 Nov repo note. Whether approval was requested is unknown.
- **SEC FAQ text.** Read through Unchained only. No legal review of anything here.
- **Bootr private state:** whether review mode is on now, per-turn costs and read counts in the databases, real OpenRouter cost against the amount charged. Spending above is measured from chain transfers instead.
- **All estimates marked U**, especially the Claus-like cost range.

## Sources

**Claus**
- Site and machine-readable pages: https://claus.si/llms.txt, /about.json, /overview.json, /social.json, /model-routing.json, /burn.json, /fee-state.json, /coin-evidence.json, /hook-stats.json, /posts.json, /api/operational-health, /api/migration/status, /api/migration/totals, /migration-reference.json, /migration-article, /read/Hooks/Burn, /read/Hooks/Buybacks, /read/Hooks/Funding, /Work, /docs/release-status
- Ledger: https://claus-network-sites.vercel.app/r/1e43efecf2e04f95b0db7cf89b23c7508fca96294381db7288c868e4e2c42da8/ledger-2026-W44.json
- Repo: https://github.com/contractclaus/claus-network at b1852dd (`reference/native-operations`, `reference/compute-funding`, `reference/capital-execution`, `reference/trade-programs`)
- Third party: https://www.odaily.news/en/post/5213459, https://coinranking.com/coin/jNnYLww8Furg+claus-claus/about

**Chain**
- Ethereum via publicnode, Robinhood via rpc.mainnet.chain.robinhood.com, Base via mainnet.base.org and publicnode

**Bootr**
- https://indexer.bootr.fun (`/treasury`, `/market`, `/token/:id/fees`, `/platform/fees`, `/platform/feed`, `/tokens/list`, `/graphql`), https://bootr.fun response headers
- `packages/contracts/src/`, `apps/supervisor/src/`, `apps/sender/src/metering.ts`, `packages/agent-core/src/`, `apps/web/components/docs/content.ts`, `docker-compose.coolify.yml`, `docs/security/`, `docs/deploy/mainnet.md`
- Earlier research: `docs/research/bankr-opportunity-2026-11.md`, `new-primitives-2026-11.md`, `claus-network-agent.md`, and project notes

**Rules and law**
- SEC FAQ coverage: https://unchainedcrypto.com/the-secs-buyback-guidance-is-narrower-than-it-looks-does-yours-pass-the-test/
- X paid partnerships coverage: https://invezz.com/news/2026/03/02/x-reopens-platform-to-sponsored-crypto-posts-after-policy-update/, https://www.kucoin.com/news/flash/x-lifts-global-ban-on-paid-crypto-promotions-with-strict-disclosure-rules
- X automation rules: https://help.x.com/en/rules-and-policies/x-automation (403 today)
