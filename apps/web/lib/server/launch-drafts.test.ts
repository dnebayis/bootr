import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_IDENTITY_CHARS,
  draftsDir,
  isDraftId,
  normalizeCoin,
  normalizeIdentity,
  ownerCookieValue,
  ownerTagFromCookie,
  parseOwnerCookie,
  readDraftIdentity,
  readLaunchDraft,
  saveDraftIdentity,
} from './launch-drafts';

const DRAFT = '0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6f';
const OTHER = '3b241101-e2bb-4255-8caf-4136c566a962';
const TEXT = 'A patient onchain analyst for small Base coins. Short, plain, no hype.';

describe('normalizeIdentity', () => {
  it('accepts plain text between 20 and 600 characters, normalized', () => {
    expect(normalizeIdentity(`  Who:\tanalyst\r\n\r\n\r\nHow:   dry, never gives price targets.  `)).toBe('Who: analyst\n\nHow: dry, never gives price targets.');
    expect(normalizeIdentity('x'.repeat(MAX_IDENTITY_CHARS))).toHaveLength(MAX_IDENTITY_CHARS);
  });
  it('drops control, zero-width and bidi characters', () => {
    expect(normalizeIdentity('Hel\u0000lo wor‮ld, a​ patient analyst﻿ for Base coins.')).toBe('Hello world, a patient analyst for Base coins.');
  });
  it('rejects non-strings and texts outside the bounds', () => {
    expect(normalizeIdentity(undefined)).toBeNull();
    expect(normalizeIdentity(42)).toBeNull();
    expect(normalizeIdentity('too short')).toBeNull();
    expect(normalizeIdentity(' '.repeat(30))).toBeNull();
    expect(normalizeIdentity('x'.repeat(MAX_IDENTITY_CHARS + 1))).toBeNull();
  });
});

describe('isDraftId', () => {
  it('accepts only lowercase uuid v4', () => {
    expect(isDraftId(DRAFT)).toBe(true);
    expect(isDraftId(DRAFT.toUpperCase())).toBe(false);
    expect(isDraftId('10388')).toBe(false);
    expect(isDraftId(null)).toBe(false);
  });
});

describe('draftsDir', () => {
  const saved = { LAUNCH_DRAFTS_DIR: process.env.LAUNCH_DRAFTS_DIR, ADMIN_CONFIG_PATH: process.env.ADMIN_CONFIG_PATH };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  it('prefers LAUNCH_DRAFTS_DIR, then the admin config directory, then <cwd>/data/launch-drafts', () => {
    process.env.LAUNCH_DRAFTS_DIR = '/data/launch-drafts';
    process.env.ADMIN_CONFIG_PATH = '/data/admin-config.json';
    expect(draftsDir()).toBe(path.resolve('/data/launch-drafts'));
    process.env.LAUNCH_DRAFTS_DIR = '';
    expect(draftsDir()).toBe(path.resolve('/data/launch-drafts'));
    process.env.ADMIN_CONFIG_PATH = '';
    expect(draftsDir()).toBe(path.join(process.cwd(), 'data', 'launch-drafts'));
  });
});

