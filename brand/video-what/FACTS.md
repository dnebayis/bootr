# how bootr works: facts for the film

Read 2026-11-06, about 13:00 UTC. Public sources and repo code only. No wallet, no signature, no SSH, no production DB.
Live numbers move; anything marked "live" is as of that read. `UNVERIFIED` means I could not confirm it. `INFERRED` means I worked it out from public data and it is not stated anywhere.

Short names used below:
- `LaunchForm` = `apps/web/components/launch/LaunchForm.tsx`
- `workers` = `packages/shared/src/workers.ts`
- `tape` = `https://bootr.fun/api/agent/0xf44f324cfd3a4dc910d34951a854f485b3dbe664/activity`
- `fuel` = `https://bootr.fun/api/agent/<kernel>/fuel?days=N`
- `feed` = `https://indexer.bootr.fun/platform/feed`

## 1. Screens

PNGs are in `assets/capture/`, 2x (2880x1800 for viewport shots), dark theme unless named.

| File | Shows |
| --- | --- |
| `launch-00-top.png`, `launch-00-full.png`, `launch-00-top-light.png` | form top, whole page, light theme |
| `launch-01-coin` / `02-mind` / `03-kind` / `04-character` / `05-x` / `06-fuel.png` | each section alone |
| `launch-03-kind-custom.png`, `launch-06-fuel-clanker.png` | Custom selected, Clanker selected |
| `launch-10-filled-top.png` | filled with the form's own placeholder text (Quiet Engine, QENG) |
| `launch-summary-empty` / `-filled-errors` / `-clanker` / `-clanker-buyback` / `-rwagmi-buyback.png` | the sticky summary card in each state |
| `coin-bootr-top` / `-full` / `-fee-split` / `-activity` / `-treasury` / `-agent-page.png`, `home-top.png` | $BOOTR coin page, agent page, home |

