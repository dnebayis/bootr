import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOARD_DEFAULT, BOARD_META, boardPeriods, clockUtc, isBoardId, periodLabel } from './leaderboards';
import { mock } from './mock';

const INDEXER = readFileSync(path.resolve(import.meta.dirname, '../../indexer/src/api/lists.ts'), 'utf8');

describe('boards', () => {
  it('offers exactly the boards and periods of the indexer', () => {
    const block = /export const BOARDS[^=]*= \{([\s\S]*?)\n\};/.exec(INDEXER)![1]!;
    const declared = [...block.matchAll(/'?([\w-]+)'?: \{ periods: \[([^\]]*)\]/g)].map((m) => [m[1]!, [...m[2]!.matchAll(/'(\w+)'/g)].map((p) => p[1]!)]);
    expect(declared.length).toBeGreaterThan(3);
    expect(BOARD_META.map((b) => [b.id, [...b.periods]])).toEqual(declared);
  });

  it('has a default, refuses what is not a board', () => {
    expect(isBoardId(BOARD_DEFAULT)).toBe(true);
    expect(isBoardId('toString')).toBe(false);
    expect(boardPeriods('holders')).toEqual(['now']);
  });

  it('says nothing that implies gain or a call', () => {
    const copy = BOARD_META.flatMap((b) => [b.label, b.metric, b.description, b.empty]).join(' ');
    expect(copy).not.toMatch(/gain|profit|moon|pump|winner|best|return|early|buy now|x402|session key|kernel/i);
  });
});

describe('labels', () => {
  it('names every period', () => {
    expect(periodLabel('24h')).toBe('24 h');
    expect(periodLabel('all')).toBe('All time');
    expect(periodLabel('now')).toBe('Now');
  });

  it('prints the read time in UTC', () => {
    expect(clockUtc(Date.UTC(2026, 10, 5, 14, 3, 59) / 1000)).toBe('2026-11-05 14:03 UTC');
  });
});

describe('mock boards', () => {
  it('rank highest first with only real values', () => {
    for (const b of BOARD_META) {
      const board = mock.leaderboard(b.id, b.periods[0]!);
      expect(board.periods).toEqual(b.periods);
      const values = board.items.map((r) => r.value);
      expect([...values].sort((x, y) => y - x)).toEqual(values);
      for (const r of board.items) expect(r.value).toBeGreaterThan(0);
    }
  });
});
