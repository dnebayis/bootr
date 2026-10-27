import type { Trade } from '@/lib/types';
import { ago, price, shortAddr, units, usd } from '@/lib/format';
import { explorer } from '@/lib/chains';
import { Empty } from '@/components/ui/Panel';

export function TradesTable({ trades, symbol, now }: { trades: Trade[]; symbol: string; now: number }) {
  if (trades.length === 0) return <Empty>No trades yet.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="whitespace-nowrap bg-canvas-soft text-left text-caption text-mute">
            <th scope="col" className="px-4 py-2 font-normal">Time</th>
            <th scope="col" className="px-4 py-2 font-normal">Side</th>
            <th scope="col" className="px-4 py-2 text-right font-normal">Value</th>
            <th scope="col" className="px-4 py-2 text-right font-normal">{symbol}</th>
            <th scope="col" className="px-4 py-2 text-right font-normal">Price</th>
            <th scope="col" className="px-4 py-2 font-normal">Trader</th>
            <th scope="col" className="px-4 py-2 text-right font-normal">Tx</th>
          </tr>
        </thead>
        <tbody className="whitespace-nowrap font-mono tabular">
          {trades.slice(0, 20).map((t) => (
            <tr key={t.id} className="h-9 border-t border-hairline hover:bg-canvas-sub">
              <td className="px-4 text-mute">{ago(t.timestamp, now)}</td>
              <td className="px-4">
                <span className={t.side === 'buy' ? 'text-ink' : 'text-mute'}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
              </td>
              <td className="px-4 text-right text-ink">{usd(t.valueUsd, { compact: false })}</td>
              <td className="px-4 text-right text-body">{units(t.amountToken, 18, 0)}</td>
              <td className="px-4 text-right text-body">${price(t.priceUsd)}</td>
              <td className="px-4">
                <a className="text-body hover:text-link" href={explorer.address(t.trader)} target="_blank" rel="noopener noreferrer">
                  {shortAddr(t.trader, 6, 4)}
                </a>
              </td>
              <td className="px-4 text-right">
                <a className="text-link hover:underline" href={explorer.tx(t.txHash)} target="_blank" rel="noopener noreferrer">
                  {t.txHash.slice(0, 10)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