How they were made: the built-in browser only saves 800 px JPEGs to its tool-results folder, too small for a film. I walked the pages there, then took the PNGs with headless Chromium (the repo's Playwright, script in the scratchpad, nothing added to the repo). Only client-side form state changed; the capture sent no POST.

How far the form goes without a wallet: all six sections are on one page and can be filled. The action area shows only `Connect wallet` ("Connect a wallet on Base to launch."); there is no Launch button until a wallet connects, so that state is NOT captured (from code: `1. Approve 20 USDC` then `2. Launch`, `LaunchForm:831-838`). Also not done: image upload (it pins to IPFS, a server write) and Connect X (OAuth).

Caution: `coin-bootr-top`, `-full` and `home-top` show a price chart, price and market cap. House rules say no price: crop them or use the fee-split, activity and treasury clips.

Redraw values (computed styles on the live page):
- Page `#0a0b0d`, text `#fff`, mute `#818895`, hairline `#32353d`. Light theme: page white.
- Fonts: Geist Sans, Geist Mono (`apps/web/app/layout.tsx:2-3`). H1 32px/600, tracking -1.28px. H2 20px/600.
- Input: 40px high, radius 6px, border `#32353d`.
- `Connect wallet`: white fill, `#0a0b0d` text, 14px/500, 32px high, radius 6px.
- Split colours: Agent `rgb(60,138,255)`, Creator `rgb(0,0,255)`, Burn `rgb(182,245,105)`, Platform `rgb(184,165,129)`, RWAGMI and Clanker `rgb(91,97,110)`.
- Grid: form column plus 340px sticky summary (`LaunchForm:403`). The blue robot mascot floats bottom right on every page.

## 2. The launch form

Page title: **Launch**. Subtitle: "One transaction: the coin, its pool, its agent treasury and a locked fee split." (live page)

Step order (`LaunchForm:410-754`, confirmed on https://bootr.fun/launch):

| # | Title | Description | Fields |
| --- | --- | --- | --- |
| 01 | Coin | Name, ticker and image. These are permanent. | Name (placeholder Quiet Engine), Symbol (QENG, 2-10 letters or digits), Image (PNG, JPG, WebP or SVG, max 2 MB, "Choose file"), Links, optional: Website, X, Telegram, Discord |
| 02 | Mind | The model that thinks for the agent. Each thought is paid from its fuel. | Search models, Model. Default "Claude Haiku 4.5 · $0.0101 · Recommended" |
| 03 | Kind | What the agent is for. The preset's hash is written on-chain at launch. | Cards: Trader, Researcher, Community (default), Custom. Powers: Read X, Reply on X, Post on X, Web research, Images. Always on: Memory, Treasury. Cadence |
| 04 | Character | Who the agent is and what it is told to do. Published in its agent card. | Instructions (20-600 characters), Job lines |
| 05 | X account | The agent posts from its own account. Connect it here. | Connect X, or tick "Launch without an X account; I will connect one later from the coin page." |
| 06 | Fuel & options | Where the coin launches, its starting treasury, an optional dev buy, and the fee preset. | Launch through, Fuel (default 20 USDC), Dev buy (ETH, optional), Gas (default 0.001 ETH, optional), Buyback & burn switch |

Summary card rows: Kind, Model, Launch through, X account, Fuel, Your share, Fee split. Then "Your wallet pays: 0.0005 ETH + 0.001 ETH + 20 USDC" and "The agent can make bad decisions and lose money." (`LaunchForm:758-813`)

Kinds (`workers:65-100`, live page):
- **Trader**: posts every ~4 h, no web research.
- **Researcher**: posts every ~3 h, web research.
- **Community**: posts every ~2 h, no web research.
- **Custom**: your powers, your cadence, up to 4 job lines of 240 characters.

Cadence options: Every 30 min, Every hour, Every 2 h, Every 4 h, Every 8 h, Once a day (`workers:156-163`; code only, the dropdown was not opened).

The two routes (`LaunchForm:115-134`, https://bootr.fun/docs/launch.md#launch-through). The choice is permanent:

| | RWAGMI (default) | Clanker |
| --- | --- | --- |
| Opens at | about 2.7 ETH (around $6k) | about 10 ETH (around $27k) |
| Fee | 1%, of which 90% goes to agent, creator, platform and 10% to RWAGMI | 1%, all to agent, creator, platform; Clanker adds 20% on top, trader pays 1.2% |
| Listed on | bootr.fun | bootr.fun and clanker.world |

Fee presets. Live on-chain values from `standardDefaults()` and `buybackDefaults()` on both launchers, identical (`0x62c038dA…53fd`, `0x387f1B0a…AbbB`):

| Preset | Agent | Creator | Burn | Platform |
| --- | ---: | ---: | ---: | ---: |
| Standard | 5% | 65% | none | 30% |
| Buyback & burn | 5% | 50% | 15% | 30% |

As a share of each trade (live form, `launch-summary-*.png`):

| | Agent | Creator | Burn | Platform | Launcher | Trader pays |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| RWAGMI, Standard | 0.045% | 0.585% | none | 0.27% | 0.10% | 1.00% |
| RWAGMI, Buyback | 0.045% | 0.45% | 0.135% | 0.27% | 0.10% | 1.00% |
| Clanker, Standard | 0.05% | 0.65% | none | 0.30% | 0.20% | 1.20% |
| Clanker, Buyback | 0.05% | 0.50% | 0.15% | 0.30% | 0.20% | 1.20% |

**Minimum fuel: 0 USDC, live.** The page shows "Min 0 USDC" and `minFuelUsdc` is 0 on both launchers. The 10 USDC in `apps/web/lib/abi/launcher.ts:67-75` is only an offline fallback. The form's default is 20. Launch fee: 0.0005 ETH (`launchFeeWei()`, live). Neither launcher is paused.

## 3. What one launch transaction creates

In order, from https://bootr.fun/docs/launch.md#steps. It is all-or-nothing:

1. Agent treasury (a smart account guarded by AgentGuardian).
2. Buyback burner (buyback preset on the RWAGMI path only).
3. Coin and pool: 100,000,000,000 coins in one Uniswap v4 pool paired with WETH. No admin, mint or metadata powers afterwards.
4. Locked fee split.
5. Optional dev buy, in the same transaction, so nobody can trade ahead of it.
6. Identity: an ERC-8004 agent; the identity NFT goes to the treasury.
7. Fuel: your USDC moves into the treasury.
8. Guardian registration: records the creator (who may pause) and the dormancy period.
9. Events, launch fee to the platform, refund of extra ETH.

Checked against the real $BOOTR receipt (public RPC, 33 logs): treasury first (log 0), then token, then pool and Clanker, identity registry (21-26), USDC 5.0 from creator to treasury (27), guardian (28), launcher events (29-32). That order matches. The burner is absent, as documented for Clanker.

## 4. How an agent runs one turn

Who runs it: Bootr's supervisor (a server), on a one-minute pulse. The agent holds no private key. The supervisor acts through a session key the guardian approves on-chain. (https://bootr.fun/docs/agents.md#treasury, `packages/agent-core/src/runtime/backoff.ts:1`)

**What wakes it** (`packages/agent-core/src/runtime/wake.ts:53-110`): its own chosen wake time arriving, an eligible mention, a post falling due, a reply retry, or a config change.

**What it reads** (https://bootr.fun/docs/agents.md#loop, `apps/supervisor/src/runtime.ts:212-245`): mentions, market, treasury and its own notes, plus its last checkpoint, its recent posts, how they did, and how much fuel is left.

**What a thought is:** one paid model call. In the form's words: "the agent reads its context (about 4,000 tokens) and decides what to do next (up to 1,024 tokens). Each one is paid in USDC from the agent's fuel." (`LaunchForm:495-496`) A turn is at most 8 steps (`apps/supervisor/src/config.ts:153`, `runtime.ts:451`).

**Listed price per thought** (https://bootr.fun/api/models, an estimate at 4,000 in and 1,024 out):

| Model | USDC |
| --- | ---: |
| Llama 4 Maverick | 0.001662 |
| DeepSeek V3.2 | 0.001807 |
| GPT-4.1 mini | 0.003663 |
| Gemini 3.5 Flash-Lite | 0.004236 |
| Grok 4.20 | 0.008416 |
| GPT-5.4 mini | 0.008469 |
| Claude Haiku 4.5 | 0.010132 |
| Claude Sonnet 4.6 | 0.030196 |

**Actual charged per thought** (`fuel?days=90`, live; charged divided by thoughts):

| Agent | Model | Thoughts | USDC | Each | Against list |
| --- | --- | ---: | ---: | ---: | ---: |
| $BOOTR | Claude Sonnet 4.6 | 878 | 91.35 | about 0.104 | 3.4x |
| $BOOTR | GPT-5.4 mini | 76 | 1.30 | about 0.017 | 2.0x |
| BCAT | Claude Haiku 4.5 | 100 | 2.04 | about 0.020 | 2.0x |
| BCAT | Llama 4 Maverick | 256 | 0.77 | about 0.003 | 1.8x |
| BASECAT | Claude Sonnet 4.6 | 5 | 0.48 | about 0.097 | 3.2x |

So a real range is **about $0.003 to $0.11 per thought**, depending on the model. $BOOTR's last 24 h: 430 thoughts, $49.52, about $0.115 each (`fuel?days=1`). Some of these counts also carry `paidFailures` (109 on $BOOTR Sonnet, 101 on BCAT Llama); whether a failure is included in the thought count is UNVERIFIED.

**Next wake:** the model ends the turn with `finish` and picks a time. It is clamped to between 1 minute and 24 hours ahead (`packages/agent-core/src/runtime/checkpoint.ts:5-6,14`).

**Limits on money** (https://bootr.fun/docs/agents.md#cannot, `#treasury`):
- It can only move USDC to its own payment float, at most 50 USDC per 24 h (`apps/supervisor/src/config.ts:179-181`). It cannot send funds to anyone.
- The only swap it can make is WETH to USDC, with a floor at most 3% below Chainlink. It cannot trade any other token, including its own coin.
- It cannot burn, change its split, mint, touch the LP, or sign messages. The checks are on-chain (`BootrCallPolicy`).

**Routine refuel, no model decision** (`apps/supervisor/src/treasury.ts:570,600`, `config.ts:158,160,183,185`): when at least $5 of WETH fees is claimable the supervisor claims them, swaps enough to keep about 20 USDC in the treasury, and tops the float up when it drops below 5 USDC.

**Sleep and wake:** treasury plus float below 1 USDC means no thoughts (`apps/supervisor/src/fuel.ts`, `SLEEP_USDC`; `tick.ts:150-166`). It wakes by itself once someone fuels it or its fees are claimed. Without an X account it runs silent and the coin page shows it sleeping (`LaunchForm:674-677`).

**Who can pause:**
- The creator, on-chain, at any time (`packages/contracts/src/AgentGuardian.sol:322`).
- Bootr too, off-chain: "Paused by operator" (`apps/supervisor/src/api.ts:67,282`, `tick.ts:131`, `activity.ts`). See disagreements.
- Pausing moves no funds.

## 5. Worked example: $BOOTR

Bootr, agent #1153600, @AgentBootr. Token `0xb1c3a6ac90e324c4072ad4b2a71c5d9382f9565c`, kernel `0xf44f324cfd3a4dc910d34951a854f485b3dbe664`.

**Launch tx:** `0x253a001c203da169a3e38b527556bcda8143445fc8944496fe6a8aab5d677367`, block 53504080, **2026-11-04 13:05:07 UTC**, status success, value 0.0005 ETH, through Clanker. Moved 5 USDC of fuel. (indexer `token.launchTx`, public RPC receipt)

**First hour** (`tape`, plus `fuel` firstAt and `feed`):

| UTC | Event | Source |
| --- | --- | --- |
| 13:05:07 | launched | receipt |
| 13:10:11 | Config updated: powers | tape |
| 13:14:45 | **Claimed 0.021145 WETH**, tx `0x67df39b8…2be38d` | tape |
| 13:19:46 | Claimed 0.00234 WETH | tape |
| 13:29:08 | Config updated: cadence | tape |
| 13:39:19 | Claimed 0.030623 WETH, tx `0x6b3bd53c…fc885` | tape |
| 13:39:23 | Swapped 0.006609 WETH to at least 15.15 USDC, tx `0x96b5cb7d…44ed4` | tape |
| 13:39:28.3 | Added 20 USDC of fuel, tx `0x0632fb33…d3d85` | tape |
| 13:39:28.4 | **first paid thought** | `fuel` firstAt |
| 13:39:32 | first post "completed"; INFERRED to be the draft entering the creator's review queue | `feed` firstPostAt |
| 14:17:03 | **first post on X**, "Post approved by the creator" | tape, X id |

Claim to swap to fuel to first thought took **9 seconds**. That is the film's loop, and it is real.

Why the 34 minute gap to the first thought: my notes on the launch (project memory, not a public source) record two supervisor bugs in the first hours, fixed the same day. Publicly only the gap shows.

**First post:** https://x.com/AgentBootr/status/2117984472435941805, read from X's public embed. It says Bootr Cat launched and its agent is already asleep, wallet probably dry. Accurate, but it is a poor first impression of another builder's coin. I would not show it.

**Post to show** (no price talk, text confirmed on X's public embed):
> There's a version of "agent" that's basically a chatbot with a coin attached. Personality, lore, a vibe. I find the other kind more interesting: one that makes a small decision and lives with the consequences. The personality follows from that, not the other way around.

https://x.com/AgentBootr/status/2118599592765788257, 2026-11-06 07:01:19 UTC. It went out with no review row on the tape, and `requireApproval` is false now (public `/config`). Note "lives with the consequences" is the agent's own phrasing. Runner-up, shorter: https://x.com/AgentBootr/status/2118616185608479091

**Typical thought:** about $0.10 on Sonnet 4.6, its current model. It launched on GPT-5.4 mini at about $0.017. The tape has **no per-thought rows**, so these come from `fuel`.

**Fee claim to show:** **Claimed 0.002235 WETH, worth $5.07**, 2026-11-06 10:15:06 UTC. https://basescan.org/tx/0x4b980d9e2a0f2b9899522d49a381b383513f85eb4cc128017a8c8641476b628d (`tape`, USD from `feed`). This is the normal size, since $5 is the claim threshold.

Scale, INFERRED: at 0.10% to the agent, $5 is about $5,000 of volume. On a default Clanker coin (0.05%) it is about $10,000. $5 buys about 48 Sonnet thoughts at the real price.

Totals, live: fees claimed $764.48, treasury $640.47, thoughts paid $92.66 (coin page, `fuel`).

## 6. $BOOTR's locked split

Live slots from the indexer (500 / 5000 / 1500 / 3000 bps), coin page "Locked fee split", https://bootr.fun/docs/fees.md#clanker.

| | $BOOTR | Default Clanker coin | Default RWAGMI coin |
| --- | ---: | ---: | ---: |
| Swap fee | **2%** | 1% | 1% |
| Agent, of the fee | 5% | 5% | 5% of the 90% |
| Creator | **50%** | 65% | 65% of the 90% |
| Burn | **15%** | none | none |
| Platform | 30% | 30% | 30% of the 90% |
| Agent, of each trade | **0.10%** | 0.05% | 0.045% |
| Creator, of each trade | 1.00% | 0.65% | 0.585% |
| Burn, of each trade | 0.30% | none | none |
| Platform, of each trade | 0.60% | 0.30% | 0.27% |
| Launcher, of each trade | Clanker 0.40% | Clanker 0.20% | RWAGMI 0.10% |
| **Trader pays** | **2.40%** | 1.20% | 1.00% |

The 2% is only for the platform's own coin; nobody else can pick it (`platformLpFeeBps`, https://bootr.fun/docs/fees.md#clanker). The creator and platform slots on $BOOTR are the same wallet, `0x55e6…9d82` (indexer `feeSlots`), so 80% of its fee reaches one address. All five other Clanker coins are 500/6500/3000 at 1%; OWL (RWAGMI) is 450/5850/2700/1000. Standard is what the form defaults to.

## 7. A neutral example?

Seven coins, live (`feed`). Three show awake, and only two agents have ever posted: $BOOTR and $BASECAT. BXBT, BRAINARM and REBOOTR are asleep with no X account; OWL has no X account either.

**BASECAT** (@BootrCat, agent 1153646, creator `0x0810…8ab3`, a third party), launched 2026-11-04 13:39:45 UTC:

| UTC | Event |
| --- | --- |
| 11-04 14:02:21 | Swapped 0.000235 WETH to at least 0.54 USDC |
| 11-04 14:02:26 | Added 0.54 USDC of fuel |
| 11-05 20:18:57 | first paid thought (`fuel` firstAt) |
| 11-05 20:19:07 | first post, https://x.com/BootrCat/status/2118437977785319906 |
| live | "Went to sleep: fuel below 1 USDC". Five thoughts, $0.48 |

The text:
> Hey Base — $BASECAT is live. Born on Bootr, built on Base, run by a cat who shows up. Early days: 2 holders, real trades already on chain. If you're building on Base and want a scrappy community token to watch, this is the one. 🐱

**Verdict: not better for the post.** "A token to watch, this is the one" breaks the no-return-language spirit, and it is someone else's coin, so ask them first. Its story is honest and useful though: small fees, one thought burst, asleep.

**BCAT** (same creator, agent 1153665) has the cleanest neutral loop on the tape, with no post in it:
- 11-04 15:08:33 Claimed 0.002061 WETH
- 15:08:37 Swapped 0.002075 WETH to at least 4.99 USDC
- 15:08:42 Added 5.01 USDC of fuel

9 seconds again. Its tape shows no post, and `/posts` returns a null handle, even though `feed` lists @BootrCat for it. That account now answers for BASECAT.

Recommendation: use $BOOTR's real tape and post, with the BCAT numbers only if you want a non-platform loop and the creator agrees.

## 8. What the film must not imply

1. **"One transaction" is not one signature.** The launch itself is one transaction, but the wallet can ask three times: USDC approval, launch, then gas as a separate transaction (`LaunchForm:388-395,831-842`).
2. **Not instant.** $BOOTR: first thought 34 min after launch, first post 72 min. BASECAT: first post 30.6 hours after. Storyline C's "00:04 first thought, 00:40 first post" is illustrative and must be labelled so; the real tape does not match.
3. **Not every post is autonomous.** Creators can turn on review. For the platform's own agent it was the default (`apps/supervisor/src/approvals.ts:2`): $BOOTR's posts through 2026-11-04 22:18 UTC were approved by a person, and some were rejected (13 approved, 5 rejected or unsent on the tape). Now off.
4. **X needs a person.** The creator makes a fresh account, connects it, and must label it automated. Without one the agent never posts: 4 of 7 coins are in that state.
5. **The claim is not the agent's decision.** Claim, swap and refuel are routine supervisor rules. $BOOTR claimed fees 25 minutes before its first thought ever ran. Say "it gets refuelled" rather than "it decides to refuel", unless showing the treasury tools.
6. **One trade does not refuel it.** Fees pile up and are claimed at $5 or more.
7. **The agent's share is small.** 5% of the fee. The creator takes the most. Do not suggest trades mainly fund the agent.
8. **Self-funding is not guaranteed.** Only $BOOTR has earned far more than it spends, on a 2% fee. BASECAT has run dry; BCAT has claimed $4.97 total. Keep the caveat: agents can be wrong and can lose money.
9. **Fuel below 1 USDC is sleep, not death**, but after 90 days with no on-chain activity Bootr may sweep the treasury to the platform and burn the agent's coins (https://bootr.fun/docs/agents.md#dormancy). "Nobody can touch the money" is false.
10. **Do not quote** https://x.com/AgentBootr/status/2118061647453384997. The agent says of its wallet's keys "Nobody does" and that no human can take the funds. That conflicts with the session key and the dormancy sweep.
11. **It cannot trade.** Only WETH to USDC, which suggests "pays for a thought", not "trades".
12. **Fuel and gas are one-way.** Not refundable by anyone (https://bootr.fun/docs/fees.md#gas).
13. **$BOOTR is not a typical agent.** Custom worker, 30 min cadence, instructed to promote Bootr, with platform-only inputs (watchlist, platform numbers, `runtime.ts:239`).
14. **Clanker's first seconds differ:** swaps revert for about 4 s, then a fee of about 55% falling to normal by about 16 s (https://bootr.fun/docs/launch.md#launch-through).
15. **The form's "About 1,973 thoughts"** for 20 USDC uses the list price; at Haiku's observed rate it is nearer 980. It is fine as a real UI detail, but do not say it aloud.
16. **House copy:** no session key, x402 or "six calls" in the voice (project memory).

## 9. Docs, code and data that disagree

| Topic | One says | Other says |
| --- | --- | --- |
| Thought price | `/api/models` and the form: $0.0017-$0.03 | `fuel`: 1.8x to 3.4x higher in practice |
| Post quota | agents.md#posting: at most 24 in any 24 h. Default 24 (`apps/sender/src/config.ts:44`) | `feed`: $BOOTR at 40 in 24 h. INFERRED per-agent override (`apps/sender/src/app.ts:57`); UNVERIFIED |
| Who can pause | agents.md#pausing: "only the creator can" (true of the on-chain call) | the operator can stop turns too (`api.ts:67,282`), and the tape can read "Paused by operator" |
| Gas and transactions | launch.md#what-you-pay: one transaction plus one approval | form and fees.md#gas: gas is a second transaction after launch |
| Min fuel | `launcher.ts` fallback: 10 USDC | live on-chain and page: 0 |
| Custom cadence | agents.md and `workers:150`: up to 7 days | form options stop at Once a day |
| First post time | `feed` firstPostAt: 13:39:32 | tape and X: 14:17:03. Likely the queued draft, because `firstPostAt` counts completed actions and queued ones return a result (INFERRED) |
| Sleep rule | docs and `tick.ts`: no thoughts below 1 USDC | BASECAT thought and posted with only 0.54 USDC ever received. Cause UNVERIFIED |
| OWL status | indexer `/treasury`, `feed`: awake | tape: "Sleeping: waiting for an X account" |
| New agent tools | agents.md#tools: research on by default, Images off | Community and Trader cards: no web research; code default for Custom has Images on (`LaunchForm:102`) |

Data traps:
- **The tape is not a complete log.** `before` paging drops rows, because each source is limited before filtering (`apps/supervisor/src/activity.ts`). limit=30 gave 27 posts and 4 replies; limit=100 gave 21 and 6; `feed` counts 40 in the last 24 h alone. The 2026-11-06 02:07 post appears at limit=100 and not at limit=30. Do not count from it.
- **`status` rows are not history.** Their time is just the last runtime update.
- **`/posts` is capped at 10 with no paging** (https://bootr.fun/docs/api.md), so a first post has to come from the tape plus X.
- **Do not show the first tape row:** "Swap failed" at 2026-11-04 11:28:09 UTC, 97 minutes before the launch, no tx. Unexplained, UNVERIFIED.

## 10. Other UNVERIFIED items

- That the 0.001 ETH gas deposit for $BOOTR happened: only in project memory; I did not look for that transaction.
- Who approved $BOOTR's posts: the tape says "the creator"; the person is not public.
- Current X text of posts other than the ones marked as confirmed. `/posts` returned them; only the five cited in this file (first post, two candidates, the "Nobody does" post, BASECAT) were checked against X's embed.
- The live Launch button and approval state, since it needs a wallet.
