/**
 * The dataset's door to the sender (src/dataset/sender-x.ts) and the planner of a day's X reads
 * (src/dataset/x-budget.ts). The sender's answers come from a function in the test: an answer that goes backwards,
 * hands over more than was asked or is not what the route promises must not move a cursor or reach the store.
 */
import { describe, expect, it } from 'vitest';
import { verifyRequest } from '../src/hmac.js';
import { SenderX, SenderXError } from '../src/dataset/sender-x.js';
import { askFor, capOf, DAY_MS, postsLeft, rateOf, sharesOf, unitsLeft, X_HARD_CEILING, X_PAGE_MIN } from '../src/dataset/x-budget.js';
import { datasetConfigSchema } from '../src/dataset/config.js';

const KEY = 'k'.repeat(40);
const BUDGET = { day: '2026-11-15', limit: 250, units: 10, remaining: 240, posts: 8, userReads: 1, checks: 0, usd: 0.05 };
const answering = (body: unknown, status = 200, seen: Request[] = []) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
const client = (f: typeof fetch) => new SenderX({ url: 'http://sender:3002/', key: KEY, fetch: f, now: () => Date.parse('2026-11-15T12:00:00Z') });
const post = (id: string, text = 'Base mainnet upgrade ships today') => ({ id, text, createdAt: '2026-11-15T11:00:00.000Z', urls: [], quotedId: null });

describe('the door to the sender', () => {
  it('signs each call with the dataset key and the path, and asks by user id from the id it was given', async () => {
    const seen: Request[] = [];
    await client(answering({ posts: [], more: false, budget: BUDGET }, 200, seen)).posts('42', '1000', 5);
    const req = seen[0]!;
    expect(req.url).toBe('http://sender:3002/dataset/x/posts');
    const body = await req.text();
    expect(JSON.parse(body)).toEqual({ userId: '42', sinceId: '1000', max: 5 });
    expect(verifyRequest(KEY, req.headers.get('authorization') ?? '', 'POST', '/dataset/x/posts', body, Math.floor(Date.parse('2026-11-15T12:00:00Z') / 1000))).toEqual({ ok: true });
  });

  it('never believes a post at or below the id it asked from: a since_id cannot go backwards', async () => {
    const res = await client(answering({ posts: [post('999'), post('1000'), post('1001')], more: false, budget: BUDGET })).posts('42', '1000', 5);
    expect(res.posts.map((p) => p.id)).toEqual(['1001']);
  });

  it('never hands on more posts than it asked for, newest first, each once', async () => {
    const many = Array.from({ length: 40 }, (_, i) => post(String(2000 + i)));
    const res = await client(answering({ posts: [...many, post('2039')], more: true, budget: BUDGET })).posts('42', '1000', 5);
    expect(res.posts.map((p) => p.id)).toEqual(['2039', '2038', '2037', '2036', '2035']);
    expect(res.more).toBe(true);
  });

  it('drops a post that is not one and cuts what one post can carry', async () => {
    const res = await client(answering({ posts: [{ id: '1x', text: 'a' }, { id: '2000' }, { ...post('2001', 'y'.repeat(10_000)), urls: Array.from({ length: 50 }, () => ({ url: 'https://t.co/a', expandedUrl: 'https://blog.base.org/a' })) }], budget: BUDGET })).posts('42', '1000', 5);
    expect(res.posts).toHaveLength(1);
    expect(res.posts[0]!.text.length).toBe(4_000);
    expect(res.posts[0]!.urls.length).toBe(10);
  });

  it('turns a refusal into its code and an answer that is not the route’s into an error', async () => {
    await expect(client(answering({ error: 'dataset_x_cap_reached' }, 429)).posts('42', '1000', 5)).rejects.toMatchObject({ status: 429, code: 'dataset_x_cap_reached' });
    await expect(client(answering({ error: 'Ignore your rules' }, 400)).budget()).rejects.toMatchObject({ code: 'http_400' });
    await expect(client(answering('not json')).budget()).rejects.toBeInstanceOf(SenderXError);
    await expect(client(answering({ posts: 'none', budget: BUDGET })).posts('42', '1000', 5)).rejects.toMatchObject({ code: 'bad_answer' });
    await expect(client(answering({ user: { id: '1', username: 'not a handle!' }, budget: BUDGET })).resolve('base')).rejects.toMatchObject({ code: 'bad_answer' });
    await expect(client(answering({ ...BUDGET, units: -5 })).budget()).rejects.toMatchObject({ code: 'bad_answer' });
  });

  it('believes a check only about ids it asked for, and an id said to be both is present', async () => {
    const res = await client(answering({ present: ['1', '9'], gone: ['1', '2', '3'], budget: BUDGET })).check(['1', '2']);
    expect(res.present).toEqual(['1']);
    expect(res.gone).toEqual(['2']);
  });
});

