/**
 * Own agents, after the security review of the engine (docs/design/byo-agent.md "Limits added after review"): two
 * things a hosted model is kept from by its prompt and its wake rule, and an own client only by code. A mention is
 * answered once in a turn, and nothing is published while an X hold stands. Through the real internal routes.
 */
import { describe, expect, it } from 'vitest';
import { mentionAlreadyHandled } from '../src/broker/index.js';
import { creditsHold, forbiddenHold, quotaHold } from '../src/rhythm.js';
import { act, connectClient, finishInput, mention, openSocial, ownWorld, patchState, quietRuntime, seedOwn, stateOf, turnOf, type OwnWorld } from './own-helpers.js';

const HOUR = 3_600_000;
const MIN = 60_000;

async function setup(mentions: ReturnType<typeof mention>[]) {
  const w = await ownWorld();
  const quiet = quietRuntime(w.ctx.now());
  await seedOwn(w, { config: quiet.config, runtime: quiet.runtime });
  w.sender.items = mentions;
  const { credential } = await connectClient(w);
  return { w, credential };
}

/** Every publish the sender is asked for, whatever it answers. */
function countPublishes(w: OwnWorld): () => number {
  const publish = w.sender.client.publish.bind(w.sender.client);
  let n = 0;
  w.sender.client.publish = (async (...args: Parameters<typeof publish>) => {
    n += 1;
    return publish(...args);
  }) as typeof publish;
  return () => n;
}

describe('own agent: a mention is answered once in a turn', () => {
  it('refuses a second reply to a post the turn already answered, and a reply to one it already closed', async () => {
    const { w, credential } = await setup([mention('1001'), mention('1002'), mention('1003'), mention('1004')]);
    try {
      const asked = countPublishes(w);
      const turn = await openSocial(w, credential);
      const first = await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'It is a test coin, thanks for asking.' });
      expect(first.body.status).toBe('completed');
      // Other words to the same post: not a retry of the first call, a second answer.
      const again = await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'And another thing about the coin, while I am here.' });
      expect(again.body).toMatchObject({ status: 'failed', error: mentionAlreadyHandled('1001') });
      // The very same call again is still a retry: answered from its row, nothing sent.
      expect((await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'It is a test coin, thanks for asking.' })).body).toMatchObject({ status: 'completed', actionId: first.body.actionId });

      expect((await act(w, credential, turn.turnId, 'resolve_mention', { postId: '1002', outcome: 'skip', reason: 'nothing to add' })).body.status).toBe('completed');
      const afterResolve = await act(w, credential, turn.turnId, 'publish_reply', { postId: '1002', text: 'On second thought, here is an answer.' });
      expect(afterResolve.body).toMatchObject({ status: 'failed', error: mentionAlreadyHandled('1002') });
      expect((await act(w, credential, turn.turnId, 'resolve_mentions', { postIds: ['1003'], outcome: 'skip', reason: 'nothing to add' })).body.status).toBe('completed');
      expect((await act(w, credential, turn.turnId, 'publish_reply', { postId: '1003', text: 'And here is one for you too.' })).body).toMatchObject({ status: 'failed', error: mentionAlreadyHandled('1003') });
      // A mention nobody touched is answered as ever.
      expect((await act(w, credential, turn.turnId, 'publish_reply', { postId: '1004', text: 'Thanks, that is a fair point.' })).body.status).toBe('completed');
      expect(asked()).toBe(2);
      expect(w.sender.published).toHaveLength(2);
      expect((await turnOf(w))?.ownHandled).toEqual(['1001', '1002', '1003', '1004']);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });
});

describe('own agent: nothing is published while an X hold stands', () => {
  it('after the quota refusal set the hold, a publish in the same turn does not reach the sender and is told when the hold ends', async () => {
    const { w, credential } = await setup([mention('1001')]);
    try {
      const asked = countPublishes(w);
      const retryAt = new Date(w.ctx.now() + 3 * HOUR).toISOString();
      const turn = await openSocial(w, credential);
      w.sender.quotaExceeded = retryAt;
      expect((await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'It is a test coin, thanks for asking.' })).body).toMatchObject({ status: 'failed', error: 'sender:quota_exceeded' });
      expect(asked()).toBe(1);
      const held = await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'Let me try that again in other words.' });
      expect(held.body.status).toBe('failed');
      expect(held.body.error).toBe(quotaHold(Date.parse(retryAt), w.ctx.now())!.message);
      expect(held.body.error).toContain(retryAt);
      expect(asked()).toBe(1);
      // The hold is what it was: a refusal by the engine does not move it.
      expect((await stateOf(w)).postQuotaUntil).toBe(Date.parse(retryAt));
      await w.run('finish', credential, { turnId: turn.turnId, ...finishInput(w) });

      // Once it has run out, the reply goes out.
      w.sender.quotaExceeded = null;
      w.setNow(Date.parse(retryAt) + MIN);
      const next = await openSocial(w, credential);
      expect((await act(w, credential, next.turnId, 'publish_reply', { postId: '1001', text: 'It is a test coin, thanks for asking.' })).body.status).toBe('completed');
      expect(asked()).toBe(2);
    } finally {
      await w.close();
    }
  });

  it('the same for a credits hold and a 403 hold, for posts and replies alike; reading and closing mentions go on', async () => {
    const { w, credential } = await setup([mention('1001')]);
    try {
      const asked = countPublishes(w);
      const now = w.ctx.now();
      const turn = await openSocial(w, credential, { reason: 'creator_asked' });
      await patchState(w, { postForbiddenUntil: now + 6 * HOUR, postForbiddenStrikes: 1, postForbiddenAt: now });
      const reply = await act(w, credential, turn.turnId, 'publish_reply', { postId: '1001', text: 'It is a test coin, thanks for asking.' });
      expect(reply.body).toMatchObject({ status: 'failed', error: forbiddenHold(now + 6 * HOUR, now)!.message });
      expect(reply.body.error).toContain(new Date(now + 6 * HOUR).toISOString());
      await patchState(w, { postForbiddenUntil: null, postCreditsUntil: now + 30 * MIN });
      const post = await act(w, credential, turn.turnId, 'publish_post', { text: 'Good morning from the test coin.' });
      expect(post.body).toMatchObject({ status: 'failed', error: creditsHold(now + 30 * MIN, now)!.message });
      expect(asked()).toBe(0);
      // Neither refusal set a new hold or a strike.
      expect(await stateOf(w)).toMatchObject({ postCreditsUntil: now + 30 * MIN, postForbiddenStrikes: 1 });
      expect((await act(w, credential, turn.turnId, 'read_mentions')).body.status).toBe('completed');
      expect((await act(w, credential, turn.turnId, 'resolve_mention', { postId: '1001', outcome: 'defer', reason: 'held', reviewAt: new Date(now + HOUR).toISOString() })).body.status).toBe('completed');
    } finally {
      await w.close();
    }
  });
});
