/**
 * One hosted turn of the platform account (@AgentBootr) with its post slot due, written against nothing but what
 * existed before stage 5 of docs/design/agent-behaviour.md (records for the platform account): the test world, the
 * tick, the platform's own sections. The same file was run against the code at the base of the stage (commit bdeeb17)
 * to record what the model was sent (`test/fixtures/records-base-turn.json`), and it runs against today's code in
 * `test/records-dark.test.ts`: with the dataset off, or with nothing to serve, the system prompt, the first observation
 * and the tools must be the recording's.
 *
 * It imports only from files that exist at the base, with names that exist there, so it can be copied into a tree of
 * that commit unchanged. To record again: `git archive bdeeb17 apps/supervisor apps/sender packages/agent-core
 * packages/shared` into an empty directory, link each `node_modules` to this checkout's, build that tree's agent-core,
 * copy this file and `records-base-record.test.ts` into its `apps/supervisor/test`, and run the second with vitest
 * there; it writes the fixture.
 *
 * `seed` runs after the account is seeded and before the tick: today's test puts dataset records in it.
 */
import { tick } from '../src/tick.js';
import type { IndexerClient } from '../src/indexer-client.js';
import { finishResponse, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const HOUR = 3_600_000;
/** Mid-morning UTC: no numbers post (15:00) and no weekly digest is due, and no platform update is dated yet. */
export const RECORDS_BASE_START = Date.parse('2026-10-24T10:00:00Z');

/** What the model was sent at the first step of the turn, and how many paid calls the tick made. */
export interface RecordedPlatformTurn {
  system: string;
  observation: Record<string, unknown>;
  tools: unknown[];
  calls: number;
}

export async function recordPlatformTurn(config: Record<string, string> = {}, seed?: (w: TestWorld) => Promise<void>): Promise<RecordedPlatformTurn> {
  const w = await makeWorld({ script: [finishResponse(RECORDS_BASE_START + 3 * HOUR)], config });
  try {
    w.setNow(RECORDS_BASE_START);
    (w.ctx as { indexer: IndexerClient }).indexer = { ...(w.indexer.client as object), platformFeed: async () => null, platformFees: async () => null, graphql: async () => null } as unknown as IndexerClient;
    await seedAgent(w, {
      config: { platform: true, xHandle: 'AgentBootr', requireApproval: false, socialStartedAt: new Date(RECORDS_BASE_START - 30 * HOUR).toISOString() },
      runtime: { lastDecisionAt: new Date(RECORDS_BASE_START - 60_000), nextAt: new Date(RECORDS_BASE_START - 1000) },
    });
    if (seed) await seed(w);
    const report = await tick(w.ctx);
    if (report.errors.length) throw new Error(`the tick failed: ${JSON.stringify(report.errors)}`);
    const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
    const call = calls[0];
    if (!call) throw new Error('no turn ran');
    const body = call.body as { messages: { role: string; content: string }[]; tools: unknown[] };
    return { system: body.messages.find((m) => m.role === 'system')!.content, observation: JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>, tools: body.tools, calls: calls.length };
  } finally {
    await w.close();
  }
}
