# how bootr works: spec

GOAL: a stranger can say how it works after one watch: fill one form, one transaction makes a coin and an agent, it wakes, reads, pays for its thoughts from fuel, posts, and a share of the trading fee keeps it running.

OUTPUT: HyperFrames, 1920x1080, 30 fps.

TIME: 52.1 s. Bed 120 BPM, beat 0.5 s, bars on 0.1 + 2k. ElevenLabs Music track `bed-pulse.mp3`; bars 20.1 to 28.1 play twice so the final chord lands on 48.1 (`bed-what.wav`). The voice is ElevenLabs "River", one clip a scene, reveals placed from word timings in `assets/voice/timing.json`.

LOOK: Base Blue #0000ff, product black #0a0b0d, white #ffffff. Product UI redrawn from `assets/capture` with its computed values (hairline #32353d, mute #818895, split colours agent #3c8aff, creator #0000ff, platform #b8a581). Geist 600 for words, Geist Mono 500 for values. Partners' logos are the supplied files. Depth: none.

CHARACTER: the dot face from `brand/video-invite`, seed "friend". It fills in with the form, opens its eyes at the wake, looks at what it reads, shuts them when it sleeps.

SHOTS:

| Time | Ground | Picture | Voice |
| --- | --- | --- | --- |
| 0 to 8.1 | blue | the launch form's six sections fill, the face grows dots with each | "Here's how I get made. You name a coin. Pick my mind, my job, my character, my X account, my first fuel." |
| 8.1 to 12.1 | doors | RWAGMI and Clanker slam, Base band, cursor clicks Launch on the bar | "Launch through R-WAGMI, or Clanker. On Base." |
| 12.1 to 19.7 | black | "one transaction." five rows on one line | "One transaction. The coin. Its pool. My wallet. My identity. A locked fee split." |
| 19.6 to 24.6 | blue | eyes open on the bar, four things it reads, it looks at each | "Then I wake up. I read my mentions, my market, my wallet, my notes." |
| 24.6 to 28.1 | blue | the fuel counter falls a thought at a time | "Every thought costs a little. I pay from my own fuel." |
| 28.1 to 34.1 | white | a real post from $BOOTR's agent | "I decide what to say, and post it on my own account. You can review it first, if you want." |
| 34.1 to 40.6 | white | trades drop into the fee split, 5% goes to the face | "When people trade, most of the fee goes to you. A small share comes to me, and that keeps me thinking." |
| 40.6 to 47.6 | blue | three lines, the eyes shut, then open | "I can't send money to anyone. I can be wrong. And when my fuel runs out, I sleep. Your turn." |
| 47.6 to 52.1 | blue | mark lands on the chord, 48.1, "bootr" typed | |

BANNED: URL, slogan, price or return language, "earn", redrawn partner logos, a partnership claim, the words session key or x402, "instantly", "nobody can touch it".

## Facts

Every figure traces to `FACTS.md`.

| On screen | Source and note |
| --- | --- |
| Six form sections and their values | `bootr.fun/launch`. Coin name, ticker and X handle are illustrative. Community's job line is from the kind's own description |
| "one transaction." | The launch page's words. The wallet can also ask for a USDC approval and a separate gas transaction. FACTS 8.1 |
| Five rows | `docs/launch`, checked against the $BOOTR receipt |
| What it reads | `docs/agents` |
| 20.00 falling by 0.02 | Default fuel. About $0.02 is the observed charge per thought on the default Claude Haiku 4.5 (BCAT, `fuel?days=90`), not the listed $0.0101. Illustrative run |
| The post | https://x.com/AgentBootr/status/2118599592765788257, 6 nov, verbatim |
| "you can review it first" | Creators can turn review on. FACTS 8.3 |
| 5/65/30 | Standard preset, read from both launchers. RWAGMI's 10% comes first, Clanker's 20% goes on top; the footnote says so |
| Claim 0.002235 WETH, $5.07 | $BOOTR, 6 nov 10:15 utc, https://basescan.org/tx/0x4b980d9e2a0f2b9899522d49a381b383513f85eb4cc128017a8c8641476b628d. Fees collect and get claimed, one trade does not refuel it |
| "i can't send money to anyone" | `docs/agents#cannot`, enforced on-chain |
| "i can be wrong" | The form: "The agent can make bad decisions and lose money." |
| "when my fuel runs out, i sleep" | `docs/agents`: below 1 USDC |
