# Where Bootr stands (2026-11-09)

Written 2026-11-09 08:00 UTC against commit `12feefe` (deployed 2026-11-08 22:33 UTC); `47f1a95` (web docs copy only) is
pushed and not deployed. This page is the owner's map: what runs, the commands they run from their Mac, and the work
left in order. Every runbook it points at stays the source of its own detail; when a command changes, change it in
[`deploy/coolify.md`](./deploy/coolify.md) or [`deploy/blockrun-rollout.md`](./deploy/blockrun-rollout.md) first and
copy it here.

## 1. What is live

**Production.** One Hetzner CX33 (`77.42.90.52`, Helsinki) run by Coolify, application `bootr-stack` (uuid
`ko7sx54pwakworrqogccvbfc`): Postgres 17 and the five services pulled from GHCR images that GitHub Actions builds
([`deploy/coolify.md`](./deploy/coolify.md)). Hosts: `bootr.fun` (web), `api.bootr.fun` (sender), `indexer.bootr.fun`
(indexer); the supervisor and the inference relay stay on the compose network. Every container has a `mem_limit`
(5.5 GB of the 7.6 usable). Hermes answers on Telegram as `@bootrhermesbot` and runs the daily check and the watchdog.

**Chain (Base mainnet, 8453).** Two launch paths behind `BootrLaunchGate` `0x7ddaf2A1FC0861B288c7b0BDfA8314621C47c3a5`:
`BootrLauncher` v3.1 `0x62c038dA8A409ad1CD811df980A6F9867cd453fd` (RWAGMI v3, ~$6k opening cap) and
`BootrClankerLauncherV5` `0xA70D4fCbcD7979609E0e66E7b581bE2711A8FE69` (Clanker v5 with creator token settings,
since 2026-11-11, block 56190112); the v4 `BootrClankerLauncher` `0x387f1B0aC128D534E822c344D829645336BDAbbB` is paused
since 2026-11-12 and its coins keep trading and claiming; `AgentGuardian` `0x799Ab875294E37839883D12084aB4BE3f7633630`, `BootrCallPolicy`
`0x8586BdE0339b85bb9c0f0612954CCdF7fDCF9cE8`, `BootrSwapHelper` `0x5723152f21ed7E305312fd90a2Bb94864BA9D80d`. $BOOTR
launched through the Clanker path on 2026-11-04 (agent 1153600, `@AgentBootr`). The RWAGMI v2 and v3 launchers are
paused and still followed by the indexer. Source of truth: `packages/shared/src/addresses.ts`.

**Indexer.** Schema `bootr_v9` (since 2026-11-11; the next is `bootr_v10`). One snapshot per 60 s of chain
time on both sides of the Denim fork (30 blocks before, 300 after). Block reads go to
`INDEXER_BLOCKS_RPC_URL=https://mainnet.base.org`, `eth_getLogs` to the CDP key under `INDEXER_RPC_BU_PER_SEC` (1300):
about 500 BU/s on the key, half of before. `/sql/*` is gone.

