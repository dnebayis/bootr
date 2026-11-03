# the commitment: spec

Goal: show that an agent's job is committed on-chain at launch (a hash), what the supervisor does with it, and what
stays editable afterwards. No claim that the job is locked: edits after launch are real and visible.

## Grid

Music: `assets/audio/bed-leash.mp3` (124.0 BPM, phase 0.06 s), reused from the leash film. beat(k) = 0.06 + k x 0.48387.
29 s or less. Effects peak-aligned one frame after the picture (`build_index.py`).

## FACTS (every on-screen line mapped to code)

| On screen | Source |
| --- | --- |
| powers: read x, reply on x, post on x; always on: memory, treasury | `CAPABILITIES`, `ALWAYS_ON_CAPABILITIES` in `packages/shared/src/workers.ts` |
| cadence every 4 h | `CADENCE_OPTIONS` (30 min to 24 h), `WORKER_BOUNDS` |
| two job lines | `WORKER_BOUNDS.maxJobLines` = 4, 240 chars each |
| hash `0xb7b8...0058` | keccak256 of the canonical JSON `{id:"custom",version:1,preset:{capabilities,postIntervalMs:14400000,identity}}`, computed with viem (full hash 0xb7b837d4...ba0058) |
| edited card `0xeee8...925d` | same JSON with `postIntervalMs: 1800000` (full hash 0xeee892c2...c925d) |
| launch(workerHash), AgentLaunched event | `BootrLauncher.sol` (`LaunchParams.workerHash`, `emit AgentLaunched(..., p.workerHash, ...)`) |
| indexer stores it | `apps/indexer/ponder.schema.ts` (`workerHash: t.hex().notNull()`) |
| "mined once, it cannot change" | the hash is only an event argument in a mined transaction; the contract keeps no mutable copy |
| card edited, hash differs, `worker_hash_mismatch`, default template runs | `resolveWorker` and `warnWorkerFallback` in `apps/supervisor/src/onboarding.ts` |
| card equal to the hash: applied | `resolveWorker` returns `{id: 'custom', preset}` |
| "Config updated: cadence" rows | `apps/supervisor/src/activity.ts` (`Config updated: ${fields.join(', ')}`) |
| edited once / edited 3 times | `editedLabel` in `apps/web/components/token/CreatorConsole.tsx` |
| the on-chain hash stays the launch-time commitment | `docs/design/agent-launch-v2.md` decision 6, `agent-config.ts` header |

## Shot list (b = beat; as built)

- C1 dark, b0-12: title "you pick the job." on screen from frame 0. Five mono rows, one per beat from b1: powers, always on, cadence, job, job. b6.2 `keccak256 =`; b7 the hash types in (impact); b8.5 "the job, as one value."
- C2 white, b12-22: title "the hash goes on-chain." Rows b13 / b14.5 / b16: `launch` (in the launch transaction), `AgentLaunched` (in the event, public), `indexer` (stored with the coin), each with the blue hash chip. b17.5 "it is mined once. it cannot change."
- C3 dark, b22-36: title "the agent runs what hashes to it." Left card (card as launched) b23: cadence every 4 h, hash, on-chain hash; b26 "hash equal. applied." (ping). Right card (card edited) b28: cadence every 30 min, hash differs; b31.5 `worker_hash_mismatch` (red, with text, jolt); b33 "the default template runs."
- C4 white, b36-45: title "after launch, edits are visible." Rows b37 / b38.3 / b39.6: Config updated: cadence / instructions / cadence, powers, each with its counter (edited once / 2 times / 3 times). b40.5 "the launch-time hash stays on-chain."
- C5 dark, b45-55: "the job is committed at launch." (b45.3), "every change after it is on the tape." (b47); mark impact b53, slides left, "bootr" typed. Total 28.6 s.

## Banned

No URL, no slogan beyond the two end lines, no price, no addresses, no emoji, no exclamation marks, no "locked" or "immutable job".
