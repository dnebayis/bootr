/**
 * ERC-8004 agent registration file ("agent card"), hosted at `${siteUrl}/agents/<launchId>.json`.
 *
 * The launch form writes that URL into `params.agentURI`, so the IdentityRegistry entry points
 * here. The document is rebuilt from indexer data on every request, which lets it carry the
 * on-chain binding (`registrations`) that a pre-launch data: URI cannot know.
 *
 * Shared by the route handler (server) and the UI (client): keep it free of browser/server APIs.
 */
import { getAddresses } from '@bootr/shared/addresses';
import type { Address } from 'viem';
import { env } from './env';

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isLaunchId(v: string): boolean {
  return UUID_V4.test(v);
}

/** Canonical agent card URL. This exact string is what the indexer stores as `token.agentUri`. */
export function agentCardUrl(launchId: string): string {
  return `${env.siteUrl}/agents/${launchId}.json`;
}

/** ERC-8004 IdentityRegistry for a chain, or null when the address is not verified yet. */
export function identityRegistry(chainId: number): Address | null {
  try {
    return getAddresses(chainId).erc8004.identityRegistry;
  } catch {
    return null;
  }
}

function reputationRegistry(chainId: number): Address | null {
  try {
    return getAddresses(chainId).erc8004.reputationRegistry;
  } catch {
    return null;
  }
}

export interface RegistrationFile {
  type: typeof REGISTRATION_TYPE;
  name: string;
  description: string;
  image?: string;
  services: { name: string; endpoint: string }[];
  registrations: { agentRegistry: string; agentId: number }[];
  supportedTrust?: string[];
}

export type CardToken = {
  id: string;
  chainId: number;
  name: string;
  symbol: string;
  image: string;
  kernel: string;
  agentId: string;
  xHandle: string | null;
};

const isHttp = (v: string) => /^https?:\/\//i.test(v);

function chainName(chainId: number) {
  return chainId === 8453 ? 'Base' : chainId === 84532 ? 'Base Sepolia' : `chain ${chainId}`;
}

export function buildRegistration(t: CardToken): RegistrationFile {
  const registry = identityRegistry(t.chainId);
  const agentId = Number(t.agentId);
  const services = [
    ...(t.xHandle ? [{ name: 'X', endpoint: `https://x.com/${t.xHandle}` }] : []),
    { name: 'web', endpoint: `${env.siteUrl}/token/${t.id}` },
  ];
  return {
    type: REGISTRATION_TYPE,
    name: `${t.name} agent`,
    description: `The agent of ${t.name} ($${t.symbol}), a coin launched on Bootr on ${chainName(t.chainId)}. It runs from its own smart account ${t.kernel}, is paid by its share of the coin's LP fees and by fuel, and ${t.xHandle ? `posts on X as @${t.xHandle}` : 'has no X account connected yet'}.`,
    ...(isHttp(t.image) ? { image: t.image } : {}),
    services,
    registrations:
      registry && Number.isSafeInteger(agentId) && t.agentId !== ''
        ? [{ agentRegistry: `eip155:${t.chainId}:${registry}`, agentId }]
        : [],
    ...(reputationRegistry(t.chainId) ? { supportedTrust: ['reputation'] } : {}),
  };
}

/** Served right after launch, before the indexer has the token. Same type, no binding yet. */
export function pendingRegistration(): RegistrationFile {
  return {
    type: REGISTRATION_TYPE,
    name: 'Bootr agent',
    description: 'A Bootr agent whose launch has not been indexed yet. This file fills in once the launch transaction is indexed.',
    services: [{ name: 'web', endpoint: env.siteUrl }],
    registrations: [],
  };
}

/** Deterministic UUID v4-shaped launch id from a seed hex string (mock fixtures only). */
export function mockLaunchId(seedHex: string): string {
  const h = seedHex.replace(/^0x/, '').toLowerCase().padEnd(32, '0').slice(0, 32).split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) & 3]!;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
