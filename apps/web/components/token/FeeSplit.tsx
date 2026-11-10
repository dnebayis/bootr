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
import { coinTradeSplits, pairedAssetByAddress } from '@/lib/token-settings';
import { shortAddr } from '@/lib/format';
import { V5SplitBar } from './V5SplitBar';

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

/**
 * A Clanker v5 coin launched with creator-set settings: its own buy and sell tax, the split of each, the reward rows,
 * holder dividends, the paired asset and the two switches, all as the indexer reports them (`Token.v5Settings`).
 */
function V5SettingsSplit({ token, settings }: { token: Token; settings: NonNullable<Token['v5Settings']> }) {
  const { buy, sell } = coinTradeSplits(settings);
  const asset = pairedAssetByAddress(token.pairedToken)?.symbol ?? 'the paired asset';
  const rows = settings.rewards;
  const holding = BigInt(settings.minDividendHolding || '0') / 10n ** 18n;
  return (
    <Panel title="Locked fee split" action={<span className="font-mono text-micro text-mute">FROM INDEXER</span>}>
      <V5SplitBar buy={buy} sell={sell} asset={asset} />
      <dl className="mt-4 grid gap-px overflow-hidden rounded-sm border border-hairline bg-hairline text-caption" data-testid="v5-settings">
        {[
          ['Paired asset', asset],
          ['Buy tax · sell tax', `${pctLabel(buy.tax)} · ${pctLabel(sell.tax)}`],
          ['Agent · platform', `${settings.agentShareBps / 100}% · ${settings.platformShareBps / 100}% of the tax pool, locked`],
          ...(settings.dividendBps > 0 ? [['Holder dividends', `${settings.dividendBps / 100}% of the tax pool, to wallets holding ${holding.toLocaleString('en-US')}+ coins`]] : []),
          ...(settings.burnBps > 0 ? [['Burn', `${settings.burnBps / 100}% of the tax pool`]] : []),
          ['Sniper tax', settings.antiSnipe ? 'On at launch' : 'Off'],
          ['Image and metadata', !settings.metadataEditable ? 'Fixed at launch' : settings.metadataLocked ? 'Locked by the creator' : 'Editable by the creator'],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 bg-canvas px-3 py-1.5">
            <dt className="text-mute">{k}</dt>
            <dd className="text-right font-mono text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {rows.length > 0 ? (
        <div className="mt-3" data-testid="v5-reward-rows">
          <span className="text-caption font-medium text-ink">Creator funds</span>
          <ul className="mt-1 flex flex-col gap-0.5 text-caption">
            {rows.map((r, i) => (
              <li key={`${r.recipient}-${i}`} className="flex justify-between gap-3">
                <span className="font-mono text-body" title={`Recipient ${r.recipient}, admin ${r.admin}`}>
                  {shortAddr(r.recipient)}
                  {r.recipient.toLowerCase() === token.creator.toLowerCase() ? <span className="text-mute"> (creator)</span> : null}
                </span>
                <span className="font-mono text-ink tabular">
                  {pctLabel((buy.creatorFunds * r.bps) / 10_000)} of volume
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-3 text-caption text-mute">
        Set at launch and locked in the coin&rsquo;s Clanker pool: nobody, including Bootr, can change a tax or a share. Each creator-funds row&rsquo;s admin can change
        that row&rsquo;s recipient on Clanker; the agent&rsquo;s and the platform&rsquo;s rows cannot change.
      </p>
    </Panel>
  );
}

export function FeeSplit({ token }: { token: Token }) {
  if (token.source === 'clanker-v5' && token.v5Settings) return <V5SettingsSplit token={token} settings={token.v5Settings} />;
  return <PresetFeeSplit token={token} />;
}

function PresetFeeSplit({ token }: { token: Token }) {
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
