import { describe, expect, it } from 'vitest';
import { HOUR_SEC, historicalSnapshotDue } from './time';

/** How many snapshots of one hour are due, for a grid `spacing` seconds apart starting `offset` into the hour. */
function dueInHour(spacing: number, offset: number) {
  let due = 0;
  for (let ts = 1_793_620_800 + offset; ts < 1_793_620_800 + HOUR_SEC + offset; ts += spacing) {
    if (historicalSnapshotDue(ts, spacing)) due += 1;
  }
  return due;
}

describe('historicalSnapshotDue', () => {
  it('picks exactly one snapshot per hour wherever the 60 s grid starts', () => {
    for (const offset of [0, 1, 2, 29, 59]) expect(dueInHour(60, offset)).toBe(1);
  });

  it('picks exactly one per hour on a 600 s grid', () => {
    for (const offset of [0, 7, 599]) expect(dueInHour(600, offset)).toBe(1);
  });

  it('keeps every snapshot when they are an hour or more apart', () => {
    expect(historicalSnapshotDue(1_793_620_800 + 3_599, HOUR_SEC)).toBe(true);
    expect(dueInHour(HOUR_SEC, 1_234)).toBe(1);
  });

  it('gives the same answer on a replay', () => {
    expect(historicalSnapshotDue(1_793_620_830, 60)).toBe(true);
    expect(historicalSnapshotDue(1_793_620_890, 60)).toBe(false);
    expect(historicalSnapshotDue(1_793_620_830, 60)).toBe(true);
  });
});
