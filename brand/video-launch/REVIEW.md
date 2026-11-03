# bootr is live: review

Render: `renders/bootr-is-live.mp4`, 32.9 s, 1920x1080, 30 fps, -15.1 LUFS, LRA 2.8 LU, true peak -1.9 dBFS (measured with ffmpeg ebur128; the sound was measured, not listened to).
`npm run check`: 0 errors, 0 warnings. About 20 frames looked at on contact sheets.

## Changed after the first look

- The empty fee bar outline showed during "someone trades."; it now appears with the first share on the drop (b32).
- "usdc" sat too far from the fuel number; spacing is now a fixed margin.

## Facts to confirm before posting

- The fuel number (20.00 ticking to 19.97) and "Orbit · orb" are illustrative. Nothing on screen is a live balance.
- The fee bar is the standard preset drawn to scale (creator 58.5, platform 27, rwagmi 10, agent 4.5 of the 1% fee) and labelled by name only; the buyback preset is deliberately absent.
- "one transaction" is about the launch call; the form sends a second transaction for the agent's first gas.
- "pause it any time: only the creator can" is `AgentGuardian.pauseAgent`; the button lives on the creator's profile page, not on the coin page.
- bootr.fun has to be open to the public when this is posted (go/no-go of 2026-11-04: software GO, treasury unfunded).
- Music is the RWAGMI film's future-bass bed (127.7 BPM): the two films share a song.
