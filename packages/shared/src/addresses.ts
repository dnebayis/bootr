import type { Address } from 'viem';

/**
 * Per-chain contract addresses used by Bootr.
 *
 * IMPORTANT: every address in this file (and in particular the Base-mainnet ERC-8004
 * registries) MUST be re-verified on-chain before any mainnet deploy.
 */

export const BASE_MAINNET_CHAIN_ID = 8453 as const;
export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;

export type SupportedChainId = typeof BASE_MAINNET_CHAIN_ID | typeof BASE_SEPOLIA_CHAIN_ID;

export interface ChainAddresses {
  /** Clanker v4 core contracts. */
  clanker: Address;
  clankerFeeLocker: Address;
  clankerLpLocker: Address;
  clankerHookStaticFeeV2: Address;
  clankerHookDynamicFeeV2: Address;
  clankerUniv4EthDevBuy: Address;
  clankerMevBlockDelay: Address;
  /**
   * ClankerLpLockerFeeConversion - the LP locker Clanker enables for the V2 hooks
   * (`enabledLockers(lpLockerFeeConversion, hookStaticFeeV2) == true`; the plain `clankerLpLocker`
   * above is only enabled for the V1 hooks). BootrLauncher uses this one.
   */
  clankerLpLockerFeeConversion: Address;
  /** ERC-8004 registries. `null` when not yet verified for the chain. */
  erc8004: {
    identityRegistry: Address | null;
    reputationRegistry: Address | null;
  };
  /** Wrapped ether. */
  weth: Address;
  /** Circle USDC. */
  usdc: Address;
  /** Uniswap v4 + periphery. */
  uniswap: {
    poolManager: Address;
    universalRouter: Address;
    permit2: Address;
    /** v4-core PoolSwapTest router (testnets only). */
    poolSwapTest: Address | null;
  };
  /** ERC-4337 EntryPoint v0.7. */
  entryPointV07: Address;
  /** ZeroDev Kernel v3.1 + permission modules. */
  zerodev: {
    kernelV31Implementation: Address;
    kernelFactory: Address;
    metaFactory: Address;
    ecdsaValidator: Address;
    ecdsaSigner: Address | null;
    callPolicy: Address | null;
    gasPolicy: Address | null;
    rateLimitPolicy: Address | null;
    sudoPolicy: Address | null;
    timestampPolicy: Address | null;
    signaturePolicy: Address | null;
  };
  /** Bootr contracts (filled in by `forge script script/Deploy.s.sol` and `script/DeployCallPolicy.s.sol`). */
  bootr: {
    launcher: Address | null;
    guardian: Address | null;
    burnerImplementation: Address | null;
    /**
     * BootrCallPolicy: the session-key call allow-list module. Replaces ZeroDev's CallPolicy, which
     * cannot parse the `executeUserOp`-wrapped callData that hooked Kernel permissions require.
     */
    callPolicy: Address | null;
  };
}

