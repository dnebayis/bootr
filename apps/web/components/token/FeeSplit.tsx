'use client';

import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { lpLockerAbi } from '@/lib/abi/lpLocker';
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

function classify(recipient: string, t: Token): RecipientKind {
  const r = recipient.toLowerCase();
  if (r === t.kernel.toLowerCase()) return 'agent';
  if (t.burner && r === t.burner.toLowerCase()) return 'burn';
  if (r === t.creator.toLowerCase()) return 'creator';
  return 'platform';
}

/** Percent of trading volume, e.g. 2000 bps of a 1% LP fee -> "0.20%". */
function ofVolume(bpsOfFee: number, lpFeeBps: number) {
  return `${((bpsOfFee / 10000) * (lpFeeBps / 10000)).toFixed(2)}%`;
}

/**
 * Fee split as a share of trading volume. The LP fee (default 1%) is split in full between the
 * recipients; Clanker's protocol fee is 20% of the LP fee charged ON TOP (swappers pay 1.2%).
 * Shared with the /launch preview.
 */
export function SplitBar({ split, lpFeeBps = 10_000 }: { split: Split; lpFeeBps?: number }) {
  const parts = ORDER.filter((k) => split[k] > 0);
  const gross = 1.2; // LP fee + 20% Clanker on top, in units of the LP fee
  const clankerBps = 2000; // 20% of the LP fee
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-2 w-full overflow-hidden rounded-xs" role="img" aria-label="Fee split">
        {parts.map((k) => (
          <div
            key={k}
            className={`h-full ${FILL[k]} border-r border-canvas transition-[width] duration-[400ms] ease-out-quint`}
            style={{ width: `${(split[k] / 10000 / gross) * 100}%` }}
          />
        ))}
        <div className="h-full flex-1 bg-hairline-strong" title="Clanker, on top" />
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1.5">
        {parts.map((k) => (
          <div key={k} className="flex items-center gap-2">
            <dt className="flex items-center gap-1.5 text-caption text-mute">
              <span className={`size-2 rounded-[2px] ${FILL[k]}`} aria-hidden="true" />
              {LABEL[k]}
            </dt>
            <dd className="font-mono text-caption text-ink tabular">{ofVolume(split[k], lpFeeBps)}</dd>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <dt className="flex items-center gap-1.5 text-caption text-mute">
            <span className="size-2 rounded-[2px] bg-hairline-strong" aria-hidden="true" />
            Clanker
          </dt>
          <dd className="font-mono text-caption text-ink tabular">
            {ofVolume(clankerBps, lpFeeBps)} <span className="text-mute">on top</span>
          </dd>
        </div>
      </dl>
      <p className="text-caption text-mute">
        Of trading volume. Swappers pay {((lpFeeBps / 10000) * gross).toFixed(2)}%: the {(lpFeeBps / 10000).toFixed(2)}% LP fee goes to the recipients
        above in full; Clanker&rsquo;s 20% protocol fee is charged on top of it.
      </p>
    </div>
  );
}

export function FeeSplit({ token }: { token: Token }) {
  const read = useReadContract({
    address: contracts.lpLocker,
    abi: lpLockerAbi,
    functionName: 'tokenRewards',
    args: [token.id as Address],
    chainId: appChain.id,
    query: { enabled: !env.useMock, staleTime: Infinity, retry: 0 },
  });

  let split = fromToken(token);
  let source: 'chain' | 'indexer' = 'indexer';
  if (read.data && read.data.rewardBps.length > 0) {
    const s: Split = { agent: 0, creator: 0, burn: 0, platform: 0 };
    read.data.rewardRecipients.forEach((r, i) => {
      s[classify(r, token)] += Number(read.data.rewardBps[i] ?? 0);
    });
    if (s.agent + s.creator + s.burn + s.platform === 10000) {
      split = s;
      source = 'chain';
    }
  }

  return (
    <Panel
      title="Locked fee split"
      action={<span className="font-mono text-micro text-mute">{source === 'chain' ? 'READ FROM LP LOCKER' : 'FROM INDEXER'}</span>}
    >
      <SplitBar split={split} lpFeeBps={token.lpFeeBps || 10_000} />
      <p className="mt-3 text-caption text-mute">
        Set at launch and locked in Clanker&rsquo;s LP locker (ClankerLpLockerFeeConversion). Nobody, including Bootr, can change it for this coin.
        {split.burn > 0 ? ' The burn share is converted to this coin by the locker and burned.' : ''} Fees are not collected during the first two minutes
        after launch.
      </p>
    </Panel>
  );
}
