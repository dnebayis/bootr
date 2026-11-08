import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST } from './route';

/** The draft route had no rate limit and no wallet behind it: one file per uuid, as many as anyone cared to send. */
const TEXT = 'A patient onchain analyst for small Base coins. Short, plain, no hype.';
const uuid = (n: number) => `0b7f6a52-3c1e-4d0a-9f3e-${n.toString(16).padStart(12, '0')}`;

describe('POST /api/launch/draft', () => {
  let dir: string;
  const saved = process.env.LAUNCH_DRAFTS_DIR;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bootr-draft-route-'));
    process.env.LAUNCH_DRAFTS_DIR = dir;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.LAUNCH_DRAFTS_DIR;
    else process.env.LAUNCH_DRAFTS_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const post = (ip: string, body: Record<string, unknown>) =>
    POST(
      new NextRequest('http://localhost/api/launch/draft', {
        method: 'POST',
        headers: { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json', 'x-real-ip': ip },
        body: JSON.stringify(body),
      }),
    );

  it('takes 20 writes a minute per IP, then answers 429 rate_limited with Retry-After, and other addresses go on', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await post('198.51.100.5', { draftId: uuid(i), identity: TEXT });
      expect(res.status).toBe(200);
    }
    const refused = await post('198.51.100.5', { draftId: uuid(20), identity: TEXT });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await refused.json()).toEqual({ error: 'rate_limited', message: expect.stringContaining('20 requests per minute per IP') });
    expect((await readdir(dir)).filter((n) => n.endsWith('.json'))).toHaveLength(20);
    // the limit is per address, and a refusal still comes before the body is looked at
    expect((await post('198.51.100.6', { draftId: uuid(21), identity: TEXT })).status).toBe(200);
    expect((await post('198.51.100.5', { draftId: 'not a uuid', identity: TEXT })).status).toBe(429);
  });
});
