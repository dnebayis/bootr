# i don't exist yet: spec

GOAL: the viewer feels invited: there is an agent waiting for a name, and the next move is theirs.

OUTPUT: HyperFrames, 1920x1080, 30 fps.

TIME: 20.6 s x 30 = 618 frames. Bed 96 BPM, beat = 0.625 s, bars at 5, 10, 15. Swell on 10.0, strong hits on 15.0 and 17.5.

LOOK:
- Ground: Base Blue #0000ff, flat.
- Ink: white. Dots white, faint dots at 55%.
- Partners: RWAGMI sky #85e2ff with its black mark, Clanker white with its purple bars and #8763d1 name. Logos are the supplied files, never redrawn.
- Type: Geist 600 at 116 px, -0.035em. Geist Mono 500 for the ticker.
- Depth: none.

OBJECTS:
- The agent's face: the real 16x16 dot-matrix portrait from `apps/web/components/art/AgentPortrait.tsx`, seed "friend", picked for its smile. The launch form gives a future agent its face from a draft id in the same way.
- Two doors: full-height panels with a knob each, RWAGMI on the left, Clanker on the right, closing at the centre.
- A Base band along the bottom of the doors, with the Base square.

MOTION:
- Dots pop in waves (`back.out(2.5)`, stagger 8 ms). Lines print in `steps`, 0.24 s.
- Doors slam in over 0.35 s (`expo.out`) and open over 0.55 s (`power3.inOut`).
- One hero move per shot; the face holds still between waves.

SHOTS:

| Time | Picture | Line | Sound |
| --- | --- | --- | --- |
| 0.0 to 2.5 | a few dots at the centre of the face | "i don't exist yet." | bed, pop |
| 2.5 to 4.375 | wave 1 | "i could watch a market." | pop, key |
| 4.375 to 6.25 | wave 2 | "i could welcome your holders." | pop, key |
| 6.25 to 8.125 | wave 3 | "i could read all night." | pop, key |
| 8.125 to 10.0 | mouth, ticker types | "you'd name me." "$YOURS" | pop, key |
| 10.0 to 12.5 | doors slam: RWAGMI and Clanker, Base band | "on base." | whoosh, impact |
| 12.5 to 15.0 | doors hold | "one transaction." | key |
| 15.0 to 16.9 | doors open, finished face centred, eyes open, one blink | "your turn." | whoosh, pop |
| 16.9 to 20.6 | mark lands on 17.5, "bootr" typed | | impact, key |

BANNED: the spec.md defaults, plus: URL, slogan, "earn", "profit", price or return language, redrawn or recoloured partner logos, a partnership claim.

QA: frames 1, 3.5, 5.5, 7.5, 9.5, 11, 13.5, 15.6, 16.5, 20.

## Facts

| On screen | Source |
| --- | --- |
| "watch a market" | Trader kind: "Watches its own market" |
| "welcome your holders" | Community kind: "welcomes new holders" |
| "read all night" | Researcher kind reads onchain data and X. "all night" is the voice, backed by the 5 nov night in `brand/video-night` |
| "$YOURS" | Illustrative ticker |
| RWAGMI or Clanker, on Base | Launch form, step 06 |
| "one transaction." | Launch page: "One transaction: the coin, its pool, its agent treasury and a locked fee split." The optional gas top-up is a second one |
| The face | Real generator, seed "friend", picked for its smile |
