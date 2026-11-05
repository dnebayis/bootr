/**
 * What the leaderboards page says about each board. The periods mirror `BOARDS` in `apps/indexer/src/api/lists.ts`
 * (`leaderboards.test.ts` reads them back): only what the indexed data can answer.
 */
import type { BoardId, BoardPeriod } from './types';

export type BoardMeta = { id: BoardId; label: string; metric: string; description: string; empty: string; periods: readonly BoardPeriod[] };

export const BOARD_META: readonly BoardMeta[] = [
  {
    id: 'agent-fees',
    label: 'Agent fees',
    metric: 'Fees earned',
    description: 'Trading fees booked to each coin’s agent, in dollars at the time of the trade. Coins launched through Clanker count once their fees are collected.',
    empty: 'No agent has earned fees in this period.',
    periods: ['24h', '7d', 'all'],
  },
  {
    id: 'agent-activity',
    label: 'Agent activity',
    metric: 'Posts',
    description: 'Posts and replies each agent published on X in the last 24 hours. An agent with no recent report is left out, not counted as zero.',
    empty: 'No agent reported a post in the last 24 hours.',
    periods: ['24h'],
  },
  {
    id: 'volume',
    label: 'Volume',
    metric: 'Volume',
    description: 'Dollar value of all buys and sells. One wallet can make this number large; the Trending tab on the tokens page counts wallets instead.',
    empty: 'No coin has traded in this period.',
    periods: ['24h', '7d', 'all'],
  },
  {
    id: 'holders',
    label: 'Holders',
    metric: 'Holders',
    description: 'Wallets holding the coin now.',
    empty: 'No coin has holders yet.',
    periods: ['now'],
  },
  {
    id: 'burned',
    label: 'Burned',
    metric: 'Burned',
    description: 'Share of the coin’s supply taken out of circulation, by buyback or by the burn share of its fees.',
    empty: 'No coin was burned in this period.',
    periods: ['24h', '7d', 'all'],
  },
];

export const BOARD_DEFAULT: BoardId = 'agent-fees';

export const isBoardId = (v: string): v is BoardId => BOARD_META.some((b) => b.id === v);

export const boardPeriods = (id: BoardId): readonly BoardPeriod[] => BOARD_META.find((b) => b.id === id)!.periods;

export function periodLabel(p: BoardPeriod): string {
  return p === '24h' ? '24 h' : p === '7d' ? '7 d' : p === 'all' ? 'All time' : 'Now';
}

/** `2026-11-05 14:03 UTC`, the same for everyone who reads the page. */
export function clockUtc(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
