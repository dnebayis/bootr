# bootr by the numbers: spec

Goal: a 33 s metrics film a stranger can read once: how many coins and agents, how much traded, what the fees were and
how they were split, which coins were busiest, how much $BOOTR is burned. Every figure comes from `data.json`, which
`fetch_data.py` reads from the public indexer (https://indexer.bootr.fun) and from Base (the $BOOTR balance at the burn
address). Every figure is all-time unless the screen says otherwise, and the film carries its as-of time (m1 and m5).

Refresh: `python3 fetch_data.py && python3 build.py && npm run render`. The film is a snapshot, not a live page; post it
with the date it shows.

## Grid

Music and effects as the launch film: `assets/audio/bed-sky.mp3`, 127.7 BPM, beat(k) = k x 0.46985 s, drop on beat 4,
break on beats 30-32, outro from beat 60. Effects peak-aligned one frame after the picture (`build.py`). 32.9 s.

## Shots (b = beat)

- m1 dark b0-12: "bootr, by" / b4 "the numbers." (impact). b5.5 / 6.8 / 8.1: "read from the public indexer." / "since the first launch, 2 nov." / "as of <time> utc."
- m2 white b12-28: circle flood. "launched." Three rows (b13.5, 17.5, 21.5), each a blue count-up: coins, agents (one per coin), ways to launch (rwagmi 1, clanker 6).
- m3 dark b28-48: wipe. b29 "traded."; b32 (the drop) the all-time volume counts up; b33.5 "across every coin since 2 nov."; b35.5 the volume of the latest UTC day. b40 leaves; "<fees> in trading fees." and a fee bar to scale, one slot per 0.6 beat: creator, platform, launchers, burn, agent (accent); b44.3 "all time. by slot." / "locked at launch."
- m4 white b48-60: flood. "busiest coins, last 24 h.": four coins by 24 h volume, bars to scale (the first blue, the rest grey), holders under the name. b52.8 leaves; "burned, on chain." counts up the share of $BOOTR's supply at the burn address, with the token count.
- m5 dark b60-70: flood, the mark, "bootr", and a source line.

## FACTS

| On screen | Source |
| --- | --- |
| coins, agents, launch paths | `platformStats.tokens`, distinct `agentId`, `token.source` counts |
| traded (all-time, latest day) | `/platform/fees` `total.volumeTotalUsd`; `dailyStats` latest row |
| trading fees | `/platform/fees` `total.feesTotalUsd`: the gross swap fee, the launcher's part included |
| slots | `total.byKind` (creator, platform, burn, agent); "launchers" is the gross total minus those four (RWAGMI's 10% and Clanker's part) |
| busiest coins | `tokens(orderBy: volume24hUsd)`, name, 24 h volume, holders |
| burned | `balanceOf(0x…dEaD)` and `totalSupply()` of the $BOOTR token on Base |

## Banned

Price, market cap, return or "buy" language; "earned" or "received" about agents or creators (the slots are accruals);
URLs; emoji; exclamation marks; any figure not in `data.json`.
