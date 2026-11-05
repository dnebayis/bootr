'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useLeaderboard } from '@/lib/indexer';
import { env } from '@/lib/env';
import { num, shortAddr, units, usd } from '@/lib/format';
import { isBoardId, BOARD_DEFAULT, boardPeriods, clockUtc, periodLabel, type BoardMeta, BOARD_META } from '@/lib/leaderboards';
import type { BoardId, BoardPeriod, Leaderboard, LeaderboardRow } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Panel, Empty } from '@/components/ui/Panel';
import { StatusDot } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { TokenImage } from '@/components/ui/TokenImage';
import { cn } from '@/components/ui/cn';

const th = 'px-5 py-2 text-left text-caption font-normal text-mute max-sm:px-3';
const td = 'px-5 py-2.5 max-sm:px-3';

function value(row: LeaderboardRow, board: Leaderboard) {
  if (board.unit === 'usd') return usd(row.value, { compact: false });
  if (board.unit === 'percent') return `${row.value < 0.01 ? '<0.01' : num(row.value)}%`;
  return num(row.value);
}

function Row({ row, board }: { row: LeaderboardRow; board: Leaderboard }) {
  const t = row.token;
  return (
    <tr className="border-t border-hairline">
      <td className={`${td} font-mono text-sm text-mute tabular`}>{row.rank}</td>
      <td className={`${td} min-w-0`}>
        <Link href={`/token/${t.id}`} className="flex min-w-0 items-center gap-2.5 hover:text-link">
          <TokenImage src={t.image} symbol={t.symbol} size={28} className="rounded-xs" />
          <span className="truncate text-sm text-ink">{t.name}</span>
          <span className="font-mono text-caption text-mute max-sm:hidden">${t.symbol}</span>
        </Link>
      </td>
      <td className={`${td} max-sm:hidden`}>
        {t.kernel && row.agent ? (
          <Link href={`/agent/${t.kernel}`} className="inline-flex items-center gap-1.5 text-caption text-body hover:text-link">
            <StatusDot status={row.agent.status} />
            {t.xHandle ? `@${t.xHandle}` : shortAddr(t.kernel)}
          </Link>
        ) : (
          <span className="text-caption text-mute">No agent</span>
        )}
      </td>
      <td className={`${td} max-md:hidden`}>
        <Link href={`/u/${t.creator}`} className="font-mono text-caption text-mute hover:text-link" title={t.creator}>
          {shortAddr(t.creator)}
        </Link>
      </td>
      <td className={`${td} text-right`}>
        <div className="font-mono text-sm text-ink tabular">{value(row, board)}</div>
        {row.detail?.amountToken ? (
          <div className="font-mono text-micro text-mute tabular">
            {units(row.detail.amountToken, 18, 0)} ${t.symbol}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function Segment({ board, period, periods }: { board: BoardId; period: BoardPeriod; periods: readonly BoardPeriod[] }) {
  if (periods.length < 2) return <span className="font-mono text-micro text-mute">{periodLabel(period)}</span>;
  return (
    <nav aria-label="Period" className="inline-flex rounded-sm border border-hairline p-0.5">
      {periods.map((p) => (
        <Link
          key={p}
          href={`/leaderboards?board=${board}&period=${p}`}
          replace
          scroll={false}
          aria-current={p === period ? 'true' : undefined}
          className={cn('inline-flex h-6 items-center rounded-xs px-2 font-mono text-micro transition-colors', p === period ? 'bg-ink text-on-ink' : 'text-mute hover:text-ink')}
        >
          {periodLabel(p)}
        </Link>
      ))}
    </nav>
  );
}

function Board({ meta, period }: { meta: BoardMeta; period: BoardPeriod }) {
  const q = useLeaderboard(meta.id, period);
  const board = q.data;
  return (
    <Panel title={meta.metric} bodyClassName="p-0" action={<Segment board={meta.id} period={period} periods={boardPeriods(meta.id)} />}>
      <p className="border-b border-hairline px-5 py-2.5 text-caption text-mute max-sm:px-3">{meta.description}</p>
      {q.isPending ? (
        <div className="flex flex-col gap-2 p-5" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : q.isError || !board ? (
        <Empty action={<Button onClick={() => void q.refetch()}>Retry</Button>}>The indexer did not respond. Nothing is shown rather than an old or guessed number.</Empty>
      ) : board.items.length === 0 ? (
        <Empty>{meta.empty}</Empty>
      ) : (
        <table className="w-full table-fixed border-collapse">
          <thead className="bg-canvas-soft">
            <tr>
              <th scope="col" className={`${th} w-12`}>#</th>
              <th scope="col" className={th}>Coin</th>
              <th scope="col" className={`${th} w-44 max-sm:hidden`}>Agent</th>
              <th scope="col" className={`${th} w-32 max-md:hidden`}>Creator</th>
              <th scope="col" className={`${th} w-36 text-right max-sm:w-28`}>{meta.metric}</th>
            </tr>
          </thead>
          <tbody>
            {board.items.map((row) => (
              <Row key={row.token.id} row={row} board={board} />
            ))}
          </tbody>
        </table>
      )}
      {board ? (
        <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-hairline px-5 py-2.5 font-mono text-micro text-mute max-sm:px-3" data-testid="board-read-time">
          <span>Read {clockUtc(board.readAt)}</span>
          {board.indexedAt ? <span>Market figures refreshed {clockUtc(board.indexedAt)}</span> : null}
          {board.ranked > board.items.length ? <span>Top {board.items.length} of {board.ranked}</span> : null}
          {board.unknown > 0 ? <span>{board.unknown} with no recent report, left out</span> : null}
          {env.useMock ? <span>Mock data</span> : null}
        </p>
      ) : null}
    </Panel>
  );
}

export function LeaderboardsSkeleton() {
  return <Skeleton className="h-96 rounded-md" />;
}

/** The board and period come from the URL, so a board can be shared as a link. */
export function LeaderboardsView() {
  const params = useSearchParams();
  const raw = params.get('board') ?? '';
  const id: BoardId = isBoardId(raw) ? raw : BOARD_DEFAULT;
  const periods = boardPeriods(id);
  const asked = params.get('period') as BoardPeriod | null;
  const period = asked && periods.includes(asked) ? asked : periods[0]!;
  const meta = BOARD_META.find((b) => b.id === id)!;
  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Leaderboards" className="-mb-px flex gap-5 overflow-x-auto border-b border-hairline">
        {BOARD_META.map((b) => (
          <Link
            key={b.id}
            href={`/leaderboards?board=${b.id}`}
            replace
            scroll={false}
            aria-current={b.id === id ? 'page' : undefined}
            className={cn('whitespace-nowrap border-b py-2.5 text-sm transition-colors duration-150', b.id === id ? 'border-ink text-ink' : 'border-transparent text-mute hover:text-ink')}
          >
            {b.label}
          </Link>
        ))}
      </nav>
      <Board key={`${id}:${period}`} meta={meta} period={period} />
    </div>
  );
}
