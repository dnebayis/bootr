import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./env', () => ({ env: { useMock: false, indexerUrl: 'https://indexer.test', chainId: 8453 } }));

const { fetchToken, fetchTokensByCreator } = await import('./indexer');

const BOOTR = '0xb1c3a6ac90e324c4072ad4b2a71c5d9382f9565c';

/** The indexer as GraphQL answers it: a token row with only what the query asked for, so a field left out is undefined. */
function indexer(row: Record<string, unknown>) {
  const queries: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/graphql')) return Response.json({ images: {} });
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      queries.push(query);
      const asked = (field: string) => new RegExp(`\\b${field}\\b`).test(query);
      const token = Object.fromEntries(Object.entries(row).filter(([k]) => asked(k)));
      return Response.json({ data: { token: { ...token, agent: null }, trades: { items: [] }, tokens: { items: [token] } } });
    }),
  );
  return queries;
}

afterEach(() => vi.unstubAllGlobals());

describe('token fragment', () => {
  // $BOOTR as GraphQL returned it on 2026-11-21: the coin page's "24h" read "—" because the query never asked.
  const row = { id: BOOTR, symbol: 'BOOTR', priceUsd: 3.41105910157e-7, marketCapUsd: 34110.591016, volume24hUsd: 610.137502, change24hPct: 2.1896, holders: 1200 };

  it('asks for the 24 h change the coin page shows, and passes it through', async () => {
    const queries = indexer(row);
    const token = await fetchToken(BOOTR);
    expect(queries[0]).toMatch(/\bchange24hPct\b/);
    expect(token?.change24hPct).toBe(2.1896);
    expect(token?.marketCapUsd).toBe(34110.591016);
  });

  it('carries it on the other readers of the fragment too', async () => {
    const queries = indexer(row);
    const [token] = await fetchTokensByCreator('0x0000000000000000000000000000000000000001');
    expect(queries[0]).toMatch(/\bchange24hPct\b/);
    expect(token?.change24hPct).toBe(2.1896);
  });
});
