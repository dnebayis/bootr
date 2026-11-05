# How Bankr and Clanker launch from X

Read 2026-11-05. **V** = read from a primary source today (docs, public API, chain, the post itself). **U** = inferred. Sampled data is recent and small; it shows how the systems behave, not their rules.

## Clanker: @clanker_world, Base, v4 factory

Docs mention X only for Solana. The live API and chain show it also launches on Base (V).

| | Observed |
|---|---|
| Who sends the deploy | One bot EOA `0xd9aCd656…6e58`, nonce 423,273, for all 20 sampled social launches (V) |
| Factory | v4 `0xE85A59c6…83a9` for 19 of 20, even after v5 went live (V) |
| Fee slots | One recipient, 100% of the LP fee: `recipient` = `admin` = the author's wallet, with `clankerFee` and `pairedFee` of 10000 (15 of 15 with the field) (V). No platform slot; Clanker's protocol fee sits on top |
| Author's wallet | One address per X numeric id (same author, same address, V). 9 of 14 had never sent a tx and held 0 ETH, and the other 5 were active (V). clanker.world uses Privy (V in its bundle). Wallets created or looked up per X account, reached by signing in: U |
| Sniper protection | Descending tax 80% to 5% over 15 s (15 of 15) (V) |
| Provenance | `social_context` = interface `clanker`, platform `twitter`, messageId = post URL, id = numeric X id, username (V) |
| Gas | 0.0000246 ETH for the sampled launch (V) |
| Timing | Replies land about every 1-2 min, at about :10 s (V, small sample) |

Conversation, from the posts themselves (V):
- "Do you want a token named Clanker 3D with symbol Clk3D? Reply yes to confirm, or send a different name, symbol, or chain. Attach an image if you want one."
- "Did you mean name "Jesse Punk" with symbol JP on Base? Reply yes to launch, or send the name and symbol you want…"
- "I didn't catch a token name or symbol in that…"
- "Good night. I can't open links, so I can't see your creation. If it's a token you want launched, send me a name and symbol…"
- "Clanker 3D (Clk3D) is deployed on Base, paired with WETH. I didn't see an image attached, so you can add one later from the token's admin page."

So: it reads free text, chats, asks to confirm when unsure, and also launches at once when name and ticker are clear (@LLuckyfish's post went straight to deploy, V). Replies read as model-written (U).

Not found: age, follower or per-author limits on X (docs give one a day on BNB Chain only); the claim path for an X user.

## Bankr: @bankrbot, Base and Robinhood, Doppler

| | Docs (V) | Observed (V) |
|---|---|---|
| Command | "@bankrbot deploy MyToken with symbol MTK on base" | Chats about pairs in replies |
| Who deploys | Not stated | ERC-4337 bundle from the launcher's own smart wallet (2 of 2 checked) |
| Wallet | Privy smart wallet, created at signup, tied to the numeric X id, keys not exportable | |
| Fees | 1.75% total; creator 0.665%; Bankr 0.475%; buyback 0.2375% | Fee recipient = deployer in 26 of 50 |
| Gas | Bankr pays on Base | |
| Limits | 3 attempts per rolling 24 h per wallet, 1 a minute, about 10 deploys per IP per day; a slot returns only when a launch provably never broadcast | |
| Access on X | Replies only for Club ($20 a month) or Max Mode; free users "ignored" | |
| Recipient | Default own wallet; address, ENS or @handle allowed; rights transferable | |
| Image | Launches without a logo if fetching fails | |
| Reply | Address, trade link, ownership confirmation | |

Farming warning (V): 24 of 50 recent launches show a recipient different from the deployer, and most of them cite old posts by Vitalik, CZ, Trump, Meta or Cursor. Wallets in that set recur as recipients of each other's launches.

## What both do

- A bot that reads free text and talks, not a fixed command parser.
- A per-X-account wallet (Bankr documented, Clanker inferred), found by numeric id. No shared escrow key, no bind step.
- The platform pays gas. Provenance is keyed to the numeric id.
- The author can launch with no prior wallet setup.

## Where they differ

- **Income:** Clanker takes a protocol fee on top with no platform slot. Bankr keeps a large share.
- **Access:** Clanker is open on X. Bankr requires payment.
- **Limits:** Bankr documents strict per-wallet limits. Clanker's are not published.

## Effect on Bootr's draft design

Replace the draft's fixed parser and shared escrow key with: free-text conversation, a confirm step when unsure, and one wallet per X numeric id. Clanker's sniper config, one-recipient shape and social context format can be mirrored directly on the v4 path. X's written approval rule for AI reply bots still applies, and neither reference's approval status is known.

## The wallet primitive

Privy's user-creation API accepts `linked_accounts` of type `twitter_oauth` with `subject`, `name` and `username`, together with `wallets` to create for that user, so a wallet can exist before the person's first login (V: https://docs.privy.io/api-reference/users/create.md). Its docs say a user can access a pregenerated wallet and its assets after logging in (V). Who can sign before login, and the price, were not confirmed. No Bootr fork or live test has been run on this yet.

## Sources

https://docs.bankr.bot/docs/guides/social-deployment.md , /docs/token-launching/overview.md , /fee-splitting.md , /claiming-fees.md , /transferring-fees.md , /docs/faq/wallets.md , /docs/faq/token-launching.md , /docs/agent/access.md , https://api.bankr.bot/token-launches , https://clanker.gitbook.io/documentation/safety/verifying-the-social-context-of-token-deploys.md , /references/deployed-contracts.md , https://www.clanker.world/api/tokens?socialInterface=clanker , /api/search-creator , https://x.com/nft1Roul/status/2118428267464012133 , https://x.com/nft1Roul/status/2118426631979057528 , https://x.com/LLuckyfish/status/2118426620272992595
