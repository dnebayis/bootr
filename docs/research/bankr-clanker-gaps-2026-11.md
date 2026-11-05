# Bootr feature gap analysis (read 2026-11-05, repo at 5696749)

Nothing was written, signed or sent. Marks: **V** = I read the primary doc, package, repo or live endpoint today. **U** = inferred, or absent from docs I searched. "Absent" means a keyword search of that reference's docs found nothing, not proof it doesn't exist. Source codes (B1, C1...) are in the key under the table. Paths are relative to /Users/mehmet/Desktop/OnchainPrimitive. Value and effort are my estimates.

## Corrections to existing documents

- **Clanker v5 is live; `docs/design/clanker-launch.md` section 7.6 is stale.** It says no v5 contracts are published. The factory is `0x572e88D3…` and Clanker now files v4 under "Earlier versions" (C1, C11 V). Bootr launches on v4.
- **v5 token economics differ.** There is a 1-10% buy and sell tax with no LP fee. Clanker takes the larger of 10% of the tax or 0.5% of the trade, capped at 1%. My arithmetic: a 1.2% tax leaves the slots 0.7%, against 1.0% on v4; 1.5% is needed to match.
- **Sniper defaults moved.** Clanker's form now uses a descending sniper tax instead of an auction (C2 V). Bootr defaults to `ClankerSniperAuctionV2` (`packages/contracts/script/DeployClankerLauncher.s.sol:65`).
- **Bankr's launch gate is contradictory.** The support article says launches are Club-only on every chain (B31 V). Bankr's docs say all tiers can launch (B24 V). `docs/research/bankr-opportunity-2026-11.md` uses only the former, so treat "Bankr is paywalled" as unsettled.
- **"Agent per coin" is not unique to Bootr.** Clanker Droids are "One token, one droid", paying for their own compute (C14 V). Bootr's real difference is the treasury, X, on-chain identity and narrow keys.

## Feature table

Value and effort are filled for gaps only. "Contract" means contract changes needed. "Conflict" means conflict with user custody and narrow session keys.

