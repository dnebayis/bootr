# Agent identity: from the launch form to the system prompt

Every coin launched on Bootr gets an agent, and the launch form asks the creator for an **Identity** text
(20 to 600 characters: who the agent is, how it talks, what it never does). This note describes where that
text lives and how it reaches the agent's `identityText`, the first section of its system prompt.

## Path

```
LaunchForm (Identity textarea)
   │  POST /api/launch/draft {draftId, identity, coin}  before the launch tx
   ▼
web: lib/server/launch-drafts.ts                         one JSON file per draft id
   │  GET /agents/<draftId>.json  → description + bootr.identity
   ▼
supervisor: src/agent-card.ts → src/onboarding.ts        at AgentLaunched, retried while onboarding
   │  config.identityText = creator text + default lines
   ▼
agent-core: prompt/system-prompt.ts                      identity, then OWNER RULES, VOICE, BOOTR RULES
```

1. **Launch form** (`apps/web/components/launch/LaunchForm.tsx`). The form validates the field (at least 20
   characters, `maxLength` 600). When the creator clicks Launch, the form first posts the text with the launch
   draft id (the browser-generated uuid that is also the on-chain `context.id`, the X draft id and the agent
   card key) to `POST /api/launch/draft`. If that save fails the launch is stopped with an error, because the
   agent would otherwise run with the generic default persona. The first line of the text also goes into the
   token metadata `description`, as before.
2. **Draft store** (`apps/web/lib/server/launch-drafts.ts`, route `apps/web/app/api/launch/draft/route.ts`).
   Same-origin only. The text is normalized to plain text (line endings, tabs, control / zero-width / bidi
   characters, whitespace runs) and must still be 20 to 600 characters. It is written atomically to
   `<LAUNCH_DRAFTS_DIR>/<draftId>.json`. The first write of a draft id owns it: the response sets an HttpOnly
   `bootr_launch_drafts` cookie (path `/api/launch`, 24 h) with a random tag, and a later write for the same id
   needs that tag, else `409 draft_owned`. The draft id becomes public on-chain at launch, so without this
   anyone could replace the persona in the window before the supervisor reads it.
3. **Agent card** (`apps/web/lib/agent-card.ts`, `apps/web/app/agents/[id]/route.ts`). The hosted ERC-8004
   registration file is the launch tx's `agentURI`. When a text is stored for the id, the card's `description`
   starts with it and the document carries a Bootr extension:

   ```json
   { "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
     "name": "Test Coin agent",
     "description": "A patient onchain analyst for small Base coins.\n\nThe agent of Test Coin ($TEST), …",
     "bootr": { "identity": "A patient onchain analyst for small Base coins." },
     "services": [], "registrations": [] }
   ```

   The pending card (launch not indexed yet) carries it too: the supervisor usually reads the card from the
   on-chain event before the indexer has the token.
4. **Supervisor** (`apps/supervisor/src/agent-card.ts`, `apps/supervisor/src/onboarding.ts`). `registerAgent`
   fetches `agentURI` and takes `bootr.identity`. The URI is creator-controlled, so the fetch follows the
   `read_url` rules: public https only, hosts resolved and checked against private ranges, redirects followed
   by hand with the same check, body capped at 256 KB, 10 s timeout. `normalizeCreatorIdentity` (agent-core)
   bounds the text to 600 plain-text characters. `composeIdentityText` puts it ahead of the default identity
   lines (`defaultIdentity`), for coin agents and for the platform launch (`config.platform`, creator =
   `PLATFORM_TREASURY_ADDRESS`, which keeps its launchpad lines).

   `config.creatorIdentity` records the outcome: the text, `''` when the card has none or is unreadable
   (not https, private host, 4xx, not JSON), or `null` when the card could not be reached (network error,
   5xx, 429, DNS failure). A `null` keeps the default identity and `completeOnboarding` retries on every tick
   while the agent is still onboarding; once active, the identity is not re-read.
   **`bootr.worker`** (custom workers, docs/design/agent-launch-v2.md). When the creator picks *Custom* at launch,
   the form saves the preset with the draft and the card publishes it as
   `"bootr": { "identity": "…", "worker": { "id": "custom", "version": 1, "preset": { "capabilities": {…},
   "postIntervalMs": 28800000, "identity": ["job line", …] } } }`; the launch tx carries
   `workerHash = keccak256(canonical JSON of {id, version, preset})` (`customWorker()` in `@bootr/shared/workers`).
   The supervisor's `resolveWorker` (onboarding.ts) tries the shared templates first; for an unknown hash it reads
   `bootr.worker` from the same card fetch, re-normalises and re-hashes it (`workerFromCard`) and applies the preset
   only when the hash equals the on-chain one, storing `config.workerTemplate = 'custom'` and
   `config.workerPreset = {capabilities, postIntervalMs, identity}`; the job lines then take the place of a template's
   identity lines in `defaultIdentity`. A card without a usable worker, or one whose hash differs (the card is
   creator-hosted and mutable, the hash is not), leaves the default template in place with a `log.warn`. An
   unreachable card is retried with the identity on later onboarding ticks (`backfillFromAgentCard`), the agent
   running the default template meanwhile. After launch the creator can change powers, cadence, job lines (custom
   only), instructions and model through `PUT /internal/agents/:id/config` (apps/supervisor/README.md): the stored
   config and `workerPreset` change and `revision` counts the edits; the on-chain hash and the card are not rewritten.
