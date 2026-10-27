import { cookieStorage, createConfig, createStorage, http } from 'wagmi';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
import { base, baseSepolia } from 'wagmi/chains';
import { env } from './env';

/**
 * Chains: both Base and Base Sepolia are registered so a wallet on the "other" network is
 * recognised (and can be switched), but NEXT_PUBLIC_CHAIN_ID picks the primary chain.
 */
const primary = env.chainId === 8453 ? base : baseSepolia;
const secondary = env.chainId === 8453 ? baseSepolia : base;

export function makeWagmiConfig() {
  const connectors = [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: 'Bootr', appLogoUrl: `${env.siteUrl}/favicon.svg` }),
    ...(env.wcProjectId
      ? [
          walletConnect({
            projectId: env.wcProjectId,
            showQrModal: true,
            metadata: {
              name: 'Bootr',
              description: 'Launch a coin with an agent that runs it.',
              url: env.siteUrl,
              icons: [`${env.siteUrl}/favicon.svg`],
            },
          }),
        ]
      : []),
  ];

  return createConfig({
    chains: [primary, secondary],
    connectors,
    ssr: true,
    storage: createStorage({ storage: cookieStorage, key: 'bootr.wagmi' }),
    transports: {
      [base.id]: http(env.chainId === 8453 && env.rpcUrl ? env.rpcUrl : undefined),
      [baseSepolia.id]: http(env.chainId === 84532 && env.rpcUrl ? env.rpcUrl : undefined),
    },
  });
}

export type BootrWagmiConfig = ReturnType<typeof makeWagmiConfig>;

declare module 'wagmi' {
  interface Register {
    config: BootrWagmiConfig;
  }
}
