# Bootr on Robinhood Chain, next to Base

Research and design note, 2026-11-13; the code was read at commit `d8927cb`. No code is written here and nothing is
deployed. The owner's decision of 2026-11-13: after the current round of agent tools ships
([`agent-tools-2.md`](./agent-tools-2.md)), the next work is **Robinhood Chain: Bootr opens on Robinhood Chain as well
as Base, both live side by side.** This note replaces section 11 of
[`clanker-v5-migration.md`](./clanker-v5-migration.md) (written 2026-11-10) as the reference; section 13 lists what
changed since then.

Marks: **V** = read today on a primary source, which is named (the chain itself through the public RPC
`https://rpc.mainnet.chain.robinhood.com` with `cast`, Robinhood's own pages, a project's own docs or repository, or a
file of this repository); **U** = not verified; **I** = inferred. Chain reads were made on 2026-11-13 between 18:20
and 20:00 UTC, around Robinhood Chain block 113,560,000, unless a line says otherwise. A dollar figure for ETH uses
the Chainlink ETH/USD answer read on Robinhood Chain that evening, $1,935.63.

Words: **RH** = Robinhood Chain mainnet, chain id 4663. **Base** = Base mainnet, 8453. **The stack** = Bootr's five
services (web, indexer, supervisor, sender, inference relay) on the one Hetzner server (`docs/STATUS.md` section 1).
**Fuel** = the USDC an agent's spender wallet pays for thinking with. **Hosted / own** as in
[`byo-agent.md`](./byo-agent.md).

## 1. Robinhood Agents: what it is, and what it has to do with Bootr

The owner sent two Robinhood help articles with the decision. Both were read in full on 2026-11-13, with the four
articles they point at and the launch announcement. The short answer: **Robinhood Agents is a product of Robinhood's
brokerage, not of Robinhood Chain. Neither article mentions the chain, a wallet, a token, a stablecoin or any on-chain
action. It shares a brand with the chain and nothing else.**

### 1.1 What the pages say (V, pages named in 1.4)

| Question | Answer |
| --- | --- |
| What is it | An AI agent inside the Robinhood mobile app that a customer chats with, that researches, analyses the customer's portfolio and places trades. It runs on a language model from an outside provider that the customer picks. Launched 2026-05-27 as "Agentic Trading" together with an "Agentic Credit Card". |
| Two kinds of agent | **Built-in** ("Robinhood Agents"): lives in the app, one per customer. **External** ("MCP accounts"): the customer's own AI client connected to Robinhood's Trading MCP server at `https://agent.robinhood.com/mcp/trading`. Clients named: Claude Code, Claude Desktop, ChatGPT, Codex and its CLI, Cursor, Grok, Perplexity, OpenClaw, Replit, AWS Quick, Poke, and anything on localhost; others by asking support. |
| Who can use it | A Robinhood customer with a primary individual investing account in good standing. The pages sit on the US site and name no other country. Still rolling out; the full built-in experience is in the mobile app only. Up to ten external-agent accounts per customer. |
| Where the agent's money is | A dedicated, self-directed brokerage account (the "Agentic account") that the customer funds from a bank or another Robinhood account. The agent can read the customer's other accounts and can trade only in this one. |
| What it may trade | Long stocks, single-leg options, and crypto, each as far as the account is eligible. Order types: market (by shares or by dollars), limit, stop limit, stop market, and for built-in agents take-profit / stop-loss. No multi-leg options. Crypto only in the pairs Robinhood itself lists, through a Robinhood Crypto account the customer opens; the agent cannot transfer, stake or lend crypto. |
| Venue | Robinhood's own brokerage (Robinhood Financial and Robinhood Securities) and Robinhood Crypto. Not a chain, not a DEX. |
| How it is limited | "Trade approvals": the agent proposes and the customer places the order by hand. On by default for built-in agents, **off by default for external agents** (and still rolling out for them). Some trades need approval even when it is off. Skills (ready-made abilities) can be switched off one by one. The customer can pause or disconnect the agent at any time. |
| Interfaces | Two MCP servers: Trading (above) and Banking (`https://banking-agent.robinhood.com/mcp/banking`, for the card). About 90 named tools in ten groups (account, watchlists, market data, stocks, options, crypto, scanners, alerts, advanced orders, charts); external agents get most of them. No wallet, no on-chain standard, no public HTTP API described on these pages. How a client signs in is not described beyond "add the link, then authenticate". |
| Cost | Chatting with the built-in agent uses tokens paid from a prepaid usage balance, with a free starting balance. Agent apps are monthly subscriptions taken from the investing account. Normal brokerage fees apply. An external agent's model is paid for by the customer at their own provider. |
| Agent apps | A marketplace run by Robinhood Labs where a customer subscribes to add-ons from independent companies (data sets, skills, tools) for the **built-in** agent only. The pages describe no developer programme, SDK or way to apply. |
| Agentic Credit Card | A virtual card inside the Robinhood Gold Card (issued by Coastal Community Bank). The customer's agent gets the card details through the Banking MCP and pays at ordinary checkouts; the customer sets approval of every purchase or a monthly limit. No stablecoin, no x402. |
| Where it is not available | Crypto through an agent is closed in some states, New York named. In California and Connecticut approvals must stay on for crypto trades by built-in agents. |
| What the terms say | The customer is responsible for every trade and purchase the agent makes. Robinhood Labs, LLC provides the technology and is stated not to be a broker-dealer, adviser or money transmitter; Robinhood does not vouch for the agent's output. The pages point at account agreements and agentic disclosures that were not read (U). Nothing on these pages forbids a use by name beyond the limits above. |

One sentence from the trading article carries the whole stance: "You are ultimately responsible for the trades your
AI agent places in your Agentic account."

### 1.2 How it relates to Bootr

| Possible relation | Verdict | Why |
| --- | --- | --- |
| A venue Bootr's agents could trade on | **No** | The venue is a brokerage account of one identified person. A Bootr agent's money is a Kernel smart account on a chain (`packages/shared/src/addresses.ts`, `zerodev`). It has no brokerage account and cannot have one. Crypto bought there cannot be withdrawn by the agent. |
| A client that could use Bootr's MCP server | **Only in the trivial sense** | The external-agent clients Robinhood names (Claude Code, Claude Desktop, Cursor, Codex) are the same clients Bootr's own-agent mode supports (`docs/design/byo-agent.md`). One person can connect both servers to one client. Robinhood's built-in agent cannot add an MCP server; it takes only "Agent apps" from Robinhood's own marketplace. |
| A distribution channel | **Not today** | The only third-party surface is the Agent apps marketplace, for data and skills that help a brokerage customer invest. No path to apply is described, and nothing in it could launch or trade a coin on a chain. U: whether Robinhood would list a crypto-token data app at all. |
| A competitor | **No** | It is an assistant for a brokerage customer's own account. It launches nothing, has no token, no public persona and no on-chain treasury. The overlap is the idea only: an agent with a funded, fenced account, approvals and a kill switch. |
| Anything to do with a launchpad on Robinhood Chain | **No** | None of the seven pages mentions Robinhood Chain. The chain's own docs (`docs.robinhood.com/chain`, read the same day) mention no agent product either. |

