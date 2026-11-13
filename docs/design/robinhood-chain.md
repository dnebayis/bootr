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