export const addresses = {
  [BASE_MAINNET_CHAIN_ID]: {
    clanker: '0xE85A59c628F7d27878ACeB4bf3b35733630083a9',
    clankerFeeLocker: '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68',
    clankerLpLocker: '0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0',
    clankerHookStaticFeeV2: '0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC',
    clankerHookDynamicFeeV2: '0xd60D6B218116cFd801E28F78d011a203D2b068Cc',
    clankerUniv4EthDevBuy: '0x1331f0788F9c08C8F38D52c7a1152250A9dE00be',
    clankerMevBlockDelay: '0xE143f9872A33c955F23cF442BB4B1EFB3A7402A2',
    // TODO(verify on-chain before mainnet deploy): from clanker v4-contracts README
    clankerLpLockerFeeConversion: '0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496',
    erc8004: {
      // Same pair on every ERC-8004 mainnet (github.com/erc-8004/erc-8004-contracts README, Oct 2026).
      identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    },
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    uniswap: {
      // TODO(verify on-chain before mainnet deploy)
      poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
      universalRouter: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      poolSwapTest: null,
    },
    entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    zerodev: {
      // ZeroDev deploys deterministically to the same addresses on every chain; verify before use.
      kernelV31Implementation: '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D',
      kernelFactory: '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419',
      metaFactory: '0xd703aaE79538628d27099B8c4f621bE4CCd142d5',
      ecdsaValidator: '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57',
      ecdsaSigner: null,
      callPolicy: '0x85770b902D1e503D5f5141d9eaC16d0d08eEaDd2',
      gasPolicy: null,
      rateLimitPolicy: null,
      sudoPolicy: null,
      timestampPolicy: null,
      signaturePolicy: null,
    },
    bootr: {
      launcher: null,
      guardian: null,
      burnerImplementation: null,
      callPolicy: null,
    },
  },
  [BASE_SEPOLIA_CHAIN_ID]: {
    clanker: '0xE85A59c628F7d27878ACeB4bf3b35733630083a9',
    clankerFeeLocker: '0x42A95190B4088C88Dd904d930c79deC1158bF09D',
    clankerLpLocker: '0x33e2Eda238edcF470309b8c6D228986A1204c8f9',
    clankerHookStaticFeeV2: '0x11b51DBC2f7F683b81CeDa83DC0078D57bA328cc',
    clankerHookDynamicFeeV2: '0xBF4983dC0f2F8FE78C5cf8Fc621f294A993728Cc',
    clankerUniv4EthDevBuy: '0x691f97752E91feAcD7933F32a1FEdCeDae7bB59c',
    clankerMevBlockDelay: '0x71DB365E93e170ba3B053339A917c11024e7a9d4',
    clankerLpLockerFeeConversion: '0x824bB048a5EC6e06a09aEd115E9eEA4618DC2c8f',
    erc8004: {
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    },
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    uniswap: {
      poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
      universalRouter: '0x492E6456D9528771018DeB9E87ef7750EF184104',
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      poolSwapTest: '0x8B5bcC363ddE2614281aD875bad385E0A785D3B9',
    },
    entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    zerodev: {
      kernelV31Implementation: '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D',
      kernelFactory: '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419',
      metaFactory: '0xd703aaE79538628d27099B8c4f621bE4CCd142d5',
      ecdsaValidator: '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57',
      ecdsaSigner: '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF',
      callPolicy: '0x85770b902D1e503D5f5141d9eaC16d0d08eEaDd2',
      gasPolicy: '0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23',
      rateLimitPolicy: '0xf63d4139B25c836334edD76641356c6b74C86873',
      sudoPolicy: '0x67b436caD8a6D025DF6C82C5BB43fbF11fC5B9B7',
      timestampPolicy: '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F',
      signaturePolicy: '0xF6A936c88D97E6fad13b98d2FD731Ff17eeD591d',
    },
    bootr: {
      // Deployed 2026-10-24 (block 49367726), Sourcify exact match.
      launcher: '0xD4747d91BE6121eBa7602D9114B51d6C184084EF',
      guardian: '0x799Ab875294E37839883D12084aB4BE3f7633630',
      burnerImplementation: '0x7539bF645960Fc47556ECd449370BCc3A7D96Ed7',
      // TODO: fill after `forge script script/DeployCallPolicy.s.sol` (BootrCallPolicy).
      callPolicy: '0x8586BdE0339b85bb9c0f0612954CCdF7fDCF9cE8',
    },
  },
} as const satisfies Record<SupportedChainId, ChainAddresses>;

export function getAddresses(chainId: number): ChainAddresses {
  if (chainId === BASE_MAINNET_CHAIN_ID || chainId === BASE_SEPOLIA_CHAIN_ID) {
    return addresses[chainId];
  }
  throw new Error(`Unsupported chain id: ${chainId}`);
}