### 1.3 What is still worth taking from it

1. **A check on Bootr's own model.** Robinhood, a regulated broker, chose the same three controls Bootr already has:
   a separate funded account the agent cannot reach beyond (Bootr: the treasury behind `BootrCallPolicy`), approval
   by default (Bootr: approval mode is the creator's choice), and one-tap disconnect (Bootr: the creator's revoke and
   the guardian). It also states in plain words who is responsible. Bootr's creator-facing copy can be as plain.
2. **One real risk for own agents** (section 8): a creator who runs their Bootr agent in the same AI client that
   holds Robinhood's Trading MCP, with trade approvals off (the default for external agents), has put text written
   by strangers on X into a session that can place brokerage orders. Bootr's MCP server already tells the client
   that a turn's brief governs Bootr's tools only (`packages/mcp`, server instructions). The docs should add one
   line: run the coin's agent in a client or profile that holds no server able to move the creator's own money.
3. **Nothing else.** No interface, address, fee or schedule in this note depends on Robinhood Agents.

### 1.4 Pages read (2026-11-13)

- https://robinhood.com/us/en/support/articles/robinhood-agents-overview/ (the owner's first link)
- https://robinhood.com/us/en/support/articles/trading-with-your-agent/ (the owner's second link)
- https://robinhood.com/us/en/support/articles/onboarding-an-external-agent/
- https://robinhood.com/us/en/support/articles/setting-up-an-agent/
- https://robinhood.com/us/en/support/articles/agent-apps/
- https://robinhood.com/us/en/support/articles/agentic-credit-card/
- https://robinhood.com/us/en/newsroom/robinhood-is-now-open-to-agents/ (2026-05-27; stocks only at launch, crypto
  "coming soon"; crypto is in the help articles today, the date it was added was not confirmed on a Robinhood page, U)

Not read: the token usage billing article, the agentic disclosures and the customer agreements the pages link to.
The pages were read through a fetch tool that returns the page as text; a table's columns can blur in that form, so
which single tools are built-in only is U.

## 2. The chain today

Sources: Robinhood's chain docs (`https://docs.robinhood.com/chain` and the pages named per row, read 2026-11-13) and
the chain itself through the public RPC. "RPC" in the source column means a `cast` read made for this note.

