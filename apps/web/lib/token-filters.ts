/**
 * The tokens page's filters and sort as they live in the URL (`/?tab=&creator=&path=&from=&to=&agent=&sort=`), so a view can
 * be shared. Anything malformed in a URL is dropped rather than refused: a bad link still shows a page. No imports with
 * side effects: used by the page, the indexer client and the tests.
 */
import type { LaunchSource, TokenTab } from './types';

export const TOKEN_SORTS = [
  { id: 'bumped', label: 'Last trade' },
  { id: 'launched', label: 'Newest launch' },
  { id: 'mcap', label: 'Market cap' },
  { id: 'volume24h', label: '24 h volume' },
  { id: 'holders', label: 'Holders' },
] as const;

export type TokenSortKey = (typeof TOKEN_SORTS)[number]['id'];

export type TokenFilters = {
  /** Lowercase address of the coin's creator. */
  creator?: string;
  path?: LaunchSource;
  /** Launched on or after this UTC day, `YYYY-MM-DD`. */
  from?: string;
  /** Launched on or before this UTC day, `YYYY-MM-DD`. */
  to?: string;
  agent?: 'yes' | 'no';
  sort?: TokenSortKey;
};

export const NO_FILTERS: TokenFilters = {};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isCreatorAddress = (v: string) => ADDRESS.test(v.trim());

const isDay = (v: string | null): v is string => !!v && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** The filters in a URL's query. */
export function parseTokenFilters(params: { get(name: string): string | null }): TokenFilters {
  const f: TokenFilters = {};
  const creator = params.get('creator');
  if (creator && ADDRESS.test(creator)) f.creator = creator.toLowerCase();
  const path = params.get('path');
  if (path === 'bootr' || path === 'clanker') f.path = path;
  const from = params.get('from');
  if (isDay(from)) f.from = from;
  const to = params.get('to');
  if (isDay(to)) f.to = to;
  const agent = params.get('agent');
  if (agent === 'yes' || agent === 'no') f.agent = agent;
  const sort = params.get('sort');
  if (TOKEN_SORTS.some((s) => s.id === sort)) f.sort = sort as TokenSortKey;
  return f;
}

/** How many filters (not counting the sort) are on. */
export const activeFilterCount = (f: TokenFilters) => [f.creator, f.path, f.from, f.to, f.agent].filter(Boolean).length;

export const hasFilters = (f: TokenFilters) => activeFilterCount(f) > 0 || !!f.sort;

/** The page's own query string: the tab (the default one is left out) and the filters, in a stable order. */
export function tokensPageQuery(tab: TokenTab, f: TokenFilters): string {
  const q = new URLSearchParams();
  if (tab !== 'newest') q.set('tab', tab);
  if (f.creator) q.set('creator', f.creator);
  if (f.path) q.set('path', f.path);
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.agent) q.set('agent', f.agent);
  if (f.sort) q.set('sort', f.sort);
  return q.toString();
}

/** Start of a UTC day, unix seconds. */
export const dayStartUnix = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
/** Last second of a UTC day, unix seconds. */
export const dayEndUnix = (day: string) => dayStartUnix(day) + 86_399;

/** What each tab means on its own; the sort in the URL, when there is one, wins. */
const TAB_DEFAULTS: Record<Exclude<TokenTab, 'trending'>, { sort: string; graduated?: true; agentStatus?: string }> = {
  newest: { sort: 'bumped' },
  graduated: { sort: 'graduated', graduated: true },
  mcap: { sort: 'mcap' },
  active: { sort: 'volume24h', agentStatus: 'awake' },
};

function filterParams(f: TokenFilters): URLSearchParams {
  const q = new URLSearchParams();
  if (f.creator) q.set('creator', f.creator);
  if (f.path) q.set('source', f.path);
  if (f.from) q.set('from', String(dayStartUnix(f.from)));
  if (f.to) q.set('to', String(dayEndUnix(f.to)));
  if (f.agent) q.set('hasAgent', f.agent === 'yes' ? 'true' : 'false');
  return q;
}

/** The indexer query for a tab with filters: `/tokens/trending` (which ranks by its score, so no sort) or `/tokens/list`. */
export function tokenListRequest(tab: TokenTab, f: TokenFilters): { path: '/tokens/trending' | '/tokens/list'; params: URLSearchParams } {
  const q = filterParams(f);
  if (tab === 'trending') return { path: '/tokens/trending', params: q };
  const d = TAB_DEFAULTS[tab];
  q.set('sort', f.sort ?? d.sort);
  if (d.graduated) q.set('graduated', 'true');
  if (d.agentStatus) q.set('agentStatus', d.agentStatus);
  return { path: '/tokens/list', params: q };
}