**Agents.** Every agent's thoughts and chat are bought from BlockRun by its own spender wallet over x402
(`BLOCKRUN_DIRECT_MODE=all`, relay fallback off, `upto` on Claude and DeepSeek, `exact` otherwise); the model migration
of 2026-11-08 19:36 UTC moved 2 of 11 agents. Pictures stay on the relay to OpenRouter (`BLOCKRUN_IMAGE_ROUTE` unset =
`relay`), with a 24 h fleet-wide picture hold when OpenRouter refuses the relay's account (`GET /health` →
`pictureHold`); the OpenRouter key stays funded for pictures alone (about $10 a month for ten coin agents). Eight
powers, each a creator switch: X read, X reply, X post, research, memory, treasury, images and, since 2026-11-08, Paid
services (`discover_services`, `x402_fetch`; 0.05 USDC a call and 1 USDC a day by default, hard ceilings 5 and 50; host
allow and deny lists; `sv_service_calls`, migration 0009; every call on the coin page's tape). The rule for it: a paid
call answers a named need (a question, a claim, a number), never finds something to post about. Posts per day 2 to 48
from the console (the sender's quota, 24 per rolling day by default); X reads 400 a day per agent. A 403 from X on a publish holds the agent 6, 12, then 24 h with an `x_forbidden` notice (inbox and
Telegram, Connect X button under it) and a red panel on the coin page; a reconnect lifts it at once; every X hold that
ends gives the model one `x_hold_ended` line; a coin agent's self-chosen wake is floored at its next post slot. The post
length follows the account: 4000 characters with X Premium, 280 without (the sender stores X's `verified_type`,
migration `0002_account_verified_type`, and refuses a longer original before X as `post_too_long_for_account`, no hold).
Lesson of 2026-11-09: X's bare 403 "You are not permitted to perform this action" was a long post on a non-Premium
account, not an account block.

**Web.** The creator console is its own page, `/token/<address>/console` (left rail Mind, Posting, Powers, Look, Inbox,
Fuel; two-column forms; sticky save bar; `?section=` deep links); the coin page carries a "Creator console · n pending"
button under Trade, a four-item "First steps" card for a new agent (X, instructions, fuel, gas) and the red panel for a
lost X connection (`xConnection === 'revoked'`) or a 403 hold (`xHold`). The wallet menu works on phones (Base UI
Menu). The docs pages say 280 characters without Premium.

**Security and ops since 2026-11-08** ([`security/fixes-2026-11-08.md`](./security/fixes-2026-11-08.md)): `ccipRead:
false` on every server-side chain client (the indexer's own waits for the next schema bump), tool timeouts (180 s, 60 s
for reads), streamed body caps, `mem_limit` per container, `/sql/*` removed, RPC URLs scrubbed from every log line, rate
limits on the draft and nonce routes. Private key inventory and removal plan:
[`security/key-inventory-2026-11-08.md`](./security/key-inventory-2026-11-08.md). Design decision of 2026-11-08: the
coming Trade and Payouts contracts are upgradeable (UUPS proxy and feature modules), no timelock, the admin wallet is
the upgrade key ([`design/agent-capabilities.md`](./design/agent-capabilities.md) section 4).

**Environment that matters** (Coolify → `bootr-stack` → Environment Variables): `DATABASE_SCHEMA=bootr_v9`,
`BOOTR_LAUNCHERS` and `BOOTR_CLANKER_LAUNCHERS` (every launcher ever used), `BOOTR_LAUNCHER_ADDRESS`,
`BOOTR_CLANKER_LAUNCHER_ADDRESS`, `BOOTR_CLANKER_V5_LAUNCHER_ADDRESS`, `NEXT_PUBLIC_CLANKER_V5_LAUNCHER_ADDRESS`, `INDEXER_BLOCKS_RPC_URL`, `BLOCKRUN_DIRECT_MODE=all`, `BLOCKRUN_IMAGE_ROUTE` unset,
`OPENROUTER_API_KEY` funded, `PLATFORM_WATCHLIST` (default `bootrfun,base,jessepollak,clanker_world`),
`ENABLE_MODE_SELF_BUNDLE=true`, `PAYMASTER_URL` empty. `IMAGE_TAG` empty means `:main`.

## 2. Operations from the Mac

The server is `root@77.42.90.52`, key `~/.ssh/bootr_hetzner`. Everything below is copied from
[`deploy/coolify.md`](./deploy/coolify.md) section 2 and [`deploy/blockrun-rollout.md`](./deploy/blockrun-rollout.md)
sections 4 to 6.

**Before every push or deploy** (from the checkout going out; the live commit is the one the running images were built
from, `IMAGE_TAG` or the `sha-` tag of the last deployment):

```sh
# 1. No secret in the diff. Read every hit: a 64-hex tx hash in a doc is expected, a key is not.
git diff origin/main..HEAD -U0 | grep -nE '(PRIVATE_KEY|MASTER_KEY|SECRET|TOKEN|API_KEY|JWT)[A-Za-z_]*.{0,3}[=:].{0,3}[A-Za-z0-9+/_-]{16,}|sk-or-v1-[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY' || echo "no secret pattern in the diff"
# 2. Does the indexer need a new DATABASE_SCHEMA? Any line printed means yes: set bootr_v9 in Coolify first.
git diff <live commit>..HEAD --name-only -- apps/indexer/src apps/indexer/ponder.schema.ts apps/indexer/ponder.config.ts | grep -v src/api
# 3. A migration in this release? Take a backup first (coolify.md section 6).
git diff <live commit>..HEAD --name-only -- 'apps/*/drizzle'
```

**Deploy** (after the GitHub Actions images run for the pushed commit is green):

```sh
ssh -i ~/.ssh/bootr_hetzner root@77.42.90.52 'curl -s -X POST -H "Authorization: Bearer $(cat /root/.coolify-token)" \
  -H "Content-Type: application/json" http://127.0.0.1:8000/api/v1/deploy -d "{\"uuid\":\"ko7sx54pwakworrqogccvbfc\",\"force\":false}"'
# then, on the server
curl -sk --resolve bootr.fun:443:127.0.0.1 https://bootr.fun/api/health
curl -sk --resolve indexer.bootr.fun:443:127.0.0.1 https://indexer.bootr.fun/ready     # 503 while a new schema backfills
```

Rollback: `IMAGE_TAG=sha-<full sha>` in Coolify and redeploy; a migration or a schema bump is not undone by it.

**Logs** (one service at a time; container ids from `docker ps`):

```sh
ssh -i ~/.ssh/bootr_hetzner root@77.42.90.52 'docker logs --since 15m $(docker ps -qf name=supervisor | head -1) 2>&1 | grep -iE "error|warn" | tail -50'
ssh -i ~/.ssh/bootr_hetzner root@77.42.90.52 'docker logs --since 15m $(docker ps -qf name=indexer | head -1) 2>&1 | grep -c "Status: 429"'
```

After a supervisor deploy expect `supervisor starting` and `model check: catalog held against BlockRun` with `gaps: 0`
within a minute. `the relay cannot buy pictures from OpenRouter` means the key is out of credit (pictures off for a
day). `GET http://supervisor:3004/health` from any container carries `providerHold`, `pictureHold` and `modelCatalog`.

**The supervisor's admin API** (HMAC; run from inside its container, where the key and the port are local):

```sh
docker exec -it $(docker ps -qf name=supervisor) sh
call() { node -e '
const c = require("node:crypto");
const [method, path, body] = process.argv.slice(1);
const ts = Math.floor(Date.now() / 1000);
const sig = c.createHmac("sha256", process.env.SUPERVISOR_SERVICE_KEY).update(`${ts}\n${method}\n${path}\n${c.createHash("sha256").update(body).digest("hex")}`).digest("hex");
fetch(`http://127.0.0.1:3004${path}`, { method, headers: { authorization: `HMAC ${ts}:${sig}`, "content-type": "application/json" }, body: method === "GET" ? undefined : body })
  .then(async (r) => console.log(r.status, JSON.stringify(await r.json(), null, 2)));
' "$@"; }
call GET /internal/agents ''
call GET /internal/agents/<id> ''
call GET '/internal/agents/<id>/fuel?days=1' ''
call POST /internal/agents/<id>/reconcile '{}'
call POST /internal/admin/model-check '{}'
call POST /internal/admin/model-migration '{"dryRun":true}'
```

**Read-only SQL** (the session refuses writes):

```sh
ssh -i ~/.ssh/bootr_hetzner root@77.42.90.52 'docker exec -i -e PGOPTIONS="-c default_transaction_read_only=on" $(docker ps -qf name=postgres | head -1) psql -U bootr bootr' <<'SQL'
-- thoughts by route in the last hour: blockrun rows succeed, relay rows (route null) are pictures only
select receipt->>'route' as route, status, count(*) from sv_inference
where created_at > now() - interval '1 hour' group by 1, 2 order by 1, 2;
-- a picture the relay's provider refused in the last day starts the 24 h hold
select idempotency_key, agent_id, status, error, updated_at from sv_inference
where idempotency_key like 'image:%' and error like 'relay_pictures_unavailable%' and updated_at > now() - interval '1 day';
-- paid services, last day
select agent_id, host, status, quote_micro_usdc, created_at from sv_service_calls
where created_at > now() - interval '1 day' order by created_at desc;
SQL
```

The rest of the first-hour queries (paid failures, `direct_unavailable` runs, spender USDC to BlockRun) are in
[`deploy/blockrun-rollout.md`](./deploy/blockrun-rollout.md) section 5.

## 3. What comes next, in order

Sizes are the estimates of [`design/agent-capabilities.md`](./design/agent-capabilities.md) section 8, revised on
2026-11-09 after the owner's review: Payouts became **Bounties** (the agent posts a small job, a separate judge role
rules on the deliveries, code pays 0.1 to 1 USDC), Trade was tightened, and the owner's 18 yes/no decisions sit in
section 9 of that file; the owner accepted all eighteen as recommended on 2026-11-09, so the list below is the plan.

1. **Per-agent session rules** (done 2026-11-09, `apps/supervisor/src/session-rules.ts`, powers `claims`, `swap`,
   `treasury`, `trade`, `bounties`).
2. **Three roles** (done 2026-11-09; `packages/agent-core/src/prompt/system-prompt.ts` for the three prompts, with the
   social prompt pinned byte for byte; `apps/supervisor/src/roles.ts` for the switch, the tools per role, the treasury
   clock and the treasury observation; `apps/supervisor/src/judge.ts` for the judge; the role on the persisted `Turn`
   in `apps/supervisor/src/runtime.ts`; tests `test/roles.test.ts`, `test/judge.test.ts`): the social turn as today; a
   **treasury turn** on its own clock with a narrow observation (balances, caps, ops, notes; never mention text) that
   alone holds the money tools; a **judge** role with no tools that sees only a job's numbered criteria and the
   entries' artefacts. Off for every agent until the `trade` or `bounties` power exists, or the owner sets
   `treasuryTurn: true` on an agent's config through the console route to trial it. `trade_quote`, `bounty_post` and
   `bounty_cancel` are named seams for items 3 and 6; the judge has no caller until item 3.
3. **Bounties stage A** (no contract): the platform agent posts jobs, replies are collected by code, the judge rules,
   the verdict lands in the approval queue and the owner pays by hand for two weeks. Decisions 1, 2, 5, 10, 15, 16 of
   section 9. **Server side done 2026-11-10** (branch `bounties-stage-a-2026-11-10`): the `bounties` power and its
   policy block (`packages/agent-core/src/types.ts`, `packages/shared/src/workers.ts`), the tools `bounty_post`,
   `bounty_cancel`, `bounty_list` (`packages/agent-core/src/tools.ts`), a BOUNTIES block in the treasury prompt
   (`prompt/system-prompt.ts`; the social prompt is unchanged), `apps/supervisor/src/bounties.ts` (the template, the
   caps, the task rules, the review and slot waits, the entry rules, the artefact fetches, the judge call, the
   proposal, the expiry, the public views, the tape rows), migration `0010_bounties` (`sv_bounty_jobs`,
   `sv_bounty_entries`; take the backup step before deploying it), the sender's `POST /internal/read/replies`
   (`apps/sender/src/replies.ts`), the HMAC reads `GET /internal/agents/:id/bounties[/:jobId]` and the
   `bounty_payout` approval that takes the creator's `txHash`. Tests `apps/supervisor/test/bounties.test.ts`,
   `apps/sender/test/replies.test.ts`. **Web side done 2026-11-10**: the Bounties switch and the caps form in the
   console's Powers section, the `bounty_job` and `bounty_payout` items in the Inbox (the payout one takes the paying
   transaction hash; the console sends nothing), the Bounties card on the coin page at `#bounty-<shortId>`
   (`apps/web/components/token/BountiesCard.tsx`), the public reads `GET /api/agent/<kernel>/bounties[/<jobId>]`
   (`apps/web/lib/server/supervisor.ts` sanitises every field), mock fixtures, the docs block and `e2e/bounties.spec.ts`.
   **Left for the two-week trial**: switch the power on for the platform agent (console, Powers), watch the first job
   end to end (the X read of replies with the agent's token and the `pbs.twimg.com` media fetch are not yet seen live),
   then decide stage B (item 5). **Creator requests, pictures and bounty initiative, built 2026-11-11** (not deployed;
   no migration; `apps/supervisor/src/creator-requests.ts`, README "Creator requests"): in 31 hours the platform agent
   made no picture and its treasury turn ran 6 times, each straight to `finish`, and the owner's chat asks went
   nowhere. Now an ask in the chat (post about X, a picture, a bounty, stop doing Y) is filed with `request` as a
   creator request, shown in the next turn of that kind under `creatorRequests` with the owner's authority and every
   gate still on, and closed by the action that did it or an answer with the reason (48 h expiry); a treasury request
   pulls the treasury turn forward. The picture section reaches the decide model, `suggested` is an instruction,
   `draft_intent` can plan a picture, and only strangers' picture asks are refused. With Bounties on, the bounties
   section suggests a job after 2 days without one, and the treasury turn's own wake is capped at two intervals. Watch
   after deploy: pictures per day against the cap, jobs posted, and requests closed versus expired.
4. **`BootrCallPolicy` v2** (contracts, two days): 14 rules; Bounties alone needs 9, with Trade 11.
5. **`BootrBounties` + the Bounties power** (contracts and all tiers, about a week): UUPS proxy, immutable ceilings
   (0.1 to 1 USDC a job, 20 USDC a day, 5 open jobs), per-job approve + pay in one batch, per-payee cooldown, creator
   `setPolicy`/`cancel`/`paused`. Decisions 3, 4, 6, 7, 8, 17, 18.
6. **`BootrTradeHelper` + the Trade power** (contracts, about a week with fork tests and a review): WETH, USDC and the
   own coin only; 0.01 ETH a trade and 0.03 a day by default, 0.1 / 0.5 as immutables; one trade an hour; trading
   starts 24 h after the creator's first `setCaps`; own-coin buys off; memo required; ledger only, no X posts.
   Decisions 11 to 14, 18.
7. **Ledger page** (web, two days; can run beside 5 or 6).
8. **Kind presets v2** (one day): Community, Researcher, Trader, Patron (Bounties), Custom; Researcher v2 and the Paid
   services box on Custom can ship earlier.
9. **Clanker v5 migration + the indexer claim cross-booking fix** (live 2026-11-11/12;
   [`design/clanker-v5-migration.md`](./design/clanker-v5-migration.md),
   [`design/clanker-v5-token-settings.md`](./design/clanker-v5-token-settings.md)). `BootrClankerLauncherV5`
   `0xA70D4fCbcD7979609E0e66E7b581bE2711A8FE69` deployed at block 56190112, owner accepted, on the gate, Sourcify exact
   match, security-reviewed (token settings note 8.1). Released at `7d82ff3` with `DATABASE_SCHEMA=bootr_v9` (backup
   first; backfill done 2026-11-11 22:16 UTC), the launcher appended to `BOOTR_CLANKER_LAUNCHERS`,
   `BOOTR_CLANKER_V5_LAUNCHER_ADDRESS` and `NEXT_PUBLIC_CLANKER_V5_LAUNCHER_ADDRESS`. The v4 `BootrClankerLauncher` was
   paused 2026-11-12 (block 56350801); `pause()` gates `launch()` only, so v4 coins keep trading and their fees stay
   claimable. Remains: a Bootr-owned v5 test coin and a fork run of a buy and a sell through the web's calldata on it.
10. **Clanker on Robinhood Chain** (research only, nothing built; design note section 11): Clanker v5 is live there
   (chain 4663, an Arbitrum Nitro rollup), but Bootr's stack is Base-only today (address book, contracts, indexer,
   supervisor, web), there is no Circle USDC (USDG instead), no Coinbase CDP and no x402 inference seller, so the
   launchpad can close there but the agent economy needs a bridge step. The staged plan and sizes are in section 11.
11. **Bring your own agent** (designed 2026-11-12, nothing built;
   [`design/byo-agent.md`](./design/byo-agent.md)): a coin's creator runs the coin's agent in their own AI client
   (Claude Code, Cursor, Codex, Claude Desktop) through the Bootr MCP server. Only the thinking moves to the client:
   the supervisor still builds the observation, runs the broker and every guard, keeps the state and the memory,
   posts through the sender and signs with the session key; the creator's wallet approves the client in the browser
   (a device-style approval, no key copied). Thinking costs no fuel, pictures are made by the client and uploaded,
   paid x402 services are the only use of fuel, X reads stay Bootr's cost, and no fuel minimum exists anywhere (both
   live launchers read `minFuelUsdc = 0`; the form only prefills 20). The launch page opens with "Bootr agent" or "My
   own agent", and the console switches a coin between the two in both directions with no contract change and no
   session key rotation. No indexer change, so no schema bump; supervisor migration `0011_own_agent` and sender
   migration `0003_quota_reads_per_day`. One release behind `OWN_AGENT_ENABLED`, a flag that hides the surfaces and
   never changes how a coin is run (an own coin with the flag off is silent, never handed to the hosted model), built
   by four workstreams in parallel against section 13 of the note (W1a supervisor and sender, 5 days; W1b web routes,
   approval page and the SDK, MCP and CLI packages, 4 days; W2 treasury, bounties, requests and services, 5 days; W3
   launch page, console and switching, 6 days; integration 2 days). Eleven decisions wait for the owner in section 9
   of the note, each with a recommendation the builders follow until told otherwise; section 10 says where full parity cannot be had (a role's clean context on someone else's machine,
   prompt-only rules, presence, pictures that depend on the client).

