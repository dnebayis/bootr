/**
 * Public (browser-safe) configuration. Every NEXT_PUBLIC_* variable must be referenced
 * literally so Next.js can inline it at build time.
 */
import type { Address } from 'viem';

function str(v: string | undefined): string {
  return (v ?? '').trim();
}

function addr(v: string | undefined): Address | undefined {
  const s = str(v);
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? (s as Address) : undefined;
}

const chainIdRaw = Number(str(process.env.NEXT_PUBLIC_CHAIN_ID) || '84532');

export const env = {
  chainId: chainIdRaw === 8453 ? 8453 : 84532,
  indexerUrl: str(process.env.NEXT_PUBLIC_INDEXER_URL).replace(/\/$/, ''),
  /** Mock mode: explicit switch, or implied when no indexer URL is configured. */
  useMock:
    str(process.env.NEXT_PUBLIC_USE_MOCK) === '1' || str(process.env.NEXT_PUBLIC_INDEXER_URL) === '',
  wcProjectId: str(process.env.NEXT_PUBLIC_WC_PROJECT_ID),
  rpcUrl: str(process.env.NEXT_PUBLIC_RPC_URL),
  siteUrl: str(process.env.NEXT_PUBLIC_SITE_URL) || 'https://bootr.fun',
  inferenceUrl: str(process.env.NEXT_PUBLIC_INFERENCE_URL).replace(/\/$/, ''),
  senderPublicUrl: str(process.env.NEXT_PUBLIC_SENDER_PUBLIC_URL).replace(/\/$/, ''),
  swapLinkBase: str(process.env.NEXT_PUBLIC_SWAP_LINK_BASE),
  launcherAddress: addr(process.env.NEXT_PUBLIC_LAUNCHER_ADDRESS),
  /** `BootrClankerLauncher`: the "Launch through Clanker" path. Optional; the choice is hidden while unset. */
  clankerLauncherAddress: addr(process.env.NEXT_PUBLIC_CLANKER_LAUNCHER_ADDRESS),
  /**
   * `BootrClankerLauncherV5`: the Clanker v5 launcher. The switch of the Clanker card: set, new Clanker launches go
   * through v5 and v4 is no longer offered; unset, they go through v4 as before (`clankerPath` in `lib/contracts.ts`).
   */
  clankerV5LauncherAddress: addr(process.env.NEXT_PUBLIC_CLANKER_V5_LAUNCHER_ADDRESS),
  guardianAddress: addr(process.env.NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS),
  supervisorSessionKey: addr(process.env.NEXT_PUBLIC_SUPERVISOR_SESSION_KEY),
  bootXUrl: str(process.env.NEXT_PUBLIC_BOOT_X_URL),
  workerSourceBase: str(process.env.NEXT_PUBLIC_WORKER_SOURCE_BASE),
  /** Base Builder Code (ERC-8021). Appended as a calldata suffix to launch and fuel txs; empty = off. */
  builderCode: str(process.env.NEXT_PUBLIC_BUILDER_CODE),
  /** IPFS gateway origin for pinned token images (`<gateway>/ipfs/<cid>`); a dedicated Pinata gateway in production. */
  ipfsGateway: (str(process.env.NEXT_PUBLIC_IPFS_GATEWAY) || 'https://gateway.pinata.cloud').replace(/\/+$/, ''),
} as const;

export type AppChainId = 8453 | 84532;
