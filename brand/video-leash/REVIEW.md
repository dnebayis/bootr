# the leash: review (2026-11-02)

Render: `renders/the-leash.mp4`, 1920 x 1080, 30 fps, 29.0 s, h264 + aac.
Check (`npm run check`): lint, runtime, layout, motion, contrast (30/30 AA), craft, audio all at 0 errors, 0 warnings.
Sound measured, not heard: integrated -15.0 LUFS, loudness range 3.6 LU, true peak -1.5 dBFS.
Frames looked at: 0, 2.2, 4.5, 6.5, 8, 9.3, 10.3, 12, 13.8, 15.5, 17.2, 18.5, 20, 22, 24, 26.5, 27.8, 28.8.

## Changes made after the first check
- Result lines were visible for 0.3 s: attempts now run on a 4-beat cycle, the old result stays until the next hit, and the
  explanations are 3-4 words. Two attempts (usdc to another wallet, eth value) were cut: the notes on the list scene say them.
- The call-policy label was crossed by the gate: the gate halves are 200 px instead of 280 px.
- The first scene had two titles in 6 beats: one title stays, the key's own label says what it is.

## Facts to confirm before posting
- **50 usdc a day, 60 calls an hour, 30 days** are the supervisor defaults (`apps/supervisor/src/config.ts`,
  `docs/deploy/mainnet.md` lists `SESSION_USDC_TRANSFER_CAP=50000000`). If production overrides them, the film and the tweet are wrong.
  The 0.1 eth gas allowance (`SESSION_GAS_ALLOWANCE_WEI`) is not on screen on purpose.
- The attempts are illustrative: they are built from the rules (`BootrCallPolicy`, `BootrSwapHelper`), not recorded from a live agent.
  The "50 / 50" meter shows the cap used up, a hypothetical state. No contract address, balance or price is shown.
- "the creator pauses it": `AgentGuardian.pauseAgent` is creator-only and the session path reverts `AgentIsPaused`.
  "the platform revokes it": `revokeAllSessionKeys` / `revokeAllSessionKeysBatch` are `onlyOwner` (platform admin).
- Keys installed before layout v3 have no `WETH.withdraw` rule (six calls need layout v3, `docs/gas-model.md`); a key on layout 2
  has five. Rotation installs the current layout.
- The music is a catalog track (124.0 BPM) that was fitted, not recomposed; every hit is on a beat.
