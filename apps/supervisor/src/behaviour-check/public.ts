/**
 * The behaviour check from the outside (docs/dev/behaviour-check.md): what anyone can read without the database, the
 * way section 2.1 of docs/design/agent-behaviour.md read its sample by hand.
 *
 *   - the coin and its agent: the indexer's `GET /tokens/list`;
 *   - which posts and replies went out, and when: the coin page's tape, `GET <site>/api/agent/<kernel>/activity`, paged
 *     back with `before` until the window is covered. A row carries the post's link and no text;
 *   - the text: the sender's `GET /public/posts/<agentId>` for the ten newest (whole), and for the rest X's public embed
 *     endpoint (`cdn.syndication.twimg.com/tweet-result`), which cuts a long post at about 280 characters;
 *   - thoughts and their cost: `GET <site>/api/agent/<kernel>/fuel?days=N`, which counts back from now and takes no
 *     window, so the fuel figure covers the last N days and says so.
 *
 * It asks for nothing that is not public, sends no credential, and reads at a slow pace (a few requests at a time).
 * What it cannot see is left null: the measures print "needs the database" for it.
 */
import { DAY_MS, REPEAT_LOOKBACK_MS, type CheckInput, type PostRow } from './measures.js';

export interface PublicSources {
  /** The web app (`https://bootr.fun`). */
  site: string;
  /** The indexer (`https://indexer.bootr.fun`). */
  indexer: string;
  /** The sender's public API (`https://api.bootr.fun`). */
  sender: string;
  /** X's public embed endpoint. */
  embed: string;
}

export const PUBLIC_SOURCES: PublicSources = { site: 'https://bootr.fun', indexer: 'https://indexer.bootr.fun', sender: 'https://api.bootr.fun', embed: 'https://cdn.syndication.twimg.com' };

const USER_AGENT = 'bootr-behaviour-check/1.0';
/** Tape pages read at most: 200 pages of 100 rows is far past any window the check takes. */
const MAX_TAPE_PAGES = 200;
const TAPE_PAGE = 100;
/** Texts fetched from the embed at a time. */
const EMBED_CONCURRENCY = 4;
/** A text of this length or more from the embed may have been cut. */
const EMBED_CUT_AT = 270;

export interface PublicDeps {
  fetch: typeof fetch;
  now: () => number;
  sources?: PublicSources;
  /** Told each step, for a progress line on stderr. */
  onStep?: (what: string) => void;
}

