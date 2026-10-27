/**
 * Base Account (passkey smart wallet) connector.
 *
 * Same behaviour as wagmi's `baseAccount` connector (@wagmi/connectors 8.2.2, MIT, wevm), with one
 * change: the SDK is loaded from `@base-org/account/browser`. Wagmi imports the bare package, whose
 * `node` export condition (used for the SSR bundle) pulls the CDP server SDK and its Solana x402
 * dependencies, which this app neither needs nor installs. The provider is only ever created in the
 * browser (lazily, in `getProvider`).
 */
import type { createBaseAccountSDK, ProviderInterface } from '@base-org/account/browser';
import { ChainNotConfiguredError, createConnector, type Connector } from 'wagmi';
import {
  getAddress,
  numberToHex,
  SwitchChainError,
  UserRejectedRequestError,
  type AddEthereumChainParameter,
  type Address,
  type Hex,
  type ProviderRpcError,
} from 'viem';

export type BaseAccountParameters = Omit<Parameters<typeof createBaseAccountSDK>[0], 'appChainIds'>;

type WalletConnectResponseCapabilities = {
  signInWithEthereum?: { message: string; signature: Hex } | undefined;
  [capability: string]: unknown;
};

export function baseAccount(parameters: BaseAccountParameters = {}) {
  type Provider = ProviderInterface;

  let walletProvider: Provider | undefined;
  let accountsChanged: Connector['onAccountsChanged'] | undefined;
  let chainChanged: Connector['onChainChanged'] | undefined;
  let disconnect: Connector['onDisconnect'] | undefined;

  return createConnector<Provider>((config) => ({
    id: 'baseAccount',
    name: 'Base Account',
    rdns: 'app.base.account',
    type: 'baseAccount',
    async connect({ chainId, withCapabilities, ...rest } = {}) {
      try {
        const provider = await this.getProvider();
        const targetChainId = chainId ?? config.chains[0]?.id;
        if (!targetChainId) throw new ChainNotConfiguredError();

        const { accounts, currentChainId: initialChainId } = await (async () => {
          if ((rest as { isReconnecting?: boolean }).isReconnecting)
            return {
              accounts: ((await provider.request({ method: 'eth_accounts', params: [] })) as string[]).map((x) => ({
                address: getAddress(x),
                capabilities: {} as WalletConnectResponseCapabilities,
              })),
              currentChainId: await this.getChainId(),
            };
          const capabilities = (rest as { capabilities?: Record<string, unknown> }).capabilities ?? {};
          const response = (await provider.request({
            method: 'wallet_connect',
            params: [
              {
                capabilities,
                chainIds: [numberToHex(targetChainId), ...config.chains.filter((x) => x.id !== targetChainId).map((x) => numberToHex(x.id))],
              },
            ],
          })) as { accounts: { address: Address; capabilities?: WalletConnectResponseCapabilities }[]; chainIds: Hex[] };
          const ordered = (await provider.request({ method: 'eth_accounts' })) as Address[];
          return {
            accounts: ordered.map((a) => {
              const match = response.accounts.find((b) => b.address === a);
              return { address: getAddress(a), capabilities: match?.capabilities ?? {} };
            }),
            currentChainId: Number(response.chainIds[0]),
          };
        })();
        let currentChainId = initialChainId;

        if (!accountsChanged) {
          accountsChanged = this.onAccountsChanged.bind(this);
          provider.on('accountsChanged', accountsChanged);
        }
        if (!chainChanged) {
          chainChanged = this.onChainChanged.bind(this);
          provider.on('chainChanged', chainChanged);
        }
        if (!disconnect) {
          disconnect = this.onDisconnect.bind(this);
          provider.on('disconnect', disconnect);
        }

        if (chainId && currentChainId !== chainId) {
          const chain = await this.switchChain!({ chainId }).catch((error) => {
            if (error.code === UserRejectedRequestError.code) throw error;
            return { id: currentChainId };
          });
          currentChainId = chain?.id ?? currentChainId;
        }

        return {
          accounts: (withCapabilities ? accounts : accounts.map((a) => a.address)) as never,
          chainId: currentChainId,
        };
      } catch (error) {
        if (/(user closed modal|accounts received is empty|user denied account|request rejected)/i.test((error as Error).message))
          throw new UserRejectedRequestError(error as Error);
        throw error;
      }
    },
    async disconnect() {
      const provider = await this.getProvider();
      if (accountsChanged) {
        provider.removeListener('accountsChanged', accountsChanged);
        accountsChanged = undefined;
      }
      if (chainChanged) {
        provider.removeListener('chainChanged', chainChanged);
        chainChanged = undefined;
      }
      if (disconnect) {
        provider.removeListener('disconnect', disconnect);
        disconnect = undefined;
      }
      provider.disconnect();
    },
    async getAccounts() {
      const provider = await this.getProvider();
      return ((await provider.request({ method: 'eth_accounts' })) as string[]).map((x) => getAddress(x));
    },
    async getChainId() {
      const provider = await this.getProvider();
      return Number((await provider.request({ method: 'eth_chainId' })) as Hex);
    },
    async getProvider() {
      if (!walletProvider) {
        const preference = { ...parameters.preference, options: parameters.preference?.options ?? 'all' };
        const { createBaseAccountSDK } = await import('@base-org/account/browser');
        const sdk = createBaseAccountSDK({ ...parameters, appChainIds: config.chains.map((x) => x.id), preference });
        walletProvider = sdk.getProvider();
      }
      return walletProvider;
    },
    async isAuthorized() {
      try {
        return (await this.getAccounts()).length > 0;
      } catch {
        return false;
      }
    },
    async switchChain({ addEthereumChainParameter, chainId }) {
      const chain = config.chains.find((c) => c.id === chainId);
      if (!chain) throw new SwitchChainError(new ChainNotConfiguredError());
      const provider = await this.getProvider();
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(chain.id) }] });
        return chain;
      } catch (error) {
        // 4902: the chain is not added to the wallet yet.
        if ((error as ProviderRpcError).code === 4902) {
          try {
            const blockExplorerUrls = addEthereumChainParameter?.blockExplorerUrls ?? (chain.blockExplorers?.default.url ? [chain.blockExplorers.default.url] : []);
            const rpcUrls = addEthereumChainParameter?.rpcUrls?.length ? addEthereumChainParameter.rpcUrls : [chain.rpcUrls.default?.http[0] ?? ''];
            const addEthereumChain = {
              blockExplorerUrls,
              chainId: numberToHex(chainId),
              chainName: addEthereumChainParameter?.chainName ?? chain.name,
              iconUrls: addEthereumChainParameter?.iconUrls,
              nativeCurrency: addEthereumChainParameter?.nativeCurrency ?? chain.nativeCurrency,
              rpcUrls,
            } satisfies AddEthereumChainParameter;
            await provider.request({ method: 'wallet_addEthereumChain', params: [addEthereumChain] });
            return chain;
          } catch (e) {
            throw new UserRejectedRequestError(e as Error);
          }
        }
        throw new SwitchChainError(error as Error);
      }
    },
    onAccountsChanged(accounts) {
      if (accounts.length === 0) this.onDisconnect();
      else config.emitter.emit('change', { accounts: accounts.map((x) => getAddress(x)) });
    },
    onChainChanged(chain) {
      config.emitter.emit('change', { chainId: Number(chain) });
    },
    async onDisconnect() {
      config.emitter.emit('disconnect');
      const provider = await this.getProvider();
      if (accountsChanged) {
        provider.removeListener('accountsChanged', accountsChanged);
        accountsChanged = undefined;
      }
      if (chainChanged) {
        provider.removeListener('chainChanged', chainChanged);
        chainChanged = undefined;
      }
      if (disconnect) {
        provider.removeListener('disconnect', disconnect);
        disconnect = undefined;
      }
    },
  }));
}
