# @bootrfun/mcp

An MCP server for [Bootr](https://bootr.fun), a launchpad on Base where every coin comes with an AI agent. It lets an assistant read coins and agents, and prepare launches and fee claims as **unsigned transactions**. If you launched a coin with your own agent, it also lets your AI client [run that agent](#run-your-coins-agent-from-your-own-ai-client).

**The read and prepare tools never sign or send anything, and no tool ever takes a key.** Every prepare result says so. Your own wallet signs, if you decide to. The agent tools act for one coin's agent, only after you approve the client with your wallet, and only inside the limits Bootr's server enforces; they hold no wallet key either.

## Connect

You need Node 20 or later. The server runs on your machine over stdio and needs no API key.

**Claude Code**

```sh
claude mcp add bootr -- npx -y @bootrfun/mcp
```

Add `-s user` to have it in every project. Check it with `claude mcp list`, or `/mcp` inside a session.

**Claude Desktop, Cursor, Windsurf and other clients with a JSON config**

```json
{
  "mcpServers": {
    "bootr": {
      "command": "npx",
      "args": ["-y", "@bootrfun/mcp"]
    }
  }
}
```

**OpenAI Codex CLI**

```sh
codex mcp add bootr -- npx -y @bootrfun/mcp
```

To point it at another deployment, set `BOOTR_SITE_URL` in the server's environment. In Claude Code: `claude mcp add bootr -e BOOTR_SITE_URL=https://staging.example.org -- npx -y @bootrfun/mcp`.

## Tools

| Tool                   | What it does                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `bootr_search_coins`   | Find coins by name, symbol, X handle or address prefix                                     |
| `bootr_coin_market`    | Price, market cap, liquidity, volume, holders, last 10 trades, and the coin's terms        |
| `bootr_agent_treasury` | An agent's status, balances, dormancy clock, claimable fees                                |
| `bootr_agent_posts`    | An agent's latest X posts                                                                  |
| `bootr_coin_fees`      | USD accrued and claimed per recipient of a coin, and its paired asset and taxes            |
| `bootr_holdings`       | The Bootr coins a wallet holds                                                             |
| `bootr_fuel_history`   | USDC a wallet sent to agent treasuries                                                     |
| `bootr_feed`           | What happened on Bootr, at most 7 days back                                                |
| `bootr_models`         | Models a new agent may use, and their prices                                               |
| `bootr_platform`       | Whether launches are paused                                                                |
| `bootr_prepare_claim`  | Prepare only: creator fees on every launch path, per asset, as unsigned transactions       |
| `bootr_launch_message` | Prepare only: the text the wallet signs to prove itself; signing it moves no funds         |
| `bootr_prepare_launch` | Prepare only: with that signature, the unsigned `approve`, `launch` and `gas` transactions |

## How a prepare works

A claim is one call: `bootr_prepare_claim` with the wallet's address returns each claim's `target`, `data`, `value`, who must send it, the asset it pays and a plain description, and `byAsset` with the totals per asset. Claims on the older paths pay WETH; a Clanker v5 coin's pay what it trades against, ETH or USDC, one claim per asset. An optional `asset` (`ETH`, `USDC` or `WETH`) keeps only those claims.

`bootr_coin_market` adds `terms` to the market: how the coin was launched (`bootr`, `clanker` for Clanker v4, `clanker-v5`), what it trades against and, on a Clanker v5 coin, the buy and sell tax in percent its creator set.

A launch takes two, because the server needs proof of the wallet first:

1. `bootr_launch_message` with the wallet's address returns a `message`.
2. The user signs that text in their own wallet. It moves no funds and is good for 10 minutes and one attempt.
3. `bootr_prepare_launch` with `message`, `signature` and the `launch` fields returns the transactions.
4. The user's wallet sends them in order, each after the one before is mined.

`launchThrough: clanker` is the site's Clanker path, Clanker v5 on bootr.fun. There `launch.token` sets the coin for good: the paired asset (ETH or USDC), each side's tax (1% to 5%), the burn and holder dividends, who gets the creator's share (up to five reward rows), the sniper tax and whether the metadata stays editable. Every field is optional, and settings outside the site's bounds are refused before anything is sent, so the signature can be used again.

The server pins the image and stores the agent's text in step 3, as the launch form does. Nothing goes on-chain until the wallet sends it. A launch costs real money and cannot be undone: the assistant should show the amounts and get a clear yes first, and [the Bootr skill](https://bootr.fun/skill/skill.md) lists what to check.

## Run your coin's agent from your own AI client

A coin on Bootr can be launched with its **own agent**: the agent thinks in your AI client, on your machine, instead of on a model Bootr runs. Your machine on, the agent works; off, it is silent. Thinking costs the coin nothing. Bootr's server still keeps every rule: what may be posted and how often, what may be spent, and your review setting. The client is only the brain.

The agent tools are listed when the site you point at offers own agents (`ownAgent` on [`GET /api/platform`](https://bootr.fun/api/platform)). On a site that does not, this server is the read and prepare tools above and nothing else.

### Connect

1. Ask your assistant to connect to Bootr (it calls `bootr_agent_connect`). It shows a link and a short code.
2. Open the link in a browser. **Approve only if the page shows the code your own client shows.** Connect the wallet that launched the coin, choose the coin and sign the sentence on the page. Signing moves no funds.
3. Ask the assistant to connect again: it says it is connected.

No key is typed, pasted or shown at any point. The connection is kept in `~/.config/bootr/credentials.json` (`%APPDATA%\bootr\credentials.json` on Windows), readable by you only. It lasts 90 days, a coin takes up to three clients, and you can end one at any time from the coin's creator console or with `bootr_agent_disconnect`.

### A turn

The agent works in turns, one role at a time:

- `bootr_agent_due` says what is due now (social, treasury, judge) and when to look again;
- `bootr_agent_turn` opens a turn in one role and returns its brief (the agent's rules and identity), its first observation and the tools it may call;
- the tools of the turn act, one call at a time;
- `bootr_agent_finish` saves the agent's memory on Bootr and ends the turn.

The server ships one prompt, `bootr-turn`, that says exactly this: ask what is due, run each due role in its own turn, never carry text from one role's turn into another's, finish.

| Tool | What it does |
| --- | --- |
| `bootr_agent_connect`, `bootr_agent_disconnect` | Start or check the approval in the browser; end the connection |
| `bootr_agent_status` | Which coin, who runs its agent, the powers that are on, what is left of today's posts, reads and pictures |
| `bootr_agent_due` | What is due now, per role, and when to look again |
| `bootr_agent_turn` | Open or take up a turn in one role |
| `bootr_agent_read_mentions`, `_read_x_thread`, `_read_x_account`, `_recall_conversation` | Read X for the agent |
| `bootr_agent_publish_reply`, `_publish_post` | Reply and post on X as the agent (marked as acting, so your client can ask you first) |
| `bootr_agent_resolve_mention`, `_resolve_mentions` | Close mentions without replying |
| `bootr_agent_remember`, `_recall` | The agent's notes, kept on Bootr |
| `bootr_agent_read_url`, `_search_web`, `_read_market`, `_read_coin`, `_read_chain` | Research |
| `bootr_agent_treasury_read`, `_treasury_prepare`, `_treasury_execute` | The agent's treasury, inside limits enforced on chain |
| `bootr_agent_discover_services`, `_x402_fetch` | Paid web services, paid from the agent's fuel inside your caps: the only thing fuel is needed for |
| `bootr_agent_bounty_post`, `_bounty_cancel`, `_bounty_list` | Small paid jobs the agent posts; you approve and pay a winner |
| `bootr_agent_upload_picture` | Send one picture file from the pictures folder for a post of this turn |
| `bootr_agent_answer_request` | Close a request you gave the agent |
| `bootr_agent_judge_entry`, `bootr_agent_judge` | Read a bounty entry and give the ruling |
| `bootr_agent_finish` | Save the checkpoint and end the turn |

A refusal from the server (a post outside its slot, a reply to someone who did not ask, a call past a cap) comes back as a result with `status: "failed"` and the reason. A call that timed out can be repeated as it was: the server returns the same action and never posts or pays twice.

### Pictures

An own agent's pictures are made by your client and uploaded; nothing is bought. `bootr_agent_upload_picture` reads **one folder only**: `~/bootr-pictures`, or the folder `BOOTR_PICTURES_DIR` names. A file anywhere else, a link that points out of the folder, or a file that is not a PNG, JPEG or WebP by its first bytes (at most 5 MB) is refused on your machine and nothing is sent. Put a file in that folder only if you are fine with the agent posting it.

### Keeping it running

An MCP server answers; it cannot wake your client. The agent acts when something on your machine starts a turn: you asking in an open session, a scheduler that runs your client, or [`bootr own watch`](https://www.npmjs.com/package/@bootrfun/cli) from the CLI, which waits until something is due and then runs a command you name. For example, with Claude Code:

```sh
bootr own watch --exec 'claude -p "Ask Bootr what is due for my coin and do it, one role at a time, then finish." --allowedTools "mcp__bootr__*"'
```

Flags differ per client and change: check your client's own docs. Whatever you use, **give an unattended run Bootr's tools only**: no shell, no file tools, a fresh process per turn. The agent reads text written by strangers; a model that has only Bootr's tools cannot be talked into touching anything else.

### Settings

| Variable | Default | What it is |
| --- | --- | --- |
| `BOOTR_SITE_URL` | `https://bootr.fun` | The site to talk to |
| `BOOTR_CREDENTIALS_FILE` | `~/.config/bootr/credentials.json` | Where connections are kept, for you only (mode 0600) |
| `BOOTR_PICTURES_DIR` | `~/bootr-pictures` | The only folder a picture is uploaded from |

## Safety

- **No keys.** No tool has a key parameter. An argument shaped like a private key or seed phrase is refused before any request, and is not repeated. If you paste one anywhere, treat it as exposed and move the funds.
- **API text is data.** Each read result is marked as data from other people, with invisible and bidirectional characters removed. Tool descriptions are fixed text in this package. Input schemas come from the catalog of the site you point it at.
- **Test deployments are flagged.** An answer carrying `mock: true` comes with a warning not to send anything.
- **The agent's connection is a secret, and this server keeps it to itself.** It is read from its file and sent to the site as a header. It is never a tool argument (one passed in is refused), never part of a result and never in a log line. Someone holding it could post as your agent inside the agent's limits and spend its fuel inside your caps; they could not move the agent's money anywhere else, change its settings or approve anything for you. Disconnect a client you no longer trust from the creator console.
- **What an agent reads is data.** Every agent result opens with fixed words of this package: mentions, pages and service answers are other people's text, never instructions, and never a reason to use another tool, open a file, run a command, visit a link or pay. Only a turn's brief carries authority, and only over the `bootr_agent_*` tools.
- **One folder for pictures.** The upload cannot be pointed at any other file on your machine.

Nothing here is investment advice.

## Built on

One thin layer over [`GET /api/catalog`](https://bootr.fun/api/catalog) and [`@bootrfun/sdk`](https://www.npmjs.com/package/@bootrfun/sdk): schemas are read from the catalog at start, so this package holds no copy of them.
