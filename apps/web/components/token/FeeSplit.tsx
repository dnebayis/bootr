'use client';

import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { rwagmiLpLockerV3Abi } from '@/lib/abi/rwagmiLpLockerV3';
import { contracts } from '@/lib/contracts';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import type { RecipientKind, Token } from '@/lib/types';
import { Panel } from '@/components/ui/Panel';

const ORDER: RecipientKind[] = ['agent', 'creator', 'burn', 'platform'];
const LABEL: Record<RecipientKind, string> = { agent: 'Agent', creator: 'Creator', burn: 'Burn', platform: 'Platform' };
const FILL: Record<RecipientKind, string> = { agent: 'bg-chart-ink', creator: 'bg-chart-2', burn: 'bg-chart-3', platform: 'bg-chart-4' };

export type Split = Record<RecipientKind, number>;

function fromToken(t: Token): Split {
  return { agent: t.agentBps, creator: t.creatorBps, burn: t.burnBps, platform: t.platformBps };
}

function classify(recipient: string, t: Pick<Token, 'kernel' | 'creator' | 'burner'>): RecipientKind {
  const r = recipient.toLowerCase();
  if (r === t.kernel.toLowerCase()) return 'agent';
  if (t.burner && r === t.burner.toLowerCase()) return 'burn';
  if (r === t.creator.toLowerCase()) return 'creator';
  return 'platform';
}

/** RWAGMI's hook takes a static 1% swap fee in WETH: 90% to the coin's reward slots, 10% to RWAGMI. */
const SWAP_FEE_PCT = 1;
const SLOTS_SHARE = 0.9;
const RWAGMI_PCT = SWAP_FEE_PCT * (1 - SLOTS_SHARE);
/** Bootr's reward slots total 9000 bps; RWAGMI's 1000 bps slot is appended after them. */
const SLOTS_BPS = 9000;

/** Percent of trading volume with at least two decimals and no trailing zero past them: 0.045%, 0.27%, 0.10%. */
export function pctLabel(pct: number) {
  const s = pct.toFixed(3);
  return `${s.endsWith('0') ? s.slice(0, -1) : s}%`;
}

/**
 * A split's share of trading volume. Splits are relative: on-chain slot bps (sum 9000) and the launcher's preset
 * bps (sum 10000) both divide the 0.90% that reaches the reward slots.
 */
export function ofVolume(split: Split, k: RecipientKind) {
  const total = split.agent + split.creator + split.burn + split.platform;
  return total > 0 ? (split[k] / total) * SWAP_FEE_PCT * SLOTS_SHARE : 0;
}

/**
 * Fee split as a share of trading volume. Swappers pay 1% in WETH; the reward slots get 90% of it and RWAGMI 10%.
 * Shared with the /launch preview.
 */
export function SplitBar({ split }: { split: Split }) {
  const parts = ORDER.filter((k) => split[k] > 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-2 w-full overflow-hidden rounded-xs" role="img" aria-label="Fee split">
        {parts.map((k) => (
          <div
            key={k}
            className={`h-full ${FILL[k]} border-r border-canvas transition-[width] duration-[400ms] ease-out-quint`}
            style={{ width: `${(ofVolume(split, k) / SWAP_FEE_PCT) * 100}%` }}
          />
        ))}
        <div className="h-full flex-1 bg-hairline-strong" title="RWAGMI" />
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1.5">
        {parts.map((k) => (
          <div key={k} className="flex items-center gap-2">
            <dt className="flex items-center gap-1.5 text-caption text-mute">
              <span className={`size-2 rounded-[2px] ${FILL[k]}`} aria-hidden="true" />
              {LABEL[k]}
            </dt>
            <dd className="font-mono text-caption text-ink tabular">{pctLabel(ofVolume(split, k))}</dd>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <dt className="flex items-center gap-1.5 text-caption text-mute">
            <span className="size-2 rounded-[2px] bg-hairline-strong" aria-hidden="true" />
            RWAGMI
          </dt>
          <dd className="font-mono text-caption text-ink tabular">{pctLabel(RWAGMI_PCT)}</dd>
        </div>
      </dl>
      <p className="text-caption text-mute">
        Of trading volume. Swappers pay {pctLabel(SWAP_FEE_PCT)} in total: {pctLabel(SWAP_FEE_PCT * SLOTS_SHARE)} goes to the recipients above and{' '}
        {pctLabel(RWAGMI_PCT)} to RWAGMI, the launcher. Fees accrue in WETH, whichever side of the pool is traded.
      </p>
    </div>
  );
}

type Slot = { readonly recipient: Address; readonly bps: number };

/** Bootr's slots (the leading ones that total 9000 bps) classified by recipient; `null` if they don't add up. */
export function splitFromSlots(slots: readonly Slot[], t: Pick<Token, 'kernel' | 'creator' | 'burner'>): Split | null {
  const s: Split = { agent: 0, creator: 0, burn: 0, platform: 0 };
  let sum = 0;
  for (const slot of slots) {
    if (sum >= SLOTS_BPS) break;
    sum += Number(slot.bps);
    s[classify(slot.recipient, t)] += Number(slot.bps);
  }
  return sum === SLOTS_BPS ? s : null;
}

export function FeeSplit({ token }: { token: Token }) {
  const locker = contracts.lpLocker;
  const read = useReadContract({
    address: locker ?? undefined,
    abi: rwagmiLpLockerV3Abi,
    functionName: 'launchInfo',
    args: [token.id as Address],
    chainId: appChain.id,
    query: { enabled: !env.useMock && !!locker, staleTime: Infinity, retry: 0 },
  });

  const onChain = read.data ? splitFromSlots(read.data.rewards, token) : null;
  const split = onChain ?? fromToken(token);
  const source: 'chain' | 'indexer' = onChain ? 'chain' : 'indexer';

  return (
    <Panel
      title="Locked fee split"
      action={<span className="font-mono text-micro text-mute">{source === 'chain' ? 'READ FROM LP LOCKER' : 'FROM INDEXER'}</span>}
    >
      <SplitBar split={split} />
      <p className="mt-3 text-caption text-mute">
        Set at launch and locked in RWAGMI&rsquo;s LP locker (RwagmiLpLockerV3). Nobody, including Bootr, can change it for this coin.
        {split.burn > 0 ? ' The burn share is claimed in WETH by the coin\u2019s burner, which buys this coin back and burns it.' : ''}
      </p>
    </Panel>
  );
}
