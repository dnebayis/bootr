import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Container builds (apps/web/Dockerfile) set NEXT_OUTPUT=standalone to emit a self-contained
  // `.next/standalone` server; local `next build && next start` (and the e2e suite) are unchanged.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  // No `x-powered-by: Next.js` on responses: nothing in the stack should advertise its framework.
  poweredByHeader: false,
  // The build type-checks the app only: tests may import the indexer or the SDK sources, whose dependencies the web
  // image does not install (`pnpm install --filter "web..."`). `pnpm typecheck` still checks them with tsconfig.json.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
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
