/**
 * Pure parts of the public list routes (`/tokens/list`, `/tokens/trending`, `/leaderboards/:board`, `/creator/:address`):
 * query parsing, board rules and ranking. The SQL lives in api/index.ts. API code, so no new DATABASE_SCHEMA.
 */
import { isLaunchSource, LAUNCH_SOURCES, type LaunchSource } from '../lib/fees';

export const LIST_MAX = 100;
export const LIST_DEFAULT = 48;
export const BOARD_MAX = 100;
export const BOARD_DEFAULT = 50;

export type TokenSort = 'bumped' | 'launched' | 'mcap' | 'volume24h' | 'holders' | 'graduated';
const SORTS: readonly TokenSort[] = ['bumped', 'launched', 'mcap', 'volume24h', 'holders', 'graduated'];

export type TokenFilters = {
  /** Lowercase address. */
  creator?: string;
  source?: LaunchSource;
  /** Launched at or after, unix s. */
  from?: number;
  /** Launched at or before, unix s. */
  to?: number;
  hasAgent?: boolean;
  graduated?: boolean;
  agentStatus?: string;
};

export type TokenListQuery = { filters: TokenFilters; sort: TokenSort; limit: number; offset: number };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AGENT_STATUSES = ['awake', 'sleeping', 'paused', 'dormant', 'claimed'];

function unixParam(v: string | undefined): number | undefined | null {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function boolParam(v: string | undefined): boolean | undefined | null {
  if (v === undefined || v === '') return undefined;
  return v === 'true' ? true : v === 'false' ? false : null;
}

/** The filters of a list route's query string, or the reason they are refused (answered as a 400). */
export function parseTokenFilters(q: Record<string, string | undefined>): TokenFilters | string {
  const filters: TokenFilters = {};
  if (q.creator) {
    if (!ADDRESS.test(q.creator)) return 'creator must be an address';
    filters.creator = q.creator.toLowerCase();
  }
  if (q.source) {
    if (!isLaunchSource(q.source)) return `source must be one of ${LAUNCH_SOURCES.join(', ')}`;
    filters.source = q.source;
  }
  const from = unixParam(q.from);
  if (from === null) return 'from must be unix seconds';
  if (from !== undefined) filters.from = from;
  const to = unixParam(q.to);
  if (to === null) return 'to must be unix seconds';
  if (to !== undefined) filters.to = to;
  const hasAgent = boolParam(q.hasAgent);
  if (hasAgent === null) return 'hasAgent must be true or false';
  if (hasAgent !== undefined) filters.hasAgent = hasAgent;
  const graduated = boolParam(q.graduated);
  if (graduated === null) return 'graduated must be true or false';
  if (graduated !== undefined) filters.graduated = graduated;
  if (q.agentStatus) {
    if (!AGENT_STATUSES.includes(q.agentStatus)) return `agentStatus must be one of ${AGENT_STATUSES.join(', ')}`;
    filters.agentStatus = q.agentStatus;
  }
  return filters;
}

/** `limit` and `after` (an offset cursor; the order moves between pages, so clients dedupe by id). */
export function parsePage(q: Record<string, string | undefined>): { limit: number; offset: number } {
  return {
    limit: Math.min(LIST_MAX, Math.max(1, Math.floor(Number(q.limit)) || LIST_DEFAULT)),
    offset: Math.max(0, Math.floor(Number(q.after)) || 0),
  };
}

export function parseTokenList(q: Record<string, string | undefined>): TokenListQuery | string {
  const filters = parseTokenFilters(q);
  if (typeof filters === 'string') return filters;
  const sort = (q.sort || 'bumped') as TokenSort;
  if (!SORTS.includes(sort)) return `sort must be one of ${SORTS.join(', ')}`;
  return { filters, sort, ...parsePage(q) };
}

/** A page of `items` out of an already ranked list, in the shape every list route answers. */
export function pageOf<T>(ranked: readonly T[], offset: number, limit: number) {
  const items = ranked.slice(offset, offset + limit);
  const next = offset + limit;
  return { items, pageInfo: { endCursor: next < ranked.length ? String(next) : null, hasNextPage: next < ranked.length } };
}

// ------------------------------------------------------------------ leaderboards

export type BoardId = 'agent-fees' | 'agent-activity' | 'volume' | 'holders' | 'burned';
export type BoardPeriod = '24h' | '7d' | 'all' | 'now';
export type BoardUnit = 'usd' | 'count' | 'percent';

/** Only the periods the indexed data can answer: post counts exist for the last 24 h, holders as of now. */
export const BOARDS: Record<BoardId, { periods: readonly BoardPeriod[]; unit: BoardUnit }> = {
  'agent-fees': { periods: ['24h', '7d', 'all'], unit: 'usd' },
  'agent-activity': { periods: ['24h'], unit: 'count' },
  volume: { periods: ['24h', '7d', 'all'], unit: 'usd' },
  holders: { periods: ['now'], unit: 'count' },
  burned: { periods: ['24h', '7d', 'all'], unit: 'percent' },
};

export const isBoardId = (v: string): v is BoardId => Object.hasOwn(BOARDS, v);

/** The asked period, the board's first one when none was asked, null when the board does not have it. */
export function boardPeriod(board: BoardId, raw: string | undefined): BoardPeriod | null {
  const { periods } = BOARDS[board];
  if (!raw) return periods[0]!;
  return periods.includes(raw as BoardPeriod) ? (raw as BoardPeriod) : null;
}

/** Unix seconds a period starts at; null for "all" and "now" (no window). */
export function periodStart(period: BoardPeriod, now: number): number | null {
  if (period === '24h') return now - 86_400;
  if (period === '7d') return now - 7 * 86_400;
  return null;
}

/** A supervisor report older than this is not a count of the last 24 h any more. */
export const POST_COUNT_MAX_AGE_S = 86_400;

/**
 * The agent's posts in the last 24 h, as far as anyone knows: the supervisor's report when it is fresh, else null.
 * `agent.postsCount24h` starts at 0 before any report, so a row without a report says nothing.
 */
export function knownPostCount(report: { postsCount24h: number; updatedAt: number } | undefined, now: number): number | null {
  if (!report || now - report.updatedAt > POST_COUNT_MAX_AGE_S) return null;
  return report.postsCount24h;
}

/** Percent of a coin's supply that `burned` is, to four decimals; null when the supply is not known. */
export function percentOfSupply(burned: bigint, totalSupply: bigint): number | null {
  if (totalSupply <= 0n) return null;
  return Number((burned * 1_000_000n) / totalSupply) / 10_000;
}

/**
 * Rows ranked by value, highest first. A row without a real value (null, zero, not finite) gets no rank and is only
 * counted: nothing is estimated to fill a board. Ties keep their given order.
 */
export function rankRows<T extends { value: number | null }>(rows: readonly T[], limit: number): { items: (T & { rank: number })[]; ranked: number; unknown: number } {
  const known = rows.filter((r): r is T & { value: number } => typeof r.value === 'number' && Number.isFinite(r.value) && r.value > 0);
  const unknown = rows.filter((r) => r.value === null).length;
  const sorted = [...known].sort((a, b) => b.value - a.value);
  return { items: sorted.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 })), ranked: sorted.length, unknown };
}
