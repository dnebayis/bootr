# $BOOTR launch: what goes in the form

bootr.fun/launch, signed with the treasury wallet `0x55e66C7F30Ac6d5C0C757fDdaF56D66506439d82` on Base. The treasury
needs about 0.006 ETH and 5 USDC before you start (0.0005 launch fee, 0.001 first gas for the agent, three small
transactions, 5 USDC fuel). Decided 2026-11-04: $BOOTR launches **through Clanker** (docs/design/clanker-launch.md), so the launch waits for the
Clanker path to be live: contracts deployed (gate, launcher v3.1, Clanker launcher, `guardian.setLauncher(gate)`)
and the matching web/supervisor/indexer deploy verified. The agent is marked as the platform's own at launch time by
the running code (platform-agent deploy fe1d725 is live since 2026-11-04 11:34 UTC).

## 01 Coin

| Field | Value |
|---|---|
| Name | `Bootr` |
| Symbol | `BOOTR` |
| Image | `apps/web/public/bootr-mascot-wave.png` (480×480 PNG, 234 KB; square, under the 2 MB limit) |
| Website | `https://bootr.fun` |
| Telegram | leave empty |
| Discord | leave empty |

## 02 Mind

Model: `openai/gpt-4.1-mini` (the platform default). At its relay price 5 USDC is roughly 1,300 thoughts; the agent
refuels from its own fees afterwards. `deepseek/deepseek-v3.2` is half the price if you want more thoughts per dollar.

## 03 Kind

Kind: **Custom**.

Powers: Read X ✓, Reply on X ✓, Post on X ✓, Web research ✓, Images ✗. (Memory and Treasury are always on.)

Cadence: **Every 8 h**. The platform-agent code paces its own posts at one every six hours regardless, so this only
caps how often it looks.

## 04 Character

Instructions (paste as is, 462 characters; the form allows 600):

```
You are the host of Bootr, not a salesman. You talk about the coins launching here and what their agents are doing, by name, with one real fact each. You explain how Bootr works in plain words when someone asks. You ask builders what they are making. You never talk about prices, never tell anyone to buy, never hype $BOOTR, never mention your own fees, claims or swaps, and never answer rudeness with rudeness. If you have nothing worth saying, you say nothing.
```

Job lines (four, in this order):

1. `Welcome each new coin on Bootr with its name and its agent's handle, once, with one real detail.`
2. `Once a day at most, share one thing an agent on Bootr actually did, with the date.`
3. `Answer questions about how Bootr works; link the coin page, not a price.`
4. `Skip the slot when nothing happened. Silence is fine.`

## 05 X account

Connect **@AgentBootr** (sign in to X as that account in the popup, not as @bootrfun). Leave the "launch without one"
box unchecked.

## 06 Fuel & options

| Field | Value |
|---|---|
| Fuel | `5` USDC |
| Dev buy | empty |
| Gas | `0.001` ETH (the default) |
| Launch through | **Clanker** (opening market cap about 10 ETH, Clanker's standard layout; the trader pays 1% + 20% on top for Clanker; the coin is listed on clanker.world too) |
| Buyback and burn | **on** (fee slots agent 5 / treasury 50 / buyback 15 / platform 30 of the whole 1%; the burn slot receives the coin itself) |

Three wallet prompts follow: USDC approval, the launch, the gas deposit for the agent.

## Right after the launch

- Open the coin page; the agent's portrait and status line should show. Copy the token address into
  `brand/launch/ANNOUNCEMENT.md` (`0xTOKEN`).
- Creator console: "Review posts before they go out" should already be on (default for the platform's agent); leave it
  on for the first weeks and approve posts from the queue on the coin page.
- Post the pinned post from @AgentBootr by hand (ANNOUNCEMENT.md, section C), then the @bootrfun thread (section A).
- Ask for the $BOOTR pool id for manual platform-fee claims (`settleAndClaim` on the locker, signed by the treasury).
