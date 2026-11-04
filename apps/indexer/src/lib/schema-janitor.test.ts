import { describe, expect, it } from 'vitest';
// @ts-expect-error plain module next to the start script
import { AUTO_SCHEMA, schemasToDrop } from '../../scripts/schema-janitor.mjs';

describe('schema janitor', () => {
  it('drops only automatic schemas older than the newest previous one, never fixed names or bootr_offchain', () => {
    const all = ['bootr_v1', 'bootr_v2', 'bootr_offchain', 'bootr_a1b2c3d', 'bootr_v3', 'bootr_e4f5a6b', 'bootr_0123abc', 'bootr_ffffff0'];
    expect(schemasToDrop(all, 'bootr_ffffff0')).toEqual(['bootr_a1b2c3d', 'bootr_e4f5a6b']);
    // the current one is never dropped, even when it is not the last created
    expect(schemasToDrop(all, 'bootr_a1b2c3d')).toEqual(['bootr_e4f5a6b', 'bootr_0123abc']);
    expect(schemasToDrop(['bootr_v3', 'bootr_offchain'], 'bootr_ffffff0')).toEqual([]);
    expect(AUTO_SCHEMA.test('bootr_v3')).toBe(false);
    expect(AUTO_SCHEMA.test('bootr_abc1234')).toBe(true);
  });
});
