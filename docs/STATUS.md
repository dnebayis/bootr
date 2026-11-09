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
`BootrClankerLauncher` `0x387f1B0aC128D534E822c344D829645336BDAbbB` (Clanker v4), both deployed 2026-11-04 at block
53503025; `AgentGuardian` `0x799Ab875294E37839883D12084aB4BE3f7633630`, `BootrCallPolicy`
`0x8586BdE0339b85bb9c0f0612954CCdF7fDCF9cE8`, `BootrSwapHelper` `0x5723152f21ed7E305312fd90a2Bb94864BA9D80d`. $BOOTR
launched through the Clanker path on 2026-11-04 (agent 1153600, `@AgentBootr`). The RWAGMI v2 and v3 launchers are
paused and still followed by the indexer. Source of truth: `packages/shared/src/addresses.ts`.

**Indexer.** Schema `bootr_v8` (a fixed name, since 2026-11-08; the next is `bootr_v9`). One snapshot per 60 s of chain
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

**Environment that matters** (Coolify → `bootr-stack` → Environment Variables): `DATABASE_SCHEMA=bootr_v8`,
`BOOTR_LAUNCHERS` and `BOOTR_CLANKER_LAUNCHERS` (every launcher ever used), `BOOTR_LAUNCHER_ADDRESS` and
`BOOTR_CLANKER_LAUNCHER_ADDRESS`, `INDEXER_BLOCKS_RPC_URL`, `BLOCKRUN_DIRECT_MODE=all`, `BLOCKRUN_IMAGE_ROUTE` unset,
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
section 9 of that file. Nothing below starts until those are answered.

1. **Per-agent session rules** (done 2026-11-09, `apps/supervisor/src/session-rules.ts`; the `payouts` power name
   there becomes `bounties` with the next change).
2. **Three roles** (supervisor and agent-core, about three days): the social turn as today; a **treasury turn** on its
   own clock with a narrow observation (balances, caps, quotes, notes; never mention text) that alone may trade or
   post a job; a **judge** role with no tools that sees only a job's numbered criteria and the deliveries' artefacts.
3. **Bounties stage A** (supervisor, web; about a week; no contract): the platform agent posts jobs, replies are
   collected by code, the judge rules, the verdict lands in the approval queue and the owner pays by hand for two
   weeks. Decisions 1, 2, 5, 10, 15, 16 of section 9.
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
9. **Clanker v5 migration + the indexer claim cross-booking fix** (last; design note first, then contracts, indexer,
   web; `bootr_v9`). Decisions: the tax rate (about 1.5% matches today's slot income); whether a burn-preset coin waits.

**Parked** (the owner brings them back; nothing is built meanwhile):

- Roadmap page: where it lives and how open it is (the direction of 2026-11-08 says agents trade, run their treasury
  and use x402 services, and later a bring-your-own agent).
- Key removal plan, steps 1 to 6 of `security/key-inventory-2026-11-08.md` section 3.4. Step 1 is the owner's:
  delete the deployer, treasury and Basescan variables in Coolify and scrub the local env files; nothing on the
  server needs them.
- Tweet-to-launch agent (`research/x-launch-references-2026-11.md`): free-text bot with a confirm step, one Privy
  wallet per X id, Bootr pays gas; open: the fee share, a Privy account, X's written approval for AI replies.
- npm publish of `@bootrfun/sdk`, `cli`, `mcp`: the account was suspended on 2026-11-06 and every publish answered
  404; the live docs still say `npx @bootr/mcp`. Check the suspension, regenerate the recovery codes, publish sdk,
  cli, mcp in that order.
- X quota hold redesign: a launch-day agent fills its 24 posts and goes silent, mention reads included, until the
  window rolls. Options: a launch-day quota, or reading mentions during the hold and queueing replies.
- Bring-your-own local agent (Claude, Codex) against Bootr, for creators who will not buy credits.
- Chainstack ($49 a month) for the indexer's `eth_getLogs` if 429s persist on the CDP key.
- Public-endpoint 429 noise: retry inside the indexer's blocks transport or rest longer, so each 429 stops showing as
  a Ponder error line.
- The relay storing the upstream error body (`upstream` is null today), and a key-limit 403 from OpenRouter as a
  global inference hold like the X credits hold.
- An onboarding step suggesting X's "Automated" account label for the agent's account.
- Agent images: no live picture has been verified end to end yet (the first one, the digest of 2026-11-08, failed on
  a 256-token `max_tokens`, since fixed); watch the next one reach X.
- X launch references: copy Bankr and Clanker, bring fee and custody decisions to the owner before building.
