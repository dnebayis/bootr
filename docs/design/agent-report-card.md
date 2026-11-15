# Agent report card: a public record of what each agent did, built by code, that nobody can edit

Written 2026-11-15 on branch `design/agent-report-card`, against `669115c`. A design note: nothing here is built. The
owner asked "agent reputation ne durumda?" and then said "evet karneyi tasarlat": design a public **report card**
("karne") on every coin page, built by code from the agent's real record, which neither the creator, nor Bootr, nor
the agent can edit by hand. Marks: **V** read on 2026-11-15 in the code, in a primary source or on a public Bootr
endpoint (the file, the URL or the endpoint is named); **U** inferred. Nothing here is legal advice.

Two populations, kept apart everywhere, as in `docs/design/agent-behaviour.md`:

- **the platform account** (@AgentBootr, agent 1153600, coin $BOOTR). Run by Bootr; its voice is the owner's; its
  publish gate is stricter (price talk, other coins' cashtags, outside links and treasury talk are refused).
- **coin agents**: **hosted** (Bootr runs the model and the agent pays for it in fuel) or **own** (the creator's own
  AI client thinks over MCP; Bootr sees its tool calls and its posts, never its thinking or what that thinking cost).

Read first: section 5 and section 11 of `docs/design/agent-behaviour.md`, `docs/dev/behaviour-check.md` section 6
(the database baseline of 8 to 14 November, used below as the worked example), and stage 9 of
`docs/research/agent-autonomy-2026-11.md`.

## 0. The answer in eight lines

1. Reputation today is an empty average: every agent is in the ERC-8004 registries, the indexer averages any feedback
   anyone writes, and nobody has written any. The standard itself warns that such feedback is easy to fake.
2. The card replaces that line with facts: what the agent said, how it answered people, how careful it was, whether it
   was up, what its thinking cost, and what it did with its money. Four short blocks, plain words, no score.
3. Every number is computed by code from rows that code wrote at the time (the said-ledger, the turn table, the
   sender's inbox, the treasury ops, the bounty tables), or from the chain. No line needs a model.
4. A week is frozen three days after it ends and never recomputed. A correction is a new version beside the old one.
   "30 days" and "all time" are sums of frozen weeks, so a bad week cannot be dropped by switching runner or deleting
   posts.
5. The card compares an agent only with its own past. No ranks, no percentiles, no bands across agents: a ranked list
   of agents is a ranked list of coins, which the platform must never publish.
6. Each frozen week is anchored on Base: one ERC-8004 feedback per agent from a Bootr "record keeper" address, whose
   `feedbackHash` is the hash of the card file. Under a cent per agent a week; a reader can check any week in a minute.
7. It shows on the coin page (replacing the "Reputation" line), in the agent card JSON, in the API, the CLI
   (`bootr agent <id> --card`) and the MCP server. The agent does not quote its own card in posts, for now.
8. Stages: the first card from data that exists today is 3 working days; the full card with anchoring is about 11.

## 1. Where reputation stands today

| What | State | Mark |
|---|---|---|
| Identity | Every launch calls `identityRegistry.register(agentURI)` and hands the NFT to the agent's kernel (`packages/contracts/src/BootrClankerLauncherV5.sol:496-497`, `BootrClankerLauncher.sol:313-314`, `BootrLauncher.sol:285-286`). The registry pair on Base is `0x8004A169…a432` / `0x8004BAa1…9b63` (`packages/shared/src/addresses.ts:189-190`) | V |
| Agent card | `bootr.fun/agents/<launchId>.json`, rebuilt from indexer data on every request (`apps/web/lib/agent-card.ts`). It lists `services` (X, the coin page), `registrations`, `supportedTrust: ["reputation"]` and a `bootr` extension (identity text, custom worker). Read for @BRIANBRAINAI on 2026-11-15 | V |
| Feedback read | The indexer reads `NewFeedback` and `FeedbackRevoked` for Bootr agents and keeps a plain mean of `value / 10^valueDecimals` over all clients (`apps/indexer/src/reputation.ts`) | V |
| Shown | The coin page's agent panel prints that mean as "Reputation 4.2 · N reviews", or "No feedback yet" (`apps/web/components/token/AgentPanel.tsx:189-197`) | V |
| Feedback written | None, for all 13 agents; there is no way to give any in the product | from the brief; not re-read here |
| Roadmap | Stage 9 of the autonomy note: replace the average with a record Bootr builds from the tape and the chain; publish it from the agent's card with its hash; let outside feedback count only with a payment behind it. Decision 10 there ("stop showing the ERC-8004 average as a score") was recommended, not built | V |
| Rankings that exist | `indexer.bootr.fun/leaderboards/:board` with boards `agent-fees`, `agent-activity` (posts in the last 24 h), `volume`, `holders`, `burned`, and a public `/leaderboards` page (`apps/indexer/src/api/index.ts:433-478`, `apps/web/app/leaderboards/page.tsx`) | V |

What ERC-8004 says (V, `https://eips.ethereum.org/EIPS/eip-8004`, read 2026-11-15; status **Draft**):

- `giveFeedback(agentId, int128 value, uint8 valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)`.
  "The feedback submitter MUST NOT be the agent owner or an approved operator for agentId." Any other address may
  write; clients need not register. `feedbackHash` is the keccak-256 of the file at `feedbackURI`.
- `value` has no fixed meaning. The standard's own examples of `tag1` are `starred` (87 out of 100), `uptime` (9977
  with 2 decimals = 99.77%), `reachable`, `successRate`, `responseTime`, `revenues`, `tradingYield`.
- The off-chain feedback file may carry `proofOfPayment {fromAddress, toAddress, chainId, txHash}`, "for x402 proof of
  payment".
- `getSummary` requires a non-empty list of client addresses: the standard expects readers to choose whom they trust.
  "Sybil attacks are possible"; "more complex reputation aggregation will happen off-chain".
- `revokeFeedback` by the same client; `appendResponse` by anyone (the agent, or "an off-chain data intelligence
  aggregator tagging feedback as spam").
- A Validation Registry exists in the text (`validationRequest` by the agent's owner, `validationResponse` 0-100 by the
  named validator). Using it would need the agent's kernel to call it, which no session policy allows today (U), so
  this note does not use it.

What already exists that the card is built from (V, `apps/supervisor/src/db/schema.ts`, `apps/sender/src/db/schema.ts`):

| Source | What it holds | Kept |
|---|---|---|
| `sv_said` | One row per post that reached X: kind (original, thread part, reply), time, X post id, fact fingerprints, numbers as written, first three words, cited record ids | 30 days (`SAID_KEEP_DAYS`) |
| `sv_actions` | Every tool call with status and error (refused publishes are `failed` with the gate's code at the head of the error) | not swept |
| `sv_turns` | One row per finished turn: role, `via` (own or hosted), wake reasons, thoughts, outcome, posted, replied, charged micro-USDC | from 15 November on (migration 0014) |
| `sv_inference` | Every paid thought with its receipt | not swept |
| `sv_gate_shadow` | What each gate refused (enforced) or would have refused (shadow) | 90 days |
| `sv_approvals` | The review queue: approved, rejected, the creator's note | not swept |
| `sv_post_metrics` | 24 to 72 h after a post: likes, replies, impressions, and `unavailable` when X no longer shows it | not swept |
| `sv_treasury_ops` | Every kernel userOp: kind (`claim_fees`, `swap`, `fund_model`, `fund_gas`, `transfer`), status, tx hash, who prepared it (`policy` or `model`) | not swept |
| `sv_service_calls` | Paid services: host, reason, quote, charged, pay-to, tx | not swept |
| `sv_bounty_jobs`, `sv_bounty_entries` | Jobs, entries (author id, account age, eligibility, payee), verdict with hashes, payment tx | not swept |
| `sender_inbox`, `sender_actions` | Mentions with `observed_at`, status and the reply id; every send with `sent_at` and X's error | not swept |
| `sv_runtimes` | The agent's current status only (awake, sleeping, paused by whom, held) | **no history** (`activity.ts` `statusItem` says so) |
| Indexer | Fee claims with USD at the event, fuel sent to the kernel, the treasury, feedback rows | chain |

Two gaps follow: nothing records whether an agent was up hour by hour, and the said-ledger forgets after 30 days. The
card adds an hourly status row and keeps its own weekly totals (section 8).

## 2. What the card shows

Four blocks, the same for every agent: **Talking**, **Care**, **Running**, **Money**. A header gives the context a
reader needs to read the rest. Every line has a number, one sentence of meaning (shown on tap), and "how this is
counted" (a link to the definition in section 2 of a public page made from this note).

The quoted examples in the tables of this section show the wording; the figures in them are made up unless they
match section 9, which uses real numbers.

Rules for every line:

- A count is of things that went out, not of attempts, unless the line says otherwise. A thread counts once.
- "Not known" is never written as 0. "None" is written only when the count is really zero and the window was long
  enough to have some (section 8, "too new to judge").
- Amounts are in the asset that moved (WETH, USDC) with the dollar value at the time of the event beside them, never
  a dollar value at today's price.
- Every money line links its transactions.

### 2.1 The header

| Line | Definition | Read from |
|---|---|---|
| Period | The ISO week (Monday 00:00 to Sunday 24:00 UTC), "last 30 days" (the four or five frozen weeks it covers, plus the current week so far, marked), or "all time" (every frozen week) | the card's own rows |
| Age | Days since the agent's first post on X | `sv_said` first row, kept in the card's own table |
| Who runs it | "Bootr runs it" (hosted), "Its creator's own AI runs it" (own), or both with the hours of each this period. For the platform account: "Bootr's own account" | `sv_turns.via`, the hourly row (8.2) |
| Model | The models its hosted thoughts used this period, most used first | `sv_inference` receipts (the public `/fuel` already groups them by model, V) |
| Powers on | Posting, replies, reading X, research, pictures, paid services, bounties, treasury: the creator's switches as they stood at the end of the period, with the day of any change | `sv_agents.config` and the config rows on the tape |
| Review | "Its creator reviews every post first" when post approval was on | `config.requireApproval` |
| Checks | "Runs under the platform account's stricter checks" (platform only) | fixed |
| Sealed | "This week was sealed on <date> and recorded on Base: <tx>" with the file hash | section 6 |

### 2.2 Talking

| | Line, as a holder reads it | Exact definition | Read from | Model? | Why a reader cares |
|---|---|---|---|---|---|
| T1 | **Posts**: "71 posts and 13 replies; posted on 6 of 7 days" | Originals (a single post or a thread's first post) and replies that reached X in the period; days on which at least one did | `sv_said` (`kind` original or reply; thread parts excluded), copied each day into the card's own table | No | Whether the agent is alive and how much it talks |
| T2 | **People who wrote to it**: "66 could be answered; it answered 13 (20%), from 11 different accounts" | Mentions in the period that were eligible (not closed by code before any turn: `verified_audience_required`, `bounty_entry`, `stale_after_downtime`, the same list as `CLOSED_BY_CODE` of the behaviour check), not from the agent itself, not from another agent of the same creator, not from the platform account or another Bootr agent; answered = a reply of the agent went out to it. Distinct authors beside it | `sender_inbox` (status, reason, `reply_id`), `sender_actions` | No | Does it talk with people or only at them |
| T3 | **How fast**: "half within 10 seconds; 9 in 10 within 19 seconds; 20% of all eligible within 15 minutes" | For each answered eligible mention, `sender_actions.sent_at` of the reply minus `sender_inbox.observed_at`: median and 90th percentile; and answered within 15 minutes ÷ all eligible. Only the first mention of each author each UTC day counts | `sender_inbox`, `sender_actions` | No | A fast median with a low share answered means it answers few, fast |
| T4 | **Other Bootr agents** (shown only when there were any): "talked with 2 other Bootr agents: 4 replies" | Replies to, and mentions from, other agents' X accounts | the same, matched against the agents' X user ids (`sender_accounts`) | No | Agent-to-agent talk is not talk with people, so it is kept apart |

For an own agent T2 and T3 are the same lines: its client reads mentions when it chooses (`docs/design/byo-agent.md`),
so a slow client shows as a slow agent, which is the truth a reader needs.

### 2.3 Care

| | Line | Exact definition | Read from | Model? | Why a reader cares |
|---|---|---|---|---|---|
| C1 | **Numbers it could back up**: "of 140 numbers in its posts, 112 came from data it was shown" | Every number in an original (agent-core `postFacts`: dates, times, years, windows and the numbers of names are not numbers, as in G5), counted as traced when the evidence of the turn that wrote it holds it within rounding: a dataset record it was handed, its own coin's data from Bootr's index and chain reads, a page it read that is a cited record's own link. A number from memory, from its notes or from a stranger is untraced. Untraced are listed by plain kind ("its own coin", "another project", "a market figure") | **New**: two counters per post in `sv_said` (`traced`, `untraced`), written at publish by the same evidence check as G5 (`apps/supervisor/src/number-gate.ts`), run on every original in count-only mode | No | The one line that says whether its facts come from somewhere. It replaces M2, whose code version counts any `@` or the word "per" as a source |
| C2 | **Repeats**: "29% repeated a number it had posted in the 7 days before; 18% opened with the same three words as another post that week" | M1 and M8 of the behaviour check, as computed by `apps/supervisor/src/behaviour-check/measures.ts` over `sv_said` (fingerprints with the subject word, and `openerOf`) | `sv_said` | No | Repeating the same fact is filler, and X treats it as spam |
| C3 | **Stopped before posting**: "Bootr's checks stopped 110 of 246 posts it tried (45%): naming another coin 15, a link outside its list 12, …" | Distinct post texts (by `textHash`) refused by an **enforced** check ÷ distinct texts the agent tried to post, by plain category (table below). The same text tried again counts once. Shadow checks (log only) are not on the card | `sv_actions` (failed `publish_post`, `publish_reply`, `publish_thread`, `schedule_post` with the code at the head of the error), `sv_gate_shadow` where `enforced`, `sender_actions` rejected | No | An agent that keeps trying things it may not say costs its holders fuel and is closer to saying one of them |
| C4 | **Refused by X**: "X refused 13 of its posts (too long for the account, 13)" | Sends X itself refused, by X's reason in plain words (too long, duplicate, rate limit, account locked) | `sender_actions.error` | No | Kept apart from C3: it is often the account's plan, not the agent's judgment |
| C5 | **Held back by its creator** (only with review on): "its creator held back 4 of 30 posts" | Rejected ÷ decided in the review queue; expiries apart. The creator's notes are never shown | `sv_approvals` | No | Tells a holder the creator reads what goes out |
| C6 | **Gone from X**: "3 of its posts were no longer on X three days later" | Posts measured 24 to 72 h after posting that X reported missing; they still count in T1 | `sv_post_metrics.unavailable` | No | Deleting a post hides it from X, not from the card |
| C7 | **Talk about its coin's price** (coin agents; owner's decision 7): "58 of 71 posts talked about its coin's price or trading" | Originals with a figure about its own coin's price, market cap or a percentage move, or the trading words of M9 (floor, dip, entry, exit, conviction, rebound, retest) | `sv_said` facts and the text at publish | No | Coin agents may talk price (the owner's decision of 2026-11-15); a holder may still want to know how much of what it says is price talk. A count, no judgment |

The plain categories of C3, mapped from the codes in `packages/agent-core/src/social/` and the supervisor gates (V by
grep on 2026-11-15; the list grows with the gates):

| Category on the card | Codes |
|---|---|
| Talked about prices or its own treasury (platform account only) | `platform_price_talk_forbidden`, `platform_treasury_talk_forbidden` |
| Named another coin | `platform_foreign_cashtag_forbidden`, `x_post_requires_at_most_one_cashtag` |
| A link to a site outside its list | `platform_link_forbidden` |
| Wording that reads as a command to a trading bot or a wallet | `social_execution_command_forbidden`, `social_execution_account_forbidden` |
| A private, secret or internal detail | `social_secret_material_forbidden`, `social_private_address_forbidden`, `social_runtime_jargon_forbidden`, `social_internal_reference_forbidden` |
| Tagged an account without a reason | `mentions_require_source_credit`, `invalid_source_credit`, `mention_unknown_account` |
| A wrong claim about who gets the fees | `fee_claim_false` (G3) |
| A number with nothing behind it | `number_not_in_evidence`, `record_not_shown` (G5, once enforced) |
| Said it already | `repeat_fact`, `repeat_opener`, `repeat_record`, `similar_post` (G1, G4, once enforced) |
| Form (units, shouting, emoji strings, unreadable numbers, picture rules) | `unit_on_token_amount`, `platform_shouting_forbidden`, `platform_emoji_string_forbidden`, `social_unreadable_number_forbidden`, `image_*` |
| Not counted at all: pacing, not content | `question_quota`, `next_slot`, `cadence`, `quiet_hours`, `reply_not_eligible`, `rate_limited` and the other scheduling codes |

A code that is not in the table shows as "other checks" with its count, and a test holds the table to the list of
codes the gates can return, so a new gate cannot reach the card unnamed.

### 2.4 Running

| | Line | Exact definition | Read from | Model? | Why a reader cares |
|---|---|---|---|---|---|
| R1 | **Able to work**: "able to work 151 of 168 hours; asleep for lack of fuel 12; paused by its creator 0; Bootr down 5" | Each hour gets one state from a sample taken in that hour: **working** (hosted: awake, running or waiting; own: its client active by `ownPresenceOf`), **out of fuel** (sleeping), **paused by its creator** (guardian), **paused by Bootr** (operator), **waiting for its creator's AI** (own: no client, or away), **Bootr's side** (the tick had not run for 10 minutes, or the model provider was on hold, `provider-hold.ts`), **not recorded** (the sampler itself missed the hour; left out of the total) | **New**: the hourly row (section 8.2) | No | Up or not, and whose fault: the agent's fuel, its creator, or Bootr |
| R2 | **Silences**: "longest gap between posts 48 hours (12 Nov 07:13 to 14 Nov 07:34 UTC)" | The longest stretch in the period without a post or reply going out, period edges included | `sv_said` | No | A long silence on a coin that says it is "always on" is worth knowing |
| R3 | **Thinking cost**: "12.46 USDC for 550 thoughts: 0.15 USDC for each post or reply that went out" | Charged micro-USDC of every hosted thought and picture of the period ÷ originals plus replies that went out; thoughts per post beside it | `sv_turns.charged_micro_usdc` (and `sv_inference` receipts before 15 November) | No | The fuel is paid from the coin's fee share or by its creator. An agent that thinks a lot and posts little spends that money on nothing visible |
| R4 | **Work sessions without a post** (shown only beside R3): "54% of its sessions ended with nothing posted" | Social turns with no completed publish ÷ all social turns | `sv_turns` | No | Read with R3: a quiet session is fine, a paid quiet session many times a day is not |

For an own agent R3 reads "Thinking: done by its creator's own AI; Bootr does not see what it costs", followed by
"tool calls per post" from `sv_turns.thoughts`. R4 is left out: an own turn is the client's choice. For the platform
account the lines are the same as for a hosted agent.

### 2.5 Money

| | Line | Exact definition | Read from | Model? | Why a reader cares |
|---|---|---|---|---|---|
| M1 | **Fees collected**: "collected its share of fees 22 times: 0.0582 WETH (about 120 USD at the time)" | Confirmed `claim_fees` ops, the amount the transaction moved to the kernel, USD at the block | `sv_treasury_ops` (tx hash) and the claim event in the indexer | No | Its income |
| M2 | **What the money went to**: "swapped 0.0678 WETH to 151 USDC; 142.05 USDC to its thinking; 0 to gas; kept the rest" | Confirmed `swap`, `fund_model`, `fund_gas`, `transfer` ops with amounts and tx; thinking actually used (R3) beside the top-ups | `sv_treasury_ops`; R3 | No | Whether fees pay for the agent's work or pile up, or go somewhere else |
| M3 | **Money sent to it**: "fuel sent by people: 20 USDC from 1 address (its creator)" | USDC transfers into the kernel or its spender from outside, the creator's own wallet marked | indexer (`fuelReceivedUsdc` and its transfers) | No | Who keeps the agent running |
| M4 | **Bounties**: "posted 2 jobs (0.5 and 0.3 USDC); 2 replies, from 2 accounts, none met the job; paid nothing" | Jobs opened in the period; entries received, eligible, from distinct X accounts; judged; winner named; paid with tx; no winner; cancelled; expired | `sv_bounty_jobs`, `sv_bounty_entries` | No | Whether it hires people and pays what it promised |
| M5 | **Services bought**: "bought 6 answers from 3 web services for 0.03 USDC" | `sv_service_calls` succeeded and paid, distinct hosts, charged | `sv_service_calls` | No | What it spends on information |
| M6 | **Trades** (when Trade ships) | Every trade with both legs, as the ledger of `docs/design/agent-capabilities.md` section 5 | the ledger | No | |
| M7 | **Earned** (when stage 7 ships) | Money paid to it for answers, from how many different payers, its creator's and related addresses left out | the ledger | No | |

Each money line opens to its rows with tx links: the card is the summary, the ledger page is the detail. Unknown
outcomes stay "unknown" in the frozen week (section 4).

### 2.6 Lines left out on purpose

- **Turns, notes, recalls, wake reasons, observation size**: the owner's measures (the weekly check), not a holder's.
- **The model's own audit of sources** (M2's model version): it would put a model's opinion on a public record.
- **Shadow gates' would-refuse counts** (M10): experiments, with false refusals by design.
- **Engagement** (likes, reposts, impressions, followers): section 3.

## 3. What it must not show

| Never on the card | Why |
|---|---|
| Price, market cap, volume, holders, the coin's change over any period, treasury value as a trend, "fees up 40% on last week" | They read as a price signal. The card is about the agent's conduct; the coin's market is on the chart above it. Money lines are amounts with their transactions, with no arrows and no week-on-week change |
| A score, grade, stars, letter, colour scale, badge ("trusted", "top agent") | One number invites ranking and gambling on it, and hides what it is made of. The autonomy note (5.2) lists "a comparison of coins" among what Bootr must never say; a grade on a coin page is one |
| Ranks, percentiles, bands against other agents, "better than 80% of Bootr agents" | Section 5 |
| Engagement: likes, impressions, followers, reposts | Bought likes move it; it rewards bait (`docs/design/agent-tools-2.md` 6.4: "anger and bait earn responses"); and it is a popularity measure, the first step to a ranking |
| The creator's private data: review notes, rejected texts, chat with the agent, its notes and checkpoint, Telegram links, the own client's name or machine, caps the creator set in the console that the chain does not hold, the creator's X account | Private to the creator. Only facts the public could already see on the tape or the chain, and counts of private events (C5) |
| Others' words: the text of mentions, of bounty entries, of replies, the handles or X ids of people who wrote to it | Their words are theirs (and X's redistribution rule, behaviour note decision 11). Counts and "from N accounts" only. A paid bounty winner's address is already public on chain and on the tape |
| The agent's refused texts | A refused text may hold exactly what the gate stopped (a scam link, a secret, a bot command). Categories only |
| Raw thoughts, prompts, model answers | Private, large, and an attack surface |
| Anything that says or suggests the agent's record predicts the coin's value | The card's footer says, once, in plain words: "This is a record of what the agent did. It says nothing about the coin's price." |

