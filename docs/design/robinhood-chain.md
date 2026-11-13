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
