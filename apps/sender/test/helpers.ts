import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { saveAccount } from '../src/accounts.js';
import { createApp } from '../src/app.js';
import { signRequest } from '../src/auth.js';
import type { SenderContext } from '../src/context.js';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { XClient, type XTweet } from '../src/x-client.js';

export const SERVICE_KEY = 'test-service-key-0123456789abcdef0123456789';
export const ENC_KEY = Buffer.from('11'.repeat(32), 'hex');
export const AGENT = 'agent-1';
export const AGENT_X_ID = '1000';
export const AGENT_HANDLE = 'bootr_agent';

type Handler = (req: {
  method: string;
  url: URL;
  body: unknown;
  headers: Headers;
}) => Response | Promise<Response>;

/** Manual fetch stub for api.x.com. Routes by "METHOD /path"; records every call. */
export class FakeX {
  calls: { method: string; path: string; url: URL; body: unknown }[] = [];
  routes = new Map<string, Handler>();
  posted: XTweet[] = [];
  private nextId = 5000n;

  on(method: string, path: string | RegExp, handler: Handler): this {
    this.routes.set(`${method} ${typeof path === 'string' ? path : path.source}`, handler);
    return this;
  }

  count(method: string, pathPrefix: string): number {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix)).length;
  }

  newId(): string {
    this.nextId += 1n;
    return this.nextId.toString();
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = init?.body;
    let body: unknown = raw;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    this.calls.push({ method, path: url.pathname, url, body });
    for (const [key, h] of this.routes) {
      const [m, p] = key.split(' ', 2) as [string, string];
      if (m !== method) continue;
      if (p === url.pathname || new RegExp(`^${p}$`).test(url.pathname)) {
        return h({ method, url, body, headers: new Headers(init?.headers) });
      }
    }
    return json({ title: 'Not Found' }, 404);
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function timeoutError(): never {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

export class Clock {
  constructor(public t = new Date('2026-10-24T12:00:00.000Z')) {}
  now = () => new Date(this.t.getTime());
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export async function setup(opts: { connect?: boolean } = {}) {
  const pg = new PGlite();
  const db = drizzle(pg, { schema }) as unknown as Db;
  await migrate(drizzle(pg), {
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    migrationsTable: MIGRATIONS_TABLE,
    migrationsSchema: MIGRATIONS_SCHEMA,
  });
  const clock = new Clock();
  const fake = new FakeX();
  const ctx: SenderContext = {
    db,
    x: new XClient({
      baseUrl: 'https://api.x.test',
      fetch: fake.fetch,
      now: () => clock.now().getTime(),
      sleep: async () => {},
    }),
    oauth: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://sender.test/oauth/callback',
      authorizeUrl: 'https://x.test/i/oauth2/authorize',
      tokenUrl: 'https://api.x.test/2/oauth2/token',
      serviceKey: SERVICE_KEY,
      encryptionKey: ENC_KEY,
      fetch: fake.fetch,
    },
    encryptionKey: ENC_KEY,
    serviceKey: SERVICE_KEY,
    now: clock.now,
    defaults: { postsPerDay: 24, mentionReadIntervalSec: 300, readsPerDay: 400 },
    xTimeoutMs: 15_000,
  };
  if (opts.connect !== false) {
    await saveAccount(
      ctx,
      AGENT,
      {
        accessToken: 'access-token-secret',
        refreshToken: 'refresh-token-secret',
        expiresAt: new Date(clock.now().getTime() + 2 * 3600_000),
        scopes: 'tweet.read tweet.write users.read offline.access media.write',
      },
      { id: AGENT_X_ID, username: AGENT_HANDLE },
    );
  }
  const app = createApp(ctx);

  /** Signed internal call. */
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const auth = signRequest(
      SERVICE_KEY,
      method,
      path,
      raw,
      Math.floor(clock.now().getTime() / 1000),
    );
    const res = await app.request(path, {
      method,
      headers: { authorization: auth, ...(raw ? { 'content-type': 'application/json' } : {}) },
      body: raw || undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in assertions
    return { status: res.status, body: (await res.json()) as any };
  };

  return { pg, db, ctx, app, clock, fake, call, close: () => pg.close() };
}

/** Default X behaviour: POST /2/tweets succeeds and records the tweet on the agent timeline. */
export function acceptPosts(fake: FakeX, clock: Clock) {
  fake.on('POST', '/2/tweets', ({ body }) => {
    const b = body as { text: string; reply?: { in_reply_to_tweet_id: string } };
    const tweet: XTweet = {
      id: fake.newId(),
      text: b.text,
      author_id: AGENT_X_ID,
      created_at: clock
        .now()
        .toISOString()
        .replace(/\.\d{3}Z$/, '.000Z'),
      ...(b.reply
        ? { referenced_tweets: [{ type: 'replied_to' as const, id: b.reply.in_reply_to_tweet_id }] }
        : {}),
    };
    fake.posted.push(tweet);
    return json({ data: { id: tweet.id, text: tweet.text } }, 201);
  });
}
