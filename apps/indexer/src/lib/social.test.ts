import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileStore, parseSocialPatch } from './social-store';

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
  it('accepts a spender address (lowercased) or null', () => {
    expect(parseSocialPatch({ spender: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' })).toEqual({
      spender: '0xabcdef0123456789abcdef0123456789abcdef01',
    });
    expect(parseSocialPatch({ spender: null, postsCount24h: 0 })).toEqual({ spender: null, postsCount24h: 0 });
  });
  it('accepts firstPostAt as unix seconds or null', () => {
    expect(parseSocialPatch({ firstPostAt: 1_800_000_000 })).toEqual({ firstPostAt: 1_800_000_000 });
    expect(parseSocialPatch({ firstPostAt: null })).toEqual({ firstPostAt: null });
    expect(typeof parseSocialPatch({ firstPostAt: -1 })).toBe('string');
    expect(typeof parseSocialPatch({ firstPostAt: 'yesterday' })).toBe('string');
  });
  it('rejects a malformed spender', () => {
    for (const spender of ['0x1234', 'abcdef0123456789abcdef0123456789abcdef01', '0xzzcdef0123456789abcdef0123456789abcdef01', 42, '', {}])
      expect(typeof parseSocialPatch({ spender })).toBe('string');
    expect(typeof parseSocialPatch({ xHandle: 'ok', spender: '0x12' })).toBe('string');
  });
  it('rejects invalid payloads', () => {
    expect(typeof parseSocialPatch({ xHandle: 'way_too_long_handle_name' })).toBe('string');
    expect(typeof parseSocialPatch({ postsCount24h: -1 })).toBe('string');
    expect(typeof parseSocialPatch({ status: 'dormant' })).toBe('string');
    expect(typeof parseSocialPatch({})).toBe('string');
    expect(typeof parseSocialPatch([])).toBe('string');
  });
});

describe('FileStore (PGlite dev mode)', () => {
  const kernel = '0x00000000000000000000000000000000000000a1';
  const spender = '0x00000000000000000000000000000000000000e1';

  it('stores the spender in the JSON file and keeps it across partial patches', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bootr-social-'));
    try {
      const file = path.join(dir, 'agent-social.json');
      const store = new FileStore(file);
      expect((await store.upsert(kernel, { xHandle: 'agent', spender })).spender).toBe(spender);
      await store.upsert(kernel, { postsCount24h: 2 });
      const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, { spender: string | null }>;
      expect(raw[kernel]?.spender).toBe(spender);
      expect((await new FileStore(file).all()).get(kernel)).toMatchObject({ xHandle: 'agent', postsCount24h: 2, spender });
      expect((await store.upsert(kernel, { spender: null })).spender).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the earliest firstPostAt ever stored and reads old entries as firstPostAt: null', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bootr-social-'));
    try {
      const file = path.join(dir, 'agent-social.json');
      await writeFile(file, JSON.stringify({ [kernel]: { kernel, xHandle: 'agent', lastPostAt: 1_700_000_000, postsCount24h: 1, status: 'awake', updatedAt: 1 } }));
      const store = new FileStore(file);
      expect((await store.all()).get(kernel)?.firstPostAt).toBeNull();
      expect((await store.upsert(kernel, { firstPostAt: 1_700_000_500, lastPostAt: 1_700_000_500 })).firstPostAt).toBe(1_700_000_500);
      // a later value never replaces it; an earlier one does; null leaves it alone
      expect((await store.upsert(kernel, { firstPostAt: 1_700_009_000 })).firstPostAt).toBe(1_700_000_500);
      expect((await store.upsert(kernel, { firstPostAt: null, postsCount24h: 3 })).firstPostAt).toBe(1_700_000_500);
      expect((await store.upsert(kernel, { firstPostAt: 1_600_000_000 })).firstPostAt).toBe(1_600_000_000);
      expect((await new FileStore(file).all()).get(kernel)?.firstPostAt).toBe(1_600_000_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads entries written before the spender field existed as spender: null', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bootr-social-'));
    try {
      const file = path.join(dir, 'agent-social.json');
      await writeFile(file, JSON.stringify({ [kernel]: { kernel, xHandle: 'old', lastPostAt: null, postsCount24h: 1, status: 'awake', updatedAt: 1 } }));
      expect((await new FileStore(file).all()).get(kernel)).toMatchObject({ xHandle: 'old', spender: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
