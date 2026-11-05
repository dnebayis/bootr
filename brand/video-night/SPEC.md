# the night receipt: spec

GOAL: the viewer remembers what the agent did and said at 3 am, and that it paid for it itself.

OUTPUT: HyperFrames, 1920x1080, 30 fps.

TIME: 29.7 s x 30 = 891 frames. Bed 100 BPM, beat = 0.6 s. Quiet dip 9.6 to 11.4, release on 19.2 (beat 32), peak on 26.4 (beat 44).

LOOK:
- Ground: Base Blue #0000ff, flat. Goes black #0a0b0d from the printer slot for the dead of night, 9.6 to 15.0.
- Paper: white #ffffff, ink #0a0b0d, 700 px wide, zigzag head.
- Accent: Cerulean #3c8aff on one sentence, "It earns one." On the paper, one blue block (fees) and one black block (fuel).
- Type: Geist 600 at 116 px for the agent's words and the lines. Geist Mono 500 for the clock (120 px), the labels (40 px) and row times (30 px).
- Depth: none. No shadow, grain or glow.

OBJECTS:
- A receipt printer: a #0a0b0d body along the bottom right, top edge at y = 932, a slot and a toothed cutter bar. Paper comes up out of it.
- The receipt: one row per real post with its topic and price, other thinking, the night's total, fees in, fuel added, a footer, a barcode cut from the first payment's real tx hash.

MOTION:
- One continuous take: the camera never cuts, the paper feeds in steps on beats. Feed is a pure function of time, and the clock and the counter read from it.
- The agent's words print line by line (`steps(8)`, 0.24 s), the same way the receipt does.
- Night flood: a circle from the slot, 0.4 s, `power2.inOut`, out again the same way.
- The fee block fires in 0.22 s (`expo.out`) on the release.
- The tear: the paper flies up in 0.7 s (`power3.in`) with -3 degrees of rotation, the printer drops out.

SHOTS:

| Time | Paper | Left column | Sound |
| --- | --- | --- | --- |
| 0.0 to 2.4 | head | "one night. one agent." | bed |
| 2.4 to 4.8 | 00:29 post | 00:29: "No one decides in the moment." | print, key |
| 4.8 to 7.8 | 01:02, 01:35 posts | 01:35: "it stops being a tool and starts being a participant." | print, key |
| 7.8 to 9.6 | 02:05 post | 02:05: "The rail is quietly becoming infrastructure." | print, key |
| 9.6 to 12.6 | 02:38, 03:11 posts, ground goes black | 03:11: "Nobody hands it a budget. It earns one." | print, key, impact |
| 12.6 to 15.0 | 03:44, 04:17 posts | 04:17: "An agent reads, decides, and surprises you." | print, key |
| 15.0 to 19.2 | blue returns, other thinking, the night | 06:29, "8 posts. $9.20 of thinking." | print |
| 19.2 to 21.0 | blue fee block, 07:12 | "then its fees came in." | cut, impact |
| 21.0 to 22.8 | black fuel block | "and became fuel." | print |
| 22.8 to 25.2 | footer and barcode | "under $1 of fuel, it sleeps." | print |
| 25.2 to 26.4 | paper tears away, printer drops | left column clears | tear |
| 26.4 to 29.7 | | mark lands on the peak, "bootr" typed | impact, key |

BANNED: the spec.md defaults, plus: "thought" as a row label, "nobody touched it", "while you slept", "earned" or "profit" in Bootr's own voice, "paid for itself", any price or return language, "x402" on screen, third-party names in the film (the agent's quoted lines name nobody).

QA: frames 0.5, 3, 6.5, 9, 11, 14, 17.5, 20.5, 22.5, 24.5, 25.6, 29.

## Facts

Figures come from `data.json` (Base logs, `fetch_data.py`) and `night.json` (site API, read 5 nov).

| On screen | Source | Note |
| --- | --- | --- |
| 8 post rows, times, the five quotes | `/api/agents/1153600/posts`, kept in `night.json` with their URLs | `build.py` asserts each quote is verbatim. Capitals are the agent's own. "It earns one." is the agent's line, labelled "it posted:" |
| Row topics | My summaries of each post | Third parties in the posts are left out |
| Price of a post | Sum of the payment bursts (gaps under 90 s) starting within 240 s before the post | Attribution by timing, not a recorded link. `build.py` asserts that posts + other = total |
| "other thinking $4.50" | All other bursts, including everything after 04:17 | What those calls did is not public, so the label stays generic |
| "$9.20" | 100 USDC payments from the spender, 00:00 to 07:00 utc | First and last checked against their blocks |
| "paid to: bootr's ai relay" | Recipient is the coin's `platformRecipient`, also `INFERENCE_PAYTO_ADDRESS` per `docs/deploy/mainnet.md` | Shown on purpose |
| "07:12:43 fees in +$47.31" | `/platform/feed` claim, tx 0x6ff44dab… | Covers fees since the 21:21 claim |
| "07:12:49 fuel added +$18.94" | Activity tape, tx 0xa74aa136… | "Added 18.94 USDC of fuel" |
| "under $1 of fuel, it sleeps" | `SLEEP_USDC = 1`, `apps/supervisor/src/tick.ts` | Kernel + spender USDC |

## Left out, knowingly

Hourly "Fee claim failed" entries from 00:58 to 07:02 are on the public activity tape. They came from the session key's lifetime limit of 60 userOps. The 07:12 claim worked because the key was rotated by hand that morning, so the film must never suggest the agent recovered by itself. Claims normally run on their own (many on 4 nov).
