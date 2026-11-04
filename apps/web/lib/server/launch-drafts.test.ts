import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKER_BOUNDS } from '@bootr/shared/workers';
import {
  MAX_IDENTITY_CHARS,
  draftsDir,
  isDraftId,
  normalizeCoin,
  normalizeIdentity,
  normalizeSource,
  normalizeWorker,
  ownerCookieValue,
  ownerTagFromCookie,
  parseOwnerCookie,
  readDraftIdentity,
  readLaunchDraft,
  saveDraftIdentity,
  updateLaunchDraftLinks,
} from './launch-drafts';

const DRAFT = '0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6f';
const OTHER = '3b241101-e2bb-4255-8caf-4136c566a962';
const TEXT = 'A patient onchain analyst for small Base coins. Short, plain, no hype.';
const CAPS = { xRead: true, xReply: false, xPublish: true, research: true, memory: true, treasury: true, images: false };

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
    const coin = { name: 'Quiet Engine', symbol: 'QENG', image: 'https://gateway.pinata.cloud/ipfs/bafy', imageIpfs: 'ipfs://bafy', xHandle: null, links: { website: 'https://quiet.engine', x: 'https://x.com/quietengine', telegram: null, discord: null } };
    await saveDraftIdentity(DRAFT, TEXT, null, { dir, coin });
    expect(await readLaunchDraft(DRAFT, { dir })).toEqual({ identity: TEXT, coin, worker: null, source: 'bootr' });
    expect(await readLaunchDraft(OTHER, { dir })).toBeNull();
  });

  it('stores which launcher the launch goes through; older drafts read as bootr', async () => {
    expect(normalizeSource(undefined)).toBe('bootr');
    expect(normalizeSource('clanker')).toBe('clanker');
    expect(normalizeSource('other')).toBeNull();
    await saveDraftIdentity(DRAFT, TEXT, null, { dir, source: 'clanker' });
    expect((await readLaunchDraft(DRAFT, { dir }))?.source).toBe('clanker');
    await saveDraftIdentity(OTHER, TEXT, null, { dir });
    expect((await readLaunchDraft(OTHER, { dir }))?.source).toBe('bootr');
  });

  it('stores the worker choice: a preset by id, a custom worker with its preset', async () => {
    await saveDraftIdentity(DRAFT, TEXT, null, { dir, worker: { kind: 'trader' } });
    expect((await readLaunchDraft(DRAFT, { dir }))?.worker).toEqual({ kind: 'trader' });
    const preset = { capabilities: CAPS, postIntervalMs: 2 * 60 * 60 * 1000, identity: ['Your job is the weather on Base.'] };
    await saveDraftIdentity(OTHER, TEXT, null, { dir, worker: { kind: 'custom', preset } });
    expect((await readLaunchDraft(OTHER, { dir }))?.worker).toEqual({ kind: 'custom', preset });
    // A file whose worker no longer validates (bounds changed, hand-edited) reads back without one.
    const { writeFile } = await import('node:fs/promises');
    const file = path.join(dir, `${OTHER}.json`);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.worker.preset.postIntervalMs = 1;
    await writeFile(file, JSON.stringify(raw));
    expect((await readLaunchDraft(OTHER, { dir }))?.worker).toBeNull();
  });

  it('rejects a malformed draft id instead of writing outside the directory', async () => {
    await expect(saveDraftIdentity('../x', TEXT, null, { dir })).rejects.toThrow(/draft id/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("replaces a launched coin's links without the owner tag and keeps everything else", async () => {
    const coin = { name: 'Quiet Engine', symbol: 'QENG', image: 'https://gateway.pinata.cloud/ipfs/bafy', imageIpfs: 'ipfs://bafy', xHandle: 'qeng_agent', links: { website: null, x: null, telegram: null, discord: null } };
    const saved = await saveDraftIdentity(DRAFT, TEXT, null, { dir, coin, worker: { kind: 'trader' }, now: 1 });
    const links = { website: 'https://quiet.engine', x: 'https://x.com/bootrfun', telegram: null, discord: 'https://discord.gg/qeng' };
    expect(await updateLaunchDraftLinks(DRAFT, links, { dir, now: 2 })).toEqual({ ok: true });
    expect(await readLaunchDraft(DRAFT, { dir })).toEqual({ identity: TEXT, coin: { ...coin, links }, worker: { kind: 'trader' }, source: 'bootr' });
    // The owner tag and the creation time survive; only `updatedAt` moves.
    const raw = JSON.parse(await readFile(path.join(dir, `${DRAFT}.json`), 'utf8'));
    expect(raw).toMatchObject({ ownerTag: saved.ok ? saved.ownerTag : '', createdAt: 1, updatedAt: 2 });
    expect(await readdir(dir)).toEqual([`${DRAFT}.json`]);
    // No draft, a draft without coin metadata, a malformed id: nothing is written.
    expect(await updateLaunchDraftLinks(OTHER, links, { dir })).toEqual({ ok: false, reason: 'missing' });
    await saveDraftIdentity(OTHER, TEXT, null, { dir });
    expect(await updateLaunchDraftLinks(OTHER, links, { dir })).toEqual({ ok: false, reason: 'no_coin' });
    expect(await updateLaunchDraftLinks('../x', links, { dir })).toEqual({ ok: false, reason: 'missing' });
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
  const none = { website: null, x: null, telegram: null, discord: null };
  it('accepts the launch form fields, trimmed', () => {
    expect(normalizeCoin(ok)).toEqual({ ...ok, name: 'Quiet Engine', links: none });
    expect(normalizeCoin({ ...ok, imageIpfs: null, xHandle: null })).toMatchObject({ imageIpfs: null, xHandle: null });
  });
  it('keeps the optional links, trimmed, and only https URLs of the right host', () => {
    const links = { website: ' https://quiet.engine ', telegram: 'https://t.me/quietengine', discord: 'https://discord.gg/abc' };
    expect(normalizeCoin({ ...ok, links })).toMatchObject({ links: { website: 'https://quiet.engine', telegram: 'https://t.me/quietengine', discord: 'https://discord.gg/abc' } });
    expect(normalizeCoin({ ...ok, links: { website: '', telegram: null } })).toMatchObject({ links: none });
    expect(normalizeCoin({ ...ok, links: { website: 'http://quiet.engine' } })).toBeNull();
    expect(normalizeCoin({ ...ok, links: { website: 'javascript:alert(1)' } })).toBeNull();
    expect(normalizeCoin({ ...ok, links: { telegram: 'https://quiet.engine/tg' } })).toBeNull();
    expect(normalizeCoin({ ...ok, links: { discord: 'https://t.me/x' } })).toBeNull();
    expect(normalizeCoin({ ...ok, links: { website: `https://a.b/${'x'.repeat(200)}` } })).toBeNull();
  });
  it("keeps the project's X account as https://x.com/<handle>, from a URL or a handle; older drafts have none", () => {
    expect(normalizeCoin({ ...ok, links: { x: '@bootrfun' } })).toMatchObject({ links: { ...none, x: 'https://x.com/bootrfun' } });
    expect(normalizeCoin({ ...ok, links: { x: 'https://twitter.com/bootrfun/' } })).toMatchObject({ links: { ...none, x: 'https://x.com/bootrfun' } });
    expect(normalizeCoin({ ...ok, links: { website: 'https://quiet.engine' } })).toMatchObject({ links: { ...none, website: 'https://quiet.engine' } });
    expect(normalizeCoin({ ...ok, links: { x: 'https://quiet.engine/x' } })).toBeNull();
    expect(normalizeCoin({ ...ok, links: { x: 'too long for a handle' } })).toBeNull();
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

describe('normalizeWorker', () => {
  const H = 60 * 60 * 1000;
  it('accepts a template id and nothing else by name', () => {
    expect(normalizeWorker({ kind: 'trader' })).toEqual({ kind: 'trader' });
    expect(normalizeWorker({ kind: 'community', preset: { junk: true } })).toEqual({ kind: 'community' });
    expect(normalizeWorker({ kind: 'overlord' })).toBeNull();
    expect(normalizeWorker('trader')).toBeNull();
    expect(normalizeWorker(null)).toBeNull();
  });
  it('normalizes a custom preset: always-on powers forced, job lines cleaned, bounds enforced', () => {
    const w = normalizeWorker({
      kind: 'custom',
      preset: { capabilities: { xRead: true, xPublish: true, research: 'yes', memory: false, treasury: false }, postIntervalMs: 2 * H, identity: ['  Your job is  the weather. ', '', 'Cite\u200b sources.'] },
    });
    expect(w).toEqual({
      kind: 'custom',
      preset: {
        capabilities: { xRead: true, xReply: false, xPublish: true, research: false, memory: true, treasury: true, images: false },
        postIntervalMs: 2 * H,
        identity: ['Your job is the weather.', 'Cite sources.'],
      },
    });
    expect(normalizeWorker({ kind: 'custom', preset: { capabilities: CAPS, postIntervalMs: 2 * H, jobLines: ['via jobLines'] } })).toMatchObject({ preset: { identity: ['via jobLines'] } });
    expect(normalizeWorker({ kind: 'custom' })).toBeNull();
    expect(normalizeWorker({ kind: 'custom', preset: { capabilities: CAPS, postIntervalMs: WORKER_BOUNDS.minPostIntervalMs - 1, identity: [] } })).toBeNull();
    expect(normalizeWorker({ kind: 'custom', preset: { capabilities: CAPS, postIntervalMs: 2 * H, identity: ['x'.repeat(WORKER_BOUNDS.maxJobLineChars + 1)] } })).toBeNull();
    expect(normalizeWorker({ kind: 'custom', preset: { capabilities: CAPS, postIntervalMs: 2 * H, identity: Array(WORKER_BOUNDS.maxJobLines + 1).fill('line') } })).toBeNull();
    expect(normalizeWorker({ kind: 'custom', preset: { capabilities: CAPS, postIntervalMs: 2 * H, identity: [42] } })).toBeNull();
  });
});
