# Bootr web (`apps/web`)

Next.js 16 App Router (Cache Components + Partial Prefetching), React 19, Tailwind v4, wagmi v3 / viem, TanStack Query.
Brand and tokens: [`DESIGN.md`](./DESIGN.md) (`## Bootr` section) and [`app/globals.css`](./app/globals.css).

```sh
pnpm --filter web dev          # http://localhost:3000
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web build
pnpm --filter web test:e2e     # Playwright smoke tests (builds + starts on :3210, mock mode)
# Trade panel calldata on a Base fork (real buys and sells on $BOOTR and OWL): base-anvil --fork-url <Base RPC> --port 8646, then
SWAP_FORK_RPC=http://127.0.0.1:8646 pnpm --filter web exec vitest run lib/swap/swap.fork.test.ts --testTimeout=120000
```

Container (build from the repo root; `NEXT_PUBLIC_*` are build args, everything else is runtime env; production setup in
[`docs/deploy/coolify.md`](../../docs/deploy/coolify.md)). The Dockerfile builds with `NEXT_OUTPUT=standalone` (see `next.config.ts`) and serves `apps/web/server.js`;
`GET /api/health` is the liveness probe.

```sh
docker build -f apps/web/Dockerfile -t bootr-web \
  --build-arg NEXT_PUBLIC_CHAIN_ID=84532 --build-arg NEXT_PUBLIC_INDEXER_URL=https://indexer.bootr.fun \
  --build-arg NEXT_PUBLIC_SENDER_PUBLIC_URL=https://api.bootr.fun .
docker run --rm --env-file .env -e PORT=3000 -v bootr-web-data:/data -p 3000:3000 bootr-web
```

First e2e run needs a browser: `pnpm --filter web exec playwright install chromium`.

## Mock mode

Set `NEXT_PUBLIC_USE_MOCK=1` (mock mode is also implied when `NEXT_PUBLIC_INDEXER_URL` is empty). Every page then renders from
`lib/mock.ts`: ~84 seeded tokens and agents, 90 days of `dailyStats`, `platformStats` with a BOOT token, trades, posts,
holdings and fuel history. A simulator moves market caps every 5 s and launches a coin every ~20 s, emitting the same
stream hints as `/stream`, so the live grid (reordering, new-launch flash, ticking numbers) can be seen without an indexer.
Writes (launch, fuel, pause, console actions) show a toast instead of sending a transaction; a mock launch inserts the coin
and redirects to its page.

## Environment

Public (inlined at build time):

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `84532` (Base Sepolia, default) or `8453` (Base). Picks explorer, DexScreener, contract addresses. |
| `NEXT_PUBLIC_INDEXER_URL` | Ponder indexer origin (`/graphql`, `/search`, `/token/:id/fees`, `/stream`). |
| `NEXT_PUBLIC_USE_MOCK` | `1` to use fixtures. |
| `NEXT_PUBLIC_WC_PROJECT_ID` | WalletConnect project id (connector hidden when empty). |
| `NEXT_PUBLIC_RPC_URL` | Optional RPC for the primary chain (public RPC otherwise). |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for metadata/sitemap (default `https://bootr.fun`). Also the only origin accepted for SIWE sign-in (domain/URI) and for same-origin checks on admin and X-connect POSTs; `X-Forwarded-Host`/`Host` are never trusted. Under `next dev`, localhost origins are accepted too. Must be the exact origin users load (redirect `www.` to it), or admin sign-in and X connect are refused. |
| `NEXT_PUBLIC_INFERENCE_URL` | Inference relay origin. Only read server-side by `/api/models` when `INFERENCE_URL` is unset; the browser never calls the relay. |
| `NEXT_PUBLIC_SENDER_PUBLIC_URL` | Browser-facing X sender origin: `/api/x/start` redirects the OAuth popup to its signed `/oauth/start`. |
| `NEXT_PUBLIC_SWAP_LINK_BASE` | Prefix of the trade panel's "Swap on another site" link, token address appended (LlamaSwap on Base otherwise, Uniswap on Sepolia). |
| `NEXT_PUBLIC_LAUNCHER_ADDRESS` | `BootrLauncher`. |
| `NEXT_PUBLIC_CLANKER_LAUNCHER_ADDRESS` | `BootrClankerLauncher`, the "Launch through Clanker" path (optional; the choice is hidden while unset). |
| `NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS` | `AgentGuardian`. |
| `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY` | Address passed as `supervisorSessionKey` in `launch()` (informational). |
| `NEXT_PUBLIC_BOOT_X_URL` | Platform X profile link (hidden when empty). |
| `NEXT_PUBLIC_WORKER_SOURCE_BASE` | Prefix for worker-hash source links (hash shown without link when empty). |
| `NEXT_PUBLIC_IPFS_GATEWAY` | IPFS gateway origin for pinned token images, `<gateway>/ipfs/<cid>` (default `https://gateway.pinata.cloud`, which is rate limited: use a dedicated `https://<name>.mypinata.cloud` gateway in production). Also used to render `ipfs://` images. Changing it later does not change images already written on-chain. |