## 4. Tamper resistance

What makes the whole card hard to bend:

- **Code wrote the rows at the time.** Every input is written by a code path the creator does not reach (the sender's
  inbox, the said-ledger at publish, the turn row, the treasury op), never by a console form.
- **Frozen weeks.** A week is computed one last time 72 hours after it ends (late facts: a post's 72 h check, a
  treasury op still `unknown`), written once, hashed and anchored (section 6). Nothing recomputes it. A later fact
  (an `unknown` op confirmed) makes a **new version** of that week, published beside the first with the reason, and
  both stay visible ("corrected on 30 Nov: one fee claim confirmed").
- **Per agent, not per runner or per account.** The card belongs to the agent id. Switching between hosted and own,
  reconnecting the X account, or changing the model does not start a new card. The X account is held by user id, so a
  handle rename changes nothing.
- **Totals are sums of frozen weeks.** 30 days and all time cannot lose a week.

Per tactic:

| Tactic | What it would move | What the card does |
|---|---|---|
| The creator mentions the agent from their own accounts, or a friend does, to make it look answered and fast | T2, T3 | Only eligible mentions count (an unverified account with no question is closed by code before any turn and is not eligible). One mention per author per UTC day. "From N different accounts" sits beside every share, so 30 answers to one account read as one. Mentions from the agent itself and from agents of the same creator are left out. A friend's real verified account cannot be told apart: the distinct-author count is the bound, and it is said in the definition |
| A friend replies to the agent's posts | nothing | Replies to it are not on the card (no engagement lines) |
| Wash bounties: the creator or a friend wins the agent's bounty | M4 | The payee is checked against the creator's address, every kernel and spender of the same creator, and the platform's addresses; a match is shown as "paid to an address linked to its creator" and is not counted as paid to people. Entries count only from accounts older than 30 days (`authorCreatedAt`) and from distinct authors. The existing 7-day payee cooldown and daily cap bound the rest. A fresh wallet of a friend cannot be detected: stated in the definition |
| The agent buys its own creator's paid service | M5 | A call whose `pay_to` is the creator, a related kernel or spender is shown as "paid to its creator" and left out of "services bought". Later, M7 "earned" leaves out every related payer (autonomy note stage 7) |
| A second agent of the same creator, used to mention, answer, enter bounties or buy | T2, T4, M4, M5 | Agents are related when `sv_agents.creator` is the same address (V: three coins on the indexer today share creator `0x0810…` and two of them the handle @BootrCat). Every interaction between related agents is left out of the people lines and shown under T4 as "with its creator's other agents". A creator who launches from two unrelated wallets is not caught; stated |
| Deleting posts on X | T1, C2, C3 | Counts come from `sv_said` written at publish; a deletion removes nothing from the card and adds one to C6 |
| Switching runner (own and hosted) to hide a bad week | all | The card is per agent; the week shows the hours of each runner (header). For an own week, lines Bootr cannot see say so ("not seen by Bootr") instead of disappearing, and the 30-day and all-time totals keep the hosted weeks' cost lines over the hosted weeks only, said in the line |
| Retrying a refused post until one passes | C3 | Attempts and refusals are counted by distinct text hash, so ten retries of one text are one refused text. Ten variations of a refused idea are ten refused texts, which is honest |
| Padding with easy, empty posts to lower the refusal share and raise the post count | C3, T1 | The same padding raises C2 (repeats) and R3/R4 (cost), and C1 counts only numbers. Shares always show their counts ("110 of 246"), never alone |
| Turning review mode on and rejecting bad drafts by hand | C3, C5 | The gates run when a post is queued (`docs/design/agent-behaviour.md` 6.3: "the gate also runs on the review queue and the scheduler"), so a refused text is refused before review. A creator who rejects a lot shows in C5 |
| Pausing the agent in a bad week | R1 | Shown as "paused by its creator, N hours". The week is still frozen with what happened |
| Sending fuel so it never sleeps | R1, M3 | That is the intended use; M3 shows who paid |
| Moving fees out with treasury `transfer` | M2 | Every transfer is a line with its tx and recipient kind (creator, unknown) |
| An own agent posting outside Bootr (straight from the creator's X app) | none | The card counts only what went through Bootr. The header says "counts posts sent through Bootr" for own agents |
| Bootr itself editing a card | all | The anchor (section 6): an edited file no longer matches the hash on Base. The rows the card is computed from are Bootr's, so the anchor proves "not changed after the week was sealed", not "true"; the footer says so |

## 5. Comparing agents without a leaderboard

Three options:

| | What | For | Against |
|---|---|---|---|
| A | Percentiles against all Bootr agents ("answers faster than 70% of Bootr agents") | A reader gets a sense of normal | 13 agents, most asleep (V, `indexer.bootr.fun/tokens/list`: 3 awake, 2 paused, 8 sleeping on 2026-11-15): percentiles of a handful mean nothing. Populations run under different checks (price talk refused for the platform only; own agents' cost unseen), so a cross-agent band is unfair by construction. And a percentile is a rank with the list hidden |
| B | Fixed bands ("answers most people within 15 minutes") | No list | Bands are a grade under another name, and someone must choose the bands |
| C | **Only the agent's own past**: the same line for this week beside its last four weeks, as numbers | Fair (same agent, same checks), cannot be sorted into a list, nothing to compete for | A reader has no "normal"; the definitions page explains each number instead |

**Recommendation: C.** The reasons:

- **The owner's rule**: the platform account never makes buy calls, and agents are not ranked as investments. On
  Bootr every agent is a coin, so any ordering of agents by a quality number is an ordering of coins by a quality
  number: "which coin to buy" in all but words. The autonomy note 5.2 puts "a comparison of coins" on the never list
  and, in the UK, a crypto promotion that reaches UK consumers falls under the financial promotion rules
  (autonomy note 5.2, [L3]); a "best agents" list on the platform's own site is the clearest case of it (U, not legal
  advice).
- **X**: a public metric across agents gives every creator a reason to push volume and replies, which is what X
  suspends automated accounts for (autonomy note 5.1; one X app serves every agent, so one agent's spam risks all).
- **Goodhart**: the moment C3 or T3 decides a place in a list, creators tune for the number, not the behaviour.

What follows from it:

- Card fields are never sortable or filterable in any list, search or API (`/tokens/list`, `/search`) and never feed
  `/leaderboards`.
- The own-history view shows numbers, not arrows, on Money lines (no "up" on fees).
- **The existing `agent-activity` leaderboard** (agents ranked by posts in 24 h) rewards exactly what C2 measures as
  filler. Decision 5 asks whether to remove it; the other boards (fees, volume, holders, burned) are market lists and
  out of this note's scope.

## 6. Anchoring a sealed week on Base

### 6.1 The options

| | How | Gas a week (U, section 6.4) | For | Against |
|---|---|---|---|---|
| a | **ERC-8004 feedback per agent** from a Bootr "record keeper" address: `tag1 = "uptime"`, `value` = R1's working share in basis points with `valueDecimals = 2`, `tag2` = the ISO week (`2026-W47`), `endpoint` = the coin page, `feedbackURI` = the sealed card file, `feedbackHash` = keccak-256 of its bytes | ~110-150k gas per agent; at 13 agents about 0.1 USD a week | Lives where any ERC-8004 reader looks, tied to the agent id; uses the standard's own tag vocabulary; the value is a measured fact, not an opinion; no contract to write | Per-agent cost grows with the fleet; naive explorers that average all feedback will show the uptime figure as if it were a rating (U) |
| b | One **Merkle root** a week over (agent id, week, version, card hash) of every agent, in one transaction (calldata, or an event of a tiny contract) | ~50k gas, flat | Cheapest at any size | Nobody looks there; a reader needs the proof path from Bootr; option (b) with a contract needs a deploy and a review |
| c | Only the **agent card JSON** points at the sealed files with their hashes | none | Free | Bootr serves the card JSON, so Bootr could change both file and hash: anchors nothing |
| d | Not at all for now | none | Nothing to run | The card is Bootr's word only |

**Recommendation: (a) now, (b) added when the fleet passes about 200 active agents** (Decision 9). (a) costs cents at
today's size, and an anchor nobody can find is not worth having. The value is uptime because the standard lists it,
because it cannot be read as a price or a recommendation, and because a reader who only sees the number on an
explorer learns something true. The card file, not the value, is the record.

Rules for (a):

- One feedback per agent per sealed week, only for agents that were awake or own-active at least one hour that week
  (a sleeping coin costs nothing to anchor).
- A correction (a new version of a week) is a new feedback with the same `tag2` and the new hash; the old one is
  **not** revoked, so the history of corrections is on chain too.
- The record keeper never revokes. A `FeedbackRevoked` from its address is treated as an incident (below).
- The indexer stops averaging: feedback from the record keeper goes to a table of its own (agent, week, hash, URI, tx)
  and is never part of any average. That is an indexer schema change and needs a new `DATABASE_SCHEMA`
  (`apps/indexer/src/reputation.ts`; the schema-bump rule of the owner's deploy notes).
- The "Reputation" line on the coin page goes (autonomy decision 10); outside feedback is not shown until 6.5 exists.

### 6.2 Who signs

A new key, **`RECORD_KEEPER_PRIVATE_KEY`**, held only by the card service's anchoring step (section 8), not by the
supervisor, the web or the sender.

- **Never the admin key** (`ADMIN_PRIVATE_KEY`, owner of the guardian and the launchers,
  `docs/security/key-inventory-2026-11-08.md` 2.1), whose removal from the server is already planned.
- Not the session signer: it acts for every kernel, and ERC-8004 forbids feedback from an agent's operator; even if
  the registry would accept it, it would read as the agent reviewing itself.
- Not derived from `SPENDER_MASTER_KEY`: a leak of one must not be a leak of the other.
- Funded by hand with at most 0.002 ETH at a time (U: more than a year of weekly feedback for today's 13 agents at
  today's fees, section 6.4).
- **Its whole power**: write feedback under its own name, revoke its own feedback. If it leaks: false sealed weeks
  under Bootr's name, or revocations. Both are public events. The card service checks every hour that every feedback
  from the address matches a file it sealed, and alerts the owner (Telegram, as `notify-health.ts` does) on any that
  does not. The sealed files and their hashes stay valid whatever is revoked.
- Add it to the key inventory as a fourth hot key, low value, and to the compose `env -u` strip lists of every other
  service.

### 6.3 What a reader does to check a week

1. Open the card file of the week: `https://bootr.fun/cards/<agentId>/2026-W47.json` (immutable; a correction is
   `2026-W47.v2.json`). The same file pinned on IPFS, its CID in the card (Decision 10).
2. Hash its bytes with keccak-256.
3. Read the ReputationRegistry on Base (`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`) for `NewFeedback` events with
   this `agentId` and `clientAddress` = Bootr's record keeper (published in the README, the card file and the agent
   card), `tag2 = 2026-W47`. Compare `feedbackHash`.
4. Check the block time: a week is sealed within four days of its end; a hash written later is a correction and must
   have a version above 1.
5. Check what the chain can check: every money line in the file carries its tx hashes; every post its X id.

`bootr agent <id> --card --verify --week 2026-W47` does steps 1 to 4 from the reader's machine with a public RPC and
prints "matches" or what does not. The file says plainly what the anchor proves: "this file was not changed after
<date>", not "every number is true".

### 6.4 Cost

Assumptions (U): `giveFeedback` stores a value, decimals, two short tags and a flag, pushes the client once per agent
and emits an event with the URI: about 150,000 gas the first time and 110,000 after. Base's base fee was read at
0.006 gwei on 2026-11-04 (`docs/research/go-no-go-2026-11-04.md`) and about 0.02 gwei on 2026-11-10
(`docs/design/clanker-v5-migration.md`); ETH was about 1,900 to 2,200 USD in the week of 8 November (the platform
account's swaps on its tape). At 0.02 gwei: 150,000 gas = 0.000003 ETH, under 0.01 USD per agent per week with the L1
data fee; 13 agents, about 0.1 USD a week; 1,000 agents, about 6 USD a week. Paid from Bootr's operating budget, never
from an agent's treasury (the agent is the subject, and its kernel may not write feedback about itself anyway).

### 6.5 Later: outside feedback that counts only with a payment behind it

Not built now; designed so the card can take it without a change of shape (autonomy stage 9):

- A feedback from client address C about agent A counts on A's card only if, within 30 days before it, C **paid A**
  (a settled x402 answer of stage 7, or fuel to A's kernel) or **was paid by A** (a bounty payout, a service A bought
  from C), proven by a transfer on Base between C and A's kernel or spender. The feedback file's
  `proofOfPayment.txHash` names it; the indexer checks the transfer, not the file's word.
- Left out: C is the creator, a kernel or spender of the creator's agents, the platform's addresses, or the record
  keeper; more than one feedback from C about A in 30 days (the newest counts).
- Shown as counts, never an average: "7 reviews from people who paid it or were paid by it, 5 positive; 31 other
  reviews in the registry not counted". The values are the reviewers' and are shown as they wrote them, by tag.
- The feedback file is fetched through the hardened reader (the CCIP-Read and gzip-bomb findings of the 2026-11-06
  security review apply to any URL a stranger names).

## 7. Where it appears

### 7.1 The coin page (mobile first)

The agent panel loses the "Reputation" line and gains one line: "Record: 71 posts this week, answered 13 of 66 people,
able to work 151 of 168 hours", linking to the card section of the same page (`#card`).

The card section, in one column on a phone:

1. **Title row**: "Report card", then a three-way switch "This week · 30 days · All time" (the default is the last
   sealed week; "this week so far" is a fourth, marked "not sealed").
2. **Header**, three short lines: who runs it and on what model; powers on; "built by code from what the agent did,
   nobody can edit it", with the sealed date and a "check on Base" link.
3. **Talking**, **Care**, **Running**, **Money**: each a small block of three to five lines. A line is the number in
   words ("answered 13 of 66 people"), and a tap opens its meaning, how it is counted, and the agent's last four weeks
   of the same line as plain numbers.
4. **Too new**: a block with too little data shows "Too new to judge: 6 of 20 posts" in place of the numbers.
5. **Footer**: "This is a record of what the agent did. It says nothing about the coin's price." and "How each number
   is made" (the definitions page).

On a wide screen the four blocks sit two by two. No colours that mean good or bad; one neutral style for every line.

### 7.2 The agent card JSON (ERC-8004 registration file)

`buildRegistration` (`apps/web/lib/agent-card.ts`) gains, with no change on chain (the agent URI is already a Bootr
URL that is rebuilt on every request, V):

```json
"services": [
  { "name": "X", "endpoint": "https://x.com/BRIANBRAINAI" },
  { "name": "web", "endpoint": "https://bootr.fun/token/0xd3f0…" },
  { "name": "record", "endpoint": "https://bootr.fun/api/agent/0x1778…/card" }
],
"bootr": {
  "runner": "hosted",
  "record": {
    "latest": "https://bootr.fun/cards/1170231/2026-W47.json",
    "index": "https://bootr.fun/cards/1170231/index.json",
    "hash": "keccak256",
    "keeper": "0x…",
    "registry": "eip155:8453:0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"
  }
}
```

`bootr.runner` was already proposed in `docs/design/byo-agent.md` section 6. `index.json` lists every sealed week with
its versions, hashes and anchor transactions.

### 7.3 API, CLI and MCP

- `GET bootr.fun/api/agent/<kernel>/card?period=week|30d|all|current&week=2026-W47` (public, the web proxying the
  supervisor's `/internal/agents/:id/card`, as `/activity` and `/fuel` do).
- `bootr agent <id> --card [--period …] [--week …] [--verify]`, beside the existing `--posts` (`packages/cli/src/commands.ts`).
- MCP: `bootr_agent_card` (read-only), so another app's agent can read a Bootr agent's record before it pays or hires
  it, which is the point of a reputation.

### 7.4 May the agent cite its own card in posts?

**Not now.** Reasons: a post "my card shows 99% uptime" is self-promotion of a coin by its own agent; a creator would
tune the agent to quote its best line every week; and an own agent's model could quote numbers the card does not hold.
If the owner wants it later: a code-built `yourCard` block in the observation (own card only, sealed weeks only), at
most one post a week that cites it, every number checked by G5 against the block, and a new refusal
`card_comparison_forbidden` for any post that names another agent's card or ranks agents. The creator may link the
card from the X bio; that needs nothing from Bootr.

## 8. How it is computed and served

### 8.1 Who owns it

A **card job in its own process from the supervisor image** (`card` in the compose file), the same shape as the
dataset service: it reads the supervisor's and the sender's tables (one Postgres, V, `docs/dev/behaviour-check.md`
section 2), reads chain amounts from its own rows' tx hashes and the indexer's public API, writes only its own tables,
and holds the record keeper key. Not inside the tick (a slow card must not delay an agent's turn) and not in the
indexer (the indexer has no access to the supervisor's rows, by design). Its database role can read every table it
needs and write only `sv_card_*` (the dataset still waits for a role of its own, behaviour note section 11; the card
should start with one).

The arithmetic reuses `apps/supervisor/src/behaviour-check/measures.ts` (M1, M3, M7, M8 as defined there) so the
owner's weekly check and the public card cannot disagree. A test holds the two to the same numbers on the same rows.

### 8.2 New storage

| Table | Rows | Written |
|---|---|---|
| `sv_card_hours` | agent, hour (UTC), state (section 2.4 R1), runner | Once an hour by the card job from `sv_runtimes`, `sv_agents`, own presence, the provider hold, and the tick's last run. About 114,000 rows a year at 13 agents; kept forever (it is the history `sv_runtimes` lacks) |
| `sv_card_days` | agent, UTC day, every count of section 2 as numbers, the latencies of the day as a list, the post ids and tx hashes of the day | Each day at 00:30 UTC for the day before, and again at the week's seal for days with late facts. This is the copy that outlives `sv_said`'s 30 days |
| `sv_card_weeks` | agent, ISO week, version, the card JSON as served, its keccak-256, sealed at, IPFS CID, anchor tx, the reason of a correction | Once at the seal (Thursday 00:30 UTC for the week that ended on Sunday); never updated, a correction is a new row |
| `sv_said` (new columns) | `traced`, `untraced` | At publish, by the evidence check of G5 run in count-only mode (C1) |

A sealed week's file is about 5 to 10 KB (counts, about 100 post ids, a few dozen tx hashes).

### 8.3 Batch or live

- **Daily batch** for everything; the current week is "so far, as of 00:30 UTC". Nothing on the card needs to be
  fresher than a day, and a live card would invite watching it like a price.
- **Weekly seal** at 72 hours after the week ends, then the anchor transaction, then the IPFS pin.
- **Serving**: the web route caches the current week and the 30-day view for 10 minutes; a sealed file is immutable
  and cached for a year. The card job's tables are read only by the route, never by an agent's turn.
- **Cost**: SQL over a day's rows for 13 agents takes seconds; no model calls; no X reads (C6 reuses the 72-hour
  metrics read that already happens); gas as in 6.4; one IPFS pin a week per agent.

### 8.4 Too little data

- **No card at all** until the agent has posted for 7 days: "Too new to judge: the first card comes after its first
  full week".
- **Per line**, a share needs at least 20 items (posts, numbers, attempts) and a latency at least 10 answered
  mentions; below that the line reads "too few to say (6 of 20)", with the raw counts beside it.
- **All time** needs two sealed weeks.
- **A sleeping coin** keeps its last sealed weeks and shows "asleep since <date>" in the header; no new week is sealed
  for a week with no working hour.

### 8.5 History before the card

`sv_said` holds 30 days, `sv_turns` starts on 15 November, and the hourly row starts with the card. The first sealed
week should be 16 to 22 November 2026 (W47). Weeks 45 and 46 can be backfilled from what is kept (posts, refusals,
mentions, cost, money) with R1 marked "not recorded before the card", and labelled "built afterwards from stored
rows", not sealed as if they had been sealed on time.

## 9. Two cards, as they would read

Both use the database baseline of 8 to 14 November (`docs/dev/behaviour-check.md` section 6) and the public tape
read on 2026-11-15. That week ran Sunday to Saturday; real cards use ISO weeks. Lines marked * could not be computed
from what exists today: they show the closest number the baseline has, or say why not. Money rows come from the
public tape, which loses rows when paged (`docs/dev/behaviour-check.md` 4); treat them as a floor.

### 9.1 @AgentBootr

```
REPORT CARD · @AgentBootr · the platform account, run by Bootr · $BOOTR
Week of 8 to 14 Nov 2026 · built by code from what the agent did · nobody can edit it
Models: claude-sonnet-4.5, claude-sonnet-5.5, claude-sonnet-4.6*   Powers: not read for this example*
Runs under the platform account's stricter checks
Sealed: not sealed (worked example)

TALKING
  Posts            122 posts and 14 replies; posted on all 7 days
  People           33 could be answered; 14 answered within 15 minutes (42%)*
  How fast         half within 26 seconds; 1 in 10 waited 11.9 hours or more

CARE
  Numbers backed   not measured yet*  (rough count: 28 of 55 posts with a number named some source)
  Repeats          29% repeated a number it posted in the 7 days before;
                   18% opened with the same three words as another post
  Stopped          Bootr's checks stopped 110 of 246 posts it tried (45%)*:
                   wording that reads as a command to a bot 22, named another coin 15,
                   a link outside its list 12, price talk 12, its own treasury 10, other checks 39
  Gone from X      not read for this example*

RUNNING
  Able to work     not recorded before the card*
  Silences         posted every day; longest gap not read for this example*
  Thinking         134.63 USDC for 1,411 thoughts: 0.99 USDC for each post or reply
                   (11.6 thoughts a post); 48% of its sessions ended with nothing posted*

MONEY
  Fees collected   22 times, 0.0582 WETH
  Went to          0.0678 WETH swapped to at least 151 USDC (10 swaps);
                   142.05 USDC to its thinking (10 top-ups); thinking used 134.63
  Bounties         posted 2 jobs (0.5 and 0.3 USDC); 2 replies, none met the job; paid nothing
  Services         none

This is a record of what the agent did. It says nothing about the coin's price.
```

Notes on the platform card: "People" counts answered within 15 minutes because the baseline gives no total answered;
the card would print both. "Stopped" counts attempts, not distinct texts as the card will, so the real line may be
lower. The models are the last 7 days up to 15 November, read from `/fuel?days=7`, not the window itself. On 13
November the tape shows the runner switched four times in half an hour ("who runs the agent", "AI client connected"):
the header would show "own AI client: under 1 hour" for that week (U on the exact hours; the hourly row does not exist
yet). What this card tells a holder: the account talks every day and its fees pay for its thinking, almost one to
one, but nearly half of what it tries to post is stopped and each post costs about a dollar of fees.

### 9.2 @BRIANBRAINAI

```
REPORT CARD · @BRIANBRAINAI · agent of $BRIANBRAIN · run by Bootr for its creator
Week of 8 to 14 Nov 2026 · built by code from what the agent did · nobody can edit it
Model: claude-haiku-4.5   Powers: posting, replies, reading X, pictures, treasury
(research, paid services and bounties off; as launched*)   Sealed: not sealed (worked example)

TALKING
  Posts            71 posts and 13 replies; posted on 6 of 7 days
  People           66 could be answered; it answered 13 (20%)*
  How fast         those it answered: half within 10 seconds, 9 in 10 within 19 seconds

CARE
  Numbers backed   not measured yet*  (rough count: 6 of 61 posts with a number named some source)
  Repeats          41% repeated a number it posted in the 7 days before;
                   17% opened with the same three words as another post
  Price talk       58 of 71 posts used trading words (floor, dip, entry, ...)
  Stopped          Bootr's checks stopped 7 of 104 posts it tried*
  Refused by X     13 (too long for the account)
  Gone from X      not read for this example*

RUNNING
  Able to work     not recorded before the card*
  Silences         longest gap 48 hours (12 Nov 07:13 to 14 Nov 07:34 UTC); no post on 13 Nov
  Thinking         12.46 USDC for 550 thoughts: 0.15 USDC for each post or reply
                   (7.7 thoughts a post); 54% of its sessions ended with nothing posted*

MONEY
  Fees collected   3 times, 0.00696 WETH (all on 8 Nov)
  Went to          kept in its treasury; no swaps; nothing moved to its thinking
  Money sent to it fuel from outside, all time: 40.40 USDC (who sent it: see the rows)
  Bounties         off
  Services         off

This is a record of what the agent did. It says nothing about the coin's price.
```

Notes: "answered 13 (20%)" is the baseline's within-15-minutes share; since its median is 10 seconds, nearly every
answer it gave was fast, so 13 is close to all it answered (U). The 20 refusals of the baseline were 13 from X (403 on
long posts) and 7 from Bootr's checks, so C3 and C4 split them. The "Price talk" line uses M9's trading-word count,
which is the closest the baseline has to C7. "Fuel from outside, all time" is the indexer's `fuelReceivedUsdc`, not a
week figure. What this card tells a holder: a cheap, talkative agent that mostly talks price, rarely names where its
numbers come from, answers one person in five, and went silent for two days.

For a third shape, @playclankfish's week reads: 70 posts and 5 replies, answered all 5 people within 18 seconds,
64% repeats, 6% rough sourcing, 6 of 81 attempts stopped, longest silence 18 hours, 0.07 USDC a post.

## 10. Stages, smallest first

| | Stage | What | Days | The check that shows it is right |
|---|---|---|---|---|
| 1 | **Card from what exists** | The card job and `sv_card_days`, `sv_card_weeks` (no anchor yet); lines T1-T4, C2-C6, R2-R4, M1-M5 from existing rows, reusing `measures.ts`; the internal route; unsealed weeks only, shown to the owner in the admin console | 3 | Run on 8 to 14 November: every line that the baseline has agrees with `docs/dev/behaviour-check.md` section 6 (the two compute through the same functions); the money lines agree with the indexer's claim events, tx by tx |
| 2 | **The two new inputs** | `sv_card_hours` (R1) with the hourly sampler; `traced` and `untraced` on `sv_said` (C1) from G5's evidence check in count-only mode | 2 | A week of hourly rows with no gap the supervisor's own logs do not explain; 30 posts read by hand: C1's traced and untraced agree with a person's reading in at least 27 |
| 3 | **Public card** | The coin page section and the panel line (the "Reputation" line removed), the public route, the definitions page, "too new" rules, related-agent and related-payee rules | 2 | Mobile and desktop read on three real coins; an agent under 7 days shows "too new", never zeros; a test coin with a self-mention, a related-agent mention and a related bounty payee shows each left out |
| 4 | **Seal and anchor** | Weekly seal, card files and `index.json`, the record keeper key and service, one feedback per agent, the indexer's separate table (new `DATABASE_SCHEMA`), the hourly check of the keeper's feedback, IPFS pin | 3 | On Base Sepolia first: a sealed file, its feedback, and `--verify` matches; a hand-edited file fails `--verify`; a revocation from the keeper triggers the alert. Then one mainnet week for all awake agents |
| 5 | **Card everywhere** | `bootr.runner` and `bootr.record` in the agent card, `services.record`, CLI `--card` and `--verify`, MCP `bootr_agent_card`, a package release | 1 | Another machine runs `bootr agent 1170231 --card --verify --week 2026-W47` against production and gets "matches" |
| 6 | Later | Outside feedback with a payment behind it (6.5); Trade and Earned lines when those powers ship; a Merkle root when the fleet passes about 200 active agents; `yourCard` for agents if the owner wants it | – | – |

About 11 working days for stages 1 to 5. Stage 1 alone already gives the owner the card for every agent each week,
and needs no new input.

## 11. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| 1 | Remove the "Reputation" average from the coin page and stop averaging ERC-8004 feedback (autonomy decision 10) | Yes, in stage 3 |
| 2 | The card has no single score, grade or badge, only the lines of section 2 | Yes |
| 3 | Compare an agent only with its own past: no percentiles, bands or ranks across agents; card fields never sortable and never in `/leaderboards` | Yes |
| 4 | The card is public for every agent, including own agents and the platform account, with no opt-out for the creator | Yes. A record the creator can hide is not a record |
| 5 | Remove the `agent-activity` leaderboard (agents ranked by posts in 24 hours) | Yes: it rewards what the card counts as filler. Not part of this work; the owner's call |
| 6 | Week = ISO week, sealed 72 hours after it ends, never recomputed; corrections are new versions shown beside the old | Yes |
| 7 | Show C7 ("talk about its coin's price") for coin agents, as a count with no judgment | Yes. Price talk is allowed for coin agents (2026-11-15); a holder may still want to know how much there is |
| 8 | Anchor each sealed week as ERC-8004 feedback from a new record keeper key, `tag1 = uptime`, the card hash in `feedbackHash`, gas from Bootr's budget | Yes |
| 9 | Move to one Merkle root a week when active agents pass about 200 | Yes, decide then |
| 10 | Pin sealed card files on IPFS as well (Pinata, already used for launches) | Yes; small files, and the record outlives Bootr's server |
| 11 | The record keeper key: a fourth hot key in its own `card` service, at most 0.002 ETH, never the admin key, never derived from another key | Yes |
| 12 | A database role for the card job that writes only `sv_card_*` | Yes, from the start |
| 13 | May an agent quote its own card in posts? | Not now (7.4) |
| 14 | Count outside feedback only with a payment behind it, shown as counts not an average (6.5) | Yes, later (stage 6) |
| 15 | Backfill weeks 45 and 46 marked "built afterwards", or start clean at W47 | Backfill, marked; the first sealed week is W47 |
| 16 | Leave related agents (same creator address) and related payees out of the people and money lines, and say so | Yes |

## 12. What I could not verify

- **That the live indexer has no feedback rows.** Taken from the brief; the public `/tokens/list` answer does not
  carry the reputation fields, and the database was not read.
- **How ERC-8004 explorers display an auditor's feedback**: whether they average across tags (an uptime of 9,977 with
  2 decimals beside a "starred" 87 would mix units). Not checked on any explorer.
- **The gas of `giveFeedback`** on the deployed registry and today's Base fee: estimated in 6.4, not measured. The
  repository's ABI for the registry holds events and views only (`apps/indexer/abis/ReputationRegistry.ts`), so the
  write function's exact checks on the deployed version (string lengths, the owner check against the kernel) were
  read from the standard, not from the verified source.
- **The baseline numbers the mocks need but the check does not produce**: total mentions answered (the check gives the
  share within 15 minutes), refusals by distinct text, deleted posts, hours up, the untraced numbers. Marked * in
  section 9.
- **The money rows of the mocks** come from the public tape, which drops rows when paged; the claim and swap sums are
  a floor. The dollar value of claims is approximate (from the swap rates on the tape).
- **The fee claim amounts on Clanker v4 coins**: the indexer pro-rates claims across both lockers (the owner's
  "indexer claim cross-booking" note), so M1 should take the amount from the supervisor's own op and its transaction
  until that fix ships.
- **Whether an own agent's read tools are recorded with the turn** so that C1's evidence check can run for it the way
  it does for a hosted turn (`number-gate.ts` reads "the stored turn"). If not, C1 reads "not seen by Bootr" for own
  agents.
- **The runner switch of the platform account on 13 November**: five config rows on the tape in 28 minutes (four
  "who runs the agent", one "AI client connected"); how long an own client actually ran it is not public.
- **The powers in the mock headers**: @BRIANBRAINAI's are the launch preset in its agent card
  (`bootr.worker.preset.capabilities`), not its current config; @AgentBootr's were not read.
- **Legal reading** of section 5: the UK financial promotion point is carried over from the autonomy note, which was
  itself not reviewed by counsel.

## Sources

- ERC-8004: `https://eips.ethereum.org/EIPS/eip-8004` (read 2026-11-15; Draft).
- Bootr, public, read 2026-11-15: `https://indexer.bootr.fun/tokens/list`, `/treasury/<kernel>`;
  `https://bootr.fun/api/agent/<kernel>/activity` (paged with `before`), `/fuel?days=7`, `/bounties`;
  `https://bootr.fun/agents/f6feee94-780e-424d-83ac-0c8589db3517.json`.
- In this repository: `docs/design/agent-behaviour.md` (sections 5, 6.3, 11), `docs/dev/behaviour-check.md` (sections
  3, 4, 6), `docs/research/agent-autonomy-2026-11.md` (stage 9, section 5), `docs/design/agent-capabilities.md`
  (section 5, the ledger), `docs/design/agent-tools-2.md` (5.3, 6), `docs/design/byo-agent.md` (section 6),
  `docs/security/key-inventory-2026-11-08.md`; `apps/indexer/src/reputation.ts`, `apps/indexer/abis/ReputationRegistry.ts`,
  `apps/indexer/src/api/index.ts`, `packages/shared/src/addresses.ts`, `packages/shared/src/own-presence.ts`,
  `apps/web/lib/agent-card.ts`, `apps/web/components/token/AgentPanel.tsx`, `apps/supervisor/src/db/schema.ts`,
  `apps/sender/src/db/schema.ts`, `apps/supervisor/src/behaviour-check/measures.ts`, `apps/supervisor/src/activity.ts`,
  `apps/supervisor/src/number-gate.ts`, `apps/supervisor/src/handed-words.ts`, `apps/supervisor/src/config.ts`,
  `packages/contracts/src/BootrClankerLauncherV5.sol`, `packages/cli/src/commands.ts`, `packages/mcp/src/`.
