# Review: first boot ($BOOTR)

Rendered: `renders/first-boot.mp4`, 1920 x 1080, 30 fps, 29.7 s, h264 + aac. Rebuild the sound with `python3 build_index.py`.

## Creative calls
- Concept "first boot": the platform coin and its agent wake up together. Not the mechanism explainer (that is `brand/video`) and not the Base film.
- Music: catalog drum and bass, measured 173.66 BPM, beat 0.3455 s. Build 0-5.5 s, drop on beat 16, drop section looped on bar lines, stops dead on beat 80. Different from both earlier films (130 BPM four on the floor).
- Boot log and countdown on black (chain world), drop and post on white (agent world), as in the first film.
- The end card reuses the logo-motion lockup so the mark behaves the same everywhere; $BOOTR lands on the music cut.
- Not built: the fee-loop film (buy, burn, post as a loop) and the agent's first-person log. Both fit a later film.

## Measured
- check passes with no warnings; layout, contrast and runtime clean.
- Rendered audio: integrated about -15.6 LUFS, true peak about -1.7 dBFS, loudness range 3.1 LU. The drop lands at 5.5 s (+17 dB jump), the music stops at 27.64 s, the tail ends at 29.08 s.
- Frames reviewed: review sheets (scenes, 10 seams, phone width). Seam at beat 16 reads as blackout, tiny flood, full flood.

## Not checked
- The sound was measured, not heard. Beat alignment is from signal analysis (confidence low on half-time detection; tempo and phase were fitted on the drop section).
- Text on a real phone: only the 360 px sheet.

## Weakest shot
- The post card (b41-b54) is the quietest: it holds 5 s of typed text on a white card with empty space below. With more time: a second post appears on b52 with the agent's treasury number ticking.

## Update 2026-10-29 (after the RWAGMI release)
- Fee model: coins launch through RWAGMI v3. Swappers pay 1% in WETH, 90% reaches the coin's locked slots, 10% goes to RWAGMI. The fee scene now shows shares of the 1% (4.5 / 45 / 13.5 / 27 and rwagmi 10) and is titled "where the 1% goes", matching the product's fee bar. The 5 / 50 / 15 / 30 numbers are the same split read as shares of the 90%.
- Palette: the product moved to Base tokens (dark canvas #0a0b0d, hairline #32353d, accent Cerulean #3c8aff on dark and Base Blue #0000ff on white). The film follows.
- Nothing in the film names Clanker; the boot log and statements still match the launch flow.

## Facts to confirm before posting
- Ticker is shown as $BOOTR. The repo docs, the web app and the post validator still say $BOOT (checked again on 2026-10-29).
- The burned row (13.5% of the fee) is the buyback preset the docs plan for the platform coin. Confirm the launch uses that preset.
- The film makes no price claim, shows no address and no date.

## Warnings kept on purpose
- None.