| Feature | Bankr | Clanker | Bootr and proof | Value | Effort | Contract | Conflict |
|---|---|---|---|---|---|---|---|
| **Launch config** | | | | | | | |
| Vesting or vault | yes, 15% on/off; Arc up to 50% (B1 V) | v4 vault, 7-day minimum (C2 V); not on v5 (C3 V) | no; `packages/contracts/src/BootrClankerLauncher.sol:483` dev buy only; `BootrLauncher.sol:56-70` no field | M | M | yes | none if paid to creator |
| Airdrops | absent (U) | v4 yes (C2 V) | no, same proof | L | M | yes | none |
| Presale | absent (U) | v4 extension, API (C4 V) | no, same proof | L | L | yes | none if Bootr never holds funds |
| Dev buy | partial, Arc only documented (B1 V) | yes (C2 V) | yes; `BootrLauncher.sol:452`, `BootrClankerLauncher.sol:483` | - | - | - | - |
| Custom split, multiple recipients | partial: one beneficiary, partner five-way (B2, B3 V) | yes, up to 7 with admins (C2, C3 V) | two presets, fixed slots; `BootrClankerLauncher.sol:36-44` | M | M | yes | none if agent slot is protected |
| Non-WETH pair | yes, allowlist (B1 V) | v5 ETH or USDC; v4 list (C5 V) | no; `BootrClankerLauncher.sol:422`, `BootrLauncher.sol:437` | M | L | yes | session rules must be rewritten, stays narrow |
| Stock pairs | yes (B1 V) | partial: catalog API live, deploy table shows ETH and USDC only (C5, C6 V) | no | L | L | yes | none; legal view needed |
| Multi-chain | Robinhood, Base, Arbitrum, Arc (B1 V) | Base, Arbitrum, Unichain, Ethereum, BNB, Monad, Solana by bot (C7 V) | Base only; `apps/web/app/api/agent/launch/route.ts:133` | L | L | yes | same model per chain |
| MEV protection | fixed: 14 s fee decay, 2% balance cap for 5 min (B1 V) | modules; form sets 1-120 s; v5 20 s (C2, C3, C13 V) | Clanker path admin-set, no creator choice (`BootrClankerLauncher.sol:145,267`); RWAGMI path none (`apps/web/components/docs/content.ts:123`) | H | M, unknown on RWAGMI | yes | none |
| Vanity address | absent (U) | SDK helper (C8 V); v5 addresses all end in `cccc` (C11 V) | no; salt from draft id, `route.ts:212` | L | S | no | none |
| Pool layouts | partial: standard or $2,500 degen (B1 V) | Project 10/20, Legacy, up to 7 positions (C2 V) | one per path; `BootrClankerLauncher.sol:104-109,461-464`; `BootrLauncher.sol:103-108` | L | M | yes | none |
| Image, metadata update | partial: display name and logo only (B4 V) | yes; v5 also renames (C9 V) | links only (`apps/web/app/api/agent/[kernel]/links/route.ts:45-48`); image locked (`BootrClankerLauncher.sol:40-44`) | M | S (off-chain display) | no | none |
| Recipient and admin handover | yes, fee rights transfer (B5 V) | yes, two-step creator transfer (C9 V) | none, locked; `BootrClankerLauncher.sol:40-44` | H | M, future coins only | yes | creator slot only; agent and platform stay locked |
| Clanker v5 path (tax, burn, dividends, integrator) | n/a | yes (C1, C3 V) | v4 only; `BootrClankerLauncher.sol:422-424` | H | L | new launcher | none |
| Agentless coin | yes | yes | no; launchers always create a kernel (`BootrClankerLauncher.sol:28`) | M | M | no, per research doc (not rechecked) | none |
| **Post-launch** | | | | | | | |
| Claim UI | yes (B6 V) | yes (C9 V) | yes; `apps/web/components/profile/CreatorFees.tsx:31`, `ClankerCreatorFees.tsx:22`; agent `apps/supervisor/src/session-key.ts:231-249` | - | - | - | - |
| Unsigned claim API | yes, `build-claim` (B6 V) | SDK (C8 V) | no, skill names calls only (skill.md lines 360-361) | M | S | no | none, fits unsigned model |
| Fee dashboard | yes: API, CLI (B6, B7 V) | yes, API (C12 V) | partial; `apps/indexer/src/api/index.ts:148,179`, no per-creator history | L | S | no | none |
| Verified status | partial: project review (B8 V) | yes, badge (C9, C15 V) | none of its own; Clanker's API returns `verified: true` for $BOOTR but also for other coins, meaning undocumented | M | S | no | none |
| **Discovery** | | | | | | | |
| Feed | yes (B10 V) | yes (C12 V) | yes; `apps/web/components/tokens/TokensView.tsx:14-19`, `index.ts:132,535` | - | - | - | - |
| Search | chat only found (B16 V) | yes (C12 V) | yes; `index.ts:96`, `CommandPalette.tsx:12` | - | - | - | - |
| Trending | chat (B16 V) | yes, reranked each minute (C12 V) | no; "Active" tab only sorts by 24h volume, `apps/web/lib/indexer.ts:119-124` | M | S | no | none |
| Filters | not checked (U) | yes: creator, pair, type, date, curated (C12 V) | four tabs only | M | S | no | none |
| Leaderboards | partial: score and rank in API (B11 V) | droid leaderboard (C14, C17 V) | none, zero code matches | H | S | no | none |
| Public profiles | Projects (B8 V) | profile, creator API (C12 V) | connected wallet only; `apps/web/components/profile/ProfileView.tsx:142-228` | M | S | no | none |
| Referrals | partial: code shown, rules not found (B12 V) | partial: integrator share (C3 V) | none | M | M | yes if paid on-chain | none |
| Notifications | partial: price alerts, Telegram (B16, B20 V) | absent (U) | none; stub at `apps/supervisor/src/approvals.ts:112-115` | H | S-M | no | none |
| Trade in site | yes, `/trade/<token>` (B6 V) | yes, listed as v5 frontend (C16 V) | no, links to DefiLlama; `apps/web/components/token/TokenView.tsx:164`, `apps/web/lib/chains.ts:45-49` | H | M | no | none; user's wallet signs |
| Portfolio | yes, with PnL (B13 V) | balances, dividends (C12 V) | Bootr coins only, no PnL; `ProfileView.tsx:200`, `index.ts:405` | L | M | no | none |
| **Developer** | | | | | | | |
| SDK | alpha (B14 V) | yes, 4.2.19 (C8 V) | none; packages private (`packages/agent-core/package.json:4`) | M | S | no | none |
| API | yes (B1 V) | yes (C12 V) | yes, 21 endpoints; `apps/web/lib/server/catalog.ts` | - | - | - | - |
| CLI | yes (B15 V) | yes (C8 V) | none | M | S | no | none if signing stays local |
| Webhooks | inbound agent triggers (B17 V) | absent (U) | none; SSE hints only, `index.ts:535` | M | S-M | no | none |
| Partner keys | yes (B3 V) | yes (C3 V) | none; catalog offers only open or SIWE auth | L | M | yes for fee share | conflict if server-sent; return unsigned txs |
| Skills, plugins | catalog, Claude plugins (B18 V) | skill (C18 V) | skill; `apps/web/app/skill/skill.md/route.ts` | - | - | - | - |
| MCP server | client only; no public server found (B19 V, U) | absent (U) | none | M | S | no | none if read and prepare only |
| Rate limits | documented (B21 V) | documented (C19 V) | two routes (`catalog.ts:192,206`); no limiter in `apps/indexer/src/api/index.ts`, and `/treasury` reads chain per request | M | S | no | none |
| Status page | none found (U) | none found (U) | `/api/health` only | L | S | no | none |
| **Social triggers** | | | | | | | |
| X launch | yes (B22 V) | Solana only (C7 V) | none; agents read mentions only (`apps/sender/src/inbox.ts:20`) | H | M | no | conflict only if gasless; signing link is clean |
| Farcaster | surface and replies (B20 V); launch unclear (U) | yes (C20 V) | none, zero code matches | M | M | no | none |
| Telegram | yes (B1 V) | absent (U) | link field only, `links/route.ts:45` | L | S-M | no | none |
| **Agents** | | | | | | | |
| Trading | full (B16 V) | none described (C14 V page, U absence) | WETH to USDC only; `apps/supervisor/src/broker/index.ts:413,444` | M | L | policy, likely contract | **high** unless one pinned route with capped window |
| Automations | yes (B23 V) | absent (U) | agent-chosen wake only; `packages/agent-core/src/tools.ts`, `runtime/wake.ts` | M | M | no | none for reads and posts |
| Limit, stop, DCA | yes (B23 V) | absent (U) | none | L | L | yes | **high**; I would not build |
| Memory | yes (B24 V) | voice text; memory U (C14 V) | yes; `apps/supervisor/src/memories.ts:25` | - | - | - | - |
| Tools | MCP, skills, browser (B19 V) | cast and reply (C14 V) | 20 tools; `apps/web/components/docs/agent-tools.ts:22-41`; no creator-added tools | M | M | no | none for read-only |
| Private chat with own agent | yes (B24 V) | yes (C14 V) | none, zero code matches | M | S-M | no | none |
| Agent webhooks | yes (B17 V) | absent (U) | none | M | M | no | treat as data; no money action |
| Agent without launching a coin | agent-first model (B24 V) | standalone droid (C14 V) | no | H | L | maybe; funding unsolved | none |
| **Account** | | | | | | | |
| Passkey wallet | embedded, not exportable (B25 V) | Privy, Farcaster login (C20 V) | yes, Base Account; `apps/web/lib/wagmi.ts:5,25` | - | - | - | - |
| Email or social login | yes (B25 V) | partial (C20 V) | none | M | M | no | **yes** if server-signed; only passkey-owned wallets fit |
| Gas sponsorship | yes, capped (B26 V) | not checked | none; gas funded by creator, `apps/web/components/token/GasForm.tsx` | M | M | no | none with paymaster only |
| **Monetization** | | | | | | | |
| Staking | yes (B27 V) | absent (U) | none | L | L | yes | none |
| Buyback | BNKR share of fees (B1 V) | $CLANKER counter on site (C13 V) | per-coin preset; $BOOTR burn counted, `apps/indexer/src/fees.ts:230`; platform buyback not found | M | S | no | none |
| Holder dividends | partial, Arc only (B1 V) | v5 (C10 V) | none | M | L, or via v5 | yes | none; legal view needed |

