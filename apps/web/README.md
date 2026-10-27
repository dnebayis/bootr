# Bootr web (`apps/web`)

Next.js 16 App Router (Cache Components + Partial Prefetching), React 19, Tailwind v4, wagmi v3 / viem, TanStack Query.
Brand and tokens: [`DESIGN.md`](./DESIGN.md) (`## Bootr` section) and [`app/globals.css`](./app/globals.css).

```sh
pnpm --filter web dev          # http://localhost:3000
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web build
pnpm --filter web test:e2e     # Playwright smoke tests (builds + starts on :3210, mock mode)
```

Container (build from the repo root; `NEXT_PUBLIC_*` are build args, everything else is runtime env; Railway setup in
[`docs/deploy/railway.md`](../../docs/deploy/railway.md)). The Dockerfile builds with `NEXT_OUTPUT=standalone` (see `next.config.ts`) and serves `apps/web/server.js`;
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
| `NEXT_PUBLIC_SWAP_LINK_BASE` | Trade link prefix, token address appended (Uniswap otherwise). |
| `NEXT_PUBLIC_LAUNCHER_ADDRESS` | `BootrLauncher`. |
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
`config warning` line at startup for a missing or short key (values are never logged). The web app does not call the
supervisor, so it does not hold `SUPERVISOR_SERVICE_KEY`.

Clanker / USDC / WETH addresses come from `@bootr/shared/addresses`. The locked split is read from
`ClankerLpLockerFeeConversion.tokenRewards(token)`. Claimable fees are `ClankerFeeLocker.availableFees(owner, feeToken)`
(WETH is one pooled balance per recipient; fees taken in a coin are per coin) and `claim(owner, feeToken)` is
permissionless and always pays `owner`. Claims carry the ERC-8021 `dataSuffix`.

Wallets: Base Account ("Sign in with Base", passkey smart wallet; `lib/connectors/base-account.ts` loads
`@base-org/account/browser` so the SSR bundle never pulls the SDK's Node entry), Coinbase Wallet (EOA only), the
injected browser wallet, WalletConnect. The Builder Code suffix is passed to both SDKs as `preference.attribution` so a
smart wallet also suffixes its outer `executeBatch` calldata.

Server API used by the app itself: `GET /api/models` (relay `/v1/models` read server-side, cached 60 s, priced per
thought = 4,000 prompt + 1,024 output tokens at the relay's margin, filtered by the console `allowedModels`; built-in
list when the relay is unset or down) and `GET /api/agents/:id/posts?limit=3` (proxy to the sender's public
`/public/posts/:agentId`, cached 60 s; 404 = the sender never saw the agent).

## Routes

| Route | |
|---|---|
| `/` | $BOOT box, tabs `?tab=newest|graduated|mcap|active`, live grid (virtualized past 60 cards), ⌘K search. |
| `/token/[address]` | Header, DexScreener embed (mainnet), agent panel + Fuel, locked fee split, Trade link, last 20 trades. |
| `/launch` | Coin, Agent, X account, Fuel & options; USDC approve then `BootrLauncher.launch`. |
| `/analytics` | Stat tiles + six visx charts from `dailyStats` / `platformStats` / agents. |
| `/docs`, `/docs/[slug]` | How it works, Fee math, Agent rules, Dormancy, Risks. |
| `/profile` | Wallet-gated: your agents (pause/unpause), creator fees (claimable WETH + per-coin, Claim), launched coins, holdings, fuel history. |
| `/console-<ADMIN_CONSOLE_SLUG>` | Hidden admin console (see below). Not linked, `noindex`, disallowed in `robots.txt`, absent from the sitemap. |

## Images on IPFS

The launch form pins the coin image to public IPFS before launch; it never embeds a `data:` URI (bloated calldata,
not rendered on clanker.world).

1. The uploader (drag-and-drop or file picker, local preview, progress) sends the file to `POST /api/upload`
   (multipart `file` + `draftId`). The route accepts PNG, JPG, WebP and SVG up to 2 MB, decides the type from the
   magic bytes (a declared type that disagrees is refused), and refuses SVGs with `<script>`, `on*=` handlers,
   `<foreignObject>`/embeds, DOCTYPE/entities, `javascript:` URLs or any non-`#fragment` `href`/`url()`.
2. It pins through Pinata's v3 Files API (`POST https://uploads.pinata.cloud/v3/files`, `network=public`) as
   `bootr/<draftId>/<sha256 prefix>` and returns `{cid, ipfsUri: "ipfs://<cid>", url: "<NEXT_PUBLIC_IPFS_GATEWAY>/ipfs/<cid>"}`.
3. `launch()` writes the gateway `url` into the Clanker `image` (wallets and clanker.world need http(s)) and the
   `ipfsUri` into the Clanker metadata as `imageIpfs`. The ERC-8004 agent card (`/agents/<id>.json`) takes its `image`
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

## Admin console and auth

Next.js only treats whole-segment brackets as dynamic, so the page lives at the literal route `app/console-[slug]/` and
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
- `allowedModels`: the launch form only offers models on the list (an entry matches a relay id by full id or by its
  vendor-less, dot-insensitive form: `claude-haiku-4-5` = `anthropic/claude-haiku-4.5`). The relay and the supervisor do
  not read it yet.
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
