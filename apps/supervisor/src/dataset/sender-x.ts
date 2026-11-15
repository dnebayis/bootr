/**
 * How the dataset process reads X: it does not. It asks the sender, which holds the tokens, over the sender's
 * `/dataset/x/*` routes (apps/sender/src/dataset-x.ts), signed with `DATASET_SENDER_KEY`. That key opens those reads
 * and nothing else in the sender, and this process is given no other key.
 *
 * Every answer is rebuilt field by field before anything is done with it: only the fields named here pass, every
 * string is checked against its shape and cut, every list is bounded. An answer that is not what the route promises is
 * an error, never something to make the best of.
 */
import { signRequest } from '../hmac.js';

export const SENDER_X_TIMEOUT_MS = 30_000;
/** The most of an answer that is read. */
export const SENDER_X_ANSWER_MAX = 256 * 1024;
export const X_POST_TEXT_MAX = 4_000;
export const X_POST_URLS_MAX = 10;
const ID = /^\d{1,25}$/;
const HANDLE = /^\w{1,15}$/;

export interface XBudget {
  day: string;
  limit: number;
  units: number;
  posts: number;
  userReads: number;
  checks: number;
}

export interface XUser {
  id: string;
  /** The handle as X spells it. */
  username: string;
  followers: number | null;
  protected: boolean;
}

export interface XPost {
  id: string;
  text: string;
  createdAt: string | null;
  urls: { url: string; expandedUrl: string }[];
  quotedId: string | null;
}

/** A refusal or failure of the sender, with its own code (`dataset_x_off`, `dataset_x_cap_reached`, `not_connected`, `x_rate_limited`, ...). */
export class SenderXError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`sender ${status}: ${code}`);
    this.name = 'SenderXError';
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12 ? Math.floor(v) : null);

function budgetOf(v: unknown): XBudget {
  const b = obj(v);
  const [limit, units, posts, userReads, checks] = [whole(b?.limit), whole(b?.units), whole(b?.posts), whole(b?.userReads), whole(b?.checks)];
  if (!b || typeof b.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.day) || limit === null || units === null || posts === null || userReads === null || checks === null) throw new SenderXError(502, 'bad_answer');
  return { day: b.day, limit, units, posts, userReads, checks };
}

function userOf(v: unknown): XUser | null {
  if (v === null) return null;
  const u = obj(v);
  if (!u || typeof u.id !== 'string' || !ID.test(u.id) || typeof u.username !== 'string' || !HANDLE.test(u.username)) throw new SenderXError(502, 'bad_answer');
  return { id: u.id, username: u.username, followers: whole(u.followers), protected: u.protected === true };
}

function postOf(v: unknown): XPost | null {
  const p = obj(v);
  if (!p || typeof p.id !== 'string' || !ID.test(p.id) || typeof p.text !== 'string') return null;
  const urls = (Array.isArray(p.urls) ? p.urls : [])
    .slice(0, X_POST_URLS_MAX)
    .map(obj)
    .filter((u): u is Obj => !!u && typeof u.url === 'string' && typeof u.expandedUrl === 'string')
    .map((u) => ({ url: (u.url as string).slice(0, 200), expandedUrl: (u.expandedUrl as string).slice(0, 2_000) }));
  return { id: p.id, text: p.text.slice(0, X_POST_TEXT_MAX), createdAt: typeof p.createdAt === 'string' ? p.createdAt.slice(0, 40) : null, urls, quotedId: typeof p.quotedId === 'string' && ID.test(p.quotedId) ? p.quotedId : null };
}

export interface SenderXOptions {
  url: string;
  key: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class SenderX {
  private readonly base: string;

  constructor(private readonly opts: SenderXOptions) {
    this.base = opts.url.replace(/\/+$/, '');
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Obj> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const now = this.opts.now ?? Date.now;
    const res = await (this.opts.fetch ?? fetch)(`${this.base}${path}`, {
      method,
      headers: { authorization: signRequest(this.opts.key, method, path, raw, Math.floor(now() / 1000)), ...(raw ? { 'content-type': 'application/json' } : {}) },
      ...(raw ? { body: raw } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(SENDER_X_TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, SENDER_X_ANSWER_MAX);
    let parsed: Obj | null = null;
    try {
      parsed = obj(JSON.parse(text));
    } catch {
      parsed = null;
    }
    if (!res.ok) throw new SenderXError(res.status, typeof parsed?.error === 'string' && /^[a-z0-9_]{1,60}$/.test(parsed.error) ? parsed.error : `http_${res.status}`);
    if (!parsed) throw new SenderXError(502, 'bad_answer');
    return parsed;
  }

  /** The day so far, as the sender metered it. Costs nothing. */
  async budget(): Promise<XBudget> {
    return budgetOf(await this.call('GET', '/dataset/x/budget'));
  }

  /** One user read by handle: the first lookup of a listed account. `user` is null when X has no such account. */
  async resolve(handle: string): Promise<{ user: XUser | null; budget: XBudget }> {
    const res = await this.call('POST', '/dataset/x/resolve', { handle });
    return { user: userOf(res.user ?? null), budget: budgetOf(res.budget) };
  }

  /** One user read by id: the look at a pinned account. */
  async user(userId: string): Promise<{ user: XUser | null; budget: XBudget }> {
    const res = await this.call('POST', '/dataset/x/user', { userId });
    return { user: userOf(res.user ?? null), budget: budgetOf(res.budget) };
  }

  /**
   * One account's original posts newer than `sinceId`, newest first. Whatever the answer holds, at most `max` posts
   * come back from here, each with an id above `sinceId`: an answer cannot hand over more than was asked for, and
   * cannot move the cursor backwards.
   */
  async posts(userId: string, sinceId: string, max: number): Promise<{ posts: XPost[]; more: boolean; budget: XBudget }> {
    const res = await this.call('POST', '/dataset/x/posts', { userId, sinceId, max });
    if (!Array.isArray(res.posts)) throw new SenderXError(502, 'bad_answer');
    const since = BigInt(sinceId);
    const seen = new Set<string>();
    const posts = res.posts
      .slice(0, 100)
      .map(postOf)
      .filter((p): p is XPost => !!p && BigInt(p.id) > since && !seen.has(p.id) && !!seen.add(p.id))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
      .slice(0, max);
    return { posts, more: res.more === true, budget: budgetOf(res.budget) };
  }

  /** Which of `ids` X still shows. Only ids that were asked about are believed, and an id in neither list is unknown. */
  async check(ids: readonly string[]): Promise<{ present: string[]; gone: string[]; budget: XBudget }> {
    const res = await this.call('POST', '/dataset/x/check', { ids });
    const asked = new Set(ids);
    const list = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).filter((id): id is string => typeof id === 'string' && asked.has(id)))];
    const present = list(res.present);
    return { present, gone: list(res.gone).filter((id) => !present.includes(id)), budget: budgetOf(res.budget) };
  }
}
