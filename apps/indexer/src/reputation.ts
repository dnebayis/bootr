import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';

import { enabledSources } from './lib/env';
import { toUnits } from './lib/price';
import { lc } from './lib/store';

const score = (sum: number, count: number) => (count > 0 ? Math.round((sum / count) * 1e4) / 1e4 : null);

if (enabledSources().ReputationRegistry) {
  /**
   * ERC-8004 ReputationRegistry (verified impl, getVersion 2.x):
   *   NewFeedback(agentId, clientAddress, feedbackIndex, int128 value, uint8 valueDecimals,
   *               indexedTag1, tag1, tag2, endpoint, feedbackURI, feedbackHash)
   *   FeedbackRevoked(agentId, clientAddress, feedbackIndex)
   * Score = mean of value / 10^valueDecimals over non-revoked feedback.
   */
  ponder.on('ReputationRegistry:NewFeedback', async ({ event, context }) => {
    const ident = await context.db.find(schema.agentIdentity, { id: event.args.agentId });
    if (!ident) return;
    const id = `${event.args.agentId}-${lc(event.args.clientAddress)}-${event.args.feedbackIndex}`;
    if (await context.db.find(schema.feedback, { id })) return;
    const value = toUnits(event.args.value, event.args.valueDecimals);
    await context.db.insert(schema.feedback).values({
      id,
      agentId: event.args.agentId,
      kernel: ident.kernel,
      client: lc(event.args.clientAddress),
      feedbackIndex: event.args.feedbackIndex,
      value,
      tag1: event.args.tag1,
      tag2: event.args.tag2,
      revoked: false,
      timestamp: Number(event.block.timestamp),
      txHash: event.transaction.hash,
    });
    await context.db.update(schema.agent, { id: ident.kernel }).set((a) => {
      const sum = a.reputationSum + value;
      const count = a.reputationCount + 1;
      return { reputationSum: sum, reputationCount: count, reputationScore: score(sum, count) };
    });
  });

  ponder.on('ReputationRegistry:FeedbackRevoked', async ({ event, context }) => {
    const id = `${event.args.agentId}-${lc(event.args.clientAddress)}-${event.args.feedbackIndex}`;
    const f = await context.db.find(schema.feedback, { id });
    if (!f || f.revoked) return;
    await context.db.update(schema.feedback, { id }).set({ revoked: true });
    await context.db.update(schema.agent, { id: f.kernel }).set((a) => {
      const sum = a.reputationSum - f.value;
      const count = Math.max(0, a.reputationCount - 1);
      return { reputationSum: count ? sum : 0, reputationCount: count, reputationScore: score(sum, count) };
    });
  });
}
