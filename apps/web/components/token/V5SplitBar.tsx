import { pctLabel } from '@/lib/fee-split';
import type { TradeSplit } from '@/lib/token-settings';

const PARTS: { key: Exclude<keyof TradeSplit, 'tax'>; label: string; fill: string }[] = [
  { key: 'agent', label: 'Agent', fill: 'bg-chart-1' },
  { key: 'creatorFunds', label: 'Creator funds', fill: 'bg-chart-2' },
  { key: 'dividends', label: 'Holder dividends', fill: 'bg-chart-3' },
  { key: 'burn', label: 'Burn', fill: 'bg-ink' },
  { key: 'platform', label: 'Platform', fill: 'bg-chart-4' },
];

/**
 * A Clanker v5 coin's tax with creator-set settings, as shares of trading volume: the agent, creator funds, holder
 * dividends, the burn and the platform, then Clanker's cut. One row per side when the buy and sell taxes differ. Shared by
 * the launch summary and the coin page's fee panel.
 */
export function V5SplitBar({ buy, sell, asset }: { buy: TradeSplit; sell: TradeSplit; asset: string }) {
  const same = buy.tax === sell.tax;
  const sides = same ? [{ label: null, t: buy }] : [{ label: 'Buy', t: buy }, { label: 'Sell', t: sell }];
  return (
    <div className="flex flex-col gap-3" data-testid="v5-split">
      {sides.map(({ label, t }) => (
        <div key={label ?? 'both'} className="flex flex-col gap-2">
          {label ? <span className="text-caption text-mute">{label}: {pctLabel(t.tax)} tax</span> : null}
          <div className="flex h-2 w-full overflow-hidden rounded-xs" role="img" aria-label={label ? `${label} tax split` : 'Tax split'}>
            {PARTS.filter((p) => t[p.key] > 0).map((p) => (
              <div key={p.key} className={`h-full ${p.fill} border-r border-canvas`} style={{ width: `${(t[p.key] / t.tax) * 100}%` }} />
            ))}
            <div className="h-full flex-1 bg-hairline-strong" title="Clanker" />
          </div>
          <dl className="flex flex-wrap gap-x-5 gap-y-1">
            {PARTS.filter((p) => t[p.key] > 0).map((p) => (
              <div key={p.key} className="flex items-center gap-2">
                <dt className="flex items-center gap-1.5 text-caption text-mute">
                  <span className={`size-2 rounded-[2px] ${p.fill}`} aria-hidden="true" />
                  {p.label}
                </dt>
                <dd className="font-mono text-caption text-ink tabular">{pctLabel(t[p.key])}</dd>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <dt className="flex items-center gap-1.5 text-caption text-mute">
                <span className="size-2 rounded-[2px] bg-hairline-strong" aria-hidden="true" />
                Clanker
              </dt>
              <dd className="font-mono text-caption text-ink tabular">{pctLabel(t.clanker)}</dd>
            </div>
          </dl>
        </div>
      ))}
      <p className="text-caption text-mute" data-testid="fee-sentence">
        Of trading volume. {same ? `A ${pctLabel(buy.tax)} tax on every buy and sell` : `A ${pctLabel(buy.tax)} tax on buys and ${pctLabel(sell.tax)} on sells`}: Clanker keeps its share, the rest
        goes to the recipients above. Fees, rewards and dividends are paid in {asset}; a burn share is taken in the coin itself and sent to the dead address.
      </p>
    </div>
  );
}
