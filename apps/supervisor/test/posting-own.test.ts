/**
 * Threads, comments and the mention audience for an own agent (docs/design/agent-tools-2.md section 3.5 and
 * docs/design/byo-agent.md section 7.1): the creator's own AI client calls the same tools through the real engine
 * routes, with nobody's prompt to hold it, so every rule must be code. A thread is the turn's one original and needs
 * its slot; a client that scripts the API directly gets no further with the new fields than a model does.
 */
import { describe, expect, it } from 'vitest';
import { json } from '../../sender/test/helpers.js';
import { POST_ALREADY_SENT_THIS_TURN } from '../src/broker/index.js';
import { COMMENT_SOURCE_UNREAD } from '../src/comment-posts.js';
import { fileRequest } from '../src/creator-requests.js';
import { approvals } from '../src/db/schema.js';
import { mentionNotEngaged } from '../src/attributions.js';
import { slotsUsed } from '../src/rhythm.js';
import { AGENT_ID } from './helpers.js';
import { act, connectClient, openSocial, ownWorld, quietRuntime, seedOwn, stateOf, turnOf } from './own-helpers.js';
import { HOUR, T0, wire, xIdAt } from './posting-helpers.js';

const PARTS = ['An own agent thinks in its creator\'s client and posts through Bootr.', 'The limits are the same ones a hosted agent has, and they live in code.', 'So a thread from it is one post in every count.'];
const THREAD = { text: PARTS[0]!, thread: PARTS.slice(1).map((text) => ({ text })) };

async function setup(opts: { agent?: Record<string, unknown>; quiet?: boolean; config?: Record<string, string> } = {}) {
  const w = await wire(await ownWorld(opts.config ? { config: opts.config } : {}));
  const now = w.ctx.now();
  const quiet = quietRuntime(now);
  // by default the coin's original post is due: its social loop began ten hours ago and it never posted
  await seedOwn(w, opts.quiet ? { config: { ...quiet.config, ...(opts.agent ?? {}) }, runtime: quiet.runtime } : { config: { socialStartedAt: new Date(now - 10 * HOUR).toISOString(), ...(opts.agent ?? {}) } });
  const { credential } = await connectClient(w);
  return { w, credential };
}

