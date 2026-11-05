# i don't exist yet: spec

GOAL: the viewer feels invited: there is an agent waiting for a name, and the next move is theirs.

OUTPUT: HyperFrames, 1920x1080, 30 fps.

TIME: 20.4 s x 30 = 612 frames. Bed 110 BPM, beat = 60/110 s, a new bar every 2.18 s. The voice is ElevenLabs "River", one clip a line, on the bars.

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

| Time | Picture | Line and voice |
| --- | --- | --- |
| 0.0 to 2.18 | a few dots | "i don't exist yet." |
| 2.18 to 4.36 | wave 1 | "i could watch a market." |
| 4.36 to 6.55 | wave 2 | "i could welcome your holders." |
| 6.55 to 8.73 | wave 3 | "i could read all night." |
| 8.73 to 10.91 | mouth, ticker types | "you'd name me." "$YOURS" |
| 10.91 to 13.09 | doors slam: RWAGMI and Clanker | voice: "Through R-WAGMI, or Clanker." |
| 13.09 to 14.18 | Base band rises | "on base." |
| 14.18 to 15.27 | doors hold | "one transaction." |
| 15.27 to 16.8 | doors open, face centred, eyes open, one blink | "your turn." |
| 16.8 to 20.4 | mark lands on 17.45, "bootr" typed, music comes up | |

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
