# the commitment: review

Render: `renders/the-commitment.mp4`, 28.6 s, 1920x1080, 30 fps, -16.0 LUFS, LRA 3.6 LU, true peak -1.9 dBFS (measured with ffmpeg ebur128; the sound was measured, not listened to).
`npm run check`: 0 errors, 0 warnings. 12 frames looked at on contact sheets.

## Changed after the first check

- Title on screen from frame 0 (first_frame_empty); the five rows no longer dim, so each line stays up long enough to read.
- C2 and C4 rows 1.3-1.5 beats apart with the notes earlier; C4 note shortened to "the launch-time hash stays on-chain." (the longer sentence could not be held long enough); mark moved one beat later so the second end line is readable.
- C2 and C4 rows enlarged (the lower half was empty).

## Facts to confirm before posting

- The contract only emits the hash (`AgentLaunched`); it never reads it. The check is the supervisor's (`resolveWorker`), and it runs when the agent is registered, with the default template as the fallback. The film never says "the contract checks".
- "Mined once, it cannot change" is true of the event; it says nothing about the agent card, which the creator hosts.
- The demo preset (read x, reply, post, 4 h, two job lines) is illustrative. Both hashes are real: keccak256 of its canonical JSON (0xb7b837d4...ba0058) and of the same JSON with a 30 minute cadence (0xeee892c2...c925d), computed with viem on 2026-11-03.
- Counters ("edited once / 2 times / 3 times") follow `editedLabel`; the tape rows follow `Config updated: <fields>`. Which fields exist (cadence, instructions, powers) is from `agent-config.ts`.
- Music is the leash film's bed (124.0 BPM, phase 0.06 s), reused.
