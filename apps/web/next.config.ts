import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  transpilePackages: ['@bootr/shared'],
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
    resolveAlias: {
      // `siwe` hard-requires ethers for signature helpers we never call: we verify with viem.
      // A tiny viem-backed shim keeps ethers (~400 kB) out of the bundle. See lib/siwe/ethers-shim.ts.
      ethers: './lib/siwe/ethers-shim.ts',
    },
  },
};

export default nextConfig;