Server only: `ADMIN_CONSOLE_SLUG`, `ADMIN_ADDRESSES`, `SESSION_SECRET` (≥ 16 chars, 32+ recommended),
`SENDER_SERVICE_KEY` (≥ 32 chars; signs the sender's `/oauth/start`, the `/api/x/*` internal calls and the
X-connect draft cookies), `INDEXER_SERVICE_KEY` (≥ 32 chars; verifies the indexer's signed `GET /api/admin/config`.
While it is unset, `SENDER_SERVICE_KEY` signatures are still accepted there and a startup warning is logged: set it
here and in the indexer, then the fallback is gone), `SENDER_URL` (optional server-to-server sender origin for
`/api/x/status` and `/api/agents/:id/posts`; defaults to `NEXT_PUBLIC_SENDER_PUBLIC_URL`), `INFERENCE_URL` (optional
server-to-server relay origin for `/api/models`; defaults to `NEXT_PUBLIC_INFERENCE_URL`), `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` (SIWE signature
checks), `PINATA_JWT` (Pinata API JWT with scope `org:files:write`, used by `POST /api/upload`; unset = uploads answer 503),
`PINATA_MOCK` (`1` = never call Pinata, return a deterministic local CID; also implied in mock mode while `PINATA_JWT` is unset). Keys shorter than 32 characters are treated as unset. `instrumentation.ts` logs a `[web] config error` /
`config warning` line at startup for a missing or short key (values are never logged). `SUPERVISOR_URL`
(`http://supervisor:3004` on the compose network) and `SUPERVISOR_SERVICE_KEY` (≥ 32 chars) back the coin page's agent
config, activity, inbox, chat and fuel routes (`/api/agent/[kernel]/*`), which proxy the supervisor's HMAC admin API;
without them those routes are disabled. `BLOCKRUN_IMAGE_ROUTE` (unset = `relay`, the supervisor's setting) decides where
the console's image list and picture prices come from: the relay's `/v1/models` while pictures go through the relay,
the model catalog with `direct`.

RWAGMI v3 / USDC / WETH addresses come from `@bootr/shared/addresses` (RWAGMI v3 is mainnet only; on Base Sepolia the
fee panels show the indexer's split and no claimables). The locked split is read from
`RwagmiLpLockerV3.launchInfo(token).rewards`: Bootr's slots total 9000 bps of the 1% WETH swap fee and RWAGMI's 1000-bps
slot follows them. Claimable fees are WETH only: `claimableQuote(recipient, WETH)` (settled, one balance per recipient)
plus `pendingQuote(poolId, recipient)` per coin (unsettled). `settleAndClaim(poolIds, WETH, to)` / `claimQuote(WETH, to)`
pay `msg.sender`'s balance, so only the recipient's own wallet can claim. Claims carry the ERC-8021 `dataSuffix`.

Wallets: Base Account ("Sign in with Base", passkey smart wallet; `lib/connectors/base-account.ts` loads
`@base-org/account/browser` so the SSR bundle never pulls the SDK's Node entry), Coinbase Wallet (EOA only), the
injected browser wallet, WalletConnect. The Builder Code suffix is passed to both SDKs as `preference.attribution` so a
smart wallet also suffixes its outer `executeBatch` calldata.

Server API used by the app itself: `GET /api/models` (the minds and their per-thought prices from the model catalog in
`@bootr/agent-core` (`lib/models.ts`, priced the way the agent pays BlockRun), filtered by the console `allowedModels`;
the image models and picture prices from the relay's `/v1/models`, read server-side and cached 60 s, while
`BLOCKRUN_IMAGE_ROUTE` is `relay`) and `GET /api/agents/:id/posts?limit=3` (proxy to the sender's public
`/public/posts/:agentId`, cached 60 s; 404 = the sender never saw the agent).

## Routes

| Route | |
|---|---|
| `/` | $BOOTR box, tabs `?tab=newest|graduated|mcap|active`, live grid (virtualized past 60 cards), ⌘K search. |
| `/token/[address]` | Header, DexScreener embed (mainnet), agent panel (agent wallet, balances, gas status chip and out-of-gas notice, latest posts), locked fee split, Trade panel (buy and sell on the coin's Uniswap v4 pool from the user's own wallet, `lib/swap`), last 20 trades. The creator additionally sees a "Creator console · n pending" button under the Trade button (`CreatorConsoleLink`), a "First steps" card for a new agent (X account, instructions, fuel, gas; each step opens the console at its section, `FirstSteps` / `OnboardingCard`), a red panel when the X connection is lost (`xConnection === 'revoked'`) or X refused posting (`xHold`, the supervisor's 403 hold) with Connect X, Fuel, Add gas (`EntryPoint.depositTo(kernel)`, acknowledged as non-refundable) and, while the agent has no X account, Connect X (SIWE claim `POST /api/siwe/x-claim`, then the usual OAuth popup against the live agent id). |
| `/token/[address]/console` | The creator console on its own page (creator only; `?section=` deep links, `lib/console-sections.ts`): a left rail with Mind, Posting, Powers, Look, Inbox and Fuel, two-column forms and a sticky save bar. Powers include Paid services with its per-call and daily caps and host lists; Posting has the posts-per-day slider (2 to 48). Reads and writes go through `/api/agent/[kernel]/*` to the supervisor. |
| `/launch` | 01 Coin, 02 Mind (model, searchable), 03 Kind (Trader / Researcher / Community / Custom with the Powers grid and Cadence), 04 Character (Instructions and job lines), 05 X account, 06 Fuel & options, with a sticky summary card (cost line, fee split, risk line, Launch). A custom kind's preset is hashed like a template (`customWorker`), saved with the draft (`POST /api/launch/draft`, field `worker`) and published in the agent card as `bootr.worker` ([`docs/design/agent-launch-v2.md`](../../docs/design/agent-launch-v2.md)); USDC approve, `BootrLauncher.launch`, then `EntryPoint.depositTo(kernel)` for the gas ([`docs/gas-model.md`](../../docs/gas-model.md)). |
| `/analytics` | Stat tiles + six visx charts from `dailyStats` / `platformStats` / agents. |
| `/docs`, `/docs/<slug>` | Overview, How a launch works, Fee math and claims, Agents, Contracts, Public APIs, For agents and LLMs, Risks, Terms, Privacy. `/docs/agent-rules` and `/docs/dormancy` redirect (308) to `/docs/agents`. |
| `/llms.txt`, `/llms-full.txt` | The docs for language models: an llmstxt.org index and the full text in Markdown, `text/plain; charset=utf-8`, prerendered, cached 1 h (1 day at the edge). See "Docs" below. |
| `/profile` | Wallet-gated: your agents (pause/unpause), creator fees (claimable WETH, unsettled WETH per coin, Claim), launched coins, holdings, fuel history. |
| `/agents/[id].json` | ERC-8004 registration file (agent card) of the agent launched under draft id `id`, with `bootr.identity` (the Instructions text) and, for a custom kind, `bootr.worker`; any origin, cached 60 s. |
| `/tokens/[id].json` | ERC-7572 contract URI of the coin launched under draft id `id` (name, symbol, description, image, external_link, socialMediaUrls). |
| `/console-<ADMIN_CONSOLE_SLUG>` | Hidden admin console (see below). Not linked, `noindex`, disallowed in `robots.txt`, absent from the sitemap. |

## Docs

The docs are data, not JSX: `components/docs/pages.ts` (order, groups, titles, descriptions), `components/docs/content.ts`
(page bodies as typed blocks; inline strings use the `code` / **bold** / [link](href) subset in `lib/docs/inline.ts`),
`components/docs/agent-tools.ts` (the agent's tool list) and `components/docs/graphql-examples.ts`. `DocArticle` renders
them on `/docs`; `lib/docs/markdown.ts` renders the same blocks to Markdown for `/llms.txt` and `/llms-full.txt`, with
site links made absolute against `NEXT_PUBLIC_SITE_URL` (default `https://bootr.fun`). Docs pages carry
`<link rel="alternate" type="text/plain" href="/llms.txt">`; the sitemap lists every page and both text files.

To add a page: an entry in `DOC_PAGES`, its body in `DOC_CONTENT`, and `app/docs/<slug>/page.tsx` (three lines, static so
it prerenders). Tests in `lib/docs/*.test.ts` keep it honest: links and anchors resolve, tables are well formed, nothing
private is documented (no `/internal`, admin or console routes), the tool list matches `packages/agent-core/src/tools.ts`
and the example queries select only fields of `apps/indexer/ponder.schema.ts`. Contract addresses come from
`@bootr/shared/addresses`, so the Contracts page follows that file.

## Images on IPFS

The launch form pins the coin image to public IPFS before launch; it never embeds a `data:` URI (bloated calldata,
not rendered by most wallets).

1. The uploader (drag-and-drop or file picker, local preview, progress) sends the file to `POST /api/upload`
   (multipart `file` + `draftId`). The route accepts PNG, JPG, WebP and SVG up to 2 MB, decides the type from the
   magic bytes (a declared type that disagrees is refused), and refuses SVGs with `<script>`, `on*=` handlers,
   `<foreignObject>`/embeds, DOCTYPE/entities, `javascript:` URLs or any non-`#fragment` `href`/`url()`.
2. It pins through Pinata's v3 Files API (`POST https://uploads.pinata.cloud/v3/files`, `network=public`) as
   `bootr/<draftId>/<sha256 prefix>` and returns `{cid, ipfsUri: "ipfs://<cid>", url: "<NEXT_PUBLIC_IPFS_GATEWAY>/ipfs/<cid>"}`.
3. `launch()` writes the gateway `url` into `LaunchParams.image` and saves it with the draft (`POST /api/launch/draft`,
   field `coin`), so the hosted ERC-7572 contract URI (`/tokens/<id>.json`, passed as `LaunchParams.metadata` and set as
   the B20 `contractURI`) carries it as `image` and the `ipfsUri` as `imageIpfs`. The ERC-8004 agent card (`/agents/<id>.json`) takes its `image`
   from the indexed token, so it carries the same gateway URL.

The route is same-origin only (`Origin` = `NEXT_PUBLIC_SITE_URL`, or a browser `Sec-Fetch-Site: same-origin`), allows 10
requests per minute per IP (in memory, per instance; IP from `X-Real-IP`, else the last `X-Forwarded-For` hop), and
answers 503 without `PINATA_JWT`. `POST /api/upload?kind=json&draftId=<uuid>` pins a JSON object (≤ 64 kB) the same
way, e.g. a registration file. In mock mode (`PINATA_MOCK=1`, or app mock mode without a JWT) nothing is pinned: the
CID is a CIDv1 (raw, sha2-256) of the bytes, deterministic but not resolvable, so a mock launch keeps the local preview.
`TokenImage` renders `ipfs://` sources through the gateway.

## Connecting X at launch

The launch form generates a draft uuid (`sessionStorage`), which is also the on-chain launch `context.id` and the agent
card key. "Connect X":

1. `POST /api/x/draft {agentId}` (same-origin only) registers the draft to this browser: an HttpOnly, SameSite=Strict
   cookie `bootr_x_drafts` (path `/api/x`, 24 h, up to 4 drafts) with an HMAC tag per draft id.
2. A popup opens `GET /api/x/start?agentId=<draft>&state=<uuid>[&reconnect=1]`: the route validates the input
   (lowercase uuid, state ≤ 128 URL-safe chars), requires the draft cookie (`403 draft_not_registered` otherwise, so a
   link sent by someone else cannot bind the visitor's X account to their draft), signs `ts`/`sig` with
   `SENDER_SERVICE_KEY` and 302s to the sender's `/oauth/start?…&redirect=1`. The sender sets its own binding cookie
   and redirects to X; its callback only completes in the same browser, once.
3. The form polls `GET /api/x/status?agentId=<draft>` every 2 s (5 min timeout; same draft cookie required), which
   calls the sender's HMAC `GET /internal/account/:agentId` server-side and returns only `{connected, handle}`.

"Change" next to a connected handle restarts the flow with `reconnect=1` (signed): the only way the sender replaces an
already connected X account. "Disconnect" issues a new draft id, so the old connection is never used. The routes answer
503 when `SENDER_SERVICE_KEY` / the sender URL are missing; in mock mode `draft` and `start` return `{mock: true}` and
`status` a fake handle. After launch the supervisor rebinds the account from the draft id to the ERC-8004 agent id.

## Connecting X after launch (the creator) and the agent API

A coin launched without an X account shows its creator a Connect X step on the coin page (`components/token/ConnectAgentX.tsx`):
the wallet signs a SIWE message `Connect the X account of Bootr agent #<agentId> (<kernel>).` (nonce from `/api/siwe/nonce`),
`POST /api/siwe/x-claim` verifies it (`lib/server/siwe-verify.ts`) and checks against the indexer that this wallet created the
coin, then registers the browser for the agent id in the same `bootr_x_drafts` cookie, so `/api/x/start` and `/api/x/status`
run the usual popup flow against the real agent id. The supervisor picks the account up from the sender on its next pass.

The agent API lets a program with a wallet do the same without a browser, authenticated by SIWE only (any origin):

| Route | Purpose |
| --- | --- |
| `POST /api/agent/nonce` | `{nonce, expiresIn}`; single use, 10 min, not cookie-bound |
| `POST /api/agent/launch` | `{message, signature, launch: {...}}` with statement `Prepare a Bootr launch.`: pins the image, stores the instructions, coin metadata and worker under a new launch id, reads fee and minimum fuel from the launcher, returns the `approve`, `launch` and `gas` transactions to send (nothing is sent server-side). `launch.worker` is a template id (`trader`, `researcher`, `community`) or a custom preset `{capabilities, postIntervalMs, jobLines}` (`@bootr/shared/workers`, `normalizeWorkerPreset`); the answer carries `workerHash` (and `workerPreset` for a custom one). 5/min per IP |
| `POST /api/agent/x-connect` | `{message, signature}` with the Connect-X statement: returns the signed sender `/oauth/start` URL for the agent (5 min), for a person to open in the agent's X account |

Mock mode returns `{mock: true}` shapes (no chain reads, zero-address launcher, deterministic CID). Documented for agents on
`/docs/for-agents#launching` and in `/llms-full.txt`; e2e in `e2e/agent-api.spec.ts`.

## Admin console and auth

Next.js only treats whole-segment brackets as dynamic, so the page lives at the literal route `app/console-admin/` and
`proxy.ts` maps requests onto it:

1. `/console-<x>` with `x !== ADMIN_CONSOLE_SLUG` (or the slug unset) → 404.
2. `/console-<slug>/signin` → SIWE sign-in (connect wallet, sign).
3. `/console-<slug>` without a valid session → 404. The console never reveals that it exists.
4. With a session → rewritten to the console; the proxy forwards the slug in a request header (client copies are
   overwritten) and the page re-checks slug + session before rendering.

SIWE flow (`siwe` package for the message; viem verifies the signature, including ERC-1271/6492 smart accounts):
`POST /api/siwe/nonce` records a 10-minute nonce server-side and sets a signed nonce cookie → the wallet signs →
`POST /api/siwe/verify` consumes the nonce (single use, even on failure), requires the message URI to be the configured
site origin (`NEXT_PUBLIC_SITE_URL`) and the domain to be that URI's host, checks chain, issued/expiry times and
`ADMIN_ADDRESSES`, then sets `bootr_admin`: an httpOnly, SameSite=Strict cookie, HMAC-SHA256-signed with
`SESSION_SECRET`, valid 8 h, carrying a random session id. `POST /api/siwe/logout` clears it and revokes that session id
server-side; the console page and `/api/admin/config` reject revoked sessions. Nonces and revocations live in process
memory (`lib/server/server-state.ts`): one web instance is assumed, and a restart forgets revocations (rotate
`SESSION_SECRET` to end every session).
(`siwe` requires `ethers`; `next.config.ts` aliases it to a tiny viem shim in `lib/siwe/ethers-shim.ts`.)

Platform config: `GET/POST /api/admin/config`, stored in `ADMIN_CONFIG_PATH` (default `data/admin-config.json` under the
working directory; the Docker image uses `/data/admin-config.json`, which must be a persistent volume) (TODO: Postgres). POST needs the admin
cookie and an `Origin` equal to the configured site origin. The indexer reads it with
`x-bootr-timestamp: <unix s>` and `x-bootr-signature: hex(HMAC-SHA256(INDEXER_SERVICE_KEY, "<ts>.GET./api/admin/config"))`
(`SENDER_SERVICE_KEY` only while `INDEXER_SERVICE_KEY` is unset).

What the console switches do:

- `launchesPaused`: the launch form shows a notice and disables Launch (via the public `GET /api/platform`). Launching is
  a wallet transaction, so there is no server-side guard; the binding switch is the launcher's on-chain `pause()`.
- `allowedModels`: the launch form and the console only offer models on the list (an entry matches a catalog id by
  full id or by its vendor-less, dot-insensitive form: `claude-haiku-4-5` = `anthropic/claude-haiku-4.5`); the web passes
  the list to the supervisor's `PUT /internal/agents/:id/config`, which refuses a model outside it. A model added to the
  catalog later must be ticked here to appear in the launch form.
- `xQuotas`, `postIntervalMinutes`: not enforced by any service yet (the sender takes its budget from its own defaults
  and `POST /internal/quota/:agentId`).

## Security headers

`proxy.ts` adds to every page and API response: a Content-Security-Policy without nonces (pages are prerendered:
`script-src 'self' 'unsafe-inline'`; `connect-src 'self' https: wss:` for wallets, RPCs and WalletConnect;
`frame-src` DexScreener and the WalletConnect/Coinbase wallet iframes; `img-src` https/data/blob; `object-src 'none'`;
`base-uri`/`form-action 'self'`; `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin` (`/api/x/*` sets `no-referrer`), a restrictive `Permissions-Policy`
and, in production on https, HSTS. See `lib/server/security-headers.ts`.

On-chain actions in the console use the connected wallet (must be the contract owner): `setDefaults(buyback, d)`,
launcher `pause/unpause`, `AgentGuardian.revokeAllSessionKeys`, `AgentGuardian.claimDormant`, and "force refuel" (a USDC
transfer to the kernel). `pauseAgent/unpauseAgent` are creator-only on-chain, so they live on `/profile`.
"Platform fees" lists, per coin from the indexer's agent list, the platform recipient (last reward recipient in
`tokenRewards`) and its claimable balances, with per-balance Claim and a sequential "Claim all"; any wallet may send
these (`claim` is permissionless and pays the recipient).

## Rendering notes

Pages must render in background tabs, where `requestAnimationFrame` never fires:

- React reveals streamed / outlined Suspense boundaries with rAF, so there is no route-level `loading.tsx`
  (React 19.2 outlines any boundary over ~12.8 KB and reveals it via rAF), and components that read URL data
  (`useSearchParams`, `useParams`) render after mount via `components/ui/ClientOnly.tsx` instead of inside a
  streamed Suspense hole. Views show their own skeletons while TanStack Query loads.
- Chart draw-in and card enter animations are CSS keyframes (`.chart-*`, `animate-enter` in `globals.css`), not
  rAF-driven JS; chart width is measured synchronously, not via visx `useParentSize`.
- `useNow()` is a shared clock read through `useSyncExternalStore` (server snapshot `0`), so render never calls
  `Date.now()` (rejected at prerender under Cache Components).

## Data layer

`lib/indexer.ts` — typed GraphQL/REST fetchers and hooks: `useTokens({tab, after})`, `useTokenFeed`, `useToken`,
`useAgent`, `useAgents`, `useDailyStats`, `usePlatformStats`, `useSearch`, profile hooks. `useIndexerStream()` (mounted
once in `Providers`) listens to `/stream` and only invalidates queries; payloads are never applied.