describe('own agent: a thread', () => {
  it('is the turn\'s one original: all parts go out under one another, one step, one slot, and nothing original follows it', async () => {
    const { w, credential } = await setup();
    try {
      const turn = await openSocial(w, credential);
      const first = await act(w, credential, turn.turnId, 'publish_post', THREAD);
      expect(first.body).toMatchObject({ status: 'completed', result: { sent: 3, of: 3 }, stepsUsed: 1 });
      const rows = await w.senderRows();
      expect(w.posted().map((p) => [p.text, p.replyTo])).toEqual([[PARTS[0], null], [PARTS[1], rows[0]!.providerPostId], [PARTS[2], rows[1]!.providerPostId]]);
      expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(1);
      expect((await stateOf(w)).lastPostAt).toBe(w.ctx.now());
      expect(w.modelCalls()).toBe(0);

      // a second original in the same turn, single or thread, is refused: the thread used the slot (the guard that
      // speaks first is the slot's; with a creator request open it is `post_already_sent`, below)
      const second = await act(w, credential, turn.turnId, 'publish_post', { text: 'And one more original, please.' });
      expect(second.body.status).toBe('failed');
      expect(second.body.error).toMatch(/^post_slot_not_due: /);
      const another = await act(w, credential, turn.turnId, 'publish_post', { text: 'Another thread.', thread: [{ text: 'With a second part.' }] });
      expect(another.body.status).toBe('failed');
      expect(another.body.error).toMatch(/^post_slot_not_due: /);
      expect(w.posted()).toHaveLength(3);

      // the same call again (a client that retried after a timeout) is answered from the first one: nothing is sent twice
      const retried = await act(w, credential, turn.turnId, 'publish_post', THREAD);
      expect(retried.body).toMatchObject({ status: 'completed', result: { sent: 3, of: 3, postId: rows[0]!.providerPostId } });
      expect(w.posted()).toHaveLength(3);
      expect(await w.senderRows()).toHaveLength(3);
    } finally {
      await w.close();
    }
  });

  it('with a creator request open a turn still carries one original: a thread after a post is refused as a second one', async () => {
    const { w, credential } = await setup({ quiet: true });
    try {
      await fileRequest(w.ctx, AGENT_ID, { text: 'Post about the new coin page.', turn: 'social' });
      const turn = await openSocial(w, credential);
      const first = await act(w, credential, turn.turnId, 'publish_post', { text: 'The coin page got a new look this week.' });
      expect(first.body.status).toBe('completed');
      const thread = await act(w, credential, turn.turnId, 'publish_post', THREAD);
      expect(thread.body).toMatchObject({ status: 'failed', error: POST_ALREADY_SENT_THIS_TURN });
      expect(w.posted()).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('needs the due slot like any original: outside one nothing is sent', async () => {
    const { w, credential } = await setup({ quiet: true });
    try {
      const turn = await openSocial(w, credential, { reason: 'creator_asked' });
      const res = await act(w, credential, turn.turnId, 'publish_post', THREAD);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toMatch(/^post_slot_not_due: /);
      expect(w.posted()).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('in approval mode it is one queued item for the slot, and its rules are applied before the creator sees it', async () => {
    const { w, credential } = await setup({ agent: { requireApproval: true } });
    try {
      const turn = await openSocial(w, credential);
      const bad = await act(w, credential, turn.turnId, 'publish_post', { text: 'Opening.', thread: [{ text: 'A second part with an @stranger in it.' }] });
      expect(bad.body.status).toBe('failed');
      expect(bad.body.error).toMatch(/^mentions_require_source_credit: part 2 of the thread/);
      const queued = await act(w, credential, turn.turnId, 'publish_post', THREAD);
      expect(queued.body).toMatchObject({ status: 'completed', result: { queued: true } });
      const rows = await w.db.select().from(approvals);
      expect(rows).toHaveLength(1);
      expect((rows[0]!.meta as { thread: unknown }).thread).toEqual(THREAD.thread);
      expect(w.posted()).toEqual([]);
      const more = await act(w, credential, turn.turnId, 'publish_post', { text: 'A second original for the same slot.' });
      expect(more.body.status).toBe('failed');
      expect(more.body.error).toMatch(/^post_(slot_not_due|already_sent|already_queued): /);
    } finally {
      await w.close();
    }
  });

  it('a client that scripts the fields directly cannot name a reply target, add a part beyond the limit, or smuggle a field into a part', async () => {
    const { w, credential } = await setup();
    try {
      const turn = await openSocial(w, credential);
      const invalid: Record<string, unknown>[] = [
        { text: 'x', replyTo: '123' },
        { text: 'x', quote: { postId: '123' } },
        { text: 'x', thread: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] },
        { text: 'x', thread: [{ text: 'a', replyTo: '123' }] },
        { text: 'x', thread: [{ text: 'a', imageId: 'img_1' }] },
        { text: 'x', about: { postId: '123', authorId: '4201' } },
        { text: 'x', about: { postId: '123' }, aboutAuthorId: '4201' },
        { text: 'x', topic: 'Not A Slug' },
      ];
      for (const input of invalid) {
        const res = await act(w, credential, turn.turnId, 'publish_post', input);
        expect([input, res.status]).toEqual([input, 400]);
      }
      expect(w.posted()).toEqual([]);
      // none of it used the turn's one original
      expect((await turnOf(w))!.posted ?? false).toBe(false);
    } finally {
      await w.close();
    }
  });
});

describe('own agent: a comment and a mention', () => {
  const READ = xIdAt(T0 - HOUR, 5);
  const tweet = { id: READ, text: 'Fees belong on the coin page.', author_id: '4201', conversation_id: READ, created_at: new Date(T0 - HOUR).toISOString() };
  const user = { id: '4201', username: 'alice', verified: true, verified_type: 'blue' };

  it('comments only on a post it read in this turn, and the read is kept on the turn the engine stores', async () => {
    const { w, credential } = await setup();
    try {
      w.x.fake.on('GET', `/2/tweets/${READ}`, () => json({ data: tweet, includes: { users: [user] } }));
      const turn = await openSocial(w, credential);
      // a post id the client never read through Bootr
      const unread = await act(w, credential, turn.turnId, 'publish_post', { text: 'A thought about a post I did not read.', about: { postId: READ } });
      expect(unread.body).toMatchObject({ status: 'failed', error: COMMENT_SOURCE_UNREAD });
      const read = await act(w, credential, turn.turnId, 'read_x_thread', { postId: READ });
      expect(read.body.status).toBe('completed');
      expect((await turnOf(w))!.seen).toEqual([{ postId: READ, authorId: '4201', handle: 'alice', verified: true, verifiedType: 'blue', at: new Date(T0 - HOUR).toISOString(), via: 'thread' }]);
      const comment = await act(w, credential, turn.turnId, 'publish_post', { text: 'Alice is right that fees belong on the coin page: a holder should not have to ask.', about: { postId: READ } });
      expect(comment.body).toMatchObject({ status: 'completed', result: { about: { postId: READ, authorId: '4201', handle: 'alice' } } });
      // a post of its own at X: no reply target
      expect(w.posted()).toEqual([{ text: 'Alice is right that fees belong on the coin page: a holder should not have to ask.', replyTo: null }]);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('what an earlier turn read does not carry into the next one', async () => {
    const { w, credential } = await setup();
    try {
      w.x.fake.on('GET', `/2/tweets/${READ}`, () => json({ data: tweet, includes: { users: [user] } }));
      const first = await openSocial(w, credential);
      await act(w, credential, first.turnId, 'read_x_thread', { postId: READ });
      const finished = await w.run('finish', credential, { turnId: first.turnId, memory: 'm', agenda: 'a', summary: 's', nextAt: new Date(w.ctx.now() + HOUR).toISOString() });
      expect(finished.status).toBe(200);
      // the slot was passed on, so the next turn is opened by hand; its original still needs a slot, and its reads are its own
      const next = await openSocial(w, credential, { reason: 'creator_asked' });
      expect(next.turnId).not.toBe(first.turnId);
      expect((await turnOf(w))!.seen ?? []).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('an @ for somebody who did not write to the agent is refused for an own agent as for a hosted one', async () => {
    const { w, credential } = await setup();
    try {
      w.x.fake.on('GET', '/2/users/by/username/stranger', () => json({ data: { id: '5100', username: 'stranger' } }));
      w.x.fake.on('GET', '/2/users/5100/tweets', () => json({ data: [] }));
      const turn = await openSocial(w, credential);
      const res = await act(w, credential, turn.turnId, 'publish_post', { text: 'A sharp point from @stranger.', attributions: [{ username: 'stranger', sourceUrl: 'https://example.com/s' }] });
      expect(res.body).toMatchObject({ status: 'failed', error: mentionNotEngaged('stranger') });
      expect(w.posted()).toEqual([]);
      // the refusal did not use the turn's one original
      const plain = await act(w, credential, turn.turnId, 'publish_post', { text: 'A sharp point from stranger, named in words.' });
      expect(plain.body.status).toBe('completed');
      expect(AGENT_ID).toBe('7');
    } finally {
      await w.close();
    }
  });
});
