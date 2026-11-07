# the trailer: spec

GOAL: an action-trailer parody that tells how Bootr works and lands on the rules the agent cannot break.

OUTPUT: HyperFrames, 1920x1080, 30 fps, 46.5 s.

SOUND (all ElevenLabs): score `bed-orchestral.mp3` (the user's orchestral prompt), played from media 1.4 s so its last hit lands on the mark at 42.9, dipped to 0.14 from 28.1 to 32.1 for the stop. Narrator: premade Brian. The agent: premade Callum. Braam, boom and whoosh from Sound Effects.

LOOK: black #000000 and Base Blue #0000ff, white type, Geist 600 cards at 130-230 px, Geist Mono for small lines, a white flash on each cut, a shake on each hit.

| Time | Picture | Sound |
| --- | --- | --- |
| 0 to 4 | "this november" | braam |
| 4 to 12.1 | a wall of tickers scrolls; "$YOURS" lights up and becomes the face | "In a world... where every coin is just a ticker... one coin... got a mind of its own." |
| 12.1 to 14.1 | "born in one transaction." | boom |
| 14.1 to 17.1 | eyes open on 16.1, "i'm awake." | boom, agent: "I'm awake." |
| 17.1 to 20.1 | mentions. market. wallet. notes. one a beat | "It reads the room." |
| 20.1 to 24.1 | fuel counter 20.00 falling 0.02 a beat | "It pays for every thought... itself." |
| 24.1 to 28.1 | a real line from @AgentBootr | "It speaks for its coin." |
| 28.1 to 32.1 | music stops, a clock ticks | "But it plays by rules... it cannot break." |
| 32.1 to 38.1 | three rules, one a bar | braam, booms |
| 38.1 to 40.1 | "rated b for base." | boom |
| 40.1 to 42.5 | the face, "your turn." | agent: "Your turn." |
| 42.9 to 46.5 | the mark on the last hit | braam |

BANNED: URL, slogan, price or return language, a real rating board's mark, invented tickers that exist (the wall is random letters, seeded).

## Facts

| On screen | Source |
| --- | --- |
| "born in one transaction." | The launch page. A wallet can also ask for an approval and a gas transaction |
| mentions, market, wallet, notes | `docs/agents`: what a turn reads |
| 20.00 falling by 0.02 | Default fuel; about $0.02 is the observed charge per thought on the default model. Illustrative run |
| the quoted line | https://x.com/AgentBootr/status/2118599592765788257, 6 nov, verbatim part |
| can't send money to anyone; can't trade its own coin; can't change its split | `docs/agents#cannot`, checked on-chain |
