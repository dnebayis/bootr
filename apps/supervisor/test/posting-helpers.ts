/**
 * What the tests of the posting workstream share (docs/design/agent-tools-2.md section 17.9, row A): a world whose
 * sender is the REAL sender app in the same process, with a fake X behind it, so a thread is followed from the
 * broker down to the calls X would get; the limits at "off"; and small builders for a pending action, a broker
 * environment and a stored turn.
 */
import type { Action, PendingAction } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { saveAccount } from '../../sender/src/accounts.js';
import { signRequest as signSenderRequest } from '../../sender/src/auth.js';
import { actions as senderActions } from '../../sender/src/db/schema.js';
import { acceptPosts, json, setup as senderSetup, SERVICE_KEY as SENDER_KEY } from '../../sender/test/helpers.js';
import type { BrokerEnv } from '../src/broker/index.js';
import { actions, runtimes } from '../src/db/schema.js';
import type { Turn } from '../src/runtime.js';
import { SenderClient, type SenderInboxItem } from '../src/sender-client.js';
import { AGENT_ID, makeWorld, type TestWorld } from './helpers.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = Date.parse('2026-10-24T12:00:00Z');

export { POSTING_OFF } from './posting-off.limits.js';

export type SenderEnv = Awaited<ReturnType<typeof senderSetup>>;

export interface WiredWorld extends TestWorld {
  /** The real sender behind `ctx.sender`: its app, its database, its clock and the fake X it posts to. */
  x: SenderEnv;
  /** What the fake X was asked to post, in order: the text and the post each one replies to (null for an original). */
  posted(): { text: string; replyTo: string | null }[];
  /** The sender's rows of the test agent, oldest first. */
  senderRows(): Promise<(typeof senderActions.$inferSelect)[]>;
  /** Moves the supervisor's and the sender's clock together. */
  advance(ms: number): void;
}

/**
 * Puts the real sender behind a world: `ctx.sender` becomes the supervisor's own `SenderClient`, whose requests go
 * straight into the sender's app (signed at the sender's clock, since both clocks are the test's). The test agent's X
 * account (`bootr_agent`, user 1000) is connected there, and X takes every post unless a test says otherwise.
 */
export async function wire<W extends TestWorld>(world: W, opts: { verifiedType?: string | null } = {}): Promise<W & WiredWorld> {
  const x = await senderSetup({ connect: false });
  await saveAccount(
    x.ctx,
    AGENT_ID,
    { accessToken: 'access-token-secret', refreshToken: 'refresh-token-secret', expiresAt: new Date(x.clock.now().getTime() + 30 * DAY), scopes: 'tweet.read tweet.write users.read offline.access media.write' },
    { id: '1000', username: 'bootr_agent', ...(opts.verifiedType !== undefined ? { verifiedType: opts.verifiedType } : {}) },
  );
  acceptPosts(x.fake, x.clock);
  // Nobody wrote to the agent unless a test says so.
  x.fake.on('GET', '/2/users/1000/mentions', () => json({ data: [], meta: { result_count: 0 } }));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = `${url.pathname}${url.search}`;
    const raw = typeof init?.body === 'string' ? init.body : '';
    return x.app.request(path, { method, headers: { authorization: signSenderRequest(SENDER_KEY, method, path, raw, Math.floor(x.clock.now().getTime() / 1000)), ...(raw ? { 'content-type': 'application/json' } : {}) }, body: raw || undefined });
  };
  world.ctx.sender = new SenderClient('http://sender.test', SENDER_KEY, fetchImpl);
  const close = world.close;
  const setNow = world.setNow;
  return Object.assign(world, {
    x,
    posted: () => x.fake.calls.filter((c) => c.method === 'POST' && c.path === '/2/tweets').map((c) => ({ text: (c.body as { text: string }).text, replyTo: (c.body as { reply?: { in_reply_to_tweet_id: string } }).reply?.in_reply_to_tweet_id ?? null })),
    senderRows: async () => (await x.db.select().from(senderActions)).filter((r) => r.agentId === AGENT_ID).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.actionId < b.actionId ? -1 : 1)),
    advance: (ms: number) => {
      x.clock.advance(ms);
      setNow(world.ctx.now() + ms);
    },
    close: async () => {
      await x.close();
      await close();
    },
  });
}

export async function wiredWorld(opts: Parameters<typeof makeWorld>[0] & { verifiedType?: string | null } = {}): Promise<WiredWorld> {
  const { verifiedType, ...rest } = opts;
  return wire(await makeWorld(rest), verifiedType !== undefined ? { verifiedType } : {});
}

/** A pending action as the runtime hands it to the broker: already marked sent, keyed by its id. */
export function pendingOf(id: string, tool: Action['tool'], input: Record<string, unknown>): PendingAction {
  return { id, cycleKey: `cycle:${id}`, action: { tool, input } as unknown as Action, status: 'sent', createdAt: 0, attempts: 1 };
}

export const brokerEnv = (items: SenderInboxItem[] = []): BrokerEnv => ({ inbox: new Map(items.map((i) => [i.postId, i])), eligibility: new Map(), cycle: 1 });

/** Stores a turn on the test agent's runtime, as both loops do before an action leaves the process. */
export async function storeTurn(world: TestWorld, turn: Partial<Turn>, agentId: string = AGENT_ID): Promise<void> {
  const full: Turn = { role: 'social', startedAt: world.ctx.now(), steps: 0, nudged: false, reasons: [], messages: [], inbox: {}, recentSteps: [], ...turn };
  await world.db.update(runtimes).set({ turn: full as unknown as Record<string, unknown> }).where(eq(runtimes.agentId, agentId));
}

/** A hosted turn's first observation as the loop stores it: the system prompt, then the observation as the first user message. */
export function observed(observation: Record<string, unknown>): Pick<Turn, 'messages'> {
  return { messages: [{ role: 'system', content: 'system prompt' }, { role: 'user', content: JSON.stringify(observation) }] };
}

/** The action row a step writes before it runs, so the counts that leave the action being decided out see the others. */
export async function actionRow(world: TestWorld, id: string, action: Record<string, unknown>, over: Partial<typeof actions.$inferInsert> = {}): Promise<void> {
  const at = new Date(world.ctx.now());
  await world.db.insert(actions).values({ actionId: id, agentId: AGENT_ID, cycleKey: `cycle:${id}`, action, status: 'completed', createdAt: at, updatedAt: at, ...over });
}

/** An X id made at `ms`: ids carry their own clock (a snowflake), which is how the age of a post is known when the read gave no date. */
export function xIdAt(ms: number, seq = 0): string {
  return ((BigInt(ms) - 1_288_834_974_657n) << 22n | BigInt(seq)).toString();
}

/** A post as `read_x_thread` returns it. */
export function xPost(id: string, author: { id: string; username: string; verified?: boolean; verifiedType?: 'blue' | 'business' | 'government' | 'none' }, text = 'something worth a thought', createdAt?: string) {
  return { id, text, authorId: author.id, conversationId: id, ...(createdAt ? { createdAt } : {}), author };
}
