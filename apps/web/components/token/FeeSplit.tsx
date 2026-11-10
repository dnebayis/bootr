'use client';

import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { rwagmiLpLockerV3Abi } from '@/lib/abi/rwagmiLpLockerV3';
import { contracts } from '@/lib/contracts';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { BOOTR_FEE, feeModelOf, launcherName, launcherPct, ofVolume, pctLabel, slotsShare, splitFromSlots, swapFeePct, traderPaysPct, type FeeModel, type Split } from '@/lib/fee-split';
import type { RecipientKind, Token } from '@/lib/types';
import { Panel } from '@/components/ui/Panel';

const ORDER: RecipientKind[] = ['agent', 'creator', 'burn', 'platform'];
const LABEL: Record<RecipientKind, string> = { agent: 'Agent', creator: 'Creator', burn: 'Burn', platform: 'Platform' };
const FILL: Record<RecipientKind, string> = { agent: 'bg-chart-1', creator: 'bg-chart-2', burn: 'bg-chart-3', platform: 'bg-chart-4' };

function fromToken(t: Token): Split {
  return { agent: t.agentBps, creator: t.creatorBps, burn: t.burnBps, platform: t.platformBps };
}

/** One sentence on what a trader pays and where it goes, for the coin's fee model. */
export function feeSentence(fee: FeeModel): string {
  const total = pctLabel(traderPaysPct(fee));
  if (fee.source === 'clanker-v5') {
    return `Of trading volume. A ${total} tax on every trade: Clanker keeps its share (${pctLabel(launcherPct(fee))}), the rest goes to the recipients above. Fees arrive as ETH; a burn share is taken in the coin itself and sent to the dead address.`;
  }
  if (fee.source === 'clanker') {
    return `Of trading volume. The swap fee is ${pctLabel(swapFeePct(fee))}, all of it to the recipients above, plus 20% on top for Clanker (${pctLabel(launcherPct(fee))}): a trader pays ${total} in total. Fees arrive as WETH; a burn share arrives as the coin itself, sent to the dead address.`;
  }
  return `Of trading volume. Swappers pay ${total} in total: ${pctLabel(swapFeePct(fee) * slotsShare(fee))} goes to the recipients above and ${pctLabel(launcherPct(fee))} to RWAGMI, the launcher. Fees accrue in WETH, whichever side of the pool is traded.`;
}

/**
 * Fee split as a share of trading volume, over everything a trader pays: the reward slots, then the launcher's part
 * (RWAGMI's 10% within the 1% fee, Clanker's 20% on top of a v4 coin's fee, or Clanker's share inside a v5 coin's tax).
 * Shared with the /launch preview.
 */
export function SplitBar({ split, fee = BOOTR_FEE }: { split: Split; fee?: FeeModel }) {
  const parts = ORDER.filter((k) => split[k] > 0);
  const total = traderPaysPct(fee);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-2 w-full overflow-hidden rounded-xs" role="img" aria-label="Fee split">
        {parts.map((k) => (
          <div
            key={k}
            className={`h-full ${FILL[k]} border-r border-canvas transition-[width] duration-[400ms] ease-out-quint`}
            style={{ width: `${(ofVolume(split, k, fee) / total) * 100}%` }}
          />
        ))}
        <div className="h-full flex-1 bg-hairline-strong" title={launcherName(fee)} />
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1.5">
        {parts.map((k) => (
          <div key={k} className="flex items-center gap-2">
            <dt className="flex items-center gap-1.5 text-caption text-mute">
              <span className={`size-2 rounded-[2px] ${FILL[k]}`} aria-hidden="true" />
              {LABEL[k]}
            </dt>
            <dd className="font-mono text-caption text-ink tabular">{pctLabel(ofVolume(split, k, fee))}</dd>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <dt className="flex items-center gap-1.5 text-caption text-mute">
            <span className="size-2 rounded-[2px] bg-hairline-strong" aria-hidden="true" />
            {launcherName(fee)}
          </dt>
          <dd className="font-mono text-caption text-ink tabular">{pctLabel(launcherPct(fee))}</dd>
        </div>
      </dl>
      <p className="text-caption text-mute" data-testid="fee-sentence">
        {feeSentence(fee)}
      </p>
    </div>
  );
}

export function FeeSplit({ token }: { token: Token }) {
  const fee = feeModelOf(token);
  const bootr = fee.source === 'bootr';
  const v5 = fee.source === 'clanker-v5';
  const locker = contracts.lpLocker;
  // The on-chain slots are read from RWAGMI's locker on the Bootr path; Clanker coins show the indexer's copy.
  const read = useReadContract({
    address: locker ?? undefined,
    abi: rwagmiLpLockerV3Abi,
    functionName: 'launchInfo',
    args: [token.id as Address],
    chainId: appChain.id,
    query: { enabled: bootr && !env.useMock && !!locker, staleTime: Infinity, retry: 0 },
  });

  const onChain = bootr && read.data ? splitFromSlots(read.data.rewards, token, fee) : null;
  const split = onChain ?? fromToken(token);
  const source: 'chain' | 'indexer' = onChain ? 'chain' : 'indexer';

  return (
    <Panel
      title="Locked fee split"
      action={<span className="font-mono text-micro text-mute">{source === 'chain' ? 'READ FROM LP LOCKER' : 'FROM INDEXER'}</span>}
    >
      <SplitBar split={split} fee={fee} />
      <p className="mt-3 text-caption text-mute">
        {bootr
          ? 'Set at launch and locked in RWAGMI’s LP locker (RwagmiLpLockerV3). Nobody, including Bootr, can change it for this coin.'
          : v5
            ? 'Set at launch and locked in the coin’s Clanker pool. Nobody, including Bootr, can change it for this coin.'
            : 'Set at launch and locked in Clanker’s LP locker. Nobody, including Bootr, can change it for this coin.'}
        {split.burn > 0
          ? bootr
            ? ' The burn share is claimed in WETH by the coin’s burner, which buys this coin back and burns it.'
            : v5
              ? ' Clanker takes the burn share in this coin on every trade and sends it to the dead address.'
              : ' The locker turns the burn share into this coin and sends it to the dead address, so it is out of circulation as soon as it is collected.'
          : ''}
      </p>
    </Panel>
  );
}
