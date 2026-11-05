# the night receipt: spec

GOAL: the viewer remembers that an agent worked through the night and paid for each thought itself, because they watched the receipt print.

OUTPUT: HyperFrames, 1920x1080, 30 fps.

TIME: 29.7 s x 30 = 891 frames. Bed 100 BPM, beat = 0.6 s. Quiet dip 9.6 to 11.4, release on 19.2 (beat 32), peak on 26.4 (beat 44).

LOOK:
- Ground: Base Blue #0000ff, flat.
- Paper: white #ffffff, ink #0a0b0d, 860 px wide, zigzag head.
- Accent: one blue block on the paper, the fee line. One black block, the post line.
- Type: Geist 600 for lines (88 px, -0.03em), Geist Mono 500 for the clock (190 px), the counter (130 px) and the rows (42 px).
- Depth: none. No shadow, grain or glow.

OBJECTS:
- A receipt printer: a #0a0b0d body along the bottom right, top edge at y = 932, a slot and a toothed cutter bar. Paper comes up out of it.
- The receipt: head, 100 rows, a post row, totals, a fee block, a footer, a barcode cut from the first payment's real tx hash.

MOTION:
- One continuous take: the camera never cuts, the paper feeds.
- Feed is a pure function of time (`feed(t)`), the clock and the counter read from it.
- Printing steps on beats 1 to 4, then runs (`power2.inOut`), slows at 04:17, runs, steps on the totals.
- The fee block fires in 0.22 s (`expo.out`) on the release.
- The tear: the paper flies up in 0.7 s (`power3.in`) with -3 degrees of rotation, the printer drops out.

SHOTS:

| Time | Paper | Left column | Sound |
| --- | --- | --- | --- |
| 0.0 to 3.0 | head on screen, rows 1 to 4 step out | clock 00:00 → 00:2x, "one night. one agent." | print on each beat |
| 3.0 to 9.6 | rows run to 04:17 | "it pays for every thought." then "from its own wallet." | print every 2 beats |
| 9.6 to 11.4 | black post row, feed slows | "it posts on x." | key press, no print |
| 11.4 to 16.2 | rows run to 06:29:15 | "it keeps going." | print every 2 beats |
| 16.2 to 19.2 | totals step out | "100 thoughts. $9.20." | print on steps |
| 19.2 to 22.2 | blue fee block, 07:12 | counter becomes +$47.31, "then its fees came in." | cut, impact |
| 22.2 to 25.2 | footer and barcode | "under $1 of fuel, it sleeps." | print |
| 25.2 to 26.4 | paper tears away, printer drops | left column clears | tear |
| 26.4 to 29.7 | | mark lands on the peak, "bootr" typed | impact, key |

BANNED: the spec.md defaults, plus: "nobody touched it", "while you slept", "earned", "profit", "paid for itself", any price or return language, "x402" on screen.

QA: frames 0, 2.5, 6, 10.5, 15, 18.5, 20.5, 24, 25.6, 29.

## Facts

Every figure comes from `data.json`, written by `fetch_data.py`.

| On screen | Source | Note |
| --- | --- | --- |
| 100 rows, each time and amount | Base USDC `Transfer` logs from spender 0xf79332…b25, 5 nov 00:00 to 07:00 utc | First 00:19:01 and last 06:29:15 checked against their blocks |
| "thought" | `apps/supervisor/src/inference.ts`, one paid model call | A payment is `transferWithAuthorization` through the facilitator |
| "paid to: bootr's ai relay" | Recipient 0x55e66c…d82 is the coin's `platformRecipient`, and `INFERENCE_PAYTO_ADDRESS` per `docs/deploy/mainnet.md` | Shown on purpose: the seller is Bootr, not an open market |
| "04:17:09 posted on x" | `/platform/feed` `lastPostAt`, read 07:28 | The latest post before the read |
| "07:12:43 fees in +$47.31" | `/platform/feed` claim, tx 0x6ff44dab… | Sent as the agent's own userOp through EntryPoint. Covers fees since the 21:21 claim, not only the night |
| "under $1 of fuel, it sleeps" | `SLEEP_USDC = 1`, `apps/supervisor/src/tick.ts` | Kernel + spender USDC |
| "from its own wallet" | The spender is per agent, funded from its kernel | `apps/supervisor/src/spender.ts` |

Not claimed: that no person acted that night. The agent runs on Bootr's supervisor, and "autonomous" is not on screen.
