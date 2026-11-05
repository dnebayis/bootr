# Bankr leaving Clanker: what it means for Bootr

Written 2026-11-05. Marks: **V** checked by us in a primary source or on chain, **R** reported by a research agent from a primary source and not rechecked, **U** unverified or our inference. Figures are as read on that date.

## Conclusion

The opening is real but smaller than it looks, and it is not "take Bankr's place".

- Bankr will almost certainly keep its own migrating coins on its own stack (U). Those coins are not up for grabs.
- The gap we can use is access: Bankr launches are now for paying members, and its chat, social and API launches default to Robinhood Chain (V).
- Bootr's difference is not "another launcher". It is that a coin gets an agent with its own treasury, on narrow keys, without custody. Bankr's custody incidents make that a stronger pitch (R).
- A gasless tweet-to-launch copy is the wrong first move. A tweet that returns a signing link gets the same reach without a hot wallet, fee escrow or impersonation exposure.
- One finding matters more than the opportunity: X requires prior written approval for any AI reply bot, which covers Bootr's agents today (V).

## What happened

- Bankr's founder posted on 5 Nov 07:10 UTC that he plans to migrate $BNKR off Clanker, with other Bankr-launched Clanker coins getting the option, and that a plan comes "over the coming weeks" (V). No destination, mechanism or date.
- His stated reason is a person he alleges holds a stake in Clanker (V that he said it). The allegation itself is unverified. Do not repeat it publicly.
- Bankr's launches left earlier: its docs call Clanker deprecated and use Doppler (V). So this is the token following the launches, not a new supply of launches.
- Clanker now sits with Mask Network, with Toady Hawk as CEO (R). Deal terms unknown.

## Size of the market

DefiLlama, fees, read 5 Nov (V; all chains unless noted):

| | Last 30 days | All time |
|---|---|---|
| Clanker | $978k | $92.7M |
| Bankr | $767k | $40.8M |
| Virtuals | $188k | $74.8M |
| Flaunch | $12k | $3.6M |

- Base launchpad fees fell from about $30M+ a month in Jan-Feb to about $2M a month (R). The hype collapse hit everyone.
- Clanker launches on Base: 419,766 in January, 3,584 in October (R).
- Virtuals, the closest comparison for agent launches, earned about $84k on Base in 30 days (R). Demand for agent launches specifically is unproven.

## Bankr compared with Bootr

| | Bankr | Bootr |
|---|---|---|
| Trigger | X post, chat, CLI, API | Website, API, skill |
| Access | Bankr Club members only, per support article of 19 Oct (V); $20 a month (R) | Open |
| Default chain | Robinhood Chain for chat, social, API (V) | Base |
| Trader fee | 1.75% (R) | 1.2% Clanker, 1% RWAGMI |
| Creator share of volume | 0.665% plus a 15% supply vest (R) | 0.65% Clanker, 0.585% RWAGMI, no buyback preset (fork test) |
| Wallet | Privy-based, not exportable, server signs (R) | The creator's own wallet; agents on narrow session keys |
| Agent per coin | No | Yes |
| Launch for someone else's handle | Yes, wallet made for that handle, no consent step documented (R) | No |

## What Bankr has taught the market (R unless marked)

- Sampling 50 recent launches: 26 cite a tweet not from the deployer's linked account (Vitalik, CZ, Armstrong, Anthropic), and 19 have no handle with fees sent to another wallet, 11 of whose recipients also deployed. This looks like farming (U).
- Grok was prompted into launches in March 2025; Bankr blocked it.
- A May 2026 Morse-code injection through Grok moved about $150K; the founder reportedly said a rewrite had dropped the block.
- In May 2026 at least 14 wallets were accessed and transactions paused; losses reported at $150K-$440K.
- Bankr was suspended on X and Telegram in Oct 2025 and restored within hours; reason not given.

**Worth copying:** quota design where a slot returns only when a launch provably never broadcast; caps per name and recipient; public launch and fee endpoints; a tested hard block on LLM accounts; identity keyed to the X numeric id, not the handle.

**Not worth copying:** custody; signing authority from a tweet; displaying unverified tweet attribution; irrevocable value to a handle that did not consent; gas sponsorship with no proof of cost.

## X rules (V, X automation rules page)

- "the deployment or operation of any AI reply bot requires prior written and explicit approval". Request through a point of contact or the developer portal.
- Automated replies need opt-in, a clear opt-out, one reply per user interaction, and may not be driven by keyword search alone.
- "You may not create and/or automate multiple accounts for duplicative or substantially similar use cases." Related but non-duplicative uses are allowed. This bears on one account per coin and on a second platform persona.