### Source key

`clanker.gitbook.io/clanker-documentation/` loaded, but the `.md` and `llms.txt` paths I read are under `/documentation/`.

| Code | URL |
|---|---|
| B1 | https://docs.bankr.bot/docs/token-launching/overview.md |
| B2 | https://docs.bankr.bot/docs/token-launching/fee-splitting.md |
| B3 | https://docs.bankr.bot/docs/partnership/overview.md , https://docs.bankr.bot/docs/partnership/token-launching.md |
| B4 | https://docs.bankr.bot/docs/faq/token-launching.md |
| B5 | https://docs.bankr.bot/docs/token-launching/transferring-fees.md |
| B6 | https://docs.bankr.bot/docs/token-launching/claiming-fees.md |
| B7 | https://docs.bankr.bot/docs/token-launching/reading-fees.md |
| B8 | https://docs.bankr.bot/docs/projects/overview.md |
| B10 | https://docs.bankr.bot/docs/token-launching/api-reference/list-token-launches.md , live https://api.bankr.bot/token-launches |
| B11 | https://docs.bankr.bot/docs/wallet-api/wallet-info.md |
| B12 | https://docs.bankr.bot/docs/cli.md (`whoami`) |
| B13 | https://docs.bankr.bot/docs/wallet-api/portfolio.md |
| B14 | https://docs.bankr.bot/docs/agent-api/transaction-types.md |
| B15 | https://docs.bankr.bot/docs/cli.md |
| B16 | https://docs.bankr.bot/docs/features/features-table.md |
| B17 | https://docs.bankr.bot/docs/webhooks/overview.md |
| B18 | https://docs.bankr.bot/docs/skills/overview.md , https://github.com/BankrBot/skills , https://docs.bankr.bot/docs/claude-plugins/overview.md |
| B19 | https://docs.bankr.bot/docs/agent/advanced.md |
| B20 | https://docs.bankr.bot/docs/agent/access.md , https://docs.bankr.bot/docs/faq/bankr-club.md |
| B21 | https://docs.bankr.bot/docs/security/developer-api.md |
| B22 | https://docs.bankr.bot/docs/guides/social-deployment.md |
| B23 | https://docs.bankr.bot/docs/agent/automations.md |
| B24 | https://docs.bankr.bot/docs/agent/overview.md , https://docs.bankr.bot/docs/agent/memory.md , https://docs.bankr.bot/docs/agent/access.md |
| B25 | https://docs.bankr.bot/docs/faq/wallets.md |
| B26 | https://docs.bankr.bot/docs/getting-started/supported-chains.md |
| B27 | https://docs.bankr.bot/docs/features/staking.md |
| B31 | https://bankr-support.support.site/article/token-launch-blocked |
| C1 | https://clanker.gitbook.io/documentation/tokens/token-deployments.md |
| C2 | https://clanker.gitbook.io/documentation/tokens/token-deployments/clanker.world-deployments.md , https://clanker.gitbook.io/documentation/tokens/token-deployments/v4-deployments.md |
| C3 | https://clanker.gitbook.io/documentation/tokens/token-deployments/v5-deployments.md |
| C4 | https://clanker.gitbook.io/documentation/api-reference/public/presales.md |
| C5 | https://clanker.gitbook.io/documentation/references/supported-quote-tokens.md |
| C6 | https://clanker.gitbook.io/documentation/api-reference/public/market-data.md , live https://www.clanker.world/api/tax/quote-market?chainId=8453 , https://www.clanker.world/terms/stock-tokens (URL seen, not read) |
| C7 | https://clanker.gitbook.io/documentation/references/deployed-contracts.md |
| C8 | https://www.npmjs.com/package/clanker-sdk (package 4.2.19 README and types read) |
| C9 | https://clanker.gitbook.io/documentation/tokens/managing-a-token.md |
| C10 | https://clanker.gitbook.io/documentation/tokens/holder-dividends.md |
| C11 | https://clanker.gitbook.io/documentation/references/core-contracts/v5.md |
| C12 | https://clanker.gitbook.io/documentation/api-reference/public.md and subpages under https://clanker.gitbook.io/documentation/api-reference/public/ |
| C13 | https://www.clanker.world homepage; https://github.com/clanker-devco/v4-contracts (`src/mev-modules`) |
| C14 | https://www.clanker.world/droids |
| C15 | https://clanker.gitbook.io/documentation/safety/verifying-the-social-context-of-token-deploys.md |
| C16 | https://clanker.gitbook.io/documentation/references/compatible-trading-platforms.md |
| C17 | https://clanker.gitbook.io/documentation/api-reference/public/legion.md |
| C18 | https://www.clanker.world/skill/skill.md |
| C19 | https://clanker.gitbook.io/documentation/api-reference/authenticated/deployment.md , https://clanker.gitbook.io/documentation/api-reference/public/deployment.md |
| C20 | https://clanker.gitbook.io/documentation/tokens/token-deployments/farcaster-bot-deployments.md , https://clanker.gitbook.io/documentation/tokens/token-deployments/preclank-deployments.md |

