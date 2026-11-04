import { describe, expect, it } from 'vitest';
import { HOUR_SEC, historicalSnapshotDue } from './time';

/** How many snapshots of one hour are due, for a grid `step` seconds apart starting `offset` into the hour. */
function dueInHour(step: number, intervalBlocks: number, offset: number) {
  let due = 0;
  for (let ts = 1_793_620_800 + offset; ts < 1_793_620_800 + HOUR_SEC + offset; ts += step) {
    if (historicalSnapshotDue(ts, intervalBlocks)) due += 1;
  }
  return due;
}

describe('historicalSnapshotDue', () => {
  it('picks exactly one snapshot per hour wherever the 60 s grid of Base mainnet starts', () => {
    for (const offset of [0, 1, 2, 29, 59]) expect(dueInHour(60, 30, offset)).toBe(1);
  });

  it('picks exactly one per hour on the 600 s grid of Base Sepolia', () => {
    for (const offset of [0, 7, 599]) expect(dueInHour(600, 300, offset)).toBe(1);
  });

  it('keeps every snapshot when they are an hour or more apart', () => {
    expect(historicalSnapshotDue(1_793_620_800 + 3_599, 1_800)).toBe(true);
    expect(dueInHour(HOUR_SEC, 1_800, 1_234)).toBe(1);
  });

  it('gives the same answer on a replay', () => {
    expect(historicalSnapshotDue(1_793_620_830, 30)).toBe(true);
    expect(historicalSnapshotDue(1_793_620_890, 30)).toBe(false);
    expect(historicalSnapshotDue(1_793_620_830, 30)).toBe(true);
  });
});
