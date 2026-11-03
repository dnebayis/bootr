# bootr is live: spec

Goal: a stranger who sees this for 33 s knows what bootr is: launch a coin, it gets an agent (wallet, x account, a share
of the fee), you set its job, the agent pays for its own thinking, you stay in control. No token, no buyback, no price,
no URL, no address, no date.

## Grid

Music: `assets/audio/bed-sky.mp3`, the future-bass trailer bed of the RWAGMI film (127.7 BPM, beat(k) = k x 0.46985 s,
drop on beat 4, drum break beats 30-32, outro from beat 60, 33 s). One clip, rate 1.0. Effects peak-aligned one frame after
the picture (`build_index.py`). 32.9 s.

## FACTS (every on-screen line mapped to the product)

| On screen | Source |
| --- | --- |
| every coin gets an agent | README: "Every coin gets an autonomous agent with its own X account" |
| its own wallet | the kernel, a ZeroDev smart account created by `BootrLauncher.launch` |
| its own x account | launch form step 05, OAuth; `docs/design/agent-launch-v2.md` |
| its own fee share | the agent slot of the 1% fee (README fee model) |
| launch form rows: coin, kind, powers, cadence, x account, fuel | `docs/design/agent-launch-v2.md` decision 1; kind researcher is a template, powers and cadence from `packages/shared/src/workers.ts` |
| "Orbit · orb", "20 usdc" | illustrative example values (20 usdc is the fuel the launch copy in `brand/launch/ANNOUNCEMENT.md` uses) |
| one transaction | README: "A launch is one transaction" (the form also sends a gas deposit after it; the film says "one transaction" about the launch) |
| 1% of every trade, split at launch, locked | README fee model: static 1.00% fee, slots locked, no function to change recipients |
| bar: creator 58.5, platform 27, rwagmi 10, agent 4.5 (shares of the 1% fee, drawn to scale, labelled by name only) | README fee table (standard preset: 585 / 270 / 100 / 45 of the 1%) |
| the agent pays for its own thinking, fuel 20.00 ticking down, "fuel gone, it sleeps." | `docs/gas-model.md`, supervisor `tick.ts` (sleeps below 1 USDC), x402 spender payments; the tick amounts are illustrative |
| pause it any time: only the creator | `AgentGuardian.pauseAgent` creator-only; button in `ProfileView.tsx` |
| change its job: instructions, powers, cadence | creator console (`CreatorConsole.tsx`, supervisor config API) |
| watch all of it: posts, claims, swaps, sleeps | activity tape (`apps/supervisor/src/activity.ts`) |

## Shot list (b = beat, 0.46985 s)

- P1 dark, b0-12: frame 0 already shows "every coin gets" (144 px). Riser into the drop; b4 "an agent." types in with an impact and a jolt. b5.5 / b6.8 / b8.1 "its own wallet." / "its own x account." / "its own fee share."
- P2 white, b12-28: circle flood from "an agent.". b12.5 "you set its job." Six rows (label mute, value dark, mono) on b13-b18: coin Orbit · orb / kind researcher / powers read x, reply, post, research / cadence every 4 h / x account connected / fuel 20 usdc. b20 the launch button (Base blue) lands, a cursor travels to it, click b23 (rebound), b24 "one transaction."
- P3 dark, b28-48: wipe from the right. b29 "someone trades." The music break (b30-32) holds still. b32 drop: the fee bar draws, one segment a beat: creator b32, platform b33, rwagmi b34, agent b35 (accent). b36 "1% of every trade. locked." b40 bar and title leave; b40.5 "the agent pays for its own thinking."; fuel readout 20.00 usdc ticks to 19.97 at b42.5; b44.5 "fuel gone, it sleeps."
- P4 white, b48-60: circle flood from the readout. b48.5 "you stay in control." Rows b49.5 / b52.5 / b55.5: "pause it any time." (only the creator can.) / "change its job." (instructions, powers, cadence.) / "watch all of it." (posts, claims, swaps, sleeps.)
- P5 dark, b60-70: circle flood; the mark is cut out and slams on b62, slides left, "bootr" is typed. Hold about 2.4 s while the music fades.

## Banned

$BOOTR, the buyback preset, any price, cap, address, date or url, the word "token" as a pitch, return language, emoji,
exclamation marks, "locked" about the agent's job (only the fee split is locked).
