'use client';

import { useQuery } from '@tanstack/react-query';
import { isAddress, type Address } from 'viem';
import type { MarketDetails } from '@/lib/server/quote-market';
import {
  allocatedPct,
  creatorFundsPct,
  creatorPoolBps,
  MIN_DIVIDEND_HOLDING,
  pairedAssetBySymbol,
  pairedAssetsFor,
  perTradeLines,
  type SettingsProblem,
  type TokenSettingsInput,
  type V5Bounds,
} from '@/lib/token-settings';
import { shortAddr, usd } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Input, Label, Switch } from '@/components/ui/Field';
import { cn } from '@/components/ui/cn';

/**
 * The launch form's "Token settings" for a Clanker v5 launch (docs/design/clanker-v5-token-settings.md), laid out like
 * Clanker's own deploy form: Tax (buy and sell tax, the allocation donut with the agent's and the platform's locked
 * shares, the per-trade footer, the sniper tax and editable-metadata switches), Rewards (the creator's own row and up to
 * four more) and Pool (the paired asset and its market details). The fields are text while typed; `settingsFromDraft`
 * turns them into the `TokenSettingsInput` the bounds are checked on (`lib/token-settings.ts`).
 */

export type RewardRowDraft = { recipient: string; admin: string; pct: string };

export type TokenSettingsDraft = {
  pairedAsset: string;
  buyTax: string;
  sellTax: string;
  burn: string;
  dividends: string;
  minHolding: string;
  /** Row 0 is the creator's own: an empty address there means the connected wallet. */
  rewards: RewardRowDraft[];
  sniperTax: boolean;
  editableMetadata: boolean;
};

export const DEFAULT_SETTINGS_DRAFT: TokenSettingsDraft = {
  pairedAsset: 'ETH',
  buyTax: '1.5',
  sellTax: '1.5',
  burn: '0',
  dividends: '0',
  minHolding: String(MIN_DIVIDEND_HOLDING),
  rewards: [{ recipient: '', admin: '', pct: '100' }],
  sniperTax: true,
  editableMetadata: true,
};

const num = (s: string) => (/^\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : NaN);

/** The typed fields as a settings input; the creator's row falls back to the connected wallet. */
export function settingsFromDraft(d: TokenSettingsDraft, creator: Address | undefined, bounds: V5Bounds): TokenSettingsInput {
  const wallet = creator ?? ('0x0000000000000000000000000000000000000000' as Address);
  const s: TokenSettingsInput = {
    pairedAsset: d.pairedAsset,
    buyTaxPct: num(d.buyTax),
    sellTaxPct: num(d.sellTax),
    burnPct: d.burn.trim() === '' ? 0 : num(d.burn),
    dividendsPct: d.dividends.trim() === '' ? 0 : num(d.dividends),
    minDividendHolding: num(d.minHolding),
    rewards: d.rewards.map((r, i) => ({
      recipient: (r.recipient.trim() || (i === 0 ? wallet : '')) as Address,
      admin: (r.admin.trim() || (i === 0 ? wallet : r.recipient.trim())) as Address,
      pct: num(r.pct),
    })),
    sniperTax: d.sniperTax,
    editableMetadata: d.editableMetadata,
  };
  if (creatorFundsPct(s, bounds) === 0) s.rewards = [];
  return s;
}

const SEGMENTS = [
  { key: 'agent', label: 'Agent', color: 'var(--chart-1)' },
  { key: 'platform', label: 'Platform', color: 'var(--chart-4)' },
  { key: 'creator', label: 'Creator funds', color: 'var(--chart-2)' },
  { key: 'dividends', label: 'Holder dividends', color: 'var(--chart-3)' },
  { key: 'burn', label: 'Burn allocation', color: 'var(--color-ink, currentColor)' },
] as const;