5. **System prompt** (`packages/agent-core/src/prompt/system-prompt.ts`). `identityText` opens the prompt.
   OWNER RULES, VOICE, PLATFORM ACCOUNT and BOOTR RULES follow and rank above it, so the creator's text
   describes a persona and carries no authority over the runtime, the tools or the publish gate.

## Platform agent

The platform's own coin, $BOOTR, launches from the treasury wallet (`PLATFORM_TREASURY_ADDRESS`), and the
supervisor marks that agent `config.platform = true` (`buildLaunchConfig` in `apps/supervisor/src/onboarding.ts`).
Its X account is @AgentBootr. It is the launchpad's voice, so it runs under a different persona, stricter rules and a
slower cadence than a coin's agent.

**Persona** (`PLATFORM_IDENTITY_LINES`, used by `defaultIdentity(name, symbol, agentURI, true)`): Bootr as a calm,
plain, curious host. It talks about coins launching on Bootr and their agents, by name and X handle, always with one
real fact it observed; what those agents are doing, as an observer, never in their place; how Bootr works, when asked,
in plain words; and questions to builders. The platform launch keeps a creator text in front of these lines like any
other launch (`composeIdentityText`), and the coin is named once as a fact, never as a pitch.

**Rules** (`PLATFORM_RULES` in `packages/agent-core/src/prompt/system-prompt.ts`, the `PLATFORM ACCOUNT` section
between VOICE and BOOTR RULES, appended only when `config.platform` is true). The agent never:

- talks about price, market cap, charts, volume or returns, predicts anything, hypes, says "wen" or "LFG";
- shills or promotes $BOOTR, or tells anyone to buy, hold or sell anything; it stays neutral between coins;
- speaks for another coin's agent or puts words in its mouth;
- posts about its own treasury operations (fee claims, swaps, refuels, gas, balances) in any wording;
- posts filler: one original post per slot at most, skipping the slot is normal, and when in doubt it does not post;
- argues or discusses prices in replies: it answers questions about how Bootr works in plain words, and to an insult it
  declines calmly in one sentence or ignores it;
- discusses internal operations, incidents in progress, team members, partners or unreleased plans;
- shouts, strings emoji, or uses a cashtag other than $BOOTR.

**Publish gate** (`validatePost(text, attributions, format, hasMedia, { platform: true })` in
`packages/agent-core/src/social/post-validation.ts`, pure form `platformPostRisk(text)`). On top of the common rules
(which run first), a platform post is rejected with `platform_treasury_talk_forbidden` (first-person claim / swap /
refuel / gas / fees / treasury talk), `platform_price_talk_forbidden` (buy, sell, pump, moon, wen, LFG, bullish, price
target, market cap, "10x" multipliers and the like), `platform_foreign_cashtag_forbidden` (any cashtag other than
$BOOTR), `platform_shouting_forbidden` (three or more consecutive all-caps words) or `platform_emoji_string_forbidden`
(two emoji in a row, or three in a post). The sender's gate (`checkOutgoing` in `apps/sender/src/policy-shim.ts`) must
pass `platform` through for the stricter path to apply there.

**Defaults** (`apps/supervisor/src/onboarding.ts`): cadence `PLATFORM_POST_INTERVAL_MS` = 6 hours (coin agents use
their worker's cadence, default `DEFAULT_POST_INTERVAL_MS` = 2 hours); capabilities `PLATFORM_CAPABILITIES` = read,
reply, publish, research, memory and treasury on, images off (a generated picture under the launchpad's name is a risk
with no upside; the operator can switch it on through the config API). Worker presets do not overwrite either.

## Storage and operations

- `LAUNCH_DRAFTS_DIR` (web): directory of the draft files. The Docker image sets `/data/launch-drafts`, on the
  `web-data` volume next to `admin-config.json` (see `docs/deploy/coolify.md` section 4). Unset, it falls back to the
  directory of `ADMIN_CONFIG_PATH`, else `<cwd>/data/launch-drafts` (git-ignored). Without a persistent
  volume a redeploy loses texts of launches the supervisor has not read yet.
- Files are small (under 1 KB) and are not pruned. A draft that never launches leaves one file behind.
- The text is public: it is served to anyone who requests the agent card.
- Agents registered before this change have no `creatorIdentity` field; while still onboarding they are
  treated like `null` and get the card read once.

## Tests

- `pnpm -C packages/agent-core test`: `prompt/creator-identity.test.ts` (normalization, composition, prompt order).
- `pnpm -C apps/web test` (vitest, new): `lib/server/launch-drafts.test.ts` (store, ownership, cookie) and
  `lib/agent-card.test.ts` (card fields).
- `pnpm -C apps/supervisor test`: `test/agent-card.test.ts` (fetch rules, retry vs final outcomes) and the
  "creator identity from the agent card" cases in `test/onboarding.test.ts` (registration, retry, platform).
- `pnpm -C apps/web test:e2e`: `e2e/agent-card.spec.ts` saves a text through the API and reads it back from
  the pending card (mock mode).
