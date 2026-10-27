import { cookieStorage, createConfig, createStorage, http } from 'wagmi';
import { coinbaseWallet, injected, walletConnect } from 'wagmi/connectors';
import { base, baseSepolia } from 'wagmi/chains';
import { builderDataSuffix } from './attribution';
import { baseAccount } from './connectors/base-account';
import { env } from './env';

/**
 * Chains: both Base and Base Sepolia are registered so a wallet on the "other" network is
 * recognised (and can be switched), but NEXT_PUBLIC_CHAIN_ID picks the primary chain.
 */
const primary = env.chainId === 8453 ? base : baseSepolia;
const secondary = env.chainId === 8453 ? baseSepolia : base;

/**
 * Smart-wallet attribution (ERC-8021). `writeContract({ dataSuffix })` suffixes the inner call; a
 * smart wallet wraps it in `executeBatch`, so the SDKs are also told to suffix the outer calldata.
 */
const attribution = builderDataSuffix ? { dataSuffix: builderDataSuffix } : undefined;

export function makeWagmiConfig() {
  const logo = `${env.siteUrl}/favicon.svg`;
  /**
   * Order is the order of the connect menu (ConnectButton sorts by the same ids):
   * Base Account (passkey smart wallet) first, then Coinbase Wallet (app / extension, EOA),
   * the browser's injected wallet, and WalletConnect when a project id is configured.
   * Providers load lazily (dynamic import in each connector's getProvider), never on the server.
   */
  const connectors = [
    baseAccount({
      appName: 'Bootr',
      appLogoUrl: logo,
      preference: { telemetry: false, ...(attribution ? { attribution } : {}) },
    }),
    coinbaseWallet({
      appName: 'Bootr',
      appLogoUrl: logo,
      // EOA only: the passkey smart wallet is the Base Account entry above.
      preference: { options: 'eoaOnly' },
    }),
    injected({ shimDisconnect: true }),
    ...(env.wcProjectId
      ? [
          walletConnect({
            projectId: env.wcProjectId,
            showQrModal: true,
            metadata: {
              name: 'Bootr',
              description: 'Launch a coin with an agent that runs it.',
              url: env.siteUrl,
              icons: [logo],
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