/** The allocation of the tax pool as a ring: the five shares, in percent, adding up to 100. */
function Donut({ parts }: { parts: Record<(typeof SEGMENTS)[number]['key'], number> }) {
  const r = 15.9155; // circumference 100
  // Each arc starts where the ones before it end, from twelve o'clock (dash offset 25).
  const values = SEGMENTS.map((s) => Math.max(0, parts[s.key]));
  const starts = values.map((_, i) => 25 - values.slice(0, i).reduce((a, b) => a + b, 0));
  return (
    <svg viewBox="0 0 42 42" className="size-28 shrink-0" role="img" aria-label="Tax allocation">
      <circle cx="21" cy="21" r={r} fill="none" stroke="var(--color-hairline, #ddd)" strokeWidth="6" />
      {SEGMENTS.map((s, i) =>
        values[i]! > 0 ? (
          <circle key={s.key} cx="21" cy="21" r={r} fill="none" stroke={s.color} strokeWidth="6" strokeDasharray={`${values[i]} ${100 - values[i]!}`} strokeDashoffset={starts[i]} />
        ) : null,
      )}
    </svg>
  );
}

function PctInput({ id, value, onChange, invalid, disabled, label }: { id: string; value: string; onChange: (v: string) => void; invalid?: boolean; disabled?: boolean; label?: string }) {
  return (
    <Input
      id={id}
      aria-label={label}
      inputMode="decimal"
      mono
      suffix="%"
      value={value}
      disabled={disabled}
      aria-invalid={invalid}
      onChange={(e) => onChange(e.target.value.trim())}
    />
  );
}

