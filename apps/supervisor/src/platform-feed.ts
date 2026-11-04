/**
 * "Bootr today": a compact, dated digest of what happened on the launchpad, for the platform's own
 * agent (@AgentBootr). Read from the indexer's `GET /platform/feed?since=` (indexer-client.ts), cached
 * per tick, rendered newest first with ISO dates and capped at PLATFORM_FEED_MAX_CHARS. Launches,
 * milestones (first trade, holder counts, 24 h volume), wake/sleep changes, first posts, posts and agent
 * fee claims; never a price. Everything in it is third-party content (coin names, handles) and is
 * rendered as untrusted evidence: control characters are stripped, strings are clipped, handles must
 * look like handles.
 */
import type { SupervisorContext } from './context.js';

export const PLATFORM_FEED_MAX_CHARS = 1_500;
/** One indexer read per tick: a feed read within this window is served from the cache. */
export const PLATFORM_FEED_TTL_MS = 60_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** What `GET /platform/feed` answers (apps/indexer/src/api/index.ts). Timestamps are unix seconds. */
export interface PlatformFeedData {
  now: number;
  since: number;
  totals?: { tokens?: number; agentsTotal?: number; agentsAwake?: number; volume24hUsd?: number; volume7dUsd?: number; fees24hUsd?: number; updatedAt?: number | null };
  launches?: { token: string; kernel: string; name: string; symbol: string; creator: string; launchedAt: number; xHandle?: string | null }[];
  statusChanges?: { kernel: string; token?: string; symbol?: string | null; status: string; at: number; xHandle?: string | null }[];
  posts?: { kernel: string; symbol?: string | null; xHandle?: string | null; lastPostAt: number | null; postsCount24h?: number }[];
  claims?: { token: string; kernel?: string; symbol?: string | null; amountUsd: number; at: number; txHash?: string }[];
  /** `first_swap` (value 0), `holders` (count reached) or `volume24h` (USD reached); once per coin and value. */
  milestones?: { token: string; kernel?: string; symbol?: string | null; kind: string; value: number; at: number; txHash?: string | null }[];
  /** Agents whose first ever post went out in the window. */
  firstPosts?: { kernel: string; token?: string | null; symbol?: string | null; xHandle?: string | null; firstPostAt: number | null; lastPostAt?: number | null; postsCount24h?: number }[];
}

export interface PlatformFeedCounts {
  launches: number;
  statusChanges: number;
  posters: number;
  firstPosts: number;
  claims: number;
  claimedUsd: number;
  milestones: number;
}

export interface PlatformFeed {
  /** False when the indexer did not answer; `text` then explains that. */
  available: boolean;
  /** Window start / end, ms. */
  since: number;
  now: number;
  /** Anything at all in the last 24 h (launch, milestone, status change, post, claim) by someone other than `exclude`. */
  noteworthy: boolean;
  day: PlatformFeedCounts;
  week: PlatformFeedCounts;
  /** The rendered digest, at most PLATFORM_FEED_MAX_CHARS characters. */
  text: string;
}

export interface PlatformFeedOptions {
  /** Window start (ms); default now - 7 d. The digest always splits it into the last 24 h and the rest. */
  since?: number;
  /** The reading agent's own kernel: its own launch, status, posts and claims are left out. */
  exclude?: string;
}

// ---------------------------------------------------------------------------
// Rendering helpers (every input is third-party content)
// ---------------------------------------------------------------------------

export const clean = (v: unknown, max: number): string =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export const handleOf = (v: unknown): string | null => {
  const h = clean(v, 20).replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? `@${h}` : null;
};

export const symbolOf = (v: unknown): string => {
  const s = clean(v, 12).replace(/^\$/, '');
  return s ? `$${s}` : '$?';
};

export const shortAddress = (v: unknown): string => {
  const a = clean(v, 42);
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ? a.slice(0, 11) : 'unknown';
};

export const iso = (unixSec: number): string => new Date(Math.round(unixSec * 1000)).toISOString().replace('.000Z', 'Z');

