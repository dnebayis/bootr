import { createPublicClient, type PublicClient } from 'viem';

import { indexerTransport, withRateLimitRetry } from '../../rpc-budget';
import { indexerEnv } from './env';

let client: PublicClient | undefined;

/**
 * Plain viem client for reads Ponder's `context.client` does not offer (eth_getLogs for the USDC fuel scan) and for live
 * reads in the REST API. Not cached by Ponder. It spends from the same budget as Ponder (`INDEXER_RPC_BU_PER_SEC`), waits
 * out a 429 and never has a url in its errors. A read that is refused for longer than that rejects, and the callers keep
 * what they had.
 */
export function rpcClient(): PublicClient {
  client ??= createPublicClient({
    transport: withRateLimitRetry(
      indexerTransport({
        urls: indexerEnv().rpcUrls,
        ...(process.env.INDEXER_RPC_BU_PER_SEC !== undefined ? { budget: process.env.INDEXER_RPC_BU_PER_SEC } : {}),
        ...(process.env.BASE_RPC_FALLBACK_URL !== undefined ? { fallbackUrl: process.env.BASE_RPC_FALLBACK_URL } : {}),
        httpRetries: 3,
      }),
    ),
  }) as PublicClient;
  return client;
}
