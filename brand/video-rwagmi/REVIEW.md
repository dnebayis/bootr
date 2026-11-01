# Review: bootr on rwagmi

Rendered: `renders/bootr-on-rwagmi.mp4`, 1920 x 1080, 30 fps, 32.9 s, h264 + aac. Rebuild the sound track list with `python3 build_index.py`.

## Creative calls
- Brief: the person's three points about the RWAGMI stack (one-sided pool with the LP locked in RWAGMI's locker, the 1% fee split on-chain between agent, creator, platform and RWAGMI, the agent claims its own share and pays its own gas from it). One scene each, plus an arrival and an end card.
- Two houses: Bootr's dark and white worlds with the product's Base tokens, and RWAGMI's sky (#85e2ff, sampled from the supplied logo). No Bootr accent blue, so the sky is the one colour.
- The RWAGMI mark is the supplied image, cut out (never redrawn): the black glyph as a transparent PNG and split into its four arcs. The four arcs become the four fee slots (agent, creator, platform, rwagmi). The avatar tile is used as is, as the locker.
- Music: catalog future-bass trailer, 127.7 BPM (beat 0.46985 s), a different feel from the two drum-and-bass and house films. Intro beats 0-4, drop on beat 4, the track's own break on beats 30-32 is where the mark appears, the fee drop lands on beat 32.
- Fee rows are shares of the 1% fee for the standard preset: agent 4.5, creator 58.5, platform 27, rwagmi 10 (0.045 / 0.585 / 0.27 / 0.10 % of volume, as in the product's fee bar).
- Not built: the buyback preset variant (burn row), the creator and platform claims from the web app.

## Measured
- check: 0 errors, 0 warnings, layout and contrast clean.
- Rendered audio: -15.0 LUFS integrated, true peak -2.5 dBFS, loudness range 2.7 LU. Drop at 1.9 s (-17 to -12 dB), break at 14 s (-22 dB) and return at 15 s, end-card slam at 30 s, fade-out to silence at 32 s.
- Frames reviewed on contact sheets: intro, all four scenes, end card. No phone-width sheet.

## Not checked
- The sound was measured, not heard. Beat alignment comes from a tempo and phase fit of the track (kick peaks sit about 80 ms after the grid, as expected for a bass body).
- The cut-out of the logo comes from a 400 px source; at 480 px on screen its curves are smooth, but a vector original from RWAGMI would be better.

## Facts to confirm before posting
- "pays its own gas from it": the supervisor docs say kernels pay their own gas through the paymaster and the EntryPoint deposit, so a sponsored operation may be billed to the paymaster account rather than the agent. The film follows the person's wording.
- "one-sided pool, LP locked": from docs/rwagmi-migration.md (single position above the start price, all supply in the pool, LP held by RwagmiLpLockerV3).
- The fee numbers are the standard preset. A coin on the buyback preset shows 45 / 13.5 burned instead of 58.5.
- No price, address, date or URL on screen.

## Weakest shot
- The agent flow (b44-b60) is the quietest: two titles and a small diagram on white, the balance numbers are illustrative (0.0042, 0.0038 weth). With more time: the same flow with a real claim from the product's data.

## Warnings kept on purpose
- None.
