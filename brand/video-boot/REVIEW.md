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
- Rendered audio: integrated -15.6 LUFS, true peak -1.7 dBFS, loudness range 3.1 LU. The drop lands at 5.5 s (+17 dB jump), the music stops at 27.64 s, the tail ends at 29.08 s.
- Frames reviewed: review sheets (scenes, 10 seams, phone width). Seam at beat 16 reads as blackout, tiny flood, full flood.

## Not checked
- The sound was measured, not heard. Beat alignment is from signal analysis (confidence low on half-time detection; tempo and phase were fitted on the drop section).
- Text on a real phone: only the 360 px sheet.

## Weakest shot
- The post card (b41-b54) is the quietest: it holds 5 s of typed text on a white card with empty space below. With more time: a second post appears on b52 with the agent's treasury number ticking.

## Facts to confirm before posting
- Ticker is shown as $BOOTR. The repo docs, the web app and the post validator still say $BOOT.
- The burned 15% row is the buyback preset (5 / 50 / 15 / 30) the docs plan for the platform coin. Confirm the launch uses that preset.
- The film makes no price claim, shows no address and no date.

## Warnings kept on purpose
- None.
