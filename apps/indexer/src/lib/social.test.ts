import { describe, expect, it } from 'vitest';

import { parseSocialPatch } from './social-store';

describe('parseSocialPatch', () => {
  it('accepts valid fields and strips @', () => {
    expect(parseSocialPatch({ xHandle: '@bootr_fun', lastPostAt: 1_800_000_000, postsCount24h: 3, status: 'awake' })).toEqual({
      xHandle: 'bootr_fun',
      lastPostAt: 1_800_000_000,
      postsCount24h: 3,
      status: 'awake',
    });
    expect(parseSocialPatch({ xHandle: null })).toEqual({ xHandle: null });
  });
  it('rejects invalid payloads', () => {
    expect(typeof parseSocialPatch({ xHandle: 'way_too_long_handle_name' })).toBe('string');
    expect(typeof parseSocialPatch({ postsCount24h: -1 })).toBe('string');
    expect(typeof parseSocialPatch({ status: 'dormant' })).toBe('string');
    expect(typeof parseSocialPatch({})).toBe('string');
    expect(typeof parseSocialPatch([])).toBe('string');
  });
});
