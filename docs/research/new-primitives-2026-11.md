# New primitives Bootr could add: research, 2026-11-05

Research is finished and nothing was changed: no project files written, nothing signed or sent. The only Bootr calls were public reads. The market offers little proven demand, so my top 3 are Agent Lens, Agent Log and Attach-an-Agent, and most popular ideas are rejected.

**Baseline** (Bootr indexer, 5 Nov): 7 coins, 2 agents awake, best treasury $664, 0 ERC-8004 feedback. Anything needing a fleet is premature.

Marks: V = page read this session; U = search snippet only. V does not mean the underlying figure was audited.

## Live versus announced
- **ERC-8004, live, polluted:** on Base, 90.6% of reviewers are Sybil-flagged and at most 0.6% of feedback has payment proof (to May) [1V]. Validation Registry status conflicts [2V].
- **x402, live, thin:** public counter looks frozen; Visa/Artemis cut $135.7M to $15.0M; $367,950 in one August week [3V, secondary].
- **Virtuals ACP, collapsed:** 814,185 jobs in March, 6,918 jobs and $50 inflow in September; no incentive epochs listed after March [4V].
- **ERC-8183:** Draft in March; hooks claimed on Base, no usage figures [5V].
- **Bankr, documented as operating:** Glidepath [6V], index tokens [7V], stock pairs [8V].
- **Agent performance bonds:** only proposals and a testnet hook found [9U].

## Ranked primitives

**1. Agent Lens (S).** One read returns the coin-agent binding, policy, caps and worst-case daily loss if keys leak.
- Users: wallets, explorers, launchpads; free integration, Bootr gains distribution after a $204k injection incident [10V].
- Existing: Coinbase limits are server-side [11V]; no public on-chain figure found.
- Reuse: `packages/contracts/src/BootrCallPolicy.sol` (`rulesOf`, `windowOf`), `AgentGuardian.sol` (`agentInfo`).
- Risk: false comfort. Must disclose the shared session signer, `SPENDER_MASTER_KEY` and the dormancy sweep.
- Test: fork-drain each of 7 agents, figure holds within 1%; one outside consumer in 30 days.

**2. Agent Log (S contract, M service).** Append-only job revisions and daily receipt roots, extending the launch-only `workerHash`.
- Users: holders, evaluators, grant reviewers; proves history was not edited, not honest execution.
- Existing: discussion with no replies, Sepolia demo [12V].
- Reuse: `apps/supervisor/src/db/schema.ts` (`sv_actions`, `sv_treasury_ops`), `agent-config.ts`.
- Risk: supervisor is sole author; X deletion duties require salted hashes.
- Test: anchor $BOOTR 14 days; outside script verifies random receipts and catches one edited row.

**3. Attach-an-Agent (M).** Consent-proved agent for an existing coin, funded by fuel or a redirected reward slot.
- Users: coin teams with fee income; inference margin pays Bootr.
- Existing: Virtuals, with $VIRTUAL pairing, uptake unstated [13V].
- Reuse: `BootrLaunchGate.sol`, `registerAgent`, `IClanker.sol` `updateRewardRecipient`.
- Risk: impersonation (require admin signature); X AI-reply approval [14, repo note marks it verified; page 403 today].
- Test: pitch 20 Clanker coins; 3 signed commitments before any contract.

**4. Behaviour Score (S).** Open formula from events only: claims, spend, runway, pauses, key rotation, job edits.
- Users: escrow evaluators, sponsors, directories.
- Existing: reputation-gating hooks claimed [15V].
- Reuse: `apps/indexer/src/reputation.ts`, `/treasury`, `apps/supervisor/src/fuel.ts` (currently private).
- Risk: self-funded gaming; reads as an endorsement. Publish components only; never gate money.
- Test: hand-label 50 Base agents; drop if rank correlation is under 0.5.

**5. Policy Kit (S-M).** SDK for the ownerless policy plus the documented ERC-1271 pitfall.
- Users: launchpads, Kernel teams.
- Existing: Smart Sessions [16U]; ERC-7715 still Draft [17V].
- Reuse: `BootrCallPolicy.sol`, `BootrSwapHelper.sol`, `apps/supervisor/src/session-key.ts`.
- Risk: Kernel v3.1 specificity, support, implied assurance.
- Test: one outside mainnet install from 10 pitches in 45 days.