export function money(usd: number): string {
  const n = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return `$${n.toFixed(2)}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STATUS_WORDS: Record<string, string> = {
  awake: 'woke up',
  sleeping: 'went to sleep (out of fuel)',
  dormant: 'went dormant',
  claimed: 'was claimed by its creator',
  paused: 'was paused',
};

function who(symbol: unknown, handle: unknown): string {
  const h = handleOf(handle);
  return h ? `${symbolOf(symbol)} agent (${h})` : `${symbolOf(symbol)} agent`;
}

/** One milestone as a sentence fragment after the symbol: "had its first trade", "reached 100 holders", "passed $1.0k traded in 24 h". */
export function milestoneWords(kind: unknown, value: unknown): string {
  const k = clean(kind, 16);
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (k === 'first_swap') return 'had its first trade';
  if (k === 'holders') return `reached ${plural(n, 'holder')}`;
  if (k === 'volume24h') return `passed ${money(n)} traded in 24 h`;
  return `reached milestone ${k || 'unknown'} ${n}`.trim();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export interface Windowed {
  launches: NonNullable<PlatformFeedData['launches']>;
  changes: NonNullable<PlatformFeedData['statusChanges']>;
  posts: NonNullable<PlatformFeedData['posts']>;
  claims: NonNullable<PlatformFeedData['claims']>;
  milestones: NonNullable<PlatformFeedData['milestones']>;
  firstPosts: NonNullable<PlatformFeedData['firstPosts']>;
}

/** The feed's items within [fromSec, toSec) (unix seconds), newest first, without the reader's own kernel (`exclude`, lower-case). */
export function selectWindow(data: PlatformFeedData, fromSec: number, toSec: number, exclude: string | null): Windowed {
  const own = (k: unknown) => exclude !== null && typeof k === 'string' && k.toLowerCase() === exclude;
  const within = (t: unknown) => typeof t === 'number' && Number.isFinite(t) && t >= fromSec && t < toSec;
  const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  return {
    launches: list(data.launches).filter((l) => l && within(l.launchedAt) && !own(l.kernel)).sort((a, b) => b.launchedAt - a.launchedAt),
    changes: list(data.statusChanges).filter((s) => s && within(s.at) && !own(s.kernel)).sort((a, b) => b.at - a.at),
    posts: list(data.posts).filter((p) => p && within(p.lastPostAt) && !own(p.kernel)).sort((a, b) => (b.lastPostAt ?? 0) - (a.lastPostAt ?? 0)),
    claims: list(data.claims).filter((c) => c && within(c.at) && !own(c.kernel)).sort((a, b) => b.at - a.at),
    milestones: list(data.milestones).filter((m) => m && within(m.at) && !own(m.kernel)).sort((a, b) => b.at - a.at),
    firstPosts: list(data.firstPosts).filter((p) => p && within(p.firstPostAt) && !own(p.kernel)).sort((a, b) => (b.firstPostAt ?? 0) - (a.firstPostAt ?? 0)),
  };
}

const counts = (w: Windowed): PlatformFeedCounts => ({
  launches: w.launches.length,
  statusChanges: w.changes.length,
  posters: w.posts.length,
  firstPosts: w.firstPosts.length,
  claims: w.claims.length,
  claimedUsd: w.claims.reduce((s, c) => s + (Number.isFinite(c.amountUsd) ? c.amountUsd : 0), 0),
  milestones: w.milestones.length,
});

const postedWords = (c: PlatformFeedCounts) => `${plural(c.posters, 'agent')} posted${c.firstPosts ? ` (${c.firstPosts} for the first time)` : ''}`;

/** A block of lines that is cut from the end when the digest is over budget; `more` names what was cut. */
interface Block {
  lines: string[];
  more?: (cut: number) => string;
}

function fit(blocks: Block[], max: number): string {
  const render = (bs: Block[]) => bs.flatMap((b) => b.lines).join('\n');
  const cut = blocks.map((b) => ({ ...b, lines: [...b.lines], cut: 0 }));
  let text = render(cut);
  // Trim list blocks from the last block backwards, one line at a time, keeping at least the heading.
  for (let i = cut.length - 1; i >= 0 && text.length > max; i--) {
    const b = cut[i]!;
    if (!b.more) continue;
    while (text.length > max && b.lines.length > 1) {
      b.lines.pop();
      b.cut += 1;
      const trailer = b.more(b.cut);
      text = render(cut.map((x, j) => (j === i ? { ...x, lines: [...x.lines, trailer] } : x)));
      if (text.length <= max) {
        b.lines.push(trailer);
        return text;
      }
    }
    if (b.cut > 0) b.lines.push(b.more(b.cut));
    text = render(cut);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Renders the indexer's feed into a PlatformFeed. `now` and `since` are ms. */
export function formatPlatformFeed(data: PlatformFeedData, opts: { now: number; since?: number; exclude?: string | null }): PlatformFeed {
  const now = opts.now;
  const since = Math.max(opts.since ?? now - WEEK_MS, now - WEEK_MS);
  const exclude = opts.exclude ? opts.exclude.toLowerCase() : null;
  const nowSec = now / 1000;
  const daySec = Math.max(since, now - DAY_MS) / 1000;
  const sinceSec = since / 1000;
  const day = selectWindow(data, daySec, nowSec + 1, exclude);
  const week = selectWindow(data, sinceSec, nowSec + 1, exclude);
  const dayCounts = counts(day);
  const weekCounts = counts(week);
  const noteworthy = dayCounts.launches + dayCounts.milestones + dayCounts.statusChanges + dayCounts.posters + dayCounts.firstPosts + dayCounts.claims > 0;
  const t = data.totals ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  const totals = `Totals: ${plural(num(t.tokens), 'coin')}, ${plural(num(t.agentsAwake), 'agent')} awake of ${num(t.agentsTotal)}, ${money(num(t.volume24hUsd))} traded in 24 h${typeof t.updatedAt === 'number' ? ` (indexer at ${iso(t.updatedAt)})` : ''}.`;
  const weekSymbols = week.launches.slice(0, 6).map((l) => symbolOf(l.symbol));
  const weekLine =
    `Last 7 d (since ${iso(sinceSec)}): ${plural(weekCounts.launches, 'new coin')}${weekSymbols.length ? ` (${weekSymbols.join(', ')}${week.launches.length > 6 ? ', …' : ''})` : ''}, ` +
    `${plural(weekCounts.milestones, 'milestone')}, ${plural(weekCounts.statusChanges, 'wake/sleep change')}, ${postedWords(weekCounts)}, ${plural(weekCounts.claims, 'agent fee claim')}` +
    `${weekCounts.claims ? ` (${money(weekCounts.claimedUsd)})` : ''}, ${money(num(t.volume7dUsd))} traded.`;

  const blocks: Block[] = [];
  if (!noteworthy) {
    blocks.push({ lines: [`Nothing noteworthy on Bootr in the last 24 h (since ${iso(daySec)}): no launches, milestones, wake/sleep changes, posts or agent fee claims.`, totals, weekLine] });
  } else {
    blocks.push({
      lines: [
        `Last 24 h (since ${iso(daySec)}), newest first: ${plural(dayCounts.launches, 'new coin')}, ${plural(dayCounts.milestones, 'milestone')}, ${plural(dayCounts.statusChanges, 'wake/sleep change')}, ${postedWords(dayCounts)}, ${plural(dayCounts.claims, 'agent fee claim')}.`,
        totals,
      ],
    });
    if (day.launches.length) {
      blocks.push({
        lines: [
          'New coins:',
          ...day.launches.map((l) => {
            const h = handleOf(l.xHandle);
            return `- ${iso(l.launchedAt)} ${clean(l.name, 32) || 'Unnamed'} (${symbolOf(l.symbol)}) launched by ${shortAddress(l.creator)}${h ? `, agent ${h}` : ', agent not on X yet'}`;
          }),
        ],
        more: (n) => `- (+${n} more launches)`,
      });
    }
    if (day.milestones.length) {
      blocks.push({
        lines: ['Milestones:', ...day.milestones.map((m) => `- ${iso(m.at)} ${symbolOf(m.symbol)} ${milestoneWords(m.kind, m.value)}`)],
        more: (n) => `- (+${n} more milestones)`,
      });
    }
    if (day.changes.length) {
      blocks.push({
        lines: ['Agents:', ...day.changes.map((s) => `- ${iso(s.at)} ${who(s.symbol, s.xHandle)} ${STATUS_WORDS[clean(s.status, 16)] ?? `is now ${clean(s.status, 16) || 'unknown'}`}`)],
        more: (n) => `- (+${n} more status changes)`,
      });
    }
    if (day.firstPosts.length) {
      blocks.push({
        lines: ['First posts:', ...day.firstPosts.map((p) => `- ${iso(p.firstPostAt ?? daySec)} ${who(p.symbol, p.xHandle)} posted for the first time`)],
        more: (n) => `- (+${n} more first posts)`,
      });
    }
    if (day.posts.length) {
      blocks.push({
        lines: ['Posted:', ...day.posts.map((p) => `- ${iso(p.lastPostAt ?? daySec)} ${who(p.symbol, p.xHandle)}: ${plural(Math.max(0, Math.floor(num(p.postsCount24h))), 'post')} in 24 h`)],
        more: (n) => `- (+${n} more agents posted)`,
      });
    }
    if (day.claims.length) {
      blocks.push({
        lines: ['Agent fee claims:', ...day.claims.map((c) => `- ${iso(c.at)} ${symbolOf(c.symbol)} agent claimed ${money(num(c.amountUsd))} in fees`)],
        more: (n) => `- (+${n} more claims)`,
      });
    }
    blocks.push({ lines: [weekLine] });
  }
  // The 7-day line is the last block and never a list, so lists above it are what gets trimmed.
  return { available: true, since, now, noteworthy, day: dayCounts, week: weekCounts, text: fit(blocks, PLATFORM_FEED_MAX_CHARS) };
}

export function unavailableFeed(now: number, since: number): PlatformFeed {
  const empty: PlatformFeedCounts = { launches: 0, statusChanges: 0, posters: 0, firstPosts: 0, claims: 0, claimedUsd: 0, milestones: 0 };
  return { available: false, since, now, noteworthy: false, day: empty, week: empty, text: 'Bootr digest unavailable: the indexer did not answer.' };
}

// ---------------------------------------------------------------------------
// Reading (one indexer call, cached per tick)
// ---------------------------------------------------------------------------

/** Reads the feed from the indexer and renders it. Never throws: an unreachable indexer yields `available: false`. */
export async function buildPlatformFeed(ctx: Pick<SupervisorContext, 'indexer' | 'now' | 'log'>, opts: PlatformFeedOptions = {}): Promise<PlatformFeed> {
  const now = ctx.now();
  const since = Math.max(opts.since ?? now - WEEK_MS, now - WEEK_MS);
  let raw: Record<string, unknown> | null = null;
  try {
    raw = await ctx.indexer.platformFeed(Math.floor(since / 1000));
  } catch (err) {
    ctx.log.warn({ err }, 'platform feed read failed');
  }
  if (!raw || typeof raw !== 'object') return unavailableFeed(now, since);
  return formatPlatformFeed(raw as unknown as PlatformFeedData, { now, since, exclude: opts.exclude ?? null });
}

interface CacheEntry {
  at: number;
  since: number;
  raw: Promise<Record<string, unknown> | null>;
}

const cache = new WeakMap<object, CacheEntry>();

/**
 * The raw feed with one indexer call per tick: reads within PLATFORM_FEED_TTL_MS of the last one (by `ctx.now()`)
 * share its answer, which covers any `since` at or after the cached one. Concurrent readers share the in-flight
 * promise. Null when the indexer did not answer.
 */
export async function cachedPlatformFeedData(ctx: Pick<SupervisorContext, 'indexer' | 'now' | 'log'>, opts: Pick<PlatformFeedOptions, 'since'> = {}): Promise<PlatformFeedData | null> {
  const now = ctx.now();
  const since = Math.max(opts.since ?? now - WEEK_MS, now - WEEK_MS);
  const key = ctx.indexer as unknown as object;
  let entry = cache.get(key);
  if (!entry || now - entry.at >= PLATFORM_FEED_TTL_MS || now < entry.at || entry.since > since) {
    const sinceSec = Math.floor(since / 1000);
    entry = {
      at: now,
      since,
      raw: Promise.resolve()
        .then(() => ctx.indexer.platformFeed(sinceSec))
        .catch((err: unknown) => {
          ctx.log.warn({ err }, 'platform feed read failed');
          return null;
        }),
    };
    cache.set(key, entry);
  }
  const raw = await entry.raw;
  return raw && typeof raw === 'object' ? (raw as unknown as PlatformFeedData) : null;
}

/** `buildPlatformFeed` on the per-tick cache (`cachedPlatformFeedData`); rendering (and `exclude`) is applied per call. */
export async function cachedPlatformFeed(ctx: Pick<SupervisorContext, 'indexer' | 'now' | 'log'>, opts: PlatformFeedOptions = {}): Promise<PlatformFeed> {
  const now = ctx.now();
  const since = Math.max(opts.since ?? now - WEEK_MS, now - WEEK_MS);
  const data = await cachedPlatformFeedData(ctx, { since });
  if (!data) return unavailableFeed(now, since);
  return formatPlatformFeed(data, { now, since, exclude: opts.exclude ?? null });
}