| Fact | Value | Mark, source |
| --- | --- | --- |
| Chain id | 4663 mainnet, 46630 testnet | V, RPC `eth_chainId` = 4663; `/chain/connecting` |
| Stack | Arbitrum Nitro rollup ("Arbitrum Dedicated Blockchains"), node `nitro/v3.12.4-rc.3` built 2026-11-10, ArbOS 61 (`ArbSys.arbOSVersion()` = 116, minus 55) | V, RPC `web3_clientVersion`; `/chain/differences-from-ethereum` |
| Age | Block 1 is stamped 2026-04-30; public mainnet launch 2026-07-01 (the launch date is carried over from the 2026-11-10 note, not re-read) | V block 1, RPC; U launch date |
| Block time | 0.104 s average over the last 1,000,000 blocks: about 10 blocks a second, 830,000 a day. Twice Base's rate. | V, RPC |
| `block.number` inside a contract | The Ethereum block number, not the chain's own: Multicall3 `getBlockNumber()` answered 26,407,805 while the chain was at block 113,560,389. The real height is `ArbSys(0x64).arbBlockNumber()`. `block.timestamp` is normal. | V, RPC; `/chain/differences-from-ethereum` |
| Sequencer | One sequencer, first come first served by arrival time; no priority fee auction, so paying more gas does not jump the queue. The docs do not say who runs it. | V, `/chain/differences-from-ethereum`; U operator |
| Screening | "Sequencer-level screening": a transaction tied to a sanctioned address is left out and never processed. Reads are unaffected. The filtering precompile `0x…0074` exists on chain. The terms add that Robinhood may block wallet addresses. | V, same page; RPC `eth_getCode`; terms section 6 |
| Finality | Soft confirmation from the sequencer in under a second; the batch reaches Ethereum in minutes; Ethereum finality about 13 minutes after that. A withdrawal over the canonical bridge takes about 7 days. | V, `/chain/transaction-finality`, `/chain/bridging` |
| Governance | Security Council of 8 (Robinhood 2 seats; BitGo, Chainlink Labs, Fireblocks, Offchain Labs, Paxos, Talos 1 each): 6 of 8 with a 7-day timelock, 7 of 8 without. Two permissioned validators (Offchain Labs, Alchemy), BoLD disputes. | V, `/chain/governance` |
| Gas token | ETH. Floor price 0.02 gwei (`ArbGasInfo.getMinimumGasPrice()` = 20,000,000 wei); the base fee sat at the floor all evening. | V, RPC |
| Cost of a Clanker v5 launch | 2.49 M to 3.85 M gas = 0.000050 to 0.000078 ETH, **$0.10 to $0.15** (four real launches of 2026-11-12/13) | V, RPC receipts, e.g. tx `0x3dffb97c…5adc6` |
| Cost of a swap on a Clanker v5 pool | 277,000 to 344,000 gas = about 0.0000056 to 0.0000069 ETH, **about one cent** | V, RPC receipts, e.g. tx `0xfd6e8bef…a624` |
| Cost of a Bootr launch (kernel, identity, guardian on top) | Not measured: no Bootr contract exists there. Likely under 6 M gas, under $0.25 at the floor. | I |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com`. Rate-limited with no published figure, "not recommended for production", may be withdrawn without notice. It answered `eth_getLogs` over 3,500,000 blocks for one address and topic in one call. **It is not an archive**: a balance read at block 50,000,000 failed with "historical state … is not available". No public WebSocket RPC is documented; the sequencer feed is `wss://feed.mainnet.chain.robinhood.com`. | V, `/chain/connecting`, terms 2.1, RPC |
| RPC providers | Alchemy (the one Robinhood recommends; HTTP and WebSocket, archive), Chainstack, QuickNode, Blockdaemon, dRPC, Validation Cloud, GlobalStake, Pinax. Prices and `eth_getLogs` limits per plan were not re-read today (the 2026-11-10 note has Alchemy's free tier at 10 blocks per `eth_getLogs`). | V names, `/chain/connecting`; U prices |
| Explorer | Blockscout, `https://robinhoodchain.blockscout.com`; verification with `forge verify-contract --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/`. Its API sits behind a Cloudflare check that refused a plain `curl` today. **Sourcify supports 4663** and holds Clanker's contracts there, so Bootr's Sourcify habit carries over. | V, `/chain/deploy-smart-contracts`; `https://sourcify.dev/server/chains` |
| Bridges in and out | Canonical Arbitrum bridge from Ethereum (about 10 minutes in, 7 days out). Fast routes: Relay, Across, Stargate (LayerZero), Chainlink CCIP, LiFi / 0x. **From Base, measured today**: Relay quotes Base to RH and back in about a second, 5 USDC on Base to 4.97 USDG on RH and 0.005 ETH on RH to 9.65 USDC on Base (0.5% all in; 2.4% on a one-dollar move because of a fee floor near 2 cents). Across lists three routes from RH to Base (USDG to USDC, WETH to WETH, ETH to ETH) through its SpokePool `0xD29C85F15DF544bA632C9E25829fd29d767d7978`, 5 USDG to 4.9937 USDC, minimum deposit about 0.50 USDG. | V, `/chain/bridging`; `https://api.relay.link/quote`, `https://app.across.to/api/suggested-fees` |
| Testnet | Chain 46630 on Sepolia, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com`. No faucet is named in the docs. Whether Clanker v5 is on the testnet was not checked. | V addresses; U faucet, U Clanker |
| Wallets | Robinhood Wallet (iOS, Android) supports it; any EVM wallet by adding the network (MetaMask is the documented example). viem 2.57.10, the version this repository pins, already exports `robinhood` (id 4663, `blockTime: 100`). Whether the Base Account passkey wallet (`apps/web/lib/connectors/base-account`) can sign on 4663 is not known. | V, `/chain/add-network-to-wallet`; V `pnpm-lock.yaml` and viem's `chains/definitions/robinhood.ts`; U Base Account |
| Who may transact | Anyone: the docs call the chain permissionless ("anyone can … deploy smart contracts"). No allow-list, no KYC to send a transaction. The terms exclude sanctioned persons and places and under-18s and forbid hiding one's location with a VPN. They do not exclude US persons. | V, `/chain`, `/chain/terms-of-service` (last updated 2026-08-24) |
| Terms that touch Bootr | (a) No use of the name or marks "Robinhood Chain" in a token issuance or fundraising without written consent (5.11(e)), and none with scam projects (5.7(g)). (b) "Automated tools such as bots, scrapers, or spiders" are listed under network abuse of **the Services**, which are the public RPC, the docs and the sequencer service, not the chain's contracts. (c) Robinhood may block addresses and apps (6). (d) The user alone answers for compliance with law (2.4). (e) Nothing names third-party tokens, launchpads, memecoins or AI agents. | V, same page. Read through a fetch tool, not as the legal text itself: section 9 lists the questions for a lawyer |
| Stock Tokens | ERC-20s with 18 decimals issued by Robinhood Assets (Jersey) Limited as tokenised debt securities; only KYB'd participants mint and burn; **not to be offered or sold to US persons**, with more restricted places. Clanker v5 on RH accepts them as paired assets (section 3). | V, `/chain/stock-tokens`; RPC |

**How busy the chain is (2026-11-13).** DefiLlama shows about $1.03 billion locked on Robinhood Chain and $641 million
of DEX volume in 24 hours, of which Uniswap v3 $255 million and Uniswap v4 $216 million (V that DefiLlama says so,
`https://api.llama.fi/v2/chains` and `/overview/dexs/Robinhood%20Chain`; U the numbers themselves). The chain's own
logs agree on the order of magnitude: the Uniswap v4 PoolManager emitted **44,568 `Swap` events in 60,000 blocks**
(104 minutes), about 7 a second (V, RPC). The PoolManager holds 24,169 ETH and 21.1 million USDG (V, RPC). This is a
chain of stock tokens and dollars, not of small coins: section 9.3 has the numbers for Clanker coins, and they are
tiny.

## 3. What exists there that Bootr depends on

Every address was read on Robinhood Chain on 2026-11-13 (`eth_getCode` for presence, a call for meaning). The Base
column of Bootr's own book is `packages/shared/src/addresses.ts`.

### 3.1 Clanker

| Piece | On Robinhood Chain | Mark and what was read |
| --- | --- | --- |
| v5 factory `TaxRWAERC20LaunchpadFactory` | `0xcA111dcdd2cE924c3378d6514fDCbC46217bcA16` | V. 23,776 bytes. `owner()` = `0x87f4aa83ff26e91237a1a99b0555C616c159aF15` (the same owner as on Base), `launchCreationEnabled()` = true, `configVersion()` = **12** (Base had 23 on 2026-11-10), `nativeLaunchFee()` = 0, `launchSupply()` = 1e27, `tickSpacing()` = 200, `poolManager()` = the Uniswap v4 PoolManager below |
| v5 hook `TaxLaunchHook` | `0x565189a6780D1a50FC1792F64db8e4881119AaCC` | V. `factory.hook()` returns it; `hook.feeEscrow()` and `hook.launchBuyAdapter()` match the rows below |
| v5 `FeeEscrow` | `0xFBB6e837A2eA96d6b4beb4788c2749Cf34A997e7` | V. `escrow.hook()` = the hook |
| v5 token deployer | `0xE76c413b26c7006CF3ac747b46A8F05E0Ccf3287` | V. `factory.tokenDeployer()`. The `cccc` salt is mined against this address, so a coin's address differs from any Base coin's |
| v5 launch-buy adapter | `0xB23DCEC5F77abC6185c6a1535F1662A37e578689` | V. `factory.launchBuyAdapter()` |
| Announcement registry, validation, operations, dividends | `0x2D75afC0Cdf502E4381dC0B23327BFeD358bA43A`, `0xCB4530728c259a0f23193f5C13c2061b46fe4288`, `0x533179dF1316420a83C20e6bd6EC092Ae82aa967`, `0xffe2627E9b89E1eD4a777488c8597a3912c46723` / `0xdb525d50c70b9303115bA19503761756136d2B49` / `0x4305A1858E9E532349661a89f462d1248045Ed95` | V the registry (`factory.announcementRegistry()`); the rest from Clanker's page only, https://clanker.gitbook.io/documentation/references/deployed-contracts |
| **Same code as Base?** | Yes | V. Sourcify holds the factory, the hook and the escrow for 4663 (verified 2026-11-05) and for 8453; for each of the three, the full set of source files hashes the same on both chains (65, 44 and 17 files, compiler 0.8.26). This was "U" on 2026-11-10 |
| Tax policy | buy and sell 1% to 10%; Clanker's share 10% of the tax, never under 0.5% nor over 1% of the trade; fee recipient `0x7a2E54E3aa9C4D02F6C9B950DcD33054D2043829`; sniper window 99% falling over 20 s; dividend floor 1e22 | V, `taxPolicy()`. Identical to Base's of 2026-11-10 |
| Paired assets | Native ETH: registered, 18 decimals, start tick −200,400 (about 1.98 ETH for the whole supply, **about $3,800 opening cap**). USDG: registered, 6 decimals, start tick −400,600 (about 4,000 USDG). WETH: not registered. **Stock tokens are registered too**: launches paired with AAPL, NVDA, TTWO, AAOI and ASML exist | V, `quoteConfig(address)` and the factory's `Launched` logs. The ETH start tick differs from Base's (−201,000): Clanker sets it per chain |
| MEV / sniper module | None separate on v5: the hook's own 20-second surcharge. On this chain the sequencer is first come first served, so the surcharge is the only defence, and it bites: 4 sniped buys paid 0.0989 ETH of surcharge, more than all other v5 fees there put together | V, hook `AntiSnipeFeeCredited` logs |
| v4.1 | Clanker `0xD3f2cC1731b7Fd17f28798835C2E02f0a1839A94`, fee locker `0x88db2340bE5991B2b5Fca2Baee39B5CE048Cd70c`, locker `0xE4910b09709423aFafD995dD76D8A81CF9134A09`, hooks, vault, airdrop, dev buy | V presence of the first two; the list from Clanker's page. Bootr's v4 wrapper is paused on Base and has no reason to exist here |

### 3.2 Uniswap, wrapped ETH, dollars, price feed

| Piece | On Robinhood Chain | Mark and what was read |
| --- | --- | --- |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | V. 24,009 bytes; the Clanker factory points at it |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` (the one in Uniswap's v4 table, and the executor of 154 of the 267 Clanker v5 trades) and `0x204FAca1764B154221e35c0d20aBb3c525710498` (v2.1.2, the "latest" in Uniswap's deployment file) | V both have code. The web's swap builder must be tested against the one it picks |
| v4 Quoter, StateView, PositionManager | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`, `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`, `0x58daec3116aae6d93017baaea7749052e8a04fa7` | V code for the first two; https://github.com/Uniswap/contracts `deployments/json/4663.json` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | V, the canonical address |
| Uniswap v3 | Factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2`, QuoterV2 `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` | V. `SwapRouter02.factory()` and `.WETH9()` return the factory and WETH below. This was "U" on 2026-11-10. Base's addresses (`0x2626…e481`, `0x3312…FDfD`) have no code here |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, 18 decimals | V. Not the OP-stack address `0x4200…0006`, which is empty here |
| USDG ("Global Dollar", Paxos) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, **6 decimals**, 630 million in supply, a proxy | V. It has EIP-3009 (`TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` is the standard hash), so x402's `exact` scheme can move it. It has `isFrozen(address)`: **the issuer can freeze an address** |
| Other dollars | USDe (Ethena), about $363 million there; no Circle USDC, no USDT | V that DefiLlama lists only these, `https://stablecoins.llama.fi/stablecoins`; Base's USDC address is empty here; Across maps USDG on RH to USDC on Base |
| WETH / USDG liquidity (Uniswap v3) | 0.01% pool `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca`: 6,108 WETH and 1.26 million USDG. 0.05% pool `0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a`: 1,408 WETH and 0.40 million USDG. 0.3% and 1% pools exist and are thinner | V, `factory.getPool`, balances. Deep enough for the dev-buy route and for a treasury swap of a few dollars |
| Chainlink ETH / USD | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, 8 decimals, `description()` = "ETH / USD", answer 1,935.63, last update 50 minutes before the read | V. 24-hour heartbeat and 0.5% deviation per the 2026-11-10 note, not re-read. `BootrSwapHelper` refuses a price older than 1 hour (`MAX_PRICE_AGE`), which on a calm day this feed will be: see section 6.7 |

### 3.3 Accounts, identity, tooling

| Piece | On Robinhood Chain | Mark and what was read |
| --- | --- | --- |
| ERC-4337 EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | V, 16,035 bytes. v0.6, v0.8 and v0.9 are there too |
| Bundlers and paymasters | Alchemy ("powers" account abstraction there, with a gas manager), ZeroDev (`https://rpc.zerodev.app/api/v3/<project>/chain/4663`), Pimlico (bundler and paymaster for v0.6, v0.7, v0.8). **No bundler usable without an account** was found. Coinbase CDP, Bootr's bundler on Base, is not there | V, `/chain/account-abstraction`, https://docs.pimlico.io/guides/supported-chains, https://docs.zerodev.app/api-and-toolings/faqs/chains |
| ZeroDev Kernel v3.1 | Implementation `0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D`, factory `0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419`, meta-factory `0xd703aaE79538628d27099B8c4f621bE4CCd142d5`, ECDSA validator `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57`, ECDSA signer `0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF` | V, all five at Base's addresses. `kernelFactory.implementation()` = the implementation, `metaFactory.approved(kernelFactory)` = true, `implementation.entrypoint()` = EntryPoint v0.7 |
| ZeroDev policies | call `0x85770b902D1e503D5f5141d9eaC16d0d08eEaDd2`, gas `0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23`, rate limit `0xf63d4139B25c836334edD76641356c6b74C86873`, sudo `0x67b436caD8a6D025DF6C82C5BB43fbF11fC5B9B7`, timestamp `0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F`, signature `0xF6A936c88D97E6fad13b98d2FD731Ff17eeD591d` | V, all six have code at Base's addresses. Not compared with Base byte for byte (U) |
| ERC-8004 identity and reputation | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | V. Same addresses as Base. `name()` = "AgentIdentity", `symbol()` = "AGENT", `getVersion()` = "2.0.0", `reputation.getIdentityRegistry()` = the identity registry. The highest existing agent id is **25,717**. This was "U" on 2026-11-10 |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | V, 3,808 bytes |
| CREATE2 deployers | Arachnid `0x4e59b44847b379578588920cA78FbF26c0B4956C`, CreateX `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`, Safe singleton factory `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` | V, all three |
| Base B20 precompile and RWAGMI | Nothing at `0xB20f000000000000000000000000000000000000`, nothing at the RWAGMI launcher, hook or locker addresses | V absent. **The RWAGMI path cannot exist on this chain.** `BootrLauncher` and `BuybackBurner` stay on Base |
| Bootr's own contracts | Nothing at the Base addresses of the guardian or the call policy | V absent, as expected |

### 3.4 Paying for thinking

| Piece | State | Mark, source |
| --- | --- | --- |
| BlockRun (where hosted agents buy thoughts) | Takes USDC on Base and on Solana, on Arc, and batched through Circle Gateway. Not Robinhood Chain, not USDG | V, https://blockrun.ai/x402 , https://blockrun.ai/docs/x402/how-it-works |
| Coinbase CDP x402 facilitator (what BlockRun and Bootr's relay settle through) | Base, Polygon, Arbitrum, Monad, World, Solana. Not 4663 | V, https://docs.cdp.coinbase.com/x402/network-support |
| An x402 facilitator for USDG on 4663 | Only community software: an npm package `hood402-facilitator` and a few small marketplaces say they settle USDG on 4663 with a facilitator the operator runs. No facilitator run by a known company | U, found by search, none of it tested or read in source |
| A seller of model inference payable on 4663 | None found | U (absence is hard to prove) |
| Paid x402 services in general (`discover_services`) | The discovery list Bootr reads is CDP's (`X402_DISCOVERY_URL`, `apps/supervisor/src/config.ts`), and it lists sellers on CDP's networks | V for the code; I that no 4663 seller appears in it |

**The blockers, in one place.** Everything the launchpad needs exists on Robinhood Chain: Clanker v5 with the same
code, Uniswap v4 and v3, WETH, a deep dollar, a price feed, Kernel, the EntryPoint, the identity registry. What does
not exist: (1) Circle USDC, (2) a seller of thinking and a known x402 facilitator, (3) Coinbase CDP as bundler and
RPC, (4) Base builder codes, (5) RWAGMI and the B20 precompile, (6) a free archive RPC. None of them stops a launch,
a trade or a fee claim. (1) and (2) together decide how an agent there pays for its thoughts, which is section 6.5.

## 4. Launch through Clanker v5 there, or through Bootr's own launcher

The owner leans towards an own launcher: like Clanker's, built to be extended for agent features, with a launched
coin's economics fixed for good and only the agent modules open to extension. This section compares the two honestly
and ends in a recommendation; the choice is decision 1 in section 11.

### 4.1 What "through Clanker v5" means on Robinhood Chain

`BootrClankerLauncherV5` (`packages/contracts/src/BootrClankerLauncherV5.sol`) deployed again with Robinhood Chain's
addresses as constructor arguments. Nothing in the contract names a chain: the factory, hook, escrow, WETH, Uniswap v3
factory, the dollar token, the identity registry, the Kernel factory, the guardian and the gate are all immutables
set at deploy, and no Bootr contract reads `block.number` (V, a search of `packages/contracts/src`). The Clanker
contracts it calls are the same source on both chains (section 3.1). The work is a deploy script, the allow-list of
paired assets (ETH and USDG), the dev-buy route (the WETH/USDG 0.01% or 0.05% Uniswap v3 pool) and fork tests.

What the coin's creator, the agent and Bootr get per $100 of trading at Bootr's default tax of 1.5%
(`docs/design/clanker-v5-token-settings.md` section 2.3; Clanker's floor of 0.5% of the trade binds at any tax up to
5%):

| Who | Share | Per $100 traded |
| --- | --- | --- |
| Clanker | 0.5% of the trade, a third of the tax | $0.50 |
| Creator and their reward rows | 65% of the rest | $0.65 |
| Bootr (platform slot) | 30% of the rest | $0.30 |
| The agent | 5% of the rest | $0.05 |

Clanker earns more from a Bootr coin than Bootr does, and ten times what the agent does. On Robinhood Chain so far the
real split was harsher: of all quote-side fees Clanker v5 pools took in ETH there since 2026-11-05, 0.0291 ETH went to
creators' slots, 0.0091 ETH to Clanker as its share and 0.0989 ETH to Clanker as sniper surcharge (V, the hook's
`CreatorTaxCredited`, `ProtocolFeeCredited` and `AntiSnipeFeeCredited` logs).

### 4.2 What an own launcher would be

Three contracts that replace Clanker's three, behind the launch gate Bootr already has:

| Contract | Job | Changeable after a coin's launch |
| --- | --- | --- |
| Factory | One call: creates the coin (fixed supply, no owner), opens the Uniswap v4 pool on the hook at an opening price, seeds the whole supply as locked one-sided liquidity, writes the coin's terms, then does what today's wrapper does (Kernel, identity, guardian through `BootrLaunchGate`) | Nothing for that coin. The owner can change defaults and the paired-asset list for **later** launches only, each change bumping a config version, the way Clanker's `configVersion` works |
| Hook | Holds every coin's liquidity for good. On each swap takes the coin's buy or sell tax in the paired asset and credits the coin's fee slots; a falling surcharge in the first seconds against snipers | Nothing: tax, slots' weights, surcharge and paired asset are read from the coin's stored terms, and no function writes them |
| Fee escrow | One balance per recipient and asset; `claimFor(recipient, asset)` callable by anyone, paying only the recipient | Nothing |

**Where "extensible for agents" lives: not in the pool.** A coin's terms hold no address that can be swapped later. The
agent's abilities are on the account side, where Bootr already put them: the Kernel treasury, `AgentGuardian`,
`BootrCallPolicy` and the helper contracts a session key may call (`BootrSwapHelper` today; the Trade helper, Bounties
and the fuel bridge of section 6.5 next, each behind a UUPS proxy as decided on 2026-11-08,
`docs/design/agent-capabilities.md` section 4). A new agent feature is a new module plus a new rule in the agent's
session key, installed by a key rotation. It never touches the coin, its pool or its fees. So the owner's two
conditions hold by construction: the economics are frozen in the hook, the agent grows through modules. The only tie
between the two halves is one fee slot whose recipient is the agent's treasury, fixed at launch.

What it would add over Clanker:

1. **The third of the tax that goes to Clanker stays in Bootr's economy.** At the same 1.5% to the trader, the agent's
   share could be $0.55 per $100 instead of $0.05, or the tax could drop to 1%, or the platform could take it. A
   launch-time choice, then frozen.
2. **The opening price is Bootr's.** Clanker sets one start tick per paired asset per chain (about $3,800 on Robinhood
   Chain today); Bootr's RWAGMI path opens near $6,000 by choice.
