/**
 * Two hosted turns of a coin agent, written against nothing but what existed before the agent tools of round two
 * (docs/design/agent-tools-2.md): the test world, the action and metrics tables as they were, the tick. The same file
 * was run against the code at the base of that round (commit f1e1b2e) to record what the model was sent
 * (`test/fixtures/base-turn-*.json`), and it runs against today's code with every limit of the round at 0
 * (`test/round-off.test.ts`): the system prompt, the first observation and the tools must be the same.
 *
 * It imports only from files that exist at the base, with names that exist there, so it can be copied into a tree of
 * that commit unchanged (how the recording was made is said at the head of `test/round-off.test.ts`).
 */
import { actions, approvals, postMetrics } from '../src/db/schema.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent } from './helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-10-24T12:00:00Z');

export const BASE_TURN_SCENARIOS = ['quiet', 'busy'] as const;
export type BaseTurnScenario = (typeof BASE_TURN_SCENARIOS)[number];

/** What the model was sent at the first step of the turn. */
export interface RecordedTurn {
  system: string;
  observation: Record<string, unknown>;
  tools: unknown[];
}

const sentPost = (id: string, text: string, agoMs: number, postId: string, tool: 'publish_post' | 'publish_reply' = 'publish_post', input: Record<string, unknown> = {}) => ({
  actionId: id,
  agentId: AGENT_ID,
  cycleKey: `cycle:${id}`,
  action: { tool, input: { text, ...input } },
  status: 'completed',
  attempts: 1,
  result: { actionId: id, tool, status: 'completed', result: { postId } },
  createdAt: new Date(START - agoMs),
  updatedAt: new Date(START - agoMs),
});

const mention = (postId: string, authorId: string, text: string, verified: boolean) => ({
  postId,
  authorId,
  conversationId: postId,
  status: 'pending',
  observedAt: new Date(START - 60_000).toISOString(),
  seenAt: null,
  deferredUntil: null,
  post: { id: postId, authorId, text, createdAt: new Date(START - 120_000).toISOString(), conversationId: postId, author: { id: authorId, username: `user${authorId}`, verified, ...(verified ? { verifiedType: 'blue' } : {}) } },
});

/**
 * Runs one tick for the test agent in `scenario` and returns what its model was sent.
 *   - `quiet`: a coin whose post slot is due and that has said nothing yet;
 *   - `busy`: a coin with posts and a reply behind it (one of them a question), measured posts, a rejected post in the
 *     review queue's history, a mention from a verified account and two from accounts without a badge (a statement,
 *     and a question), and a post slot that is due.
 */
export async function recordTurn(scenario: BaseTurnScenario, config: Record<string, string> = {}): Promise<RecordedTurn> {
  const w = await makeWorld({ script: [finishResponse(START + 3 * HOUR)], config });
  try {
    await seedAgent(w, { config: { socialStartedAt: new Date(START - 10 * HOUR).toISOString() } });
    if (scenario === 'busy') {
      await w.db.insert(actions).values([
        sentPost('act-base-0001', 'The coin page shows who holds the coin and where every fee went.', 26 * HOUR, '9101'),
        sentPost('act-base-0002', 'Fees from every trade are split at launch. What would you change about that split?', 20 * HOUR, '9102'),
        sentPost('act-base-0003', 'It is fixed at launch and shown on the coin page.', 19 * HOUR, '9103', 'publish_reply', { postId: '8001' }),
        sentPost('act-base-0004', 'A quiet morning: three new holders and a handful of trades.', 5 * HOUR, '9104'),
      ] as never);
      await w.db.insert(approvals).values([{ id: 'act-base-0005', agentId: AGENT_ID, kind: 'post', text: 'A post the creator did not like.', textHash: 'base-hash-0005', status: 'rejected', decision: 'reject', note: 'Too vague. Say one concrete thing.', createdAt: new Date(START - 30 * HOUR), decidedAt: new Date(START - 29 * HOUR) }] as never);
      await w.db.insert(postMetrics).values([
        { postId: '9101', agentId: AGENT_ID, kind: 'post', excerpt: 'The coin page shows who holds the coin and where every fee went.', postedAt: new Date(START - 3 * DAY), measuredAt: new Date(START - 2 * DAY), likes: 12, replies: 3, reposts: 2, quotes: 0, impressions: 900 },
        { postId: '9102', agentId: AGENT_ID, kind: 'post', excerpt: 'Fees from every trade are split at launch.', postedAt: new Date(START - 2 * DAY), measuredAt: new Date(START - DAY), likes: 2, replies: 0, reposts: 0, quotes: 0, impressions: 150 },
        { postId: '9103', agentId: AGENT_ID, kind: 'reply', excerpt: 'It is fixed at launch and shown on the coin page.', postedAt: new Date(START - 2 * DAY), measuredAt: new Date(START - DAY), likes: 1, replies: 1, reposts: 0, quotes: 0, impressions: 40 },
      ] as never);
      w.sender.items = [mention('8101', '4301', '@bootr_agent what does the agent do with its share of the fees?', true), mention('8102', '4302', '@bootr_agent nice coin', false), mention('8103', '4303', '@bootr_agent how do I find the contract?', false)] as never;
    }
    const report = await tick(w.ctx);
    if (report.errors.length) throw new Error(`the tick failed: ${JSON.stringify(report.errors)}`);
    const call = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'));
    if (!call) throw new Error(`no turn ran in the ${scenario} scenario`);
    const body = call.body as { messages: { role: string; content: string }[]; tools: unknown[] };
    return { system: body.messages.find((m) => m.role === 'system')!.content, observation: JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>, tools: body.tools };
  } finally {
    await w.close();
  }
}
