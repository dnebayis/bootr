import { amountNumber, capUse, dayName, lineText, orderedLines, usdSum } from '@/lib/ledger-view';
import type { AgentBountiesPolicy, AgentServicesPolicy, LedgerDay } from '@/lib/types';

/**
 * The daily totals at the top of the ledger: per UTC day, what came in and what went out (in dollars where every part
 * has a value), then each kind in its own asset. Moves between the agent's own wallets and bounties paid from its
 * creator's wallet are listed but are in neither sum. With `caps` (the creator console) today's use of the creator's
 * daily caps sits beside them.
 */
export function LedgerDays({ days, complete = true, caps }: { days: readonly LedgerDay[]; complete?: boolean; caps?: { services: Pick<AgentServicesPolicy, 'dailyMicroUsdc'>; bounties: Pick<AgentBountiesPolicy, 'dailyCapMicroUsdc'> } }) {
  const shown = days.filter((d, i) => i === 0 || d.lines.length > 0 || d.unknown > 0 || d.failed > 0);
  return (
    <div className="flex flex-col gap-2" data-testid="ledger-days">
      {caps ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="ledger-caps">
          {capUse(days[0], caps.services, caps.bounties).map((c) => (
            <li key={c.label} className="rounded-xs bg-canvas-soft px-3 py-2">
              <div className="text-micro text-mute">{c.label} today (UTC)</div>
              <div className="font-mono text-caption text-ink tabular">
                {amountNumber(String(c.usedMicro), 6, 4)} of {amountNumber(String(c.capMicro), 6, 4)} USDC
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="divide-y divide-hairline">
        {shown.map((d) => (
          <li key={d.day} className="py-2" data-testid="ledger-day" data-day={d.day}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-caption font-medium text-ink">{dayName(d.day)}</span>
              <span className="font-mono text-caption text-body tabular">
                in {usdSum(d.inUsd)} · out {usdSum(d.outUsd)}
              </span>
            </div>
            {d.lines.length ? (
              <p className="mt-0.5 text-micro text-mute">{orderedLines(d).map(lineText).join(' · ')}</p>
            ) : (
              <p className="mt-0.5 text-micro text-mute">Nothing settled this day.</p>
            )}
            {d.unknown || d.failed ? (
              <p className="text-micro text-mute">
                {[d.unknown ? `${d.unknown} not settled yet` : '', d.failed ? `${d.failed} did not go through` : ''].filter(Boolean).join(' · ')}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {complete ? null : <p className="text-micro text-mute">Some rows could not be read just now, so these totals may be short.</p>}
    </div>
  );
}