3. **One launcher on every chain**, including chains Clanker is not on, and no dependence on Clanker keeping launches
   switched on (`launchCreationEnabled`) or its policy.
4. **Events written for Bootr's indexer** (amounts and price in the hook's own event), so the indexer never needs the
   PoolManager's stream (section 6.9).
5. **Room for agent coins that pay their fees in the fuel asset**: on Robinhood Chain, USDG; Clanker v5 already allows
   USDG, so this is not exclusive to an own launcher.

What it would cost:

1. **It becomes the riskiest contract Bootr owns.** The hook custodies the liquidity of every coin launched through
   it. A bug there is a loss for every coin at once, and the design promises nobody can fix a coin's pool afterwards.
   Today that risk is Clanker's and RWAGMI's.
2. **Time.** A fork of Clanker's tax suite is the realistic start: its own files (hook, fee math, token, escrow) are
   MIT-licensed (V, SPDX lines of the verified sources); two Uniswap v4-core library files in the verified set are
   BUSL-1.1 (V), which needs a check before copying. Estimate: 3 weeks to write and test on both chains, then an
   outside review before any coin with real money, which Bootr does not control the calendar of. No quote was
   obtained (U).
3. **No listing on clanker.world**, no `cccc` address, and whatever trading tools recognise Clanker pools by their
   hook will not recognise Bootr's (U which do on Robinhood Chain).
