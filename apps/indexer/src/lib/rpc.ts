import { createPublicClient, http, type PublicClient } from 'viem';

import { indexerEnv } from './env';

let client: PublicClient | undefined;

/**
 * Plain viem client for reads Ponder's `context.client` does not offer (eth_getLogs for the
 * USDC fuel scan) and for live reads in the REST API. Not cached by Ponder.
 */
export function rpcClient(): PublicClient {
  client ??= createPublicClient({ transport: http(indexerEnv().rpcUrl, { retryCount: 3 }) }) as PublicClient;
  return client;
}