## Top 10 gaps, in order

1. **Notifications.** Fuel, gas and review events reach nobody; review items expire after 48 h, and the stub is at `approvals.ts:112`.
2. **Trade on the coin page.** Today the main action sends every visitor to DefiLlama; the user's wallet can sign, so custody is untouched.
3. **Leaderboards, trending, filters.** The indexer already holds the data, and agents ranked by fees and activity give people a reason to return.
4. **Creator-slot handover, plus off-chain image edit.** Every launch adds a coin that can't be retrofitted, and a lost creator key strands its fees.
5. **X launch reply with a signing link.** This is the largest reach gain that adds no custody, but X's written approval for AI replies comes first.
6. **Anti-sniper on the RWAGMI path.** The default launch path has none, while both references protect launches.
7. **Decide on Clanker v5.** It brings a lower opening cap, USDC fees that remove the agent's swap step, burns and an integrator slot; it needs a new launcher, `cccc` salt grinding and a higher tax to match today's slot income.
8. **Private chat with your own agent.** Clanker Droids and Bankr offer it, and it makes the agent feel owned at low cost.
9. **Public creator and agent profiles with an X-linked badge.** Trust currently rests on a contract address and links.
10. **Prepare-only MCP, CLI and SDK, plus unsigned claim.** One thin wrapper over the catalog; I found no public MCP server at either reference.