4. **A second kind of coin forever.** Coins already launched through Clanker keep their terms. The indexer, the
   supervisor's claim path and the trade panel carry one more `LaunchSource` (`apps/supervisor/src/chain.ts`), which
   they are built for.

### 4.3 Side by side

| | Clanker v5 wrapper | Own launcher |
| --- | --- | --- |
| New contract code | A deploy script | Factory, hook, escrow, token: new, custody of all liquidity |
| Ready to deploy on Robinhood Chain | About a week with fork tests | About 3 weeks plus an outside review |
| Who can stop new launches | Clanker's owner, or Bootr's (pause) | Bootr's owner |
| Who takes the protocol share | Clanker: at least 0.5% of every trade | Bootr decides at design time |
| Opening price | Clanker's, per asset per chain | Bootr's |
| Coin's economics after launch | Frozen (Clanker's design) | Frozen (Bootr's design) |
| Agent features | In the account layer, same as below | In the account layer |
| Audience it brings on Robinhood Chain | Almost none: 93 coins and 267 trades in 8 days (section 9.3) | None by itself |
| Same on Base | Live since 2026-11-11 | Would be new there too |

### 4.4 Recommendation

**Build both, in this order: open Robinhood Chain on the Clanker v5 wrapper, and start the own launcher at once as its
own track for both chains.** The reasons:

- The wrapper is reviewed code calling contracts that are byte for byte the reviewed ones. It lets Robinhood Chain
  open as soon as the plumbing is done.
- Nine tenths of the work in this note is that plumbing (address book, indexer, supervisor, web, fuel), and it is
  the same whichever launcher sits on top. Doing it first loses nothing.
- The own launcher deserves its own design note, its own fork tests on two chains and an outside review. Tying the
  opening of a chain to that calendar puts pressure on the one contract that must not be rushed.
- When it is reviewed, it becomes one more launcher on `BootrLaunchGate`, the default on the launch page, on both
  chains; the Clanker path can stay as a choice or be paused, as the v4 wrapper was.

The honest argument for the other order, the owner's leaning: Clanker brings no audience on Robinhood Chain, and every
coin launched through it pays Clanker a third of its tax for good. If the owner would rather have every Robinhood
Chain coin on Bootr's own terms from the first day, the price is opening about four to six weeks later. Section 10
gives both orders.

## 5. Every Base-only assumption in the code

Read at `d8927cb`. **Kind**: C = a value that needs an entry per chain; L = logic that must change; W = words only.
Paths are from the repository root.

### 5.1 Contracts (`packages/contracts`)

| File | What it assumes | Kind | What a second chain needs |
| --- | --- | --- | --- |
| `src/*.sol` | Nothing about a chain: every outside address is a constructor immutable; no `block.number`; time is `block.timestamp` everywhere (dormancy, policy windows, price age) | none | Redeploy with the chain's addresses. Same source, so the same review holds for the logic |
| `src/BootrClankerLauncherV5.sol` (`usdc`, `fuelUsdc`, line 501) | The launch pulls `fuelUsdc` of "USDC" from the creator into the kernel as thinking fuel | L | On RH the immutable would be USDG, which pays for no thought (section 6.5). The form must send `fuelUsdc = 0` there, and the docs must not call it fuel |
| `src/BootrSwapHelper.sol` (`MAX_PRICE_AGE = 1 hours`, the `1e20` divisor) | A Chainlink ETH/USD feed that updates within the hour; a 6-decimal dollar; a Uniswap v3 WETH/dollar pool at an immutable fee tier | C, L | USDG has 6 decimals, the pools exist. The feed's heartbeat is 24 h (U, 2026-11-10 note): a stale price makes the helper revert on calm days, so the age limit must become a constructor argument, or the helper there reads a second source |
| `src/BootrLauncher.sol`, `src/BuybackBurner.sol` | RWAGMI v3 and the Base B20 precompile `0xB20f…0000` | L | Not deployed on RH: neither exists there (section 3.3) |
| `src/BootrClankerLauncher.sol` (v4) | Clanker v4 with the MEV modules of Base | none | Not deployed on RH (paused on Base too) |
| `script/Deploy.s.sol`, `DeploySwapHelper.s.sol` (`chainConfig()`), `DeployClankerLauncherV5.s.sol` (`require(block.chainid == 8453)`, constants `FACTORY`, `HOOK`, `FEE_ESCROW`, `WETH`, `USDC`, `UNISWAP_V3_FACTORY`, `WETH_USDC_500`), `DeployClankerLauncher.s.sol`, `DeployCallPolicy.s.sol` | Base and Base Sepolia only; Base addresses as constants | L | A deploy script for 4663 with the addresses of section 3: guardian, gate, call policy, swap helper, v5 launcher. No RWAGMI launcher, no burner |
| `foundry.toml` (`[rpc_endpoints]`, `[etherscan]`) | `base`, `base_sepolia`, Basescan keys | C | A `robinhood` endpoint; verification through Sourcify and Blockscout, no Etherscan key |
| `test/fork/*.t.sol`, `test/security/*.t.sol` (`vm.createSelectFork(vm.envOr("BASE_RPC_URL", "https://mainnet.base.org"))`) | A Base fork; Base addresses in the test constants | L | Fork tests on a 4663 fork (`ROBINHOOD_RPC_URL`): the v5 launcher's launch, dev buy over the USDG route, claim, the session-key and guardian suites. A fork of an Arbitrum chain reports its own block number where the live chain reports Ethereum's; Bootr's contracts do not read it, and whether Clanker's or Uniswap's paths do on a fork is U until the tests run |
| `evm_version = "cancun"`, solc 0.8.26 | Cancun opcodes | none | Clanker's own contracts there are 0.8.26 too (V, Sourcify); Bootr's bytecode was not tried on 4663 (U) |

### 5.2 Shared (`packages/shared`)

| File | What it assumes | Kind | What a second chain needs |
| --- | --- | --- | --- |
| `src/addresses.ts` (`SupportedChainId = 8453 \| 84532`, `getAddresses` throws otherwise) | Two chains | L | A 4663 entry and a wider type |
| same (`ChainAddresses`: `rwagmi*: Address \| null`, `clanker` required, `usdc`, `uniswap.swapRouter02`) | Every chain has Clanker v4 and "Circle USDC" | L | `clanker` nullable; a neutral name for the dollar (`dollar: {address, symbol, decimals}`) next to `usdc`, since half the code means "the fuel asset" and half means "the chain's dollar"; the v4 Quoter and StateView in the book (they sit in `apps/web/lib/swap/core.ts` today); the ETH/USD feed in the book (it sits in two apps today); chain facts: name, explorer, block time, native symbol |
| `src/config.ts` (`chainIdSchema` refuses anything but 8453 / 84532) | Two chains | C | Admit 4663 |
| `src/fuel.ts`, `src/workers.ts` | USDC, 6 decimals, as the unit of fuel and caps | none | Holds: fuel stays Base USDC (section 6.5) |

### 5.3 Indexer (`apps/indexer`)

| File | What it assumes | Kind | What a second chain needs |
| --- | --- | --- | --- |
| `ponder.config.ts` (`chains: { [chain]: … }`, types `base` / `baseSepolia`; "Single-chain config selected by CHAIN_ID") | One chain per process | L | A second process with `CHAIN_ID=4663`, or two chains in one config (section 6.1 says why not) |
| `src/lib/env.ts` (`chainId: 8453 \| 84532`, `chainName`, an unknown `CHAIN_ID` falls back to 84532 with a warning; `CHAINLINK_ETH_USD`, `PUBLIC_RPC`, `RWAGMI_V3`, `CLANKER_V4`, `CLANKER_V5`, `BOOTR_DEPLOY_BLOCK` keyed by chain; `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL`) | Base's two ids and their tables | C, L | 4663 rows (feed `0x78F3…d3A9`, the v5 stack of section 3.1, RWAGMI and v4 null), an RPC variable that is not named after Base, and no silent fallback to Sepolia |
| `src/lib/blocks.ts` (`BLOCK_SEC = 0.2`, `DENIM_FIRST_BLOCK`, `DEFAULT_SNAPSHOT_INTERVAL = 300`) | Base's block time and its Denim fork | L | Block time per chain: 0.1 s on RH, so one snapshot a minute is every 600 blocks |
| `rpc-budget.ts` (`CDP_BU_PER_SECOND`, the billing-unit table) | Coinbase CDP as the RPC, priced in billing units | L | A budget in the unit of the provider chosen for RH, or none; the file sits outside `src/`, so it needs no schema bump |
| `ponder.config.ts` (`PoolManager` source with no filter) | Reading every Uniswap v4 swap on the chain is affordable | L | Not on RH: about 7 v4 swaps a second there (section 2). The hook-based read must come first (section 6.9) |
| `ponder.schema.ts` (`token.id` = address, `agent.id` = kernel address, `agent_identity.id` = the ERC-8004 number, `platform_stats`, `daily_stat`, `price_feed` as single rows) | One chain per schema: no key carries a chain id (only `token.chainId` is a column) | L | One schema per chain keeps this true. In one shared schema the ERC-8004 number, the platform rows and possibly a kernel address would collide |
| `src/snapshot.ts`, `src/lib/balances.ts`, `src/lib/status.ts` (`MIN_FUNDED_USDC`) | The agent's fuel is USDC **on the indexed chain**: the kernel's and the spender's balance are read in the same multicall, and under 1 USDC the agent shows as sleeping | L | On RH the spender's fuel is on Base. The status must take fuel from a Base read (a second client in the snapshot, or the supervisor's figure) or every RH agent shows as sleeping |
| `src/launcher.ts` (`frameTick = quote.symbol === 'USDC' ? -400_600 : -201_000`; the fuel transfer replay keyed on `env.addresses.usdc`), `src/lib/quote.ts` (`QuoteSymbol = 'WETH' \| 'ETH' \| 'USDC' \| '?'`), `src/lib/price.ts` | ETH and USDC are the only paired assets; Clanker's Base start ticks | C, L | USDG as a 6-decimal dollar quote; RH's ETH start tick is −200,400; better, read the tick from the factory at the launch block |
| `src/lib/store.ts` (Chainlink read at the event's block), `src/launcher.ts` (`readContract` at launch blocks) | The RPC serves state at past blocks during a backfill | L | The public RH RPC does not (section 2). The RH indexer needs an archive endpoint for any backfill older than what the node keeps |
| `src/api/*` | One chain per API host; rows carry no chain except `token.chainId` | L | Each API answers for its chain and says which (`chainId` on every list); the web merges (section 6.2) |

### 5.4 Supervisor (`apps/supervisor`)

| File | What it assumes | Kind | What a second chain needs |
| --- | --- | --- | --- |
| `src/config.ts` (`CHAIN_ID` 8453 / 84532; `BASE_RPC_URL`; one `BUNDLER_URL`, `PAYMASTER_URL`; one `LAUNCHER_START_BLOCK`; one set of launcher, guardian, locker addresses) | One chain per process | L | Per-chain blocks of settings (RPC, bundler, launchers, guardian, start block) |
| `src/chain.ts` (`ChainContext.chainId: 8453 \| 84532`, `chainFor` returns `base` or `baseSepolia`, `CHAINLINK_ETH_USD` map, `rwagmi` and `clanker` required) | One `ChainContext`, on Base | L | One context per chain; `rwagmi` and `clanker` nullable |
| `src/context.ts` (`SupervisorContext.chain`, `.indexer`), about 90 uses in `onboarding.ts`, `treasury.ts`, `services.ts`, `blockrun.ts`, `broker/index.ts`, `bounties.ts`, `api.ts`, `tick.ts`, others | "The chain" is one thing: where the coin lives and where the agent pays | L | Two notions: the agent's **home chain** (coin, kernel, fees, gas) and the **pay chain** (Base, where the spender holds USDC). A context derived per agent keeps most call sites as they are (section 6.1) |
| `src/db/schema.ts` (`sv_agents.agent_id` primary key = the ERC-8004 number as text; some twenty tables keyed by it; `sv_cursors` with one launch cursor) | An ERC-8004 number names one agent | L | The number is per chain: RH's registry is at 25,717 and counts on its own. RH agents get the id `4663:<number>`; Base ids stay bare (section 6.2). A launch cursor per chain |
| `src/spender.ts` (`keccak256(master, agentId)`) | The id is unique | L | Holds once ids are namespaced. Base ids must not change: the spender's address is derived from the id string |
| `src/blockrun.ts`, `src/inference.ts`, `src/services.ts`, `src/fuel.ts`, `src/images.ts` (`eip155:${ctx.chain.chainId}`, `ctx.chain.addresses.usdc`, the spender's balance on `ctx.chain.publicClient`) | Payment happens on the agent's own chain | L | These read the pay chain (Base) for every agent |
| `src/kernel.ts` (`bundlerUrl`), `src/entrypoint.ts` (`SELF_BUNDLE_GAS`), `ENABLE_MODE_SELF_BUNDLE` | A CDP bundler for ordinary ops; the admin key self-bundles enable-mode ops | C, L | A bundler account on RH (ZeroDev, Pimlico or Alchemy), or self-bundling of every op there by a key with no other power (section 6.6) |
| `src/gas.ts` (`GAS_MIN_WEI` 0.0002 ETH, `GAS_TARGET_WEI` 0.001 ETH) | Base's gas price | C | Per chain. At RH's 0.02 gwei floor the same thresholds are generous; keep them until measured |
| `src/treasury.ts` (`BLOCKS_PER_SECOND = 5n`, `LANDED_SCAN_BLOCKS`), `LAUNCH_LOG_CHUNK_BLOCKS` default 2000 | Base's 200 ms blocks | C | 10 blocks a second on RH; a larger log chunk |
| `src/session-rules.ts`, `src/session-key.ts` (targets from the address book: escrow, WETH, swap helper, USDC, call policy) | The Base contracts | C | The RH addresses; the same layout 5 for a v5 coin. The funding rule (`USDC.transfer(spender, …)`) has no use on RH until the fuel bridge exists |
| `src/coin-fees.ts` (`USDC_ADDRESSES` from 8453 and 84532), `src/coin-reader.ts`, `src/launch-source.ts` | Fees are ETH, WETH or USDC | C | USDG as a fee asset |
| `src/builder-codes.ts`, `BUILDER_CODES_URL` (`api.base.dev`) | Base builder codes on every session op | L | Off for RH agents: a Base programme |
| `src/activity.ts:55`, `src/bounties.ts:195` (`basescan.org/tx/…`) | Basescan links | C | The explorer per chain |
| `X402_DISCOVERY_URL` (CDP), `src/services.ts` (`network === eip155:<chainId>`, asset = USDC) | Sellers on the agent's chain | L | Sellers on the pay chain (Base), for every agent |
| `apps/supervisor/src/indexer-client.ts`, `platform-feed.ts`, `platform-numbers.ts` | One indexer | L | An indexer per chain; the platform agent's digest reads both |

### 5.5 Sender and inference relay

| File | What it assumes | Kind | What a second chain needs |
| --- | --- | --- | --- |
| `apps/sender/src/db/schema.ts` (`sender_accounts.agent_id` primary key, quotas, inbox by `agent_id`) | The id is unique | none | Nothing once the supervisor sends namespaced ids: the sender never touches a chain (no chain id anywhere in `apps/sender/src`) |
| `apps/inference/src/config.ts` (`X402_NETWORK` is `eip155:84532` or `eip155:8453`; CDP facilitator), `src/client/x402-payer.ts` | Payment on Base through CDP | none | Stays as it is: the relay (pictures) keeps being paid on Base |

### 5.6 Web (`apps/web`)

| File | What it assumes | Kind | What a second chain needs |
| --- | --- | --- | --- |
| `lib/env.ts` (`NEXT_PUBLIC_CHAIN_ID` → `chainId: 8453 \| 84532`, one `indexerUrl`, one `rpcUrl`), `AppChainId` | One chain per build | L | A list of live chains, an indexer URL and an RPC per chain |
| `lib/chains.ts` (`appChain`, `isMainnet`, `chainLabel`, `explorerBase`, `dexscreenerUrl` → `/base/`, `swapLink` → `?chain=base`, `clankerWorldUrl`) | Base names and links | C | Per chain: label, Blockscout links, DexScreener slug, clanker.world path (U for RH) |
| `lib/wagmi.ts` (`chains: [primary, secondary]` of Base and Base Sepolia; Base Account connector first) | Wallets on Base | L | `robinhood` in the chain list with its transport; the Base Account entry hidden or marked where it cannot sign (U) |
| 112 uses of `env.chainId`, `appChain`, `isMainnet`, `chainAddresses()` in 29 files, most in `components/launch/LaunchForm.tsx` (19), `components/console/ConsoleView.tsx` (14), `PlatformFees.tsx`, `use-clanker-fees.ts`, `ConnectButton.tsx`, `CreatorFees.tsx`, `use-gas.ts`, `V5MetadataForm.tsx`, `FuelForm.tsx`, `GasForm.tsx` | The deployment's one chain | L | The chain of the coin on screen, or the one chosen in the launch form |
| `lib/swap/core.ts` (`const A = addresses[8453]`, `SWAP_CONTRACTS = { chainId: 8453, quoter, stateView, … }`), `lib/swap/quote.ts`, `use-swap.ts` | The trade panel's contracts are Base's | L | The four addresses per chain (section 3.2), the pool key from the coin's chain |
| `lib/token-settings.ts` (paired assets: ETH with `fallbackStartTick: -201_000`, USDC at `addresses[8453].usdc`), `lib/v5-launch.ts`, `lib/clanker-v5.ts` | Base's two paired assets and start ticks | C | Per chain: ETH (−200,400) and USDG on RH |
| `lib/server/quote-market.ts` (`…/api/tax/quote-market?chainId=8453`) | Clanker's Base market data | C | `chainId=4663` (U that the endpoint answers for it) |
| `lib/contracts.ts` (`clankerFeeLocker` only when `env.chainId === 8453`), `components/launch/LaunchForm.tsx:567` and `app/api/agent/launch/route.ts:241` (fallback `addresses[8453].clankerV5`) | Base | C | The chain's own entries |
| `lib/server/chain.ts` (`ServerChainId = 8453 \| 84532`, `BASE_RPC_URL`), `lib/server/siwe-verify.ts` (`msg.chainId !== env.chainId`), `app/api/siwe/verify/route.ts:65` (8453 or 84532) | Sign-in messages name Base | L | Accept the live chains; a creator's signature is checked on the chain of the coin it is about |
| `app/api/agent/launch/route.ts`, `app/api/agent/claim/[id]/route.ts`, `app/api/catalog/route.ts`, `app/api/agent/[kernel]/*` | One chain behind every route; a kernel address or a coin address names an agent | L | A `chainId` in the launch body and in the answers; lookups by address ask the right indexer (section 6.2) |
| `lib/server/supervisor.ts:446` (a `txUrl` is kept only if it matches `basescan.org/tx/…`) | Basescan | L | The explorer of each live chain |
| `components/token/FuelForm.tsx`, the launch form's fuel step | Fuel is USDC sent to the kernel on the coin's chain | L | For an RH coin: USDC on Base to the agent's spender (section 6.5) |
| `components/docs/content.ts` (10 places: "Base mainnet (chain id 8453)", Basescan links, `RPC=https://mainnet.base.org`), `lib/skill/skill-md.ts` (7 places, `import { base } from 'viem/chains'`), `lib/docs/markdown.ts`, `components/docs/pages.ts`, `agent-tools.ts`, `lib/agent-card.ts:97`, `components/shell/ConnectButton.tsx` (Base mark) | "On Base" | W | "On Base and Robinhood Chain", with the per-chain tables |

### 5.7 Packages (`packages/sdk`, `cli`, `mcp`, `agent-core`)

| File | What it assumes | Kind | What a second chain needs |
| --- | --- | --- | --- |
| `packages/agent-core/src/types.ts:168` (`token.chainId` is 8453 or 84532) | Two chains | C | Admit 4663 |
| `packages/agent-core/src/prompt/system-prompt.ts` (lines 60, 226, 231: "Your treasury lives on Base at …", "keeper of the treasury of … on Base"; line 164 "another agent project on Base") | The agent is told it lives on Base | L | The chain's name from the config. The social prompt is pinned byte for byte by a test (`docs/STATUS.md` section 3 item 2), so Base agents' text must come out unchanged |
| `packages/agent-core/src/social/post-validation.ts:56` (`PLATFORM_LINK_HOSTS` has `basescan.org`, `clanker.world`, `dexscreener…`), `social/disclosure-policy.ts:96` (`EXPLORER_TX_LINK` matches Basescan) | Links an agent may post | C | Add `robinhoodchain.blockscout.com` |
| `packages/agent-core/src/models/catalog.ts`, `inference/request.ts` | Prices in micro-USDC | none | Holds |
| `packages/sdk/src/terms.ts` (`KNOWN_ASSETS`: ETH, Base WETH, Base USDC, "on Base (8453)"), `src/types.ts` (five `chainId: number` fields already), `src/client.ts` | One API base URL, Base's assets | C, L | Assets per chain (RH WETH, USDG); the catalog names the chains; calls that take a coin take its chain |
| `packages/mcp/src/index.ts:17` (instructions open "Bootr is a launchpad on Base"), `src/tools.ts` (9 places), `packages/cli/src/commands.ts` (7 places) | Base in tool descriptions and output | W, L | The words; a `chain` argument on `bootr_prepare_launch`, `bootr_search_coins`, `bootr_coin_market`, `bootr_prepare_claim` and the swap tool of `agent-tools-2.md` |

### 5.8 Deploy and docs

| File | What it assumes | Kind | What a second chain needs |
| --- | --- | --- | --- |
| `docker-compose.coolify.yml` (one `indexer`, `CHAIN_ID: ${CHAIN_ID:-8453}`, `BASE_RPC_URL`, `DATABASE_SCHEMA`; `mem_limit`s summing to 5.5 GB) | One chain; a 7.6 GB server | L | A second indexer service with its own schema variable and memory; new variables per chain (section 10) |
| `docs/STATUS.md`, `docs/deploy/coolify.md`, `docs/deploy/mainnet.md`, `docs/data-contract.md`, `docs/agent-identity.md`, `docs/gas-model.md`, the design notes | Base throughout; one schema-bump rule; one deploy record | W | A deploy record for 4663, the bump rule said once per indexer, the runbooks' commands per chain |
| Hermes (the Telegram watchdog, `docs/deploy/coolify.md`) | Watches one indexer and one chain | L | A second `/ready` to watch (U how it is configured: not read) |
