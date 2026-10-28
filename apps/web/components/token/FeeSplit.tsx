'use client';

import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { rwagmiLpLockerV3Abi } from '@/lib/abi/rwagmiLpLockerV3';
import { contracts } from '@/lib/contracts';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { ofVolume, pctLabel, RWAGMI_PCT, SLOTS_SHARE, splitFromSlots, SWAP_FEE_PCT, type Split } from '@/lib/fee-split';
import type { RecipientKind, Token } from '@/lib/types';
import { Panel } from '@/components/ui/Panel';

const ORDER: RecipientKind[] = ['agent', 'creator', 'burn', 'platform'];
const LABEL: Record<RecipientKind, string> = { agent: 'Agent', creator: 'Creator', burn: 'Burn', platform: 'Platform' };
const FILL: Record<RecipientKind, string> = { agent: 'bg-chart-1', creator: 'bg-chart-2', burn: 'bg-chart-3', platform: 'bg-chart-4' };

function fromToken(t: Token): Split {
  return { agent: t.agentBps, creator: t.creatorBps, burn: t.burnBps, platform: t.platformBps };
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
