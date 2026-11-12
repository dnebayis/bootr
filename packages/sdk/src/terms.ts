import { formatUnits, type Address } from 'viem';
import type { LaunchSource, PreparedClaims, UnsignedClaim, V5CoinFields } from './types.js';

/** The assets a Bootr coin can trade against or pay fees in, on Base (8453). */
const KNOWN_ASSETS: Record<string, { symbol: string; decimals: number }> = {
  '0x0000000000000000000000000000000000000000': { symbol: 'ETH', decimals: 18 },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
};

/** The symbol and decimals of an asset a Bootr coin or claim uses on Base; null for any other. */
export function knownAsset(
  address: string | null | undefined,
): { symbol: string; decimals: number } | null {
  return (address && KNOWN_ASSETS[address.toLowerCase()]) || null;
}

/** What a trader pays on a coin and what it trades against, in plain units. */
export interface CoinTerms {
  source: LaunchSource | null;
  /** `ETH` or `USDC` on Clanker v5, `WETH` on the older paths; null when the row does not say. */
  pairedAsset: string | null;
  /** Clanker v5 only (null elsewhere): each side's tax in percent of the trade, set by the creator at launch. */
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  /** Clanker v5 only: the sniper tax was on at launch (99% falling to the normal tax over the first 20 seconds). */
  sniperTax: boolean | null;
  /** The image and metadata can still be changed by the creator. */
  metadataEditable: boolean | null;
}

/** The terms of a coin from a market snapshot, a search row or a fees answer. */
export function coinTerms(row: V5CoinFields & { source?: LaunchSource | null }): CoinTerms {
  const pct = (bps: number | null | undefined) =>
    typeof bps === 'number' ? Math.round(bps) / 10_000 : null;
  return {
    source: row.source ?? null,
    pairedAsset: row.pairedSymbol ?? knownAsset(row.pairedToken)?.symbol ?? null,
    buyTaxPct: pct(row.buyTaxBps),
    sellTaxPct: pct(row.sellTaxBps),
    sniperTax: typeof row.antiSnipe === 'boolean' ? row.antiSnipe : null,
    metadataEditable: typeof row.metadataEditable === 'boolean' ? row.metadataEditable : null,
  };
}

/** The claims that pay one asset, with their total. */
export interface ClaimsInAsset {
  asset: Address;
  /** `ETH`, `WETH` or `USDC`; null for an asset this package does not know. */
  symbol: string | null;
  /** The total in the asset's smallest units (wei, or 6 decimals for USDC). */
  amount: string;
  /** The total in whole units ("0.0123"); null when the asset is not known. */
  amountText: string | null;
  claims: UnsignedClaim[];
}

/**
 * The claims of `prepareClaim` grouped by the asset they pay: WETH from the older paths, and on Clanker v5 ETH or USDC,
 * the coins' paired asset. `totalWei` adds ETH and WETH one to one and leaves USDC out; these totals do not mix assets.
 */
export function claimsByAsset(prepared: Pick<PreparedClaims, 'claims' | 'asset'>): ClaimsInAsset[] {
  const groups = new Map<string, ClaimsInAsset>();
  for (const claim of prepared.claims) {
    // An answer from before the asset field paid WETH.
    const asset = claim.asset ?? prepared.asset;
    const key = asset.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        asset,
        symbol: knownAsset(asset)?.symbol ?? null,
        amount: '0',
        amountText: null,
        claims: [],
      };
      groups.set(key, group);
    }
    group.claims.push(claim);
    group.amount = (BigInt(group.amount) + BigInt(claim.amountWei)).toString();
  }
  for (const group of groups.values()) {
    const known = knownAsset(group.asset);
    group.amountText = known ? formatUnits(BigInt(group.amount), known.decimals) : null;
  }
  return [...groups.values()];
}