function Block({ title, description, children, testId }: { title: string; description?: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="flex flex-col gap-4 rounded-sm border border-hairline p-4" data-testid={testId}>
      <div>
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        {description ? <p className="mt-0.5 text-caption text-mute">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

function MarketDetailsPanel({ asset }: { asset: string }) {
  const q = useQuery<MarketDetails>({
    queryKey: ['quote-market', asset],
    queryFn: async () => {
      const res = await fetch(`/api/quote-market?asset=${encodeURIComponent(asset)}`);
      if (!res.ok) throw new Error(`quote-market ${res.status}`);
      return (await res.json()) as MarketDetails;
    },
    staleTime: 60_000,
    retry: false,
  });
  const d = q.data;
  const a = pairedAssetBySymbol(asset);
  const capText = d ? `${d.openingCap.toLocaleString('en-US', { maximumFractionDigits: d.openingCap < 100 ? 2 : 0 })} ${d.asset}` : null;
  return (
    <div className="rounded-sm border border-hairline bg-canvas-soft p-3" data-testid="market-details" data-source={d?.source ?? (q.isError ? 'error' : 'loading')}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-caption font-medium text-ink">Market details</span>
        <span className="text-micro text-mute" data-testid="market-source">
          {d ? (d.source === 'clanker.world' ? 'From clanker.world' : 'Bootr’s own figures: clanker.world did not answer') : q.isError ? 'Not available right now' : 'Loading…'}
        </span>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-caption sm:grid-cols-3">
        <div className="flex justify-between gap-2 sm:flex-col">
          <dt className="text-mute">{a?.symbol ?? asset} price</dt>
          <dd className="font-mono text-ink tabular" data-testid="market-price">
            {d?.priceUsd != null ? usd(d.priceUsd) : '—'}
          </dd>
        </div>
        <div className="flex justify-between gap-2 sm:flex-col">
          <dt className="text-mute">Liquidity</dt>
          <dd className="font-mono text-ink tabular" data-testid="market-liquidity">
            {d?.liquidityUsd != null ? usd(d.liquidityUsd, { compact: true }) : '—'}
          </dd>
        </div>
        <div className="flex justify-between gap-2 sm:flex-col">
          <dt className="text-mute">Opening market cap</dt>
          <dd className="font-mono text-ink tabular" data-testid="market-opening-cap">
            {d ? (d.openingCapUsd != null ? `${usd(d.openingCapUsd, { compact: true })} (${capText})` : capText) : '—'}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-micro text-mute">
        The opening price is Clanker&rsquo;s for every new coin paired with {a?.symbol ?? asset}
        {d ? (d.startTickSource === 'chain' ? ', read from its factory' : ', as Clanker set it on 10 Nov 2026') : ''}. Shown for reference; nothing here goes on chain.
      </p>
    </div>
  );
}

export function TokenSettingsPanel({
  draft,
  onChange,
  creator,
  bounds,
  problems,
}: {
  draft: TokenSettingsDraft;
  onChange: (next: TokenSettingsDraft) => void;
  creator: Address | undefined;
  bounds: V5Bounds;
  problems: SettingsProblem[];
}) {
  const set = (patch: Partial<TokenSettingsDraft>) => onChange({ ...draft, ...patch });
  const s = settingsFromDraft(draft, creator, bounds);
  const bad = (field: string) => problems.some((p) => p.field === field || p.field.startsWith(`${field}.`));
  const minTax = bounds.minTaxBps / 10_000;
  const maxTax = bounds.maxTaxBps / 10_000;
  const agentPct = bounds.agentShareBps / 100;
  const platformPct = bounds.platformShareBps / 100;
  const room = creatorPoolBps(bounds) / 100;
  const funds = creatorFundsPct(s, bounds);
  const dividends = Number.isFinite(s.dividendsPct) ? s.dividendsPct : 0;
  const burn = Number.isFinite(s.burnPct) ? s.burnPct : 0;
  const taxesOk = !bad('buyTaxPct') && !bad('sellTaxPct') && !bad('burnPct') && !bad('dividendsPct');
  const lines = taxesOk ? perTradeLines(s, bounds) : [];
  const allocated = allocatedPct(s.rewards);
  const maxRows = bounds.maxRewardRows;
  const assets = pairedAssetsFor('agent');
  const asset = pairedAssetBySymbol(draft.pairedAsset);
  const walletLabel = creator ? `Your wallet (${shortAddr(creator)})` : 'Your wallet';
  const setRow = (i: number, patch: Partial<RewardRowDraft>) => set({ rewards: draft.rewards.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  return (
    <div className="flex flex-col gap-4" data-testid="token-settings">
      <Block title="Tax" description={`A tax on every buy and every sell, ${minTax}% to ${maxTax}% each. Clanker keeps its share of it; the rest is split below.`} testId="settings-tax">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="buy-tax" hint={`${minTax}–${maxTax}%`}>
              Buy tax
            </Label>
            <PctInput id="buy-tax" value={draft.buyTax} onChange={(v) => set({ buyTax: v })} invalid={bad('buyTaxPct')} />
          </div>
          <div>
            <Label htmlFor="sell-tax" hint={`${minTax}–${maxTax}%`}>
              Sell tax
            </Label>
            <PctInput id="sell-tax" value={draft.sellTax} onChange={(v) => set({ sellTax: v })} invalid={bad('sellTaxPct')} />
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-caption font-medium text-ink">Tax allocation</span>
            <span className={cn('font-mono text-caption tabular', funds < 0 ? 'text-danger' : 'text-mute')} data-testid="tax-allocation-total">
              {funds < 0 ? `Over by ${Math.round(-funds * 100) / 100}%` : 'Allocated: 100/100%'}
            </span>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <Donut parts={{ agent: agentPct, platform: platformPct, creator: Math.max(0, funds), dividends, burn }} />
            <div className="grid min-w-0 flex-1 gap-2" data-testid="tax-allocation">
              {[
                { key: 'agent', label: 'Agent', value: `${agentPct}%`, note: 'Locked: the agent’s thinking budget' },
                { key: 'platform', label: 'Platform', value: `${platformPct}%`, note: 'Locked' },
              ].map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-3 text-sm" data-testid={`allocation-${row.key}`}>
                  <span className="flex items-center gap-2 text-body">
                    <span className="size-2 rounded-[2px]" style={{ background: SEGMENTS.find((x) => x.key === row.key)!.color }} aria-hidden="true" />
                    {row.label}
                    <span className="text-micro text-mute">{row.note}</span>
                  </span>
                  <span className="font-mono text-ink tabular">{row.value}</span>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 text-sm" data-testid="allocation-creator">
                <span className="flex items-center gap-2 text-body">
                  <span className="size-2 rounded-[2px]" style={{ background: SEGMENTS[2].color }} aria-hidden="true" />
                  Creator funds
                  <span className="text-micro text-mute">What the burn and dividends leave of {room}%</span>
                </span>
                <span className={cn('font-mono tabular', funds < 0 ? 'text-danger' : 'text-ink')}>{Math.max(0, funds)}%</span>
              </div>
              {(
                [
                  { key: 'dividends', id: 'dividends-pct', label: 'Holder dividends', value: draft.dividends, field: 'dividendsPct', patch: (v: string) => set({ dividends: v }) },
                  { key: 'burn', id: 'burn-pct', label: 'Burn allocation', value: draft.burn, field: 'burnPct', patch: (v: string) => set({ burn: v }) },
                ] as const
              ).map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-3 text-sm">
                  <label htmlFor={row.id} className="flex items-center gap-2 text-body">
                    <span className="size-2 rounded-[2px]" style={{ background: SEGMENTS.find((x) => x.key === row.key)!.color }} aria-hidden="true" />
                    {row.label}
                  </label>
                  <div className="w-28">
                    <PctInput id={row.id} value={row.value} onChange={row.patch} invalid={bad(row.field)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          {dividends > 0 ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_200px] sm:items-end">
              <p className="text-caption text-mute">
                Paid in {asset?.symbol ?? 'the paired asset'} to every wallet holding at least this many coins, which claims it itself. Clanker holds the dividend money;
                while nobody qualifies, the dividend share goes to Clanker.
              </p>
              <div>
                <Label htmlFor="min-holding" hint={`From ${MIN_DIVIDEND_HOLDING.toLocaleString('en-US')}`}>
                  Minimum holding
                </Label>
                <Input id="min-holding" inputMode="numeric" mono suffix="coins" value={draft.minHolding} onChange={(e) => set({ minHolding: e.target.value.trim() })} aria-invalid={bad('minDividendHolding')} />
              </div>
            </div>
          ) : null}
          <div className="mt-3 flex flex-col gap-0.5 font-mono text-caption text-body" data-testid="per-trade">
            {lines.length > 0 ? lines.map((l) => <p key={l}>{l}</p>) : <p className="text-mute">Per trade: fix the fields above to see the split.</p>}
          </div>
        </div>

        <div className="grid gap-px overflow-hidden rounded-sm border border-hairline bg-hairline">
          <div className="flex items-start justify-between gap-4 bg-canvas px-3 py-2.5">
            <div className="min-w-0">
              <label htmlFor="sniper-tax" className="text-sm font-medium text-ink">
                Sniper tax
              </label>
              <p className="mt-0.5 text-caption text-mute">Falls from 99% to the tax in 20 seconds; the surcharge goes to Clanker. It keeps bots from taking the first block.</p>
            </div>
            <Switch id="sniper-tax" checked={draft.sniperTax} onChange={(v) => set({ sniperTax: v })} label="Sniper tax" />
          </div>
          <div className="flex items-start justify-between gap-4 bg-canvas px-3 py-2.5">
            <div className="min-w-0">
              <label htmlFor="editable-metadata" className="text-sm font-medium text-ink">
                Editable metadata
              </label>
              <p className="mt-0.5 text-caption text-mute">Only you can change the image and metadata after launch, from the coin&rsquo;s console; you can lock it for good there. Name and ticker never change.</p>
            </div>
            <Switch id="editable-metadata" checked={draft.editableMetadata} onChange={(v) => set({ editableMetadata: v })} label="Editable metadata" />
          </div>
        </div>
      </Block>

      <Block
        title="Rewards"
        description={`Who receives the creator funds (${Math.max(0, funds)}% of the tax pool), in ${asset?.symbol ?? 'the paired asset'}. Each row’s admin can later change its recipient on Clanker; the agent’s and the platform’s rows are locked.`}
        testId="settings-rewards"
      >
        {funds <= 0 ? (
          <p className="text-caption text-mute">The burn and holder dividends take all of the creator&rsquo;s share, so there is nothing for reward rows.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {draft.rewards.map((r, i) => {
              const own = i === 0;
              return (
                <div key={i} className="grid gap-2 rounded-sm border border-hairline p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px_auto] sm:items-end" data-testid={`reward-row-${i}`}>
                  <div className="min-w-0">
                    <Label htmlFor={`reward-admin-${i}`}>{own ? 'Admin (you)' : 'Admin'}</Label>
                    <Input
                      id={`reward-admin-${i}`}
                      mono
                      placeholder={own ? walletLabel : '0x…'}
                      value={r.admin}
                      onChange={(e) => setRow(i, { admin: e.target.value.trim() })}
                      aria-invalid={bad(`rewards.${i}.admin`) || (r.admin !== '' && !isAddress(r.admin))}
                    />
                  </div>
                  <div className="min-w-0">
                    <Label htmlFor={`reward-recipient-${i}`}>Recipient</Label>
                    <Input
                      id={`reward-recipient-${i}`}
                      mono
                      placeholder={own ? walletLabel : '0x…'}
                      value={r.recipient}
                      onChange={(e) => setRow(i, { recipient: e.target.value.trim() })}
                      aria-invalid={bad(`rewards.${i}.recipient`) || (r.recipient !== '' && !isAddress(r.recipient))}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`reward-pct-${i}`}>Reward</Label>
                    <PctInput id={`reward-pct-${i}`} value={r.pct} onChange={(v) => setRow(i, { pct: v })} invalid={bad(`rewards.${i}.pct`)} />
                  </div>
                  {own ? (
                    <span className="hidden sm:block sm:w-16" />
                  ) : (
                    <Button type="button" variant="ghost" size="sm" aria-label={`Remove recipient ${i + 1}`} onClick={() => set({ rewards: draft.rewards.filter((_, j) => j !== i) })}>
                      Remove
                    </Button>
                  )}
                </div>
              );
            })}
            <div className="flex flex-wrap items-center justify-between gap-3">
              {draft.rewards.length < maxRows ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => set({ rewards: [...draft.rewards, { recipient: '', admin: '', pct: '' }] })}>
                  + Add recipient
                </Button>
              ) : (
                <span className="text-caption text-mute">Up to {maxRows - 1} recipients beside yours.</span>
              )}
              <span className={cn('font-mono text-caption tabular', allocated === 100 ? 'text-mute' : 'text-danger')} data-testid="rewards-allocated">
                Allocated: {allocated}/100%
              </span>
            </div>
          </div>
        )}
      </Block>

      <Block title="Pool" description="What the coin trades against. Fees, rewards and dividends are paid in it." testId="settings-pool">
        <fieldset>
          <legend className="mb-1.5 text-caption font-medium text-ink">Paired asset</legend>
          <div className="grid gap-2 sm:grid-cols-2" data-testid="paired-asset">
            {assets.map((a) => (
              <label
                key={a.symbol}
                className={cn('flex cursor-pointer flex-col gap-1 rounded-sm border p-3 transition-colors duration-150', draft.pairedAsset === a.symbol ? 'border-ink' : 'border-hairline hover:border-hairline-strong')}
              >
                <input type="radio" name="paired-asset" value={a.symbol} checked={draft.pairedAsset === a.symbol} onChange={() => set({ pairedAsset: a.symbol })} className="sr-only" />
                <span className="text-sm font-medium text-ink">{a.symbol}</span>
                <span className="text-caption text-mute">{a.note}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <MarketDetailsPanel asset={draft.pairedAsset} />
      </Block>

      {problems.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-caption text-danger" data-testid="settings-problems">
          {problems.map((p) => (
            <li key={`${p.field}:${p.message}`}>{p.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
