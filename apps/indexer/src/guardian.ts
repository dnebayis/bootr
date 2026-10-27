import { and, eq, lt } from 'ponder';
import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';

import { enabledSources } from './lib/env';
import { lc, updateAgentStatus } from './lib/store';

if (enabledSources().AgentGuardian) {
  ponder.on('AgentGuardian:Activity', async ({ event, context }) => {
    const a = await context.db.find(schema.agent, { id: lc(event.args.kernel) });
    if (!a) return;
    await updateAgentStatus(context, a, Number(event.block.timestamp), {
      lastActivityAt: Number(event.args.timestamp),
    });
  });

  ponder.on('AgentGuardian:AgentPaused', async ({ event, context }) => {
    const a = await context.db.find(schema.agent, { id: lc(event.args.kernel) });
    if (!a) return;
    await updateAgentStatus(context, a, Number(event.block.timestamp), { paused: event.args.paused });
  });

  ponder.on('AgentGuardian:DormantClaimed', async ({ event, context }) => {
    const kernel = lc(event.args.kernel);
    const a = await context.db.find(schema.agent, { id: kernel });
    if (!a) return;
    await context.db.insert(schema.dormantClaim).values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      token: a.token,
      kernel,
      usdc: event.args.usdcAmount,
      weth: event.args.wethAmount,
      eth: event.args.ethAmount,
      tokenBurned: event.args.tokenBurned,
      timestamp: Number(event.block.timestamp),
      txHash: event.transaction.hash,
    });
    // The sweep empties USDC/WETH/ETH and burns the agent's own coin.
    await updateAgentStatus(context, a, Number(event.block.timestamp), {
      claimed: true,
      treasuryUsdc: 0n,
      treasuryWeth: 0n,
      treasuryEth: 0n,
      treasuryOwnToken: 0n,
      treasuryUsd: 0,
    });
  });

  ponder.on('AgentGuardian:SessionKeyApproved', async ({ event, context }) => {
    const kernel = lc(event.args.kernel);
    if (!(await context.db.find(schema.agent, { id: kernel }))) return;
    const ts = Number(event.block.timestamp);
    await context.db
      .insert(schema.sessionKey)
      .values({
        id: `${kernel}-${lc(event.args.digest)}`,
        kernel,
        validationId: lc(event.args.validationId),
        nonce: event.args.nonce,
        digest: lc(event.args.digest),
        status: 'approved',
        approvedAt: ts,
        updatedAt: ts,
        txHash: event.transaction.hash,
      })
      .onConflictDoUpdate({ status: 'approved', updatedAt: ts, txHash: event.transaction.hash });
  });

  ponder.on('AgentGuardian:SessionKeyApprovalRevoked', async ({ event, context }) => {
    const id = `${lc(event.args.kernel)}-${lc(event.args.digest)}`;
    if (!(await context.db.find(schema.sessionKey, { id }))) return;
    await context.db.update(schema.sessionKey, { id }).set({ status: 'revoked', updatedAt: Number(event.block.timestamp) });
  });

  ponder.on('AgentGuardian:SessionKeyUninstalled', async ({ event, context }) => {
    await context.db.sql
      .update(schema.sessionKey)
      .set({ status: 'uninstalled', updatedAt: Number(event.block.timestamp) })
      .where(
        and(
          eq(schema.sessionKey.kernel, lc(event.args.kernel)),
          eq(schema.sessionKey.validationId, lc(event.args.validationId)),
        ),
      );
  });

  ponder.on('AgentGuardian:SessionNonceInvalidated', async ({ event, context }) => {
    // Kernel invalidates every non-root validation installed with a nonce below the new one.
    await context.db.sql
      .update(schema.sessionKey)
      .set({ status: 'invalidated', updatedAt: Number(event.block.timestamp) })
      .where(and(eq(schema.sessionKey.kernel, lc(event.args.kernel)), lt(schema.sessionKey.nonce, event.args.nonce)));
  });
}
