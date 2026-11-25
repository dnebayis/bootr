import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';

import { enabledSources, indexerEnv } from './lib/env';
import { applyTransfer } from './lib/market';
import { lc } from './lib/store';
import { swapsAfter, swapsBefore, syncAt } from './lib/swap-sync';
import { touchesPoolManager } from './lib/swaps';

if (enabledSources().BootrToken) {
  /**
   * A coin's ERC-20 `Transfer`: balances, holders, supply and the dead balance. It is also how the indexer learns of
   * swaps: there is no `PoolManager` source (Ponder cannot filter `Swap` by a growing pool id list, so that source
   * delivered every v4 swap on Base), and a swap in a coin's pool moves the coin to or from the PoolManager. Such a
   * transfer is a sync point: the pool's `Swap` logs are read from the transaction's receipt and applied in log
   * order, the ones before this log ahead of the transfer and the rest after it when no later sync point follows
   * (lib/swaps.ts, lib/swap-sync.ts).
   */
  ponder.on('BootrToken:Transfer', async ({ event, context }) => {
    const token = lc(event.log.address);
    const t = await context.db.find(schema.token, { id: token });
    if (!t || t.launchTx === event.transaction.hash) return; // launch tx is replayed by AgentLaunched
    const inPool = touchesPoolManager(event.args.from, event.args.to, indexerEnv().addresses.uniswap.poolManager);
    const at = syncAt(event);
    if (inPool) await swapsBefore(context, at);
    await applyTransfer(context, token, event.args.from, event.args.to, event.args.value, Number(event.block.timestamp), event.transaction.hash, true);
    if (inPool) await swapsAfter(context, at);
  });
}
