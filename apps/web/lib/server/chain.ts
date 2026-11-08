import { createPublicClient, http, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';

if (typeof window !== 'undefined') throw new Error('lib/server/chain must not be imported in the browser');

export type ServerChainId = 8453 | 84532;

/** The keyed RPC of the server routes (`BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL`); undefined = viem's public default for the chain. */
export function serverRpcUrl(chainId: ServerChainId): string | undefined {
  return (chainId === 8453 ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL) || undefined;
}

/**
 * The one viem client every server route uses to read the chain (SIWE signature checks, the claim and launch
 * routes). No CCIP-Read (ERC-3668): a contract that reverts with `OffchainLookup` would otherwise make this server
 * fetch the URLs the contract names, and the addresses these routes read (a signer's smart account, a locker, a
 * launcher) are chosen by the caller or by the chain, so the lookup is refused and the read fails at once. One
 * client per chain and RPC url, so a request does not build a new one.
 */
const clients = new Map<string, PublicClient>();

export function serverPublicClient(chainId: ServerChainId): PublicClient {
  const rpc = serverRpcUrl(chainId);
  const key = `${chainId}:${rpc ?? ''}`;
  let client = clients.get(key);
  if (!client) {
    client = createPublicClient({ chain: chainId === 8453 ? base : baseSepolia, transport: http(rpc), ccipRead: false }) as PublicClient;
    clients.set(key, client);
  }
  return client;
}