**Parked** (the owner brings them back; nothing is built meanwhile):

- Indexer reads every Uniswap v4 swap on Base (noted 2026-11-11): the `PoolManager` source has no filter, because Ponder
  cannot filter by pool ids unknown before each launch, so a full re-read (the `bootr_v9` backfill took ~40 min) walks
  all of Base's v4 swaps. Fix: listen to the RWAGMI, Clanker v4 and Clanker v5 hooks instead, after checking that price
  and volume come out the same as from `Swap`; ships as `bootr_v10` with the next indexer change.

- Roadmap page: where it lives and how open it is (the direction of 2026-11-08 says agents trade, run their treasury
  and use x402 services, and later a bring-your-own agent).
- Key removal plan, steps 2 to 6 of `security/key-inventory-2026-11-08.md` section 3.4. Step 1 checked 2026-11-09:
  Coolify holds no deployer, treasury or Basescan variable; only the admin key and the two hot keys remain. Step 3
  (the admin key off the server) must land before the Bounties and Trade contracts.
- Tweet-to-launch agent (`research/x-launch-references-2026-11.md`): free-text bot with a confirm step, one Privy
  wallet per X id, Bootr pays gas; open: the fee share, a Privy account, X's written approval for AI replies.
- Plain token deploys from a tweet, the way bankr.bot and clanker.world do it (noted 2026-11-10 as a later step, after
  Clanker v5 and the Robinhood Chain launcher): possibly through Bootr's own launcher rather than the Clanker path;
  not decided, nothing designed. Start from the research note above when it comes up.
- npm publish of `@bootrfun/sdk`, `cli`, `mcp`: the account was suspended on 2026-11-06 and every publish answered
  404; the live docs still say `npx @bootr/mcp`. Check the suspension, regenerate the recovery codes, publish sdk,
  cli, mcp in that order.
- X quota hold redesign: a launch-day agent fills its 24 posts and goes silent, mention reads included, until the
  window rolls. Options: a launch-day quota, or reading mentions during the hold and queueing replies.
- Chainstack ($49 a month) for the indexer's `eth_getLogs` if 429s persist on the CDP key.
- Public-endpoint 429 noise: retry inside the indexer's blocks transport or rest longer, so each 429 stops showing as
  a Ponder error line.
- The relay storing the upstream error body (`upstream` is null today), and a key-limit 403 from OpenRouter as a
  global inference hold like the X credits hold.
- An onboarding step suggesting X's "Automated" account label for the agent's account.
- Agent images: no live picture has been verified end to end yet (the first one, the digest of 2026-11-08, failed on
  a 256-token `max_tokens`, since fixed); watch the next one reach X.
- X launch references: copy Bankr and Clanker, bring fee and custody decisions to the owner before building.
