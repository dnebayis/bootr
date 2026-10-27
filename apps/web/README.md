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
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for metadata/sitemap (default `https://bootr.fun`). |
| `NEXT_PUBLIC_INFERENCE_URL` | Inference gateway; `/v1/models` feeds the model picker (static list otherwise). |
| `NEXT_PUBLIC_SENDER_PUBLIC_URL` | Browser-facing X sender origin: `/api/x/start` redirects the OAuth popup to its signed `/oauth/start`; also `/public/posts/:kernel`. |
| `NEXT_PUBLIC_SWAP_LINK_BASE` | Trade link prefix, token address appended (Uniswap otherwise). |
| `NEXT_PUBLIC_LAUNCHER_ADDRESS` | `BootrLauncher`. |
| `NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS` | `AgentGuardian`. |
| `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY` | Address passed as `supervisorSessionKey` in `launch()` (informational). |
| `NEXT_PUBLIC_BOOT_X_URL` | Platform X profile link (hidden when empty). |
| `NEXT_PUBLIC_WORKER_SOURCE_BASE` | Prefix for worker-hash source links (hash shown without link when empty). |

Server only (already in the root `.env.example`): `ADMIN_CONSOLE_SLUG`, `ADMIN_ADDRESSES`, `SESSION_SECRET` (≥ 16 chars),
`SENDER_SERVICE_KEY` (HMAC for service reads of the admin config, and for signing the sender's `/oauth/start` and
internal API calls in `/api/x/*`), `SENDER_URL` (optional server-to-server sender origin for `/api/x/status`; defaults to
`NEXT_PUBLIC_SENDER_PUBLIC_URL`), `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` (SIWE signature checks).

Clanker / USDC / WETH addresses come from `@bootr/shared/addresses`. The locked split is read from
`ClankerLpLockerFeeConversion.tokenRewards(token)`.

## Routes

| Route | |
|---|---|
| `/` | $BOOT box, tabs `?tab=newest|graduated|mcap|active`, live grid (virtualized past 60 cards), ⌘K search. |
| `/token/[address]` | Header, DexScreener embed (mainnet), agent panel + Fuel, locked fee split, Trade link, last 20 trades. |
| `/launch` | Coin, Agent, X account, Fuel & options; USDC approve then `BootrLauncher.launch`. |
| `/analytics` | Stat tiles + six visx charts from `dailyStats` / `platformStats` / agents. |
| `/docs`, `/docs/[slug]` | How it works, Fee math, Agent rules, Dormancy, Risks. |
| `/profile` | Wallet-gated: your agents (pause/unpause), launched coins, holdings, fuel history. |
| `/console-<ADMIN_CONSOLE_SLUG>` | Hidden admin console (see below). Not linked, `noindex`, disallowed in `robots.txt`, absent from the sitemap. |

## Connecting X at launch

The launch form generates a draft uuid (`sessionStorage`), which is also the on-chain launch `context.id` and the agent
card key. "Connect X" opens a popup on `GET /api/x/start?agentId=<draft>&state=<uuid>`: the route validates the
input (lowercase uuid, state ≤ 128 URL-safe chars), signs `ts`/`sig` with `SENDER_SERVICE_KEY` and 302s to the sender's
`/oauth/start?…&redirect=1`, which redirects to X. The form polls `GET /api/x/status?agentId=<draft>` every 2 s (5 min
timeout), which calls the sender's HMAC `GET /internal/account/:agentId` server-side and returns only
`{connected, handle}`. Both answer 503 when `SENDER_SERVICE_KEY` / the sender URL are missing; in mock mode `start`
returns `{mock: true}` and `status` a fake handle. "Disconnect" issues a new draft id, so the old connection is never
used. After launch the supervisor rebinds the account from the draft id to the ERC-8004 agent id.

## Admin console and auth

Next.js only treats whole-segment brackets as dynamic, so the page lives at the literal route `app/console-[slug]/` and
`proxy.ts` maps requests onto it:

1. `/console-<x>` with `x !== ADMIN_CONSOLE_SLUG` (or the slug unset) → 404.
2. `/console-<slug>/signin` → SIWE sign-in (connect wallet, sign).
3. `/console-<slug>` without a valid session → 404. The console never reveals that it exists.
4. With a session → rewritten to the console; the proxy forwards the slug in a request header (client copies are
   overwritten) and the page re-checks slug + session before rendering.

SIWE flow (`siwe` package for the message; viem verifies the signature, including ERC-1271/6492 smart accounts):
`POST /api/siwe/nonce` sets a signed, 10-minute nonce cookie → the wallet signs → `POST /api/siwe/verify` checks nonce,
domain, URI, chain, issued/expiry times and `ADMIN_ADDRESSES`, then sets `bootr_admin`: an httpOnly, SameSite=Strict
cookie, HMAC-SHA256-signed with `SESSION_SECRET`, valid 8 h. `POST /api/siwe/logout` clears it.
(`siwe` requires `ethers`; `next.config.ts` aliases it to a tiny viem shim in `lib/siwe/ethers-shim.ts`.)

Platform config: `GET/POST /api/admin/config`, stored in `data/admin-config.json` (TODO: Postgres). POST needs the admin
cookie and a same-origin request. The indexer/supervisor read it with
`x-bootr-timestamp: <unix s>` and `x-bootr-signature: hex(HMAC-SHA256(SENDER_SERVICE_KEY, "<ts>.GET./api/admin/config"))`.

On-chain actions in the console use the connected wallet (must be the contract owner): `setDefaults(buyback, d)`,
launcher `pause/unpause`, `AgentGuardian.revokeAllSessionKeys`, `AgentGuardian.claimDormant`, and "force refuel" (a USDC
transfer to the kernel). `pauseAgent/unpauseAgent` are creator-only on-chain, so they live on `/profile`.

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
