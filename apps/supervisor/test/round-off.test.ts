/**
 * With every limit of the agent tools of round two at 0, a hosted turn is what it was before the round
 * (docs/design/agent-tools-2.md sections 12, 13 and 17.9): the system prompt, the first observation and the tools the
 * model is sent are compared, value for value, with what the code at the base of the round sent for the same turn.
 *
 * The base's answer is a recording, not a description: `fixtures/base-turn-quiet.json` and `base-turn-busy.json` hold
 * what `recordTurn` (base-turn-scenario.ts) returned when it was run against commit f1e1b2e, the commit the four
 * workstreams branched from. To make them again: unpack that commit's `apps/supervisor`, `apps/sender`,
 * `packages/agent-core` and `packages/shared` into an empty directory (`git archive f1e1b2e ...`), link each
 * `node_modules` to this checkout's, copy `base-turn-scenario.ts` into its `apps/supervisor/test`, and run it there
 * with vitest, with `@bootr/agent-core` and `@bootr/shared/*` aliased to that tree's own sources so that nothing of
 * today's code is loaded. The scenario file imports only what existed at the base.
 *
 * With the defaults the same turns differ, and the second half says by exactly what: the tools and sections the round
 * added, and nothing else that was there before.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASE_TURN_SCENARIOS, recordTurn, type RecordedTurn } from './base-turn-scenario.js';
import { POSTING_DEFAULTS } from './posting-off.limits.js';
import { ROUND_OFF } from './round-off.limits.js';

const base = (scenario: string): RecordedTurn => JSON.parse(readFileSync(new URL(`./fixtures/base-turn-${scenario}.json`, import.meta.url), 'utf8')) as RecordedTurn;
const names = (tools: unknown[]): string[] => (tools as { function: { name: string } }[]).map((t) => t.function.name);
const byName = (tools: unknown[]) => new Map((tools as { function: { name: string } }[]).map((t) => [t.function.name, t]));
const without = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** The tools the round added to a hosted social turn, and the observation sections it added or renamed. */
const NEW_TOOLS = ['note_what_works', 'schedule_post', 'scheduled_list', 'scheduled_cancel'];
const NEW_SECTIONS = ['coinToday', 'scheduled', 'whatWorks', 'yourCoin', 'openReplies'];

describe('every limit of the round at 0: a hosted turn is the base\'s, value for value', () => {
  for (const scenario of BASE_TURN_SCENARIOS) {
    it(`the ${scenario} turn: the same prompt, the same observation, the same tools`, async () => {
      const before = base(scenario);
      const now = await recordTurn(scenario, ROUND_OFF);
      expect(now.system).toBe(before.system);
      expect(names(now.tools)).toEqual(names(before.tools));
      expect(now.tools).toEqual(before.tools);
      expect(Object.keys(now.observation).sort()).toEqual(Object.keys(before.observation).sort());
      expect(now.observation).toEqual(before.observation);
    });
  }

  it('the recordings are of a turn worth comparing: a due post, mentions, what was said and how it did', () => {
    const quiet = base('quiet');
    const busy = base('busy');
    expect(names(quiet.tools)).toEqual(['read_mentions', 'read_x_thread', 'read_x_account', 'recall_conversation', 'publish_reply', 'resolve_mention', 'resolve_mentions', 'publish_post', 'remember', 'recall', 'finish', 'read_url', 'read_market', 'read_coin', 'read_chain', 'treasury_read', 'treasury_prepare', 'treasury_execute']);
    for (const key of ['postPerformance', 'recentPosts', 'questions', 'postBudget', 'review', 'social']) expect(busy.observation, key).toHaveProperty(key);
    // at the base an account without a badge was not answered, whatever it asked: one message reached the model
    expect((busy.observation.social as { messages: unknown[] }).messages).toHaveLength(1);
    expect(busy.observation.ineligibleMentions).toBe(0);
  });
});

describe('with the defaults the same turns differ by what the round added, and by nothing else', () => {
  it('the quiet turn: four more tools, publish_post takes more, two more sections; the prompt and every other value are the base\'s', async () => {
    const before = base('quiet');
    const now = await recordTurn('quiet', POSTING_DEFAULTS);
    // the pinned prompt of a coin agent is not edited by the round
    expect(now.system).toBe(before.system);
    expect(names(now.tools).filter((n) => !NEW_TOOLS.includes(n))).toEqual(names(before.tools));
    expect(names(now.tools).filter((n) => NEW_TOOLS.includes(n)).sort()).toEqual([...NEW_TOOLS].sort());
    // every tool that existed is the same but publish_post, which gained fields and sentences
    const was = byName(before.tools);
    for (const [name, tool] of byName(now.tools)) {
      if (NEW_TOOLS.includes(name) || name === 'publish_post') continue;
      expect(tool, name).toEqual(was.get(name));
    }
    const publish = byName(now.tools).get('publish_post') as unknown as { function: { description: string; parameters: { properties: Record<string, unknown> } } };
    expect(Object.keys(publish.function.parameters.properties)).toEqual(['text', 'thread', 'attributions', 'imageId', 'about', 'topic']);
    // the observation: the sections of before with the values of before, and the new ones beside them
    // (this world's indexer knows nothing of the coin's day, so the round's `coinToday` has nothing to say here)
    expect(Object.keys(now.observation).filter((k) => !Object.keys(before.observation).includes(k)).sort()).toEqual(['scheduled', 'yourCoin']);
    expect(without(now.observation, [...NEW_SECTIONS, 'tools'])).toEqual(without(before.observation, ['tools']));
    expect((now.observation.tools as string[]).filter((n) => !NEW_TOOLS.includes(n))).toEqual(before.observation.tools);
  });

  it('the busy turn: the question from an account without a badge is now shown with its reason, the performance section became whatWorks, and the rest is the base\'s', async () => {
    const before = base('busy');
    const now = await recordTurn('busy', POSTING_DEFAULTS);
    expect(now.system).toBe(before.system);
    expect(Object.keys(now.observation).filter((k) => !Object.keys(before.observation).includes(k)).sort()).toEqual(['openReplies', 'scheduled', 'whatWorks', 'yourCoin']);
    expect(Object.keys(before.observation).filter((k) => !Object.keys(now.observation).includes(k))).toEqual(['postPerformance']);
    // the seven-day digest line the old section carried is in the new one, word for word
    expect((now.observation.whatWorks as { digest: string }).digest).toBe((before.observation.postPerformance as { digest: string }).digest);
    // who gets a reply: the verified account as before, and now the stranger who asked; the stranger's statement is closed as before
    const messages = (o: Record<string, unknown>) => (o.social as { messages: { postId: string; eligibleBecause?: string }[] }).messages;
    expect(messages(before.observation).map((m) => m.postId)).toEqual(['8101']);
    expect(messages(now.observation).map((m) => [m.postId, m.eligibleBecause ?? null])).toEqual([['8101', null], ['8103', 'asked_a_question']]);
    expect(messages(now.observation)[0]).toEqual(messages(before.observation)[0]);
    // everything else that was there is unchanged
    const social = (o: Record<string, unknown>) => without(o.social as Record<string, unknown>, ['messages']);
    expect(social(now.observation)).toEqual(social(before.observation));
    expect(without(now.observation, [...NEW_SECTIONS, 'tools', 'social'])).toEqual(without(before.observation, ['postPerformance', 'tools', 'social']));
  });
});
