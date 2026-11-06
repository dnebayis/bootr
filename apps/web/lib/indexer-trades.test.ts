import { describe, expect, it } from 'vitest';
import { newestTradesFirst } from './indexer';

describe('newestTradesFirst', () => {
  it('orders by block then log index, when several blocks share one timestamp', () => {
    const trade = (blockNumber: string, logIndex: number) => ({ blockNumber, logIndex, timestamp: 1_793_901_601 });
    const sorted = newestTradesFirst([trade('53556128', 90), trade('53556129', 3), trade('53556129', 40), trade('53556127', 500)]);
    expect(sorted.map((t) => `${t.blockNumber}-${t.logIndex}`)).toEqual(['53556129-40', '53556129-3', '53556128-90', '53556127-500']);
  });
});
