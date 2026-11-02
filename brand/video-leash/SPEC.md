GOAL:    After 29 s a viewer knows what an agent's session key can and cannot do: six allow-listed calls, fee claims that can
         only land in the kernel, USDC only to the agent's own spender under a daily cap, a swap helper with an oracle floor,
         and three ways to stop the key. Feeling: dry, precise, a mechanism that always says no.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps, 29.0 s = 870 frames.
TIME:    Music: catalog "dark minimal techno, 124 BPM, sub-bass, mechanism clicks, dark synth motif" (30 s, ends ~29 s).
         Fitted 124.0 BPM, phase 0.06 s: beat(k) = 0.06 + k x 0.48387 s (14.5 frames), bar 1.935 s. One clip, rate 1.0,
         flat energy (no drop): every hit of the picture sits on a beat. Effects peak-aligned one frame after the picture.
LOOK:    Bootr house. Dark #0a0b0d, white #fff, hairlines #32353d / #dee1e7, mute #818895 / #5b616e, Geist 600 titles
         (-0.04em), Geist 500 body, Geist Mono 500 for identifiers. Dark accent Cerulean #3c8aff = "allowed"; Red #fc401f on
         dark = "failed", always next to the word PolicyFailed (colour never the only signal). On white: Base Blue #0000ff,
         ink #0a0b0d. No gradients, no glow, no shadows, no grain, no emoji.
FACTS:   Every line on screen maps to the code (source of truth in brackets).
         The six calls [apps/supervisor/src/session-key.ts callPolicyRules, layout v3]:
           1 RwagmiLpLockerV3.settleAndClaim(ids, currency, to)  arg 2 `to` == kernel
           2 RwagmiLpLockerV3.claimQuote(currency, to)           arg 1 `to` == kernel
           3 WETH.approve(spender, amount)                       arg 0 spender == BootrSwapHelper
           4 BootrSwapHelper.swapWethToUsdc(amountIn, maxSlippageBps)  pays ALL output USDC to msg.sender (the kernel)
           5 USDC.transfer(to, amount)                           `to` == the agent's spender EOA, SUM_PER_WINDOW <= 50 USDC / 86400 s
           6 WETH.withdraw(wad)                                  WETH9 pays msg.sender: ETH stays on the kernel (gas)
         Every call carries value 0; only single and batch call types match, delegatecall fails; a miss is
         SIG_VALIDATION_FAILED, shown by the kernel as PolicyFailed(i) [BootrCallPolicy.sol].
         Swap helper [BootrSwapHelper.sol]: floor = amountIn x Chainlink ETH/USD x (10000 - maxSlippageBps)/10000;
           maxSlippageBps <= 300, else revert SlippageTooHigh(requested, 300); feed must be < 1 h old.
         Other session limits [config.ts defaults, docs/deploy/mainnet.md]: RateLimitPolicy 60 per hour, GasPolicy 0.1 ETH
           cumulative, TimestampPolicy 30 days (rotated 3 days early), SESSION_USDC_TRANSFER_CAP 50 USDC per day.
         Stops [AgentGuardian.sol]: expiry (TimestampPolicy); creator `pauseAgent` (session path then reverts AgentIsPaused);
           owner (platform) `revokeAllSessionKeys` / `revokeAllSessionKeysBatch`, one transaction for any number of kernels.
         The spender is the only USDC recipient; x402 payments are signed by the spender, not by the key.
SHOTS:   (b = beat)
         b0-6    L1 dark   "the agent holds the money." Treasury box (usdc, weth, eth) on frame 0, bars grow b0.7-b1.5.
                           b3 the session key slams in, a line draws to the box, label "session key".
         b6-18   L2 white  circle flood from the key. "it can make six calls." six rows b7-b12 (name + constraint).
                           b12.7 "60 calls an hour. 30 days." b13.6 "zero eth value. no delegatecall."
         b18-38  L3 dark   the gate. Key tile left, "call policy" wall, kernel box right. Code line on top, result at the bottom.
                           A0 hit b20: claim to the kernel passes (ok, lands in the kernel). A1 b24: claim to another wallet,
                           the gate shuts, PolicyFailed (only the kernel). A2 b28: usdc.transfer(spender, 1) with the meter at
                           50 / 50, PolicyFailed (daily cap reached). A3 b32: swap at 10 % slippage passes the call policy,
                           b33.5 the "swap helper" wall shuts: SlippageTooHigh(1000, 300) (max 3% off chainlink).
         b38-47  L4 white  "and it can be stopped." three rows, each key - line - kernel, then a cut: it expires (30 days,
                           rotated 3 days early), the creator pauses it (a paused agent's calls revert), the platform revokes it
                           (every key, one transaction). Rows b39, b41, b43; cuts b40, b42, b44.
         b47-60  L5 dark   b47.3 "the agent holds the money." b49.3 "the key holds six calls." b54 the mark slams, slides left,
                           "bootr" typed. Music fades out over the last 0.6 s.
SOUND:   bed 1.0; key ticks on typing; chip whoosh on flights; ping on allowed; click + low impact on denials; pops on rows;
         whooshes on floods; impact on the mark.
BANNED:  a URL, slogan, contract address, price or return language, launch date; claims beyond the table above; emoji;
         anything centred except the end lockup; HUD chrome; floating small elements on a dark void.
QA:      f0 (treasury box on frame, not blank); b7-b12 rows readable; each result line stays until the next hit (>= 1.7 s);
         the 50 / 50 meter on A2; SlippageTooHigh(1000, 300) readable; end lockup; loudness and peaks measured.
