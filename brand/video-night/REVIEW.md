# the night receipt: review

## Creative calls

- Built B of `STORYLINES.md`, picked by the user. Not built: seven windows, you slept.
- One continuous take: the paper feeds out of the printer and never cuts until the tear.
- The header says "paid to: bootr's ai relay". The seller is Bootr, and the film says so.
- "thought" stands for one paid model call. "x402" stays off screen.
- The fee line says "fees in", not earned. It covers everything since the 21:21 claim.
- Not claimed: that nobody acted that night, or that the agent is autonomous.
- The 100 thoughts and the fee line are real, and the barcode is cut from the first payment's tx hash.

## Measured

- `check` passes with no errors.
- Render: 1920x1080, 29.7 s, -16.7 LUFS, peak -1.5 dBFS. Slightly under the -16 target with the bed already at full level; left as it is rather than pushing the mix.
- Data: 100 payments, 9.2008 USDC, read twice from Base logs. First and last times checked against their blocks. All went to the coin's `platformRecipient`.
- Looked at: QA frames, the phone sheet, the release from 19.1 to 19.6 s, the tear from 25.15 to 26.6 s.

## Not checked

- The sound was measured, not heard. The printer sound is quiet at source, so it is boosted 12 to 20 dB. Listen to it first.

## Warnings kept on purpose

- `line_unread` on receipt rows: the rows are meant to run past. The lines that must be read sit in the left column and pass.
- `contrast_aa_failure` on rows at 14.85 and 21.45 s: false positives on rows crossing the top of the frame, where the checker reads the blue ground instead of the white paper.

## Weakest shot

3.0 to 9.6 s: nothing changes but the rows, the clock and the counter. With more time, one more real event in that stretch would help, such as a reply. That needs the post text, which X shows only after a sign-in.

## Sound credits

Printer and tear are CC0 from Freesound: "Thermal Receipt Print & Cut" by twisterad3, "tearing paper4.wav" by keweldog. Music is from the HeyGen catalog.
