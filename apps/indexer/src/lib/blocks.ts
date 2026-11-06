/**
 * Base's block time by era. Denim (2026-11-05 18:00 UTC) took Base mainnet from one block every 2 s to one every 200 ms;
 * Base Sepolia was already on 200 ms for the whole range we index. `block.timestamp` stays in whole seconds, so about five
 * blocks in a row share one value, and a block number maps to chain time exactly in each era: every block on chain since
 * the fork sits at `1793901601 + floor((n - 53556127) / 5)`.
 *
 * First post-Denim block by chain measurement: 53556126 is at :59 (17:59:59, 2 s after the one before it), 53556127 to
 * 53556131 all carry 18:00:01, and 53556132 is the first at 18:00:02.
 */
export const DENIM_FIRST_BLOCK: Record<number, number | null> = { 8453: 53_556_127, 84532: null };

const PRE_DENIM_BLOCK_SEC = 2;
const BLOCK_SEC = 0.2;

/** Seconds per block at block `n`. */
export function blockSecondsAt(chainId: number, n: number | bigint): number {
  const denim = DENIM_FIRST_BLOCK[chainId] ?? null;
  return denim !== null && Number(n) < denim ? PRE_DENIM_BLOCK_SEC : BLOCK_SEC;
}

/** Chain seconds from block `from` to block `to`, whichever eras they are in. Negative when `to` comes first. */
export function secondsBetweenBlocks(chainId: number, from: number | bigint, to: number | bigint): number {
  const a = Number(from);
  const b = Number(to);
  if (b < a) return -secondsBetweenBlocks(chainId, b, a);
  const denim = DENIM_FIRST_BLOCK[chainId] ?? null;
  if (denim === null || a >= denim) return (b - a) * BLOCK_SEC;
  if (b < denim) return (b - a) * PRE_DENIM_BLOCK_SEC;
  return (denim - a) * PRE_DENIM_BLOCK_SEC + (b - denim) * BLOCK_SEC;
}

/** The intended time between two snapshots. */
export const SNAPSHOT_SEC = 60;

/** Blocks between snapshots at today's block time (the default of `INDEXER_SNAPSHOT_INTERVAL`). */
export const DEFAULT_SNAPSHOT_INTERVAL = Math.round(SNAPSHOT_SEC / BLOCK_SEC);

/** One Ponder block source. */
export type SnapshotSource = { startBlock: number | 'latest'; endBlock?: number; interval: number };

/**
 * The block sources of the snapshot handler. Ponder's `interval` counts blocks over a source's whole range, so one source
 * cannot be 60 s in both eras: 30 blocks would be every 6 s since Denim, 300 every 10 minutes before it. Two sources keep
 * 60 s in both:
 *
 * - `preDenim`: the blocks before the fork, on the same 30-block grid as every earlier schema. Ponder keeps its RPC cache
 *   per (interval, offset), so as long as the start block has not changed this source refetches nothing and the snapshots
 *   of that history land on the very same blocks. Null when the range has no block before the fork.
 * - `main`: from the first block after the fork, every 300 blocks, which on a 5 blocks a second chain is 60 s exactly. The
 *   grid starts on the fork block, so it is new to Ponder's cache once (one `eth_getBlockByNumber` a minute of history since
 *   the fork) and reused after that.
 *
 * `intervalBlocks` (`INDEXER_SNAPSHOT_INTERVAL`) is in today's blocks; the pre-Denim grid keeps the same time.
 */
export function snapshotSources(chainId: number, startBlock: number | 'latest', intervalBlocks: number): { main: SnapshotSource; preDenim: SnapshotSource | null } {
  const denim = DENIM_FIRST_BLOCK[chainId] ?? null;
  if (denim === null || startBlock === 'latest' || startBlock >= denim) return { main: { startBlock, interval: intervalBlocks }, preDenim: null };
  return {
    main: { startBlock: denim, interval: intervalBlocks },
    preDenim: { startBlock, endBlock: denim - 1, interval: preDenimInterval(intervalBlocks) },
  };
}

function preDenimInterval(intervalBlocks: number): number {
  return Math.max(1, Math.round((intervalBlocks * BLOCK_SEC) / PRE_DENIM_BLOCK_SEC));
}

/** Seconds between the snapshots around block `n`: what `historicalSnapshotDue` needs to know about the era. */
export function snapshotSpacingSec(chainId: number, n: number | bigint, intervalBlocks: number): number {
  const denim = DENIM_FIRST_BLOCK[chainId] ?? null;
  if (denim !== null && Number(n) < denim) return preDenimInterval(intervalBlocks) * PRE_DENIM_BLOCK_SEC;
  return intervalBlocks * BLOCK_SEC;
}
