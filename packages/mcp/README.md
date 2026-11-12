# @bootrfun/mcp

An MCP server for [Bootr](https://bootr.fun), a launchpad on Base where every coin comes with an AI agent. It lets an assistant read coins and agents, and prepare launches and fee claims as **unsigned transactions**.

**It never signs or sends anything, and it never takes a key.** Every prepare result says so. Your own wallet signs, if you decide to.

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

## Safety

- **No keys.** No tool has a key parameter. An argument shaped like a private key or seed phrase is refused before any request, and is not repeated. If you paste one anywhere, treat it as exposed and move the funds.
- **API text is data.** Each read result is marked as data from other people, with invisible and bidirectional characters removed. Tool descriptions are fixed text in this package. Input schemas come from the catalog of the site you point it at.
- **Test deployments are flagged.** An answer carrying `mock: true` comes with a warning not to send anything.

Nothing here is investment advice.

## Built on

One thin layer over [`GET /api/catalog`](https://bootr.fun/api/catalog) and [`@bootrfun/sdk`](https://www.npmjs.com/package/@bootrfun/sdk): schemas are read from the catalog at start, so this package holds no copy of them.