**Not worth building:** limit, stop and DCA orders, arbitrary agent trading, server-held wallets. They break the custody rule and duplicate Bankr's main product.

## What Bootr already does better

- **Custody:** the server returns unsigned transactions and the user signs (`apps/web/app/api/agent/launch/route.ts`). Bankr's embedded keys are not exportable (B25 V).
- **On-chain limits:** session keys pass through an allow-list with a windowed USDC cap (`packages/contracts/src/BootrCallPolicy.sol:6-19`). Bankr's spend limits are enforced on its own wallet-level controls (B21, B31 not contract-level, U).
- **Creator kill switch:** `pauseAgent` and `unpauseAgent` (`packages/contracts/src/AgentGuardian.sol:322,330`), exposed in `ProfileView.tsx:59`.
- **Post review and reply opt-outs:** `apps/supervisor/src/approvals.ts`, `apps/sender/src/consent-gate.ts:91`.
- **Agent identity:** ERC-8004 entry plus a worker hash committing to the preset (`packages/shared/src/workers.ts`).
- **Locked agent funding:** the split can't be changed by anyone after launch. The same lock causes gap 4, so keep it for the agent and platform slots.
- **Trader cost:** 1% (RWAGMI) or 1.2% (Clanker v4), against Bankr's 1.75% (B1 V).
- **Machine-readable API:** `https://bootr.fun/api/catalog` gives schemas and limits in one document, and the skill leads with safety rules.
- **No launches for someone else's handle:** Bankr's docs allow `@handle` as fee recipient (B2 V); Bootr's creator is always the signer.

## What I couldn't check

- Bankr's logged-in site (trade panel, leaderboard page, filters). Its routes all return 200, so route status proves nothing; page features come from docs.
- clanker.world's in-page trading behavior, beyond docs and markup counts. I didn't connect a wallet or test any flow.
- Whether `BootrClankerLauncher`'s pattern works on v5 `createLaunch` (Solidity not read), and whether `ClankerSniperAuctionV2` is still enabled.
- Whether RWAGMI offers an anti-sniper module.
- The meaning of Clanker's `tags.verified`.
- Clanker's X coverage beyond the one Solana line in its contracts page, and Farcaster launch details for Bankr.
- Live production config for Bootr: code was read, deployed env vars were not.
- The `clanker-devco/v4-contracts` repo was last pushed 2025-11-07, so it doesn't reflect v5.