async function getJson(deps: PublicDeps, url: string): Promise<unknown> {
  try {
    const res = await deps.fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface Coin {
  agentId: string;
  kernel: string;
  token: string;
  symbol: string | null;
  handle: string | null;
  /** Launched by the platform's own wallet: the supervisor's rule for the platform account (onboarding.ts). */
  platform: boolean;
}

/** The coin a name stands for: an agent id, an X handle (with or without the @), a symbol (with or without the $), or the coin's or the treasury's address. */
export async function findCoin(deps: PublicDeps, name: string): Promise<Coin | null> {
  const sources = deps.sources ?? PUBLIC_SOURCES;
  const body = (await getJson(deps, `${sources.indexer}/tokens/list`)) as { items?: Record<string, unknown>[] } | null;
  const wanted = name.trim().replace(/^[@$]/, '').toLowerCase();
  const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  for (const t of body?.items ?? []) {
    const names = [text(t.agentId), text(t.xHandle), text(t.symbol), text(t.id), text(t.kernel)].map((n) => n.toLowerCase()).filter(Boolean);
    if (!names.includes(wanted) || !text(t.agentId) || !text(t.kernel)) continue;
    const platform = !!text(t.creator) && text(t.creator).toLowerCase() === text(t.platformRecipient).toLowerCase();
    return { agentId: text(t.agentId), kernel: text(t.kernel), token: text(t.id), symbol: text(t.symbol) || null, handle: text(t.xHandle) || null, platform };
  }
  return null;
}

interface TapePost {
  at: number;
  kind: 'post' | 'reply';
  postId: string;
}

const STATUS_URL = /^https:\/\/(?:x|twitter)\.com\/\w{1,15}\/status\/(\d{1,25})$/;

/** The kinds of tape row that come from the agent's actions, the source that holds its posts (activity.ts). */
const ACTION_KINDS: readonly string[] = ['post', 'reply', 'image', 'config'];

/**
 * The posts and replies on the tape from `since` on, and whether the tape was read all the way back to it.
 *
 * The tape is a merge: each of its sources gives its newest rows older than `before`, and the page keeps the newest of
 * them all. A refused publish is a row of the action source and shows nothing, so a page holds fewer posts than its
 * action source read rows, and two things follow that a reader has to know (both seen on 2026-11-14): a page's oldest
 * row can be older than the point its posts were read back to, so asking for the next page from there skips the posts
 * in between; and a page shorter than the limit is not the end of the tape. So the next page is asked from the oldest
 * action row this page showed (one millisecond later, so a row of the same instant is not lost; what comes twice is
 * kept once), and the read ends when the posts reach back past `since` or a page comes back empty.
 */
export async function readTape(deps: PublicDeps, kernel: string, since: number): Promise<{ posts: TapePost[]; complete: boolean }> {
  const sources = deps.sources ?? PUBLIC_SOURCES;
  const posts = new Map<string, TapePost>();
  const done = (complete: boolean) => ({ posts: [...posts.values()], complete });
  let before: number | null = null;
  for (let page = 0; page < MAX_TAPE_PAGES; page++) {
    const url: string = `${sources.site}/api/agent/${kernel}/activity?limit=${TAPE_PAGE}${before !== null ? `&before=${encodeURIComponent(new Date(before).toISOString())}` : ''}`;
    const body = (await getJson(deps, url)) as { items?: { at?: unknown; kind?: unknown; url?: unknown }[] } | null;
    if (!body || !Array.isArray(body.items)) return done(false);
    let oldest = Number.POSITIVE_INFINITY;
    let oldestAction = Number.POSITIVE_INFINITY;
    for (const item of body.items) {
      const at = typeof item.at === 'string' ? Date.parse(item.at) : Number.NaN;
      if (!Number.isFinite(at)) continue;
      oldest = Math.min(oldest, at);
      if (typeof item.kind === 'string' && ACTION_KINDS.includes(item.kind)) oldestAction = Math.min(oldestAction, at);
      const id = typeof item.url === 'string' ? STATUS_URL.exec(item.url)?.[1] : undefined;
      if ((item.kind === 'post' || item.kind === 'reply') && id && at >= since) posts.set(id, { at, kind: item.kind, postId: id });
    }
    // Nothing older is left, or the posts already reach back past the start: everything from `since` on has been seen.
    if (body.items.length === 0) return done(true);
    const reached = Number.isFinite(oldestAction) ? oldestAction : oldest;
    if (!Number.isFinite(reached)) return done(false);
    if (reached < since) return done(true);
    // The next cursor must move back, or the read would ask for the same page for ever.
    const next: number | undefined = [reached + 1, reached, oldest].find((t) => before === null || t < before);
    if (next === undefined) return done(false);
    before = next;
  }
  return done(false);
}

/** The token X's embed endpoint asks for with a post id (the embed script's own arithmetic; no secret). */
export function embedToken(postId: string): string {
  return ((Number(postId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** One post's text from X's public embed, or null when X does not show it (deleted, protected, rate limited). */
export async function embedText(deps: PublicDeps, postId: string): Promise<string | null> {
  const sources = deps.sources ?? PUBLIC_SOURCES;
  const body = (await getJson(deps, `${sources.embed}/tweet-result?id=${postId}&token=${embedToken(postId)}`)) as { text?: unknown; display_text_range?: unknown; note_tweet?: unknown } | null;
  if (!body || typeof body.text !== 'string') return null;
  // A reply's text opens with the handles it answers; the range says where the agent's own words begin.
  const range = Array.isArray(body.display_text_range) ? Number(body.display_text_range[0]) : 0;
  const text = [...body.text].slice(Number.isFinite(range) && range > 0 ? range : 0).join('');
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

/** The whole public read for one agent and one window. Throws when the coin is not on Bootr's public list. */
export async function readPublic(deps: PublicDeps, name: string, from: number, to: number): Promise<CheckInput> {
  const sources = deps.sources ?? PUBLIC_SOURCES;
  const say = deps.onStep ?? (() => undefined);
  const now = deps.now();
  const coin = await findCoin(deps, name);
  if (!coin) throw new Error(`no coin "${name}" on ${sources.indexer}/tokens/list (give an agent id, an X handle, a symbol or an address)`);
  const caveats: string[] = [];

  say(`reading the tape of ${coin.handle ? `@${coin.handle}` : coin.agentId}`);
  const tape = await readTape(deps, coin.kernel, from - REPEAT_LOOKBACK_MS);
  if (!tape.complete) caveats.push('The tape could not be read all the way back to the start of the window: posts are missing, and every share is of what was read.');
  const wanted = tape.posts.filter((p) => p.at < to).sort((a, b) => a.at - b.at);

  // Whole texts for the newest ten, from Bootr's own public list; the embed for the rest.
  const whole = new Map<string, string>();
  const latest = (await getJson(deps, `${sources.sender}/public/posts/${coin.agentId}?limit=10`)) as { items?: { postId?: unknown; text?: unknown }[] } | null;
  for (const item of latest?.items ?? []) if (typeof item.postId === 'string' && typeof item.text === 'string') whole.set(item.postId, item.text);

  say(`reading ${wanted.filter((p) => !whole.has(p.postId)).length} texts from X's public embed`);
  const posts: PostRow[] = [];
  let unread = 0;
  let cut = 0;
  for (let i = 0; i < wanted.length; i += EMBED_CONCURRENCY) {
    const batch = wanted.slice(i, i + EMBED_CONCURRENCY);
    const texts = await Promise.all(batch.map(async (p) => whole.get(p.postId) ?? (await embedText(deps, p.postId))));
    batch.forEach((p, j) => {
      const text = texts[j];
      if (typeof text !== 'string' || !text) {
        unread += 1;
        return;
      }
      const wasCut = !whole.has(p.postId) && [...text].length >= EMBED_CUT_AT;
      if (wasCut && p.at >= from) cut += 1;
      posts.push({ at: p.at, kind: p.kind, status: 'completed', text, ...(wasCut ? { cut: true } : {}) });
    });
  }
  if (unread) caveats.push(`${unread} of ${wanted.length} posts on the tape could not be read from X's embed (deleted, or X did not answer): they are left out of every count.`);
  if (cut) caveats.push(`${cut} texts are as long as the embed shows (about 280 characters) and may be cut: anything at the end of a long post is under-counted.`);
  caveats.push('A thread is one row on the tape and is read by its first post only.');

  const days = Math.min(30, Math.max(1, Math.ceil((now - from) / DAY_MS)));
  const fuelBody = (await getJson(deps, `${sources.site}/api/agent/${coin.kernel}/fuel?days=${days}`)) as { byModel?: { thoughts?: unknown; chargedMicroUsdc?: unknown }[]; since?: unknown } | null;
  const fuel = fuelBody && Array.isArray(fuelBody.byModel) ? { thoughts: fuelBody.byModel.reduce((n, m) => n + (Number(m.thoughts) || 0), 0), chargedMicroUsdc: fuelBody.byModel.reduce((n, m) => n + (Number(m.chargedMicroUsdc) || 0), 0), label: `the last ${days} days up to the read, pictures included: the public fuel read takes no window` } : null;
  if (!fuel) caveats.push('The fuel read did not answer: M6 is missing.');
  else if (to < now - DAY_MS || Math.abs(now - days * DAY_MS - from) > DAY_MS / 2) caveats.push('The fuel figure covers a different stretch than the window (see M6): compare it only with a read taken the same way.');

  return {
    mode: 'public',
    agent: { id: coin.agentId, handle: coin.handle, symbol: coin.symbol, platform: coin.platform },
    from,
    to,
    readAt: now,
    posts,
    fuel,
    turns: null,
    steps: null,
    approvals: null,
    senderRejected: null,
    mentions: null,
    shadow: null,
    caveats,
  };
}
