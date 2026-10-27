import { getAddresses, type ChainAddresses } from '@bootr/shared/addresses';
import { createPublicClient, http, type Address, type Chain, type PublicClient, type Transport } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { Config } from './config.js';

export const CHAINLINK_ETH_USD: Record<number, Address> = {
  8453: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  84532: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
};

export interface ChainContext {
  chain: Chain;
  chainId: 8453 | 84532;
  publicClient: PublicClient<Transport, Chain>;
  addresses: ChainAddresses;
  launcher: Address;
  guardian: Address;
  ethUsdFeed: Address;
}

export function chainFor(chainId: number): Chain {
  return chainId === 8453 ? base : baseSepolia;
}

export function createChainContext(config: Pick<Config, 'CHAIN_ID' | 'RPC_URL' | 'BOOTR_LAUNCHER_ADDRESS' | 'BOOTR_GUARDIAN_ADDRESS'>): ChainContext {
  const chain = chainFor(config.CHAIN_ID);
  const publicClient = createPublicClient({ chain, transport: http(config.RPC_URL) });
  return {
    chain,
    chainId: config.CHAIN_ID as 8453 | 84532,
    publicClient,
    addresses: getAddresses(config.CHAIN_ID),
    launcher: config.BOOTR_LAUNCHER_ADDRESS as Address,
    guardian: config.BOOTR_GUARDIAN_ADDRESS as Address,
    ethUsdFeed: CHAINLINK_ETH_USD[config.CHAIN_ID] as Address,
  };
}