**6. Job Ballot (S).** Holders sign for one of several creator-hashed job cards; no free text, never money.
- Users: communities wanting a voice. Nothing live found.
- Reuse: `resolveWorker` in `onboarding.ts`, `packages/shared/src/workers.ts`.
- Risk: $70k cap makes capture cheap; voting worsens the securities picture.
- Test: one $BOOTR ballot; 50 of 447 holders sign, else drop.

**7. Rule-based Exit Vault (M-L).** Public, committed creator sale envelope, no AI.
- Users: creators signalling restraint. Existing: Glidepath [6V].
- Reuse: `BootrSwapHelper.sol` pattern.
- Risk: no on-chain price for fresh coins (BOOTR-03), sandwiching, audit cost.
- Test: 3 creators commit 1% before code.

**8. Liveness Bond (M).** Creator, not treasury, locks USDC; a missed anchor routes it to the agent's fuel, never holders.
- Users: creators proving commitment. Depends on 2.
- Reuse: `AgentGuardian.sol` `Activity`, `dormantAt`.
- Risk: heartbeat farming, new custody.
- Test: 2 creators lock $50 in a manual Safe.

## Top 3
1. **Lens:** smallest work, no counterparties needed, and it makes bounded loss checkable.
2. **Log:** today's commitment covers launch only; feeds 4 and 8.
3. **Attach:** the only item with possible paying users, testable without code.

## Rejected
- **Bonding the treasury:** $664 at best, needs a judge, the session key has no such rule.
- **Agent hiring, ERC-8183 markets:** ACP's collapse, two awake agents.
- **Shared index:** one coin has real volume; Bankr got there [7V].
- **Prediction markets on agents:** none found; coverage is agents trading markets [18U]; metrics are manipulable.
- **TEE:** Phala's sample targets Sepolia [19U]; inference runs at OpenRouter, so an enclave proves little.
- **Succession market:** `AgentInfo.creator` has no setter; X accounts stay with the owner.
- **Creator-coin mechanics:** Zora volume down 99.8% [20U].
- **Stock pairs, v4 hooks, on-chain memory [21U]:** no Bootr-specific value.
- **Revenue share:** staff FAQ excludes central parties [22V]; the owner-only `swapAndBurn` needs counsel review.
- **Hype:** registration counts (263,164 in one day) [2V], cumulative aGDP [4V], x402 headlines [3V].

## Not found
Current ERC-8183 volumes; Validation Registry usage; x402 buyer data per service; token-gated agents with users; agent index TVL; intent systems for agents (barely searched); Builder Codes figures; sec.gov FAQ text; Coinbase's own page (403).

## Sources
1 https://arxiv.org/html/2606.26028
2 https://stablecoininsider.org/erc-8004/
3 https://www.danielmcglynn.com/the-x402-counter-has-shown-the-same-four-numbers-since-march/
4 https://chainward.ai/decodes/virtuals-top-dog
5 https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902?page=2
6 https://docs.bankr.bot/token-launching/glidepath/
7 https://docs.bankr.bot/token-launching/index-tokens
8 https://docs.bankr.bot/token-launching/overview/
9 https://github.com/Epta-Node/ai-net/issues/834
10 https://metamask.com/news/crypto-security-report-may-2026
11 https://eco.com/support/en/articles/14845485-coinbase-agentic-wallets-explained
12 https://ethereum-magicians.org/t/execution-receipts-for-ai-agents-off-chain-evidence-on-chain-roots-and-verifiable-session-proofs/28737
13 https://whitepaper.virtuals.io/about-virtuals/capital-formation-layer/launch-as-an-existing-token
14 https://help.x.com/en/rules-and-policies/x-automation
15 https://www.quicknode.com/blog/erc-8183-agentic-commerce
16 https://erc7579.com/tooling/module-sdk/modules/smart-sessions
17 https://eips.ethereum.org/EIPS/eip-7715
18 https://www.coindesk.com/tech/2026/03/15/ai-agents-are-quietly-rewriting-prediction-market-trading
19 https://github.com/Phala-Network/erc-8004-tee-agent
20 https://beincrypto.com/jesse-pollak-base-zora-social-bet/
21 https://blockeden.xyz/blog/2026/04/18/walrus-protocol-ai-agent-memory-layer-sui-decentralized-storage/
22 https://unchainedcrypto.com/the-secs-buyback-guidance-is-narrower-than-it-looks-does-yours-pass-the-test/
