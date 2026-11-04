import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';

import { enabledSources } from './lib/env';
import { applySwap, applyTransfer } from './lib/market';
import { lc } from './lib/store';

if (enabledSources().PoolManager) {
  /**
   * Every PoolManager swap is delivered; only pools registered by `AgentLaunched` are kept
   * (Ponder log filters cannot match a dynamic set of pool ids).
   */
  ponder.on('PoolManager:Swap', async ({ event, context }) => {
    const p = await context.db.find(schema.pool, { id: lc(event.args.id) });
    if (!p) return;
    const t = await context.db.find(schema.token, { id: p.token });
    if (!t || t.launchTx === event.transaction.hash) return; // launch tx is replayed by AgentLaunched
    await applySwap(
      context,
      t,
      {
        amount0: event.args.amount0,
        amount1: event.args.amount1,
        sqrtPriceX96: event.args.sqrtPriceX96,
        liquidity: event.args.liquidity,
        tick: event.args.tick,
        fee: event.args.fee,
        sender: event.args.sender,
      },
      {
        txHash: event.transaction.hash,
        logIndex: event.log.logIndex,
        blockNumber: event.block.number,
        timestamp: Number(event.block.timestamp),
        from: event.transaction.from,
      },
    );
  });
}

if (enabledSources().BootrToken) {
  ponder.on('BootrToken:Transfer', async ({ event, context }) => {
    const token = lc(event.log.address);
    const t = await context.db.find(schema.token, { id: token });
    if (!t || t.launchTx === event.transaction.hash) return; // launch tx is replayed by AgentLaunched
    await applyTransfer(context, token, event.args.from, event.args.to, event.args.value, Number(event.block.timestamp), event.transaction.hash);
  });
}