Whether Bootr has this approval is not known from the repo. Not legal advice; a tweet that names a real person or pays for a post carries more exposure (U).

## What our code allows (R, code read by a research agent)

- Both launchers always create a kernel, identity and guardian entry, and `creator = msg.sender`. The creator slot is locked.
- Mentions can be read for any connected account; the sender estimates $0.005 per post read and $0.01 per post sent. X plan limits are not recorded in the repo.
- No relayer exists. `ADMIN_PRIVATE_KEY` must not be reused for this.
- Tokens are indexed only through `AgentLaunched`; `kernel` and `agentId` are required, and several pages key on `kernel`. Agentless coins need an indexer source, a nullable field, UI branches and a backfill (about 7 minutes).
- If a launch's relayer were the treasury, the coin would get `config.platform` and the 2% fee. A trap for any shortcut.
- A second `platform: true` agent breaks: one persona list, numbers, digest, updates and watchlist are global, and both would post them.

## Proposed order

**0. Now, regardless of everything else.**
- Request X's written approval for AI replies (owner, developer portal).
- Stay out of the Clanker dispute. $BOOTR itself lives on Clanker, and Clanker's team has been helpful. Do not repeat the allegation or attack Clanker.

**1. This week: reach, no new custody.**
- Submit a skill to `BankrBot/skills` (accepts PRs, already lists a Clanker skill; acceptance for a rival uncertain).
- Pitch one line: open launch on Base, an agent for your coin, no custody. Say it once with the skill, not as a reaction to the news.
- Deterministic launch replies on @bootrfun: "@bootrfun launch NAME TICKER" gets one reply with a prefilled launch link, and the user's wallet signs. No LLM, no relayer, no escrow, nothing created without a signature, so no coin can be made in someone else's name. Needs the parser, the prefill route, opt-out, per-author caps, a reply quota.

**2. After seeing demand for the links.**
- Agentless coins as an option through the same link, signed by the user's wallet, directly on Clanker's factory with a platform fee slot. Indexer and UI work; no contract required. The owner wants this; the risk is that it joins a commodity market and dilutes the agent pitch. Measure first.
- Attach an agent to an existing coin, which the research points to as the real target (communities unsettled by these changes). Open question: its fees are locked elsewhere, so what funds the agent? Needs a design before any promise.

**3. Hold.**
- Gasless launches from a tweet, with a relayer and claim-by-handle escrow. Needs a hot key controlling unclaimed fees or a new contract, an impersonation policy, a legal view and anti-farming rules. Reconsider only if step 1 shows real pull.
- Revisit Bankr's migration plan when it is published, and consider Doppler as a third backend. Clanker's v4 factory is owned by a Safe (V) that can deprecate launches (R); RWAGMI is the only fallback today.

**@bootrfun agent.** The simplest form is the deterministic launch replies above with no LLM, keeping @AgentBootr as the voice. A real second persona needs code (a `persona` field, a treasury-off mode, a hand-funded spender) and has to fit X's duplicate account rule. Decide after step 1.

## Not found

Bankr's migration plan; proof of the alleged stake; Mask's deal terms; Bankr's Clanker coin count; launchpad volume series; Bankr's terms text; any Bankr impersonation policy; whether Clanker shows coins made outside its site as verified; X plan limits for this account.

## Sources

- Founder post: https://x.com/0xDeployer/status/2118239501462163627
- Bankr docs: https://docs.bankr.bot/ (faq/token-launching, token-launching/overview, token-launching/fee-splitting, faq/wallets, partnership, skills)
- Bankr launch gate: https://bankr-support.support.site/article/token-launch-blocked
- Bankr skills: https://github.com/BankrBot/skills
- Fees: https://api.llama.fi/summary/fees/bankr and `/clanker`, `/virtuals-protocol`, `/flaunch`
- X automation rules: https://help.x.com/en/rules-and-policies/x-automation
- Incidents: https://www.theblock.co/post/346027/ , https://cointelegraph.com/news/bankr-disables-transactions-after-14-wallets-hacked , https://theblock.co/post/374119/bankr-back-live-x , https://beincrypto.com/grok-wallet-bankr-drb-prompt-injection/
- Clanker contracts: https://raw.githubusercontent.com/clanker-devco/v4-contracts/main/src/Clanker.sol
- Clanker CEO: https://x.com/toady_hawk/status/2117691205601403391