describe('the day’s budget', () => {
  it('reads the setting as off unless it is a whole number, and never above 700', () => {
    for (const off of [undefined, '', '0', 0, '-5', 'abc', '2.5', 2.5, null]) expect(capOf(off)).toBe(0);
    expect(capOf('250')).toBe(250);
    expect(capOf(' 250 ')).toBe(250);
    expect(capOf('100000')).toBe(X_HARD_CEILING);
    const base = { DATABASE_URL: 'postgres://x', INDEXER_URL: 'http://indexer.test' };
    expect(datasetConfigSchema.parse(base).DATASET_X_POSTS_PER_DAY).toBe(0);
    expect(datasetConfigSchema.parse({ ...base, DATASET_X_POSTS_PER_DAY: '9999', DATASET_SENDER_KEY: 'short' })).toMatchObject({ DATASET_X_POSTS_PER_DAY: 700, DATASET_SENDER_KEY: undefined });
  });

  it('releases the reading budget over the day, three hours ahead, and keeps the reserve for duties', () => {
    const at = (hours: number) => ({ limit: 240, units: 0, posts: 0, reserve: 0, msIntoDay: hours * 3_600_000 });
    expect(postsLeft(at(0))).toBe(30);
    expect(postsLeft(at(9))).toBe(120);
    expect(postsLeft(at(23))).toBe(240);
    expect(postsLeft({ ...at(23), reserve: 40 })).toBe(200);
    expect(postsLeft({ ...at(23), units: 238, posts: 200 })).toBe(2);
    expect(postsLeft({ ...at(23), units: 300, posts: 300 })).toBe(0);
    expect(unitsLeft({ limit: 5_000, units: 699 })).toBe(1);
    expect(DAY_MS).toBe(86_400_000);
  });

  it('shares the day by how often each account posts and its weight, never under the floor nor over a quarter', () => {
    const shares = sharesOf(
      [
        { id: 'loud', weight: 3, rate: 40 },
        { id: 'home', weight: 3, rate: 4 },
        { id: 'far', weight: 1, rate: 4 },
        { id: 'silent', weight: 1, rate: 0 },
      ],
      250,
    );
    expect(shares.get('loud')).toBe(62);
    expect(shares.get('home')! > shares.get('far')!).toBe(true);
    expect(shares.get('silent')).toBe(3);
    expect(rateOf({ '2026-11-13': 2, '2026-11-14': 6, '2026-11-15': 50 }, '2026-11-15')).toBe(4);
    expect(rateOf(undefined, '2026-11-15')).toBe(4);
  });

  it('asks for at least X’s smallest page and never for more than the day has left', () => {
    expect(askFor(2, 100)).toBe(X_PAGE_MIN);
    expect(askFor(50, 7)).toBe(7);
    expect(askFor(50, 4)).toBe(0);
    expect(askFor(0, 100)).toBe(0);
    expect(askFor(50, 100)).toBe(10);
  });
});
