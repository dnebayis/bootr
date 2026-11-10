'use client';

/**
 * A Clanker v5 coin's current image and metadata (docs/design/clanker-v5-token-settings.md section 2.5). An editable
 * coin's creator can change both after launch, so the coin page reads them from the token itself (`extraMetadata`)
 * rather than trusting the launch-time copy; the indexer's copy (`Token.image`, `v5Settings.metadataJson`) stands in
 * until the read lands, in mock mode, and for coins whose metadata cannot change.
 */
import { useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import { clankerV5TokenAbi } from './abi/clankerV5Token';
import { appChain } from './chains';
import { env } from './env';
import type { Token } from './types';

/** The `description` of Clanker's metadata JSON, or null when the string is not that JSON. */
export function descriptionOf(json: string | null | undefined): string | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { description?: unknown };
    return typeof v.description === 'string' && v.description.trim() ? v.description.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The metadata JSON with a new description, keeping every other key (the links, `auditUrls`, Bootr's `contractUri`).
 * Starts from `{socialMediaUrls: [], auditUrls: []}` when the current string is not JSON.
 */
export function withDescription(json: string | null | undefined, description: string): string {
  let base: Record<string, unknown> = { socialMediaUrls: [], auditUrls: [] };
  try {
    const v = json ? (JSON.parse(json) as unknown) : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) base = v as Record<string, unknown>;
  } catch {
    /* the default above */
  }
  return JSON.stringify({ ...base, description });
}

export type V5Metadata = { image: string; metadataJson: string | null; description: string | null; source: 'chain' | 'indexer' };

export function useV5Metadata(token: Pick<Token, 'id' | 'image' | 'imageOnChain' | 'v5Settings'> | null | undefined): V5Metadata | null {
  const editable = !!token?.v5Settings?.metadataEditable;
  const live = editable && !env.useMock;
  const read = useReadContracts({
    allowFailure: true,
    contracts: token
      ? [
          { address: token.id as Address, abi: clankerV5TokenAbi, functionName: 'extraMetadata', args: ['image'], chainId: appChain.id },
          { address: token.id as Address, abi: clankerV5TokenAbi, functionName: 'extraMetadata', args: ['metadata'], chainId: appChain.id },
        ]
      : [],
    query: { enabled: live && !!token, staleTime: 30_000 },
  });
  if (!token?.v5Settings) return null;
  const [image, metadata] = read.data ?? [];
  const chainImage = image?.status === 'success' && image.result ? (image.result as string) : null;
  const chainJson = metadata?.status === 'success' && metadata.result ? (metadata.result as string) : null;
  // A creator's off-chain image on Bootr (`imageOnChain` set) still wins on Bootr's pages, as for every other coin.
  const shownImage = token.imageOnChain ? token.image : (chainImage ?? token.image);
  const json = chainJson ?? token.v5Settings.metadataJson ?? null;
  return { image: shownImage, metadataJson: json, description: descriptionOf(json), source: chainImage || chainJson ? 'chain' : 'indexer' };
}
