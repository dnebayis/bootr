# Rollout: every agent pays BlockRun directly

The owner's decision (2026-11-08): after one local paid check, every agent's thinking, chat and pictures move to
BlockRun at once, paid from each agent's own wallet over x402, with no trial and no relay behind it. Models are
reorganised to the catalog of what BlockRun serves (`packages/agent-core/src/models/catalog.ts`); agents on a model
BlockRun does not serve are moved to the closest one it does and go on from where they were (memory, cadence, powers,
X account and treasury untouched). Agents belong to third parties, so every change is on the agent's activity tape in
plain words and in the creator's inbox.

What is already merged and what this rollout switches on: `apps/supervisor/src/blockrun.ts` (direct mode),
`apps/supervisor/src/model-migration.ts` (the one-shot move), `apps/supervisor/src/model-check.ts` (the catalog held
against BlockRun's live list at start and every 6 hours), the web's model lists and prices from the same catalog.

Order of operations, each step waits for the one before it.

## 1. Local paid check with the deployer wallet (about 5 minutes, about $0.05)

On your own machine, from the checkout that will be deployed (`apps/supervisor/README.md`, "BlockRun live check").
Use a dev wallet that holds nothing else; the deployer wallet is fine for this if its USDC is small.

```sh
pnpm install
read -rs BLOCKRUN_TEST_PRIVATE_KEY && export BLOCKRUN_TEST_PRIVATE_KEY
export BLOCKRUN_TEST_RPC_URL=https://base-rpc.publicnode.com   # any Base RPC that is not the CDP one
pnpm --filter supervisor blockrun:live-check          # the plan: balances, ceilings, what it needs; signs nothing
# fund the wallet with the USDC the plan asks for (no ETH), then
pnpm --filter supervisor blockrun:live-check --yes    # a tool call on Claude Haiku, a thought on GPT-4.1 mini, a picture
unset BLOCKRUN_TEST_PRIVATE_KEY
```

Go on only with exit code 0: a tool call answered on Claude and on another model, a picture made from a reference, no
other model answered (`X-Fallback-Used` absent), every payment went to `0xe9030014F5DAe217d0A152f02A043567b16c1aBf`.
The check reports whether `upto` settled under its ceiling; on 2026-11-06 it settled the whole ceiling, which is still
under what the relay charged. That is a report, not a stop.

## 2. Environment (Coolify → `bootr-stack` → Environment Variables, supervisor service)

| Variable | Value | Why |
| --- | --- | --- |
| `BLOCKRUN_DIRECT_MODE` | `all` | every agent pays BlockRun |
| `BLOCKRUN_RELAY_FALLBACK` | unset or `false` | no call ever goes to the relay; a BlockRun outage means waiting, unpaid |
| `BLOCKRUN_ALLOW_EXACT` | unset (`true`) | every model but Claude and DeepSeek is `exact` only |
| `BLOCKRUN_PROMPT_CACHE` | unset (`true`) | caching on Claude |
| `BLOCKRUN_PAYTO_ADDRESS` | unset | the default is BlockRun's treasury; set it only if BlockRun announces a new one |
| `BLOCKRUN_DIRECT_AGENTS` | unset | only for `agents` mode |
| `OPENROUTER_API_KEY` | leave as it is for now | the relay stays deployed to reconcile old rows and for rollback (step 7) |

The relay (`inference` service) keeps running. Nothing in the web or the indexer changes its environment: the web's
model list and prices come from the catalog in code.

## 3. Deploy

Push `main`, then **Deploy** in the Coolify panel or the API call in `docs/deploy/coolify.md` section 2. Watch the
supervisor log for these two lines within a minute of start:

- `supervisor starting`
- `model check: catalog held against BlockRun` with `gaps: 0` and `agentsOnMissingModels: 0`. A gap line before it
  (`model check: the catalog differs from BlockRun`) names a model that is gone, marked unavailable or re-priced: not a
  stop for the deploy, but read step 5 before the migration. `agentsOnMissingModels > 0` lists agents whose stored model
  BlockRun does not serve; the migration in step 4 moves the ones the catalog knows.

`GET http://supervisor:3004/health` (no auth, from any container on the compose network) carries `modelCatalog: {at,
read, gaps, agentsOnMissingModels}` from the last check.

## 4. The migration: dry run, then for real

Both calls go to the supervisor's HMAC admin API from inside its container, where `SUPERVISOR_SERVICE_KEY` is in the
environment and the port is local. The container image has Node and no curl.

```sh
docker exec -it $(docker ps -qf name=supervisor) sh
# inside the container: one request signed the way src/hmac.ts expects (ts, method, path, sha256(body))
call() { node -e '
const c = require("node:crypto");
const [method, path, body] = process.argv.slice(1);
const ts = Math.floor(Date.now() / 1000);
const sig = c.createHmac("sha256", process.env.SUPERVISOR_SERVICE_KEY).update(`${ts}\n${method}\n${path}\n${c.createHash("sha256").update(body).digest("hex")}`).digest("hex");
fetch(`http://127.0.0.1:3004${path}`, { method, headers: { authorization: `HMAC ${ts}:${sig}`, "content-type": "application/json" }, body: method === "GET" ? undefined : body })
  .then(async (r) => console.log(r.status, JSON.stringify(await r.json(), null, 2)));
' "$@"; }

call POST /internal/admin/model-migration '{"dryRun":true}'
```

Read the plan. For every agent it lists `changes` (`field`, `from`, `to`, `same`: true means the same model under
BlockRun's name, false a different model standing in), `unknown` (ids neither the catalog nor BlockRun's live list
knows; they are left alone and the creator already has a `model_unavailable` notice) and `notes` (an economy mode whose
deciding model and writer became the same model). `checkedAgainstBlockRun: false` means BlockRun's list could not be
read; wait and run the dry run again rather than migrating blind.

The known moves (verified against BlockRun on 2026-11-08):

| Stored id | Becomes | Same model? |
| --- | --- | --- |
| `x-ai/grok-4.20` | `xai/grok-4.3` | no |
| `deepseek/deepseek-v3.2` | `deepseek/deepseek-chat` | no (V4.1 Flash) |
| `meta-llama/llama-4-maverick` | `deepseek/deepseek-chat` | no |
| `google/gemini-3.1-pro-preview` | `google/gemini-3.1-pro` | yes |
| `x-ai/grok-4.7` | `xai/grok-4.7` | yes |
| `moonshotai/kimi-k2.6` | `moonshot/kimi-k3.1-pro` | no |
| `z-ai/glm-4.6` | `zai/glm-5.3` | no |
| `mistralai/mistral-medium-3.1` | `mistral/mistral-large-4` | no |
| `openai/gpt-5-nano` | `openai/gpt-5.4-nano` | no |
| `qwen/qwen3-235b-a22b-2507` | `qwen/qwen3.7-plus` | no |
| `google/gemini-3-pro-image` | `google/nano-banana-pro` | yes |
| `google/gemini-3.1-flash-image` | `google/nano-banana-2` | yes |
| `google/gemini-2.5-flash-image` | `google/nano-banana` | yes |
| `openai/gpt-5.4-image-2` | `openai/gpt-image-2` | yes |
| `openai/gpt-5-image-mini` | `openai/gpt-image-1` | no |

Claude and OpenAI text ids are the same on both sides and do not move. Then:

```sh
call POST /internal/admin/model-migration '{"dryRun":false}'
```

Each moved agent gets `revision + 1` (its next tick starts a turn on the new model), one line on its activity tape
("Model changed to Grok 4.3 by the platform; everything else unchanged."), and one `model_changed` notice in the
creator's inbox and Telegram, sent once and closed by itself after a week. Run the real call a second time: `summary.
changed` must be 0. That is the proof it is done. To move a few agents first: `{"dryRun":false,"agentIds":["12","15"]}`.

## 5. The first hour: what to watch

All SQL on the supervisor's tables in the shared Postgres (`docker exec -it <postgres container> psql -U bootr bootr`).

**Direct thoughts arrive and nothing goes to the relay.** Every paid row since the deploy must carry `route = blockrun`:

```sql
select receipt->>'route' as route, status, count(*)
from sv_inference
where created_at > now() - interval '1 hour'
group by 1, 2 order by 1, 2;
```

Expected: rows with `route = blockrun` and `status = succeeded`; no row with a null route and a payment (`receipt->'payment'
is not null and receipt->>'route' is null` would be a relay payment, which must not happen with the fallback off).

**Paid failures.** `/fuel` per agent (`GET /internal/agents/:id/fuel?days=1`) shows `paidFailures`; fleet-wide:

```sql
select agent_id, error, count(*)
from sv_inference
where created_at > now() - interval '1 hour' and status = 'failed' and receipt->>'route' = 'blockrun'
group by 1, 2 order by 3 desc;
```

`direct_paid_no_response` is money lost (BlockRun settled, no answer came; it has no refund path): one is a note, a
run of them is a stop (step 7). `direct_failed_unpaid` cost nothing (the signature expired unused).

**`direct_unavailable` runs** are the unpaid failures: BlockRun could not serve a call and nothing was signed.

```sql
select agent_id, left(error, 120) as error, count(*), max(created_at)
from sv_inference
where created_at > now() - interval '1 hour' and error like 'direct_unavailable%'
group by 1, 2 order by 3 desc;
```

`direct_unavailable: model_missing: <id>` is one agent's model BlockRun does not know: its creator has a
`model_unavailable` notice and the owner has an error line in the log; the migration (step 4) or the creator fixes it.
Anything else at scale (`unpaid_http_503`, `unreachable`) is a BlockRun outage: the fleet-wide hold
(`/health` → `providerHold`) pauses thoughts for 10 minutes at a time and clears itself on the first answer.

**Spender USDC flows to BlockRun.** On chain, every agent's spender pays `0xe9030014F5DAe217d0A152f02A043567b16c1aBf`.
From the receipts:

```sql
select agent_id,
       count(*) as thoughts,
       sum((receipt->'relay'->>'chargedMicroUsdc')::numeric) / 1e6 as usdc,
       sum(case when receipt->'payment'->'accepted'->>'scheme' = 'upto' then 1 else 0 end) as upto,
       sum(case when receipt->'direct'->>'fallback' = 'true' then 1 else 0 end) as other_model_answered
from sv_inference
where created_at > now() - interval '1 hour' and status = 'succeeded' and receipt->>'route' = 'blockrun'
group by 1 order by 3 desc;
```

`other_model_answered > 0` means BlockRun answered with a fallback model (logged as `BlockRun answered with a fallback
model`); the thought is delivered and counted, but a steady count is worth a mail to hello@blockrun.ai.

**The first picture.** Images go through BlockRun's image API (`exact`, a fixed price per picture: Nano Banana 2 at
0.0955 USDC, Pro at 0.106). The first one proves the path:

```sql
select id, agent_id, model, size_bytes, created_at from sv_images order by created_at desc limit 5;
select idempotency_key, status, error, receipt->'relay'->>'chargedMicroUsdc' as charged
from sv_inference where idempotency_key like 'image:%' order by created_at desc limit 5;
```

`direct_image_in_progress` on an open row is a slow picture: the reconcile polls BlockRun's job and the row closes on
its own; `direct_image_unreadable` means the picture could not be downloaded (the payment is then judged by the chain).

**The creator console** shows "Paid to BlockRun from the agent's own wallet." under the fuel line once an agent has one
direct thought in the window.

## 6. When it is safe to stop funding OpenRouter

The relay is paid by agents only when a call reaches it, and with `BLOCKRUN_RELAY_FALLBACK=false` none does. It still
answers reconcile reads for rows paid before the switch. Stop funding OpenRouter (let the key's credit run out, or
remove `OPENROUTER_API_KEY` and redeploy the `inference` service) once all of these hold:

```sql
-- no open relay-paid row left (an unknown row with a payment and no route is a relay row still being reconciled)
select count(*) from sv_inference
where status in ('pending', 'unknown') and receipt->'payment' is not null and receipt->>'route' is distinct from 'blockrun';
-- no relay payment in the last 7 days
select count(*) from sv_inference
where created_at > now() - interval '7 days' and receipt->'payment' is not null and receipt->>'route' is distinct from 'blockrun';
```

Both zero, and a week of `route = blockrun` rows behind you: OpenRouter credit can go. Keep the relay container running
anyway until the open rows are gone; it costs nothing without traffic. Removing it altogether is a later change (the
supervisor still requires `INFERENCE_PROVIDER_URL` and `INFERENCE_PAYTO_ADDRESS` in its config).

## 7. Rollback

Rollback is a degraded state, not a return to the day before: agents moved to models the relay's price table does not
know (`xai/grok-4.3`, `deepseek/deepseek-chat`, `moonshot/kimi-k3.1-pro`, `zai/glm-5.3`, `mistral/mistral-large-4`,
`qwen/qwen3.7-plus`, `openai/gpt-5.4-nano`, `openai/gpt-image-1`) would fail at the relay with `model_not_allowed` and
back off, unpaid, until they are put on a model both serve (the creator console, or `PUT /internal/agents/:id/config`
with `{"by": <creator>, "model": ...}`). Claude, OpenAI and the renamed Gemini and picture models work on both routes
(the supervisor sends the relay the name it knows).

1. Fund OpenRouter: the key in `OPENROUTER_API_KEY` must have credit (the 2026-11-04 outage was a relay without credit
   taking payments it could not honour).
2. Set `BLOCKRUN_DIRECT_MODE=off` on the supervisor and redeploy it. From the next tick every new call pays the relay.
   Open direct rows keep reconciling by the chain (nothing is paid twice).
3. List the agents the relay cannot serve and change their models:
   ```sql
   select agent_id, config->>'model' as model, config->'routing'->>'decideModel' as decide, config->>'imageModel' as image
   from sv_agents where status = 'active'
     and (config->>'model' like 'xai/%' or config->>'model' like 'deepseek/deepseek-chat' or config->>'model' like 'moonshot/%'
          or config->>'model' like 'zai/%' or config->>'model' like 'mistral/%' or config->>'model' like 'qwen/%'
          or config->>'model' = 'openai/gpt-5.4-nano');
   ```
4. A half-way house: `BLOCKRUN_DIRECT_MODE=all` with `BLOCKRUN_RELAY_FALLBACK=true` sends to the relay only what
   BlockRun refuses before any signature, and holds an agent on the relay for 30 minutes after a direct failure. Use it
   only while OpenRouter is funded.

## 8. Where the pieces are

| Piece | File |
| --- | --- |
| The catalog (ids, names, roles, schemes, prices, caps, retired ids) | `packages/agent-core/src/models/catalog.ts` |
| Direct payment, `model_missing`, pictures over BlockRun's image API | `apps/supervisor/src/blockrun.ts` |
| The migration and its admin route | `apps/supervisor/src/model-migration.ts`, `POST /internal/admin/model-migration` |
| The catalog check at start and on demand | `apps/supervisor/src/model-check.ts`, `POST /internal/admin/model-check`, `GET /health` |
| Creator notices `model_changed`, `model_unavailable` | `apps/supervisor/src/notifications.ts` |
| Launch form and console lists and prices | `apps/web/lib/models.ts`, `apps/web/lib/server/relay-models.ts`, `apps/web/lib/server/admin-config.ts` |
| Terms and privacy copy | `apps/web/components/docs/content.ts` (`/docs/terms`, `/docs/privacy`) |
| The live check | `apps/supervisor/scripts/blockrun-live-check.ts` |
