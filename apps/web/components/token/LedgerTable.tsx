import { explorer } from '@/lib/chains';
import { shortAddr } from '@/lib/format';
import { amountText, utcWhen, DIRECTION_LABEL, DIRECTION_TITLE, KIND_LABEL, partyLabel, STATUS_LABEL, STATUS_TITLE, usdText } from '@/lib/ledger-view';
import type { LedgerRow } from '@/lib/types';
import { ArrowUpRightIcon } from '@/components/ui/Icons';
import { cn } from '@/components/ui/cn';

/** "15 Nov, 10:42 UTC": UTC like the day totals above the table (ledger-view.ts `utcWhen`), with the full instant as the title. */
function When({ at }: { at: string }) {
  const when = utcWhen(at);
  return (
    <time dateTime={at} title={when?.full} className="whitespace-nowrap font-mono text-micro text-mute tabular">
      {when?.short ?? '—'}
    </time>
  );
}

function Party({ row }: { row: LedgerRow }) {
  const p = row.counterparty;
  const label = partyLabel(p);
  if (!p?.address) return <span>{label}</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1">
      {p.role === 'person' ? null : <span>{label}</span>}
      <a href={explorer.address(p.address)} target="_blank" rel="noopener noreferrer" className="font-mono text-link hover:underline" title={p.address}>
        {shortAddr(p.address)}
      </a>
    </span>
  );
}

function Amount({ row }: { row: LedgerRow }) {
  const value = usdText(row.amount);
  return (
    <span className="inline-flex flex-col">
      <span className="whitespace-nowrap font-mono tabular text-ink">{amountText(row.amount)}</span>
      {row.received ? <span className="whitespace-nowrap font-mono text-micro text-body tabular">for {amountText(row.received)}</span> : null}
      {value ? <span className="font-mono text-micro text-mute tabular">{value}</span> : null}
    </span>
  );
}

function Status({ row }: { row: LedgerRow }) {
  return (
    <span title={STATUS_TITLE[row.status]} className={cn('text-micro', row.status === 'confirmed' ? 'text-mute' : 'text-ink')} data-status={row.status}>
      {STATUS_LABEL[row.status]}
    </span>
  );
}

function Tx({ row }: { row: LedgerRow }) {
  const href = row.txHash ? explorer.tx(row.txHash) : row.url;
  if (!href) return <span className="text-mute">—</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono text-micro text-link hover:underline" aria-label={row.txHash ? 'View the transaction' : 'View the post on X'}>
      {row.txHash ? row.txHash.slice(0, 10) : 'post'}
      <ArrowUpRightIcon size={11} />
    </a>
  );
}

function Direction({ row }: { row: LedgerRow }) {
  return (
    <span title={DIRECTION_TITLE[row.direction]} className="text-micro font-medium text-ink">
      {DIRECTION_LABEL[row.direction]}
    </span>
  );
}

/**
 * The ledger's rows: on a phone each row is a short card (kind, amount, then the reason, then when, who and the
 * transaction); from `md` up a table with the columns of the design (when · in/out · amount · counterparty · reason ·
 * status · tx). Neutral type throughout: in and out are words, never green and red.
 */
export function LedgerTable({ rows, empty = 'No money has moved yet.' }: { rows: readonly LedgerRow[]; empty?: string }) {
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-mute" data-testid="ledger-empty">
        {empty}
      </p>
    );
  }
  return (
    <div data-testid="ledger-table">
      <ul className="divide-y divide-hairline md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-col gap-1 py-3" data-testid="ledger-row" data-kind={row.kind} data-direction={row.direction}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-ink">
                <Direction row={row} /> <span className="text-body">· {KIND_LABEL[row.kind]}</span>
              </span>
              <Amount row={row} />
            </div>
            <p className="break-words text-caption text-body">{row.reason}</p>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-micro text-mute">
              <When at={row.at} />
              <Party row={row} />
              {row.status === 'confirmed' ? null : <Status row={row} />}
              <Tx row={row} />
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-caption">
          <thead className="text-micro text-mute">
            <tr className="h-8">
              <th className="pr-3 font-normal">When</th>
              <th className="pr-3 font-normal">In/out</th>
              <th className="pr-3 font-normal">Amount</th>
              <th className="pr-3 font-normal">Counterparty</th>
              <th className="pr-3 font-normal">Reason</th>
              <th className="pr-3 font-normal">Status</th>
              <th className="font-normal">Tx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-hairline align-top" data-kind={row.kind}>
                <td className="py-2 pr-3">
                  <When at={row.at} />
                </td>
                <td className="py-2 pr-3">
                  <Direction row={row} />
                  <div className="text-micro text-mute">{KIND_LABEL[row.kind]}</div>
                </td>
                <td className="py-2 pr-3">
                  <Amount row={row} />
                </td>
                <td className="py-2 pr-3 text-body">
                  <Party row={row} />
                </td>
                <td className="max-w-80 py-2 pr-3 break-words text-body">{row.reason}</td>
                <td className="py-2 pr-3">
                  <Status row={row} />
                </td>
                <td className="py-2">
                  <Tx row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