describe('draft store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bootr-launch-drafts-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves, reads back and answers null for unknown or malformed ids', async () => {
    expect(await readDraftIdentity(DRAFT, { dir })).toBeNull();
    const saved = await saveDraftIdentity(DRAFT, TEXT, null, { dir, now: 1_700_000_000 });
    expect(saved.ok).toBe(true);
    expect(await readDraftIdentity(DRAFT, { dir })).toBe(TEXT);
    expect(await readDraftIdentity(OTHER, { dir })).toBeNull();
    expect(await readDraftIdentity('../etc/passwd', { dir })).toBeNull();
    expect(await readdir(dir)).toEqual([`${DRAFT}.json`]); // no temp file left behind
    const file = JSON.parse(await readFile(path.join(dir, `${DRAFT}.json`), 'utf8'));
    expect(file).toMatchObject({ identity: TEXT, createdAt: 1_700_000_000, updatedAt: 1_700_000_000 });
    expect(file.ownerTag).toMatch(/^[0-9a-f]{32}$/);
  });

  it('lets the owner replace the text and refuses everyone else', async () => {
    const first = await saveDraftIdentity(DRAFT, TEXT, null, { dir, now: 1 });
    if (!first.ok) throw new Error('first save failed');
    const stranger = await saveDraftIdentity(DRAFT, 'A different persona written by someone else entirely.', null, { dir });
    expect(stranger).toEqual({ ok: false, reason: 'owned' });
    const wrongTag = await saveDraftIdentity(DRAFT, 'A different persona written by someone else entirely.', 'f'.repeat(32), { dir });
    expect(wrongTag).toEqual({ ok: false, reason: 'owned' });
    expect(await readDraftIdentity(DRAFT, { dir })).toBe(TEXT);

    const owner = await saveDraftIdentity(DRAFT, 'The owner changed their mind about the persona.', first.ownerTag, { dir, now: 2 });
    expect(owner).toEqual({ ok: true, ownerTag: first.ownerTag });
    expect(await readDraftIdentity(DRAFT, { dir })).toBe('The owner changed their mind about the persona.');
    const file = JSON.parse(await readFile(path.join(dir, `${DRAFT}.json`), 'utf8'));
    expect(file).toMatchObject({ createdAt: 1, updatedAt: 2 });
  });

  it('stores the coin metadata next to the identity text', async () => {
    const coin = { name: 'Quiet Engine', symbol: 'QENG', image: 'https://gateway.pinata.cloud/ipfs/bafy', imageIpfs: 'ipfs://bafy', xHandle: null };
    await saveDraftIdentity(DRAFT, TEXT, null, { dir, coin });
    expect(await readLaunchDraft(DRAFT, { dir })).toEqual({ identity: TEXT, coin });
    expect(await readLaunchDraft(OTHER, { dir })).toBeNull();
  });

  it('rejects a malformed draft id instead of writing outside the directory', async () => {
    await expect(saveDraftIdentity('../x', TEXT, null, { dir })).rejects.toThrow(/draft id/);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('owner cookie', () => {
  const tag = 'a'.repeat(32);
  it('round-trips ids and tags, most recent first, and ignores garbage', () => {
    const v1 = ownerCookieValue(undefined, DRAFT, tag);
    expect(v1).toBe(`${DRAFT}.${tag}`);
    const v2 = ownerCookieValue(v1, OTHER, 'b'.repeat(32));
    expect(parseOwnerCookie(v2).map((d) => d.id)).toEqual([OTHER, DRAFT]);
    expect(ownerTagFromCookie(v2, DRAFT)).toBe(tag);
    expect(ownerTagFromCookie(v2, '3b241101-e2bb-4255-8caf-000000000000')).toBeNull();
    expect(parseOwnerCookie('junk~10388.abc~' + `${DRAFT}.zz`)).toEqual([]);
  });
  it('keeps at most four drafts and replaces an existing id in place', () => {
    let v: string | undefined;
    for (let i = 0; i < 6; i++) v = ownerCookieValue(v, `0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6${i}`, tag);
    expect(parseOwnerCookie(v)).toHaveLength(4);
    const again = ownerCookieValue(v, '0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e64', 'c'.repeat(32));
    expect(parseOwnerCookie(again)).toHaveLength(4);
    expect(ownerTagFromCookie(again, '0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e64')).toBe('c'.repeat(32));
  });
});

describe('normalizeCoin', () => {
  const ok = { name: ' Quiet Engine ', symbol: 'QENG', image: 'https://gateway.pinata.cloud/ipfs/bafy', imageIpfs: 'ipfs://bafy', xHandle: 'qeng_agent' };
  it('accepts the launch form fields, trimmed', () => {
    expect(normalizeCoin(ok)).toEqual({ ...ok, name: 'Quiet Engine' });
    expect(normalizeCoin({ ...ok, imageIpfs: null, xHandle: null })).toMatchObject({ imageIpfs: null, xHandle: null });
  });
  it('rejects bad symbols, non-http images, bad handles and oversized names', () => {
    expect(normalizeCoin(null)).toBeNull();
    expect(normalizeCoin({ ...ok, symbol: 'qeng' })).toBeNull();
    expect(normalizeCoin({ ...ok, image: 'javascript:alert(1)' })).toBeNull();
    expect(normalizeCoin({ ...ok, image: 'data:image/png;base64,AAAA' })).toBeNull();
    expect(normalizeCoin({ ...ok, imageIpfs: 'https://x' })).toBeNull();
    expect(normalizeCoin({ ...ok, xHandle: 'bad handle' })).toBeNull();
    expect(normalizeCoin({ ...ok, name: 'x'.repeat(49) })).toBeNull();
  });
});
